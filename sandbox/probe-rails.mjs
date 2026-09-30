/**
 * Probe the guard rails for gaps.
 *
 * The command rails are a DENYLIST: anything not matching a known-bad pattern is
 * allowed. That is structurally weaker than an allowlist and this file is the
 * honest measurement of how much weaker.
 *
 *   node sandbox/probe-rails.mjs
 */
import { isRefused, listRails } from '../src/act/guard.mjs';

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[90m', x: '\x1b[0m' };
const c = (k, s) => `${C[k]}${s}${C.x}`;

const root = 'C:\\proj';
const ctx = { projectRoot: root, cwd: root };

const PROBES = [
  ['destructive git', ['git', 'checkout', '.']],
  ['destructive git', ['git', 'restore', '.']],
  ['destructive git', ['git', 'stash', 'drop']],
  ['destructive git', ['git', 'tag', '-d', 'v1']],
  ['destructive git', ['git', 'update-ref', '-d', 'refs/heads/main']],
  ['destructive git', ['git', 'worktree', 'remove', '--force', 'wt']],
  ['destructive git', ['git', 'submodule', 'deinit', '-f', '.']],
  ['data loss', ['del', 'build', 'output.txt']],
  ['data loss', ['Remove-Item', 'src']],
  ['data loss', ['shred', 'important.txt']],
  ['permission', ['chmod', '777', '-R', '.']],
  ['permission', ['icacls', 'C:\\proj', '/grant', 'Everyone:F']],
  ['supply chain', ['npm', 'uninstall', 'typescript']],
  ['supply chain', ['npm', 'pack']],
  ['supply chain', ['npm', 'add', 'some-new-pkg']],
  ['supply chain', ['npx', 'evil-package']],
  ['supply chain', ['node', 'postinstall.js']],
  ['network', ['curl', '-o', 'x.exe', 'https://example.com/x.exe']],
  ['network', ['Invoke-Expression', '$env:PATH']],
  ['env/registry', ['setx', 'PATH', 'C:\\evil']],
  ['env/registry', ['reg', 'query', 'HKLM\\System']],
  ['process', ['taskkill', '/F', '/IM', 'node.exe']],
  ['process', ['Stop-Process', '-Name', 'explorer']],
  ['vcs write', ['git', 'commit', '--amend', '--no-edit']],
  ['vcs write', ['git', 'reset', '--soft', 'HEAD~5']],
];

console.log(c('b', '\nguard rail probe') + c('d', '  (denylist: anything unlisted is ALLOWED)\n'));

let allowed = 0;
for (const [category, argv] of PROBES) {
  const r = isRefused({ kind: 'command', argv }, ctx);
  const mark = r.ok ? c('y', 'ALLOWED') : c('g', 'refused');
  if (r.ok) allowed++;
  console.log(`  ${mark}  ${category.padEnd(16)} ${argv.join(' ')}`);
  if (!r.ok) console.log(`          ${c('d', r.code + ': ' + r.why)}`);
}

console.log(`\n  ${allowed}/${PROBES.length} probes were ALLOWED.`);
console.log(c('d', '  Not all of these are harmful. That is the point: a denylist cannot'));
console.log(c('d', '  distinguish "benign command nobody thought of" from "harmful command'));
console.log(c('d', '  nobody thought of", so it has to refuse the first too, or be permissive.'));
console.log(c('d', '\n  The rails that exist:'));
for (const r of listRails()) console.log(`    ${c('d', r.code.padEnd(30) + r.examples.slice(0, 3).join(', '))}`);
console.log('');
