// Unit tests for the execution-core Linear eligible query (CTL-535 Phase 2).
// Run: cd plugins/dev/scripts/execution-core && bun test linear-query.test.mjs

import { describe, test, expect } from "bun:test";
import {
  buildLinearisArgs,
  runEligibleQuery,
  fetchTicketState,
  fetchTicketLabels,
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
