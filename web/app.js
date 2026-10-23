const $ = (id) => document.getElementById(id);
const state = { snapshot: null, eventSource: null, timer: null };
const titles = {
  overview: ['Control center.', 'A truthful view of what your local watchdog can currently observe.', 'Runtime status'],
  activity: ['Live activity.', 'Local daemon output and event-stream connectivity.', 'Recent runtime output'],
  findings: ['Findings.', 'Findings become available when the runtime bridge exposes its live finding model.', 'Finding integration'],
  repairs: ['Repair studio.', 'Review and authorize bounded repair proposals through the guarded engine.', 'Repair execution is not enabled'],
  graph: ['System graph.', 'A relationship view will use actual process and dependency data when exposed by the agent.', 'Graph integration status'],
  verification: ['Verification.', 'Evidence from real verification runs—not optimistic success labels.', 'Verification integration']
};
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function showApp() { $('pair-screen').classList.add('hidden'); $('app').classList.remove('hidden'); }
async function api(path, options = {}) {
  const response = await fetch(path, { credentials:'same-origin', cache:'no-store', ...options, headers:{'Content-Type':'application/json', ...(options.headers || {})} });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { disconnect(); throw new Error('Session expired. Pair again using the code in your terminal.'); }
  if (!response.ok) throw new Error(data.message || data.error || `Request failed (${response.status})`);
  return data;
}
function disconnect() {
  if (state.eventSource) state.eventSource.close();
  clearInterval(state.timer);
  state.eventSource = null;
  state.snapshot = null;
  $('app').classList.add('hidden');
  $('pair-screen').classList.remove('hidden');
}
$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('pair-error').textContent = '';
  const code = $('pair-code').value.trim();
  try {
    await api('/api/session', { method:'POST', body:JSON.stringify({ pairingCode:code }) });
    $('pair-code').value = '';
    showApp();
    await refresh();
    connectEvents();
    state.timer = setInterval(refresh, 10000);
  } catch (err) { $('pair-error').textContent = err.message === 'invalid_pairing_code' ? 'Pairing code not accepted. Copy the current code from the terminal.' : err.message; }
});
async function refresh() {
  try {
    state.snapshot = await api('/api/snapshot');
    render(state.snapshot);
    $('connection-label').textContent = 'Agent connected';
    $('connection-dot').classList.add('good');
    $('footer-state').textContent = 'LOCAL SESSION ACTIVE';
  } catch (err) {
    $('connection-label').textContent = 'Connection lost';
    $('connection-dot').classList.remove('good');
    $('footer-state').textContent = 'RECONNECTING';
    $('notice').textContent = err.message;
    $('notice').classList.remove('hidden');
  }
}
function render(s) {
  const w = s.watchdog || {};
  const running = w.state === 'running';
  $('metric-daemon').textContent = w.state || 'unknown';
  $('metric-daemon-note').textContent = w.detail || 'No detail available';
  $('metric-heartbeat').textContent = w.lastBeat ? new Date(w.lastBeat).toLocaleTimeString() : 'No beat';
  $('metric-mode').textContent = w.autonomy || 'unknown';
  $('metric-pid').textContent = w.daemonPid ?? 'Not running';
  $('metric-runtime').textContent = `Gateway PID ${s.agent?.pid ?? '—'} · ${s.agent?.version ?? 'Node.js'}`;
  $('daemon-pill').className = 'status-pill ' + (running ? 'good' : 'bad');
  $('daemon-pill').innerHTML = '<i></i>' + esc(w.state || 'unknown').toUpperCase();
  $('last-updated').textContent = 'Updated ' + new Date(s.generatedAt).toLocaleTimeString();
  $('primary-content').innerHTML = `<div class="runtime-banner"><div class="runtime-icon">${running?'✓':'!'}</div><div><h3>${running?'Watchdog heartbeat is current':'Watchdog is not confirmed running'}</h3><p>${esc(w.detail || 'The local agent has not reported daemon state.')}</p><div class="runtime-tags"><span class="tag">GATEWAY ONLINE</span><span class="tag">${running?'DAEMON LIVE':'DAEMON UNCONFIRMED'}</span><span class="tag">LOCAL ONLY</span></div></div></div>`;
  const layers = w.layers || {};
  const layerNames = [['shell','Shell transcripts'],['process','Process watcher'],['conpty','ConPTY layer']];
  $('layers').innerHTML = layerNames.map(([key,label]) => {
    const val = layers[key];
    const on = val === true;
    return `<div class="layer-row"><span>${label}</span><span class="layer-state ${on?'':'off'}">${val === undefined?'NOT REPORTED':on?'ENABLED':'DISABLED / UNAVAILABLE'}</span></div>`;
  }).join('');
  const caps = s.capabilities || {};
  $('capabilities').innerHTML = [
    ['Authenticated local gateway',true],
    ['Heartbeat + log snapshot',caps.snapshot],
    ['Live finding event bridge',caps.liveFindingEvents],
    ['Guarded repair execution',caps.repairExecution]
  ].map(([label,on])=>`<div class="capability-row"><span>${label}</span><span class="${on?'available':''}">${on?'AVAILABLE':'NOT YET WIRED'}</span></div>`).join('');
  const logs = s.logs || [];
  $('logs').innerHTML = logs.length ? logs.slice(-60).map(x=>`<div class="log-line">${esc(x.line)}</div>`).join('') : '<div class="empty-state">No daemon log lines available yet. Start the existing watchdog daemon to populate this panel.</div>';
  if (!caps.liveFindingEvents || !caps.repairExecution) {
    $('notice').textContent = caps.note || 'Some integration modules are not connected yet. The interface deliberately labels unavailable capabilities instead of simulating data.';
    $('notice').classList.remove('hidden');
  } else $('notice').classList.add('hidden');
  const view = document.querySelector('.nav-item.active')?.dataset.view || 'overview';
  renderView(view);
}
function renderView(view) {
  const t = titles[view] || titles.overview;
  $('view-name').textContent = view.charAt(0).toUpperCase()+view.slice(1);
  $('page-title').innerHTML = esc(t[0]).replace('.', '<span>.</span>');
  $('page-subtitle').textContent = t[1];
  $('primary-title').textContent = t[2];
  if (view === 'overview') return;
  const s = state.snapshot || {};
  const messages = {
    activity: 'The gateway event stream is connected. Detailed live finding events will appear after the coordinator is wired into the existing Watcher event emitter.',
    findings: 'No fabricated findings are displayed. Next integration step: expose the existing Watcher finding collection through a read-only service interface.',
    repairs: 'Execution is disabled in this build. The existing guarded Applier, policy checks, and verification flow must be connected before the web UI can mutate files or run fixes.',
    graph: 'The graph renderer will consume observed process and dependency relationships. No synthetic network topology is presented as real system data.',
    verification: 'Verification evidence is not yet exposed through the gateway. Existing tests and journal data remain authoritative.'
  };
  $('primary-content').innerHTML = `<div class="runtime-banner"><div class="runtime-icon">i</div><div><h3>${esc(t[2])}</h3><p>${esc(messages[view] || 'No data available.')}</p><div class="runtime-tags"><span class="tag">SOURCE-DRIVEN</span><span class="tag">NO MOCK METRICS</span></div></div></div>`;
}
function connectEvents() {
  if (state.eventSource) state.eventSource.close();
  const es = new EventSource('/api/events');
  state.eventSource = es;
  es.addEventListener('connected', () => { $('connection-label').textContent = 'Agent connected'; });
  es.onerror = () => { $('connection-label').textContent = 'Restoring event stream…'; };
  es.onmessage = () => refresh();
}
document.querySelectorAll('.nav-item[data-view]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.nav-item[data-view]').forEach(b=>b.classList.toggle('active', b===button));
  renderView(button.dataset.view);
}));
$('refresh').addEventListener('click', refresh);
$('logs-refresh').addEventListener('click', refresh);
$('logout').addEventListener('click', async () => { try { await api('/api/session/logout',{method:'POST',body:'{}'}); } catch {} disconnect(); });
