// cluster-governance.d.mts — CTL-1104 type declarations for cluster-governance.mjs.
// Mirrors governance-reader.d.mts and cluster-view.d.mts conventions.

/** One host's latest governance snapshot from the heartbeat event log. */
export interface ClusterGovernanceNode {
  host: string;
  /** The raw governance modes from body.payload.governance, or null if never heard. */
  governance: Record<string, unknown> | null;
  /** The ISO timestamp from the latest heartbeat ts field, or null if never heard. */
  reportedAt: string | null;
  /** Milliseconds since the heartbeat (clamped to 0 for clock skew), or null if never heard. */
  ageMs: number | null;
  /** Liveness classification matching classifyHostLiveness. */
  status: "live" | "degraded" | "offline";
}

/** The full cluster governance wire shape returned by /api/cluster/governance. */
export interface ClusterGovernanceSignal {
  /** True when roster.length <= 1 (single-host identity no-op). */
  singleHost: boolean;
  /** ISO timestamp of when this signal was generated (injected `now`). */
  generatedAt: string;
  /** One entry per roster host, in roster order. */
  nodes: ClusterGovernanceNode[];
}

export interface ReadClusterGovernanceOpts {
  logPath?: string;
  roster?: string[];
  now?: number;
  intervalMs?: number;
  graceMs?: number;
}

export function readClusterGovernance(opts?: ReadClusterGovernanceOpts): ClusterGovernanceSignal;
