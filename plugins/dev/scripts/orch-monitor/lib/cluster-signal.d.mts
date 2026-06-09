// Type declarations for cluster-signal.mjs (CTL-898 / SHELL8 footer per-node
// health projection).
import type { ClusterView } from "./cluster-view.mjs";

/** One node's heartbeat-overlay liveness (the footer dot color). */
export type ClusterNodeStatus = "live" | "degraded" | "offline";

/** One real roster node in the footer signal: its host name + liveness. */
export interface ClusterSignalNode {
  host: string;
  status: ClusterNodeStatus;
}

/** The tiny per-node footer-health wire shape projected off the ClusterView. */
export interface ClusterSignal {
  /** True ⇒ exactly one node — footer shows one dot, the node filter is absent. */
  singleHost: boolean;
  /** One entry per REAL roster host (the synthetic unassigned bucket is dropped). */
  nodes: ClusterSignalNode[];
  /** The source ClusterView's generatedAt (passthrough for cache/debug). */
  generatedAt: string;
}

/** Project the full ClusterView down to the footer's tiny per-node health shape. */
export function deriveClusterSignal(view: ClusterView | null | undefined): ClusterSignal;
