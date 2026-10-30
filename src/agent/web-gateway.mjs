import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { readJournal } from './journal-reader.mjs';
import { readBoundedLogTail } from './log-tail.mjs';
import { readBoundedJsonlLines } from './findings-reader.mjs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.mjs';
import { readHeartbeat } from '../core/heartbeat.mjs';
import { parseCookies } from './cookies.mjs';
import { createSessionStore } from './session-store.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../web/', import.meta.url)));
const HOST = '127.0.0.1';
const PORT = Number(process.env.WD_WEB_PORT || 4317);
const MAX_BODY = 8 * 1024;
const MAX_SSE_CLIENTS = 32;
const MAX_SSE_BUFFER_BYTES = 256 * 1024;
const MAX_SSE_EVENT_BYTES = 16 * 1024;
const MAX_SSE_HISTORY_EVENTS = 128;
const MAX_FINDING_EVIDENCE_BYTES = 4096;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const cfg = loadConfig();
const sessions = createSessionStore({ ttlMs: SESSION_TTL, maxSessions: 256 });
const clients = new Set();
const eventHistory = [];
const pairingCode = randomBytes(24).toString('base64url');

const json = (res, status, body, extra = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(JSON.stringify(body));
};
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      // Stop retaining bytes once the limit is crossed, but keep draining the
      // request so the handler can return a deterministic HTTP 413 response.
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', error => {
      if (!tooLarge) reject(error);
    });
  });
}
function isOriginAllowed(req) {
  const origin = req.headers.origin;
  return !origin || origin === `http://${HOST}:${PORT}`;
}
function authenticated(req) {
  const id = parseCookies(req.headers.cookie).wd_session;
  const expires = id && sessions.get(id);
  if (!expires || expires <= Date.now()) {
    if (id) sessions.delete(id);
    return false;
  }
  sessions.set(id, Date.now() + SESSION_TTL);
  return true;
}
function boundedText(value, maxBytes) {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : String(value);
  let result = '';
  let bytes = 0;
  // Iterate Unicode code points so a byte limit never splits a surrogate pair.
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function readFindings(limit = 200) {
  const base = join(cfg.paths.data, 'findings.jsonl');
  const records = [];
  for (const path of [base + '.1', base]) {
    try {
      if (!existsSync(path)) continue;
      const lines = readBoundedJsonlLines(path);
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          if (record && typeof record === 'object' && record.ruleId && record.evidence) records.push(record);
        } catch {
          // A partial final line is ignored; the next snapshot can read the next complete record.
        }
      }
    } catch {
      // Read-only observability must not prevent the health snapshot from working.
    }
  }
  // The watcher may persist the same signature more than once as advisor/applier
  // state changes. Keep the latest record for each signature rather than showing
  // duplicate incidents for each lifecycle update.
  const latest = new Map();
  for (const record of records) {
    const key = record.signature || `${record.ruleId}::${record.sessionId || ''}::${record.evidence}`;
    latest.set(key, record);
  }
  return [...latest.values()]
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
    .slice(-limit)
    .map(record => ({
      id: boundedText(record.signature || `${record.ruleId}::${record.at || ''}`, 256),
      ruleId: boundedText(record.ruleId, 128),
      title: boundedText(record.title || record.ruleId, 256),
      severity: boundedText(record.severity || 'unknown', 32),
      confidence: boundedText(record.confidence || 'unknown', 32),
      evidence: boundedText(record.evidence, MAX_FINDING_EVIDENCE_BYTES),
      evidenceTruncated: typeof record.evidence === 'string' && Buffer.byteLength(record.evidence, 'utf8') > MAX_FINDING_EVIDENCE_BYTES,
      at: boundedText(record.at, 64),
      shell: boundedText(record.shell, 128),
      cwd: boundedText(record.cwd, 1024),
      sessionId: boundedText(record.sessionId, 256),
      advisor: record.advisor ? { pending: Boolean(record.advisor.pending), verdict: boundedText(record.advisor.verdict, 64), requiresHuman: Boolean(record.advisor.requiresHuman), why: boundedText(record.advisor.why, 240), verification: record.advisor.verification ? { verdict: boundedText(record.advisor.verification.verdict || 'unknown', 64), evidence: boundedText(record.advisor.verification.evidence || 'unknown', 128), why: boundedText(record.advisor.verification.why, 240) } : null } : null,
      applied: record.applied ? { status: boundedText(record.applied.status || 'unknown', 64), summary: boundedText(record.applied.summary, 240) } : null,
      requiresHuman: Boolean(record.advisor?.requiresHuman),
      suppressed: typeof record.suppressed === 'string' ? boundedText(record.suppressed, 240) : record.suppressed ? '[suppressed]' : null
    }));
}
function snapshot() {
  const heartbeat = readHeartbeat(cfg.paths.data);
  let logs = [];
  try {
    const file = join(cfg.paths.data, 'daemon.log');
    if (existsSync(file)) logs = readBoundedLogTail(file).map((line, i) => ({ id: i, line }));
  } catch {}
  let dataFiles = [];
  try { dataFiles = readdirSync(cfg.paths.data).slice(0, 100); } catch {}
  const findings = readFindings();
  const verifications = findings.filter(record => record.advisor?.verification).map(record => ({ id: record.id, title: record.title, status: record.advisor.verification.evidence || record.advisor.verification.verdict, verdict: record.advisor.verification.verdict, evidence: record.advisor.verification.why || record.advisor.verification.evidence, at: record.at }));
  const journal = readJournal(cfg.paths.data, cfg.projectRoot);
  return {
    protocol: 'watchdogs.local.v1',
    generatedAt: new Date().toISOString(),
    agent: { state: 'ready', pid: process.pid, version: process.version, host: HOST, port: PORT },
    watchdog: {
      state: heartbeat.state,
      detail: heartbeat.detail,
      lastBeat: heartbeat.info?.lastBeat ?? null,
      daemonPid: heartbeat.info?.pid ?? null,
      projectRoot: heartbeat.info?.projectRoot ?? cfg.projectRoot,
      autonomy: cfg.autonomy,
      layers: cfg.capture?.layers ?? {},
      dataFiles
    },
    logs,
    findings,
    verifications,
    journal,
    capabilities: {
      health: true, snapshot: true, eventStream: true,
      findingsSnapshot: true,
      journalSnapshot: true,
      liveFindingEvents: true,
      repairExecution: false,
      note: 'The gateway streams newly persisted or updated finding records over the authenticated event stream. In-memory watcher events before persistence and browser-triggered repair execution are not connected.'
    }
  };
}
function writeSsePayload(res, payload) {
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (res.destroyed || res.writableEnded ||
      payloadBytes > MAX_SSE_EVENT_BYTES ||
      res.writableLength + payloadBytes > MAX_SSE_BUFFER_BYTES) {
    clients.delete(res);
    res.destroy();
    return false;
  }
  try {
    res.write(payload);
    if (res.writableLength > MAX_SSE_BUFFER_BYTES) {
      clients.delete(res);
      res.destroy();
      return false;
    }
    return true;
  } catch {
    clients.delete(res);
    res.destroy();
    return false;
  }
}

