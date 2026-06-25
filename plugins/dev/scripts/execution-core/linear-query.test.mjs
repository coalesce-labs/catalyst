// Unit tests for the execution-core Linear eligible query (CTL-535 Phase 2).
// Run: cd plugins/dev/scripts/execution-core && bun test linear-query.test.mjs

import { describe, test, expect, mock } from "bun:test";
import {
  buildLinearisArgs,
  runEligibleQuery,
  fetchTicketState,
  fetchTicketLabels,
  readTicketLabels,
  readTicketLabelNodes,
  fetchTicketRelations,
  fetchTicketsBatch,
  authHeader,
  buildBatchCurlArgs,
  isBatchRateLimited,
  classifyTicketResolution,
  fetchTicketAssignee,
  isAssigneeClaimable,
  isClaimable,
  buildDelegateCurlArgs,
  fetchTicketDelegate,
  buildDelegateBatchCurlArgs,
  fetchTicketsDelegateBatch,
} from "./linear-query.mjs";
import { createTicketStateCache } from "./linear-cache.mjs";

// A fake exec returning a canned linearis result. `exec(cmd, args)` ->
// { code, stdout, stderr } — the injectable seam runEligibleQuery uses so a
// test never shells out to the real linearis CLI.
function fakeExec({ code = 0, stdout = "", stderr = "" } = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args });
    return { code, stdout, stderr };
  };
  fn.calls = calls;
  return fn;
}

function ticketsJson(nodes) {
  return JSON.stringify({ nodes });
}

describe("buildLinearisArgs", () => {
  test("includes --team and --status (both mandatory; --status requires --team)", () => {
    const args = buildLinearisArgs({ team: "ENG", status: "Todo" });
    expect(args.slice(0, 2)).toEqual(["issues", "list"]);
    expect(args[args.indexOf("--team") + 1]).toBe("ENG");
    expect(args[args.indexOf("--status") + 1]).toBe("Todo");
  });

  test("includes --project / --label only when set", () => {
    const without = buildLinearisArgs({ team: "ENG", status: "Todo" });
    expect(without).not.toContain("--project");
    expect(without).not.toContain("--label");

    const withBoth = buildLinearisArgs({
      team: "ENG",
      status: "Todo",
      project: "Platform",
      label: "ready",
    });
    expect(withBoth[withBoth.indexOf("--project") + 1]).toBe("Platform");
    expect(withBoth[withBoth.indexOf("--label") + 1]).toBe("ready");
  });

  test("omits --priority from argv (priority is a post-filter floor, not server-side)", () => {
    const args = buildLinearisArgs({ team: "ENG", status: "Todo", priority: 2 });
    expect(args).not.toContain("--priority");
  });

  test("includes a --limit", () => {
    const args = buildLinearisArgs({ team: "ENG", status: "Todo" });
    expect(args).toContain("--limit");
    expect(Number(args[args.indexOf("--limit") + 1])).toBeGreaterThan(0);
  });

  test("throws when query.team is null (cannot satisfy --status requires --team)", () => {
    expect(() => buildLinearisArgs({ team: null, status: "Todo" })).toThrow();
  });
});

describe("runEligibleQuery", () => {
  const query = { team: "ENG", status: "Todo", project: null, label: null, priority: null };

  test("parses { nodes: [...] } into [{ identifier, title, state, priority, ... }]", () => {
    const exec = fakeExec({
      stdout: ticketsJson([
        {
          identifier: "ENG-1",
          title: "First",
          state: { name: "Todo" },
          priority: 2,
          project: { name: "Platform" },
          updatedAt: "2026-05-21T00:00:00Z",
        },
      ]),
    });
    const tickets = runEligibleQuery(query, { exec });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      identifier: "ENG-1",
      title: "First",
      state: "Todo",
      priority: 2,
      project: "Platform",
      updatedAt: "2026-05-21T00:00:00Z",
    });
  });

  test("priority floor 2 keeps priority 1 and 2, drops 3, 4, and 0 (no priority)", () => {
    const exec = fakeExec({
      stdout: ticketsJson([
        { identifier: "ENG-1", state: { name: "Todo" }, priority: 1 },
        { identifier: "ENG-2", state: { name: "Todo" }, priority: 2 },
        { identifier: "ENG-3", state: { name: "Todo" }, priority: 3 },
        { identifier: "ENG-4", state: { name: "Todo" }, priority: 4 },
        { identifier: "ENG-0", state: { name: "Todo" }, priority: 0 },
      ]),
    });
    const tickets = runEligibleQuery({ ...query, priority: 2 }, { exec });
    expect(tickets.map((t) => t.identifier).sort()).toEqual(["ENG-1", "ENG-2"]);
  });

  test("no priority floor keeps every returned ticket", () => {
    const exec = fakeExec({
      stdout: ticketsJson([
        { identifier: "ENG-1", state: { name: "Todo" }, priority: 1 },
        { identifier: "ENG-3", state: { name: "Todo" }, priority: 3 },
        { identifier: "ENG-0", state: { name: "Todo" }, priority: 0 },
      ]),
    });
    expect(runEligibleQuery(query, { exec })).toHaveLength(3);
  });

  test("returns [] for { nodes: [] }", () => {
    const exec = fakeExec({ stdout: ticketsJson([]) });
    expect(runEligibleQuery(query, { exec })).toEqual([]);
  });

  test("throws (does NOT silently return []) when linearis exits non-zero", () => {
    const exec = fakeExec({ code: 1, stderr: "linearis: auth failed" });
    expect(() => runEligibleQuery(query, { exec })).toThrow(/exit 1/);
  });

  test("throws on unparseable linearis stdout", () => {
    const exec = fakeExec({ stdout: "not json at all" });
    expect(() => runEligibleQuery(query, { exec })).toThrow();
  });

  test("passes the resolved team and status through to the linearis argv", () => {
    const exec = fakeExec({ stdout: ticketsJson([]) });
    runEligibleQuery({ ...query, team: "PLAT", status: "Backlog" }, { exec });
    const args = exec.calls[0].args;
    expect(exec.calls[0].cmd).toBe("linearis");
    expect(args[args.indexOf("--team") + 1]).toBe("PLAT");
    expect(args[args.indexOf("--status") + 1]).toBe("Backlog");
  });

  // CTL-536: the scheduler's priority tie-break needs createdAt; the readiness
  // filter (analyzeDependencyGraph) needs relations / inverseRelations.
  test("captures createdAt when present", () => {
    const exec = fakeExec({
      stdout: ticketsJson([
        {
          identifier: "ENG-1",
          state: { name: "Todo" },
          priority: 2,
          createdAt: "2026-05-01T00:00:00Z",
        },
      ]),
    });
    expect(runEligibleQuery(query, { exec })[0].createdAt).toBe("2026-05-01T00:00:00Z");
  });

  test("createdAt is null when absent (never undefined)", () => {
    const exec = fakeExec({
      stdout: ticketsJson([{ identifier: "ENG-1", state: { name: "Todo" } }]),
    });
    expect(runEligibleQuery(query, { exec })[0].createdAt).toBeNull();
  });

  test("passes relations / inverseRelations through verbatim for the dependency graph", () => {
    const relations = {
      nodes: [{ type: "blocks", relatedIssue: { identifier: "ENG-2" } }],
    };
    const exec = fakeExec({
      stdout: ticketsJson([{ identifier: "ENG-1", state: { name: "Todo" }, relations }]),
    });
    const t = runEligibleQuery(query, { exec })[0];
    expect(t.relations).toEqual(relations);
    expect(t.inverseRelations).toEqual({ nodes: [] });
  });

  // CTL-878: the eligible/Pass-2 path carries the parent epic id so
  // buildDependencyEdges can drop a parent→child blocks edge for a Todo child.
  test("CTL-878: captures the parent epic identifier (nested) for an eligible ticket", () => {
    const exec = fakeExec({
      stdout: ticketsJson([
        { identifier: "CTL-863", state: { name: "Todo" }, parent: { identifier: "CTL-859" } },
      ]),
    });
    expect(runEligibleQuery(query, { exec })[0].parent).toBe("CTL-859");
  });

  test("CTL-878: parent is null when an eligible ticket has no parent (never undefined)", () => {
    const exec = fakeExec({
      stdout: ticketsJson([{ identifier: "CTL-1", state: { name: "Todo" } }]),
    });
    expect(runEligibleQuery(query, { exec })[0].parent).toBeNull();
  });
});

