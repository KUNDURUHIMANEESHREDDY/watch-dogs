/**
 * Hard safety rails. These are NOT a "deny by default" list that autonomy can
 * switch off -- they are structural refusals that no config flag, no LLM proposal,
 * and no autonomy setting can bypass. `isRefused` is the single choke point every
 * proposed change passes through before it is written or executed.
 */
import { resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { realpathNearest, realProjectRoot } from './containment.mjs';

export const REFUSAL = Object.freeze({
  PATH_OUTSIDE_ROOT: 'path_outside_project_root',
  FORCE_PUSH: 'force_push',
  HISTORY_REWRITE: 'history_rewrite',
  DESTRUCTIVE_DELETE: 'destructive_delete',
  SECRET_FILE: 'secret_file',
  SYSTEM_PATH: 'system_path',
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
  }

  if (action.argv?.length) {
    const cmdline = action.argv.join(' ');
    for (const rule of FORBIDDEN_ARGV) {
      if (rule.re.test(cmdline)) return refuse(rule.code, rule.why);
    }
  }
  return { ok: true };
}

function refuse(code, why) {
  return { ok: false, code, why };
}

export function listRails() {
  return [
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
