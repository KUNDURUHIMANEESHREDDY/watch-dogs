/**
 * The watcher: a single process that owns findings, cooldown, the LLM queue, and
 * autonomy. Capture layers feed it lines; it is the only thing that decides.
 */
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, statSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, severityAtLeast, SEVERITY } from '../analyze/rules.mjs';
import { Advisor } from '../analyze/advisor.mjs';
import { Applier } from '../act/apply.mjs';
import { redact } from '../capture/stream.mjs';
import { log } from '../core/log.mjs';

/**
 * Broad "this is definitely an error" shape, used only to decide whether a line
 * the rules did NOT claim is worth asking the model about. Deliberately wider
 * than any single rule: the question is not "is this a known error" but "does
 * this look like something went wrong".
 */
const ERROR_SHAPE =
  /(^|\s)(error|errors|failed|failure|fatal|panic|exception|traceback|denied|refused|unreachable|invalid|unexpected|cannot|unable to|not found|no such file|unresolved|unhandled|timed? ?out)\b|^\s*(E\d{4}|FATAL)|\bERR!|:[0-9]+:[0-9]+: (error|fatal)|\b[A-Za-z]*(Error|Exception)\b\s*:/i;

/**
 * Success statements that happen to contain an error word. Found by the sandbox:
 * "Build completed with 0 errors" was triaged as a failure. Negation has to be
 * tested before the broad shape, or the residual path burns LLM budget on good news.
 */
const NOT_AN_ERROR =
  /\b(0|zero|no)\s+(errors?|failures?|failings?|warnings?)\b|\bcompleted with\b|\bbuild (succeeded|successful)\b|\bnothing to commit\b|\ball tests? passed\b/i;

/** Statuses meaning the advisor itself is broken, as opposed to merely busy. */
const ADVISOR_DOWN = new Set(['unavailable', 'timeout', 'failed', 'unparseable']);

/**
 * How many sessions keep a budget entry. The daemon watches every terminal on
 * the machine, so an unbounded map would retain one entry per shell that ever
 * opened for the life of the process. Far above the number of terminals anyone
 * actually has open at once.
 */
const MAX_TRACKED_BUDGET_SESSIONS = 500;

/**
 * Default cap on the findings log, before rotation.
 *
 * Larger than the daemon log's 2MB, because findings are records rather than
 * diagnostics: one previous generation is kept so a rotation does not silently
 * erase the recent history, and the safety-critical before/after for any applied
 * fix lives in the journal, not here.
 *
 * Overridable via analyze.maxFindingsBytes, which is also how the tests reach
 * rotation without writing 16MB to disk.
 */
const DEFAULT_MAX_FINDINGS_BYTES = 16 * 1024 * 1024;

/**
 * Move `path` aside to `path.1`, replacing any previous generation.
 *
 * Rotation must never be able to stop the daemon recording findings, so every
 * failure here is swallowed: the worst case is a log that grew too large, which is
 * the situation we started in.
 */
function rotateFile(path) {
  try {
    const prev = path + '.1';
    try {
      if (existsSync(prev)) unlinkSync(prev);
    } catch {
      /* best effort */
    }
    renameSync(path, prev);
  } catch (e) {
    log.debug('findings log rotation failed: ' + e.message);
  }
}

export function looksLikeError(line) {
  if (NOT_AN_ERROR.test(line)) return false;
  return ERROR_SHAPE.test(line);
}

export class Watcher extends EventEmitter {
  #cfg;
  #advisor;
  #applier;
  #findings = [];
  #cooldown = new Map();
  // Per session, despite the single counter this replaced. A shared budget meant
  // one terminal with a noisy build consumed the whole allowance and every other
  // terminal got silence -- the opposite of what maxInvocationsPerSession says.
  #llmBudget = new Map();
  #findingsPath;
  #bytesAtLastCheck = null;
  #advisorWarned = false;

