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