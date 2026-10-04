/**
 * Typed command policy.
 *
 * The previous rail was a denylist of regexes over the joined command line. That
 * is not a boundary, for a structural reason rather than a stylistic one: a
 * regex has to enumerate spellings, and the person writing the command chooses
 * the spelling. `terraform apply` is caught; `terraform --chdir=infra apply` is
 * not. `kubectl -n prod delete pods` is caught; `kubectl -n $NS delete pods` is
 * not. Every added pattern is a guess about someone else's spelling, and a
 * denylist's coverage gap is not a bug in the denylist, it is the denylist.
 *
 * So the policy is inverted. A command may run only if its shape is one the
 * watchdog can describe: a known program, a known verb for that program, known
 * flags for that verb, and arguments that match a declared shape. Anything
 * unrecognised is refused because it is unrecognised, not because it matched a
 * bad pattern.
 *
 * One point worth being precise about, because it is easy to get backwards.
 * Commands are spawned with `shell: false`, so `|` and `&&` are already literal
 * characters and a command like `curl x | sh` does not pipe anything. Blocking
 * metacharacters is therefore defence in depth rather than the fix.
 *
 * The hole that *is* real is programs whose own argument parser evaluates a
 * string. `sh -c '...'`, `node -e '...'`, `python -c '...'`,
 * `powershell -Command '...'` all take a whole program as one argument, so
 * everything a denylist would have to reason about arrives inside a single argv
 * entry that looks completely benign. Those flags are refused structurally,
 * which is a smaller and much more reliable rule than trying to read the payload.
 *
 * The regex denylist still runs, last, as a backstop. Two layers is the point;
 * the allowlist is what makes the denylist a backstop rather than the boundary.
 */

/** Flags that hand a whole program to an interpreter as one argument. */
const EVAL_FLAGS = new Set([
  '-c', '-e', '--eval', '--command', '-command', '/c', '-enc', '-encodedcommand',
  '--exec', '-X', 'eval', 'exec', 'source', '.',
]);

/** Flags that forbid a tool from fetching anything. npx enforces these itself. */
const NO_DOWNLOAD_FLAGS = new Set(['--no-install', '--no', '--offline', '--prefer-offline']);

