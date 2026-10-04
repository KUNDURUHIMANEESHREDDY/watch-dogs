/**
 * The rails, as `wd doctor` and `listRails` report them.
 *
 * `listRails()` is what the user is shown when they ask what the watchdog will not
 * do. It had an example that was simply wrong: `git push` was listed under
 * `command_verb_not_allowed`, and `git push` is allowed. The verb check refused
 * `npm uninstall express` in the same breath.
 *
 * That is the same failure that produced this audit's item 2. A stale bullet in the
 * README led an external reviewer to report a blocker that had been closed. Here the
 * stale text was in code, shown to users at runtime, describing a control that does
 * not behave as stated. A refusal list that overstates is worse than no list,
 * because it is offered as evidence.
 *
 * So every example is executed below and must actually be refused. A rail cannot
 * claim a command is refused unless it refuses it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { listRails, isRefused, REFUSAL } from '../src/act/guard.mjs';

/** Rail codes that describe a path rather than a command line. */
const PATH_RAILS = new Set([REFUSAL.PATH_OUTSIDE_ROOT, REFUSAL.SYSTEM_PATH, REFUSAL.SECRET_FILE]);

/** Examples that are prose, or that name a substring rather than a whole command. */
const notAWholeCommand = (s) => s.startsWith('(') || s.includes('...') || s.endsWith('/') || s.includes('*');

/**
 * Examples that cannot be split into one argv by whitespace alone.
 *
 * `npm test; whoami` is one. Split on spaces it becomes ['npm','test;','whoami'], so
 * the verb is `test;` -- undeclared -- and the refusal comes back as
 * command_verb_not_allowed. That is correct for the argv it was handed and says
 * nothing about the metacharacter rail. Judging the rail on it would be testing the
 * splitter rather than the control.
 */
const notSplittableIntoOneArgv = (s) => /[;&|><`]/.test(s);

/** Turn a displayed example back into an argv, the way a rule would supply one. */
const argvOf = (example) => example.split(' ').filter(Boolean);

test('every rail example is actually refused', () => {
  const notRefused = [];
  const unexplained = [];
  const documented = new Set(listRails().map((r) => r.code));

  for (const rail of listRails()) {
    if (PATH_RAILS.has(rail.code)) continue;

    for (const example of rail.examples) {
      if (notAWholeCommand(example) || notSplittableIntoOneArgv(example)) continue;

      const verdict = isRefused({ kind: 'command', argv: argvOf(example) });

      // The claim under test. A rail that says "this is refused" and does not refuse
      // it is the entire failure mode this file exists for.
      if (verdict.ok) {
        notRefused.push(`${rail.code}: "${example}" was ALLOWED`);
        continue;
      }

      // Both layers run, denylist first, so a command can be refused under a more
      // specific code than the one it is filed under. That is the design working, and
      // it is better for the user: "credential_destruction" says more than "not a verb
      // you may run". What must still hold is that the code the user is actually given
      // is one they can look up, so the explanation is never a dead end.
      if (!documented.has(verdict.code)) {
        unexplained.push(`${rail.code}: "${example}" was refused as ${verdict.code}, which is not a documented rail`);
      }
    }
  }

  assert.deepEqual(notRefused, [], `documented refusals that do not happen:\n  ${notRefused.join('\n  ')}`);
  assert.deepEqual(unexplained, [], `refusals with no documented explanation:\n  ${unexplained.join('\n  ')}`);
});

test('an allowed command is not claimed by any rail', () => {
  // The other direction. If every plausible command were refused, the test above
  // would pass while the tool refused all work, so a genuinely permitted command is
  // asserted here to keep the two honest against each other.
  assert.equal(isRefused({ kind: 'command', argv: ['git', 'status'] }).ok, true, 'git status is allowed');
});

test('git push is allowed, which is why it must not be listed as a refusal', () => {
  // Pinned explicitly because this exact mistake shipped. A plain `git push` to a
  // remote is ordinary work; what is refused are the flag-gated and
  // history-destroying forms, and those are listed under their own codes.
  assert.equal(isRefused({ kind: 'command', argv: ['git', 'push'] }).ok, true, 'a plain git push was refused');

  const rails = listRails().find((r) => r.code === REFUSAL.COMMAND_VERB_NOT_ALLOWED);
  assert.ok(rails, 'the verb rail is missing entirely');
  for (const example of rails.examples) {
    assert.doesNotMatch(example, /^git push$/, 'git push is documented as refused but is not');
  }
});