# watchdog

Watches every terminal on the machine -- Windows Terminal, PowerShell, Git Bash, VS Code
and Cursor integrated terminals -- spots real problems, and either suggests a fix or
applies one under hard safety rails.

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
- **Arbitrary `command` actions are still denylist-protected.** Dependency installs are
  allowlisted, but a rule or model proposal of some other shell command passes if it
  matches no known-bad pattern. Converting the remaining rails to an allowlist of
  permitted commands would be the next hardening step.
- **PowerShell 5.1 only** here -- `pwsh` is not installed. The profile block is
  compatible with both.
- **Rules judge one line at a time.** A multi-line stack trace is judged as N
  independent lines. Fine for today's rules; it will need context for anything that
  spans several lines.
- **Recovery is on next shell start, not automatic.** The Startup-folder launcher
  starts the daemon at logon but cannot restart it after a crash; what heals a
  crash is the heartbeat check in your shell profile, which fires the next time
  you open a terminal. Until then `wd status` is the only thing that tells you
  whether coverage is real. See Autostart above.

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