// CTL-565 D5 — fetchTicketState wraps `linearis issues read <id>` to hydrate
// an out-of-set blocker's live Linear state. linearis emits JSON by default
// (its header: "CLI for Linear.app with JSON output") — no --json flag exists.
describe("fetchTicketState", () => {
  test("runs `linearis issues read <id>` and returns the state name", () => {
    const exec = (cmd, args) => {
      expect(cmd).toBe("linearis");
      expect(args).toEqual(["issues", "read", "CTL-99"]);
      return {
        code: 0,
        stdout: JSON.stringify({ identifier: "CTL-99", state: { name: "Backlog" } }),
        stderr: "",
      };
    };
    expect(fetchTicketState("CTL-99", { exec })).toBe("Backlog");
  });

  test("returns null on a non-zero linearis exit (caller fails safe)", () => {
    const exec = () => ({ code: 1, stdout: "", stderr: "not found" });
    expect(fetchTicketState("CTL-99", { exec })).toBeNull();
  });

  test("returns null on unparseable stdout", () => {
    const exec = () => ({ code: 0, stdout: "not json", stderr: "" });
    expect(fetchTicketState("CTL-99", { exec })).toBeNull();
  });

  test("accepts a flat string `state` field too", () => {
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ identifier: "CTL-99", state: "Done" }),
      stderr: "",
    });
    expect(fetchTicketState("CTL-99", { exec })).toBe("Done");
  });
});

// CTL-587 — fetchTicketLabels reads back the current label list for a ticket.
// Used by applyLabel's verify-write-landed step to close the silent-success
// gap (linearis can exit 0 without the label actually landing — see memory
// project_linear_transition_silent_success).
describe("fetchTicketLabels", () => {
  test("returns label names from linearis JSON", () => {
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({
        identifier: "CTL-9",
        labels: { nodes: [{ name: "triaged" }, { name: "needs-human" }] },
      }),
      stderr: "",
    });
    expect(fetchTicketLabels("CTL-9", { exec })).toEqual(["triaged", "needs-human"]);
  });

  test("returns [] when labels.nodes is empty", () => {
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ identifier: "CTL-9", labels: { nodes: [] } }),
      stderr: "",
    });
    expect(fetchTicketLabels("CTL-9", { exec })).toEqual([]);
  });

  test("returns null on a non-zero linearis exit (read failure → retry next tick)", () => {
    const exec = () => ({ code: 1, stdout: "", stderr: "boom" });
    expect(fetchTicketLabels("CTL-9", { exec })).toBeNull();
  });

  test("returns null on JSON parse error", () => {
    const exec = () => ({ code: 0, stdout: "not json", stderr: "" });
    expect(fetchTicketLabels("CTL-9", { exec })).toBeNull();
  });

  test("returns [] when labels object is missing from the response", () => {
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ identifier: "CTL-9" }),
      stderr: "",
    });
    expect(fetchTicketLabels("CTL-9", { exec })).toEqual([]);
  });

  test("invokes linearis issues read <id>", () => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: JSON.stringify({ labels: { nodes: [] } }), stderr: "" };
    };
    fetchTicketLabels("CTL-9", { exec });
    expect(calls[0].cmd).toBe("linearis");
    expect(calls[0].args).toEqual(["issues", "read", "CTL-9"]);
  });
});

// CTL-1078 — readTicketLabels: richer shape { ok, labels, code, stderr }
describe("readTicketLabels", () => {
  test("success → { ok: true, labels: [...] }", () => {
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({
        identifier: "CTL-9",
        labels: { nodes: [{ name: "triaged" }, { name: "needs-human" }] },
      }),
      stderr: "",
    });
    expect(readTicketLabels("CTL-9", { exec })).toEqual({ ok: true, labels: ["triaged", "needs-human"] });
  });

  test("non-zero exit → { ok: false, labels: null, code, stderr }", () => {
    const exec = () => ({ code: 1, stdout: "", stderr: "400 invalid_scope" });
    const result = readTicketLabels("CTL-9", { exec });
    expect(result.ok).toBe(false);
    expect(result.labels).toBeNull();
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("400 invalid_scope");
  });

  test("non-JSON stdout → { ok: false, labels: null }", () => {
    const exec = () => ({ code: 0, stdout: "not-json", stderr: "" });
    const result = readTicketLabels("CTL-9", { exec });
    expect(result.ok).toBe(false);
    expect(result.labels).toBeNull();
  });

  test("fetchTicketLabels back-compat: returns array on success", () => {
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ labels: { nodes: [{ name: "blocked" }] } }),
      stderr: "",
    });
    expect(fetchTicketLabels("CTL-9", { exec })).toEqual(["blocked"]);
  });

  test("fetchTicketLabels back-compat: returns null on failure", () => {
    const exec = () => ({ code: 1, stdout: "", stderr: "boom" });
    expect(fetchTicketLabels("CTL-9", { exec })).toBeNull();
  });
});

// CTL-1085 — readTicketLabelNodes: returns { id, name } nodes (not just names)
// so removeLabel can build a UUID-based overwrite payload that avoids cross-team
// name-resolution ambiguity.
describe("readTicketLabelNodes (CTL-1085)", () => {
  test("returns { ok: true, nodes: [{id,name}] } on success", () => {
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({
        labels: { nodes: [
          { id: "b4a67f92-cfce-444d-97b5-61f5575ccbd9", name: "bug" },
          { id: "62139cba-ed7b-4372-a588-5af63f6c090b", name: "orchestrator" },
        ] },
      }),
      stderr: "",
    });
    const r = readTicketLabelNodes("CTL-1", { exec });
    expect(r.ok).toBe(true);
    expect(r.nodes).toEqual([
      { id: "b4a67f92-cfce-444d-97b5-61f5575ccbd9", name: "bug" },
      { id: "62139cba-ed7b-4372-a588-5af63f6c090b", name: "orchestrator" },
    ]);
  });

  test("returns { ok: false, nodes: null, stderr } on non-zero exit", () => {
    const exec = () => ({ code: 1, stdout: "", stderr: "400 invalid_scope" });
    const r = readTicketLabelNodes("CTL-1", { exec });
    expect(r.ok).toBe(false);
    expect(r.nodes).toBeNull();
    expect(r.stderr).toBe("400 invalid_scope");
  });

  test("returns { ok: false, nodes: null } on unparseable stdout", () => {
    const exec = () => ({ code: 0, stdout: "", stderr: "" });
    const r = readTicketLabelNodes("CTL-1", { exec });
    expect(r.ok).toBe(false);
    expect(r.nodes).toBeNull();
  });

  test("returns { ok: true, nodes: [] } when ticket has no labels", () => {
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ labels: { nodes: [] } }),
      stderr: "",
    });
    const r = readTicketLabelNodes("CTL-1", { exec });
    expect(r.ok).toBe(true);
    expect(r.nodes).toEqual([]);
  });
});

