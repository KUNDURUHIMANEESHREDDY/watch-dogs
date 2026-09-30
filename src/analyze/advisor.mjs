/**
 * An LLM may only *propose*. It never receives a tool, never writes a file, and
 * never executes a command. Its entire output is text that must survive JSON
 * parsing and then pass `isRefused` like any other action. That is what keeps
 * autonomous mode defensible.
 */
import { runCapture, makeRunnable, assertSafeArg } from '../core/exec.mjs';
import { log } from '../core/log.mjs';
import { traceAdvisorReview } from '../observe/trace.mjs';

const SYSTEM_PROMPT = `You are a build-log triage assistant. Given terminal output, decide whether there is a real, actionable problem.

Respond with ONLY a JSON object, no prose, no code fences:
{"verdict":"problem"|"noise"|"unsure","confidence":0.0-1.0,"summary":"one line","fix":{"description":"what to change","files":[{"path":"relative/path","find":"exact existing text","replace":"new text"}]} or null}

Rules:
- "noise" for expected output, progress bars, warnings that need no action.
- Only propose file edits you can quote exactly. Never invent a "find" string.
- Prefer "noise" or "unsure" over a confident guess. You cannot see the filesystem.`;

export class Advisor {
  #cli;
  #model;
  #timeoutMs;
  #inFlight = new Set();

  constructor({ cli = 'opencode', model = null, timeoutMs = 180_000 } = {}) {
    this.#cli = resolveCli(cli);
    this.#model = model;
    this.#timeoutMs = timeoutMs;
  }

  available() {
    return !!this.#cli;
  }

  /**
   * @returns {Promise<{verdict:string,confidence:number,summary:string,fix:object|null,raw:string,error?:string,status?:string}>}
   */
  async review({ evidence, cwd, title, sessionId, cfg }) {
    if (!this.available()) return err('no cli configured', 'unavailable');
    const key = `${cwd}::${title}`;
    if (this.#inFlight.has(key)) return err('review already in flight for this signature', 'busy');
    this.#inFlight.add(key);

    // Tracing wraps the whole review, including the failure paths, because "we
    // never got to ask the model" is exactly the kind of thing the traces exist
    // to show. It is a no-op unless Langfuse is configured, and it cannot change
    // the result either way.
    try {
      return await traceAdvisorReview({
        cfg,
        sessionId,
        title,
        cwd,
        model: this.#model,
        evidence,
        run: () => this.#reviewInner({ evidence, cwd, title }),
      });
    } finally {
      this.#inFlight.delete(key);
    }
  }

  async #reviewInner({ evidence, cwd, title }) {
    try {
      const prompt = `${SYSTEM_PROMPT}\n\nDETECTED: ${title}\nWORKING DIR: ${cwd}\n\nOUTPUT:\n${evidence.slice(0, 4000)}`;
      const raw = await this.#invoke(prompt, cwd);

      if (typeof raw === 'string' && raw.startsWith('__WD_TIMEOUT__')) {
        return err(`advisor timed out after ${raw.slice(14)}ms - it did not answer in time`, 'timeout');
      }
      if (typeof raw === 'string' && raw.startsWith('__WD_SPAWNFAIL__')) {
        return err(`could not launch the advisor CLI: ${raw.slice(17)}`, 'unavailable');
      }
      if (typeof raw === 'string' && raw.startsWith('__WD_EXIT__')) {
        return err(`advisor CLI failed - ${raw.slice(11)}`, 'failed');
      }

      const unwrapped = unwrapEvents(raw);

      // A provider-side failure arrives as an error event. It must be reported as a
      // provider failure, never as the model saying "unsure" -- otherwise a dead or
      // unfunded LLM looks exactly like a working one.
      if (unwrapped.providerError) {
        return { ...providerError(unwrapped.providerError), raw: raw.slice(0, 2000) };
      }
      const parsed = extractJson(unwrapped.text);
      if (!parsed) {
        return { ...err('could not parse JSON from model output', 'unparseable'), raw: unwrapped.text.slice(0, 2000) };
      }
      return normalize(parsed, raw);
    } catch (e) {
      return err(e.message, e.message.includes('timed out') ? 'timeout' : 'failed');
    }
  }

