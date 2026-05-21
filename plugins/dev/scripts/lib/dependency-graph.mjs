// dependency-graph.mjs — Linear readiness filter + cycle detector (CTL-530).
//
// Pure execution-core module: data in → data out, no I/O, no imports — a true
// leaf module (cf. broker/state.mjs). Given Linear issues with their relations
// it computes the ready set (eligible status AND no unfinished blocker) and
// detects dependency cycles via Tarjan's strongly-connected-component pass.
//
// Canonical directed edge { from, to } means `from` blocks `to`: `to` depends
// on `from` and cannot start until `from` finishes.

// Statuses treated as finished. A finished issue never blocks a dependent and
// never appears in the ready/blocked sets. Override via options.terminalStatuses.
const DEFAULT_TERMINAL_STATUSES = ["Done", "Canceled"];

// buildDependencyEdges — normalize Linear relations into canonical directed
// edges (CTL-530). An edge is kept when both endpoints are in-set, OR (CTL-565
// D5) when `to` is in-set and `from` is a declared external blocker — so an
// out-of-set blocker's edge survives for computeReadySet. Non-blocking types
// (related, duplicate) are ignored; results are deduped by (from,to). Live
// `linearis` emits only `blocks`; the API-native `blocked_by` form is also
// accepted for forward-compat.
//
// options.externalIds — out-of-set blocker identifiers (D5) that remain valid
// edge endpoints on the `from` side.
export function buildDependencyEdges(issues, { externalIds } = {}) {
  const list = issues ?? [];
  const inSet = new Set(list.map((i) => i?.identifier).filter(Boolean));
  const ext = externalIds instanceof Set ? externalIds : new Set(externalIds ?? []);
  const seen = new Set();
  const edges = [];

  const add = (from, to) => {
    if (!from || !to) return; // malformed node — missing peer identifier
    // Keep an edge only when `to` is in-set AND `from` is either in-set or a
    // declared external blocker. A genuinely out-of-set edge is dropped.
    if (!inSet.has(to)) return;
    if (!inSet.has(from) && !ext.has(from)) return;
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
// blocked when some edge points at it from an UNFINISHED blocker; otherwise it
// is ready. Terminal issues appear in neither list. Returns
// { ready: string[], blocked: string[] }, both sorted.
//
// CTL-565 D5: options.blockerStates is a { identifier: stateName } map for
// out-of-set blockers. A blocker absent from `issues` is non-blocking ONLY
// when blockerStates omits it (legacy) or says it is terminal; a non-terminal
// out-of-set blocker now blocks.
export function computeReadySet(issues, edges, options = {}) {
  const list = issues ?? [];
  const terminal = new Set(options.terminalStatuses ?? DEFAULT_TERMINAL_STATUSES);
  const blockerStates = options.blockerStates ?? {};
  const isTerminal = (issue) => terminal.has(issue?.state?.name);
  const byId = new Map(list.filter((i) => i?.identifier).map((i) => [i.identifier, i]));

  // An issue is blocked if any unfinished blocker points at it. An in-set
  // blocker blocks unless it is terminal. An out-of-set blocker blocks only
  // when blockerStates carries a non-terminal state for it; an unknown
  // out-of-set blocker (no hydrated state) is non-blocking — legacy behavior.
  const blockedIds = new Set();
  for (const { from, to } of edges ?? []) {
    const inSetBlocker = byId.get(from);
    if (inSetBlocker) {
      if (!isTerminal(inSetBlocker)) blockedIds.add(to);
    } else if (from in blockerStates) {
      if (!terminal.has(blockerStates[from])) blockedIds.add(to);
    }
    // else: unknown out-of-set blocker, no hydrated state — non-blocking.
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

// detectCycles — find dependency cycles via Tarjan's strongly-connected-
// component algorithm (CTL-530). Each SCC with more than one node is a cycle;
// a single-node SCC is a cycle only when that node carries a self-loop edge.
// A node that merely bridges two cycles — sitting on a one-way path between
// them — falls into its own singleton SCC and is correctly excluded, and two
// cycles joined by a one-way edge stay separate anomalies. Returns Anomaly[]
// ordered by first member.
export function detectCycles(nodeIds, edges) {
  const nodes = [...new Set(nodeIds ?? [])];
  const nodeSet = new Set(nodes);

  // Adjacency over in-set nodes. Self-loops are tracked apart from the
  // adjacency list so a singleton SCC can still be flagged as a one-issue
  // cycle; out-of-set and malformed edges are dropped.
  const adj = new Map(nodes.map((n) => [n, []]));
  const selfLoop = new Set();
  for (const e of edges ?? []) {
    if (!e || !nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
    if (e.from === e.to) selfLoop.add(e.from);
    else adj.get(e.from).push(e.to);
  }

  // Tarjan's SCC: a single DFS that stamps each node with a discovery `index`
  // and a `lowlink` (the lowest index reachable from it). A node whose lowlink
  // equals its own index roots an SCC, which is then popped off the stack.
  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;

  const strongConnect = (v) => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v)) {
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), index.get(w)));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  };
  for (const n of nodes) {
    if (!index.has(n)) strongConnect(n);
  }

  // An SCC is a cycle when it has multiple members, or a lone member that
  // links to itself. One anomaly per cycle, members sorted, anomalies ordered
  // by first member.
  const anomalies = [];
  for (const scc of sccs) {
    if (scc.length === 1 && !selfLoop.has(scc[0])) continue;
    const members = [...scc].sort();
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
  anomalies.sort((a, b) =>
    a.members[0] < b.members[0] ? -1 : a.members[0] > b.members[0] ? 1 : 0
  );
  return anomalies;
}

// referencedBlockerIds — every `from` identifier referenced by a `blocked-by`
// edge across the issue list, regardless of set membership (CTL-565 D5). The
// D5 hydration step uses this to discover out-of-set blocker ids BEFORE
// buildDependencyEdges can be told which external endpoints to retain. Kept
// separate so buildDependencyEdges stays single-purpose.
export function referencedBlockerIds(issues) {
  const list = issues ?? [];
  const blockerIds = new Set();
  const add = (id) => {
    if (id) blockerIds.add(id);
  };
  for (const issue of list) {
    const self = issue?.identifier;
    for (const node of issue?.relations?.nodes ?? []) {
      const peer = node?.relatedIssue?.identifier;
      if (node?.type === "blocked_by") add(peer); // peer blocks self
    }
    for (const node of issue?.inverseRelations?.nodes ?? []) {
      const peer = node?.issue?.identifier;
      if (node?.type === "blocks" && self) add(peer); // peer blocks self
    }
  }
  return [...blockerIds];
}

// analyzeDependencyGraph — public entry point (CTL-530). Composes edge
// extraction, the readiness filter, and cycle detection over an array of
// Linear issues. Returns { ready, blocked, anomalies } — ready/blocked are
// sorted identifier arrays, anomalies a sorted Anomaly[].
//
// CTL-565 D5: options.blockerStates ({ id: stateName }) makes the out-of-set
// blockers it names valid edge endpoints AND feeds their state to the
// readiness filter.
export function analyzeDependencyGraph(issues, options = {}) {
  const list = issues ?? [];
  const externalIds = Object.keys(options.blockerStates ?? {});
  const edges = buildDependencyEdges(list, { externalIds });
  const { ready, blocked } = computeReadySet(list, edges, options);
  const anomalies = detectCycles(list.map((i) => i?.identifier).filter(Boolean), edges);
  return { ready, blocked, anomalies };
}