/** Characters that have no business in an argument the watchdog constructed. */
const METACHARS = /[|;&><`$(){}\[\]!*?\n\r\\]/;

/**
 * An absolute path, or one climbing out.
 *
 * `..` only counts as traversal when it is a whole path segment. Requiring a
 * separator or an end after it matters: Go's `./...` means "this package and
 * everything below it", and a looser pattern reads that as a climb and refuses
 * the most ordinary command in the language.
 */
const SUSPICIOUS_PATH =
  /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})|^\.\.(?:[\\/]|$)|[\\/](?:\.\.(?:[\\/]|$)|[^.\\\/]+[\\\/]\.\.(?:[\\/]|$))/;

/**
 * The programs the watchdog may run, and for each, the verbs and flags it may use.
 *
 * Written from what a terminal failure actually needs, not from what is
 * convenient. Note what is absent: `git push`, `git config`, `git gc`,
 * `npm publish`, `terraform`, `kubectl`. Those are absent because the watchdog has
 * no business running them on a developer's behalf -- not because a pattern
 * might miss them.
 */
/**
 * Refusal codes, defined here and re-exported through the guard's REFUSAL table.
 *
 * One source of truth. The first version returned `COMMAND_NOT_ALLOWED` from this
 * module while `REFUSAL` held `command_not_allowed`, so `isRefused` published a
 * code that did not exist in the table callers match against -- and a lookup for
 * the reason came back empty.
 */
export const CMD_REFUSAL = Object.freeze({
  NOT_ALLOWED: 'command_not_allowed',
  VERB_NOT_ALLOWED: 'command_verb_not_allowed',
  FLAG_NOT_ALLOWED: 'command_flag_not_allowed',
  ARG_NOT_ALLOWED: 'command_arg_not_allowed',
  EVAL: 'command_eval_flag',
  METACHAR: 'command_metacharacter',
  SCRIPT_NOT_ALLOWED: 'command_script_not_allowed',
  TOO_MANY_ARGS: 'command_too_many_args',
  NO_VERB: 'command_no_verb',
  MAY_DOWNLOAD: 'command_may_download',
  EMPTY: 'command_empty',
});

export const COMMAND_POLICY = Object.freeze({
  npm: {
    verbs: {
      ci: { flags: ['--no-audit', '--no-fund', '--ignore-scripts'], positionals: 0 },
      install: { flags: ['--no-audit', '--no-fund', '--ignore-scripts', '--save-dev', '--save-exact', '--dry-run'], positionals: 'packages' },
      test: { flags: [], positionals: 'testargs' },
      ls: { flags: ['--depth=0'], positionals: 0 },
      run: { flags: [], positionals: 'npm-script', rest: 'args' },
      exec: { flags: ['--'], positionals: 0 },
    },
  },
  pnpm: {
    verbs: {
      install: { flags: ['--frozen-lockfile', '--ignore-scripts', '--offline'], positionals: 'packages' },
      test: { flags: [], positionals: 'testargs' },
      ls: { flags: [], positionals: 0 },
      run: { flags: [], positionals: 'npm-script', rest: 'args' },
      ci: { flags: ['--frozen-lockfile', '--ignore-scripts'], positionals: 0 },
    },
  },
  yarn: {
    verbs: {
      install: { flags: ['--frozen-lockfile', '--ignore-scripts', '--offline'], positionals: 'packages' },
      test: { flags: [], positionals: 'testargs' },
      run: { flags: [], positionals: 'npm-script', rest: 'args' },
    },
  },
  pip: {
    verbs: {
      install: { flags: ['--no-deps', '--dry-run', '--no-cache-dir', '--require-hashes'], positionals: 'packages' },
      list: { flags: ['--format=freeze'], positionals: 0 },
      show: { flags: [], positionals: 'packages' },
    },
  },
  // pytest has no verb of its own: pytest -q is the whole invocation. Without a default the parser would treat the first flag as the verb.
  pytest: { defaultVerb: 'run', verbs: { run: { flags: ['-q', '-x', '--maxfail=1'], positionals: 'testargs' } } },
  python: { verbs: { '-m': { flags: [], positionals: 'module', rest: 'args' } } },
  node: { verbs: { '--test': { flags: [], positionals: 'testargs' }, '--version': { flags: [], positionals: 0 } } },
  go: {
    verbs: {
      test: { flags: ['-run', '-count', '-short', '-v'], positionals: 'go-packages' },
      build: { flags: [], positionals: 'go-packages' },
      vet: { flags: [], positionals: 'go-packages' },
    },
  },
  cargo: {
    verbs: {
      test: { flags: ['--offline', '--locked', '--lib', '--no-run'], positionals: 'testargs' },
      build: { flags: ['--offline', '--locked'], positionals: 0 },
      check: { flags: ['--offline', '--locked'], positionals: 0 },
    },
  },
  git: {
    verbs: {
      // Read-only, plus what you need to record work in progress. push is here but
      // not `--force`: the flag allowlist carries `--force-with-lease`, so the safe
      // form is permitted and the unsafe one cannot be expressed. That is the
      // difference between a policy and a pattern.
      status: { flags: ['--short', '--porcelain', '--branch'], positionals: 0 },
      diff: { flags: ['--stat', '--name-only', '--cached', '--', 'HEAD'], positionals: 'paths' },
      log: { flags: ['--oneline', '-n', '--stat', '--no-patch'], positionals: 0, consumesText: ['-n'] },
      show: { flags: ['--stat', '--name-only'], positionals: 0 },
      add: { flags: ['--'], positionals: 'paths' },
      stash: { flags: ['list', 'push', 'pop'], positionals: 0 },
      checkout: { flags: ['-b'], positionals: 'paths' },
      commit: { flags: ['-m', '-a', '-am'], positionals: 'args', consumesText: ['-m', '-am'] },
      push: { flags: ['--force-with-lease', '--set-upstream', '--dry-run'], positionals: 'paths' },
      fetch: { flags: ['--dry-run'], positionals: 'paths' },
      branch: { flags: ['--show-current', '--list'], positionals: 'args' },
      'rev-parse': { flags: ['--show-toplevel', '--abbrev-ref', 'HEAD'], positionals: 0 },
    },
  },
  tsc: { verbs: { '--noEmit': { flags: [], positionals: 'paths' } } },
  eslint: { verbs: {} },
  npx: {
    // Bare `npx <name>` is NOT permitted, and the reason is worth being exact
    // about: npx does not only run a locally installed binary, it *fetches* one.
    // `npx tsc` against a project without typescript resolves the `tsc` package
    // from the registry, installs it, and runs its bin script -- so a line of
    // terminal output could choose a package name and get code execution, which
    // is the same supply-chain hole the install policy spends so much effort
    // closing.
    //
    // The previous comment here claimed these were "binaries the project already
    // declares". Nothing checked that, and npx would not have honoured it.
    //
    // `--no-install` (or its `--no` alias) is required, and npx enforces it
    // itself: the binary must already be present locally or the command fails.
    // Relying on npx's own enforcement is better than duplicating a filesystem
    // check here -- this function is deliberately pure, and a hand-rolled
    // "is it declared" test would be a weaker copy of a guarantee npm already
    // provides.
    requiresLocalBinary: true,
    verbs: {
      tsc: { flags: ['--noEmit'], positionals: 'paths' },
      eslint: { flags: [], positionals: 'paths' },
    },
  },
});

/** Positional argument shapes, by name. A shape is a test, not a suggestion. */
const POSITIONAL_SHAPES = {
  packages: /^(?:@[a-z0-9-._]+\/)?[a-z0-9-._-]+(?:@[a-zA-Z0-9._^~<>=+-]+)?$/,
  // `./...` is how Go and Cargo say "this package and everything below it". It
  // looks like a path with a traversal in it and is not one, so the shape has to
  // allow it explicitly or the most ordinary build command in those ecosystems is
  // refused.
  'go-packages': /^(?:\.{1,2}\/)*\.{0,3}\/?(?:\.\.\/)*[a-z0-9-._*\/]+$/,
  paths: /^[A-Za-z0-9._][A-Za-z0-9._\\/-]*$/,
  testargs: /^[A-Za-z0-9._:@=\/-]+$/,
  args: /^[A-Za-z0-9._:@=\/-]+$/,
  module: /^[A-Za-z0-9_.]+$/,
  'npm-script': /^[a-z0-9:_-]+$/,
};

/** npm/yarn/pnpm scripts the watchdog may run. Deliberately short. */
export const ALLOWED_NPM_SCRIPTS = new Set(['test', 'build', 'lint', 'typecheck', 'check', 'verify', 'ci']);

/**
 * Decide whether a command may run.
 *
 * @param {string[]} argv
 * @returns {{ok: true, program: string, verb: string}
 *          |{ok: false, code: string, why: string}}
 */
export function checkCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, code: CMD_REFUSAL.EMPTY, why: 'no command given' };
  }

  const [program, ...rest] = argv;

  // The executable must be a bare name. A path is refused because "run this
  // absolute path" is exactly the shape that turns a vetted program name into
  // "run whatever this file does".
  if (program !== basenameSafe(program) || program.includes('\\') || program.includes('/') || program.includes(':')) {
    return {
      ok: false,
      code: CMD_REFUSAL.NOT_ALLOWED,
      why: `refuses to run "${program}" because it is given as a path rather than a known program name`,
    };
  }

  const policy = COMMAND_POLICY[program.toLowerCase()];
  if (!policy) {
    return {
      ok: false,
      code: CMD_REFUSAL.NOT_ALLOWED,
      why: `refuses to run "${program}": not a program the watchdog is permitted to invoke`,
    };
  }

  // There is deliberately no "leading VAR=value is environment injection" rule
  // here. It cannot fire in a way that means anything: commands are spawned with
  // an argv array and no shell, so argv[0] is the executable and a `VAR=value`
  // there is simply an unknown program name, refused by the rule below. Adding a
  // rule whose stated purpose it cannot serve would be a rail that reads like
  // protection and provides none.

  // Global refusal of eval-style flags, before any verb is chosen. This is the
  // structural rule that replaces reading payloads out of a command line.
  for (const a of rest) {
    if (EVAL_FLAGS.has(a)) {
      return {
        ok: false,
        code: CMD_REFUSAL.EVAL,
        why: `refuses "${program} ${a}": flags that hand a whole program to an interpreter let any command line through the denylist in one benign-looking argument`,
      };
    }
  }

  // A verb that itself looks like a flag (`python -m`, `node --test`) has to be
  // recognised as the verb, or the scan for "first argument not starting with a
  // dash" steps straight over it and picks the wrong token: `python -m pip
  // install x` would look for a verb called `pip`.
  const flagLikeVerb = rest.length > 0 && Object.hasOwn(policy.verbs, rest[0]);
  const verbIndex = flagLikeVerb ? 0 : rest.findIndex((a) => !a.startsWith('-'));
  const found = verbIndex < 0 ? rest[0] : rest[verbIndex];

  // npx will download a package to satisfy a bare binary name, so it may only be
  // used in a form that cannot. Checked here, before any verb is chosen, because
  // the verb is the thing that gets fetched.
  if (policy.requiresLocalBinary && !rest.some((a) => NO_DOWNLOAD_FLAGS.has(a))) {
    return {
      ok: false,
      code: CMD_REFUSAL.MAY_DOWNLOAD,
      why:
        `refuses "npx ${rest.find((a) => !a.startsWith('-')) ?? '?'}": npx downloads the package when the binary is not installed ` +
        'locally, so a bare invocation lets terminal output choose what gets fetched and executed. ' +
        'Use --no-install, or run the binary directly.',
    };
  }
  // A program whose invocation is verb-less: `pytest -q` is the whole command, so
  // without this the first flag is taken as the verb and refused as unknown. Only
  // applied when the token found was flag-shaped or absent -- `npm deploy` must
  // still be refused as an unknown verb rather than quietly becoming `npm test`.
  const verb =
    !Object.hasOwn(policy.verbs, found) && (verbIndex === -1 || found.startsWith('-'))
      ? (policy.defaultVerb ?? found)
      : found;

  if (found === undefined) {
    return { ok: false, code: CMD_REFUSAL.NO_VERB, why: `refuses to run "${program}" with no verb` };
  }

  const verbPolicy = policy.verbs[verb];
  if (!verbPolicy) {
    return {
      ok: false,
      code: CMD_REFUSAL.VERB_NOT_ALLOWED,
      why: `refuses "${program} ${verb}": not a verb the watchdog may run for ${program}`,
    };
  }

  const before = rest.slice(0, verbIndex < 0 ? 0 : verbIndex);
  const after = rest.slice(verbIndex + 1);

  // Flags placed before the verb must be declared too, or `npm --registry=http://evil
  // install` walks straight past the verb check.
  for (const f of before) {
    const name = f.includes('=') ? f.slice(0, f.indexOf('=')) : f;
    // The no-download flags sit before the verb by convention, as in
    // npx --no-install tsc, so they must be permitted there even though no verb
    // declares them: they are what makes the invocation safe, not an extra
    // argument to the verb.
    if (policy.requiresLocalBinary && NO_DOWNLOAD_FLAGS.has(name)) continue;
    if (!verbPolicy.flags.includes(name)) {
      return {
        ok: false,
        code: CMD_REFUSAL.FLAG_NOT_ALLOWED,
        why: `refuses "${program} ${f} ${verb}": that flag is not permitted for ${program} ${verb}`,
      };
    }
  }

  const rest2 = [];
  const consumedText = [];
  const consumesText = verbPolicy.consumesText ?? [];
  let expectingText = false;

  for (const a of after) {
    // `git commit -m "fix; the thing"` -- the message is data, not code, so the
    // shape and metacharacter rules do not apply to it. It reaches git as one argv
    // element with no shell, so a semicolon in it is just a semicolon. Refusing it
    // would make the rule refuse ordinary work while claiming to prevent injection.
    //
    // Tracked as a parallel list rather than re-derived from indices: the exemption
    // belongs to a specific argument, and working it out from positions is how the
    // first version ended up exempting the wrong element.
    if (expectingText) {
      expectingText = false;
      rest2.push(a);
      consumedText.push(true);
      continue;
    }

    if (a.startsWith('-')) {
      // Both the whole token and the name before `=` must be declared: policies
      // write `--depth=0`, users write `--depth 0` and `--depth=0`.
      const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      if (!verbPolicy.flags.includes(a) && !verbPolicy.flags.includes(name)) {
        return {
          ok: false,
          code: CMD_REFUSAL.FLAG_NOT_ALLOWED,
          why: `refuses "${program} ${verb} ${a}": that flag is not permitted for ${program} ${verb}`,
        };
      }
      // `--flag=value` carries its own text; a bare one takes the next argument.
      if (consumesText.includes(a) || (consumesText.includes(name) && !a.includes('='))) {
        expectingText = true;
      }
      continue;
    }
    rest2.push(a);
    consumedText.push(false);
  }

  // npm-script gates the one verb whose argument names further behaviour.
  if (verbPolicy.positionals === 'npm-script' && rest2.length) {
    if (!ALLOWED_NPM_SCRIPTS.has(rest2[0])) {
      return {
        ok: false,
        code: CMD_REFUSAL.SCRIPT_NOT_ALLOWED,
        why: `refuses "${program} run ${rest2[0]}": only ${[...ALLOWED_NPM_SCRIPTS].join(', ')} may be run`,
      };
    }
    for (const a of rest2.slice(1)) {
      const r = checkArgument(a);
      if (!r.ok) return r;
    }
    return { ok: true, program, verb };
  }

  // Argument-level rules run before the count, so the most specific reason wins.
  // `npm ci && rm` is refused either way, but 'that argument contains a shell
  // metacharacter' tells the reader what happened where 'takes no arguments here'
  // does not.
  for (let i = 0; i < rest2.length; i++) {
    if (consumedText[i]) continue;
    const r = checkArgument(rest2[i]);
    if (!r.ok) return r;
  }

  const counted = consumedText.reduce((n, exempt) => n + (exempt ? 0 : 1), 0);
  if (typeof verbPolicy.positionals === 'number' && counted > verbPolicy.positionals) {
    return {
      ok: false,
      code: CMD_REFUSAL.TOO_MANY_ARGS,
      why: `refuses "${program} ${verb}": takes no arguments here`,
    };
  }

  const shape = POSITIONAL_SHAPES[verbPolicy.positionals];
  if (shape) {
    for (let i = 0; i < rest2.length; i++) {
      const a = rest2[i];
      if (consumedText[i]) continue; // a message, not a package name
      const r = checkArgument(a);
      if (!r.ok) return r;
      if (!shape.test(a)) {
        return {
          ok: false,
          code: CMD_REFUSAL.ARG_NOT_ALLOWED,
          why: `refuses "${program} ${verb} ${a}": that argument is not a permitted form for this command`,
        };
      }
    }
  }

  return { ok: true, program, verb };
}

/** Argument-level rules that apply whatever the verb is. */
export function checkArgument(a) {
  if (METACHARS.test(a)) {
    return {
      ok: false,
      code: CMD_REFUSAL.METACHAR,
      why: `refuses argument "${a}": shell metacharacters have no legitimate place in a command the watchdog builds`,
    };
  }
  if (SUSPICIOUS_PATH.test(a)) {
    return {
      ok: false,
      code: CMD_REFUSAL.ARG_NOT_ALLOWED,
      why: `refuses argument "${a}": absolute or climbing paths are not permitted; arguments stay inside the project`,
    };
  }
  return { ok: true };
}

function basenameSafe(p) {
  return p.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}