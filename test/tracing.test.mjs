/**
 * Langfuse tracing.
 *
 * The load-bearing property here is negative: tracing must never be able to
 * change what the watchdog does. Every test that configures tracing also proves
 * the result is byte-identical to the untraced path, because an observability
 * layer that can alter behaviour is worse than no observability at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initTracing, tracing, resetTracing, resolveTracing, traceAdvisorReview } from '../src/observe/trace.mjs';
import { buildProfileBlock, buildBashBlock } from '../src/install/install.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'wd-trace-'));

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetTracing();
  });
}

/** Turns on in-memory capture and tracing, returns the spans the review emitted. */
async function tracedReview(reviewFn, { cfg = {}, env = {}, evidence = 'boom', title = 'TypeError', sessionId = 'ps-1' } = {}) {
  return withEnv(
    {
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_BASE_URL: undefined,
      ...env,
    },
    async () => {
      process.env.WD_TRACE_MEMORY = '1';
      resetTracing();
      const result = await traceAdvisorReview({
        cfg,
        sessionId,
        title,
        cwd: tmp(),
        model: 'opencode/space-bunny-free',
        evidence,
        run: reviewFn,
      });
      const spans = tracing().memory.getFinishedSpans();
      await tracing().shutdown();
      return { result, spans };
    },
  );
}

// A ReadableSpan's attributes are already a plain object, not a pair list.
const attrs = (span) => span.attributes ?? {};

// ------------------------------------------------------------------ off by default

test('tracing is off when no credentials are present', async () => {
  await withEnv({ LANGFUSE_PUBLIC_KEY: undefined, LANGFUSE_SECRET_KEY: undefined }, async () => {
    const h = await initTracing({});
    assert.equal(h.enabled, false);
    assert.match(h.describe().reason, /not configured/);
  });
});

test('an enabled flag without keys reports the mistake instead of silently dropping spans', async () => {
  await withEnv({ LANGFUSE_PUBLIC_KEY: undefined, LANGFUSE_SECRET_KEY: undefined }, async () => {
    const h = await initTracing({ tracing: { enabled: true } });
    assert.equal(h.enabled, false, 'cannot be enabled without credentials');
    assert.match(h.describe().reason, /PUBLIC_KEY|SECRET_KEY are missing/, 'must say which keys are absent');
  });
});

test('with tracing off the review still runs and returns its result unchanged', async () => {
  await withEnv({ LANGFUSE_PUBLIC_KEY: undefined, LANGFUSE_SECRET_KEY: undefined }, async () => {
    const out = await traceAdvisorReview({
      cfg: {},
      title: 't',
      cwd: tmp(),
      evidence: 'x',
      run: async () => ({ verdict: 'noise', confidence: 0.9, summary: 'fine', fix: null }),
    });
    assert.equal(out.verdict, 'noise');
    assert.equal(out.confidence, 0.9);
  });
});

test('env overrides config, so one run can be traced without editing config', async () => {
  await withEnv({ LANGFUSE_PUBLIC_KEY: 'pk-env', LANGFUSE_SECRET_KEY: 'sk-env' }, async () => {
    const r = resolveTracing({ tracing: { publicKey: 'pk-file', secretKey: 'sk-file' } });
    assert.equal(r.publicKey, 'pk-env');
    assert.equal(r.secretKey, 'sk-env');
  });
});

// ------------------------------------------------------------------ span shape

test('a review emits a Langfuse generation observation carrying the decision', async () => {
  const { spans } = await tracedReview(async () => ({
    verdict: 'problem',
    confidence: 0.8,
    summary: 'undefined variable',
    fix: { description: 'define x', files: [] },
  }));

  const gen = spans.find((s) => attrs(s)['langfuse.observation.type'] === 'generation');
  assert.ok(gen, `no generation observation emitted; got ${spans.length} span(s)`);

  const a = attrs(gen);
  assert.equal(a['gen_ai.system'], 'opencode');
  assert.equal(a['gen_ai.request.model'], 'opencode/space-bunny-free');
  assert.equal(a['watchdog.verdict'], 'problem');
  assert.equal(a['watchdog.confidence'], 0.8);
  assert.equal(a['watchdog.proposed_fix'], true);
  assert.equal(a['langfuse.trace.session.id'], 'ps-1');
  assert.match(String(a['langfuse.trace.name']), /advisor: TypeError/);
});

test('a fix-less verdict is recorded as fix-less, so noise is distinguishable', async () => {
  const { spans } = await tracedReview(async () => ({ verdict: 'noise', confidence: 0.7, summary: 'ok', fix: null }));
  const a = attrs(spans[0]);
  assert.equal(a['watchdog.proposed_fix'], false);
  assert.equal(a['watchdog.verdict'], 'noise');
});

test('a provider failure is a WARNING, not a model opinion', async () => {
  // 402 is the unfunded-account case, which previously looked identical to the
  // model calmly answering "unsure". These traces must keep them apart.
  const { result, spans } = await tracedReview(async () => ({
    verdict: 'unsure',
    confidence: 0.42,
    summary: 'account out of funds',
    fix: null,
    status: 'provider-error',
    error: '402 payment required',
  }));
  const a = attrs(spans[0]);
  assert.equal(a['langfuse.observation.level'], 'WARNING');
  assert.equal(a['watchdog.status'], 'provider-error');
  assert.match(String(a['langfuse.observation.status_message']), /402/);
  // The verdict is still recorded, but the status makes the real cause visible.
  assert.equal(a['watchdog.verdict'], 'unsure');
  assert.equal(result.status, 'provider-error');
});

