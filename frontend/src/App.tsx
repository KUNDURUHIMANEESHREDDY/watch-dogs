import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { FormEvent } from 'react';
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2,
  CircleHelp, Clock3, Cpu, FileClock, GitBranch, LayoutDashboard, ListFilter,
  LockKeyhole, LogOut, Network, RefreshCw, Search, Settings2, ShieldCheck, Terminal,
  Wrench, X,
} from 'lucide-react';

type Finding = {
  id: string; ruleId?: string; title?: string; severity?: string; evidence?: string;
  at?: string | null; shell?: string | null; cwd?: string | null; requiresHuman?: boolean;
  advisor?: { verdict?: string | null; why?: string | null; verification?: { verdict?: string; evidence?: string; why?: string } | null } | null;
  applied?: { status?: string; summary?: string | null } | null;
};
type Snapshot = {
  watchdog?: { state?: string; detail?: string; lastBeat?: string | null; daemonPid?: number | null } | null;
  findings?: Finding[];
  findingsSnapshot?: boolean;
  journal?: Array<{ id: string; at?: string | null; outcome?: string; type?: string; target?: string | null; reason?: string | null }>;
  journalSnapshot?: boolean;
  [key: string]: unknown;
};
type View = 'Overview' | 'System graph' | 'Incidents' | 'Repair review' | 'Verification' | 'Activity history';

const navItems: { label: View; icon: typeof LayoutDashboard }[] = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'System graph', icon: Network },
  { label: 'Incidents', icon: AlertTriangle },
  { label: 'Repair review', icon: Wrench },
  { label: 'Verification', icon: ShieldCheck },
  { label: 'Activity history', icon: FileClock },
];

export function isPairRequiredError(error: unknown): boolean {
  return error instanceof Error && error.message === 'PAIR_REQUIRED';
}

export async function readSnapshot(): Promise<Snapshot> {
  const response = await fetch('/api/snapshot', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (response.status === 401) throw new Error('PAIR_REQUIRED');
  if (!response.ok) throw new Error(`Gateway returned HTTP ${response.status}`);
  return response.json() as Promise<Snapshot>;
}

function timeLabel(value?: string | null) {
  if (!value) return 'Time unavailable';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }).format(date);
}

