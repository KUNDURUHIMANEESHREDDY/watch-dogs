/**
 * What a verification result is allowed to claim.
 *
 * Verification runs the project's own check on a staged copy, before and after the
 * edit. That establishes one thing: whether the project's checks still pass. It says
 * nothing about whether the reported error was fixed, because whether the checks
 * *cover* the reported error is not something this program knows or can find out.
 *
 * The mistake was reporting the two as one word. `pass` used to mean "the project
 * passes its own verification", which is true of a project whose checks never touched
 * the bug, and equally true of a project that was already broken and stayed broken.
 *
 * Worse, the missing baseline produced errors in both directions:
 *
 *   - false positive: an unrelated edit on a passing project read as a fix.
 *   - false negative: a correct edit on an *already failing* project was rejected,
 *     because the project was broken for some other reason and the verdict said the
 *     edit broke it.
 *
 * That second one had no test at all. The classification below is the contract, and
 * each case is pinned separately because they are separately wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyProposals } from '../src/act/verify.mjs';

/**
 * A project whose "verification" loads the file under test and then reports a marker.
 *
 * The load is not incidental. An earlier version of this file had the check merely
 * test for the marker's existence, so the edits never ran and two tests silently
 * asserted nothing: the file was modified, the marker's presence was decided by the
 * project fixture alone, and the verdicts came from the state the test had arranged
 * before the edit rather than from anything the edit did.
 */
function project({ passing }) {
  const root = mkdtempSync(join(tmpdir(), 'wd-evidence-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'const A = 1;\nmodule.exports = { A };\n', 'utf8');
  writeFileSync(
    join(root, 'check.mjs'),
    "import { existsSync } from 'node:fs';\nimport { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./src/a.js');\nprocess.exit(existsSync('PASS') ? 0 : 1);\n",
    'utf8',
  );
  if (passing) writeFileSync(join(root, 'PASS'), '', 'utf8');
  return root;
}

const cfg = { command: ['node', 'check.mjs'], timeoutMs: 30_000 };

/** One edit that applies cleanly and changes a real file. */
const files = [{ path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;' }];

const run = (root) => verifyProposals({ projectRoot: root, files, verifyCfg: cfg });

test('a project that was failing and now passes is reported as repaired', async () => {
  const root = project({ passing: false });
  // The edit "fixes" the check by making the marker exist -- which is exactly the
  // shape of a real repair as far as the verifier can tell.
  const fixMakesItPass = [{ path: 'src/a.js', find: 'const A = 1;', replace: "const A = 1;\nrequire('fs').writeFileSync('PASS','');" }];
  const r = await verifyProposals({ projectRoot: root, files: fixMakesItPass, verifyCfg: cfg });

  assert.equal(r.verdict, 'pass');
  assert.equal(r.evidence, 'repaired');
  // Even the strongest verdict must not claim to understand the bug.
  assert.match(r.why, /strongest evidence available here/i);
  assert.match(r.why, /not proof/i);
});

test('a project that was passing and still passes is not called a repair', async () => {
  // The case the audit was about. The edit is plausible, applies cleanly, and the
  // project's own checks still pass -- because they never covered the reported error.
  const root = project({ passing: true });
  const r = await run(root);

  assert.equal(r.verdict, 'pass', 'the edit should still be allowed to apply');
  assert.equal(r.evidence, 'not-broken');
  assert.match(r.why, /did not break anything/i);
  assert.match(r.why, /not evidence that the reported error is fixed/i);
  // The strongest available guard against this being read as a fix.
  assert.doesNotMatch(r.why, /passes its own verification with this edit applied/);
});

test('a project that was already failing is not told the edit broke it', async () => {
  // The false negative, and the one with no prior coverage. The verdict is still fail,
  // so nothing is applied -- but the reason has to be honest, because "your fix broke
  // the build" is exactly what a user will act on.
  const root = project({ passing: false });
  const r = await run(root);

  assert.equal(r.verdict, 'fail');
  assert.equal(r.evidence, 'inconclusive');
  assert.match(r.why, /already failing/i);
  assert.match(r.why, /cannot be attributed/i);
  assert.doesNotMatch(r.why, /leaves the project failing a check it was passing/);
});

test('a project that was passing and now fails is a regression, and says so', async () => {
  const root = project({ passing: true });
  const breaksIt = [{ path: 'src/a.js', find: 'const A = 1;', replace: "const A = 1;\nrequire('fs').unlinkSync('PASS');" }];
  const r = await verifyProposals({ projectRoot: root, files: breaksIt, verifyCfg: cfg });

  assert.equal(r.verdict, 'fail');
  assert.equal(r.evidence, 'broke');
  assert.match(r.why, /it was passing before/);
});

test('no verification command is still unknown, never a pass', async () => {
  const root = project({ passing: true });
  const r = await verifyProposals({ projectRoot: root, files, verifyCfg: null });

  assert.equal(r.verdict, 'unverified');
  assert.equal(r.evidence, 'unknown');
});

test('every verdict carries evidence, so a consumer cannot read a bare pass', async () => {
  // The contract is only worth anything if it is impossible to ignore. A consumer
  // reading `verdict: pass` still has to look at `evidence` to know what it means,
  // and that is the point.
  const cases = [
    [project({ passing: true }), 'pass'],
    [project({ passing: false }), 'fail'],
  ];
  for (const [root, expected] of cases) {
    const r = await run(root);
    assert.equal(r.verdict, expected);
    assert.ok(r.evidence, `verdict ${expected} came back with no evidence field`);
    assert.ok(r.why.length > 30, 'the reason is too short to carry the nuance it must carry');
  }
});

test('the baseline is measured before the edit, not inferred afterwards', async () => {
  // A check that only passes on its *second* invocation. That can only happen if the
  // command ran twice and the baseline ran first: a single run after the edit would
  // see no COUNT and exit 1, reporting a failure for an edit that is fine.
  //
  // This is the property the whole classification rests on, and it is cheap to assert
  // -- which makes its absence in the original suite worth noting.
  const root = mkdtempSync(join(tmpdir(), 'wd-evidence-order-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'const A = 1;\nmodule.exports = { A };\n', 'utf8');
  writeFileSync(
    join(root, 'twice.mjs'),
    "import { existsSync, writeFileSync } from 'node:fs';\n" +
      "if (!existsSync('COUNT')) { writeFileSync('COUNT', ''); process.exit(1); }\n" +
      'process.exit(0);\n',
    'utf8',
  );

  const r = await verifyProposals({
    projectRoot: root,
    files: [{ path: 'src/a.js', find: 'const A = 1;', replace: 'const A = 2;' }],
    verifyCfg: { command: ['node', 'twice.mjs'], timeoutMs: 30_000 },
  });

  assert.equal(r.verdict, 'pass');
  assert.equal(r.evidence, 'repaired', 'the baseline did not run first, so no comparison was made');
});