// CTL-634 Tier 1 — fetchTicketState consults/populates an opt-in cache. The
// cache is opt-in so the four tests above (which omit it) are unchanged; a
// failed read is NEVER cached so the D5 fail-safe re-reads next call.
describe("fetchTicketState — cache (CTL-634)", () => {
  test("serves a second read from cache without a second exec", () => {
    const cache = createTicketStateCache({ now: () => 0 });
    let calls = 0;
    const exec = () => {
      calls += 1;
      return { code: 0, stdout: JSON.stringify({ state: { name: "Done" } }), stderr: "" };
    };
    expect(fetchTicketState("CTL-1", { exec, cache })).toBe("Done");
    expect(fetchTicketState("CTL-1", { exec, cache })).toBe("Done");
    expect(calls).toBe(1); // second read was a cache hit
  });

  test("does NOT cache a failed read (null) — re-execs next call (fail-safe)", () => {
    const cache = createTicketStateCache({ now: () => 0 });
    let calls = 0;
    const exec = () => {
      calls += 1;
      return { code: 1, stdout: "", stderr: "boom" };
    };
    expect(fetchTicketState("CTL-1", { exec, cache })).toBeNull();
    expect(fetchTicketState("CTL-1", { exec, cache })).toBeNull();
    expect(calls).toBe(2); // null never cached → both calls hit exec
  });

  test("without a cache, behaves exactly as before (every call execs)", () => {
    let calls = 0;
    const exec = () => {
      calls += 1;
      return { code: 0, stdout: JSON.stringify({ state: { name: "Ready" } }), stderr: "" };
    };
    fetchTicketState("CTL-1", { exec });
    fetchTicketState("CTL-1", { exec });
    expect(calls).toBe(2);
  });
});

// CTL-755 — fetchTicketRelations is the admission gate's single-read hydration
// of a triaged-waiting candidate: state + relations + inverseRelations +
// priority + labels in one `linearis issues read <id>`. The descriptor it
// returns mirrors normalizeTicket so buildDependencyEdges / computeReadySet
// consume it unchanged. VERIFIED payload (ADV-1277): relations.nodes carry a
// `blocks` edge, inverseRelations.nodes carry a `blocks` edge from the blocker,
// priority is a number, labels.nodes[].name carries the label list.
describe("fetchTicketRelations (CTL-755)", () => {
  // The verified ADV-1277 shape: a blocks→ADV-1280 relation, an inverse
  // blocks←ADV-1276 (i.e. ADV-1276 blocks this ticket → a blocked-by edge),
  // priority 2, plus labels.
  function adv1277Json() {
    return JSON.stringify({
      identifier: "ADV-1277",
      state: { name: "Triage" },
      priority: 2,
      relations: {
        nodes: [{ type: "blocks", relatedIssue: { identifier: "ADV-1280" } }],
      },
      inverseRelations: {
        nodes: [{ type: "blocks", issue: { identifier: "ADV-1276" } }],
      },
      labels: { nodes: [{ name: "feature" }, { name: "orchestrator" }] },
    });
  }

  test("runs `linearis issues read <id>` and returns the full descriptor", () => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: adv1277Json(), stderr: "" };
    };
    const rel = fetchTicketRelations("ADV-1277", { exec });
    expect(calls[0].cmd).toBe("linearis");
    expect(calls[0].args).toEqual(["issues", "read", "ADV-1277"]);
    expect(rel).toEqual({
      state: "Triage",
      parent: null, // CTL-878: ADV-1277 has no parent → null
      relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "ADV-1280" } }] },
      inverseRelations: { nodes: [{ type: "blocks", issue: { identifier: "ADV-1276" } }] },
      priority: 2,
      labels: ["feature", "orchestrator"],
    });
  });

  test("CTL-878: carries the parent epic identifier when `linearis issues read` emits it", () => {
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({
        identifier: "CTL-863",
        state: { name: "Todo" },
        parent: { identifier: "CTL-859" },
      }),
      stderr: "",
    });
    expect(fetchTicketRelations("CTL-863", { exec }).parent).toBe("CTL-859");
  });

  test("parses a blocked-by edge out of inverseRelations.nodes", () => {
    const exec = () => ({ code: 0, stdout: adv1277Json(), stderr: "" });
    const rel = fetchTicketRelations("ADV-1277", { exec });
    // The inverse `blocks` edge means ADV-1276 blocks ADV-1277 — the blocked-by
    // relationship the dependency graph reads from inverseRelations.
    expect(rel.inverseRelations.nodes).toHaveLength(1);
    expect(rel.inverseRelations.nodes[0].type).toBe("blocks");
    expect(rel.inverseRelations.nodes[0].issue.identifier).toBe("ADV-1276");
  });

  test("defaults relations / inverseRelations to { nodes: [] } when absent", () => {
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ identifier: "CTL-9", state: { name: "Triage" } }),
      stderr: "",
    });
    const rel = fetchTicketRelations("CTL-9", { exec });
    expect(rel.relations).toEqual({ nodes: [] });
    expect(rel.inverseRelations).toEqual({ nodes: [] });
  });

  test("defaults priority to null and labels to [] when absent", () => {
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ identifier: "CTL-9", state: { name: "Triage" } }),
      stderr: "",
    });
    const rel = fetchTicketRelations("CTL-9", { exec });
    expect(rel.priority).toBeNull();
    expect(rel.labels).toEqual([]);
  });

  test("priority 0 (No priority) is preserved, not coerced to null", () => {
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ identifier: "CTL-9", state: { name: "Triage" }, priority: 0 }),
      stderr: "",
    });
    expect(fetchTicketRelations("CTL-9", { exec }).priority).toBe(0);
  });

  test("accepts a flat string `state` field too", () => {
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ identifier: "CTL-9", state: "Done" }),
      stderr: "",
    });
    expect(fetchTicketRelations("CTL-9", { exec }).state).toBe("Done");
  });

  test("returns null on a non-zero linearis exit (caller fails safe → held)", () => {
    const exec = () => ({ code: 1, stdout: "", stderr: "not found" });
    expect(fetchTicketRelations("CTL-9", { exec })).toBeNull();
  });

  test("returns null on unparseable stdout", () => {
    const exec = () => ({ code: 0, stdout: "not json at all", stderr: "" });
    expect(fetchTicketRelations("CTL-9", { exec })).toBeNull();
  });

  // The shared cache contract: fetchTicketRelations populates the SAME state
  // cache fetchTicketState reads (string state keyed by identifier), so a
  // subsequent fetchTicketState hits it without a second read. Relations /
  // priority / labels are returned uncached (one read per call) — caching them
  // under the same key would corrupt fetchTicketState's string-typed reads.
  describe("shared state cache", () => {
    test("populates the shared cache so fetchTicketState serves a hit (no second exec)", () => {
      const cache = createTicketStateCache({ now: () => 0 });
      let calls = 0;
      const exec = () => {
        calls += 1;
        return { code: 0, stdout: JSON.stringify({ state: { name: "Done" } }), stderr: "" };
      };
      expect(fetchTicketRelations("CTL-1", { exec, cache }).state).toBe("Done");
      // fetchTicketState now reads the state populated by fetchTicketRelations.
      expect(fetchTicketState("CTL-1", { exec, cache })).toBe("Done");
      expect(calls).toBe(1); // second read was a cache hit on the shared state
    });

    test("does NOT cache a failed read (null) — re-execs next call (fail-safe)", () => {
      const cache = createTicketStateCache({ now: () => 0 });
      let calls = 0;
      const exec = () => {
        calls += 1;
        return { code: 1, stdout: "", stderr: "boom" };
      };
      expect(fetchTicketRelations("CTL-1", { exec, cache })).toBeNull();
      expect(fetchTicketRelations("CTL-1", { exec, cache })).toBeNull();
      expect(calls).toBe(2); // null never cached → both calls hit exec
    });

    test("without a cache, every call execs (relations are always read fresh)", () => {
      let calls = 0;
      const exec = () => {
        calls += 1;
        return { code: 0, stdout: JSON.stringify({ state: { name: "Triage" } }), stderr: "" };
      };
      fetchTicketRelations("CTL-1", { exec });
      fetchTicketRelations("CTL-1", { exec });
      expect(calls).toBe(2);
    });

    // CTL-784: read-through. A second fetchTicketRelations WITH a cache hits the
    // relations store and does NOT exec again (the gap the handoff fixed).
    test("with a cache, a second call is a read-through hit (no second exec)", () => {
      const cache = createTicketStateCache({ now: () => 0 });
      let calls = 0;
      const exec = () => {
        calls += 1;
        return {
          code: 0,
          stdout: JSON.stringify({ state: { name: "Triage" }, priority: 2 }),
          stderr: "",
        };
      };
      expect(fetchTicketRelations("CTL-1", { exec, cache }).state).toBe("Triage");
      expect(fetchTicketRelations("CTL-1", { exec, cache }).state).toBe("Triage");
      expect(calls).toBe(1); // second call served from the relations read-through store
    });
  });
});

