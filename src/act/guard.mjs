/**
 * Hard safety rails. These are NOT a "deny by default" list that autonomy can
 * switch off -- they are structural refusals that no config flag, no LLM proposal,
 * and no autonomy setting can bypass. `isRefused` is the single choke point every
 * proposed change passes through before it is written or executed.
 */
import { resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { realpathNearest, realProjectRoot } from './containment.mjs';
import { checkCommand, CMD_REFUSAL } from './commands.mjs';

export const REFUSAL = Object.freeze({
  // Raised by the autonomy policy rather than by the pattern guard. Kept in this
  // table because it shares the vocabulary the journal and `describeRefusal` speak,
  // not because anything pattern-matched to produce it.
  IRREVERSIBLE: 'irreversible_without_opt_in',
  // Re-exported from the policy module rather than restated, so the code the
  // guard publishes is by construction the code `describeRefusal` can look up.
  COMMAND_NOT_ALLOWED: CMD_REFUSAL.NOT_ALLOWED,
  COMMAND_VERB_NOT_ALLOWED: CMD_REFUSAL.VERB_NOT_ALLOWED,
  COMMAND_FLAG_NOT_ALLOWED: CMD_REFUSAL.FLAG_NOT_ALLOWED,
  COMMAND_ARG_NOT_ALLOWED: CMD_REFUSAL.ARG_NOT_ALLOWED,
  COMMAND_EVAL: CMD_REFUSAL.EVAL,
  COMMAND_METACHAR: CMD_REFUSAL.METACHAR,
  COMMAND_SCRIPT_NOT_ALLOWED: CMD_REFUSAL.SCRIPT_NOT_ALLOWED,
  COMMAND_TOO_MANY_ARGS: CMD_REFUSAL.TOO_MANY_ARGS,
  COMMAND_NO_VERB: CMD_REFUSAL.NO_VERB,
  COMMAND_EMPTY: CMD_REFUSAL.EMPTY,
  COMMAND_MAY_DOWNLOAD: CMD_REFUSAL.MAY_DOWNLOAD,
  PATH_OUTSIDE_ROOT: 'path_outside_project_root',
  FORCE_PUSH: 'force_push',
  HISTORY_REWRITE: 'history_rewrite',
  DESTRUCTIVE_DELETE: 'destructive_delete',
  SECRET_FILE: 'secret_file',
  SYSTEM_PATH: 'system_path',
  SENSITIVE_FILE_CLASS: 'sensitive_file_class',
  REMOTE_EXEC: 'remote_code_execution',
  PRODUCTION: 'production_environment',
  PUBLISH: 'package_publish',
  PRIVILEGE_ESCALATION: 'privilege_escalation',
  CREDENTIAL_DESTRUCTION: 'credential_destruction',
  PIPELINE_TO_SHELL: 'pipe_to_shell',
});

/** Paths that are never written, regardless of anything else. */
const SECRET_PATTERNS = [
  /(^|[\\/])\.env(\.[\w-]+)?$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /(^|[\\/])credentials$/i,
  /(^|[\\/])\.aws[\\/]/i,
  /(^|[\\/])\.ssh[\\/]/i,
  /(^|[\\/])\.gnupg[\\/]/i,
  /(^|[\\/])\.kube[\\/]/i,
  /(^|[\\/])\.docker[\\/]config\.json$/i,
  /(^|[\\/])secrets?\.(ya?ml|json|toml|env)$/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])secrets?\//i,
];

/**
 * Files an LLM may never edit on its own.
 *
 * The existing rails answer "is this path obviously forbidden?". They do not
 * answer "is this change safe to make without asking", and for a file whose
 * contents *are* the authority, that is the question that matters. A single
 * model-authored line in a CI workflow, a git hook or a package manifest runs on
 * every machine that touches the repo -- usually with credentials, usually not
 * here.
 *
 * This is deliberately asymmetric. These paths are refused for model-proposed
 * edits and permitted for rule-proposed ones. The distinction is provenance:
 * a rule ships with this program and its fix was reviewed when it was written,
 * whereas a model's fix is a guess about code it could not read. Nothing here
 * inspects the replacement text, which is the honest reason a path list is the
 * gate: the model can put anything in `replace`.
 *
 * Suggesting one of these is still useful, so refusal downgrades the finding to
 * "needs a human" rather than dropping it.
 */