  #invoke(prompt, cwd) {
    const args = ['run', '--format', 'json'];
    if (this.#model) args.push('--model', assertSafeArg('llm.model', this.#model));
    const { cmd, args: fullArgs } = makeRunnable([this.#cli, ...args]);
    return runCapture({ cmd, args: fullArgs, cwd, stdin: prompt, timeoutMs: this.#timeoutMs });
  }
}

/**
 * On Windows, a bare name is resolved by cmd.exe via PATHEXT, so no suffix
 * guessing is needed here -- makeRunnable() handles the routing.
 */
function resolveCli(cli) {
  return cli;
}

/**
 * `opencode run --format json` emits an NDJSON *event stream*, one JSON object per
 * line -- not a single JSON document. The answer lives in the `part.text` of a
 * `{"type":"text",...}` event, and the JSON we asked for is nested inside that text.
 *
 * The earlier implementation pulled the first balanced object out of the raw
 * output, which grabbed the event envelope and therefore saw a verdict of
 * "unsure" for every single response -- even a perfectly good one. This is only
 * catchable by running against the real CLI.
 */
function unwrapEvents(raw) {
  const texts = [];
  let providerError = null;
  let sawEvent = false;

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue; // partial line, or not an event at all
    }
    if (ev && ev.type === 'error' && ev.error) {
      providerError = ev;
      continue;
    }
    if (ev && ev.type === 'text' && typeof ev.part?.text === 'string') {
      texts.push(ev.part.text);
    }
    if (ev && typeof ev.type === 'string') sawEvent = true;
  }

  if (texts.length) return { text: texts.join('\n'), providerError };
  if (sawEvent) return { text: '', providerError };
  // Not a stream at all: treat the whole thing as the answer (hand-rolled stubs).
  return { text: raw, providerError };
}

/** Pull the first balanced JSON object out of arbitrary text (fences included). */
function extractJson(text) {
  // opencode --format json wraps the answer; pull the first balanced object out.
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Turns a provider error envelope into an explicit, actionable status.
 * `status` is what the CLI surfaces; it must never collapse into "unsure".
 */
function providerError(envelope) {
  const e = envelope?.error ?? {};
  const status = e.status;
  let reason = 'unknown provider failure';
  if (e.type === 'provider.quota' || status === 402) {
    reason = 'LLM account is out of funds (402). The second-opinion layer cannot run until it is topped up.';
  } else if (status === 401 || e.type === 'provider.auth' || /auth/i.test(e.type ?? '')) {
    reason = 'LLM credentials are missing or invalid (401).';
  } else if (status === 404) {
    reason = 'the configured model was not found (404).';
  } else if (status === 429) {
    reason = 'rate limited (429); backing off.';
  } else if (e.message) {
    reason = `${e.type ?? 'error'}: ${e.message}`;
  }
  return { verdict: 'unsure', confidence: 0, summary: reason, fix: null, raw: '', status: `provider_${status ?? 'error'}`, error: reason };
}

function normalize(p, raw) {
  const verdict = ['problem', 'noise', 'unsure'].includes(p.verdict) ? p.verdict : 'unsure';
  const confidence = typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0;
  let fix = null;
  if (verdict === 'problem' && p.fix && Array.isArray(p.fix.files)) {
    // Model output is untrusted input, so the shape is validated strictly here.
    // An empty path resolves to the working directory, and patching that produced
    // an EISDIR crash the first time a model returned `path: ""`.
    const files = p.fix.files
      .map((f) => {
        if (!f || typeof f.path !== 'string' || typeof f.find !== 'string' || typeof f.replace !== 'string') return null;
        const p2 = f.path.trim();
        if (p2 === '' || p2.includes('\0')) return null;
        if (p2.startsWith('/') || p2.startsWith('\\') || /^[A-Za-z]:/.test(p2)) return null; // absolute
        if (p2.split(/[\\/]/).includes('..')) return null; // traversal
        if (f.find === '' || f.find === f.replace) return null; // no-op
        return { path: p2, find: f.find, replace: f.replace };
      })
      .filter(Boolean);
    if (files.length) fix = { description: String(p.fix.description ?? 'proposed edit'), files };
  }
  return { verdict, confidence, summary: String(p.summary ?? ''), fix, raw: raw.slice(0, 2000) };
}

function err(message, status = 'failed') {
  return { verdict: 'unsure', confidence: 0, summary: message, fix: null, raw: '', status, error: message };
}
