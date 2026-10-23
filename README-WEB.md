# Watch Dogs Local Control Center

A local-first browser interface for the existing Watch Dogs Node.js project. The gateway binds only to `127.0.0.1` and does not expose a remote relay.

## Requirements

- Windows is the target environment.
- Node.js 20.11 or newer (matching the existing project requirement).
- Existing Watch Dogs dependencies installed with `npm ci`.

## Run

From the repository root in PowerShell:

```powershell
node src/agent/web-gateway.mjs
```

Open the exact URL printed by the gateway, then paste the one-time pairing code printed in that same terminal. Keep the pairing code private. The code is generated for each gateway process and is not stored in the browser.

Optional port override:

```powershell
$env:WD_WEB_PORT = "4317"
node src/agent/web-gateway.mjs
```

The gateway serves the frontend, requires an authenticated local session for API access, and exposes heartbeat/configuration/log snapshot data. It does not start or replace the watchdog daemon; start the existing daemon separately with the established `wd start` command.

## Current implementation boundary

This is the first secure gateway/UI slice, not the completed repair console:

- Real data: gateway health, configured capture layers, daemon heartbeat, current autonomy setting, and a bounded tail of the daemon log.
- Event stream: authenticated Server-Sent Events connection with keepalives; current snapshot polling remains the fallback.
- Not yet connected: live Watcher finding events, complete session registry, repair proposal lifecycle, browser-triggered action execution, verification details, rollback controls, and graph data.
- Mutating repair endpoints deliberately return `501 repair_bridge_not_implemented`. Do not remove this guard until an in-process coordinator is connected to the existing guarded action and verification modules and integration tests cover the complete flow.

## Security notes

- Binds to IPv4 loopback only.
- Uses a one-time pairing code and HttpOnly, SameSite session cookie.
- Rejects unexpected browser origins and sets a restrictive Content Security Policy.
- Does not accept arbitrary commands from the browser.
- Does not elevate privileges.
- The gateway and watchdog daemon are separate processes in this first slice; no duplicate watchdog daemon is started.

This initial implementation uses Node's built-in HTTP server and browser APIs to avoid introducing runtime dependencies before the integration contract stabilizes. A TypeScript/React frontend can be introduced later without changing the versioned API contract.