const SENSITIVE_CLASSES = [
  { re: /(^|[\\/])\.git[\\/]/i, why: 'git internals and hooks' },
  { re: /(^|[\\/])\.github[\\/]workflows[\\/]/i, why: 'CI workflows run with repository credentials' },
  { re: /(^|[\\/])\.github[\\/]actions[\\/]/i, why: 'composite CI actions run on every job' },
  { re: /(^|[\\/])\.gitlab-ci\.ya?ml$/i, why: 'CI configuration' },
  { re: /(^|[\\/])Jenkinsfile$/i, why: 'CI configuration' },
  { re: /(^|[\\/])(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i, why: 'package manifests decide what code runs' },
  { re: /(^|[\\/])(pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?)$/i, why: 'package manifests decide what code runs' },
  { re: /(^|[\\/])requirements.*\.txt$/i, why: 'package manifests decide what code runs' },
  { re: /(^|[\\/])(Cargo\.toml|Cargo\.lock|go\.mod|go\.sum)$/i, why: 'package manifests decide what code runs' },
  { re: /\.(sh|bash|zsh|ps1|psm1|bat|cmd)$/i, why: 'shell scripts execute on other machines' },
  { re: /(^|[\\/])(Dockerfile|docker-compose.*\.ya?ml|Containerfile)$/i, why: 'container build definitions' },
  { re: /\.(tf|tfvars)$/i, why: 'infrastructure definitions that provision real resources' },
  { re: /(^|[\\/])k8s[\\/]/i, why: 'cluster manifests' },
  { re: /(^|[\\/])Makefile$/i, why: 'build entry points' },
  { re: /(^|[\\/])(tsconfig[^\\/]*\.json|\.(babelrc|eslintrc|prettierrc)[^\\/]*)$/i, why: 'build and tooling configuration' },
  { re: /\.(exe|dll|so|dylib|node)$/i, why: 'executables and binaries' },
];

/** @returns {{why: string}|null} */
export function sensitiveClass(relPath) {
  const norm = String(relPath).replace(/\\/g, '/');
  for (const { re, why } of SENSITIVE_CLASSES) {
    if (re.test(norm)) return { why };
  }
  return null;
}

const SYSTEM_PREFIXES = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/boot',
  '/sys',
  '/proc',
  '/var/lib',
  '/System',
  '/Library',
  '/private/etc',
];

