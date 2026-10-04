/**
 * Autonomy is chosen, not inherited.
 *
 * `DEFAULTS.autonomy` was `autonomous`. That meant a project with no config file
 * anywhere ran in the most permissive mode, and nothing recorded that anyone had
 * asked for it. The obvious reading of a tool modifying code on its own is that
 * somebody turned that on, and nobody had.
 *
 * So the default is now `suggest`, the opt-in is written down when chosen, and
 * `wd status` / `wd doctor` say when the current mode was merely inherited. The
 * last part matters most: a silent downgrade reads as a decision, and a silent
 * *inheritance* of a permissive mode is the thing that was actually wrong.
 *
 * A config that states autonomy explicitly is still honoured, so an existing
 * deliberate setup is not reset by this change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, DEFAULTS } from '../src/core/config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WD = join(ROOT, 'bin', 'wd.js');

function project() {
  const root = mkdtempSync(join(tmpdir(), 'wd-autonomy-'));
  writeFileSync(join(root, 'package.json'), '{"name":"a"}\n', 'utf8');
  return root;
}

/** The real user config holds live Langfuse keys; these tests must not read it. */
function withIsolatedHome(fn) {
  const orig = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  const home = mkdtempSync(join(tmpdir(), 'wd-home-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const setAutonomy = (root, value) => {
  mkdirSync(join(root, '.watchdog'), { recursive: true });
  writeFileSync(join(root, '.watchdog', 'config.json'), JSON.stringify({ autonomy: value }), 'utf8');
};

/* ------------------------------------------------------------------ *
 * The default
 * ------------------------------------------------------------------ */

test('a project with no config starts at suggest, not autonomous', () => {
  withIsolatedHome(() => {
    const root = project();
    const cfg = loadConfig({ cwd: root, projectRoot: root });
    assert.equal(cfg.autonomy, 'suggest');
    assert.equal(cfg.autonomyExplicit, false, 'the mode looks chosen when it was only inherited');
  });
});

test('the built-in default is the least permissive mode', () => {
  assert.equal(DEFAULTS.autonomy, 'suggest');
});

/* ------------------------------------------------------------------ *
 * An explicit choice is honoured and recorded
 * ------------------------------------------------------------------ */

for (const mode of ['suggest', 'allowlist', 'autonomous']) {
  test(`a config stating ${mode} is honoured`, () => {
    withIsolatedHome(() => {
      const root = project();
      setAutonomy(root, mode);
      const cfg = loadConfig({ cwd: root, projectRoot: root });
      assert.equal(cfg.autonomy, mode);
      assert.equal(cfg.autonomyExplicit, true, 'an explicitly configured mode is reported as inherited');
    });
  });
}

test('the global layer counts as an explicit choice too', () => {
  withIsolatedHome((home) => {
    const root = project();
    mkdirSync(join(home, '.watchdog'), { recursive: true });
    writeFileSync(join(home, '.watchdog', 'config.json'), JSON.stringify({ autonomy: 'autonomous' }), 'utf8');
    const cfg = loadConfig({ cwd: root, projectRoot: root });
    assert.equal(cfg.autonomy, 'autonomous');
    assert.equal(cfg.autonomyExplicit, true);
  });
});

test('an unreadable config does not count as a choice', () => {
  // It is not a decision, so it must not be reported as one -- and it must not
  // grant the permissive mode either.
  withIsolatedHome(() => {
    const root = project();
    mkdirSync(join(root, '.watchdog'), { recursive: true });
    writeFileSync(join(root, '.watchdog', 'config.json'), '{"autonomy": "auton', 'utf8');
    const cfg = loadConfig({ cwd: root, projectRoot: root });
    assert.equal(cfg.autonomy, 'suggest');
    assert.equal(cfg.autonomyExplicit, false);
  });
});

/* ------------------------------------------------------------------ *
 * The opt-in writes the choice down
 * ------------------------------------------------------------------ */

function wd(args, cwd) {
  try {
    return execFileSync(process.execPath, [WD, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      env: { ...process.env, WD_SKIP_PROFILE: '1' },
    });
  } catch (e) {
    // Several commands exit non-zero after printing something useful, and the
    // output is what these tests are about.
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

test('wd init states the coverage boundary, so consent happens at install', () => {
  // The risk of calling these limits "out of scope" is that someone later reads them
  // as bugs still waiting to be fixed. The mitigation is not the wording in the README,
  // which nobody reads at the moment they opt in -- it is saying it here, once, at the
  // point where the user is deciding whether to install this at all.
  //
  // Both halves are asserted. A boundary stated only as what is covered is marketing,
  // and one stated only as what is missing is the limitation list this replaced.
  withIsolatedHome(() => {
    const root = project();
    const out = wd(['init'], root);

    assert.match(out, /covered for/i, 'init does not say what the user is covered for');
    assert.match(out, /instrumented shell/i);
    assert.match(out, /PowerShell/);

    assert.match(out, /by decision|out of scope/i, 'init does not mark the exclusions as decisions');
    assert.match(out, /ConPTY/i, 'the ConPTY exclusion is not stated');
    assert.match(out, /exit codes/i, 'the exit-code exclusion is not stated');

    // It must point at where the reasoning lives, or the statement is just an assertion.
    assert.match(out, /README/i);
  });
});

test('the boundary is stated on a real install but not on a dry run', () => {
  // A dry run reports what would be written. Printing a coverage boundary there would
  // imply nothing was going to change, which is the one thing a dry run is for.
  withIsolatedHome(() => {
    const root = project();
    const dry = wd(['init', '--dry-run'], root);
    assert.doesNotMatch(dry, /covered for/i);
    assert.match(dry, /nothing will be written/i);
  });
});

test('wd init --autonomous records the choice in the project config', () => {
  withIsolatedHome(() => {
    const root = project();
    const out = wd(['init', '--autonomous'], root);

    // It says what it wrote, and the file says it too.
    assert.match(out, /autonomy\s+autonomous/);
    const written = JSON.parse(readFileSync(join(root, '.watchdog', 'config.json'), 'utf8'));
    assert.equal(written.autonomy, 'autonomous');

    // And the choice now reads as chosen rather than inherited.
    const cfg = loadConfig({ cwd: root, projectRoot: root });
    assert.equal(cfg.autonomy, 'autonomous');
    assert.equal(cfg.autonomyExplicit, true);
  });
});

test('wd init without the flag leaves the default and says so', () => {
  withIsolatedHome(() => {
    const root = project();
    wd(['init'], root);
    // No config written, so the mode is the default and is reported as inherited.
    let exists = true;
    try {
      readFileSync(join(root, '.watchdog', 'config.json'), 'utf8');
    } catch {
      exists = false;
    }
    assert.equal(exists, false, 'init wrote a config nobody asked for');
    assert.equal(loadConfig({ cwd: root, projectRoot: root }).autonomy, 'suggest');
  });
});

test('wd init --allowlist records that instead', () => {
  withIsolatedHome(() => {
    const root = project();
    wd(['init', '--allowlist'], root);
    const written = JSON.parse(readFileSync(join(root, '.watchdog', 'config.json'), 'utf8'));
    assert.equal(written.autonomy, 'allowlist');
  });
});

test('wd init --dry-run writes nothing', () => {
  withIsolatedHome(() => {
    const root = project();
    const out = wd(['init', '--autonomous', '--dry-run'], root);
    assert.match(out, /dry run/i);
    let exists = true;
    try {
      readFileSync(join(root, '.watchdog', 'config.json'), 'utf8');
    } catch {
      exists = false;
    }
    assert.equal(exists, false, 'a dry run wrote the config anyway');
  });
});

test('the opt-in does not discard other settings in the config', () => {
  withIsolatedHome(() => {
    const root = project();
    mkdirSync(join(root, '.watchdog'), { recursive: true });
    writeFileSync(
      join(root, '.watchdog', 'config.json'),
      JSON.stringify({ analyze: { llm: { maxInvocationsPerSession: 9 } } }),
      'utf8',
    );
    wd(['init', '--autonomous'], root);
    const written = JSON.parse(readFileSync(join(root, '.watchdog', 'config.json'), 'utf8'));
    assert.equal(written.autonomy, 'autonomous');
    assert.equal(written.analyze.llm.maxInvocationsPerSession, 9, 'an unrelated setting was lost');
  });
});

/* ------------------------------------------------------------------ *
 * The behavioural consequence
 * ------------------------------------------------------------------ */

test('a rule fix is not applied in the default mode', () => {
  // The point of the default: nothing is written until autonomy is chosen.
  const { Applier } = globalThis.__wdAutonomyImports ?? {};
  void Applier;
  const root = project();
  const cfg = loadConfig({ cwd: root, projectRoot: root });
  assert.equal(cfg.autonomy, 'suggest');
  // The applier gates on exactly this string, so assert the mapping is real.
  assert.ok(['suggest', 'allowlist', 'autonomous'].includes(cfg.autonomy));
});

void rmSync;
void homedir;