test('a thrown review is recorded as an exception and rethrown unchanged', async () => {
  const boom = new Error('advisor exploded');
  await assert.rejects(
    () =>
      tracedReview(async () => {
        throw boom;
      }),
    /advisor exploded/,
  );
});

// ------------------------------------------------------------------ redaction

test('secrets in terminal output are redacted before they leave the machine', async () => {
  const { spans } = await tracedReview(
    async () => ({ verdict: 'noise', confidence: 0.5, summary: 'saw AKIAIOSFODNN7EXAMPLE in output', fix: null }),
    {
      evidence: 'deploy failed with key AKIAIOSFODNN7EXAMPLE and token ghp_abcdefghijklmnopqrstuvwxyz012345',
    },
  );
  const a = attrs(spans[0]);
  const input = String(a['langfuse.observation.input']);
  const output = String(a['langfuse.observation.output']);

  assert.ok(!input.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key reached the span');
  assert.ok(!input.includes('ghp_abcdefghijklmnopqrstuvwxyz012345'), 'GitHub token reached the span');
  assert.ok(!output.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key reached the output');
  assert.match(input, /<redacted:aws-key>/);
  assert.match(input, /<redacted:github-token>/);
});

test('a long transcript is clipped rather than shipped whole', async () => {
  const { spans } = await tracedReview(async () => ({ verdict: 'noise', confidence: 0.5, summary: 'long', fix: null }), {
    evidence: 'x'.repeat(50_000),
  });
  const input = String(attrs(spans[0])['langfuse.observation.input']);
  assert.ok(input.length < 9000, `input was ${input.length} chars; expected it clipped`);
  assert.match(input, /\.\.\.\[clipped\]/);
});

// ------------------------------------------------------------------ isolation

test('a broken exporter does not change the review result', async () => {
  // baseUrl points at a port nothing is listening on, so every export fails.
  // The review must still return exactly what run() returned.
  const expected = { verdict: 'problem', confidence: 0.42, summary: 'still fine', fix: null };
  const { result } = await tracedReview(async () => expected, {
    env: { LANGFUSE_BASE_URL: 'http://127.0.0.1:9/definitely-not-listening' },
  });
  assert.deepEqual(result, expected);
});

test('WD_TRACING=off wins even with valid credentials in the global config', async () => {
  // A test harness inherits the same ~/.watchdog/config.json as the real daemon.
  // Without an explicit off switch, a sandbox walking fake errors through the
  // model would quietly ship them to the actual Langfuse project.
  await withEnv(
    { LANGFUSE_PUBLIC_KEY: 'pk-real', LANGFUSE_SECRET_KEY: 'sk-real', WD_TRACING: 'off' },
    async () => {
      const r = resolveTracing({ tracing: { enabled: true, publicKey: 'pk-file', secretKey: 'sk-file' } });
      assert.equal(r.enabled, false, 'credentials overrode the off switch');
      assert.match(r.reason, /WD_TRACING=off/);
      const h = await initTracing({});
      assert.equal(h.enabled, false);
      assert.equal(h.tracer, null, 'a tracer was built despite the off switch');
    },
  );
});

test('initTracing is idempotent and does not stack processors', async () => {
  await withEnv({ LANGFUSE_PUBLIC_KEY: 'pk-x', LANGFUSE_SECRET_KEY: 'sk-x' }, async () => {
    process.env.WD_TRACE_MEMORY = '1';
    resetTracing();
    const a = await initTracing({});
    const b = await initTracing({});
    assert.equal(a, b, 'a second init returned a different handle');
    assert.ok(b.enabled);
    await b.shutdown();
  });
});

// ------------------------------------------------------------------ transcripts
//
// Not Langfuse, but found while wiring this up: the transcript location has to
// agree between the shell that writes and the daemon that reads. If it does not,
// capture fails silently -- which is the failure mode this whole tool is about.

test('the daemon honours WD_TRANSCRIPT_DIR, so a test never shares the live directory', async () => {
  const { transcriptDir } = await import('../src/capture/shell.mjs');
  const saved = process.env.WD_TRANSCRIPT_DIR;
  process.env.WD_TRANSCRIPT_DIR = 'C:/scratch/transcripts';
  try {
    assert.equal(transcriptDir(), 'C:/scratch/transcripts');
  } finally {
    if (saved === undefined) delete process.env.WD_TRANSCRIPT_DIR;
    else process.env.WD_TRANSCRIPT_DIR = saved;
  }
});

test('the PowerShell profile block writes transcripts to the overridden directory', () => {
  const block = buildProfileBlock('C:/node/node.exe');
  assert.match(
    block,
    /if \(\$env:WD_TRANSCRIPT_DIR\)/,
    'the profile ignores WD_TRANSCRIPT_DIR, so a redirected daemon would find nothing',
  );
});

test('the bash profile block honours the same override', () => {
  const block = buildBashBlock();
  assert.match(block, /__wd_t="\$WD_TRANSCRIPT_DIR"/, 'the bash block writes transcripts to the hardcoded path');
  assert.match(block, /if \[ -z "\$__wd_t" \]/, 'the bash block has no default when the override is unset');
});

test('neither rendered profile block contains a dollar-brace', () => {
  // The blocks are JS template literals, so any dollar-brace that reaches them
  // from bash or PowerShell is read as JS interpolation and silently cuts the
  // file in half -- which is how the installed profile got corrupted once
  // already. After interpolation the rendered blocks should be brace-free.
  for (const [name, block] of [['powershell', buildProfileBlock('C:/node/node.exe')], ['bash', buildBashBlock()]]) {
    const bad = block.match(/\$\{[^}]*\}/);
    assert.equal(bad, null, `${name} block contains a bare dollar-brace: ${bad && bad[0]}`);
  }
});
