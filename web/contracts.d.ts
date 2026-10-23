/**
 * Public data contract for the authenticated loopback Watch Dogs gateway.
 *
 * This file documents the current snapshot and optional future bridge fields.
 * Optional bridge fields must remain absent until the runtime really supplies them.
 */
export type WatchDogsProtocol = 'watchdogs.local.v1';
export type DaemonState = 'running' | 'stale' | 'dead' | 'never-started' | 'unknown';
export type ResourceStatus = 'healthy' | 'running' | 'ok' | 'ready' | 'active' | 'connected' | 'warning' | 'degraded' | 'stale' | 'pending' | 'critical' | 'error' | 'failed' | 'dead' | 'crashed' | 'stopped' | 'unknown';

export interface GatewayAgent {
  state: 'ready' | 'unknown';
  pid: number;
  version: string;
  host: '127.0.0.1';
  port: number;
}

export interface CaptureLayers {
  shell?: boolean;
  process?: boolean;
  conpty?: boolean;
}

export interface WatchdogHeartbeat {
  state: DaemonState | string;
  detail: string | null;
  lastBeat: string | number | null;
  daemonPid: number | null;
  projectRoot: string | null;
  autonomy: 'suggest' | 'allowlist' | 'autonomous' | string;
  layers: CaptureLayers;
  dataFiles: string[];
}

export interface RuntimeLogLine {
  id: number | string;
  line: string;
  timestamp?: string;
  source?: string;
}

export interface ObservedResource {
  id: string;
  name?: string;
  label?: string;
  type: 'process' | 'service' | 'file' | 'session' | string;
  kind?: string;
  status?: ResourceStatus | string;
  state?: string;
  pid?: number;
  command?: string;
  path?: string;
  source?: string;
  lastObserved?: string;
  updatedAt?: string;
  [metadata: string]: unknown;
}

export interface ResourceRelationship {
  source: string;
  target: string;
  type?: string;
  label?: string;
}

export interface FindingRecord {
  id: string;
  title?: string;
  message?: string;
  rule?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical' | string;
  state?: string;
  evidence?: string;
  resourceIds?: string[];
  timestamp?: string;
  at?: string | null;
  shell?: string | null;
  cwd?: string | null;
  sessionId?: string | null;
  requiresHuman?: boolean;
  suppressed?: string | null;
  advisor?: { pending?: boolean; verdict?: string | null; requiresHuman?: boolean; why?: string | null } | null;
  applied?: { status?: string; summary?: string | null } | null;
}

export interface RepairProposal {
  id: string;
  title?: string;
  kind?: string;
  reason: string;
  target: string;
  risk?: string;
  reversible?: boolean;
  diff?: string;
  requiresApproval: boolean;
}

export interface VerificationRecord {
  id: string;
  title?: string;
  name?: string;
  status: 'passed' | 'failed' | 'incomplete' | 'inconclusive' | 'not-run' | string;
  evidence?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface JournalSummary {
  id: string;
  at: string | null;
  outcome: string;
  type: string;
  /** Project-relative path only; external targets are redacted. */
  target: string | null;
  source: string | null;
  txOutcome: string | null;
  reason: string | null;
}

export interface GatewayCapabilities {
  health: boolean;
  snapshot: boolean;
  eventStream: boolean;
  findingsSnapshot: boolean;
  journalSnapshot: boolean;
  liveFindingEvents: boolean;
  repairExecution: boolean;
  note?: string;
}

export interface WatchDogsSnapshot {
  protocol: WatchDogsProtocol;
  generatedAt: string;
  agent: GatewayAgent;
  watchdog: WatchdogHeartbeat;
  logs: RuntimeLogLine[];
  capabilities: GatewayCapabilities;
  /** Optional until a real resource discovery bridge is connected. */
  resources?: ObservedResource[];
  /** Optional; edge endpoints must match resource IDs. */
  relationships?: ResourceRelationship[];
  /** Optional until a real finding bridge is connected. */
  findings?: FindingRecord[];
  /** Sanitized audit summaries; never includes before-images or raw argv. */
  journal?: JournalSummary[];
  /** Optional until guarded proposal retrieval is connected. */
  repairProposals?: RepairProposal[];
  /** Optional until actual verification results are exposed. */
  verifications?: VerificationRecord[];
}

export interface WatchDogsEvent<T = unknown> {
  protocol: WatchDogsProtocol;
  event_id: string;
  type: string;
  timestamp: string;
  data: T;
}

/**
 * Current authenticated endpoints:
 * GET /api/health
 * GET /api/snapshot
 * GET /api/events (SSE connection + keepalive; finding events are not wired)
 * POST /api/session/logout
 *
 * No browser-triggered repair endpoint is operational. The existing gateway
 * deliberately returns HTTP 501 for /api/repairs/* until a guarded bridge exists.
 */
