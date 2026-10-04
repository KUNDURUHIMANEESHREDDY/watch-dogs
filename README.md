# watchdog

A best-effort cross-terminal watchdog. It watches the shell sessions it can actually
instrument -- Windows Terminal, PowerShell, Git Bash, VS Code and Cursor integrated
terminals -- spots real problems, and either suggests a fix or applies one under hard
safety rails.

Its coverage is uneven, and deliberately so: it is strongest where it reads a shell's
own console transcript, and honestly blind where it says so. There is no global terminal
firehose on Windows, and it does not pretend to have one. `wd doctor` reports which
capture layers are on, which shells are wired, and whether the daemon is alive right now;
[Known limits](#known-limits) lists what is missing and why.

One thing that report cannot tell you: a terminal opened *before* installation is not
covered until you open a new one, because the hook runs at shell startup. `wd doctor`
shows that the hook is installed, not that any particular window has loaded it.

Zero runtime dependencies. Node 20.11+.

---

## The problem this solves

"Watch my terminals" is not a single stream. Each shell, each IDE tab, each SSH
session is a separate process with its own buffer, and some of it lives in the
kernel. There is no global terminal firehose on Windows. So the watchdog builds
its coverage in layers, and is explicit about what each layer can and cannot see.

| Layer | What it sees | Cost | Status here |
|---|---|---|---|
| **1. Shell transcripts** | Everything written to the console of any instrumented shell, including full-screen apps | none -- uses the shell's own transcript | **active** |
| **2. Process watcher** | Process identity and lifecycle events for detached work (IDE tasks, schedulers). **Not exit codes** -- see below | one CIM query every 5s | **active** |
| **3. ConPTY proxy** | Raw bytes in both directions | needs a native ConPTY binding | **off -- reports `unavailable`** |

Layer 1 is the one that matters and it has no hooks, no injection, and no admin.
Layer 3 is deliberately not faked: a real ConPTY proxy needs a compiled binding,
and half-proxying traffic we cannot reconstruct would be worse than admitting the
gap. `wd doctor` says so plainly instead of claiming coverage it does not have.

## Install

```powershell
wd init          # wire PowerShell + Git Bash profiles
wd doctor        # confirm what is actually covered
wd start         # run the daemon
```

`wd init` writes a marker-delimited managed block into your PowerShell profile and
`~/.bashrc`. It never overwrites existing content, and `wd uninstall` removes exactly
what it added.

> On this machine the effective PowerShell profile lives under **OneDrive**
> (`~/OneDrive/Documents/WindowsPowerShell/profile.ps1`), not `~/Documents`.
> The installer queries `$PROFILE` rather than guessing, because a profile written to
> the wrong path is a profile nothing reads.

**IDE terminals are covered for free.** VS Code and Cursor integrated terminals load
the same PowerShell profile, so the managed block applies without editing any
`settings.json`. The watchdog does not touch your editor config.

## What it catches

21 deterministic rules, no model required. Every finding explains itself and shows
the line that triggered it.

Missing modules (Node/Python) | TypeScript errors | ESLint | Cargo | Go | .NET |
unhandled rejections | segfaults | OOM | port in use | connection refused |
permission denied | auth required | disk full | git locks | test failures |
deprecated APIs | unresolved markers | process exits

Verified end to end on a real shell, correctly ignoring `npm WARN`, `git push`
success, and passing build output.

### What the model may not edit on its own

The rails answer "is this path obviously forbidden?". They never asked "is this
change safe to make without asking", and **nothing inspected the replacement
text** -- so a model asked to fix a build error could rewrite a CI workflow, a
git hook or a package manifest. Those paths are inside the project, are not
secret files, and sailed straight through.

They are now refused for model-proposed edits and permitted for rule-proposed
ones. The distinction is provenance: a rule ships with this program and its fix
was reviewed when it was written, whereas a model's fix is a guess about code it
could not read. Nothing here inspects what the model wants to write, which is
the honest reason a path list is the gate at all.

| Never model-edited | Why |
|---|---|
| `.github/workflows/`, `.github/actions/`, `.gitlab-ci.yml`, `Jenkinsfile` | run with repository credentials, usually on machines you are not watching |
| `.git/**` | hooks execute on every clone and commit |
| `package.json`, lockfiles, `pyproject.toml`, `requirements*.txt`, `Cargo.toml`, `go.mod` | decide what code runs next |
| `*.sh`, `*.ps1`, `*.bat`, `*.cmd` | execute on other machines |
| `Dockerfile`, `*.tf`, `k8s/**`, `Makefile` | provision or build real things |
| `tsconfig.json`, `.eslintrc*`, `.babelrc`, `.prettierrc*` | change how everything else compiles |
| binaries and `node_modules`-adjacent executables | not source |

Provenance is **untrusted unless declared**. Forgetting to pass it disables
nothing; passing `rule` is the only way to earn the exemption.

A refusal does not discard the proposal. The finding is recorded as
`requiresHuman` and emitted as `needs-human`, so the suggestion still reaches
you with an explanation of why it was not applied.

## Autonomy, and what it will never do

You asked for fully autonomous, so that is the default. Autonomous is safe here only
because the refusal list is **structural** -- no config flag, no LLM proposal, and no
autonomy setting can bypass it:

```
force push          git reset --hard      rm -rf            git clean -fdx
history rewrite     git rebase -i         git branch -D     git filter-branch
privilege escal.    sudo                  Set-ExecutionPolicy
remote code exec    curl ... | sh         eval(atob(...))   fork bomb
production          terraform apply       kubectl -n prod   aws ... delete
publishing          npm publish           drop database
plus: any path outside the project root, and any credential file
      (.env, id_rsa, *.pem, .npmrc, .aws/, secrets.yaml, ...)
```

`git push --force-with-lease` is deliberately **allowed**; ordinary pushes, commits,
branch creation, `npm install` and `tsc` all pass.

Run `wd rails` to see this list at any time.

### Dependency installs are allowlisted, not denylisted

An earlier version auto-installed whatever package name appeared in the output.
That is a supply-chain hole: terminal output is untrusted, and anything that can
print to your terminal -- a malicious postinstall script, a compromised build
tool, a hostile README -- could make the watchdog run `npm install <chosen>`, and
installing runs code with your privileges.

A denylist cannot close that, because the attacker picks the name. The rule is now:

> **Only packages the project has already declared are installed automatically.**

That set comes from `package.json`, `requirements.txt` (including `-r` includes),
or `pyproject.toml` (PEP 621 and Poetry), and it is authored by you rather than by
a build log. It **fails closed** -- an unreadable or unrecognised manifest means
"install nothing".

**Declarations do not cross ecosystems.** Both registries host packages with the
same names, so a name declared in `requirements.txt` does not authorise an npm
install. The rule that recognised the error declares which ecosystem failed, and
the executor honours it rather than inferring one from the project layout.

That inference is the bug this replaces: a project with both `package.json` and
`requirements.txt` had `package.json` checked first, so
`ModuleNotFoundError: No module named 'requests'` ran `npm install requests` --
fetching the unrelated npm package of that name. No attacker needed, just a mixed
repo. An action with no ecosystem now installs nothing at all.

Two further consequences:

- **Python installs target a project `.venv` only.** No venv means no install, so a
  global interpreter is never touched.
- **When a lockfile exists, repair goes through it** (`npm ci`,
  `pnpm install --frozen-lockfile`) rather than `npm install <name>`, because
  installing by name re-resolves and can silently fetch a newer -- possibly
  malicious -- version than the lockfile records.

The detection rule is deliberately unchanged: it still reports the missing module.
Only the *acting* on it is gated, because suppressing the rule would hide real
problems rather than fix anything.
### The LLM cannot write anything

The model gets no tools and no write access. It reads a finding and returns **JSON
text**; the watchdog's own code parses it, diffs it, and puts it through the same
guard as everything else. Concretely, a proposed edit is rejected unless its `find`
string is present **and unambiguous** in the target file -- a model that invented the
text is caught before it touches disk.

It is invoked without `--auto`, so even a manipulated prompt cannot escalate it.

**The prompt never touches a command line.** An earlier version passed terminal
output as an argv with `shell: true` -- that was a command-injection vector, since
the "output" is attacker-influenced text from whatever package your build ran. The
prompt now travels over stdin, and the only argv values are fixed flags plus the
model name, which is charset-validated.

**A dead LLM is reported, not hidden.** When the provider returns an error envelope
(402 out of funds, 401 bad credentials, 429 rate limit) the watchdog says so
explicitly instead of recording a bland "unsure" that looks identical to a working
model. `wd doctor` probes it and prints the real reason:

```
  LLM advisor is NOT working: LLM account is out of funds (402).
  Rule-based detection below is unaffected.
```

> **On this machine the advisor currently cannot run** -- the opencode account is out
> of funds. Rule-based detection is unaffected. To silence the warning, set
> `analyze.llm.enabled: false` in `.watchdog/config.json`.

### Everything applied is reversible

```powershell
wd journal              # list applied actions
wd rollback <id>        # undo one, restoring the exact prior contents
```

File changes are journalled with full before-images. Shell commands are recorded but
not reversible, and `wd rollback` says so rather than pretending.

## Modes

Set in `.watchdog/config.json` (or `~/.watchdog/config.json`):

| `autonomy` | Behaviour |
|---|---|
| `suggest` | never changes anything |
| `allowlist` | only acts on kinds you list |
| `autonomous` | applies fixes -- **default**, subject to the rails above |

## The LLM also sees problems no rule recognised

Rules only cover what someone thought to write down. An error-shaped line that
**no rule matched** is sent to the model for a second opinion -- otherwise the
advisor would only ever see problems the rules already understood, which defeats
its entire purpose.

Successful builds are not sent: negation (`0 errors`, `completed with`,
`succeeded`, `nothing to commit`) is checked before the broad error shape.

## Seeing what the model actually decided (Langfuse)

Every advisor call is traced to [Langfuse](https://langfuse.com) if credentials
are present. It is off by default and needs nothing to run:

```powershell
$env:LANGFUSE_PUBLIC_KEY = "pk-lf-..."      # Langfuse project settings
$env:LANGFUSE_SECRET_KEY = "sk-lf-..."
```

`wd status` then shows where traces are going. Each call becomes one generation
observation recording not just the model's text but the decision the watchdog
acted on:
| Field | Why it is there |
|---|---|
| `watchdog.verdict` / `confidence` | what the model concluded |
| `watchdog.proposed_fix` | whether it wanted to change a file at all |
| `watchdog.status` | `provider_402`, `timeout`, `unparseable`... |
| `langfuse.observation.level` | `WARNING` on a provider failure, so a dead or unfunded LLM is never confused with a model calmly answering "unsure" |
| `langfuse.trace.session.id` | groups every call from one terminal |

Three properties this holds to, each with tests:

**Terminal output is redacted before it is sent.** The advisor's input is
whatever your terminal printed, and terminals are where secrets end up by
accident. Prompts and completions go through the same redaction the capture layer
already uses, and transcripts are clipped rather than shipped whole.

### What redaction does and does not cover

`capture.redact` applies to everything the watchdog itself stores or sends:
findings, the journal, LLM prompts, Langfuse traces.

It does **not** apply to the transcript file itself. PowerShell's
`Start-Transcript` writes the raw session to `~/.watchdog/transcripts/*.log` as
the shell runs, long before the daemon reads a byte. Between the moment a secret
is echoed and the moment the daemon tails past it, that secret sits in that file
unredacted.

What bounds the exposure: the file is in your own profile directory, its ACL
grants only you, SYSTEM and Administrators, and it is overwritten by the next
session. What does not: redaction cannot happen earlier without replacing
`Start-Transcript`, and truncating a live transcript would corrupt the session
being recorded.

So the honest version is: **the tool does not widen the exposure your own shell
already has, and it does not eliminate it either.** If a secret reaches disk on
your machine, assume it is in the transcript until the daemon has read past it.

**Tracing cannot change behaviour.** If Langfuse is unreachable, the review still
returns the identical result. Telemetry failing is a tracing problem, not a
watchdog problem.

**A missing SDK cannot stop the daemon.** The OpenTelemetry packages are loaded
lazily, so an untraced run never pays for them, and a broken one degrades to off.

Test it with `npm run langfuse-test`. With no credentials it stands up a local
server on the real ingestion path (`/api/public/otel/v1/traces`, same Basic auth)
and asserts against the bytes that actually crossed the socket -- URL, auth,
content type, and the decoded span. With credentials present the same run reports
to the cloud instead, no extra flag.

## The repository itself contains no credential-shaped string

Redaction is only worth something if the tests can prove it, and testing it needs
input the redactor will match, which means input shaped exactly like a credential.
Those literals used to be written into three files here, which an audit flagged.

They were synthetic -- an AWS-documented example key and a sequential token string
-- and it would have been reasonable to say so and move on. But "obviously
synthetic" is a judgement every secret scanner has to make, and some of them get it
wrong. A security-focused repository should pass a secret scan without an argument.

So the values are assembled at runtime in `test/helpers/secret-fixtures.mjs` and no
contiguous match exists anywhere in the tree. What the redactor is handed is
byte-identical, and the assertions are unchanged.

`test/no-secrets-in-source.test.mjs` walks every text file in the repository and
fails on any match, which is what stops this regressing -- writing a fixture with a
literal is the obvious way to break it, and the obvious way is the one that happens.

It also asserts the scan patterns still match a value of the shape they forbid.
That assertion is not decoration. The first version of the patterns was built by
concatenation and split inside a character class, producing `[0-9AZ]` instead of
`[0-9A-Z]`, which matched nothing -- so the guard passed against a repository still
full of the strings it existed to forbid. A guard whose own patterns are untested
reports success for exactly as long as nothing needs catching.

Two further notes, both found by running it rather than reading it: the guard's
first draft quoted one of the values in its own explanatory comment and failed on
itself, and a second pattern lost a `0` and stopped matching. The test now reports
a file and an offset rather than the value, since echoing a match back into a
failure message puts the string in the transcript, which is the thing being
prevented.

## Rollback will not destroy work it never made

Rollback means overwriting whatever is at the path now with what was there before
the watchdog touched it. If the file has been edited since, that silently eats
the newer work:

```
watchdog fixes a file
  -> you edit the same file
    -> wd rollback <id>
      -> your changes are gone, and it reports success
```

The only condition under which a rollback is the operation you asked for is that
the file still contains exactly what the watchdog wrote. So that is checked
first, against the `afterSha` the journal already records:

```
src/a.js has changed since the watchdog wrote it, so rolling back would
overwrite newer work (expected a3f2b1c9d4e5..., found 7c8d9e0f1a2b...).
Nothing was written. Revert it yourself, or force the rollback if you are sure
the newer changes should be discarded.
```

Two related decisions:

- **An entry with no post-image is refused, not assumed safe.** Entries written
  before hashes existed fall back to comparing the recorded text. An entry with
  neither is refused: "I cannot tell whether this is safe" is not permission to
  overwrite.
- **A created file is removed only while it is still what we created.** The
  new-file path moved the file aside unconditionally, which would have taken a
  file you had started using.

Rollback and crash recovery now share one classifier, because they ask the same
question of the same record. They previously differed in a way that mattered:
recovery compared hashes and rollback compared nothing at all. Rollback is also
atomic now, like every other write.

## A crash cannot leave a file half-written, or a change unrecorded

Writing was `truncate` then `write`. That has two bad windows:

```
truncate, crash mid-write   ->  the file is corrupt, and no record of what it held
write, crash before the
journal entry exists         ->  the change happened and nothing mentions it
```

The target is now **never modified in place**. Contents go to a scratch file in
the same directory, get flushed, and are renamed over the target. A rename within
one filesystem is atomic, so an observer sees the old file or the new one and
never a mixture. The scratch file has to be a *sibling* rather than in the system
temp directory, because a cross-filesystem rename is a copy, which would
reintroduce exactly the window this closes.

The journal entry is written **before** the promotion, with `outcome: "pending"`
and a hash of both images. That makes each crash window decidable rather than
ambiguous:

| target matches | means | settled as |
|---|---|---|
| `afterSha` | the rename happened | `ok` |
| `beforeSha` | nothing happened | `aborted` |
| neither | someone else changed it | `conflict`, left alone |

`recoverPending()` walks those entries and applies that table, then clears scratch
files left by a crash mid-write. The third row is the one worth noting: recovery
**does not guess**. A file matching neither hash is someone else's work, and it
is neither rolled back nor marked applied.

The descriptor is closed before the rename, because Windows will not rename over an
open file. That reopens a small window, so the target is re-read and compared
against the validated preimage immediately before the swap - a concurrent edit
becomes a refusal rather than a silent overwrite.

Every settled entry records `beforeSha` and `afterSha`, on the single-file path as
well as the transactional one, so both are reconcilable after a crash.

## A proposal is judged as a whole, so it is applied as a whole

Verification evaluates the entire proposed edit set at once. Applying it file by
file could leave the repository in a state that passed no check:

```
3 files proposed -> 1 applied, 1 refused, 1 skipped
                    the repository now holds a mixture nothing verified
```

Recording that outcome faithfully is not the same as avoiding it. The record was
accurate and the repository was still wrong.

So the write is two-phase:

```
preflight   open every target through the validated handle, read it, check the
            anchor is present and unique, check the preimage hash, syntax-check
            the result. Nothing is written.
commit      only if every file passed, write them all and journal them all.
```

A refusal therefore lands **before any byte is written**, which is the case that
actually occurs: the model proposed a CI workflow and two sources, the workflow is
refused by the file-class policy, and nothing needed undoing.

Descriptors are held open from preflight through commit on purpose. It makes the
preimage the exact bytes that get written rather than a re-read that might differ,
which is the same guarantee the preimage check exists to provide.

Some consequences worth knowing:

- A `command` or `install-deps` action cannot ride along in a file transaction.
  It is refused rather than half-applied beside patches.
- A proposal touching more than 25 files is refused outright. A set too large to
  apply atomically is not a set to apply in parts.
- Each held-back file says *why*: it was not written because another file in the
  same proposal was refused, and a partial edit would leave the project in a state
  that was never verified.

**What this is not:** an atomic transaction. If a *write fails* mid-commit,
already-written files are restored from the in-memory preimages -- a best-effort
undo, and the restore itself is reported.

A *crash* between two writes cannot be prevented: Windows offers no filesystem
transaction, so a torn tree is a real state. What used to be missing was any way to
**recognise** it. Every entry written by one `applyAll` now carries the id of the
transaction that wrote it, and `recoverPending` groups by that id and decides one
outcome for the whole transaction rather than settling each file on its own:

| state after a crash | outcome | what recovery does |
|---|---|---|
| nothing was written | `aborted` | nothing to undo |
| everything was written | `completed` | recorded as done -- undoing it would destroy good work |
| some was written | `torn-rolled-back` | the written files are restored, so the tree matches the state before the attempt |

That third row is the one that matters. Settling per file left the landed file as
`ok` and the unpromoted ones as `aborted` -- not wrong file by file, but a mixed tree
with no story attached. Restoring only what was written, and recording on every entry
that the attempt was interrupted, makes the situation legible and puts the project
back where it started.

A restore is still refused if someone edited the file after the crash, because
that rule applies everywhere else and an interrupted transaction is not a special
case. Entries written before transactions had ids are settled individually, exactly
as before.

Grouping is mutation-checked: disabling it fails 4 tests.

## Verification proves a version; the file may change

Staged verification copies the project, applies the proposal to the copy, and runs
the project's own checks. What comes back is a statement about a **version** of a
file - but nothing recorded *which* version, so between the check and the write
the file can change: a build regenerating it, an editor autosaving, you typing.

The obvious defence doesn't work. `#patchFile` already refuses when the `find`
anchor is missing. The failure mode isn't a missing anchor - it's a *newer* file
that still contains the same anchor. The edit applies cleanly, parses cleanly, and
lands in a version of the code nobody looked at.

So the preimage is hashed before verification and compared against the bytes
actually read immediately before writing:

```
verify   ->  sha256(content at staging time)      recorded per file
apply    ->  sha256(bytes just read)              must match, or `stale`
```

The comparison hashes the content read through the validated descriptor, not the
path - hashing a path would reintroduce the "the object at this path may have
changed" problem the handle validation exists to solve.

It lives **inside** `#patchFile` rather than in the caller. A precondition a caller
can forget is not a precondition, and every write funnels through that method.

A stale file is refused with `status: 'stale'`, nothing is written, and the
finding goes to a human:

```
src/a.js changed after it was verified (expected a3f2b1c9d4e5...
found 7c8d9e0f1a2b...). The fix was proved against a different version of this
file, so it was not applied. Re-run the check against the current file.
```

Rule-driven fixes pass no `expectPreimage` and are unaffected - they're reviewed
by the rule's author and never go through staged verification.

## npx fetches; it does not only run

The command policy permits `npx tsc` and `npx eslint`, and the comment claimed
these were "binaries the project already declares". Nothing checked that, and
npx would not have honoured it either.

`npx <name>` does not only run a locally installed binary - it **fetches** one.
Against a project without typescript it resolves the `tsc` package from the
registry, installs it, and runs its bin script. So a line of terminal output
could choose a package name and get code execution, which is exactly the
supply-chain hole the install policy spends so much effort closing, reachable
through a command the policy had already blessed.

Bare `npx` is now refused:

```
refuses "npx tsc": npx downloads the package when the binary is not installed
locally, so a bare invocation lets terminal output choose what gets fetched and
executed. Use --no-install, or run the binary directly.
```

`--no-install` (or `--no`, `--offline`) is required, and **npx enforces it
itself** - the binary must already be present locally or the command fails.
Relying on the tool's own enforcement beats duplicating a filesystem check here:
`checkCommand` is deliberately pure, and a hand-rolled "is it declared" test
would be a weaker copy of a guarantee npm already provides.

The flag does not widen anything: `npx --no-install evil-package` is still
refused, because `--no-install` makes the *fetch* impossible but says nothing
about whether a binary name is safe.

The practical cost is nil. `tsc` and `eslint` are allowed directly, and npm
scripts already put `node_modules/.bin` on PATH, so the direct form is what a
project would use anyway.

The requirement is declared on the program (`requiresLocalBinary`) rather than
special-cased, and a test asserts that every program which can fetch declares it
- so a future `bunx` or `uvx` added to the policy cannot forget.

## Dependency repair is not autonomous, and the reason is the undo

An audit asked for "an isolated dependency-install execution environment" and
treated its absence as a blocker. Reading the code, that framing does not hold up.

**What actually executes.** `repairArgv` is `npm ci --ignore-scripts`, not
`npm install`. `ci` reproduces the lockfile rather than resolving, so it cannot pull
a version the project did not already pin. Every install carries `--ignore-scripts`,
or `--only-binary=:all:` for Python, so **no third-party code runs at all**.
"Package installation is inherently code execution" is not true of this path.

**What is actually left** is a different problem, and a worse one than the objection
it replaces. `npm ci` deletes `node_modules` and rebuilds it -- the widest blast
radius of any action here -- and a command is journalled as unreversible, so
`wd rollback` refuses it by design. Every other autonomous action records a
preimage and can be put back.

So the dependency action was the **only** thing this program would do unattended
and be unable to undo. A container would not have changed that. The two problems
are orthogonal: isolation and reversibility are different properties, and this one
lacked the second.

Dependency actions are therefore refused under `autonomous`, with the refusal
naming that reason rather than blaming install scripts -- which do not run here, and
saying they did would teach the reader the wrong model of their own risk.

They remain available under `allowlist`, where the user names the kind:

```
wd init --allowlist        # then list repair-deps to opt in by name
```

That is stricter consent than a confirmation prompt, because it is a standing
decision recorded in config. Nothing new was invented; the loosest tier was simply
stopped from implying the tighter ones.

The boundary this draws is worth stating plainly: **everything the watchdog does
autonomously, it can undo**, with dependency repair as the one named exception you
have to opt into.

Four tests were asserting that autonomous installs succeed. Their intent was the
install *policy* -- undeclared packages refused, scripted projects refused, no venv
refused -- so they now opt in by naming the kind, which is how a real user does it.
One sandbox walkthrough narrated "the allowlist REFUSES" while the actual stop had
become the autonomy policy; it now names the kind too, so the hop it demonstrates
is the hop that fires. That demo claiming credit for a refusal it did not cause was
the same failure as the stale README bullet, in a script this time.

The package allowlist's own refusal also left no journal entry, which made it the
one refusal that was both the most important and the least reviewable. It is
recorded now, with the package name.

## Dependency repair does not hand a package your credentials

Repair already decided *which* package to install: it must be declared, the
ecosystem must match, and the install goes through the lockfile rather than by
name. That closes the injection vector -- whoever controls terminal output can no
longer choose what gets installed.

None of that touches what actually happens during an install. The package runs its
own `postinstall` script, with the user's privileges, on the user's machine, with
nothing around it. The package is already trusted to run code; the only remaining
question is whether the watchdog is the thing that hands it the keys.

So every generated install runs with lifecycle scripts disabled:

| | |
|---|---|
| npm | `--ignore-scripts --no-audit --no-fund` |
| pnpm / yarn | `--ignore-scripts` |
| pip | `--only-binary=:all:` |

pip has no `--ignore-scripts`, so the closest thing is refusing to build from
source: a wheel installs declaratively, while an sdist runs the package's own
`setup.py` with full privileges.

**This has a real cost, and it is worth stating plainly.** A native module
(`better-sqlite3`, `sharp`) genuinely needs its build step, so an install with
scripts disabled produces a package that is installed *and broken*. The next run
fails too -- but by then the log says the repair worked.

So repair refuses up front, and names the package. The lockfile records
`hasInstallScript` per package, so this is precise rather than a blanket refusal
of every project that happens to depend on a native module:

```
refused to repair dependencies automatically: this project has 1 package(s)
that run install scripts (node_modules/better-sqlite3). Autonomous repair runs
installs with lifecycle scripts disabled, so the package would be installed and
still broken. Run the install yourself, where you can see what runs.
```

That is the honest shape of this fix. Not "we made it safe", but "we made it safe,
here is what it costs, and here is where we stop and ask".

**Still not done:** no container. Docker and WSL are both available on this host,
so a container-backed install with no network and a read-only mount is achievable
-- but that is a different kind of change to this codebase, and a half-built one
would be worse than the honest refusal above. Script suppression means the
dangerous code does not execute, which for this threat is stronger than
isolation rather than a weaker substitute for it.

## Taking the file's name from the error, not from the model

The model cannot see the file tree, so it answers with a bare basename:
`tally.js` for a file at `src/tally.js`. The obvious repair -- search the tree for
a file with that name -- is a guess wearing a decision's clothes:

```
model guessed wrong -> system guesses what the model meant -> edit wrong file
```

"Exactly one file has that name" is not evidence of intent. It refuses when two
files collide and accepts when none do, so it is the same coin flip either way --
it just fails loudly sometimes. A project with only `scripts/build.js` in it edits
`scripts/build.js` because nothing happened to disagree.

But the evidence usually names the file precisely:

```
at tally (/app/src/tally.js:2:16)
File "svc/handlers.py", line 88, in handler
  --> src/parse.rs:44:9
```

So the order is now:

1. **the trace**, which is read off the error rather than guessed
2. the model's own path, if it already resolves
3. the model's basename, resolved by searching for a unique match -- now a
   fallback, for evidence that genuinely names no file

The trace's prefix is not trusted; `/app/src/tally.js` is from a container and
does not exist here. What *is* trusted is the longest trailing run of segments
that resolves to exactly one real file. That is a fact about this filesystem, not
a guess about intent. Two or more matches at the same length is a refusal.

A bare filename in a trace (`tally.js:2`) is deliberately **not** treated as
specific -- it is the same weak signal as the model's basename guess, and
pretending otherwise would reintroduce the guess.

Every proposal records `resolvedBy`, so the journal shows whether the path came
from the trace, the model, the fallback, or nowhere.

## Validating the object, not the path

Checking that a path resolves inside the project and then opening it later is not
the same as checking the thing you opened. Between the two moments the object at
that path can be replaced with a junction pointing somewhere else, and every
path-based check would have passed about a file nobody was going to write to.

`#patchFile` made that concrete. It opened the path **five separate times**:
`existsSync`, `statSync`, a read to compute the edit, a second read for the
snapshot, and the write. Any two of those could see different objects.

The worst consequence was not an escape at all. It was that the snapshot could
record content that was never patched, so `wd rollback` would faithfully restore
the wrong thing and report success doing it.

The write path now opens once, proves the handle is the object that was
validated, and reads and writes through that descriptor:

```
containedPath(root, target)      -> the path is inside the project
lstatSync(abs)                   -> which object does it refer to *now*
openSync(abs, 'r+')
fstatSync(fd)                    -> is this the same object?
containedPath(root, target)      -> has it moved since?
```

On Windows `ino` is the NTFS file index: stable across writes to one file,
distinct between files, and - the property that makes this work - **equal to the
outside file's index when read through a junction**. So a swap produces a handle
whose identity no longer matches, and is refused.

A swap *after* the open cannot corrupt anything, because the descriptor is bound
to the validated object. It is still refused: something else is rewriting the
tree, and the edit was computed from content that may no longer be current.

Two details that are easy to get wrong:

- Writes go at an **explicit offset**. The read left the descriptor at end of
  file, so writing at that position after truncating would append into the hole
  and leave the previous contents' tail behind. Dropping the offset argument fails
  4 tests.
- `sameFile` returns false when either `ino` is 0. Comparing two zeros would make
  every pair look identical, which is worse than admitting we cannot tell.

### Hardlinks: closed by removing the capability, not by detecting them

A hardlink inside the project to a file outside it defeats every path-based check,
and no amount of extra checking can fix that:

```
project/src/data.js  ->  C:\elsewhere\secret.txt   (hardlink)
```

The path is inside the project. `realpath` agrees. `ino` and `dev` match the
outside file, because they **are** the outside file. A hardlink is not an
indirection to be resolved -- it is a second name for one inode, and there is no
portable way to enumerate the other names. Detection could never be complete, so
this was closed structurally instead.

`openContained` used to open with `r+`, and both call sites passed `r+`
explicitly, on the theory that the descriptor was the safest way to do the edit.
It never was used that way: the only operations through the handle were reads, and
the content was replaced afterwards by `atomicReplaceIfUnchanged`. What `r+`
actually did was leave a **loaded write capability pointed at a validated inode**
-- one refactor away from being used, and a write through a handle is precisely
what a hardlink turns into an escape.

So the capability is gone rather than merely unused:

- `openContained` opens **read-only** and refuses any other flag with
  `write-not-permitted`. A caller cannot reintroduce the hole by forgetting to
  pass something else.
- It refuses any handle whose **link count is above 1**, with `hardlink`. An
  unreported count is refused too, since optimism about what cannot be seen is
  exactly what this module exists to avoid.
- The refusal happens **before** a descriptor is taken, which a test asserts via
  the `onChecked` seam rather than taking on trust.
- Content is replaced by **renaming a new file over the directory entry**, so the
  in-project name is repointed and any inode shared with the outside world keeps
  its own bytes. The tests replace a hardlinked path and then assert the outside
  file is untouched.

The message deliberately does not claim the other names are outside the project.
It cannot know that; they may all be inside. A test that hardlinks two files
*within* the project caught an earlier version of the message asserting otherwise,
which is the right way to find out.

Hardlinks are created here with `fsutil hardlink create`, which needs no
elevation, and the tests use real ones. A mocked link count would exercise the
branch without touching the filesystem.

### The rollback that was writing to a closed descriptor

`applyAll` closes every descriptor before its commit loop, because Windows will
not rename over an open file. Its catch block then called
`writeFd(p.fd, p.before)` to restore what had landed.

That call could not restore anything, and it was not harmless. The descriptor
number had already been reassigned by the runtime. Verified on this machine by
reproducing the shape: Node handed `3, 4, 5, 6` straight back to the temp files
`atomicReplaceIfUnchanged` opens, so the "rollback" **truncated and rewrote an
unrelated file**, left the real targets modified, and still reported
`rolled-back`. It also settled no journal entry, so a crash afterwards would have
found pending entries describing changes that were no longer on disk.

It now calls `#undoWritten`, which restores by rename and needs no live handle,
and settles each entry to `rolled-back`.

This is the same primitive a hardlink needs -- a write through a handle to an
inode that is not the one that was validated -- which is why it is fixed here
rather than filed under crash recovery. `transaction.test.mjs` covers pre-flight
refusals thoroughly and had no coverage of this path at all, which is why the bug
survived. `writeFd` remains exported for tests only, and one of them now asserts
that a containment handle refuses a write at the descriptor.

## Verification proves a transition, not a repair

An audit objected that verification proves *"this version passes the project's
configured check"* and not *"the model repaired the original problem correctly"*.
Both halves of that were true, and the second one was the defect.

Verification ran **only after** the edit. `pass` was reported as "the project passes
its own verification with this edit applied" -- a sentence that is equally true of

- a project whose checks never covered the reported error, and
- a project that was already broken and stayed broken.

There was no measurement of the state *before* the edit, so "this fixed something"
and "this broke nothing" came back with the same word. The watcher comment even said
`pass` means the project *"still"* passes, which is honest internally and
misleading in the verdict name.

The missing baseline produced errors in **both** directions:

- **false positive** -- an unrelated edit on a passing project read as a repair.
- **false negative** -- a correct edit on an *already failing* project was rejected,
  because the project was broken for an unrelated reason and the message said the
  edit broke it. That one had no test at all.

So the check now runs twice, on the staged tree before and after, and what is
reported is the transition:

| evidence | before -> after | claim |
|---|---|---|
| `repaired` | failing -> passing | strongest available; still only about the project's own check |
| `not-broken` | passing -> passing | the edit did no harm; says nothing about the reported error |
| `broke` | passing -> failing | a regression |
| `inconclusive` | failing -> failing | already broken elsewhere; not attributable in either direction |
| `unknown` | -- | the baseline could not be obtained, so no comparison was possible |

`verdict` keeps its original three values so nothing downstream changes meaning. The
nuance rides alongside in `evidence`, which is additive.

The summary line a user reads was `"applied after passing the project's own
verification"`, which reads as though the repair had been verified. In the common
case it now says the opposite of what it used to imply:

> applied: it did not break a project that was already passing its own checks. That
> is not proof the reported error is fixed

This cannot be fixed by better staging. Whether the project's checks *cover* the
reported error is not something this program knows, and `not-broken` is the honest
name for that. The cost is one extra verifier run per proposal, paid only when
`verify.command` is configured -- by default this program verifies nothing and
applies nothing.

A test asserts the ordering rather than trusting it: a check script that only passes
on its **second** invocation. That can only be satisfied by two runs with the
baseline first. Mutation-checked -- faking the baseline as always-passing fails 3
tests, including `repaired` and the false-negative case.

## Proving an edit before making it

Confidence is not correctness. An LLM edit used to be authorised by:

```js
advice.verdict === 'problem' && advice.fix && advice.confidence >= 0.6
```

Neither half says anything about whether the edit is right. Confidence measures
how sure the model sounded. The fix-quality eval then showed what was left over:
patches that applied cleanly and parsed still changed behaviour for the worse,
because a valid edit can be semantically wrong.

So the edit is now proved rather than trusted:

```
copy the project to a scratch tree
apply the proposed edits there
run the project's own verification
only then replay the same edits against the real tree
```

The real project is never left half-edited while the question is open. That is
the difference from apply-then-check-then-revert, which leaves broken code on disk
for the duration of the check and leaves it there permanently if the process dies
mid-check.

Three outcomes, all reported rather than collapsed:

| | |
|---|---|
| `pass` | the project still passes its own checks; applied |
| `fail` | it does not; kept as a suggestion, with the reason |
| `unverified` | there was no way to check; **not** applied |

Configure it per project:

```json
{ "verify": { "command": ["npm", "test"], "timeoutMs": 300000 } }
```

With nothing configured, **no model-proposed edit is ever applied
autonomously** - they are reported for a human instead. That is the honest
default: with nothing to verify against, "verified" is a word with no meaning
behind it.

> A bug worth knowing about, because it made this gate decoration for a while.
> The first version reused `runCapture`, which collapses a child process to a
> string and discards the exit code whenever stdout was non-empty
> (`if (out.trim()) return finish(out)`). Fine for pulling a JSON envelope out of
> an LLM reply. Disastrous here: `npm test` prints progress and exits 1, which
> through that helper is indistinguishable from success. Every verification passed
> unconditionally. A check that cannot fail is worse than no check, because it is
> believed.

## Failing safe when configuration is broken

A config file that cannot be read is a config whose intent is unknown, and the
safe reading of unknown is the least permissive one:

```
{"autonomy": "suggest"}
  truncated by a half-written file
  defaults say "autonomous"
  watchdog applies fixes without asking
```

That used to be exactly what happened. An unreadable layer was replaced with
`{}` and the defaults filled the gap, so a parse failure **increased**
permission. It now pins autonomy to `suggest` and says so in `wd status` and
`wd doctor`, because a silent downgrade is its own lie - the obvious reading of
`autonomy  suggest` is "I chose that".

One deliberate exception: if a **readable** layer states autonomy explicitly, it
is honoured. The hazard is a default being used as a substitute for a decision,
not a stray broken file. A corrupt `~/.watchdog/config.json` is reported but
does not veto a project's deliberate `autonomous`; letting the fail-safe decide
policy would be worse than the bug.

The rest of the config still loads. A watchdog that refuses to start is not a
safe watchdog, it is a blind one, and losing monitoring quietly is its own
failure mode.

> A related bug this uncovered: `DEFAULTS` was `Object.freeze`d, which looks
> immutable but is only one level deep. The merge shared `DEFAULTS.paths` by
> reference, so assigning `merged.paths.data` wrote straight through into the
> default and the *next* project loaded inherited the *previous* project's data
> directory. Merges are now deep-copied.

## What the model is actually good at

The sandbox asserts a proposed edit is "applied or safely refused", which passes
whether the fix was right or the rails blocked it. So it measures the rails and
calls it fix quality. Nothing checked whether a suggestion was *correct*.

`npm run eval-fix-quality` does. It reports three things that fail independently,
over N repeats, against a corpus with known ground truth:

```
sandbox/eval-fix-quality.mjs      # WD_REPEATS=5 for a tighter read
```

| Measured over 5 runs | Result |
|---|---|
| **triage** (problem vs noise) | **20/20 correct** |
| fix proposed at all | 20-40% |
| of those, anchor applicable | now 100% after path resolution |
| of those, fix actually worked | 20-100%, varying by case |

Three things worth knowing:

**Triage is the reliable part.** Perfect classification across every case,
including correctly staying silent on a successful build. Whatever else is
uncertain, the model is good at deciding whether something is wrong.

**The model cannot see the file tree**, so it answers with bare basenames --
`tally.js` for `src/tally.js`. Roughly half of all proposed fixes were being
dropped for that alone. Paths are now resolved when exactly one file has that
name; ambiguity leaves the path alone rather than guessing, because picking
wrongly would edit the wrong file.

**A patch can apply perfectly and still be wrong.** The eval found the model
replacing the bare identifier `count` with `let count = 0;`: the anchor matched,
every existing check passed, the file was written, and the result did not parse.
"Anchored text was present" is not evidence that "the result is code". Patches to
JavaScript are now parsed before they are written.

The eval reports rather than gates. The model is non-deterministic -- identical
prompts give different verdicts -- so a single-sample pass/fail would be theatre.

## Sandbox

An isolated project with deliberately broken code, plus two harnesses that run the
watchdog for real inside a blast radius you control.

```powershell
npm run sandbox           # 9 deterministic scenarios
npm run daemon-test       # real daemon + real PowerShell + real transcripts

$env:WD_LIVE_LLM = "1"
npm run sandbox:live      # also ask the real model
```

The live leg is not decoration. `opencode run --format json` emits an **NDJSON
event stream** with the answer nested in `part.text`; a parser written against a
stub returns `unsure` for every response forever, and only a real invocation
exposes it.

See [sandbox/README.md](sandbox/README.md) for what the sandbox has caught -- every
finding listed there is now a named regression test.

## Autostart, and proving it is actually running

```powershell
wd autostart            # register
wd autostart --status   # inspect (read-only)
wd autostart --remove   # unregister
```

Registering is not the same as being covered, so the tool reports them as two
separate claims. It prefers a Scheduled Task, but creating one needs an elevated
shell, so it falls back to a **Startup-folder launcher** that starts the daemon
hidden. It says so at install time, because the fallback trades one guarantee for
another:

| | Scheduled task | Startup folder |
|---|---|---|
| starts at logon | yes | yes |
| restarts after a crash | configurable | **on the next shell you open** |
Neither is a true supervisor, so neither recovers *the instant* the daemon dies.
What the Startup-folder path does instead of giving up: the managed block in your
shell profile checks a global index of running daemons on every shell start, and
relaunches any project whose heartbeat has gone stale. So a crash is healed the
moment you open a terminal: not immediately, and not while you never open one.
The check is PowerShell-native (one small file read), because spawning node on
every shell start would cost ~200ms each time.

The daemon also records what it does to `.watchdog/daemon.log`, rotating at 2MB.
Without it a crash under the launcher leaves no trace at all, since the launcher's
window is hidden and its output discarded, which is exactly what happened the
first time this daemon died.

Only one daemon may run per project, and that is enforced by an **exclusive
create** (`.watchdog/daemon.lock`, `O_EXCL`) rather than by reading the heartbeat.
The earlier version read the heartbeat, saw nobody running, and returned "ok" --
check-then-act with nothing in between. Two `wd start` processes racing at the
same moment both passed it, **20 times out of 20** when measured, so the guard was
not merely racy but ineffective for the case it exists to prevent. That matters
because two daemons means double the LLM spend and two autonomous appliers writing
the same files.

A lock left by a crashed daemon is taken over, checked by pid liveness rather
than age, so a dead daemon still cannot block the next start. Release verifies the
lock token first, so a daemon that stalled long enough to be taken over cannot
delete the *new* holder's lock on its way out.

The daemon **beats**: it writes `.watchdog/daemon.json` atomically every 5s
with its pid and a timestamp, and the absence of a fresh beat is the signal.

| Verdict | Meaning |
|---|---|
| `RUNNING` | beating, pid alive |
| `STALE` | beat older than 20s -- died, nothing restarted it |
| `DEAD` | file survived but the process is gone, or the file is corrupt |
| `NEVER-STARTED` | registered but it has never actually run |

The combination that silently protects nothing is called out explicitly:

Each of these verdicts is a named test, and each was verified by reintroducing the
original bug and confirming the suite fails:

```
bug --status writes        -> 2 tests fail
bug VBS quote doubling     -> 1 test fails
bug ms printed as seconds  -> 1 test fails
bug missing coverage state -> 3 tests fail
```

```
  REGISTERED BUT NOT RUNNING - you are NOT being covered.
```

A second daemon is refused outright, so the logon launcher and a manual
`wd start` cannot both append to the same findings log.

For real supervision, run `wd autostart` from an elevated shell: that registers
the Scheduled Task instead, which can be configured to restart on failure.

## Commands

```
wd init [--dry-run]     install          wd status         live summary
wd uninstall            remove           wd findings       list findings
wd start                run daemon       wd rules          list rules
wd doctor               coverage report  wd rails          list refusals
wd autostart [--remove|--status]        daemon at logon + liveness
wd scan <file>          analyse a log    wd journal / wd rollback <id>
```

## Configuration

```jsonc
{
  "autonomy": "autonomous",
  "capture": {
    "layers": { "shell": true, "process": true, "conpty": false },
    "redact": true          // secrets stripped from findings, journal, LLM and traces
  },
  "analyze": {
    "llm": {
      "enabled": true,
      "cli": "opencode",
      "model": null,        // null = let opencode choose
      "minSeverity": "medium",
      "maxInvocationsPerSession": 2
    },
    "cooldownMs": 15000,    // per-signature, so a looping build cannot spam the LLM
    "maxFindingsBytes": 16777216  // findings.jsonl rotates past this, keeping one generation
  },
  "tracing": {
    "enabled": false,
    "publicKey": null,      // or set LANGFUSE_PUBLIC_KEY
    "secretKey": null,      // or set LANGFUSE_SECRET_KEY
    "baseUrl": "https://cloud.langfuse.com",
    "environment": "local",
    "redact": true          // strip secrets from prompts and completions
  }
}
```

The LLM is only consulted for rules whose confidence is not `high`, at or above
`minSeverity`, capped per session. Deterministic detection stays free and instant.

`tracing.enabled` without credentials is reported by `wd status` as
`on but no credentials - every span is being dropped` rather than being treated
as a working setup. Credentials in the environment win over the file, so a single
run can be traced without editing config.

Credentials are usually kept in the **global** config
(`%USERPROFILE%\.watchdog\config.json`) rather than per project, so the secret
exists in one place instead of one copy per repo. That file is merged by every
project, which is exactly why there is an explicit off switch:

| Variable | Effect |
|---|---|
| `WD_TRACING=off` | disables tracing even with valid credentials |

The sandbox harnesses set this. Without it they inherit the real config and ship
their deliberately-fake stack traces to your actual Langfuse project, which is
not something a test gets to do quietly.

One caveat when enabling this: **terminal output is the advisor's input**, so
enabling tracing means your build logs are being sent to a third party. Redaction
covers known secret shapes and is on by default, but it is not a guarantee. If
that trade is not acceptable, leave `WD_TRACING` off and rely on the rule-based
layer, which never leaves the machine.

## Opting out

Set `WD_DISABLE=1` in any shell to exclude it from capture without uninstalling.

## Tests

```powershell
npm test                 # 190 unit/integration tests
npm run sandbox          # 33 sandbox checks
npm run daemon-test      # 9 daemon integration checks
npm run langfuse-test    # 21 tracing checks (13 of them against the cloud, with credentials)
```

`langfuse-test` needs no credentials. Without them it captures the real OTLP
request against a local stand-in for Langfuse's endpoint; with them it reports to
the cloud, so the same command is the whole test either way.

The suite covers the parts that would silently lose data or destroy work if wrong:
UTF-8 and ANSI sequences split across chunk boundaries, carriage-return progress
rewrites, secret redaction, every guard rail, rollback correctness, and the refusal
to run fix commands on the event loop (a blocking `npm install` would otherwise
blind every terminal the watchdog is watching).

It also pins down the false positives found in live use, each of which is now a
named test: a transcript header quoting a command reported as a TypeScript error,
`assert 401 == 200` reported as an auth failure, and `node_modules` paths reaching
the compiler-error rule. The sandbox (see above) covers what a unit test cannot: a real daemon, a real
PowerShell session, and a real model call.

### Why there is an integrity test

Editing this codebase with PowerShell `Set-Content` round-trips destroyed UTF-8
five separate times, silently replacing characters with U+FFFD while the file
still parsed and every test still passed. A failed string-splice edit once
duplicated half of `bin/wd.js` for the same reason.

Syntax checks catch broken code. They cannot catch content quietly mangled by an
encoding round-trip or a bad splice, so `test/integrity.test.mjs` checks for that
class directly: replacement characters, stray BOMs, duplicated top-level
declarations, and non-ASCII outside the two files where unicode is the whole
point (a progress-bar character class and a multibyte regression test).

Corollary for anyone editing here: **use the editor tool, not shell string
surgery.** If a bulk change is genuinely necessary, read the region back
afterwards -- and read it with a tool that decodes UTF-8, because the Windows
console will render valid characters as `?` and send you chasing damage that
is not there.

## Known limits

- **No WSL, no JetBrains** on this machine. WSL has no distro installed; neither
  IDE is present. The Git Bash hook is wired and untested here.
- **Full-screen apps** (`vim`, `less`, `fzf`, `lazygit`) are captured by the
  transcript layer but render as a stream of cursor-positioned writes, so the
  reconstructed lines are approximate. Detection still works; the evidence line may
  look scrambled.
- **Layer 2 has no exit codes, and cannot get them.** A process exit code goes to
  the parent that spawned the process; for the IDE tasks and scheduler jobs this
  layer exists to watch, that parent is not us. The two Windows routes both fail
  here: WMI process-stop tracing returns *Access denied* for a non-administrator
  (verified on this machine), and ETW needs a native binding, which is the same
  wall that leaves ConPTY disabled. So a process that exited cleanly and one that
  crashed look identical to this layer.

  This is **not** a gap in the execution path: commands the watchdog spawns itself
  do report their exit code, because `runCapture` sees the `close` event on its
  own child. The absence is specific to externally started processes.

- **Attribution on Windows works by inheritance, not by inspection.** There is no
  working-directory property on `Win32_Process`, and the working directory appears
  nowhere in `CommandLine` -- verified against a process started with an explicit
  `-WorkingDirectory`. So layer 2 walks `ParentProcessId` upward looking for a
  shell the session registry recorded a cwd for, and reuses that.

  This recovers the common case -- `node server.js`, `npm test`, `pytest` started
  from an instrumented terminal in the project -- which previously were **invisible**
  because argv says nothing about where they run. Two limits: a process whose
  ancestors were never instrumented still cannot be attributed, and a project
  launched from an uninstrumented parent is only seen if the project path appears
  in its command line.

  The relevance filter still exists to avoid reporting the machine's own
  infrastructure, which is how a monitor gets ignored. `processAnywhere` disables
  it.
- **Arbitrary `command` actions are allowlisted.** An earlier version of this
  bullet said they were denylist-protected, which was stale and wrong: it caused an
  external audit to report a blocker that had already been closed. `src/act/commands.mjs`
  checks the verb, every flag, every argument and any script a command would run,
  against a typed allowlist, and refuses with `command_verb_not_allowed`,
  `command_flag_not_allowed`, `command_arg_not_allowed` or
  `command_script_not_allowed`. The regex denylist still runs, **last**, as a
  backstop -- two layers on purpose, so the allowlist is the boundary rather than
  the fallback. Unknown commands fail closed.

  The gate itself was, until recently, load-bearing and untested at the same time.
  Replacing the whole of `checkCommand` with `{ ok: true }` failed 15 tests, so the
  allowlist is well covered -- but deleting the one line that calls the guard from
  `applyAsync`, the function whose entire job is to run commands, failed **zero**.
  `test/command-gate-e2e.test.mjs` now drives `applyAsync` and asserts on the
  refusal, including that a permitted command still runs, so the refusal tests are
  discriminating rather than merely strict. Removing the gate now fails 7.

  A refused command is also journalled, with the argv that was proposed. It was not:
  the gate refuses before the command path runs, so a proposal to run something
  dangerous left no evidence that it had ever been made.

  `listRails()` -- what `wd doctor` shows when you ask what will not be done --
  claimed `git push` was refused under `command_verb_not_allowed`. It is allowed.
  `test/rails-truthfulness.test.mjs` now executes every example in that list and
  requires it to actually be refused, so the refusal list cannot drift away from the
  behaviour again. Three more examples were re-filed while writing it.
- **PowerShell 5.1 only** here -- `pwsh` is not installed. The profile block is
  compatible with both.
- **Rules judge one line at a time.** A multi-line stack trace is judged as N
  independent lines. Fine for today's rules; it will need context for anything that
  spans several lines.
- **Recovery is on next shell start, and there is no non-elevated way to do
  better.** The Startup-folder launcher starts the daemon at logon but cannot restart
  it after a crash; what heals a crash is the heartbeat check in your shell profile,
  which fires the next time you open a terminal. Until then `wd status` is the only
  thing that tells you whether coverage is real.

  This was measured rather than assumed, and the answer is a platform boundary.
  Registering a Scheduled Task on this machine returns *Access is denied* without
  elevation -- not just the restart settings, any task at all. And restart-on-failure
  is what real supervision requires: a task that starts the daemon at logon and does
  nothing when it dies is not a supervisor.

  So the Scheduled Task is **no longer preferred**, which reverses an earlier
  decision. It was preferred on the belief that a task supervises better than a
  Startup-folder entry, and it does not: the task carried no restart-on-failure
  settings and reported `restarts: false`, while the Startup-folder path reported
  `restarts: true` because the shell profile relaunches a stale daemon. Both install
  that profile, so recovery was identical. What preferring the task actually bought
  was a machine-wide artifact that needs elevation to create *and* to remove, in
  exchange for nothing.

  The task path is kept behind an explicit opt-in for a future elevated install that
  can turn restart-on-failure on and report the result honestly. It is not a
  hardening step that was skipped; on this machine it is not reachable.

## Rules with no fix, on purpose

`test-failure` and `out-of-memory` carry no remediation. The honest answer differs
per project (raise `--max-old-space-size`? tune a worker pool? re-run which suite?),
and a generic command would be a guess wearing the costume of an action. A finding
with no fix beats a fix that reports `skipped: no command to run`.

## License

MIT. See [LICENSE](LICENSE).

That matters more than usual here: the safety rails in `src/act/` are the part
worth reusing. Autonomy is only defensible because refusing happens in code that
does not consult whatever proposed the action. If you fork this, keep that
separation intact.

