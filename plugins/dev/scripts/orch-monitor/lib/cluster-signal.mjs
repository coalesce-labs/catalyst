// cluster-signal.mjs — the tiny PER-NODE footer-health projection (CTL-898 /
// SHELL8).
//
// SHELL8 generalizes the footer's single daemon-health dot (CTL-896 / SHELL6)
// into a PER-NODE cluster-health indicator and adds a node filter. The footer +
// filter only need each node's { host, status } plus the single-host flag — NOT
// the heavy per-node ticket lists the full ClusterView (CTL-884 / BFF2) carries.
// This module is that projection: it strips the assembled ClusterView down to the
// small footer/filter wire shape so the SSE frame stays tiny, the SAME "derive a
// tiny projection off the read-model's already-assembled snapshot" discipline
// nav-signal.mjs::deriveNavSignal follows for the daemon dot. It is PURE (no fs,
// no clock, no subprocess) — it reads only the passed ClusterView.
//
// SINGLE-HOST IDENTITY NO-OP (the load-bearing operator constraint): a single-
// host ClusterView (roster absent or length 1) projects to EXACTLY one node with
// `singleHost: true`. The footer then collapses to today's single dot and the
// node filter is absent — behaviourally identical to the pre-SHELL8 footer. The
// N>1 branch falls out of the same code (one entry per real roster host) with
// zero added latency; the heavy cross-node aggregation is BFF2/BFF3's concern,
// not this presentation projection.

/**
 * @typedef {"live" | "degraded" | "offline"} ClusterNodeStatus
 */

/**
 * @typedef {object} ClusterSignalNode
 * @property {string} host    the roster host name (the node label)
 * @property {ClusterNodeStatus} status  the node's heartbeat-overlay liveness
 */

/**
 * @typedef {object} ClusterSignal
 * @property {boolean} singleHost  true ⇒ one node, footer shows one dot, no filter
 * @property {ClusterSignalNode[]} nodes  one entry per REAL roster host (unassigned bucket dropped)
 * @property {string} generatedAt  the source ClusterView's generatedAt (passthrough)
 */

/**
 * deriveClusterSignal — project the full ClusterView (BFF2) down to the footer's
 * tiny per-node health wire shape. Drops the per-node ticket lists (the footer
 * does not render them) and the synthetic `host: null` unassigned bucket (it is
 * not a real node to show a health dot for). Pure: reads only the passed view.
 *
 * @param {import("./cluster-view.d.mts").ClusterView | null | undefined} view
 * @returns {ClusterSignal}
 */
export function deriveClusterSignal(view) {
  const nodes = Array.isArray(view?.nodes) ? view.nodes : [];
  const projected = [];
  for (const n of nodes) {
    // The unassigned bucket (host:null / status:null) is not a real node — it has
    // no daemon to be healthy/offline, so it gets no footer dot.
    if (!n || typeof n.host !== "string" || n.host.length === 0) continue;
    if (n.status !== "live" && n.status !== "degraded" && n.status !== "offline") continue;
    projected.push({ host: n.host, status: n.status });
  }
  return {
    // A malformed/absent view degrades to the single-host empty signal (the footer
    // simply shows its unknown/muted dot until the first real frame lands).
    singleHost: view?.singleHost ?? true,
    nodes: projected,
    generatedAt:
      typeof view?.generatedAt === "string" ? view.generatedAt : "",
  };
}