function publish(type, data) {
  let event = { protocol: 'watchdogs.local.v1', event_id: randomBytes(12).toString('hex'), type, timestamp: new Date().toISOString(), data };
  // Standard SSE IDs let EventSource send Last-Event-ID after a reconnect.
  let payload = `id: ${event.event_id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_SSE_EVENT_BYTES) {
    // A dropped oversized event is a replay gap: retaining the previous cursor
    // would make reconnect replay appear complete even though state was lost.
    // Publish and retain a small reset marker so live and reconnecting clients
    // refresh their authenticated snapshot instead of silently missing a finding.
    event = {
      protocol: 'watchdogs.local.v1',
      event_id: randomBytes(12).toString('hex'),
      type: 'reset',
      timestamp: new Date().toISOString(),
      data: { reason: 'event_too_large', snapshotRequired: true }
    };
    payload = `id: ${event.event_id}\nevent: reset\ndata: ${JSON.stringify(event)}\n\n`;
  }
  eventHistory.push({ id: event.event_id, payload });
  if (eventHistory.length > MAX_SSE_HISTORY_EVENTS) eventHistory.shift();
  for (const res of clients) {
    if (!writeSsePayload(res, payload)) clients.delete(res);
  }
}

function findingsFileState() {
  const base = join(cfg.paths.data, 'findings.jsonl');
  return [base + '.1', base].map(path => {
    try {
      const stat = statSync(path);
      return `${path}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${path}:missing`;
    }
  }).join('|');
}

// Seed from the current persisted snapshot so connecting clients receive changes,
// not a replay of every historical finding. The map is bounded by readFindings()
// to the latest 200 sanitized records.
let observedFindingsState = findingsFileState();
let knownFindingRecords = new Map(readFindings().map(record => [record.id, JSON.stringify(record)]));
const findingEventPoll = setInterval(() => {
  const nextState = findingsFileState();
  if (nextState === observedFindingsState) return;
  observedFindingsState = nextState;

  const current = readFindings();
  const nextRecords = new Map();
  for (const record of current) {
    const fingerprint = JSON.stringify(record);
    nextRecords.set(record.id, fingerprint);
    if (knownFindingRecords.get(record.id) !== fingerprint) publish('finding', record);
  }
  knownFindingRecords = nextRecords;
}, 1000);
findingEventPoll.unref?.();
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (!isOriginAllowed(req)) return json(res, 403, { error: 'origin_not_allowed' });
  if (req.method !== 'GET' && req.method !== 'HEAD' && url.pathname.startsWith('/api/') && !req.headers.origin) {
    // Non-browser local clients are still subject to session authentication.
  }
  if (req.method === 'POST' && url.pathname === '/api/session') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
    if (!safeEqual(body.pairingCode ?? '', pairingCode)) return json(res, 401, { error: 'invalid_pairing_code' });
    const id = randomBytes(32).toString('base64url');
    sessions.set(id, Date.now() + SESSION_TTL);
    return json(res, 200, { ok: true, expiresInSeconds: SESSION_TTL / 1000 }, { 'Set-Cookie': `wd_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}` });
  }
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'POST' && !req.headers.origin) return json(res, 403, { error: 'origin_required' });
    if (!authenticated(req)) return json(res, 401, { error: 'authentication_required' });
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, agentPid: process.pid, timestamp: new Date().toISOString() });
    if (req.method === 'GET' && url.pathname === '/api/snapshot') return json(res, 200, snapshot());
    if (req.method === 'GET' && url.pathname === '/api/events') {
      // A local dashboard can reconnect repeatedly; bound open streams so a
      // stale tab or local client cannot retain unbounded sockets and timers.
      if (clients.size >= MAX_SSE_CLIENTS) {
        return json(res, 503, { error: 'event_stream_capacity_reached' }, { 'Retry-After': '5' });
      }
      res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-store', Connection:'keep-alive', 'X-Accel-Buffering':'no' });
      res.write(`event: connected\ndata: ${JSON.stringify({ protocol:'watchdogs.local.v1', type:'connected', timestamp:new Date().toISOString() })}\n\n`);
      clients.add(res);
      const keepalive = ': keepalive\n\n';
      const cleanup = () => {
        clearInterval(heartbeat);
        clients.delete(res);
      };
      const heartbeat = setInterval(() => {
        // Bound heartbeat writes too: a peer that never reads can otherwise
        // accumulate keepalive bytes even when no findings are published.
        if (res.destroyed || res.writableEnded ||
            res.writableLength + Buffer.byteLength(keepalive, 'utf8') > MAX_SSE_BUFFER_BYTES) {
          cleanup();
          res.destroy();
          return;
        }
        try {
          res.write(keepalive);
          if (res.writableLength > MAX_SSE_BUFFER_BYTES) {
            cleanup();
            res.destroy();
          }
        } catch {
          cleanup();
          res.destroy();
        }
      }, 15000);
      // IncomingMessage 'close' fires when the request body completes, which
      // is immediately for GET. The response close event tracks the lifetime
      // of the actual SSE stream and must own cleanup instead.
      res.once('close', cleanup);
      res.once('error', cleanup);
      req.once('aborted', cleanup);

      // Replay only events after the last ID acknowledged by EventSource.
      // If the bounded ring no longer contains that ID, request a fresh
      // authenticated snapshot instead of silently dropping state changes.
      const lastEventId = req.headers['last-event-id'];
      if (typeof lastEventId === 'string') {
        const index = /^[a-f0-9]{24}$/.test(lastEventId)
          ? eventHistory.findIndex(item => item.id === lastEventId)
          : -1;
        if (index < 0) {
          const reset = {
            protocol: 'watchdogs.local.v1',
            type: 'reset',
            timestamp: new Date().toISOString(),
            data: { reason: 'event_history_unavailable', snapshotRequired: true }
          };
          if (!writeSsePayload(res, `event: reset\ndata: ${JSON.stringify(reset)}\n\n`)) cleanup();
        } else {
          for (const item of eventHistory.slice(index + 1)) {
            if (!writeSsePayload(res, item.payload)) {
              cleanup();
              break;
            }
          }
        }
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/session/logout') {
      const id = parseCookies(req.headers.cookie).wd_session;
      if (id) sessions.delete(id);
      return json(res, 200, { ok: true }, { 'Set-Cookie':'wd_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/repairs/')) {
      return json(res, 501, { error:'repair_bridge_not_implemented', message:'No repair action was executed. The guarded runtime bridge must be implemented and tested before web-triggered mutations are enabled.' });
    }
    return json(res, 404, { error:'not_found' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error:'method_not_allowed' });
  let requested;
  try {
    requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  } catch {
    // Malformed percent-encoding is a client path error, not a reason to let
    // an async request handler reject outside the HTTP error boundary.
    return json(res, 404, { error: 'not_found' });
  }
  const target = resolve(ROOT, `.${requested}`);
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return json(res, 403, { error:'path_not_allowed' });
  try {
    if (!existsSync(target) || !statSync(target).isFile()) return json(res, 404, { error:'not_found' });
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    res.end(readFileSync(target));
  } catch { json(res, 404, { error:'not_found' }); }
});
// Bound slow headers and bodies: oversized requests are drained to return 413,
// but a client must not be able to hold the local gateway open indefinitely.
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(PORT, HOST, () => {
  console.log('\nWATCH DOGS LOCAL CONTROL CENTER');
  console.log(`URL: http://${HOST}:${PORT}`);
  console.log(`Pairing code (enter in browser; never share): ${pairingCode}`);
  console.log('Loopback-only listener. No remote access is enabled.');
});
server.on('error', err => { console.error('Gateway failed:', err.message); process.exitCode = 1; });
function shutdown() {
  clearInterval(findingEventPoll);
  for (const res of clients) { try { res.end(); } catch {} }
  clients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