/** argv fragments that are destructive no matter what else the command does. */
const FORBIDDEN_ARGV = [
  { re: /^\s*git\b.*\bpush\b.*(--force(?!-with-lease)\b|-f\b)/, code: REFUSAL.FORCE_PUSH, why: 'force push can destroy shared history' },
  { re: /^\s*git\b.*\breset\b.*--hard/, code: REFUSAL.HISTORY_REWRITE, why: 'reset --hard discards uncommitted work' },
  { re: /^\s*git\b.*\bclean\b.*-[a-z]*[fdx]/, code: REFUSAL.DESTRUCTIVE_DELETE, why: 'git clean removes untracked files' },
  { re: /^\s*git\b.*\bfilter-branch\b/, code: REFUSAL.HISTORY_REWRITE, why: 'filter-branch rewrites all history' },
  { re: /^\s*git\b.*\brebase\b.*\s-(i|--interactive)\b/, code: REFUSAL.HISTORY_REWRITE, why: 'interactive rebase rewrites history' },
  { re: /^\s*git\b.*\bbranch\b.*\s-D\b/, code: REFUSAL.DESTRUCTIVE_DELETE, why: 'force branch delete loses commits' },
  { re: /^\s*git\b.*\bpush\b.*\s--delete\b/, code: REFUSAL.DESTRUCTIVE_DELETE, why: 'deletes a remote branch' },
  { re: /^\s*git\b.*\bconfig\b.*(user\.(email|name)|core\.hooksPath)/, code: REFUSAL.PRIVILEGE_ESCALATION, why: 'rewrites git identity or hook path' },
  { re: /^\s*git\b.*\b(gc|repack|prune)\b/, code: REFUSAL.CREDENTIAL_DESTRUCTION, why: 'repairs/gc can drop unreachable objects' },
  { re: /^\s*(sudo|doas|runas)\b/, code: REFUSAL.PRIVILEGE_ESCALATION, why: 'privilege escalation' },
  { re: /(^|\s)(rm|rd)\b[^|;&]*\s-[a-z]*[rR][a-z]*\s|\/s\b/i, code: REFUSAL.DESTRUCTIVE_DELETE, why: 'recursive delete' },
  { re: /\b(Remove-Item|rm)\b.*\s-Recurse\b/i, code: REFUSAL.DESTRUCTIVE_DELETE, why: 'recursive delete' },
  { re: /\b(del|erase)\b.*\/s\b/i, code: REFUSAL.DESTRUCTIVE_DELETE, why: 'recursive delete' },
  { re: /\b(shred|srm|wipe)\b/, code: REFUSAL.DESTRUCTIVE_DELETE, why: 'secure erase' },
  { re: /\b(mkfs|fdisk|diskpart|format)\b/i, code: REFUSAL.DESTRUCTIVE_DELETE, why: 'filesystem modification' },
  { re: /\bdd\b.*\bof=\/dev\//, code: REFUSAL.DESTRUCTIVE_DELETE, why: 'raw device write' },
  { re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|)?sh\b/i, code: REFUSAL.PIPELINE_TO_SHELL, why: 'pipes a download straight into a shell' },
  { re: /\beval\s*\(?\s*(atob|base64|Buffer\.from)/i, code: REFUSAL.REMOTE_EXEC, why: 'executes decoded remote code' },
  { re: /\b(npm|yarn|pnpm)\s+publish\b/, code: REFUSAL.PUBLISH, why: 'publishes a package' },
  { re: /\b(npm|yarn|pnpm)\s+unpublish\b/, code: REFUSAL.PUBLISH, why: 'unpublishes a package' },
  { re: /\b(terraform|kubectl|helm)\b.*\b(apply|destroy|delete|rollback)\b/, code: REFUSAL.PRODUCTION, why: 'infrastructure mutation' },
  { re: /\b(kubectl|helm)\b.*\s-n\s*(prod|production)\b/, code: REFUSAL.PRODUCTION, why: 'targets production' },
  { re: /\b(aws|gcloud|az)\s+\w*\s*(delete|terminate|destroy|rm)\b/i, code: REFUSAL.PRODUCTION, why: 'cloud resource deletion' },
  { re: /\bsystemctl\s+(stop|disable|mask)\b/i, code: REFUSAL.PRODUCTION, why: 'disables a system service' },
  { re: /\b(drop\s+(database|table)|truncate\s+table)\b/i, code: REFUSAL.PRODUCTION, why: 'destructive SQL' },
  { re: /\b(update-alternatives|Set-ExecutionPolicy|reg\s+add)\b/i, code: REFUSAL.PRIVILEGE_ESCALATION, why: 'system/policy change' },
  { re: /:\(\)\{.*\};:|fn\s+main\(\)\s*\{\s*let\s+\w+\s*=\s*\$\(/, code: REFUSAL.REMOTE_EXEC, why: 'fork bomb' },
];

function isSecretPath(p) {
  const norm = p.replace(/\\/g, '/');
  return SECRET_PATTERNS.some((re) => re.test(norm));
}

function isSystemPath(p) {
  const abs = resolve(p);
  return SYSTEM_PREFIXES.some((pf) => abs.toLowerCase().startsWith(pf.toLowerCase()));
}

/**
 * @param {{kind: string, path?: string, argv?: string[]}} action
 * @param {{projectRoot?: string, cwd?: string}} ctx
 * @returns {{ok: true} | {ok: false, code: string, why: string}}
 */
function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

export function isRefused(action, ctx = {}) {
  const root = resolve(ctx.projectRoot ?? process.cwd());

  if (action.path) {
    const p = isAbsolute(action.path) ? action.path : resolve(ctx.cwd ?? root, action.path);
    if (isSecretPath(p)) return refuse(REFUSAL.SECRET_FILE, 'refuses to read or write credential files');
    if (isSystemPath(p)) return refuse(REFUSAL.SYSTEM_PATH, 'refuses to modify operating-system paths');

    // Lexical containment is not a boundary. A junction inside the project can
    // satisfy every relative() test and still resolve outside it, so the real
    // location is checked too. Both comparisons are required: the lexical one
    // first because it is cheap and catches the obvious cases.
    const rel = relative(root, p);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return refuse(REFUSAL.PATH_OUTSIDE_ROOT, `refuses to touch ${p} which is outside the project root`);
    }
    const real = realpathNearest(p);
    if (!isInside(realProjectRoot(root), real)) {
      return refuse(
        REFUSAL.PATH_OUTSIDE_ROOT,
        `refuses to touch ${p} because it resolves to ${real}, outside the project root. ` +
          'A link inside the project points somewhere else.',
      );
    }

    // Provenance matters more than the path. A rule's fix was reviewed when the
    // rule was written; a model's fix is a guess about code it could not read.
    //
    // Untrusted unless declared otherwise: a default of 'allowed' would mean that
    // forgetting the source argument silently disabled the whole policy, and that
    // is precisely how it would have shipped broken. 'rule' is the only value that
    // grants the exemption, because it is the only one a caller asserts rather
    // than omits.
    if (ctx.source !== 'rule') {
      const cls = sensitiveClass(rel);
      if (cls) {
        return refuse(
          REFUSAL.SENSITIVE_FILE_CLASS,
          `${cls.why} may not be edited by the model without a human. ` +
            `Proposed edit to ${rel} is reported as a suggestion instead.`,
        );
      }
    }
  }

  if (action.argv?.length) {
    // Denylist first, allowlist second.
    //
    // Order does not affect safety -- both run either way, and anything the
    // allowlist rejects never reaches execution. It affects the *reason* given. A
    // known-dangerous shape should still be reported as itself ("force push can
    // destroy shared history") rather than as the generic "git push is not a verb
    // you may run", which is true but tells the reader nothing they did not know.
    //
    // The allowlist is what makes the denylist a backstop rather than the
    // boundary: it refuses anything whose shape was never declared, which is the
    // coverage gap a list of patterns can never close.
    const cmdline = action.argv.join(' ');
    for (const rule of FORBIDDEN_ARGV) {
      if (rule.re.test(cmdline)) return refuse(rule.code, rule.why);
    }

    const typed = checkCommand(action.argv);
    if (!typed.ok) return refuse(typed.code, typed.why);
  }
  return { ok: true };
}

function refuse(code, why) {
  return { ok: false, code, why };
}

export function listRails() {
  return [
    { code: REFUSAL.COMMAND_NOT_ALLOWED, examples: ['C:\\\\Windows\\\\System32\\\\cmd.exe /c dir', 'definitely-not-a-real-tool'] },
    { code: REFUSAL.COMMAND_VERB_NOT_ALLOWED, examples: ['npm uninstall express', 'git remote add upstream x', 'npm publish'] },
    { code: REFUSAL.COMMAND_FLAG_NOT_ALLOWED, examples: ['npm install --registry=http://evil', 'git log --output=/tmp/x'] },
    { code: REFUSAL.COMMAND_ARG_NOT_ALLOWED, examples: ['npm install ../../elsewhere/pkg', 'npm install /abs/pkg'] },
    { code: REFUSAL.COMMAND_EVAL, examples: ['node -e "..."', 'powershell -Command "..."'] },
    { code: REFUSAL.COMMAND_METACHAR, examples: ['npm test && rm -rf /', 'npm test; whoami'] },
    { code: REFUSAL.COMMAND_SCRIPT_NOT_ALLOWED, examples: ['npm run deploy', 'npm run postinstall'] },
    { code: REFUSAL.COMMAND_MAY_DOWNLOAD, examples: ['npx tsc', 'npx some-package'] },
    { code: REFUSAL.COMMAND_TOO_MANY_ARGS, examples: ['git status somefile.js'] },
    { code: REFUSAL.COMMAND_NO_VERB, examples: ['npm'] },
    { code: REFUSAL.COMMAND_EMPTY, examples: ['(no command)'] },
    { code: REFUSAL.PATH_OUTSIDE_ROOT, examples: ['../outside-project'] },
    { code: REFUSAL.SYSTEM_PATH, examples: SYSTEM_PREFIXES.slice(0, 4) },
    { code: REFUSAL.SECRET_FILE, examples: ['.env', 'id_rsa', '*.pem', '.npmrc', '.aws/'] },
    { code: REFUSAL.FORCE_PUSH, examples: ['git push --force'] },
    { code: REFUSAL.HISTORY_REWRITE, examples: ['git reset --hard', 'git rebase -i', 'git filter-branch'] },
    { code: REFUSAL.DESTRUCTIVE_DELETE, examples: ['rm -rf', 'Remove-Item -Recurse', 'git clean -fdx', 'git branch -D'] },
    { code: REFUSAL.PRIVILEGE_ESCALATION, examples: ['sudo', 'Set-ExecutionPolicy', 'reg add'] },
    { code: REFUSAL.PIPELINE_TO_SHELL, examples: ['curl ... | sh'] },
    { code: REFUSAL.REMOTE_EXEC, examples: ['eval(atob(...))', 'fork bomb'] },
    { code: REFUSAL.PRODUCTION, examples: ['terraform apply', 'kubectl -n prod', 'aws ... delete'] },
    { code: REFUSAL.PUBLISH, examples: ['npm publish'] },
    { code: REFUSAL.CREDENTIAL_DESTRUCTION, examples: ['git gc', 'git repack'] },
  ];
}

export function describeRefusal(code) {
  return listRails().find((r) => r.code === code) ?? { code, examples: [] };
}