// CTL-784 — fetchTicketsBatch collapses N per-ticket reads into ONE request. The
// `exec` seam is injected as `(ids) => nodes[]` so no test shells out to curl.
describe("fetchTicketsBatch (CTL-784)", () => {
  // A node in the batched GraphQL shape (same nested shape `linearis issues read`
  // returns): state{name}, labels{nodes{name}}, relations{nodes{...}}.
  const node = (identifier, { state = "Triage", priority = 2, labels = [], blockedBy, parent } = {}) => ({
    identifier,
    priority,
    state: { name: state },
    ...(parent ? { parent: { identifier: parent } } : {}),
    labels: { nodes: labels.map((name) => ({ name })) },
    relations: { nodes: [] },
    inverseRelations: blockedBy
      ? { nodes: [{ type: "blocks", issue: { identifier: blockedBy } }] }
      : { nodes: [] },
  });

  test("resolves a set of identifiers in ONE exec call, keyed by identifier", () => {
    let calls = 0;
    const exec = (ids) => {
      calls += 1;
      return ids.map((id) => node(id, { state: "Done" }));
    };
    const map = fetchTicketsBatch(["CTL-1", "CTL-2", "CTL-3"], { exec });
    expect(calls).toBe(1); // ONE request for all three
    expect([...map.keys()].sort()).toEqual(["CTL-1", "CTL-2", "CTL-3"]);
    expect(map.get("CTL-2").state).toBe("Done");
  });

  test("normalizes each node to the fetchTicketRelations shape (no identifier key)", () => {
    const exec = (ids) =>
      ids.map((id) => node(id, { state: "In Progress", priority: 1, labels: ["blocked"], blockedBy: "CTL-9" }));
    const desc = fetchTicketsBatch(["CTL-1"], { exec }).get("CTL-1");
    expect(desc).toEqual({
      state: "In Progress",
      parent: null, // CTL-878: no parent on this node → null
      relations: { nodes: [] },
      inverseRelations: { nodes: [{ type: "blocks", issue: { identifier: "CTL-9" } }] },
      priority: 1,
      labels: ["blocked"],
    });
    expect("identifier" in desc).toBe(false); // shape parity with fetchTicketRelations
  });

  test("CTL-878: carries the parent epic identifier from a batched node", () => {
    const exec = (ids) => ids.map((id) => node(id, { parent: "CTL-859" }));
    const desc = fetchTicketsBatch(["CTL-863"], { exec }).get("CTL-863");
    expect(desc.parent).toBe("CTL-859");
  });

  test("dedupes identifiers before the exec", () => {
    let received = null;
    const exec = (ids) => {
      received = ids;
      return ids.map((id) => node(id));
    };
    fetchTicketsBatch(["CTL-1", "CTL-1", "CTL-2"], { exec });
    expect(received.sort()).toEqual(["CTL-1", "CTL-2"]); // deduped
  });

  test("chunks >250 identifiers into multiple exec calls", () => {
    const ids = Array.from({ length: 600 }, (_, i) => `CTL-${i + 1}`);
    const chunkSizes = [];
    const exec = (chunk) => {
      chunkSizes.push(chunk.length);
      return chunk.map((id) => node(id));
    };
    const map = fetchTicketsBatch(ids, { exec });
    expect(chunkSizes).toEqual([250, 250, 100]);
    expect(map.size).toBe(600);
  });

  test("an identifier the query does not return is ABSENT (fail-safe hold)", () => {
    // exec returns only CTL-1; CTL-MISSING (not-found) is dropped by the query.
    const exec = () => [node("CTL-1")];
    const map = fetchTicketsBatch(["CTL-1", "CTL-MISSING"], { exec });
    expect(map.has("CTL-1")).toBe(true);
    expect(map.has("CTL-MISSING")).toBe(false); // absent → caller fails safe
  });

  test("a failed batch (exec returns null) leaves all ids absent (fail-safe)", () => {
    const exec = () => null; // breaker open / network / 429
    const map = fetchTicketsBatch(["CTL-1", "CTL-2"], { exec });
    expect(map.size).toBe(0);
  });

  test("cache-first: cached ids are served from cache, only misses are fetched", () => {
    const cache = createTicketStateCache({ now: () => 0 });
    cache.setRelations("CTL-CACHED", {
      state: "Backlog",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
      priority: 2,
      labels: [],
    });
    let received = null;
    const exec = (ids) => {
      received = ids;
      return ids.map((id) => node(id, { state: "Done" }));
    };
    const map = fetchTicketsBatch(["CTL-CACHED", "CTL-FRESH"], { exec, cache });
    expect(received).toEqual(["CTL-FRESH"]); // only the miss was fetched
    expect(map.get("CTL-CACHED").state).toBe("Backlog"); // served from cache
    expect(map.get("CTL-FRESH").state).toBe("Done");
  });

  test("populates the cache (relations + primed state) on a fetched miss", () => {
    const cache = createTicketStateCache({ now: () => 0 });
    const exec = (ids) => ids.map((id) => node(id, { state: "Done" }));
    fetchTicketsBatch(["CTL-1"], { exec, cache });
    expect(fetchTicketState("CTL-1", { cache, exec: () => ({ code: 1, stdout: "", stderr: "" }) })).toBe(
      "Done",
    ); // state primed → hit, never reaches the failing exec
    expect(cache.getRelations("CTL-1").state).toBe("Done"); // relations cached
  });

  test("no exec for an empty / all-cached id set", () => {
    let calls = 0;
    const exec = () => {
      calls += 1;
      return [];
    };
    expect(fetchTicketsBatch([], { exec }).size).toBe(0);
    expect(fetchTicketsBatch(null, { exec }).size).toBe(0);
    expect(calls).toBe(0);
  });
});

// CTL-784 — the curl-path internals (auth scheme, --cacert gating, RATELIMITED
// detection) are otherwise only exercised in production (every fetchTicketsBatch
// test injects a fake exec). These pin them deterministically.
describe("authHeader (CTL-784)", () => {
  test("OAuth access token (lin_oauth_) → Bearer scheme", () => {
    expect(authHeader("lin_oauth_abc123")).toBe("Bearer lin_oauth_abc123");
  });
  test("personal API key (lin_api_) → raw (no Bearer)", () => {
    expect(authHeader("lin_api_xyz")).toBe("lin_api_xyz");
  });
  test("empty token → raw empty (no crash)", () => {
    expect(authHeader("")).toBe("");
    expect(authHeader()).toBe("");
  });
});

