// cluster-signal.ts — the UI contract for the read-model's per-node cluster-health
// projection (CTL-898 / SHELL8). The footer's health dot — a SINGLE local daemon
// dot before SHELL8 (CTL-896 / SHELL6) — generalizes into a per-node indicator
// (each node live/degraded/offline from the heartbeat-overlay liveness) plus a way
// to see and filter the shell's view by node when N>1.
//
// This module is the browser-side mirror of the server's `ClusterSignal` shape
// (lib/cluster-signal.mjs, projected off the BFF2 ClusterView) plus a structural
// decode guard, kept deliberately runtime-free + pure so it is unit-testable
// without a DOM (the same pattern lib/nav-signal.ts and lib/surface.ts follow).
// The subscription lifecycle lives in hooks/use-cluster-signal.ts; the footer
// wiring lives in components/app-sidebar.tsx.
//
// SINGLE-HOST IDENTITY NO-OP: with one node (`singleHost: true`) the footer shows
// exactly one dot and the node filter is ABSENT — behaviourally identical to the
// pre-SHELL8 footer. The N>1 per-node dots + filter fall out of the same code.

/** One node's heartbeat-overlay liveness — the footer dot color (mirrors the server). */
export type ClusterNodeStatus = "live" | "degraded" | "offline";

/** CTL-1322: why a live-but-not-accepting node is holding new-work admission. */
export type HoldReason = "drain" | "liveness-cold";

/** One real roster node in the footer signal: its host name + liveness. */
export interface ClusterSignalNode {
  host: string;
  status: ClusterNodeStatus;
  /** CTL-1092: per-node capacity from the heartbeat fan-in. 0/0/0 for offline nodes. */
  maxParallel?: number;
  inFlightCount?: number;
  freeSlots?: number;
  /** CTL-1092: in-flight ticket ids from the heartbeat (for remote slot labels). */
  tickets?: string[];
  /** CTL-1322: local node's new-work admission from its heartbeat. ABSENT ⇒ unknown
   *  (render "live"); a remote peer always omits it. `accepting:false` ⇒ holding. */
  accepting?: boolean;
  holdReason?: HoldReason | null;
}

/** The per-node cluster-health wire shape the footer renders (server's ClusterSignal). */
export interface ClusterSignal {
  /** True ⇒ exactly one node — footer shows one dot, the node filter is absent. */
  singleHost: boolean;
  /** One entry per REAL roster host (the synthetic unassigned bucket is dropped server-side). */
  nodes: ClusterSignalNode[];
  /** The source snapshot's generatedAt (passthrough for dedupe/debug). */
  generatedAt: string;
}

const STATUS_VALUES: readonly ClusterNodeStatus[] = ["live", "degraded", "offline"];

function isClusterSignalNode(value: unknown): value is ClusterSignalNode {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.host === "string" &&
    typeof v.status === "string" &&
    (STATUS_VALUES as readonly string[]).includes(v.status)
  );
}

/** Structural guard: keep a truncated/garbage SSE frame from reaching the footer. */
export function isClusterSignal(value: unknown): value is ClusterSignal {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.singleHost === "boolean" &&
    typeof v.generatedAt === "string" &&
    Array.isArray(v.nodes) &&
    v.nodes.every(isClusterSignalNode)
  );
}

/** Decode an SSE `cluster` frame's data; returns null (skipped) on garbage. */
export function decodeClusterSignalFrame(data: string): ClusterSignal | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return isClusterSignal(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The Tailwind dot color for a node-health status — emerald/amber/red. The cyan
 *  #5be0ff live-signal color is RESERVED and deliberately NOT used here. */
export function nodeDotClass(status: ClusterNodeStatus): string {
  if (status === "live") return "bg-emerald-500";
  if (status === "degraded") return "bg-amber-500";
  return "bg-red-500";
}

/** The human label for a node's health (tooltip + aria-label), naming the host. */
export function nodeStatusLabel(host: string, status: ClusterNodeStatus): string {
  if (status === "live") return `${host} healthy`;
  if (status === "degraded") return `${host} degraded`;
  return `${host} offline`;
}

/**
 * Whether to render the node filter/selector. SINGLE-HOST IDENTITY NO-OP: with
 * one node (or no signal yet) the filter is ABSENT — only a real multi-node fleet
 * (`!singleHost` AND more than one node) shows the affordance.
 */
export function shouldShowNodeFilter(signal: ClusterSignal | null): boolean {
  if (!signal) return false;
  return !signal.singleHost && signal.nodes.length > 1;
}

/**
 * Whether a node is visible under the current scope, given the live signal. The
 * `ALL_NODES` scope (from lib/node-scope.ts) includes every node; a focused scope
 * includes only its host. SINGLE-HOST IDENTITY NO-OP: on a single-host signal
 * every node is included regardless of the scope, so a stale focused scope can
 * never blank the footer when the fleet collapses back to one node.
 */
export function scopeIncludesNode(
  scope: string,
  host: string,
  signal: ClusterSignal | null,
): boolean {
  if (signal?.singleHost) return true;
  if (scope === "all") return true;
  return scope === host;
}
