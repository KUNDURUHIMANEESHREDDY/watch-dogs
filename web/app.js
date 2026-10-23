const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const state = {
  snapshot: null,
  eventSource: null,
  pollTimer: null,
  freshnessTimer: null,
  lastSuccessAt: 0,
  selectedResource: null,
  selectedInspectorTab: 'overview',
  view: 'monitor',
  graphScale: 1,
  activityCollapsed: false,
  inspectorCollapsed: false,
  notice: '',
  lastError: ''
};
const viewMeta = {
  monitor: ['System monitor.', 'A live view of what the local watchdog can actually observe.', 'System graph'],
  graph: ['System graph.', 'Explore observed resources and their reported relationships.', 'Observed resource graph'],
  incidents: ['Incidents.', 'Evidence-backed findings and their affected resources.', 'Incident queue'],
  repairs: ['Repair review.', 'Review proposals before any guarded action is authorized.', 'Repair proposals'],
  verification: ['Verification.', 'Review actual check results and their evidence.', 'Verification records'],
  history: ['Activity history.', 'Inspect timestamped local daemon output and connection changes.', 'Event history'],
  settings: ['Agent details.', 'Connection, coverage, protocol, and integration capability information.', 'Runtime details']
};
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function showApp() { $('pair-screen').classList.add('hidden'); $('app').classList.remove('hidden'); }
function api(path, options = {}) {
  return fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: { ...(options.headers || {}), ...(options.body ? {'Content-Type':'application/json'} : {}) }
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      disconnect();
      throw new Error('Session expired. Pair again using the code printed by the gateway.');
    }
    if (!response.ok) throw new Error(data.message || data.error || `Request failed (${response.status})`);
    return data;
  });
}
function disconnect() {
  if (state.eventSource) state.eventSource.close();
  clearInterval(state.pollTimer);
  clearInterval(state.freshnessTimer);
  state.eventSource = null;
  state.snapshot = null;
  state.lastSuccessAt = 0;
  $('app').classList.add('hidden');
  $('pair-screen').classList.remove('hidden');
  $('footer-state').textContent = 'NO SESSION';
}
$('pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('pair-error').textContent = '';
  const pairingCode = $('pair-code').value.trim();
  try {
    await api('/api/session', { method:'POST', body:JSON.stringify({ pairingCode }) });
    $('pair-code').value = '';
    showApp();
    await refreshSnapshot();
    connectEvents();
    state.pollTimer = setInterval(refreshSnapshot, 10000);
    state.freshnessTimer = setInterval(updateFreshness, 1000);
  } catch (error) {
    $('pair-error').textContent = error.message === 'invalid_pairing_code'
      ? 'Pairing code not accepted. Copy the current code from the gateway terminal.'
      : error.message;
  }
});
async function refreshSnapshot() {
  try {
    const snapshot = await api('/api/snapshot');
    state.snapshot = validateSnapshot(snapshot);
    state.lastSuccessAt = Date.now();
    state.lastError = '';
    renderSnapshot();
    $('footer-state').textContent = 'LOCAL SESSION ACTIVE';
  } catch (error) {
    state.lastError = error.message || 'Unable to reach local gateway.';
    $('footer-state').textContent = 'RECONNECTING';
    setConnection('disconnected');
    showNotice(`Connection interrupted. Retrying automatically. ${state.lastError}`);
    updateFreshness();
  }
}
function validateSnapshot(value) {
  if (!value || typeof value !== 'object' || value.protocol !== 'watchdogs.local.v1') {
    throw new Error('Unexpected gateway response. Expected watchdogs.local.v1.');
  }
  return value;
}
function setConnection(status) {
  const pill = $('connection-pill');
  pill.className = 'state-pill ' + (status === 'connected' ? 'state-good' : status === 'disconnected' ? 'state-bad' : 'state-pending');
  $('connection-label').textContent = status === 'connected' ? 'Gateway connected' : status === 'disconnected' ? 'Reconnecting' : 'Connecting';
}
function updateFreshness() {
  if (!state.lastSuccessAt) {
    $('freshness-label').textContent = state.lastError ? 'Last snapshot unavailable' : 'Waiting for first snapshot';
    return;
  }
  const age = Math.max(0, Math.floor((Date.now() - state.lastSuccessAt) / 1000));
  $('freshness-label').textContent = age < 5 ? 'Snapshot just refreshed' : `Snapshot ${age}s ago`;
  if (age > 25) {
    $('freshness-label').textContent = `STALE · Last snapshot ${age}s ago`;
    setConnection('disconnected');
  }
}
function showNotice(message) {
  state.notice = message;
  $('notice').textContent = message;
  $('notice').classList.remove('hidden');
}
function hideNotice() {
  state.notice = '';
  $('notice').textContent = '';
  $('notice').classList.add('hidden');
}
function formatTime(value) {
  if (!value) return 'Not reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function ageLabel(value) {
  if (!value) return 'No heartbeat timestamp';
  const timestamp = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Timestamp unavailable';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  return seconds < 2 ? 'Just now' : seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds/60)}m ${seconds%60}s ago`;
}
function heartbeatIsFresh(value) {
  if (!value) return false;
  const timestamp = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= 20000 && Date.now() >= timestamp - 5000;
}
function renderSnapshot() {
  const s = state.snapshot;
  const watchdog = s.watchdog || {};
  const daemonState = String(watchdog.state || 'unknown');
  const heartbeatFresh = heartbeatIsFresh(watchdog.lastBeat);
  $('metric-daemon').textContent = daemonState.replaceAll('-', ' ');
  $('metric-daemon-note').textContent = watchdog.detail || 'No daemon detail reported';
  $('metric-heartbeat').textContent = watchdog.lastBeat ? formatTime(watchdog.lastBeat) : 'No beat';
  $('metric-heartbeat-note').textContent = ageLabel(watchdog.lastBeat);
  $('metric-mode').textContent = watchdog.autonomy || 'Unknown';
  $('metric-pid').textContent = watchdog.daemonPid ?? 'Not running';
  $('metric-runtime').textContent = `Gateway PID ${s.agent?.pid ?? '—'} · ${s.agent?.version ?? 'Node'}`;
  $('last-updated')?.remove();
  if (daemonState === 'running' && heartbeatFresh) setConnection('connected');
  else if (daemonState === 'running' || watchdog.lastBeat) setConnection('pending');
  else setConnection('connected');
  const resources = getResources(s);
  $('graph-count').textContent = `${resources.length} observed resource${resources.length === 1 ? '' : 's'}`;
  $('graph-source').textContent = resources.length ? 'Source: local runtime snapshot' : 'Relationship data not exposed by gateway';
  const capabilities = s.capabilities || {};
  if (!capabilities.liveFindingEvents || !capabilities.repairExecution) {
    showNotice(capabilities.note || 'Some capabilities are not wired into the local gateway. Unavailable actions remain disabled; no demo findings or repairs are generated.');
  } else if (state.lastError) showNotice(state.lastError);
  else hideNotice();
  renderGraph();
  renderActivity();
  if (state.selectedResource) renderInspector(state.selectedResource);
  if (state.view !== 'monitor' && state.view !== 'graph') renderDetail(state.view);
}
function getResources(snapshot) {
  const list = snapshot?.resources || snapshot?.watchdog?.resources || snapshot?.graph?.nodes || [];
  return Array.isArray(list) ? list.filter(item => item && typeof item === 'object') : [];
}
function getEdges(snapshot) {
  const list = snapshot?.relationships || snapshot?.watchdog?.relationships || snapshot?.graph?.edges || [];
  return Array.isArray(list) ? list.filter(item => item && typeof item === 'object') : [];
}
function resourceId(resource, index) { return String(resource.id ?? resource.resourceId ?? resource.pid ?? resource.name ?? `resource-${index}`); }
function resourceLabel(resource, index) { return String(resource.label ?? resource.name ?? resource.command ?? resource.path ?? resource.type ?? `Resource ${index+1}`); }
function resourceType(resource) { return String(resource.type ?? resource.kind ?? 'resource').toLowerCase(); }
function resourceStatus(resource) { return String(resource.status ?? resource.state ?? 'unknown').toLowerCase(); }
function statusClass(status) {
  if (['healthy','running','ok','ready','active','connected','passed'].includes(status)) return 'healthy';
  if (['warning','degraded','stale','pending'].includes(status)) return 'warning';
  if (['critical','error','failed','dead','crashed','stopped'].includes(status)) return 'critical';
  return 'unknown';
}
function svgEl(name, attrs = {}) {
  const el = document.createElementNS(NS, name);
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, String(value)));
  return el;
}
function renderGraph() {
  const all = getResources(state.snapshot);
  const filter = $('type-filter').value;
  const query = $('global-search').value.trim().toLowerCase();
  const nodes = all.filter((resource, index) => {
    const type = resourceType(resource);
    const matchesType = filter === 'all' || type.includes(filter);
    const matchesQuery = !query || [resourceLabel(resource,index), resourceId(resource,index), type, resourceStatus(resource)].join(' ').toLowerCase().includes(query);
    return matchesType && matchesQuery;
  });
  const svg = $('graph-svg');
  svg.replaceChildren();
  if (!nodes.length) {
    svg.classList.add('hidden');
    $('graph-empty').classList.remove('hidden');
    $('graph-legend').classList.add('hidden');
    $('graph-empty-title').textContent = all.length ? 'No resources match these filters' : 'Waiting for observed resources';
    $('graph-empty-copy').textContent = all.length
      ? 'Try another resource type or clear the search. The graph uses only records returned by the local runtime.'
      : 'The local gateway does not expose resource relationships yet. The graph will populate only from real runtime data—no synthetic topology.';
    $('graph-count').textContent = all.length ? `0 shown · ${all.length} observed` : '0 observed resources';
    return;
  }
  $('graph-empty').classList.add('hidden');
  $('graph-legend').classList.remove('hidden');
  svg.classList.remove('hidden');
  const width = Math.max(500, $('graph-stage').clientWidth || 700);
  const height = Math.max(300, $('graph-stage').clientHeight || 360);
  const viewWidth = width / state.graphScale;\n  const viewHeight = height / state.graphScale;\n  svg.setAttribute('viewBox', `${(width-viewWidth)/2} ${(height-viewHeight)/2} ${viewWidth} ${viewHeight}`);
  svg.setAttribute('preserveAspectRatio','xMidYMid meet');
  const positions = new Map();
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const rows = Math.ceil(nodes.length / columns);
  const cellW = width / columns;
  const cellH = height / rows;
  nodes.forEach((node,index) => {
    positions.set(resourceId(node,all.indexOf(node)), {
      x: cellW * (index % columns + .5),
      y: cellH * (Math.floor(index/columns) + .5)
    });
  });
  getEdges(state.snapshot).forEach(edge => {
    const source = String(edge.source ?? edge.from ?? edge.sourceId ?? '');
    const target = String(edge.target ?? edge.to ?? edge.targetId ?? '');
    const a = positions.get(source), b = positions.get(target);
    if (!a || !b) return;
    svg.append(svgEl('path',{d:`M ${a.x} ${a.y} L ${b.x} ${b.y}`,class:'graph-edge'}));
    if (edge.type || edge.label) {
      const label = svgEl('text',{x:(a.x+b.x)/2,y:(a.y+b.y)/2-6,'text-anchor':'middle',class:'graph-edge-label'});
      label.textContent = String(edge.label ?? edge.type);
      svg.append(label);
    }
  });
  nodes.forEach((node,index) => {
    const id = resourceId(node,all.indexOf(node));
    const pos = positions.get(id);
    const group = svgEl('g',{transform:`translate(${pos.x-74},${pos.y-29})`,class:'resource-node' + (state.selectedResource?.id === id ? ' selected' : ''),tabindex:0,role:'button','aria-label':`Select ${resourceLabel(node,index)}`});
    group.append(svgEl('rect',{x:0,y:0,width:148,height:58,rx:9,class:'node-card'}));
    const dotColor = statusClass(resourceStatus(node)) === 'healthy' ? '#43965c' : statusClass(resourceStatus(node)) === 'warning' ? '#c88b32' : statusClass(resourceStatus(node)) === 'critical' ? '#c44e48' : '#a6b0a7';
    group.append(svgEl('circle',{cx:13,cy:15,r:4,fill:dotColor,class:'node-status'}));
    const title = svgEl('text',{x:24,y:19,class:'node-title'});
    title.textContent = resourceLabel(node,index).slice(0,18);
    group.append(title);
    const subtitle = svgEl('text',{x:12,y:41,class:'node-subtitle'});
    subtitle.textContent = `${resourceType(node).toUpperCase()} · ${resourceStatus(node).toUpperCase()}`.slice(0,24);
    group.append(subtitle);
    const select = () => { state.selectedResource = { ...node, id }; state.selectedInspectorTab='overview'; renderInspector(state.selectedResource); renderGraph(); };
    group.addEventListener('click',select);
    group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select();}});
    svg.append(group);
  });
  $('graph-count').textContent = `${nodes.length} shown · ${all.length} observed`;
  $('graph-source').textContent = getEdges(state.snapshot).length ? `${getEdges(state.snapshot).length} reported relationships` : 'No relationships reported';
}
function renderInspector(resource) {
  if (!resource) return;
  const content = $('inspector-content');
  const tabs = ['overview','events','configuration'];
  const tab = state.selectedInspectorTab;
  const rows = tab === 'overview'
    ? [['RESOURCE',resourceLabel(resource,0)],['TYPE',resourceType(resource)],['STATE',resourceStatus(resource)],['IDENTIFIER',resource.id ?? resource.resourceId ?? resource.pid ?? 'Not reported'],['LAST OBSERVED',resource.lastObserved ?? resource.updatedAt ?? 'Not reported']]
    : tab === 'events'
      ? [['EVENT HISTORY','Resource-specific events are not exposed by the current gateway.'],['SOURCE','Authenticated local snapshot']]
      : [['CONFIGURATION','Configuration is read-only in this view.'],['PROVENANCE',resource.source ?? 'Runtime source not reported']];
  content.innerHTML = `<div class="inspector-selected"><div class="inspector-tabs">${tabs.map(item=>`<button type="button" data-inspector-tab="${item}" class="${item===tab?'active':''}">${item[0].toUpperCase()+item.slice(1)}</button>`).join('')}</div><div class="inspector-property"><label>SELECTED RESOURCE</label><strong>${esc(resourceLabel(resource,0))}</strong></div>${rows.map(([label,value])=>`<div class="inspector-property"><label>${esc(label)}</label><strong>${esc(value)}</strong></div>`).join('')}<div class="inspector-property"><label>AVAILABLE ACTIONS</label><strong>Read-only inspection</strong></div><button type="button" class="subtle-button inspector-focus" id="focus-resource">Focus in graph</button></div>`;
  content.querySelectorAll('[data-inspector-tab]').forEach(button=>button.addEventListener('click',()=>{state.selectedInspectorTab=button.dataset.inspectorTab;renderInspector(resource);}));
  $('focus-resource')?.addEventListener('click',()=>renderGraph());
}
function renderActivity() {
  const logs = state.snapshot?.logs || [];
  const query = $('activity-search').value.trim().toLowerCase();
  const filtered = logs.filter(item => String(item.line ?? '').toLowerCase().includes(query));
  $('activity-count').textContent = `${filtered.length} line${filtered.length===1?'':'s'}`;
  $('activity-list').innerHTML = filtered.length
    ? filtered.slice(-100).map(item=>`<div class="activity-line"><span class="activity-time">${esc(item.timestamp ? formatTime(item.timestamp) : 'LOCAL LOG')}</span><span class="activity-text">${esc(item.line ?? JSON.stringify(item))}</span></div>`).join('')
    : `<div class="activity-empty">${logs.length?'No log lines match this filter.':'No daemon log lines reported. Start the existing watchdog daemon to populate this panel.'}</div>`;
}
function renderDetail(view) {
  const s = state.snapshot || {};
  const caps = s.capabilities || {};
  const resources = getResources(s);
  const findings = Array.isArray(s.findings) ? s.findings : Array.isArray(s.watchdog?.findings) ? s.watchdog.findings : [];
  const proposals = Array.isArray(s.repairProposals) ? s.repairProposals : [];
  const verifications = Array.isArray(s.verifications) ? s.verifications : [];
  const logs = s.logs || [];
  const meta = viewMeta[view] || viewMeta.monitor;
  $('view-name').textContent = view === 'settings' ? 'Agent details' : meta[0].replace('.','');
  $('page-title').innerHTML = `${esc(meta[0].replace('.',''))}<span class="title-period">.</span>`;
  $('page-subtitle').textContent = meta[1];
  $('primary-title').textContent = meta[2];
  $('monitoring-summary').classList.toggle('hidden', !['monitor','graph'].includes(view));
  $('workspace').classList.toggle('hidden', !['monitor','graph'].includes(view));
  $('detail-view').classList.toggle('hidden', ['monitor','graph'].includes(view));
  if (['monitor','graph'].includes(view)) return;
  const capabilityText = caps.note || 'The current gateway does not expose this workflow yet. The interface keeps unsupported operations unavailable.';
  let body = '';
  if (view === 'incidents') {
    body = `<div class="detail-heading"><div><span class="section-kicker">FINDINGS / EVIDENCE</span><h2>Incident queue</h2><p>${findings.length ? 'Findings returned by the runtime snapshot.' : 'No findings are exposed by the current gateway.'}</p></div><span class="detail-state">${findings.length} records</span></div>`;
    body += findings.length ? `<div class="detail-grid">${findings.map((f,i)=>`<article class="detail-card"><h3>${esc(f.title ?? f.message ?? f.rule ?? `Finding ${i+1}`)}</h3><p>${esc(f.severity ?? 'Severity not reported')} · ${esc(f.state ?? 'State not reported')}</p><p>${esc(f.evidence ?? f.line ?? f.detail ?? 'No evidence field returned.')}</p></article>`).join('')}</div>` : emptyCard('Incident bridge unavailable',capabilityText,'The UI will display findings only after the runtime exposes the actual finding model.');
  } else if (view === 'repairs') {
    body = `<div class="detail-heading"><div><span class="section-kicker">GUARDED ACTIONS / REVIEW</span><h2>Repair proposals</h2><p>Every proposed change must be reviewed against the existing safety rails.</p></div><span class="detail-state">${caps.repairExecution ? proposals.length+' proposals' : 'Execution disabled'}</span></div>`;
    body += proposals.length ? `<div class="detail-grid">${proposals.map((p,i)=>`<article class="detail-card"><h3>${esc(p.title ?? p.kind ?? `Proposal ${i+1}`)}</h3><p>${esc(p.reason ?? 'Reason not supplied')}</p><p>Target: ${esc(p.target ?? p.path ?? 'Not reported')}</p><button class="button primary" disabled title="Approval bridge is not implemented">Approve proposal unavailable</button></article>`).join('')}</div>` : emptyCard('No actionable proposals available',capabilityText,'Approval and execution controls remain disabled until the guarded runtime bridge is implemented and tested.');
  } else if (view === 'verification') {
    body = `<div class="detail-heading"><div><span class="section-kicker">POST-ACTION CHECKS / EVIDENCE</span><h2>Verification records</h2><p>Verification must report what checks actually proved—not assume a repair succeeded.</p></div><span class="detail-state">${verifications.length} records</span></div>`;
    body += verifications.length ? `<div class="detail-grid">${verifications.map((v,i)=>`<article class="detail-card"><h3>${esc(v.title ?? v.name ?? `Check ${i+1}`)}</h3><p>Result: ${esc(v.status ?? v.verdict ?? 'Not reported')}</p><p>${esc(v.evidence ?? v.detail ?? 'No evidence returned.')}</p></article>`).join('')}</div>` : emptyCard('Verification data not exposed',capabilityText,'No success state is inferred from approval or from the absence of an error.');
  } else if (view === 'history') {
    body = `<div class="detail-heading"><div><span class="section-kicker">LOCAL EVENT RECORD</span><h2>Activity history</h2><p>Timestamped lines returned by the authenticated local snapshot.</p></div><span class="detail-state">${logs.length} log lines</span></div>`;
    body += logs.length ? `<div class="detail-card history-records">${logs.slice(-100).map(item=>`<div class="activity-line"><span class="activity-time">${esc(item.timestamp ? formatTime(item.timestamp) : 'LOCAL LOG')}</span><span class="activity-text">${esc(item.line ?? '')}</span></div>`).join('')}</div>` : emptyCard('No local log lines', 'The gateway did not return any daemon log lines.','Start the existing watchdog daemon and refresh the snapshot.');
  } else if (view === 'settings') {
    const layers = s.watchdog?.layers || {};
    body = `<div class="detail-heading"><div><span class="section-kicker">CONNECTION / COVERAGE / CAPABILITIES</span><h2>Agent details</h2><p>Read-only runtime facts. Configuration changes are not offered by this gateway.</p></div><span class="detail-state">${esc(s.protocol || 'Protocol unavailable')}</span></div><div class="detail-grid">${[['Gateway',`${s.agent?.host ?? '127.0.0.1'}:${s.agent?.port ?? '—'}`],['Gateway PID',s.agent?.pid ?? 'Not reported'],['Node runtime',s.agent?.version ?? 'Not reported'],['Project root',s.watchdog?.projectRoot ?? 'Not reported'],['Autonomy mode',s.watchdog?.autonomy ?? 'Not reported'],['Heartbeat state',s.watchdog?.state ?? 'Unknown']].map(([label,value])=>`<article class="detail-card"><h3>${esc(label)}</h3><p>${esc(value)}</p></article>`).join('')}${[['Shell transcripts',layers.shell],['Process watcher',layers.process],['ConPTY capture',layers.conpty]].map(([label,value])=>`<article class="detail-card"><h3>${esc(label)}</h3><p>${value===true?'Enabled':value===false?'Disabled / unavailable':'Not reported'}</p></article>`).join('')}${[['Live finding events',caps.liveFindingEvents],['Repair execution',caps.repairExecution],['Event stream',caps.eventStream],['Snapshot API',caps.snapshot]].map(([label,value])=>`<article class="detail-card"><h3>${esc(label)}</h3><p>${value===true?'Available':value===false?'Not wired':'Not reported'}</p></article>`).join('')}</div>`;
  }
  $('detail-view').innerHTML = body;
}
function emptyCard(title,description,nextStep) {
  return `<div class="detail-callout"><span aria-hidden="true">!</span><div><strong>${esc(title)}</strong>${esc(description)}<br>${esc(nextStep)}</div></div>`;
}
function setView(view) {
  state.view = view;
  document.querySelectorAll('.rail-item[data-view]').forEach(button => {
    const active = button.dataset.view === view || (view === 'settings' && button.id === 'settings-button');
    button.classList.toggle('active',active);
    if (button.hasAttribute('aria-label')) button.setAttribute('aria-current',active?'page':'false');
  });
  renderDetail(view);
  if (view === 'graph') renderGraph();
}
function connectEvents() {
  if (state.eventSource) state.eventSource.close();
  const source = new EventSource('/api/events');
  state.eventSource = source;
  source.addEventListener('connected', () => {
    $('activity-subtitle').textContent = 'Event stream connected · detailed findings are not yet bridged';
  });
  source.onerror = () => {
    $('activity-subtitle').textContent = 'Event stream reconnecting · snapshot polling continues';
  };
  source.onmessage = () => refreshSnapshot();
}
document.querySelectorAll('.rail-item[data-view]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
$('settings-button').addEventListener('click',()=>setView('settings'));
$('refresh').addEventListener('click',refreshSnapshot);
$('type-filter').addEventListener('change',renderGraph);
$('global-search').addEventListener('input',()=>{renderGraph();renderActivity();});
$('activity-search').addEventListener('input',renderActivity);
$('clear-filter').addEventListener('click',()=>{$('activity-search').value='';$('global-search').value='';renderActivity();renderGraph();});
$('toggle-activity').addEventListener('click',()=>{$('activity-tray').classList.toggle('collapsed');state.activityCollapsed=$('activity-tray').classList.contains('collapsed');});
$('collapse-activity').addEventListener('click',()=>{$('activity-tray').classList.toggle('collapsed');state.activityCollapsed=$('activity-tray').classList.contains('collapsed');});
$('close-inspector').addEventListener('click',()=>{state.inspectorCollapsed=!state.inspectorCollapsed;$('workspace').classList.toggle('single-panel',state.inspectorCollapsed);$('close-inspector').textContent=state.inspectorCollapsed?'⇤':'⇥';$('close-inspector').setAttribute('aria-label',state.inspectorCollapsed?'Expand inspector':'Collapse inspector');});
$('fit-graph').addEventListener('click',()=>{state.graphScale=1;renderGraph();});
$('zoom-in').addEventListener('click',()=>{state.graphScale=Math.min(1.5,state.graphScale+.1);renderGraph();});
$('zoom-out').addEventListener('click',()=>{state.graphScale=Math.max(.7,state.graphScale-.1);renderGraph();});
document.addEventListener('keydown',event=>{
  if ((event.ctrlKey||event.metaKey) && event.key.toLowerCase()==='k') {event.preventDefault();$('global-search').focus();}
  if (event.key==='Escape' && document.activeElement===$('global-search')) {$('global-search').value='';$('global-search').blur();renderGraph();renderActivity();}
});
$('logout').addEventListener('click',async()=>{try{await api('/api/session/logout',{method:'POST',body:'{}'});}catch{}disconnect();});
window.addEventListener('resize',()=>{if(state.snapshot)renderGraph();});
setConnection('pending');
