// linear-query.mjs — execution-core Linear eligible query (CTL-535 Phase 2).
//
// Turns a resolved eligibleQuery into a `linearis issues list` invocation,
// parses the JSON, normalizes the ticket list, and applies the priority-floor
// post-filter that linearis cannot express server-side.

import { spawnSync } from "node:child_process";

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

// defaultExec — thin spawnSync wrapper. Injected in tests so no test ever
// shells out to the real linearis CLI or touches the network.
function defaultExec(cmd, args) {
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