describe("buildBatchCurlArgs (CTL-784)", () => {
  const argFor = (args, flag) => args[args.indexOf(flag) + 1];

  test("posts the named CtlBatchTickets query with the ids as variables, via stdin", () => {
    const { args, payload } = buildBatchCurlArgs(["CTL-1", "CTL-2"], { token: "lin_api_x" });
    expect(args).toContain("--data");
    expect(argFor(args, "--data")).toBe("@-"); // payload via stdin, not argv
    expect(args[args.indexOf("-X") + 1]).toBe("POST");
    expect(args).toContain("https://api.linear.app/graphql");
    const body = JSON.parse(payload);
    expect(body.query).toContain("query CtlBatchTickets");
    expect(body.variables).toEqual({ ids: ["CTL-1", "CTL-2"] });
  });

  test("an OAuth token is sent as Bearer in the Authorization header", () => {
    const { args } = buildBatchCurlArgs(["CTL-1"], { token: "lin_oauth_tok" });
    expect(argFor(args, "-H")).toBe("Authorization: Bearer lin_oauth_tok");
  });

  test("a personal token is sent raw in the Authorization header", () => {
    const { args } = buildBatchCurlArgs(["CTL-1"], { token: "lin_api_tok" });
    expect(argFor(args, "-H")).toBe("Authorization: lin_api_tok");
  });

  test("--cacert is added only when the CA file exists (audit proxy), else omitted", () => {
    const withCa = buildBatchCurlArgs(["CTL-1"], { token: "t", ca: "/etc/hosts" }).args; // exists
    expect(withCa).toContain("--cacert");
    expect(argFor(withCa, "--cacert")).toBe("/etc/hosts");
    const noCa = buildBatchCurlArgs(["CTL-1"], { token: "t", ca: "/no/such/ca.pem" }).args;
    expect(noCa).not.toContain("--cacert");
    const undef = buildBatchCurlArgs(["CTL-1"], { token: "t" }).args;
    expect(undef).not.toContain("--cacert");
  });
});

describe("isBatchRateLimited (CTL-784)", () => {
  test("detects extensions.code === RATELIMITED (Linear soft/complexity limit, HTTP 400)", () => {
    expect(isBatchRateLimited([{ message: "Something", extensions: { code: "RATELIMITED" } }])).toBe(true);
  });
  test("detects a 'rate limit exceeded' message", () => {
    expect(isBatchRateLimited([{ message: "Rate limit exceeded. Only 5000 requests…" }])).toBe(true);
  });
  test("a non-rate-limit GraphQL error is NOT treated as rate-limited", () => {
    expect(isBatchRateLimited([{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }])).toBe(false);
    expect(isBatchRateLimited([])).toBe(false);
    expect(isBatchRateLimited(undefined)).toBe(false);
  });
});

// ── CTL-785: isBatchAuthError re-export contract ──
// linear-query.mjs re-exports isBatchAuthError from linear-remint.mjs so
// callers already depending on this module need no direct linear-remint
// import. Pin the re-export so an accidental removal fails a test.
describe("isBatchAuthError re-export (CTL-785)", () => {
  test("is importable from linear-query.mjs and detects AUTHENTICATION_ERROR", async () => {
    const { isBatchAuthError } = await import("./linear-query.mjs");
    expect(typeof isBatchAuthError).toBe("function");
    expect(isBatchAuthError([{ extensions: { code: "AUTHENTICATION_ERROR" } }])).toBe(true);
    expect(isBatchAuthError([{ extensions: { code: "RATELIMITED" } }])).toBe(false);
  });
});

// ── CTL-671 Phase 2: 3-valued phantom-resolution classifier ──
describe("classifyTicketResolution (CTL-671)", () => {
  test("resolvable ticket → exists", () => {
    const exec = fakeExec({
      code: 0,
      stdout: JSON.stringify({ identifier: "CTL-100", state: { name: "Ready" } }),
    });
    expect(classifyTicketResolution("CTL-100", { exec })).toBe("exists");
  });

  test("clean empty result → not-found", () => {
    // linearis exits 0 with a null node for a missing ticket
    const exec = fakeExec({ code: 0, stdout: "null" });
    expect(classifyTicketResolution("CTL-9", { exec })).toBe("not-found");
  });

  test("clean empty object → not-found (no identifier/id/state)", () => {
    const exec = fakeExec({ code: 0, stdout: "{}" });
    expect(classifyTicketResolution("CTL-9", { exec })).toBe("not-found");
  });

  test("REAL linearis missing-ticket shape (exit 0 + error body) → not-found", () => {
    // Observed contract: `linearis issues read CTL-9` exits 0 with this body.
    const exec = fakeExec({
      code: 0,
      stdout: JSON.stringify({ error: 'Issue with identifier "CTL-9" not found' }),
    });
    expect(classifyTicketResolution("CTL-9", { exec })).toBe("not-found");
  });

  test("exit-0 error body that is NOT 'not found' → unknown (auth/transient — fail safe)", () => {
    // A non-not-found error body must never quarantine a real ticket.
    const exec = fakeExec({ code: 0, stdout: JSON.stringify({ error: "Authentication required" }) });
    expect(classifyTicketResolution("CTL-100", { exec })).toBe("unknown");
  });

  test("REAL linearis resolvable shape (exit 0 + identifier/id) → exists", () => {
    const exec = fakeExec({
      code: 0,
      stdout: JSON.stringify({
        id: "36fced03-bb1e-45b4-be96-234aaab39040",
        identifier: "CTL-671",
        title: "Guard + monitor runaway phase-dispatch loops",
      }),
    });
    expect(classifyTicketResolution("CTL-671", { exec })).toBe("exists");
  });

  test("explicit not-found stderr with nonzero exit → unknown (NOT not-found — fail safe)", () => {
    // A nonzero exit is ambiguous (auth/network/not-found all exit nonzero);
    // never quarantine on it. This is the load-bearing safety assertion.
    const exec = fakeExec({ code: 1, stderr: "linearis: issue CTL-9 not found" });
    expect(classifyTicketResolution("CTL-9", { exec })).toBe("unknown");
  });

  test("auth/network failure → unknown (never quarantines a real ticket)", () => {
    const exec = fakeExec({ code: 1, stderr: "auth failed" });
    expect(classifyTicketResolution("CTL-100", { exec })).toBe("unknown");
  });

  test("unparseable stdout → unknown", () => {
    const exec = fakeExec({ code: 0, stdout: "not json" });
    expect(classifyTicketResolution("CTL-100", { exec })).toBe("unknown");
  });

  test("reads via `linearis issues read <identifier>`", () => {
    const exec = fakeExec({ code: 0, stdout: "null" });
    classifyTicketResolution("CTL-9", { exec });
    expect(exec.calls[0]).toEqual({ cmd: "linearis", args: ["issues", "read", "CTL-9"] });
  });
});

// ─── gateway read-path (CTL-823) ─────────────────────────────────────────────

function fakeGateway(descriptor) {
  const calls = [];
  return {
    calls,
    getDescriptor(ticket) {
      calls.push(ticket);
      return descriptor;
    },
  };
}

const FRESH = () => new Date().toISOString();
const STALE = () => new Date(Date.now() - 11 * 60_000).toISOString();

describe("fetchTicketState — gateway freshness window (CTL-1331 reclaim fix)", () => {
  test("a STALE descriptor is rejected at the default 60s window → falls to the live read", () => {
    let execCalls = 0;
    const exec = () => {
      execCalls++;
      return { code: 0, stdout: JSON.stringify({ state: { name: "Done" } }) };
    };
    const gateway = fakeGateway({ state: "Todo", removed: false, updatedAt: STALE() });
    // default gatewayFreshMs (60s) → the 11-min-stale descriptor is rejected → live read.
    expect(fetchTicketState("CTL-9", { exec, gateway })).toBe("Done");
    expect(execCalls).toBe(1); // the slow `linearis` exec ran (the reclaim-lap spike)
  });

  test("a large gatewayFreshMs ACCEPTS a stale descriptor → ZERO live read (the reclaim fix)", () => {
    let execCalls = 0;
    const exec = () => {
      execCalls++;
      return { code: 0, stdout: JSON.stringify({ state: { name: "Done" } }) };
    };
    const gateway = fakeGateway({ state: "Todo", removed: false, updatedAt: STALE() });
    // unbounded freshness → the stale read-replica descriptor is trusted → no exec.
    expect(
      fetchTicketState("CTL-9", { exec, gateway, gatewayFreshMs: Number.MAX_SAFE_INTEGER })
    ).toBe("Todo");
    expect(execCalls).toBe(0); // the slow `linearis` exec is NEVER reached
  });
});

