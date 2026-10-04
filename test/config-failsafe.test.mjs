/**
 * A config that cannot be read must not grant permission.
 *
 * `readJsonIfExists` used to return `{}` on a parse error and let DEFAULTS fill
 * the gap. Since the default autonomy is `autonomous`, that made a failure
 * *increase* permissiveness: a config file containing
 *
 *     {"autonomy": "suggest"}
 *
 * that got truncated by a half-finished write, a bad hand-edit, or a disk
 * problem would silently run the watchdog applying fixes without asking. Exactly
 * backwards for a safety system.
 *
 * The rule these tests pin down: an unreadable layer pins autonomy to `suggest`,
 * whatever the readable layers and the defaults say.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULTS } from '../src/core/config.mjs';

const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'wd-cfg-'));
  writeFileSync(join(root, 'package.json'), '{"name":"cfg-test"}\n', 'utf8');
  mkdirSync(join(root, '.watchdog'), { recursive: true });
  return root;
};

const writeProjectConfig = (root, body) =>
  writeFileSync(join(root, '.watchdog', 'config.json'), body, 'utf8');

/**
 * The global layer is the real user's, and this test process must not read it --
 * it holds live Langfuse keys. Point HOME at a throwaway directory so the global
 * layer is absent and predictable.
 */
function withIsolatedHome(fn) {
  const original = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), 'wd-home-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    if (original === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = original;
  }
}

test('the default autonomy is still autonomous', () => {
  // Load-bearing for the whole finding: if this ever changes to `suggest`, the
  // fail-open no longer escalates and these tests would pass vacuously.
  assert.equal(DEFAULTS.autonomy, 'autonomous');
});

test('a truncated config cannot escalate suggest into autonomous', () => {
  withIsolatedHome(() => {
    const root = project();
    writeProjectConfig(root, '{"autonomy": "sugg'); // half-written

    const cfg = loadConfig({ cwd: root, projectRoot: root });
    assert.equal(cfg.autonomy, 'suggest', 'a broken file silently granted autonomous mode');
  });
});

test('a truncated config still reports what was wrong', () => {
  withIsolatedHome(() => {
    const root = project();
    writeProjectConfig(root, '{"autonomy": "sugg');

    const cfg = loadConfig({ cwd: root, projectRoot: root });
    const bad = cfg.safety?.configUnreadable;
    assert.ok(Array.isArray(bad) && bad.length, 'the downgrade was silent, so the user cannot tell');
    assert.equal(bad[0].layer, 'project');
    assert.match(bad[0].path, /\.watchdog[\\/]config\.json$/);
    assert.ok(bad[0].why, 'no reason recorded');
  });
});

test('an empty file is treated as unreadable, not as an empty opinion', () => {
  // An empty file parses to nothing. Treating that as "no settings" hands the
  // defaults the vote, which is the same escalation by another route.
  withIsolatedHome(() => {
    const root = project();
    writeProjectConfig(root, '');

    const cfg = loadConfig({ cwd: root, projectRoot: root });
    assert.equal(cfg.autonomy, 'suggest');
  });
});

test('valid JSON that is not an object is treated as unreadable', () => {
  for (const body of ['[1,2,3]', '"hello"', '42', 'null', 'true']) {
    withIsolatedHome(() => {
      const root = project();
      writeProjectConfig(root, body);
      const cfg = loadConfig({ cwd: root, projectRoot: root });
      assert.equal(cfg.autonomy, 'suggest', `${body} was treated as a valid config`);
    });
  }
});

test('a BOM is still tolerated, because that is a real editor artefact', () => {
  // Windows PowerShell's Set-Content -Encoding UTF8 and Notepad both write one.
  // Refusing autonomy for it would be correct-but-useless, so it is stripped.
  withIsolatedHome(() => {
    const root = project();
    writeProjectConfig(root, '\uFEFF{"autonomy": "allowlist"}');

    const cfg = loadConfig({ cwd: root, projectRoot: root });
    assert.equal(cfg.autonomy, 'allowlist', 'a BOM-only difference silently changed the mode');
    assert.ok(!cfg.safety?.configUnreadable?.length, 'a BOM was reported as corruption');
  });
});

test('a readable config is still honoured exactly', () => {
  withIsolatedHome(() => {
    const root = project();
    writeProjectConfig(root, '{"autonomy": "autonomous"}');

    const cfg = loadConfig({ cwd: root, projectRoot: root });
    assert.equal(cfg.autonomy, 'autonomous');
    assert.ok(!cfg.safety?.configUnreadable?.length, 'a valid config was flagged');
  });
});

test('an explicit "autonomous" survives a corrupt global layer', () => {
  // The readable project layer is authoritative for a per-repo autonomy choice,
  // and it must still be able to say autonomous. A broken *global* file must not
  // veto a deliberate project decision -- it just has to be reported.
  withIsolatedHome((home) => {
    const root = project();
    mkdirSync(join(home, '.watchdog'), { recursive: true });
    writeFileSync(join(home, '.watchdog', 'config.json'), '{{{ broken', 'utf8');
    writeProjectConfig(root, '{"autonomy": "autonomous"}');

    const cfg = loadConfig({ cwd: root, projectRoot: root });
    assert.equal(cfg.autonomy, 'autonomous', 'a broken global config blocked a deliberate project choice');
    assert.equal(cfg.safety.configUnreadable[0].layer, 'global');
  });
});

test('a broken project layer cannot be overridden into autonomous by defaults', () => {
  // The regression in its purest form: the file says suggest, is unreadable, and
  // the only other input is DEFAULTS -- which say autonomous.
  withIsolatedHome(() => {
    const root = project();
    writeProjectConfig(root, 'not json at all');

    const cfg = loadConfig({ cwd: root, projectRoot: root });
    assert.notEqual(cfg.autonomy, DEFAULTS.autonomy);
    assert.equal(cfg.autonomy, 'suggest');
  });
});

test('the rest of the config still loads when one layer is broken', () => {
  // Refusing to start is not the same as being safe. A watchdog that will not
  // run is a blind one, and silently losing monitoring is its own failure.
  withIsolatedHome(() => {
    const root = project();
    writeProjectConfig(root, '{"autonomy": "allowlist", broken');

    const cfg = loadConfig({ cwd: root, projectRoot: root });
    assert.equal(cfg.analyze.llm.cli, DEFAULTS.analyze.llm.cli, 'defaults were not applied to the readable settings');
    assert.equal(cfg.paths.data, join(root, '.watchdog'));
  });
});

test('an invalid autonomy value still throws rather than being coerced', () => {
  // A readable file asking for something that is not a mode is a user error we
  // cannot guess at. That must stay loud -- it is not the unreadable case.
  withIsolatedHome(() => {
    const root = project();
    writeProjectConfig(root, '{"autonomy": "AUTONOMOUS"}');
    assert.throws(() => loadConfig({ cwd: root, projectRoot: root }), /autonomy must be/);
  });
});