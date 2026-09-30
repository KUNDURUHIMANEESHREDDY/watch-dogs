# Sandbox

An isolated project with deliberately broken code, plus two harnesses that
exercise the watchdog end to end. Everything here is confined to
`sandbox/project/` — the autonomous path runs for real, but inside a blast radius
you control.

## Run it

```powershell
npm run sandbox           # deterministic scenarios
npm run daemon-test       # real daemon + real PowerShell + real transcripts

$env:WD_LIVE_LLM = "1"
npm run sandbox:live      # also ask the real model
npm run daemon-test:live  # real model in the daemon's residual-triage path
```

Both exit non-zero on failure and print a check-by-check report.

## Why a live model leg exists

`opencode run --format json` emits an **NDJSON event stream**, not a JSON document,
and the answer is nested inside `part.text`. An earlier parser pulled the first
balanced object and therefore saw a verdict of `unsure` for every response — a bug
no stub-based test would have caught, because the stub was written to match the
bug. Only a real invocation surfaces it.

The 402 that blocks the default model is a billing problem, not a code problem, so
the sandbox pins a free model. Override with `WD_TEST_MODEL`.

## What the scenarios prove

| # | Claim |
|---|---|
| S1 | Rules detect known failures and produce **zero** findings on known-noisy lines |
| S2 | An autonomous install is journalled; a shell action refuses rollback honestly |
| S3 | A file edit rolls back to byte-identical prior contents |
| S4 | `force push`, `reset --hard`, `rm -rf`, `terraform apply`, `.env`, and traversal are all refused **in autonomous mode** |
| S5 | A model that invented the file text, or an ambiguous anchor, changes nothing |
| S6 | Nothing escapes the sandbox — not the filesystem, not a stray file |
| S7 | `suggest` mode writes nothing at all |
| S8 | The real model reviews a real defect |
| S9 | A prompt-injection attempt in terminal output produces no applied edit |

## What the sandbox has already caught

Every one of these was found by running this, not by reading code, and each is now
a named regression test:

- **Empty `path` from the model** resolved to the project root and crashed the
  applier with `EISDIR`. Model output is untrusted input; paths are now validated
  at the boundary and re-checked with `statSync().isFile()`.
- **The NDJSON parsing bug** described above.
- **No rule for `ReferenceError`** — a plain `ReferenceError: count is not defined`
  produced no finding at all. Nine runtime-error rules were added.
- **The advisor only ever saw problems the rules already understood**, which defeats
  the purpose of a second opinion. Residual triage now sends unrecognised
  error-shaped lines to the model.
- **`Build completed with 0 errors`** was triaged as a failure because it contains
  the word "errors". Negation is now checked before the broad error shape.
- **The `busy` dedup status triggered the "LLM IS NOT WORKING" banner**, which is
  both wrong and alarming. Only genuine provider and transport failures raise it.
- **This harness's own `check()` never incremented `fail`**, so it printed
  "8/8 clean" while a check had visibly failed. Fixed — a harness that cannot fail
  is worse than no harness.

## Files

| File | Purpose |
|---|---|
| `run-sandbox.mjs` | Scenario harness. Reset → act → assert. |
| `run-daemon-test.mjs` | Starts the real daemon, drives a real PowerShell session, asserts the output. |
| `emit.ps1` | Emits realistic failures; `-Residual` emits an error no rule matches. |
| `project/` | The broken project. Recreated by every reset. |
