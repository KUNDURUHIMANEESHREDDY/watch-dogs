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
import { verifyProposals } from '../act/verify.mjs';
import { canonicalizeFix } from './paths.mjs';
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
 * The one-line summary of an applied model fix, chosen by what verification proved.
 *
 * This used to be the constant "applied after passing the project's own
 * verification", which reads as though the repair had been verified. It had not been.
 * The project's checks passing says the edit is not harmful; it says nothing about
 * the reported error unless the checks cover it, and this program has no way to know
 * whether they do.
 *
 * So the line states the transition, and in the common case says outright that the
 * repair is unproven. A user reading "applied" deserves to know which of the two
 * things happened.
 */
function appliedReason(evidence) {
  switch (evidence) {
    case 'repaired':
      return "applied: the project was failing its own verification before this edit and passes with it";
    case 'broke':
    case 'inconclusive':
      return 'applied, but verification did not support it -- see the verification reason';
    case 'unknown':
      return 'applied: it does not break the project checks, but they were not compared against the state before the edit';
    case 'not-broken':
    default:
      return "applied: it did not break a project that was already passing its own checks. That is not proof the reported error is fixed";
  }
}

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
    // Kept as plain fields because #applyLlmFix is async and cannot reach a
    // private member of a class it is not nested inside.
    this.projectRoot = cfg.projectRoot;
    this.verifyCfg = cfg.verify ?? null;
  }

  /**
   * Summarise a multi-file application honestly.
   *
   * A proposal can touch several files and they can succeed differently -- one
   * applied, one refused by the file-class policy, one skipped because the anchor
   * was gone. Collapsing that to a single status is what made the old code
   * report a partial write as a clean success.
   */
  static aggregate(results) {
    const n = results.length;
    const applied = results.filter((r) => r?.status === 'applied').length;
    const refused = results.filter((r) => r?.status === 'refused');
    const other = results.filter((r) => r && r.status !== 'applied' && r.status !== 'refused');

    let status;
    if (!n) status = 'none';
    else if (applied === n) status = 'all_applied';
    else if (applied === 0) status = refused.length ? 'refused' : 'none_applied';
    else status = 'partially_applied';

    const bits = [];
    if (applied !== n) bits.push(`${applied}/${n} applied`);
    if (refused.length) bits.push(`${refused.length} refused: ${refused.map((r) => r.why ?? 'refused').join('; ')}`);
    for (const r of other) bits.push(`${r.status}: ${r.why ?? ''}`.trim());

    return {
      status,
      allApplied: status === 'all_applied',
      summary: bits.join(' | '),
      applied,
      total: n,
    };
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
   * Give back a charge for a review this session did not actually cause.
   *
   * The budget is charged before the advisor is asked, so the per-session cap
   * cannot be overshot by concurrent requests. But a request that joined a review
   * already in flight spent nothing, and paying for it is wrong twice over: the
   * session is billed for a call it did not make, and its remaining allowance is
   * spent on a question somebody else already answered.
   */
  #refund(sessionId) {
    const key = sessionId ?? '';
    const now = this.#spent(key);
    if (now <= 0) return;
    this.#llmBudget.set(key, now - 1);
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
    // A coalesced review cost this session nothing, so it is not charged. The
    // charge happens before the advisor is called, which keeps the per-session cap
    // honest under concurrency; this is the correction once we know what actually
    // happened. It still gets the answer -- the alternative was being told `busy`
    // and learning nothing.
    if (advice.coalesced) this.#refund(rec.sessionId);

    rec.advisor = {
      pending: false,
      coalesced: advice.coalesced === true,
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

    // Confidence is a measure of how sure the model sounded, not of whether the
    // edit is right, so on its own it cannot authorise a write. The project's own
    // verification decides, with the model reduced to proposing.
    if (advice.verdict === 'problem' && advice.fix && advice.confidence >= 0.6) {
      rec.advisor.proposed = true;
      // Awaited so the record that is emitted carries the decision. Firing and
      // forgetting meant every consumer saw `finding-updated` before the gate had
      // run, so a reader could not tell whether the edit had been applied or
      // merely proposed.
      await this.#applyLlmFix(rec, advice);
    }
    this.#record(rec);
    this.emit('finding-updated', rec);
  }

  /**
   * Apply an LLM-proposed fix, but only after something has proved it is safe.
   *
   * The order matters and is the whole point: stage the project, apply the edits
   * to the copy, run the project's verification, and only then replay the same
   * edits against the real tree. The real project is never left half-edited
   * while the question is still open.
   *
   * Three outcomes, and all three are reported rather than collapsed:
   *
   *   pass        the project still passes its own checks; apply it
   *   fail        the edit breaks the project; keep it as a suggestion and say
   *               why, because a fix that fails the tests is worth showing
   *   unverified  there was no way to check; do not apply autonomously
   */
  async #applyLlmFix(rec, advice) {
    // Replaced by the canonical form below before anything is verified or written.

    // Canonicalise once, here, at the edge.
    //
    // The proposal's paths are relative to the session that produced them, while
    // the staged copy is made from the project root. Resolving the same string
    // twice -- once against the root for verification, once against the session
    // for the write -- meant a monorepo session could verify one file and change
    // another. `src/index.js` verified C:\repo\src\index.js and wrote
    // C:\repo\packages\api\src\index.js.
    //
    // So the same canonical string is used for both, and the write is made
    // against the project root rather than the session directory.
    const { files: canonical, rejected } = canonicalizeFix(advice.fix, rec.cwd ?? this.projectRoot, this.projectRoot);

    if (rejected.length) {
      rec.advisor.verification = {
        verdict: 'unverified',
        why: `refused ${rejected.length} proposed path(s) that resolve outside the project: ${rejected.map((r) => r.path).join(', ')}`,
      };
      rec.advisor.acted = false;
      rec.advisor.requiresHuman = true;
      rec.advisor.why = rec.advisor.verification.why;
      this.emit('needs-human', rec);
      return;
    }

    let verdict;
    try {
      verdict = await verifyProposals({
        projectRoot: this.projectRoot,
        files: canonical,
        verifyCfg: this.verifyCfg,
      });
    } catch (e) {
      verdict = { verdict: 'unverified', evidence: 'unknown', why: `verification could not be completed: ${e.message}` };
    }

    // `evidence` travels with the verdict, so nothing downstream can read a bare
    // `pass` and take it for a repair. See the note on EVIDENCE in verify.mjs: a
    // level is not a transition, and only the transition is evidence.
    rec.advisor.verification = { verdict: verdict.verdict, evidence: verdict.evidence ?? 'unknown', why: verdict.why };

    if (verdict.verdict !== 'pass') {
      rec.advisor.acted = false;
      rec.advisor.requiresHuman = true;
      rec.advisor.why =
        verdict.verdict === 'fail'
          ? `not applied automatically: ${verdict.why}`
          : `not applied automatically: ${verdict.why}`;
      this.emit('needs-human', rec);
      return;
    }

    // One transaction for the whole proposal.
    //
    // Verification judged all of these together, so applying them one at a time
    // could leave a mixture that passed no check: one file written, two refused,
    // and the repository in a state nobody verified. The applier opens and
    // validates every target first and writes only if all of them pass.
    const preimages = new Map((verdict.preimages ?? []).map((p) => [p.path, p.sha256]));

    const tx = this.#applier.applyAll(
      canonical.map((file) => ({
        kind: 'patch-file',
        path: file.path,
        find: file.find,
        replace: file.replace,
        // Enforced inside the applier, not trusted from here.
        expectPreimage: preimages.get(file.path),
      })),
      // `cwd: this.projectRoot`, not `rec.cwd`: the paths are project-root-relative
      // now, so resolving them against the session directory would put them back
      // where they started. `source: 'llm'` applies the file-class policy.
      { cwd: this.projectRoot, source: 'llm' },
    );
    const results = tx.results;

    // Every file's outcome is kept. Storing only the first result made a
    // three-file fix in which two writes were refused and one succeeded read as a
    // clean success, and it set acted=true before knowing whether any of the
    // writes had actually landed.
    const counts = aggregate(results);
    rec.applied = { status: counts.status, files: results };
    rec.advisor.acted = counts.allApplied;
    rec.advisor.why = counts.allApplied ? appliedReason(verdict.evidence) : counts.summary;

    if (!counts.allApplied) {
      rec.advisor.requiresHuman = true;
      this.emit('needs-human', rec);
    }
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
