// Type declarations for node-liveness.mjs (CTL-884 / BFF2 cluster liveness overlay).

export type HostLivenessStatus = "live" | "degraded" | "offline";

export interface ClusterNodeLiveness {
  /** The roster host name (config.mjs::getClusterHosts). */
  host: string;
  /** Liveness derived from the heartbeat freshness. */
  status: HostLivenessStatus;
  /** The last-seen ISO timestamp the overlay classified; null when never heard. */
  lastSeen: string | null;
}

export interface LivenessThresholds {
  /** One heartbeat interval (≤ this ago → live). Defaults to 30s. */
  intervalMs?: number;
  /** The generous grace window (≤ this ago, past interval → degraded). Defaults to 5min. */
  graceMs?: number;
}

/** node-heartbeat cadence default (mirrors execution-core HEARTBEAT_INTERVAL_MS). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS: number;
/** Liveness grace-window default (design-doc 5-10min floor). */
export const DEFAULT_LIVENESS_GRACE_MS: number;

/** Classify a single host's last-seen heartbeat into live/degraded/offline. */
export function classifyHostLiveness(
  lastSeenISO: string | null | undefined,
  now: number,
  opts?: LivenessThresholds,
): HostLivenessStatus;

/** Overlay liveness across a whole roster (stable roster order, offline when unheard). */
export function overlayClusterLiveness(
  hosts: string[],
  lastSeenByHost: Record<string, string>,
  opts?: { now?: number } & LivenessThresholds,
): ClusterNodeLiveness[];