describe("classifyTicketResolution — gateway short-circuit (CTL-823)", () => {
  test("fresh + present + not-removed → exists with ZERO live reads", () => {
    const exec = fakeExec({ code: 0, stdout: "{}" });
    const gateway = fakeGateway({ ticket: "CTL-1", removed: false, updatedAt: FRESH() });
    expect(classifyTicketResolution("CTL-1", { exec, gateway })).toBe("exists");
    expect(exec.calls.length).toBe(0);
  });

  test("removed descriptor NEVER short-circuits — exactly one live re-read (fresh-before-quarantine)", () => {
    const exec = fakeExec({
      code: 0,
      stdout: JSON.stringify({ error: "Issue not found" }),
    });
    const gateway = fakeGateway({ ticket: "CTL-2", removed: true, updatedAt: FRESH() });
    expect(classifyTicketResolution("CTL-2", { exec, gateway })).toBe("not-found");
    expect(exec.calls.length).toBe(1); // the destructive verdict paid a live read
  });

  test("stale descriptor falls through to the live read", () => {
    const exec = fakeExec({
      code: 0,
      stdout: JSON.stringify({ identifier: "CTL-3" }),
    });
    const gateway = fakeGateway({ ticket: "CTL-3", removed: false, updatedAt: STALE() });
    expect(classifyTicketResolution("CTL-3", { exec, gateway })).toBe("exists");
    expect(exec.calls.length).toBe(1);
  });

  test("gateway miss (null) falls through to the live read", () => {
    const exec = fakeExec({ code: 0, stdout: JSON.stringify({ identifier: "CTL-4" }) });
    const gateway = fakeGateway(null);
    expect(classifyTicketResolution("CTL-4", { exec, gateway })).toBe("exists");
    expect(exec.calls.length).toBe(1);
  });

  test("a gateway 'exists' hit can never quarantine: only the NOT-quarantine case is served", () => {
    // mutation guard: if someone makes a removed/absent descriptor return
    // "not-found" from the store, this test pins the contract that the store
    // can short-circuit ONLY the exists verdict.
    const exec = fakeExec({ code: 1, stdout: "" }); // live read unavailable
    const gateway = fakeGateway({ ticket: "CTL-5", removed: true, updatedAt: FRESH() });
    expect(classifyTicketResolution("CTL-5", { exec, gateway })).toBe("unknown");
  });

  test("no gateway param → behavior unchanged", () => {
    const exec = fakeExec({ code: 0, stdout: JSON.stringify({ identifier: "CTL-6" }) });
    expect(classifyTicketResolution("CTL-6", { exec })).toBe("exists");
    expect(exec.calls.length).toBe(1);
  });
});

describe("fetchTicketState — gateway read-path (CTL-823)", () => {
  test("fresh descriptor state serves with zero live reads and warms the cache", () => {
    const exec = fakeExec({ code: 0, stdout: "{}" });
    const gateway = fakeGateway({ ticket: "CTL-7", state: "Todo", removed: false, updatedAt: FRESH() });
    const cache = createTicketStateCache();
    expect(fetchTicketState("CTL-7", { exec, gateway, cache })).toBe("Todo");
    expect(exec.calls.length).toBe(0);
    expect(cache.get("CTL-7")).toBe("Todo"); // in-memory cache warmed from the store
  });

  test("stale descriptor falls through to live read", () => {
    const exec = fakeExec({
      code: 0,
      stdout: JSON.stringify({ state: { name: "PR" } }),
    });
    const gateway = fakeGateway({ ticket: "CTL-8", state: "Todo", removed: false, updatedAt: STALE() });
    expect(fetchTicketState("CTL-8", { exec, gateway })).toBe("PR");
    expect(exec.calls.length).toBe(1);
  });

  test("removed or stateless descriptor falls through to live read", () => {
    const exec = fakeExec({ code: 0, stdout: JSON.stringify({ state: { name: "PR" } }) });
    const gw1 = fakeGateway({ ticket: "CTL-9", state: "Todo", removed: true, updatedAt: FRESH() });
    expect(fetchTicketState("CTL-9", { exec, gateway: gw1 })).toBe("PR");
    const gw2 = fakeGateway({ ticket: "CTL-10", state: null, removed: false, updatedAt: FRESH() });
    expect(fetchTicketState("CTL-10", { exec, gateway: gw2 })).toBe("PR");
  });

  test("in-memory cache hit still wins before the gateway is consulted", () => {
    const gateway = fakeGateway({ ticket: "CTL-11", state: "Todo", removed: false, updatedAt: FRESH() });
    const cache = createTicketStateCache();
    cache.set("CTL-11", "Implement");
    expect(fetchTicketState("CTL-11", { gateway, cache })).toBe("Implement");
    expect(gateway.calls.length).toBe(0);
  });
});

describe("fetchTicketState — gateway state-freshness boundary (CTL-823)", () => {
  test("59s-old descriptor serves from the store; 61s falls through live", () => {
    const at = (ms) => new Date(Date.now() - ms).toISOString();
    const exec = fakeExec({ code: 0, stdout: JSON.stringify({ state: { name: "PR" } }) });
    const fresh = fakeGateway({ ticket: "CTL-20", state: "Todo", removed: false, updatedAt: at(59_000) });
    expect(fetchTicketState("CTL-20", { exec, gateway: fresh })).toBe("Todo");
    expect(exec.calls.length).toBe(0);
    const stale = fakeGateway({ ticket: "CTL-21", state: "Todo", removed: false, updatedAt: at(61_000) });
    expect(fetchTicketState("CTL-21", { exec, gateway: stale })).toBe("PR");
    expect(exec.calls.length).toBe(1);
  });
});

// ─── CTL-781: fetchTicketAssignee + isAssigneeClaimable ─────────────────────

