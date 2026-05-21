// dependency-graph.mjs — Linear readiness filter + cycle detector (CTL-530).
//
// Pure execution-core module: data in → data out, no I/O, no imports — a true
// leaf module (cf. broker/state.mjs). Given Linear issues with their relations
// it computes the ready set (eligible status AND no unfinished blocker) and
// detects dependency cycles via a Kahn-style topological pass.
//
// Canonical directed edge { from, to } means `from` blocks `to`: `to` depends
// on `from` and cannot start until `from` finishes.

// Statuses treated as finished. A finished issue never blocks a dependent and
// never appears in the ready/blocked sets. Override via options.terminalStatuses.
const DEFAULT_TERMINAL_STATUSES = ["Done", "Canceled"];

// buildDependencyEdges — normalize Linear relations into canonical directed
// edges (CTL-530). Only edges whose BOTH endpoints are in the input set are
// kept; non-blocking types (related, duplicate) are ignored; results are
// deduped by (from,to). Live `linearis` emits only `blocks`; the API-native
// `blocked_by` form is also accepted for forward-compat.
export function buildDependencyEdges(issues) {
  const list = issues ?? [];
  const inSet = new Set(list.map((i) => i?.identifier).filter(Boolean));
  const seen = new Set();
  const edges = [];

  const add = (from, to) => {
    if (!from || !to) return; // malformed node — missing peer identifier
    if (!inSet.has(from) || !inSet.has(to)) return; // out-of-set edge
    const key = `${from} ${to}`;
    if (seen.has(key)) return; // dedup symmetric relations/inverseRelations
    seen.add(key);
    edges.push({ from, to });
  };

  for (const issue of list) {
    const self = issue?.identifier;
    if (!self) continue;
    // relations: edges this issue owns. `blocks` → self blocks peer;
    // `blocked_by` (forward-compat) → self is blocked by peer.
    for (const node of issue?.relations?.nodes ?? []) {
      const peer = node?.relatedIssue?.identifier;
      if (node?.type === "blocks") add(self, peer);
      else if (node?.type === "blocked_by") add(peer, self);
    }
    // inverseRelations: edges pointing at this issue. `blocks` → peer blocks
    // self; `blocked_by` (forward-compat) → peer is blocked by self.
    for (const node of issue?.inverseRelations?.nodes ?? []) {
      const peer = node?.issue?.identifier;
      if (node?.type === "blocks") add(peer, self);
      else if (node?.type === "blocked_by") add(self, peer);
    }
  }
  return edges;
}

// computeReadySet — partition eligible issues into ready vs blocked (CTL-530).
// An issue is eligible when its status is not terminal. An eligible issue is
// blocked when some in-set edge points at it from an UNFINISHED blocker;
// otherwise it is ready. Terminal issues appear in neither list. Returns
// { ready: string[], blocked: string[] }, both sorted.
export function computeReadySet(issues, edges, options = {}) {
  const list = issues ?? [];
  const terminal = new Set(options.terminalStatuses ?? DEFAULT_TERMINAL_STATUSES);
  const isTerminal = (issue) => terminal.has(issue?.state?.name);
  const byId = new Map(list.filter((i) => i?.identifier).map((i) => [i.identifier, i]));

  // An issue is blocked if any unfinished blocker points at it. A blocker that
  // is unknown (out-of-set) or terminal does not block.
  const blockedIds = new Set();
  for (const { from, to } of edges ?? []) {
    const blocker = byId.get(from);
    if (blocker && !isTerminal(blocker)) blockedIds.add(to);
  }

  const ready = [];
  const blocked = [];
  for (const issue of list) {
    const id = issue?.identifier;
    if (!id || isTerminal(issue)) continue;
    (blockedIds.has(id) ? blocked : ready).push(id);
  }
  ready.sort();
  blocked.sort();
  return { ready, blocked };
}

// detectCycles — find dependency cycles via a Kahn-style topological pass
// (CTL-530). Source-peel: repeatedly drop indegree-0 nodes (the Kahn pass);
// survivors are in or downstream of a cycle. Sink-peel: repeatedly drop
// outdegree-0 survivors; what remains is the set of nodes on a cycle. Those
// are grouped by weakly-connected component — one anomaly per component.
// Returns Anomaly[] ordered by first member.
export function detectCycles(nodeIds, edges) {
  const live = new Set(nodeIds ?? []);
  const liveEdges = (edges ?? []).filter((e) => live.has(e.from) && live.has(e.to));

  // peel(side): repeatedly delete nodes whose degree on `side` ("to" =
  // indegree, "from" = outdegree) is 0, recomputed against the shrinking
  // `live` set so removals cascade.
  const peel = (side) => {
    let changed = true;
    while (changed) {
      changed = false;
      const deg = new Map([...live].map((n) => [n, 0]));
      for (const e of liveEdges) {
        if (!live.has(e.from) || !live.has(e.to)) continue;
        deg.set(e[side], deg.get(e[side]) + 1);
      }
      for (const [n, d] of deg) {
        if (d === 0) {
          live.delete(n);
          changed = true;
        }
      }
    }
  };
  peel("to"); // Kahn source-peel — drop indegree-0 nodes
  peel("from"); // sink-peel — drop outdegree-0 nodes

  // `live` now holds exactly the nodes on (or bridging) a cycle. Group by
  // weakly-connected component over the residual subgraph.
  const adj = new Map([...live].map((n) => [n, new Set()]));
  for (const e of liveEdges) {
    if (!live.has(e.from) || !live.has(e.to) || e.from === e.to) continue;
    adj.get(e.from).add(e.to);
    adj.get(e.to).add(e.from);
  }

  const anomalies = [];
  const visited = new Set();
  for (const start of [...live].sort()) {
    if (visited.has(start)) continue;
    const members = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const node = queue.shift();
      members.push(node);
      for (const peer of adj.get(node)) {
        if (!visited.has(peer)) {
          visited.add(peer);
          queue.push(peer);
        }
      }
    }
    members.sort();
    anomalies.push({
      type: "dependency_cycle",
      severity: "error",
      members,
      reason:
        members.length === 1
          ? `Issue ${members[0]} depends on itself.`
          : `Circular dependency among ${members.length} issues: ${members.join(", ")}.`,
    });
  }
  return anomalies;
}

// analyzeDependencyGraph — public entry point (CTL-530). Composes edge
// extraction, the readiness filter, and cycle detection over an array of
// Linear issues. Returns { ready, blocked, anomalies } — ready/blocked are
// sorted identifier arrays, anomalies a sorted Anomaly[].
export function analyzeDependencyGraph(issues, options = {}) {
  const list = issues ?? [];
  const edges = buildDependencyEdges(list);
  const { ready, blocked } = computeReadySet(list, edges, options);
  const anomalies = detectCycles(list.map((i) => i?.identifier).filter(Boolean), edges);
  return { ready, blocked, anomalies };
}