  constructor(cfg) {
    super();
    this.#cfg = cfg;
    mkdirSync(cfg.paths.data, { recursive: true });
    this.#findingsPath = join(cfg.paths.data, 'findings.jsonl');
    this.#advisor = new Advisor({
      cli: cfg.analyze.llm.cli,
      model: cfg.analyze.llm.model,
      timeoutMs: cfg.analyze.llm.timeoutMs,
    });
    this.#applier = new Applier({
      projectRoot: cfg.projectRoot,
      dataDir: cfg.paths.data,
      autonomy: cfg.autonomy,
      allowlist: cfg.allowlist ?? [],
    });
  }

  get applier() {
    return this.#applier;
  }

  get llmBudget() {
    return this.#llmBudget.size;
  }

  /** Invocations already spent by one session. */
  #spent(sessionId) {
    return this.#llmBudget.get(sessionId ?? '') ?? 0;
  }

  /**
   * Charge one invocation to a session's budget.
   *
   * Bounded by the map growing without limit: a daemon that watches every
   * terminal on a long uptime would otherwise retain one entry per shell that
   * ever existed. Insertion order is oldest-first, so the front is the one to go.
   */
  #charge(sessionId) {
    const key = sessionId ?? '';
    this.#llmBudget.set(key, this.#spent(key) + 1);
    while (this.#llmBudget.size > MAX_TRACKED_BUDGET_SESSIONS) {
      const oldest = this.#llmBudget.keys().next().value;
      if (oldest === undefined) break;
      this.#llmBudget.delete(oldest);
    }
  }

  #hasBudget(sessionId) {
    return this.#spent(sessionId) < this.#cfg.analyze.llm.maxInvocationsPerSession;
  }

  /**
   * Feed one captured line. Returns the findings the rules produced; LLM work is
   * fire-and-forget and reports back via events.
   */
  async ingest(line, { sessionId, cwd, shell } = {}) {
    const text = this.#cfg.capture.redact ? redact(line) : line;
    const produced = evaluate(text, { sessionId, cwd });

    // Residual triage. Found by the sandbox: the advisor used to only ever see
    // problems the rules already understood, so it could never contribute
    // anything the rules did not already know. An error-shaped line that no rule
    // claimed is precisely the case a second opinion is for.
    if (!produced.length && this.#cfg.analyze.llm.enabled && looksLikeError(text)) {
      this.#triage(text, { sessionId, cwd, shell });
    }

    if (!produced.length) return [];

    const enriched = [];
    for (const f of produced) {
      const rec = { ...f, shell, raw: text };
      rec.signature = `${rec.ruleId}::${rec.evidence.slice(0, 120)}`;

      const last = this.#cooldown.get(rec.signature) ?? 0;
      if (Date.now() - last < this.#cfg.analyze.cooldownMs) {
        rec.suppressed = 'cooldown';
        this.#record(rec);
        enriched.push(rec);
        continue;
      }
      this.#cooldown.set(rec.signature, Date.now());

      const eligible =
        this.#cfg.analyze.llm.enabled &&
        rec.confidence !== 'high' &&
        severityAtLeast(rec.severity, this.#cfg.analyze.llm.minSeverity) &&
        this.#hasBudget(rec.sessionId);

      if (eligible) {
        this.#charge(rec.sessionId);
        rec.advisor = { pending: true };
        this.#record(rec);
        this.#askAdvisor(rec).catch((e) => log.warn('advisor failed', e));
      } else {
        rec.advisor = { pending: false, reason: this.#cfg.analyze.llm.enabled ? 'not eligible' : 'llm disabled' };
      }

      this.#runFix(rec, { cwd });
      this.#record(rec);
      enriched.push(rec);
      this.emit('finding', rec);
    }

    this.#trim();
    return enriched;
  }

  /**
   * Ask the model about an error line no rule recognised. Kept separate from the
   * rule path so its provenance stays visible on the record.
   */
  #triage(text, ctx) {
    const signature = `residual::${text.slice(0, 120)}`;
    const last = this.#cooldown.get(signature) ?? 0;
    if (Date.now() - last < this.#cfg.analyze.cooldownMs) return;
    if (!this.#hasBudget(ctx.sessionId)) return;
    this.#cooldown.set(signature, Date.now());
    this.#charge(ctx.sessionId);

    const rec = {
      ruleId: 'unrecognised-error',
      severity: 'medium',
      confidence: 'unknown',
      title: 'Error line not matched by any rule',
      explain:
        'This line looks like a failure but no deterministic rule recognised it, so the model was asked for a second opinion.',
      evidence: text.slice(0, 500),
      fix: null,
      tags: ['residual'],
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      at: new Date().toISOString(),
      signature,
      shell: ctx.shell,
      raw: text,
      advisor: { pending: true },
    };
    this.#record(rec);
    this.emit('finding', rec);
    this.#askAdvisor(rec).catch((e) => log.warn('advisor failed on residual', e));
  }

  async #askAdvisor(rec) {
    const advice = await this.#advisor.review({
      evidence: rec.evidence,
      cwd: rec.cwd ?? this.#cfg.projectRoot,
      title: rec.title,
      // Tracing needs the resolved config to know whether it is on, and the
      // session id so traces from one terminal group together.
      cfg: this.#cfg,
      sessionId: rec.sessionId,
    });
    rec.advisor = {
      pending: false,
      verdict: advice.verdict,
      confidence: advice.confidence,
      summary: advice.summary,
      error: advice.error,
      status: advice.status ?? null,
    };

    // A dead or unfunded LLM must not look like a model saying "unsure".
    const down = advice.status && (advice.status.startsWith('provider_') || ADVISOR_DOWN.has(advice.status));
    if (down && !this.#advisorWarned) {
      this.#advisorWarned = true;
      this.emit('advisor-down', advice);
    }

    if (advice.verdict === 'problem' && advice.fix && advice.confidence >= 0.6) {
      const results = [];
      for (const file of advice.fix.files) {
        results.push(
          // source: 'llm' so the guard applies the file-class policy. Without it
          // the model could rewrite a CI workflow or a package manifest here,
          // because the existing rails only ask whether the path is forbidden.
          this.#applier.apply(
            { kind: 'patch-file', path: file.path, find: file.find, replace: file.replace },
            { cwd: rec.cwd, source: 'llm' },
          ),
        );
      }
      rec.advisor.acted = true;
      rec.applied = results[0] ?? null;

      // A refusal here is not a silent no-op. The proposal was reasonable and
      // the human still needs to see it, so the finding is recorded as
      // suggestion-only rather than disappearing.
      const refused = results.find((r) => r?.status === 'refused');
      if (refused) {
        rec.advisor.acted = false;
        rec.advisor.requiresHuman = true;
        rec.advisor.why = refused.why ?? 'refused';
        this.emit('needs-human', rec);
      }
    }
    this.#record(rec);
    this.emit('finding-updated', rec);
  }

  /** Applies a fix without ever blocking the ingest path. */
  #runFix(rec, { cwd }) {
    if (!rec.fix || rec.severity === 'info') return;
    if (rec.fix.kind === 'command' || rec.fix.kind === 'install-deps') {
      rec.applied = { status: 'running' };
      this.#applier
        .applyAsync(rec.fix, { cwd })
        .then((result) => {
          rec.applied = result;
          this.#record(rec);
          this.emit('finding-updated', rec);
        })
        .catch((e) => {
          rec.applied = { status: 'error', why: e.message };
          this.#record(rec);
        });
    } else {
      rec.applied = this.#applier.apply(rec.fix, { cwd });
    }
  }

  #trim() {
    const max = this.#cfg.analyze.maxFindingsPerSession;
    if (this.#findings.length > max) this.#findings.splice(0, this.#findings.length - max);
  }

  #record(rec) {
    const i = this.#findings.findIndex(
      (f) => f === rec || (f.signature === rec.signature && f.sessionId === rec.sessionId && f.at === rec.at),
    );
    if (i !== -1) this.#findings[i] = rec;
    try {
      const line = JSON.stringify(rec) + '\n';
      this.#appendFindings(line);
    } catch (e) {
      log.warn('could not persist finding', e);
    }
  }

  /**
   * Append to the findings log, rotating it when it grows past the cap.
   *
   * The in-memory findings list is already trimmed, so this was the only thing on
   * disk that grew without bound. Two consequences beyond disk: `wd findings`
   * reads and JSON-parses the entire file on every call, so an uncapped log made
   * that slower and more memory-hungry for as long as the daemon ran.
   *
   * Size is tracked in memory rather than stat()ing on every append, because
   * #record is called several times per finding as it moves from pending to acted.
   */
  #appendFindings(line) {
    if (this.#bytesAtLastCheck === null) {
      try {
        this.#bytesAtLastCheck = statSync(this.#findingsPath).size;
      } catch {
        this.#bytesAtLastCheck = 0;
      }
    }
    const bytes = Buffer.byteLength(line);
    if (this.#bytesAtLastCheck + bytes > this.#maxFindingsBytes()) {
      rotateFile(this.#findingsPath);
      this.#bytesAtLastCheck = 0;
    }
    appendFileSync(this.#findingsPath, line);
    this.#bytesAtLastCheck += bytes;
  }

  #maxFindingsBytes() {
    const configured = Number(this.#cfg.analyze?.maxFindingsBytes);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_FINDINGS_BYTES;
  }

  findings(filter = {}) {
    return this.#findings
      .filter((f) => (filter.minSeverity ? severityAtLeast(f.severity, filter.minSeverity) : true))
      .filter((f) => (filter.rule ? f.ruleId === filter.rule : true))
      .sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || (a.at < b.at ? 1 : -1));
  }
}