describe("fetchTicketAssignee (CTL-781)", () => {
  const BOT = "ff78d890-7906-4c22-b2f5-020bd150c790";
  const HUMAN = "11111111-1111-1111-1111-111111111111";

  test("gateway hit, delegate cached null → CONFIRMS LIVE via fetchDelegate (latch fix); zero exec", () => {
    const exec = fakeExec({ code: 0, stdout: "{}" });
    const gateway = fakeGateway({ ticket: "CTL-1", assignee: BOT, removed: false, updatedAt: FRESH() });
    const fetchDelegate = mock(() => ({ known: true, delegate: null }));
    const r = fetchTicketAssignee("CTL-1", { exec, gateway, fetchDelegate });
    expect(r).toEqual({ known: true, assignee: BOT, delegate: null });
    expect(exec.calls.length).toBe(0); // live confirm uses fetchDelegate (curl), not exec
    expect(fetchDelegate).toHaveBeenCalledTimes(1); // cached-null is confirmed live (CTL-1174 latch fix)
  });

  test("gateway hit, assignee null + delegate cached null → confirms live; zero exec", () => {
    const exec = fakeExec({ code: 0, stdout: "{}" });
    const gateway = fakeGateway({ ticket: "CTL-2", assignee: null, removed: false, updatedAt: FRESH() });
    const fetchDelegate = mock(() => ({ known: true, delegate: null }));
    const r = fetchTicketAssignee("CTL-2", { exec, gateway, fetchDelegate });
    expect(r).toEqual({ known: true, assignee: null, delegate: null });
    expect(exec.calls.length).toBe(0);
    expect(fetchDelegate).toHaveBeenCalledTimes(1);
  });

  test("LATCH FIX: gateway delegate cached null but LIVE delegate is the bot → returns delegate:BOT (gate sees its own write)", () => {
    const exec = fakeExec({ code: 0, stdout: "{}" });
    const gateway = fakeGateway({ ticket: "CTL-2b", assignee: HUMAN, removed: false, updatedAt: FRESH() });
    const fetchDelegate = mock(() => ({ known: true, delegate: BOT })); // delegate landed live after self-delegation
    const r = fetchTicketAssignee("CTL-2b", { exec, gateway, fetchDelegate });
    expect(r).toEqual({ known: true, assignee: HUMAN, delegate: BOT });
  });

  test("LATCH: gateway delegate cached null + live read unreadable → {known:false} (HOLD, never claim on unknown)", () => {
    const exec = fakeExec({ code: 0, stdout: "{}" });
    const gateway = fakeGateway({ ticket: "CTL-2c", assignee: null, removed: false, updatedAt: FRESH() });
    const fetchDelegate = mock(() => ({ known: false }));
    const r = fetchTicketAssignee("CTL-2c", { exec, gateway, fetchDelegate });
    expect(r).toEqual({ known: false });
  });

  test("gateway delegate cached NON-null (BOT) → authoritative, fetchDelegate NOT called (rate-free)", () => {
    const exec = fakeExec({ code: 0, stdout: "{}" });
    const gateway = fakeGateway({ ticket: "CTL-2d", assignee: HUMAN, delegate: BOT, removed: false, updatedAt: FRESH() });
    const fetchDelegate = mock(() => ({ known: true, delegate: null }));
    const r = fetchTicketAssignee("CTL-2d", { exec, gateway, fetchDelegate });
    expect(r).toEqual({ known: true, assignee: HUMAN, delegate: BOT });
    expect(fetchDelegate).not.toHaveBeenCalled(); // non-null cached delegate is authoritative
  });

  test("gateway descriptor removed → falls through to live read (CTL-1174: injects fetchDelegate)", () => {
    const exec = fakeExec({ code: 0, stdout: JSON.stringify({ assignee: { id: BOT } }) });
    const gateway = fakeGateway({ ticket: "CTL-3", assignee: BOT, removed: true, updatedAt: FRESH() });
    // CTL-1174: gateway miss now also fetches delegate; inject to avoid real curl
    const fetchDelegate = () => ({ known: true, delegate: null });
    const r = fetchTicketAssignee("CTL-3", { exec, gateway, fetchDelegate });
    expect(r).toEqual({ known: true, assignee: BOT, delegate: null });
    expect(exec.calls.length).toBe(1);
  });

  test("gateway absent/miss (getDescriptor null) → live read parses assignee.id (CTL-1174: injects fetchDelegate)", () => {
    const exec = fakeExec({ code: 0, stdout: JSON.stringify({ assignee: { id: BOT } }) });
    const gateway = fakeGateway(null);
    // CTL-1174: gateway miss now also fetches delegate; inject to avoid real curl
    const fetchDelegate = () => ({ known: true, delegate: null });
    const r = fetchTicketAssignee("CTL-4", { exec, gateway, fetchDelegate });
    expect(r).toEqual({ known: true, assignee: BOT, delegate: null });
    expect(exec.calls.length).toBe(1);
  });

  test("live read: top-level assignee null → {known:true, assignee:null}", () => {
    const exec = fakeExec({ code: 0, stdout: JSON.stringify({ assignee: null }) });
    const r = fetchTicketAssignee("CTL-5", { exec });
    expect(r).toEqual({ known: true, assignee: null });
  });

  test("live read non-zero exit → {known:false}", () => {
    const exec = fakeExec({ code: 1, stdout: "", stderr: "fail" });
    const r = fetchTicketAssignee("CTL-6", { exec });
    expect(r).toEqual({ known: false });
  });

  test("live read unparseable stdout → {known:false}", () => {
    const exec = fakeExec({ code: 0, stdout: "not-json" });
    const r = fetchTicketAssignee("CTL-7", { exec });
    expect(r).toEqual({ known: false });
  });

  test("no gateway param at all → straight to live read", () => {
    const exec = fakeExec({ code: 0, stdout: JSON.stringify({ assignee: { id: BOT } }) });
    const r = fetchTicketAssignee("CTL-8", { exec });
    expect(r).toEqual({ known: true, assignee: BOT });
    expect(exec.calls.length).toBe(1);
  });
});

describe("isAssigneeClaimable (CTL-781)", () => {
  const BOT = "ff78d890-7906-4c22-b2f5-020bd150c790";

  test("null assignee → claimable regardless of botUserIds", () => {
    expect(isAssigneeClaimable(null, new Set([BOT]))).toBe(true);
    expect(isAssigneeClaimable(null, new Set())).toBe(true);
    expect(isAssigneeClaimable(null, undefined)).toBe(true);
  });

  test("assignee in botUserIds Set → claimable", () => {
    expect(isAssigneeClaimable(BOT, new Set([BOT]))).toBe(true);
  });

  test("assignee NOT in botUserIds Set → NOT claimable", () => {
    expect(isAssigneeClaimable("human-uuid", new Set([BOT]))).toBe(false);
  });

  test("empty botUserIds Set + non-null assignee → NOT claimable", () => {
    expect(isAssigneeClaimable(BOT, new Set())).toBe(false);
    expect(isAssigneeClaimable("human-uuid", new Set())).toBe(false);
  });
});

// ── buildDelegateCurlArgs (CTL-1173) ──────────────────────────────────────────

describe("buildDelegateCurlArgs (CTL-1173)", () => {
  test("POSTs to the GraphQL endpoint", () => {
    const { args } = buildDelegateCurlArgs("CTL-1", { token: "lin_oauth_x" });
    expect(args).toContain("https://api.linear.app/graphql");
    expect(args).toContain("-X");
    expect(args[args.indexOf("-X") + 1]).toBe("POST");
  });

  test("reads payload from stdin (--data @-)", () => {
    const { args } = buildDelegateCurlArgs("CTL-1", { token: "lin_oauth_x" });
    expect(args).toContain("--data");
    expect(args[args.indexOf("--data") + 1]).toBe("@-");
  });

  test("sets Authorization: Bearer for oauth token", () => {
    const { args } = buildDelegateCurlArgs("CTL-1", { token: "lin_oauth_x" });
    const hIdx = args.indexOf("-H");
    expect(args[hIdx + 1]).toBe("Authorization: Bearer lin_oauth_x");
  });

  test("payload projects delegate field and passes parsed team+number as variables", () => {
    const { payload } = buildDelegateCurlArgs("CTL-1", { token: "lin_oauth_x" });
    expect(payload).toContain("delegate");
    // IssueFilter has no `identifier`; the identifier is parsed to team key + number.
    expect(JSON.parse(payload).variables).toEqual({ team: "CTL", num: 1 });
    expect(JSON.parse(payload).query).toContain("team: { key: { eq: $team } }, number: { eq: $num }");
  });
});

// ── fetchTicketDelegate (CTL-1173) ────────────────────────────────────────────

describe("fetchTicketDelegate (CTL-1173)", () => {
  const BOT = "ff78d890-7906-4c22-b2f5-020bd150c790";

  test("delegate present → { known:true, delegate:<id> }", () => {
    const runQuery = () => ({ nodes: [{ delegate: { id: BOT } }] });
    expect(fetchTicketDelegate("CTL-1", { runQuery })).toEqual({ known: true, delegate: BOT });
  });

  test("no delegate → { known:true, delegate:null }", () => {
    const runQuery = () => ({ nodes: [{ delegate: null }] });
    expect(fetchTicketDelegate("CTL-1", { runQuery })).toEqual({ known: true, delegate: null });
  });

  test("read failed (nodes null) → { known:false }", () => {
    const runQuery = () => ({ nodes: null });
    expect(fetchTicketDelegate("CTL-1", { runQuery })).toEqual({ known: false });
  });

  test("empty nodes array → { known:true, delegate:null }", () => {
    const runQuery = () => ({ nodes: [] });
    expect(fetchTicketDelegate("CTL-1", { runQuery })).toEqual({ known: true, delegate: null });
  });
});

// ── isClaimable (CTL-1174) ────────────────────────────────────────────────────