export default function App() {
  const [view, setView] = useState<View>('Overview');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Finding | null>(null);
  const [pairCode, setPairCode] = useState('');
  const [pairError, setPairError] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [paired, setPaired] = useState(false);
  const [activityOpen, setActivityOpen] = useState(true);
  const queryClient = useQueryClient();

  const snapshotQuery = useQuery({
    queryKey: ['snapshot'],
    queryFn: readSnapshot,
    enabled: paired,
    refetchInterval: 4_000,
    // Authentication failures need a new pairing code, not three retries.
    // Transient gateway errors still get a small bounded retry budget.
    retry: (failureCount, error) => !isPairRequiredError(error) && failureCount < 2,
  });
  const snapshot = snapshotQuery.data;

  useEffect(() => {
    if (!paired || !snapshotQuery.isError || !isPairRequiredError(snapshotQuery.error)) return;
    setPairCode('');
    setPairError('Your local session expired. Enter the current one-time pairing code to reconnect.');
    setPaired(false);
    queryClient.removeQueries({ queryKey: ['snapshot'] });
  }, [paired, snapshotQuery.isError, snapshotQuery.error, queryClient]);
  const findings = useMemo(() => (snapshot?.findings ?? []).filter((finding) => {
    const text = [finding.title, finding.ruleId, finding.evidence, finding.shell, finding.cwd].join(' ').toLowerCase();
    return text.includes(query.toLowerCase());
  }).reverse(), [snapshot?.findings, query]);
  const incidents = findings.filter((finding) => !['resolved', 'verified', 'dismissed'].includes(String(finding.applied?.status ?? '').toLowerCase()));
  const journal = snapshot?.journal ?? [];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        document.getElementById('global-search')?.focus();
      }
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isConnecting) return;
    setIsConnecting(true);
    setPairError('');
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ pairingCode: pairCode.trim() }),
      });
      if (!response.ok) throw new Error('Pairing code was rejected. Copy the current code from the gateway terminal.');
      setPaired(true);
      setPairCode('');
    } catch (error) {
      setPairError(error instanceof Error ? error.message : 'Unable to connect to the local gateway.');
    } finally {
      setIsConnecting(false);
    }
  }

  async function disconnect() {
    try { await fetch('/api/session/logout', { method: 'POST', credentials: 'same-origin' }); } finally {
      setPaired(false);
      setSelected(null);
      queryClient.removeQueries({ queryKey: ['snapshot'] });
    }
  }

  const graphNodes: Node[] = useMemo(() => {
    const hb = snapshot?.watchdog;
    const nodes: Node[] = [{
      id: 'agent', position: { x: 280, y: 190 }, type: 'default',
      data: { label: 'Watch Dogs agent' }, className: 'graph-node graph-node-agent',
    }];
    if (hb && typeof hb === 'object') nodes.push({
      id: 'heartbeat', position: { x: 280, y: 35 }, data: { label: 'Agent heartbeat' },
      className: 'graph-node graph-node-good',
    });
    findings.slice(0, 5).forEach((finding, index) => nodes.push({
      id: finding.id, position: { x: 40 + index * 205, y: 370 },
      data: { label: finding.title || finding.ruleId || 'Finding' },
      className: 'graph-node graph-node-incident',
      style: { width: 170 },
    }));
    return nodes;
  }, [snapshot?.watchdog, findings]);
  const graphEdges: Edge[] = useMemo(() => [
    ...(snapshot?.watchdog ? [{ id: 'heartbeat-agent', source: 'heartbeat', target: 'agent', animated: true }] : []),
    ...findings.slice(0, 5).map((finding) => ({ id: `agent-${finding.id}`, source: 'agent', target: finding.id })),
  ], [snapshot?.watchdog, findings]);

  if (!paired) return (
    <main className="pair-screen">
      <section className="pair-card">
        <div className="brand-lockup"><span className="brand-mark">W</span><span><b>WATCH DOGS</b><small>LOCAL SYSTEM CONTROL</small></span></div>
        <div className="eyebrow">PRIVATE LOCAL SESSION</div>
        <h1>Connect your agent<span className="period">.</span></h1>
        <p className="muted">Pair this workspace with the local gateway. Your session stays on this machine.</p>
        <form className="pair-form" onSubmit={connect}>
          <label htmlFor="pair-code">One-time pairing code</label>
          <input id="pair-code" autoComplete="off" spellCheck={false} type="password" value={pairCode} onChange={(event) => setPairCode(event.target.value)} placeholder="Paste code from terminal" required />
          <button className="button button-primary" type="submit" disabled={isConnecting || !pairCode.trim()} aria-busy={isConnecting} aria-label="Connect securely">{isConnecting ? "Connecting…" : "Connect securely"} {!isConnecting && <ArrowUpRight size={16} />}</button>
          {isConnecting && <p className="muted" role="status" aria-live="polite">Connecting to the local gateway…</p>}
          {pairError && <p className="error" role="alert">{pairError}</p>}
        </form>
        <div className="security-note"><LockKeyhole size={15} /> Loopback only <span className="bullet">·</span> Local gateway session</div>
      </section>
    </main>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand-button" onClick={() => setView('Overview')} aria-label="Watch Dogs home"><span className="brand-mark">W</span></button>
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="nav-list" aria-label="Primary navigation">
          {navItems.map(({ label, icon: Icon }) => <button key={label} onClick={() => setView(label)} className={`nav-item ${view === label ? 'active' : ''}`}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{label === 'Incidents' && incidents.length > 0 && <em>{incidents.length}</em>}</button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="agent-card"><span className="agent-icon"><Cpu size={17} /></span><span><b>Local agent</b><small>{snapshotQuery.isError ? 'Connection lost' : snapshotQuery.isFetching ? 'Syncing snapshot' : 'Connected'}</small></span><span className={`status-dot ${snapshotQuery.isError ? 'offline' : 'online'}`} /></div>
          <button className="nav-item" onClick={() => setView('Activity history')}><Settings2 size={17} /><span>Settings & diagnostics</span></button>
          <button className="nav-item" onClick={disconnect}><LogOut size={17} /><span>Disconnect</span></button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>WORKSPACE</span><span className="slash">/</span><b>{view}</b></div>
          <div className="topbar-actions">
            <label className="search-box"><Search size={16} /><input id="global-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search findings and logs…" /><kbd>Ctrl K</kbd>{query && <button className="clear-search" onClick={() => setQuery('')} aria-label="Clear search"><X size={14} /></button>}</label>
            <span className="local-pill"><span className="status-dot online" /> LOCAL</span>
            <button className="icon-button" onClick={() => void snapshotQuery.refetch()} title="Refresh snapshot" aria-label="Refresh snapshot"><RefreshCw size={16} className={snapshotQuery.isFetching ? 'spin' : ''} /></button>
            <button className={`icon-button ${activityOpen ? 'selected' : ''}`} onClick={() => setActivityOpen(!activityOpen)} title="Toggle activity panel" aria-label="Toggle activity panel"><Activity size={16} /></button>
          </div>
        </header>

        <section className="page-heading">
          <div><div className="eyebrow">SYSTEM OBSERVABILITY <span>/</span> LOCAL AGENT</div><h1>{view}<span className="period">.</span></h1><p className="muted">A clear, evidence-led view of what the agent can actually observe.</p></div>
          <div className="heading-meta"><span className={`status-dot ${snapshotQuery.isError ? 'offline' : 'online'}`} />{snapshotQuery.isError ? 'Gateway unavailable' : 'Snapshot connection'}<small>Updated {snapshotQuery.dataUpdatedAt ? timeLabel(new Date(snapshotQuery.dataUpdatedAt).toISOString()) : '—'}</small></div>
        </section>

        {snapshotQuery.isError && <div className="notice notice-warning"><AlertTriangle size={17} /><div><b>Snapshot unavailable</b><p>{snapshotQuery.error instanceof Error ? snapshotQuery.error.message : 'The local gateway could not be reached.'}</p></div><button className="button button-subtle" onClick={() => void snapshotQuery.refetch()}>Retry</button></div>}

        {view === 'System graph' ? (
          <section className="graph-panel">
            <div className="panel-heading"><div><b>Observed system topology</b><p>Only nodes derived from the current snapshot are shown.</p></div><span className="subtle-chip"><GitBranch size={13} /> {graphNodes.length} nodes</span></div>
            <div className="graph-canvas"><ReactFlow nodes={graphNodes} edges={graphEdges} fitView fitViewOptions={{ padding: 0.25 }} nodesDraggable nodesConnectable={false} proOptions={{ hideAttribution: true }}><Background color="#e5e9ef" gap={22} /><Controls /><MiniMap pannable zoomable /></ReactFlow></div>
            {!snapshot?.watchdog && findings.length === 0 && <div className="empty-overlay"><Network size={22} /><b>No topology data yet</b><span>Graph elements appear when the gateway returns observed data.</span></div>}
          </section>
        ) : (
          <section className="content-grid">
            <div className="main-column">
              {view === 'Overview' && <div className="metric-grid">
                <Metric icon={Activity} label="Recent findings" value={snapshot?.findings?.length ?? '—'} detail="Persisted finding records" />
                <Metric icon={AlertTriangle} label="Open incidents" value={incidents.length || '0'} detail="Based on recorded status" accent={incidents.length > 0} />
                <Metric icon={ShieldCheck} label="Verification records" value={findings.filter((f) => Boolean(f.advisor?.verification)).length} detail="Evidence present in snapshot" />
                <Metric icon={Clock3} label="Activity entries" value={journal.length} detail="Persisted journal records" />
              </div>}

              {(view === 'Overview' || view === 'Incidents' || view === 'Repair review' || view === 'Verification') && <section className="panel">
                <div className="panel-heading"><div><b>{view === 'Overview' ? 'Recent findings' : view === 'Incidents' ? 'Incident queue' : view === 'Repair review' ? 'Repair review' : 'Verification evidence'}</b><p>{view === 'Repair review' ? 'Review recorded decisions. Execution is not available from this interface.' : 'Derived from persisted gateway records; no synthetic activity is shown.'}</p></div><span className="subtle-chip"><ListFilter size={13} /> {findings.length} records</span></div>
                {findings.length === 0 ? <EmptyState title="Nothing to show yet" body={snapshotQuery.isError ? 'Reconnect to the local gateway to load records.' : 'The gateway has not returned any matching findings.'} /> : <div className="finding-list">{(view === 'Incidents' ? incidents : view === 'Repair review' ? findings.filter((f) => f.applied || f.requiresHuman) : view === 'Verification' ? findings.filter((f) => f.advisor?.verification) : findings).slice(0, 30).map((finding) => <button key={finding.id} className={`finding-row ${selected?.id === finding.id ? 'chosen' : ''}`} onClick={() => setSelected(finding)}><span className={`severity-mark severity-${String(finding.severity ?? 'unknown').toLowerCase()}`}><AlertTriangle size={15} /></span><span className="finding-copy"><b>{finding.title || finding.ruleId || 'Untitled finding'}</b><small>{finding.evidence || 'No evidence text supplied'} </small><span className="finding-tags"><span>{finding.ruleId || 'Unclassified'}</span>{finding.shell && <span>{finding.shell}</span>}{finding.requiresHuman && <span className="tag-warn">Human review</span>}</span></span><span className="finding-time">{timeLabel(finding.at)}</span><ArrowDownRight size={15} className="row-arrow" /></button>)}</div>}
              </section>}

              {view === 'Activity history' && <section className="panel"><div className="panel-heading"><div><b>Activity history</b><p>Sanitized journal summaries returned by the local gateway.</p></div><span className="subtle-chip">{journal.length} entries</span></div>{journal.length === 0 ? <EmptyState title="No journal entries" body="Recorded agent activity will appear here when available." /> : <div className="journal-list">{journal.slice().reverse().filter((entry) => [entry.type, entry.target, entry.reason, entry.outcome].join(' ').toLowerCase().includes(query.toLowerCase())).slice(0, 50).map((entry) => <div className="journal-row" key={entry.id}><span className="journal-icon"><Terminal size={15} /></span><span><b>{entry.type || 'Activity'} <i>{entry.outcome || 'unknown'}</i></b><small>{entry.target || entry.reason || 'No additional details'}</small></span><time>{timeLabel(entry.at)}</time></div>)}</div>}</section>}
            </div>

            {activityOpen && <aside className="right-column">
              <section className="panel side-panel"><div className="panel-heading"><div><b>Connection</b><p>Local gateway status</p></div><span className={`status-dot ${snapshotQuery.isError ? 'offline' : 'online'}`} /></div><div className="connection-state"><span className="connection-icon"><LockKeyhole size={17} /></span><div><b>{snapshotQuery.isError ? 'Disconnected' : 'Paired session'}</b><small>127.0.0.1 · authenticated API</small></div></div><div className="side-stat"><span>Snapshot freshness</span><b>{snapshotQuery.dataUpdatedAt ? timeLabel(new Date(snapshotQuery.dataUpdatedAt).toISOString()) : 'Not received'}</b></div><div className="side-stat"><span>Finding snapshot</span><b>{snapshot?.findingsSnapshot ? 'Available' : 'Not confirmed'}</b></div><div className="side-stat"><span>Journal snapshot</span><b>{snapshot?.journalSnapshot ? 'Available' : 'Not confirmed'}</b></div></section>
              <section className="panel side-panel"><div className="panel-heading"><div><b>Recent activity</b><p>Latest persisted journal records</p></div><FileClock size={16} /></div>{journal.slice().reverse().slice(0, 5).map((entry) => <div className="mini-activity" key={entry.id}><span className="mini-dot" /><span><b>{entry.type || 'Activity'}</b><small>{entry.target || entry.reason || entry.outcome || 'Recorded event'}</small></span><time>{timeLabel(entry.at)}</time></div>)}{journal.length === 0 && <p className="muted small-copy">No activity records available.</p>}</section>
              <div className="safety-note"><ShieldCheck size={16} /><span><b>Safety boundary</b><small>Repair execution remains disabled in this UI. Review evidence before taking action in the agent's supported workflow.</small></span></div>
            </aside>}
          </section>
        )}

        <footer className="app-footer"><span><CircleHelp size={14} /> Observability is limited to data the agent exposes.</span><span>WATCH DOGS <i>•</i> LOCAL WORKSPACE</span></footer>
      </main>

      {selected && <div className="inspector-backdrop" onClick={() => setSelected(null)}><aside className="inspector" onClick={(event) => event.stopPropagation()}><div className="inspector-head"><div><div className="eyebrow">FINDING INSPECTOR</div><h2>Evidence details</h2></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="Close inspector"><X size={17} /></button></div><div className="inspector-content"><span className={`severity-pill severity-${String(selected.severity ?? 'unknown').toLowerCase()}`}>{selected.severity || 'Unknown severity'}</span><h3>{selected.title || selected.ruleId}</h3><p className="muted">{selected.ruleId || 'Unclassified rule'}</p><Detail label="Evidence" value={selected.evidence} /><Detail label="Shell" value={selected.shell} /><Detail label="Working directory" value={selected.cwd} /><Detail label="Recorded at" value={timeLabel(selected.at)} /><Detail label="Advisor verdict" value={selected.advisor?.verdict} /><Detail label="Advisor notes" value={selected.advisor?.why} /><Detail label="Applied status" value={selected.applied?.status} /><Detail label="Applied summary" value={selected.applied?.summary} /><Detail label="Verification" value={selected.advisor?.verification?.verdict} /><Detail label="Verification evidence" value={selected.advisor?.verification?.evidence || selected.advisor?.verification?.why} /></div><div className="inspector-footer"><ShieldCheck size={15} /> Read-only evidence view</div></aside></div>}
    </div>
  );
}

function Metric({ icon: Icon, label, value, detail, accent = false }: { icon: typeof Activity; label: string; value: number | string; detail: string; accent?: boolean }) {
  return <article className="metric-card"><div className="metric-top"><span className="metric-icon"><Icon size={17} /></span>{accent ? <span className="metric-status warn">Needs review</span> : <span className="metric-status">Live snapshot</span>}</div><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-detail">{detail}</div></article>;
}
function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="empty-state"><span><CheckCircle2 size={20} /></span><b>{title}</b><p>{body}</p></div>;
}
function Detail({ label, value }: { label: string; value?: string | null }) {
  return <div className="detail-item"><span>{label}</span><p>{value || 'Not supplied by gateway'}</p></div>;
}
