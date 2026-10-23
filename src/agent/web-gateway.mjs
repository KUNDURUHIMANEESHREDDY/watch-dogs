import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.mjs';
import { readHeartbeat } from '../core/heartbeat.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../web/', import.meta.url)));
const HOST = '127.0.0.1';
const PORT = Number(process.env.WD_WEB_PORT || 4317);
const MAX_BODY = 8 * 1024;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const cfg = loadConfig();
const sessions = new Map();
const clients = new Set();
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
const parseCookies = (header = '') => Object.fromEntries(header.split(';').map(x => x.trim()).filter(Boolean).map(x => {
  const i = x.indexOf('=');
  return i < 0 ? [x, ''] : [x.slice(0, i), decodeURIComponent(x.slice(i + 1))];
}));
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolveBody(raw ? JSON.parse(raw) : {}); }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function isOriginAllowed(req) {
  const origin = req.headers.origin;
  return !origin || origin === `http://${HOST}:${PORT}`;
}
function authenticated(req) {
  const id = parseCookies(req.headers.cookie).wd_session;
  const expires = id && sessions.get(id);
  if (!expires || expires < Date.now()) {
    if (id) sessions.delete(id);
    return false;
  }
  sessions.set(id, Date.now() + SESSION_TTL);
  return true;
}
function readFindings(limit = 200) {
  const base = join(cfg.paths.data, 'findings.jsonl');
  const records = [];
  for (const path of [base + '.1', base]) {
    try {
      if (!existsSync(path)) continue;
      const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
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
      id: String(record.signature || `${record.ruleId}::${record.at || ''}`),
      ruleId: record.ruleId,
      title: record.title || record.ruleId,
      severity: record.severity || 'unknown',
      confidence: record.confidence || 'unknown',
      evidence: record.evidence,
      at: record.at || null,
      shell: record.shell || null,
      cwd: record.cwd || null,
      sessionId: record.sessionId || null,
      advisor: record.advisor || null,
      applied: record.applied || null,
      requiresHuman: Boolean(record.advisor?.requiresHuman),
      suppressed: record.suppressed || null
    }));
}
function snapshot() {
  const heartbeat = readHeartbeat(cfg.paths.data);
  let logs = [];
  try {
    const file = join(cfg.paths.data, 'daemon.log');
    if (existsSync(file)) logs = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-80).map((line, i) => ({ id: i, line }));
  } catch {}
  let dataFiles = [];
  try { dataFiles = readdirSync(cfg.paths.data).slice(0, 100); } catch {}
  const findings = readFindings();
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
    capabilities: {
      health: true, snapshot: true, eventStream: true,
      findingsSnapshot: true,
      liveFindingEvents: false,
      repairExecution: false,
      note: 'The gateway exposes real health, heartbeat, daemon logs, and persisted findings. Live finding events and repair execution are not wired and are not simulated.'
    }
  };
}
function publish(type, data) {
  const event = { protocol: 'watchdogs.local.v1', event_id: randomBytes(12).toString('hex'), type, timestamp: new Date().toISOString(), data };
  for (const res of clients) {
    try { res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`); } catch { clients.delete(res); }
  }
}
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
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
      res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-store', Connection:'keep-alive', 'X-Accel-Buffering':'no' });
      res.write(`event: connected\ndata: ${JSON.stringify({ protocol:'watchdogs.local.v1', type:'connected', timestamp:new Date().toISOString() })}\n\n`);
      clients.add(res);
      const heartbeat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
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
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const target = resolve(ROOT, `.${requested}`);
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return json(res, 403, { error:'path_not_allowed' });
  try {
    if (!existsSync(target) || !statSync(target).isFile()) return json(res, 404, { error:'not_found' });
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    res.end(readFileSync(target));
  } catch { json(res, 404, { error:'not_found' }); }
});
server.listen(PORT, HOST, () => {
  console.log('\nWATCH DOGS LOCAL CONTROL CENTER');
  console.log(`URL: http://${HOST}:${PORT}`);
  console.log(`Pairing code (enter in browser; never share): ${pairingCode}`);
  console.log('Loopback-only listener. No remote access is enabled.');
});
server.on('error', err => { console.error('Gateway failed:', err.message); process.exitCode = 1; });
function shutdown() {
  for (const res of clients) { try { res.end(); } catch {} }
  clients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
