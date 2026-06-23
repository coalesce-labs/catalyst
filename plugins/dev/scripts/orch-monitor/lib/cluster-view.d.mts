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
  /** CTL-1092: per-node capacity. Present when capacityReader is wired; 0/0/0 for offline nodes. */
  maxParallel?: number;
  inFlightCount?: number;
  freeSlots?: number;
  /** CTL-1095: drain state. Present when drainReader is wired. */
  draining?: boolean;
  /** CTL-1322: admission state from the node.heartbeat block. Present when admissionReader
   *  is wired (LOCAL node only — remote peers omit it and render "live"). */
  accepting?: boolean;
  holdReason?: "drain" | "liveness-cold" | null;
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
  /** CTL-1095: per-host drain reader → { draining, inFlightCount }. */
  drainReader?: ((host: string) => { draining?: boolean; inFlightCount?: number } | null | undefined) | null;
  /** CTL-1092: per-host capacity reader → { maxParallel, inFlightCount, freeSlots }. */
  capacityReader?:
    | ((host: string) => { maxParallel?: number; inFlightCount?: number; freeSlots?: number } | null | undefined)
    | null;
  /** CTL-1092: host alias map { oldName → pinnedName } for collapsing pre-pin heartbeat keys. */
  aliases?: Record<string, string> | null;
  /** CTL-1322: per-host admission reader → { accepting, holdReason }. */
  admissionReader?:
    | ((host: string) => { accepting?: boolean; holdReason?: "drain" | "liveness-cold" | null } | null | undefined)
    | null;
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
  /** CTL-1092: live per-host capacity reader, forwarded to assembleClusterView. */
  capacityReader?:
    | ((host: string) => { maxParallel?: number; inFlightCount?: number; freeSlots?: number } | null | undefined)
    | null;
  /** CTL-1092: host alias map { oldName → pinnedName }, forwarded to assembleClusterView. */
  aliases?: Record<string, string> | null;
  /** CTL-1095: live drain reader, forwarded to assembleClusterView. */
  drainReader?: ((host: string) => { draining?: boolean; inFlightCount?: number } | null | undefined) | null;
  /** CTL-1322: live admission reader, forwarded to assembleClusterView. */
  admissionReader?:
    | ((host: string) => { accepting?: boolean; holdReason?: "drain" | "liveness-cold" | null } | null | undefined)
    | null;
  /** Injected clock for tests. */
  now?: () => number;
}

/** A read-model entity ({ project }) that assembles the cluster view off the
 *  board snapshot the read-model already computed. Registered via
 *  createReadModel({ entities: { cluster: createClusterEntity(...) } }). */
export function createClusterEntity(deps?: ClusterEntityDeps): {
  project: (snapshot: BoardPayload) => Promise<ClusterView>;
};
