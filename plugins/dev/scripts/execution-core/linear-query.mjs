// linear-query.mjs — execution-core Linear eligible query (CTL-535 Phase 2).
//
// Turns a resolved eligibleQuery into a `linearis issues list` invocation,
// parses the JSON, normalizes the ticket list, and applies the priority-floor
// post-filter that linearis cannot express server-side.

import { spawnSync } from "node:child_process";
import { withBreaker } from "./linear-breaker.mjs";

// linearis caps a single page; 200 comfortably covers a project's pickable
// set without pagination (the reconcile poll runs every 10 min anyway).
const DEFAULT_LIMIT = 200;

// buildLinearisArgs — argv for `linearis issues list`. `--status` requires
// `--team` (linearis/SKILL.md), so a null team is unsatisfiable and throws.
// `--priority` is deliberately NOT passed: priority is a client-side floor
// filter (keep more-urgent-or-equal), not a server-side equality match.
export function buildLinearisArgs(query) {
  if (!query.team) {
    throw new Error("eligibleQuery.team is required (linearis --status requires --team)");
  }
  const args = [
    "issues",
    "list",
    "--team",
    query.team,
    "--status",
    query.status,
    "--limit",
    String(DEFAULT_LIMIT),
  ];
  if (query.project) args.push("--project", query.project);
  if (query.label) args.push("--label", query.label);
  return args;
}

// rawExec — thin spawnSync wrapper. Injected in tests so no test ever
// shells out to the real linearis CLI or touches the network.
function rawExec(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) {
    return { code: 127, stdout: "", stderr: res.error.message };
  }
  return {
    code: res.status ?? 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// defaultExec — rawExec behind the CTL-679 process-wide rate-limit breaker. The
// eligible poll and per-ticket reads short-circuit without spawning linearis
// while the breaker is open. Shared singleton with linear-write.mjs so a 429 on
// the write path also pauses reads (and vice-versa).
const defaultExec = withBreaker(rawExec);

// normalizeTicket — flatten linearis's nested shape into a stable record.
// `state` and `project` arrive as `{ name }` objects from the Linear API;
// a missing `priority` normalizes to 0 ("No priority", the least urgent).
//
// CTL-536: `createdAt` feeds the pull-loop scheduler's priority tie-break;
// `relations` / `inverseRelations` feed analyzeDependencyGraph
// (lib/dependency-graph.mjs). Relations default to an empty node list so the
// graph builder can read `.nodes` unconditionally. Relation capture depends on
// `linearis issues list` emitting them — if it omits relations the graph
// simply sees no edges and the scheduler degrades to `ready == eligible`.
function normalizeTicket(node) {
  return {
    identifier: node.identifier ?? null,
    title: node.title ?? null,
    state: node.state?.name ?? node.state ?? null,
    priority: typeof node.priority === "number" ? node.priority : 0,
    project: node.project?.name ?? node.project ?? null,
    updatedAt: node.updatedAt ?? null,
    createdAt: node.createdAt ?? null,
    relations: node.relations ?? { nodes: [] },
    inverseRelations: node.inverseRelations ?? { nodes: [] },
  };
}

// fetchTicketState — the current Linear workflow-state name of one ticket, or
// null on any failure (the D5 caller fails safe: a null state holds the
// dependent back). Wraps `linearis issues read <identifier>`; linearis emits
// JSON by default (its CLI header: "CLI for Linear.app with JSON output") so
// there is NO --json flag to pass. Used to hydrate out-of-set blocker states
// the bulk eligible query cannot see. CTL-565 D5.
// CTL-634: an opt-in `cache` (createTicketStateCache) deduplicates the
// per-tick re-reads the scheduler issues for the same out-of-set blocker.
// Consult before exec; populate only on a successful, non-null parse. A
// failed/unparseable read is NEVER cached so the D5 fail-safe re-reads next
// tick. The param is opt-in — callers that omit it exec on every call exactly
// as before.
export function fetchTicketState(identifier, { exec = defaultExec, cache } = {}) {
  if (cache) {
    const cached = cache.get(identifier);
    if (cached !== undefined) return cached; // hit
  }
  const { code, stdout } = exec("linearis", ["issues", "read", identifier]);
  if (code !== 0) return null; // fail-safe — not cached
  try {
    const node = JSON.parse(stdout);
    const state = node?.state?.name ?? node?.state ?? null;
    if (cache && state != null) cache.set(identifier, state); // populate on success only
    return state;
  } catch {
    return null; // unparseable — not cached
  }
}

// fetchTicketLabels — current label-name list for one ticket, or null on any
// failure. CTL-587: used by linear-write.mjs::applyLabel for the
// verify-write-landed step that closes the silent-success gap in linearis
// label writes (memory project_linear_transition_silent_success). The shape
// `labels.nodes[].name` is the Linear API contract — confirmed by
// orch-monitor/lib/linear.ts and pre-assign-migrations.sh. null is the
// "did not land — retry next tick" signal callers interpret as verify-failed.
export function fetchTicketLabels(identifier, { exec = defaultExec } = {}) {
  const { code, stdout } = exec("linearis", ["issues", "read", identifier]);
  if (code !== 0) return null;
  try {
    const node = JSON.parse(stdout);
    return node?.labels?.nodes?.map((n) => n.name) ?? [];
  } catch {
    return null;
  }
}

// runEligibleQuery — run the query, parse + normalize, apply the priority
// floor. A non-zero linearis exit THROWS (never a silent []): a silent empty
// would let one failed poll flatten a project's eligible set to zero. The
// caller (Phase 4 reconcile) catches the throw and preserves the prior set.
export function runEligibleQuery(query, { exec = defaultExec } = {}) {
  const { code, stdout, stderr } = exec("linearis", buildLinearisArgs(query));
  if (code !== 0) {
    throw new Error(`linearis issues list failed (exit ${code}): ${(stderr || "").trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`linearis stdout is not JSON: ${err.message}`);
  }
  let tickets = (parsed.nodes ?? []).map(normalizeTicket);
  // Priority is a floor: keep tickets whose priority is more-urgent-or-equal
  // (1=Urgent … 4=Low). 0 ("No priority") is always below any floor.
  if (query.priority != null) {
    tickets = tickets.filter((t) => t.priority >= 1 && t.priority <= query.priority);
  }
  return tickets;
}