describe("isClaimable (CTL-1174 — delegate-ONLY)", () => {
  const BOT = "bot-uuid-ff78d890";
  const HUMAN = "human-uuid-abcd1234";
  const bots = new Set([BOT]);

  test("delegated to our orchestrator → claimable, regardless of assignee", () => {
    expect(isClaimable(null, BOT, bots)).toBe(true);
    expect(isClaimable(HUMAN, BOT, bots)).toBe(true); // assignee irrelevant — the whole point
  });

  test("UNDELEGATED → NOT claimable (must be delegated-on-Todo first), regardless of assignee", () => {
    expect(isClaimable(null, null, bots)).toBe(false);
    expect(isClaimable(HUMAN, null, bots)).toBe(false);
    expect(isClaimable(BOT, null, bots)).toBe(false);
  });

  test("undefined delegate coerced to null → NOT claimable (no-gateway shape = not yet delegated)", () => {
    expect(isClaimable(null, undefined, bots)).toBe(false);
    expect(isClaimable(BOT, undefined, bots)).toBe(false);
  });

  test("delegated to a DIFFERENT actor → not ours", () => {
    expect(isClaimable(null, "foreign-uuid-xyz", bots)).toBe(false);
    expect(isClaimable(HUMAN, "foreign-uuid-xyz", bots)).toBe(false);
  });

  test("the human ASSIGNEE is irrelevant — verdict depends only on the delegate", () => {
    expect(isClaimable(HUMAN, BOT, bots)).toBe(isClaimable(null, BOT, bots));
    expect(isClaimable(HUMAN, null, bots)).toBe(isClaimable(null, null, bots));
  });

  test("empty/absent botUserIds → false (the call-site wrapper disables the gate; the predicate itself is strict)", () => {
    expect(isClaimable(null, BOT, new Set())).toBe(false);
    expect(isClaimable(null, BOT, undefined)).toBe(false);
  });
});

// ── buildDelegateBatchCurlArgs (CTL-1174) ────────────────────────────────────

describe("buildDelegateBatchCurlArgs (CTL-1174)", () => {
  test("POSTs to the GraphQL endpoint", () => {
    const { args } = buildDelegateBatchCurlArgs("CTL", ["CTL-1"], { token: "lin_oauth_x" });
    expect(args).toContain("https://api.linear.app/graphql");
    expect(args[args.indexOf("-X") + 1]).toBe("POST");
  });

  test("reads payload from stdin (--data @-)", () => {
    const { args } = buildDelegateBatchCurlArgs("CTL", ["CTL-1"], { token: "lin_oauth_x" });
    expect(args[args.indexOf("--data") + 1]).toBe("@-");
  });

  test("variables include team and parsed ticket numbers", () => {
    const { payload } = buildDelegateBatchCurlArgs("CTL", ["CTL-1", "CTL-42"], { token: "lin_oauth_x" });
    const vars = JSON.parse(payload).variables;
    expect(vars.team).toBe("CTL");
    expect(vars.nums).toEqual([1, 42]);
  });

  test("query projects identifier and delegate fields", () => {
    const { payload } = buildDelegateBatchCurlArgs("CTL", ["CTL-1"], { token: "lin_oauth_x" });
    const q = JSON.parse(payload).query;
    expect(q).toContain("identifier");
    expect(q).toContain("delegate");
  });

  test("malformed identifiers are excluded from nums (not NaN)", () => {
    const { payload } = buildDelegateBatchCurlArgs("CTL", ["CTL-1", "NOTANID"], { token: "tok" });
    const vars = JSON.parse(payload).variables;
    expect(vars.nums).toEqual([1]);
  });
});

// ── fetchTicketsDelegateBatch (CTL-1174) ─────────────────────────────────────

describe("fetchTicketsDelegateBatch (CTL-1174)", () => {
  const BOT = "bot-uuid-ff78d890";

  test("empty identifiers → empty Map, exec NOT called", () => {
    const calls = [];
    const exec = (...a) => { calls.push(a); return []; };
    const result = fetchTicketsDelegateBatch("CTL", [], { exec });
    expect(result.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("null team → empty Map, exec NOT called", () => {
    const calls = [];
    const exec = (...a) => { calls.push(a); return []; };
    const result = fetchTicketsDelegateBatch(null, ["CTL-1"], { exec });
    expect(result.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("nodes with delegate id → Map<identifier, delegateId>", () => {
    const exec = () => [
      { identifier: "CTL-1", delegate: { id: BOT } },
      { identifier: "CTL-2", delegate: null },
    ];
    const result = fetchTicketsDelegateBatch("CTL", ["CTL-1", "CTL-2"], { exec });
    expect(result.get("CTL-1")).toBe(BOT);
    expect(result.get("CTL-2")).toBeNull();
  });

  test("exec returns null → fail-safe empty Map (no crash)", () => {
    const exec = () => null;
    expect(() => fetchTicketsDelegateBatch("CTL", ["CTL-1"], { exec })).not.toThrow();
    expect(fetchTicketsDelegateBatch("CTL", ["CTL-1"], { exec }).size).toBe(0);
  });

  test("deduplicates identifiers before passing to exec", () => {
    const calls = [];
    const exec = (team, ids) => { calls.push(ids.slice()); return []; };
    fetchTicketsDelegateBatch("CTL", ["CTL-1", "CTL-1", "CTL-2"], { exec });
    expect(calls[0]).toHaveLength(2);
    expect(calls[0]).toContain("CTL-1");
    expect(calls[0]).toContain("CTL-2");
  });

  test("absent id from exec result stays absent from Map (not mapped to null)", () => {
    const exec = () => [{ identifier: "CTL-1", delegate: { id: BOT } }];
    const result = fetchTicketsDelegateBatch("CTL", ["CTL-1", "CTL-2"], { exec });
    expect(result.has("CTL-1")).toBe(true);
    expect(result.has("CTL-2")).toBe(false);
  });
});

// ── runEligibleQuery — delegate enrichment (CTL-1174) ─────────────────────────

describe("runEligibleQuery — delegate enrichment (CTL-1174)", () => {
  const query = { team: "CTL", status: "Todo", project: null, label: null, priority: null };
  const BOT = "bot-uuid-ff78d890";

  test("normalizeTicket defaults delegate to null when linearis omits it", () => {
    const exec = fakeExec({ stdout: ticketsJson([{ identifier: "CTL-1", state: { name: "Todo" } }]) });
    // delegateExec miss → null → delegate stays null
    const delegateExec = () => null;
    const tickets = runEligibleQuery(query, { exec, delegateExec });
    expect(tickets[0].delegate).toBeNull();
  });

  test("delegate hydrated from batch when id returned", () => {
    const exec = fakeExec({ stdout: ticketsJson([{ identifier: "CTL-1", state: { name: "Todo" } }]) });
    const delegateExec = () => [{ identifier: "CTL-1", delegate: { id: BOT } }];
    const tickets = runEligibleQuery(query, { exec, delegateExec });
    expect(tickets[0].delegate).toBe(BOT);
  });

  test("delegate null when batch returns node with null delegate (explicit clear)", () => {
    const exec = fakeExec({ stdout: ticketsJson([{ identifier: "CTL-1", state: { name: "Todo" } }]) });
    const delegateExec = () => [{ identifier: "CTL-1", delegate: null }];
    const tickets = runEligibleQuery(query, { exec, delegateExec });
    expect(tickets[0].delegate).toBeNull();
  });

  test("batch failure → delegate stays null, no throw (best-effort fail-safe)", () => {
    const exec = fakeExec({ stdout: ticketsJson([{ identifier: "CTL-1", state: { name: "Todo" } }]) });
    const delegateExec = () => { throw new Error("network failure"); };
    let tickets;
    expect(() => { tickets = runEligibleQuery(query, { exec, delegateExec }); }).not.toThrow();
    expect(tickets[0].delegate).toBeNull();
  });

  test("skips delegate batch entirely when zero tickets survive priority floor", () => {
    // priority: 4 (Low) tickets filtered by floor 2 → 0 survive → no batch call
    const exec = fakeExec({
      stdout: ticketsJson([{ identifier: "CTL-1", state: { name: "Todo" }, priority: 4 }]),
    });
    const calls = [];
    const delegateExec = (...a) => { calls.push(a); return null; };
    runEligibleQuery({ ...query, priority: 2 }, { exec, delegateExec });
    expect(calls).toHaveLength(0);
  });
});
