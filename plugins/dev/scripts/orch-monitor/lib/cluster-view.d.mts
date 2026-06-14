// Type declarations for cluster-view.mjs (CTL-884 / BFF2 node-aware cluster view).
import type { BoardPayload, BoardTicket } from "./board-data.mjs";
import type { HostLivenessStatus, LivenessThresholds } from "./node-liveness.mjs";

/** A board ticket attributed to its owning node (owner_host from the durable cache). */
export interface ClusterTicket extends BoardTicket {
  /** The owning host (BFF11 fence projection); null when no fence has been observed. */
  ownerHost: string | null;
}

/** One cluster node group: the host, its liveness, and the tickets it owns.
 *  The synthetic unassigned bucket has host:null and status:null (not a real host). */
export interface ClusterNode {
  host: string | null;
  status: HostLivenessStatus | null;
  lastSeen: string | null;
  tickets: ClusterTicket[];
}

export interface ClusterView {
  generatedAt: string;
  /** True when the roster is absent or length 1 — the exact identity no-op path. */
  singleHost: boolean;
  /** One entry per node (stable roster order), plus the unassigned bucket when non-empty. */
  nodes: ClusterNode[];
}

export interface AssembleClusterViewArgs extends LivenessThresholds {
  board: BoardPayload;
  ownerHostById?: Record<string, string | null>;
  hosts: string[];
  heartbeats?: Record<string, string>;
  heartbeatReader?: (opts: { logPath?: string }) => Record<string, string>;
  logPath?: string;
  now?: number;
}

export function assembleClusterView(args: AssembleClusterViewArgs): ClusterView;

export interface ClusterEntityDeps {
  /** Provider for the owner_host-per-ticket map (durable cache). */
  ownerHostProvider?: () => Promise<Record<string, string | null>> | Record<string, string | null>;
  /** Provider for the cluster roster (config.getClusterHosts). */
  rosterProvider?: () => string[];
  /** recovery.readClusterHeartbeats stand-in. */
  heartbeatReader?: (opts: { logPath?: string }) => Record<string, string>;
  /** Local event-log path forwarded to the heartbeat reader. */
  logPath?: string;
  /** Injected clock for tests. */
  now?: () => number;
}

/** A read-model entity ({ project }) that assembles the cluster view off the
 *  board snapshot the read-model already computed. Registered via
 *  createReadModel({ entities: { cluster: createClusterEntity(...) } }). */
export function createClusterEntity(deps?: ClusterEntityDeps): {
  project: (snapshot: BoardPayload) => Promise<ClusterView>;
};
