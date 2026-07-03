// Unit tests for the execution-core Linear eligible query (CTL-535 Phase 2).
// Run: cd plugins/dev/scripts/execution-core && bun test linear-query.test.mjs

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetDispatchAlertThrottle } from "./dispatch-alert.mjs";
import {
  buildLinearisArgs,
  runEligibleQuery,
  __resetEligibleEmptyConfirm,
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
  parseTerminalTimeoutMs,
  __rawExecForTest,
} from "./linear-query.mjs";
import { createTicketStateCache } from "./linear-cache.mjs";
import { isLinearTerminal } from "./terminal-state.mjs"; // CTL-1340: replica-tier terminal assertions
import { linearBreaker } from "./linear-breaker.mjs"; // CTL-1420: reset the shared breaker singleton between empty-path tests

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

// CTL-1397 — the replica-backed board-list tier. When a `replica` with an
// eligible() method is injected and it RETURNS { nodes } (a valid answer), the
// query is served from the local Catalyst-Cloud SQLite replica WITHOUT shelling
// out to `linearis issues list` — the durable fix for the fleet board-freeze
// (the linearis discovery query burns the shared quota + trips the CTL-679
// breaker). The linearis path stays UNCHANGED as the fall-through when the
// replica does not serve (undefined). `onSource("replica"|"linearis", n)` is the
// OTEL/Loki verification marker.
describe("runEligibleQuery — replica tier (CTL-1397)", () => {
  const query = { team: "CTL", status: "Todo", project: null, label: null, priority: null };

  // CTL-1397 (3/n): the empty-board re-confirm cadence is module-scoped state —
  // clear it before each test so an empty result is always "due" for re-confirm
  // (the deterministic baseline), regardless of test order.
  // CTL-1420: the CTL-679 breaker is a process-wide singleton that a prior test
  // in this file can leave OPEN; the default breakerIsOpen reads it, so reset it
  // to CLOSED here for a deterministic baseline. Tests that exercise the
  // breaker-open freeze-avoidance path inject breakerIsOpen:()=>true explicitly.
  beforeEach(() => {
    __resetEligibleEmptyConfirm();
    linearBreaker.recordSuccess(); // → closed (no-op if already closed)
  });

  // A replica stub whose eligible() returns a canned linearis-list-shaped result.
  function replicaReturning(nodes) {
    const calls = [];
    return {
      calls,
      eligible: (q) => {
        calls.push(q);
        return { nodes };
      },
    };
  }

  // An exec that fails the test if it is ever called — proves the replica path
  // does NOT shell out to linearis.
  function execMustNotRun() {
    const fn = () => {
      throw new Error("linearis exec must NOT run on a replica HIT");
    };
    return fn;
  }

  test("HIT: serves from the replica, never calls exec, normalizes + records onSource('replica')", () => {
    const replica = replicaReturning([
      {
        identifier: "CTL-100",
        title: "Repoint board-list",
        state: "Todo",
        priority: 2,
        estimate: 3,
        project: "Harden the core",
        updatedAt: "2026-06-01T00:00:00Z",
        createdAt: "2026-05-01T00:00:00Z",
        parent: "CTL-1",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
        delegate: { id: "del-1", name: "Bot" },
      },
    ]);
    const sources = [];
    const tickets = runEligibleQuery(query, {
      exec: execMustNotRun(),
      replica,
      onSource: (source, count) => sources.push([source, count]),
    });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      identifier: "CTL-100",
      state: "Todo",
      priority: 2,
      estimate: 3,
      project: "Harden the core",
      parent: "CTL-1",
      delegate: "del-1", // normalizeTicket flattens delegate.id
    });
    expect(replica.calls).toEqual([query]); // eligible() received the query
    expect(sources).toEqual([["replica", 1]]);
  });

  test("HIT applies the priority floor (same filter as the linearis path)", () => {
    const replica = replicaReturning([
      { identifier: "CTL-1", state: "Todo", priority: 1 },
      { identifier: "CTL-2", state: "Todo", priority: 2 },
      { identifier: "CTL-3", state: "Todo", priority: 3 },
      { identifier: "CTL-0", state: "Todo", priority: 0 },
    ]);
    const tickets = runEligibleQuery({ ...query, priority: 2 }, {
      exec: execMustNotRun(),
      replica,
    });
    expect(tickets.map((t) => t.identifier).sort()).toEqual(["CTL-1", "CTL-2"]);
  });

  // CTL-1397 (3/n) — a SEED-COMPLETE replica-empty is TRUSTED locally, but ONLY
  // within EMPTY_RECONFIRM_MS of a SUCCESSFUL EMPTY linearis confirmation. So empty
  // Todo boards (the steady state) stay breaker-immune (≤1 confirm/team/window),
  // yet a feed-hole (CTL-139: cursor present but a team's rows dropped, presenting
  // as empty) is never trusted as empty. Only a SUCCESSFUL EMPTY confirm caches;
  // a failed or non-empty confirm never suppresses the next one.

  test("replica-EMPTY, no recent confirm → falls through; a NON-EMPTY confirm (feed-hole) serves the real board and does NOT cache", () => {
    const replica = replicaReturning([]);
    let clock = 1_000_000;
    const now = () => clock;
    const execCalls = [];
    const mkExec = () => () => {
      execCalls.push(clock);
      return { code: 0, stdout: ticketsJson([{ identifier: "CTL-9", state: { name: "Todo" }, priority: 2 }]), stderr: "" };
    };
    // CTL-1420: pin the breaker CLOSED — this test exercises the closed-breaker
    // reconfirm cadence. (The non-empty confirm's default delegate-batch spawn can
    // 429 and trip the real breaker singleton; without pinning, the 2nd call would
    // hit the breaker-open freeze-avoidance branch and trust the empty.) A stub
    // delegateExec also keeps the unit test off the network.
    const opts = { replica, now, breakerIsOpen: () => false, delegateExec: () => ({ code: 0, stdout: "{}", stderr: "" }) };
    const t1 = runEligibleQuery(query, { exec: mkExec(), ...opts });
    expect(t1.map((t) => t.identifier)).toEqual(["CTL-9"]); // real board served (hole)
    // 1s later: the non-empty confirm did NOT cache → still falls through (no zeroing).
    clock += 1_000;
    const t2 = runEligibleQuery(query, { exec: mkExec(), ...opts });
    expect(execCalls).toHaveLength(2); // linearis called BOTH times — never suppressed
    expect(t2.map((t) => t.identifier)).toEqual(["CTL-9"]);
  });

  test("replica-EMPTY, a SUCCESSFUL EMPTY confirm caches → a subsequent empty within the window TRUSTS the replica (no exec), onSource('replica', 0)", () => {
    const replica = replicaReturning([]);
    let clock = 3_000_000;
    const now = () => clock;
    // Prime: a successful EMPTY linearis confirmation caches the agreement.
    const primeExec = fakeExec({ stdout: ticketsJson([]) });
    runEligibleQuery(query, { exec: primeExec, replica, now });
    expect(primeExec.calls).toHaveLength(1);
    // 1s later: trusted from the replica, NO linearis call.
    clock += 1_000;
    const sources = [];
    const t = runEligibleQuery(query, {
      exec: execMustNotRun(),
      replica,
      now,
      onSource: (source, count) => sources.push([source, count]),
    });
    expect(t).toEqual([]);
    expect(sources).toEqual([["replica", 0]]);
  });

  test("replica-EMPTY, a FAILED confirm does NOT cache → the next reconcile still confirms (not suppressed by a doomed attempt)", () => {
    const replica = replicaReturning([]);
    let clock = 2_000_000;
    const now = () => clock;
    // First confirm throws (non-breaker failure, e.g. auth) → propagates, no cache.
    expect(() => runEligibleQuery(query, { exec: fakeExec({ code: 1, stderr: "auth" }), replica, now })).toThrow(/exit 1/);
    // 1s later: no recent SUCCESSFUL empty confirm → falls through again (re-confirms).
    clock += 1_000;
    const exec2 = fakeExec({ stdout: ticketsJson([]) });
    runEligibleQuery(query, { exec: exec2, replica, now });
    expect(exec2.calls).toHaveLength(1);
  });

  // CTL-1420 (freeze-avoidance): the pre-1420 behavior was to THROW here →
  // reconcileProject preserved the (empty) prior set → a fleet-wide admission
  // FREEZE for the breaker's whole open window. Now a DEFINED replica-empty
  // (which already cleared the reader's writer-liveness + seed-complete +
  // snapshot gates) is TRUSTED during breaker-open instead of freezing. The
  // linearis reconfirm is never attempted (it could only short-circuit anyway).
  test("CTL-1420: replica-EMPTY, breaker OPEN, no recent confirm → TRUSTS the fresh replica-empty (no linearis, no throw), onSource('replica-empty-breaker-open', 0)", () => {
    const replica = replicaReturning([]);
    const sources = [];
    const tickets = runEligibleQuery(query, {
      exec: execMustNotRun(), // proves the doomed linearis reconfirm is skipped
      replica,
      breakerIsOpen: () => true,
      onSource: (source, count) => sources.push([source, count]),
    });
    expect(tickets).toEqual([]);
    expect(sources).toEqual([["replica-empty-breaker-open", 0]]);
    expect(replica.calls).toEqual([query]); // the replica WAS consulted
  });

  // CTL-1420: the fix is breaker-GATED — a CLOSED breaker preserves the exact
  // pre-1420 behavior (fall through to the linearis confirm so a feed-hole is
  // never trusted as empty; the ≤1-confirm/team/window cadence is intact).
  test("CTL-1420: replica-EMPTY, breaker CLOSED, no recent confirm → still falls through to the linearis confirm (unchanged)", () => {
    const replica = replicaReturning([]);
    const exec = fakeExec({ stdout: ticketsJson([]) });
    const sources = [];
    const tickets = runEligibleQuery(query, {
      exec,
      replica,
      breakerIsOpen: () => false,
      onSource: (source, count) => sources.push([source, count]),
    });
    expect(exec.calls).toHaveLength(1); // linearis WAS called (breaker closed)
    expect(tickets).toEqual([]);
    expect(sources).toEqual([["linearis", 0]]); // served + cached by the linearis path
  });

  // CTL-1420: a breaker-open reconcile must NEVER fabricate work — a genuinely
  // NON-EMPTY replica is still served verbatim (the freeze-avoidance branch only
  // fires on an empty board), so real Todo work dispatches during a quota storm.
  test("CTL-1420: replica NON-EMPTY, breaker OPEN → serves the real board (freeze-avoidance never masks real work)", () => {
    const replica = replicaReturning([{ identifier: "CTL-1416", state: "Todo", priority: 2 }]);
    const sources = [];
    const tickets = runEligibleQuery(query, {
      exec: execMustNotRun(),
      replica,
      breakerIsOpen: () => true,
      onSource: (source, count) => sources.push([source, count]),
    });
    expect(tickets.map((t) => t.identifier)).toEqual(["CTL-1416"]);
    expect(sources).toEqual([["replica", 1]]);
  });

  // CTL-1420 review finding (guard): the freeze-avoidance branch trusts the empty
  // WITHOUT caching the empty-confirm marker. If it did cache it, the linearis
  // reconfirm would be suppressed for EMPTY_RECONFIRM_MS after the breaker closes
  // — trusting a CTL-139 feed-hole as a real empty board. This asserts the marker
  // stays unset: once the breaker closes, an empty STILL reconfirms via linearis.
  test("CTL-1420: breaker-open trust does NOT cache the empty-confirm marker → after the breaker closes the next empty still reconfirms via linearis", () => {
    const replica = replicaReturning([]);
    // Breaker OPEN: trust the empty, no exec, and (crucially) no marker cached.
    const t1 = runEligibleQuery(query, { exec: execMustNotRun(), replica, breakerIsOpen: () => true });
    expect(t1).toEqual([]);
    // Breaker now CLOSED: if the open branch had cached the marker, this empty
    // would be trusted with NO linearis call. It must reconfirm instead.
    const exec = fakeExec({ stdout: ticketsJson([]) });
    const sources = [];
    const t2 = runEligibleQuery(query, {
      exec,
      replica,
      breakerIsOpen: () => false,
      onSource: (source, count) => sources.push([source, count]),
    });
    expect(exec.calls).toHaveLength(1); // reconfirmed — the open branch left the marker unset
    expect(t2).toEqual([]);
    expect(sources).toEqual([["linearis", 0]]);
  });

  test("cadence: after a successful empty confirm, empties trust the replica until the window elapses, then re-confirm once per team", () => {
    const replica = replicaReturning([]);
    let clock = 5_000_000;
    const now = () => clock;
    const execCalls = [];
    const mkExec = () => () => {
      execCalls.push(clock);
      return { code: 0, stdout: ticketsJson([]), stderr: "" };
    };
    const call = () => runEligibleQuery(query, { exec: mkExec(), replica, now });
    call(); // t0: cold → linearis confirms empty → caches
    clock += 60_000; call(); // +1m: within window → trust replica (no exec)
    clock += 60_000; call(); // +2m: within window → trust replica (no exec)
    clock += 200_000; call(); // +5m20s (past window) → re-confirm via linearis
    expect(execCalls).toEqual([5_000_000, 5_320_000]); // exactly two confirms
  });

  test("replica filtered EMPTY by the priority floor → same confirmed-empty gating (trusts only within the window)", () => {
    const replica = replicaReturning([
      { identifier: "CTL-3", state: "Todo", priority: 3 },
      { identifier: "CTL-4", state: "Todo", priority: 4 },
    ]);
    let clock = 9_000_000;
    const now = () => clock;
    // First: filtered-empty, cold → confirms via linearis (empty) → caches.
    runEligibleQuery({ ...query, priority: 2 }, { exec: fakeExec({ stdout: ticketsJson([]) }), replica, now });
    clock += 1_000;
    const tickets = runEligibleQuery({ ...query, priority: 2 }, { exec: execMustNotRun(), replica, now });
    expect(tickets).toEqual([]); // within window → trusts the filtered-empty replica result
  });

  test("MISS (eligible() → undefined): falls through to the linearis exec, records onSource('linearis')", () => {
    const replica = { eligible: () => undefined };
    const exec = fakeExec({
      stdout: ticketsJson([{ identifier: "CTL-9", state: { name: "Todo" }, priority: 2 }]),
    });
    const sources = [];
    const tickets = runEligibleQuery(query, {
      exec,
      replica,
      onSource: (source, count) => sources.push([source, count]),
    });
    expect(exec.calls).toHaveLength(1); // linearis WAS called
    expect(exec.calls[0].cmd).toBe("linearis");
    expect(tickets.map((t) => t.identifier)).toEqual(["CTL-9"]);
    expect(sources).toEqual([["linearis", 1]]);
  });

  test("a replica whose eligible() THROWS falls through to linearis (fail-open)", () => {
    const replica = {
      eligible: () => {
        throw new Error("replica blew up");
      },
    };
    const exec = fakeExec({
      stdout: ticketsJson([{ identifier: "CTL-9", state: { name: "Todo" } }]),
    });
    const tickets = runEligibleQuery(query, { exec, replica });
    expect(exec.calls).toHaveLength(1);
    expect(tickets.map((t) => t.identifier)).toEqual(["CTL-9"]);
  });

  test("no replica injected: behaves exactly like today (linearis path), onSource('linearis') still fires", () => {
    const exec = fakeExec({
      stdout: ticketsJson([{ identifier: "CTL-9", state: { name: "Todo" } }]),
    });
    const sources = [];
    const tickets = runEligibleQuery(query, {
      exec,
      onSource: (source, count) => sources.push([source, count]),
    });
    expect(exec.calls).toHaveLength(1);
    expect(tickets.map((t) => t.identifier)).toEqual(["CTL-9"]);
    expect(sources).toEqual([["linearis", 1]]);
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

// ─── read-replica tier (CTL-1340) ───────────────────────────────────────────
// fetchTicketState gains a flag-gated `replica` tier between the in-mem cache
// and the gateway. A HIT returns the replica's state name with NO exec; a MISS
// (lookup → undefined) FALLS THROUGH to today's gateway+live read path.

// fakeReplica — a lookup stub that records its calls and returns a canned result.
function fakeReplica(result) {
  const calls = [];
  return {
    calls,
    lookup(identifier) {
      calls.push(identifier);
      return result;
    },
  };
}

describe("fetchTicketState — read-replica tier (CTL-1340)", () => {
  test("flag-OFF (no replica) is byte-identical: exec runs, no replica consulted", () => {
    // Mirror the existing fetchTicketState contract test exactly — passing NO
    // replica must reproduce the live-read behavior verbatim.
    const exec = (cmd, args) => {
      expect(cmd).toBe("linearis");
      expect(args).toEqual(["issues", "read", "CTL-99"]);
      return {
        code: 0,
        stdout: JSON.stringify({ identifier: "CTL-99", state: { name: "Backlog" } }),
        stderr: "",
      };
    };
    // No `replica` key at all.
    expect(fetchTicketState("CTL-99", { exec })).toBe("Backlog");
  });

  test("flag-OFF with a gateway present: replica block is fully skipped", () => {
    let execCalls = 0;
    const exec = () => {
      execCalls++;
      return { code: 0, stdout: JSON.stringify({ state: { name: "Done" } }) };
    };
    const gateway = fakeGateway({ state: "Todo", removed: false, updatedAt: FRESH() });
    // Fresh gateway hit short-circuits — identical to the pre-CTL-1340 path.
    expect(fetchTicketState("CTL-9", { exec, gateway })).toBe("Todo");
    expect(execCalls).toBe(0);
  });

  test("flag-ON HIT terminal (completed_at → Done): returns 'Done', exec NEVER called", () => {
    const replica = fakeReplica({ terminal: true, state: "Done" });
    const exec = fakeExec({ code: 0, stdout: JSON.stringify({ state: { name: "Should-Not-Read" } }) });
    const state = fetchTicketState("CTL-1", { exec, replica });
    expect(state).toBe("Done");
    expect(isLinearTerminal(state)).toBe(true);
    expect(exec.calls.length).toBe(0); // HIT-only acceleration: no live read
    expect(replica.calls).toEqual(["CTL-1"]);
  });

  test("flag-ON HIT terminal (canceled_at → Canceled): returns 'Canceled', exec NEVER called", () => {
    const replica = fakeReplica({ terminal: true, state: "Canceled" });
    const exec = fakeExec({ code: 0, stdout: "{}" });
    const state = fetchTicketState("CTL-2", { exec, replica });
    expect(state).toBe("Canceled");
    expect(isLinearTerminal(state)).toBe(true);
    expect(exec.calls.length).toBe(0);
  });

  test("flag-ON HIT non-terminal: returns the state name, exec NEVER called", () => {
    const replica = fakeReplica({ terminal: false, state: "In Progress" });
    const exec = fakeExec({ code: 0, stdout: "{}" });
    const state = fetchTicketState("CTL-3", { exec, replica });
    expect(state).toBe("In Progress");
    expect(isLinearTerminal(state)).toBe(false);
    expect(exec.calls.length).toBe(0);
  });

  test("flag-ON MISS (lookup → undefined): the live exec IS called (fall-through, safety lock)", () => {
    // THIS encodes the adversarial-review safety decision: a replica MISS must
    // NOT skip the live read — otherwise the terminal sweep would re-flag a
    // finished ticket needs-human. fall-through-on-MISS ONLY.
    const replica = fakeReplica(undefined);
    const exec = fakeExec({
      code: 0,
      stdout: JSON.stringify({ identifier: "CTL-9", state: { name: "Done" } }),
    });
    const state = fetchTicketState("CTL-9", { exec, replica });
    expect(state).toBe("Done"); // resolved via the live read, NOT the replica
    expect(replica.calls).toEqual(["CTL-9"]); // replica was consulted first
    expect(exec.calls.length).toBe(1); // then fell through to the live exec
  });

  test("flag-ON MISS with a gateway: falls through to the gateway tier (not the live exec)", () => {
    const replica = fakeReplica(undefined);
    let execCalls = 0;
    const exec = () => {
      execCalls++;
      return { code: 0, stdout: JSON.stringify({ state: { name: "Live" } }) };
    };
    const gateway = fakeGateway({ state: "Todo", removed: false, updatedAt: FRESH() });
    // MISS → gateway tier; a fresh gateway hit short-circuits before the exec.
    expect(fetchTicketState("CTL-9", { exec, replica, gateway })).toBe("Todo");
    expect(execCalls).toBe(0);
  });

  test("flag-ON HIT warms the in-mem cache so a second call hits without re-consulting the replica", () => {
    const cache = createTicketStateCache({ now: () => 0 });
    const replica = fakeReplica({ terminal: true, state: "Done" });
    const exec = fakeExec({ code: 0, stdout: "{}" });
    expect(fetchTicketState("CTL-1", { exec, replica, cache })).toBe("Done");
    // Second call: in-mem cache hit short-circuits BEFORE the replica block.
    expect(fetchTicketState("CTL-1", { exec, replica, cache })).toBe("Done");
    expect(replica.calls).toEqual(["CTL-1"]); // consulted exactly once
    expect(exec.calls.length).toBe(0);
  });

  test("empty-state guard: a HIT with state '' does NOT poison the cache", () => {
    let setCalls = [];
    const cache = {
      get: () => undefined,
      set: (id, state) => setCalls.push([id, state]),
    };
    // A non-terminal HIT whose state is the empty string (a missing state name).
    const replica = fakeReplica({ terminal: false, state: "" });
    const exec = fakeExec({ code: 0, stdout: "{}" });
    const state = fetchTicketState("CTL-7", { exec, replica, cache });
    expect(state).toBe(""); // the falsy state is returned verbatim
    expect(exec.calls.length).toBe(0); // still a HIT (no fall-through)
    expect(setCalls).toEqual([]); // but cache.set was NEVER called with ""
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

// ─── Stage 0 / A1: fetchTicketAssignee replica-ownership fast-path ───────────
describe("fetchTicketAssignee — replica ownership (A1, Stage 0)", () => {
  const BOT = "ff78d890-7906-4c22-b2f5-020bd150c790";
  const HUMAN = "11111111-1111-1111-1111-111111111111";

  test("replica HIT with a NON-NULL delegate → trusted, never consults gateway/exec/fetchDelegate", () => {
    const replica = { ownership: mock(() => ({ assignee: HUMAN, delegate: BOT })) };
    const gateway = {
      getDescriptor: () => {
        throw new Error("gateway must NOT be read on a trusted (non-null) replica HIT");
      },
    };
    const exec = () => {
      throw new Error("live exec must NOT run on a trusted replica HIT");
    };
    const fetchDelegate = () => {
      throw new Error("live delegate must NOT run on a trusted replica HIT");
    };
    const r = fetchTicketAssignee("CTL-1", { replica, gateway, exec, fetchDelegate });
    expect(r).toEqual({ known: true, assignee: HUMAN, delegate: BOT });
    expect(replica.ownership).toHaveBeenCalledTimes(1);
  });

  // Regression (Stage-0 review, Lens 1): a NULL-delegate replica HIT must NOT be
  // trusted. A per-ticket-lagged replica can read delegate=null while a just-applied
  // human/actor delegation is still queued — trusting it would self-delegate over the
  // real owner and claim (a stomp). So a null-delegate HIT falls through to the
  // gateway/live chain, which live-confirms the delegate (CTL-1174 latch fix) and
  // observes the human's real delegation.
  test("replica HIT with a NULL delegate → NOT trusted, live-confirms via the gateway path", () => {
    const replica = { ownership: () => ({ assignee: null, delegate: null }) };
    // Gateway cached-null delegate → the CTL-1174 latch fix live-confirms it; the
    // confirm returns the human's REAL delegation, so the null is never trusted.
    const gateway = fakeGateway({ ticket: "CTL-1", assignee: HUMAN, delegate: null, removed: false, updatedAt: FRESH() });
    const fetchDelegate = mock(() => ({ known: true, delegate: HUMAN }));
    const r = fetchTicketAssignee("CTL-1", { replica, gateway, fetchDelegate });
    expect(fetchDelegate).toHaveBeenCalledTimes(1); // fell through + live-confirmed the null
    expect(r).toEqual({ known: true, assignee: HUMAN, delegate: HUMAN });
  });

  test("replica MISS (undefined) falls through to the existing gateway path UNCHANGED", () => {
    const mkGateway = () =>
      fakeGateway({ ticket: "CTL-1", assignee: HUMAN, delegate: BOT, removed: false, updatedAt: FRESH() });
    const withMiss = fetchTicketAssignee("CTL-1", {
      replica: { ownership: () => undefined },
      gateway: mkGateway(),
    });
    const withoutReplica = fetchTicketAssignee("CTL-1", { gateway: mkGateway() });
    expect(withMiss).toEqual({ known: true, assignee: HUMAN, delegate: BOT });
    expect(withMiss).toEqual(withoutReplica); // byte-identical to today's behavior on a miss
  });

  test("replica MISS + gateway miss → today's live read chain (fetchDelegate injected)", () => {
    const exec = fakeExec({ code: 0, stdout: JSON.stringify({ assignee: { id: BOT } }) });
    const fetchDelegate = () => ({ known: true, delegate: null });
    const r = fetchTicketAssignee("CTL-4", {
      replica: { ownership: () => undefined },
      gateway: fakeGateway(null),
      exec,
      fetchDelegate,
    });
    expect(r).toEqual({ known: true, assignee: BOT, delegate: null });
    expect(exec.calls.length).toBe(1); // fell through to the live read
  });
});

// ─── Stage 0 / D2: runEligibleQuery breaker-open replica-miss hardening ──────
describe("runEligibleQuery — D2 (breaker-open replica miss)", () => {
  let tmpDir;
  let prevDir;
  beforeEach(() => {
    __resetEligibleEmptyConfirm();
    __resetDispatchAlertThrottle();
    prevDir = process.env.CATALYST_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "d2-alert-"));
    process.env.CATALYST_DIR = tmpDir; // redirect the event log the alert appends to
  });
  afterEach(() => {
    if (prevDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const missReplica = () => ({ eligible: () => undefined }); // a replica MISS (fall-through)

  function eventLogBody() {
    const dir = join(tmpDir, "events");
    const files = readdirSync(dir);
    return files.map((f) => readFileSync(join(dir, f), "utf8")).join("");
  }

  test("undefined-miss + breaker OPEN → throws (preserve-prior), NO linearis spawn, alert emitted", () => {
    const exec = mock(() => ({ code: 0, stdout: ticketsJson([]), stderr: "" }));
    const sources = [];
    expect(() =>
      runEligibleQuery(
        { team: "CTL", status: "Todo" },
        {
          exec,
          replica: missReplica(),
          breakerIsOpen: () => true,
          onSource: (s, n) => sources.push([s, n]),
        },
      ),
    ).toThrow(/breaker open/);
    expect(exec).not.toHaveBeenCalled(); // did NOT spawn into the open breaker
    expect(sources).toEqual([["eligible-source-unavailable-breaker-open", 0]]);
    const body = eventLogBody();
    expect(body).toContain("catalyst.alert.eligible_source_unavailable");
    expect(body).toContain("eligible_source_unavailable");
  });

  test("undefined-miss + breaker CLOSED → spawns linearis as before (no alert, no throw)", () => {
    const exec = fakeExec({ code: 0, stdout: ticketsJson([]) });
    const tickets = runEligibleQuery(
      { team: "CTL", status: "Todo" },
      {
        exec,
        replica: missReplica(),
        breakerIsOpen: () => false,
        delegateExec: () => ({ code: 0, stdout: "{}", stderr: "" }),
      },
    );
    expect(tickets).toEqual([]);
    expect(exec.calls.length).toBe(1); // fell through to the live linearis path
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

// ─── CTL-1339: hot-path per-call wall-clock timeout ──────────────────────────
// A linearis read that stalls under a Linear 429 would otherwise block the
// synchronous scheduler tick its full ~30s. The two hot per-signal terminal
// reads pass an opt-in { timeoutMs } 3rd exec arg; a timed-out read returns
// code 127 (the spawnSync ETIMEDOUT fail-safe) and the readers fail SAFE.

// recordingExec — captures EVERY positional arg (incl. the 3rd opts) so the
// threading/opt-in-scope assertions can inspect the timeout. fakeExec above only
// records { cmd, args } and would miss the 3rd arg.
function recordingExec({ code = 0, stdout = "", stderr = "" } = {}) {
  const calls = [];
  const fn = (...all) => {
    calls.push(all);
    return { code, stdout, stderr };
  };
  fn.calls = calls;
  return fn;
}

describe("CTL-1339 terminal-read timeout — fail-safe on timeout (code 127)", () => {
  test("classifyTicketResolution: timed-out read (code 127) → 'unknown' (NEVER 'not-found')", () => {
    // A timeout is indistinguishable from a missing binary: spawnSync sets
    // res.error → code 127. That MUST NOT quarantine a real ticket.
    const exec = () => ({ code: 127, stdout: "", stderr: "spawnSync linearis ETIMEDOUT" });
    expect(classifyTicketResolution("CTL-9", { exec })).toBe("unknown");
  });

  test("fetchTicketState: timed-out read (code 127) → null (non-terminal, fail-safe)", () => {
    const exec = () => ({ code: 127, stdout: "", stderr: "spawnSync linearis ETIMEDOUT" });
    expect(fetchTicketState("CTL-9", { exec })).toBeNull();
  });
});

describe("CTL-1339 terminal-read timeout — opt-in threading scope", () => {
  test("fetchTicketState tier-3 read passes { timeoutMs: 8000 } as the 3rd exec arg", () => {
    const exec = recordingExec({ code: 0, stdout: JSON.stringify({ state: { name: "Done" } }) });
    fetchTicketState("CTL-1", { exec });
    expect(exec.calls).toHaveLength(1);
    const [cmd, args, opts] = exec.calls[0];
    expect(cmd).toBe("linearis");
    expect(args).toEqual(["issues", "read", "CTL-1"]);
    expect(opts).toEqual({ timeoutMs: 8000 });
  });

  test("classifyTicketResolution read passes { timeoutMs: 8000 } as the 3rd exec arg", () => {
    const exec = recordingExec({ code: 0, stdout: JSON.stringify({ identifier: "CTL-1" }) });
    classifyTicketResolution("CTL-1", { exec });
    expect(exec.calls).toHaveLength(1);
    const [cmd, args, opts] = exec.calls[0];
    expect(cmd).toBe("linearis");
    expect(args).toEqual(["issues", "read", "CTL-1"]);
    expect(opts).toEqual({ timeoutMs: 8000 });
  });

  test("runEligibleQuery (non-hot poll) calls exec with { uncapped: true } and NO timeoutMs (opt-out scoping)", () => {
    // The eligible-list poll must stay UNCAPPED — a blanket cap would SIGKILL a
    // slow-but-VALID 200-ticket page, open the shared breaker, throw, and trip a
    // false monitor.reconcile.failing alert (the adversarial-review finding).
    // CTL-1364 regression fix: the caller now passes { uncapped: true } so the
    // default floor (which rawExec applies to a bare opts) does NOT cap it.
    const exec = recordingExec({ code: 0, stdout: ticketsJson([]) });
    runEligibleQuery({ team: "CTL", status: "Todo" }, { exec, delegateExec: () => null });
    expect(exec.calls).toHaveLength(1);
    const opts = exec.calls[0][2];
    expect(opts).toEqual({ uncapped: true });
    expect(opts?.timeoutMs).toBeUndefined();
  });

  test("fetchTicketRelations (non-hot reader) calls exec with { uncapped: true } and NO timeoutMs", () => {
    const exec = recordingExec({ code: 0, stdout: JSON.stringify({ state: { name: "Todo" } }) });
    fetchTicketRelations("CTL-1", { exec });
    expect(exec.calls).toHaveLength(1);
    const opts = exec.calls[0][2];
    expect(opts).toEqual({ uncapped: true });
    expect(opts?.timeoutMs).toBeUndefined();
  });
});

describe("CTL-1339 parseTerminalTimeoutMs — default/disable contract", () => {
  test("unset (undefined) → 8000 default", () => {
    expect(parseTerminalTimeoutMs(undefined)).toBe(8000);
  });
  test("'0' → undefined (cap disabled — no timeout passed)", () => {
    expect(parseTerminalTimeoutMs("0")).toBeUndefined();
  });
  test("a positive numeric string → that number", () => {
    expect(parseTerminalTimeoutMs("1500")).toBe(1500);
  });
  test("garbage / non-positive → 8000 default", () => {
    expect(parseTerminalTimeoutMs("abc")).toBe(8000);
    expect(parseTerminalTimeoutMs("-5")).toBe(8000);
    expect(parseTerminalTimeoutMs("")).toBe(8000);
  });
});

// integration — drives the REAL rawExec/spawnSync path (NOT a stub) to prove the
// `timeout` option is actually wired to spawnSync. This is the ONLY test that
// exercises spawnSync; every other test injects an `exec` and bypasses rawExec.
describe("CTL-1339 rawExec timeout wiring (integration)", () => {
  test("a real `sleep 5` capped at timeoutMs:200 returns code 127 in well under 1s", () => {
    const t0 = Date.now();
    const res = __rawExecForTest("sleep", ["5"], { timeoutMs: 200 });
    const elapsed = Date.now() - t0;
    expect(res.code).toBe(127); // spawnSync ETIMEDOUT → res.error → code 127
    expect(elapsed).toBeLessThan(1000); // killed at ~200ms, NOT after 5s
    expect(res.timedOut).toBe(true); // CTL-1341: a real timeout flags timedOut → trips the breaker
  });

  test("no timeoutMs → the same `sleep` is NOT killed early (uncapped path)", () => {
    // Prove the cap is opt-in: a short sleep with no timeout runs to completion
    // (exit 0). Kept short (0.2s) so the suite stays fast.
    const res = __rawExecForTest("sleep", ["0.2"]);
    expect(res.code).toBe(0);
  });

  test("CTL-1341: a missing binary (ENOENT) returns code 127 but timedOut:false (not a degraded signal)", () => {
    // The breaker must distinguish a wall-clock timeout (trip) from a spawn error
    // like binary-not-found (do NOT trip — it's a config error, not rate-limiting).
    const res = __rawExecForTest("catalyst-no-such-binary-xyz", [], { timeoutMs: 8000 });
    expect(res.code).toBe(127);
    expect(res.timedOut).toBe(false);
  });
});

// ─── CTL-1364: DEFAULT rawExec Node timeout (caps EVERY linearis spawn) ──────
// OTEL flagged rawExec as having NO default Node timeout, so any single linearis
// read (recovery-filter / reclaim-sweep / phantom-probe / assignee-read / poll)
// could block the synchronous tick its full wall-clock. The default floor caps
// them all, WITHOUT double-capping the CTL-1339 opt-in (which passes its own).
describe("CTL-1364 rawExec DEFAULT timeout", () => {
  test("(a)+(b) a spawn with NO explicit timeoutMs is killed by the default floor (timedOut → breaker-trip)", async () => {
    // Re-import a fresh module instance with a tiny default floor so the real
    // `sleep` is killed deterministically in well under 1s. Proves rawExec passes
    // a default `timeout` to spawnSync and that a default-timeout kill flags
    // timedOut exactly like the CTL-1339 opt-in (so withBreaker still trips).
    process.env.CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS = "200";
    try {
      const fresh = await import(
        `./linear-query.mjs?ctl1364-default-floor=${Date.now()}`
      );
      const t0 = Date.now();
      const res = fresh.__rawExecForTest("sleep", ["5"]); // NO timeoutMs — relies on the default
      const elapsed = Date.now() - t0;
      expect(res.code).toBe(127); // spawnSync ETIMEDOUT → res.error → code 127
      expect(elapsed).toBeLessThan(1000); // killed at ~200ms, NOT after 5s
      expect(res.timedOut).toBe(true); // default-timeout kill trips the breaker too
    } finally {
      delete process.env.CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS;
    }
  });

  test("(no double-cap) an explicit positive timeoutMs WINS over the default floor", async () => {
    // With a tiny default floor but a generous explicit cap, a short sleep runs
    // to completion (exit 0): the explicit value is used verbatim, not stacked
    // with / overridden by the floor.
    process.env.CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS = "50";
    try {
      const fresh = await import(
        `./linear-query.mjs?ctl1364-explicit-wins=${Date.now()}`
      );
      const res = fresh.__rawExecForTest("sleep", ["0.2"], { timeoutMs: 5000 });
      expect(res.code).toBe(0); // explicit 5000 > 0.2s sleep → completes, NOT killed at the 50ms floor
    } finally {
      delete process.env.CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS;
    }
  });

  test("(disable) CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS=0 restores the uncapped path", async () => {
    // The explicit escape hatch: "0" disables the default floor entirely, so a
    // short un-timed sleep runs to completion (no kill).
    process.env.CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS = "0";
    try {
      const fresh = await import(
        `./linear-query.mjs?ctl1364-disabled=${Date.now()}`
      );
      const res = fresh.__rawExecForTest("sleep", ["0.2"]); // no opts, floor disabled
      expect(res.code).toBe(0);
    } finally {
      delete process.env.CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS;
    }
  });
});

// ─── CTL-1364 REGRESSION: the eligible poll stays UNCAPPED (production path) ──
// The earlier opt-in-scoping tests inject a STUB exec, which bypasses rawExec and
// so cannot catch a floor applied INSIDE rawExec. These drive the REAL rawExec
// (via __rawExecForTest, NO timeoutMs) under a tiny default floor to prove the
// { uncapped: true } sentinel actually opts the spawn OUT of the floor — i.e. a
// slow-but-valid `linearis issues list` is NOT SIGKILLed at the floor (which
// would open the shared breaker + throw a false monitor.reconcile.failing alert,
// exactly the failure mode CTL-1339 designed against).
describe("CTL-1364 regression — { uncapped: true } bypasses the default floor (real rawExec)", () => {
  test("a slow spawn with { uncapped: true } is NOT killed at the floor (runs to completion)", async () => {
    // Tiny floor (50ms) + a sleep longer than the floor; { uncapped: true } must
    // skip the timeout entirely so the command completes (exit 0), proving the
    // eligible poll's spawn is never capped even under a default floor.
    process.env.CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS = "50";
    try {
      const fresh = await import(
        `./linear-query.mjs?ctl1364-uncapped=${Date.now()}`
      );
      const t0 = Date.now();
      const res = fresh.__rawExecForTest("sleep", ["0.3"], { uncapped: true });
      const elapsed = Date.now() - t0;
      expect(res.code).toBe(0); // NOT killed at the 50ms floor — ran to completion
      expect(res.timedOut).toBeUndefined(); // no timeout fired → cannot trip the breaker
      expect(elapsed).toBeGreaterThanOrEqual(250); // it actually slept ~0.3s, not killed at 50ms
    } finally {
      delete process.env.CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS;
    }
  });

  test("a capped spawn (bare opts) under the SAME tiny floor IS killed — proving the floor is otherwise live", async () => {
    // Contrast control: with no { uncapped } the floor caps the same slow sleep,
    // so the previous test's pass is attributable to the sentinel, not to the
    // floor being inert.
    process.env.CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS = "50";
    try {
      const fresh = await import(
        `./linear-query.mjs?ctl1364-capped-control=${Date.now()}`
      );
      const res = fresh.__rawExecForTest("sleep", ["0.3"]); // NO opts → default floor caps it
      expect(res.code).toBe(127); // SIGKILLed at the 50ms floor
      expect(res.timedOut).toBe(true);
    } finally {
      delete process.env.CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS;
    }
  });

  test("runEligibleQuery → real rawExec: a slow VALID poll is NOT killed at the floor (production path; { uncapped } honored end-to-end)", async () => {
    // The end-to-end regression guard. We drive runEligibleQuery through an `exec`
    // that is a THIN shim over the REAL __rawExecForTest — it rewrites the fixed
    // "linearis" command to a slow `sleep … && echo <valid JSON>` so we exercise
    // the actual rawExec timeout/floor logic (NOT a stub), while forwarding the
    // { uncapped: true } opts runEligibleQuery passes. Pre-fix, rawExec applied
    // the floor to that opts → the slow spawn was SIGKILLed → exit 127 →
    // runEligibleQuery THROWS. Post-fix the { uncapped: true } sentinel skips the
    // floor → the page completes → returns the parsed tickets.
    process.env.CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS = "50";
    try {
      const fresh = await import(
        `./linear-query.mjs?ctl1364-eligible-prod=${Date.now()}`
      );
      let observedOpts;
      // Shim: forward the real opts (so { uncapped: true } is honored by rawExec)
      // but run a slow valid command instead of the real linearis CLI.
      const realExec = (_cmd, _args, opts) => {
        observedOpts = opts;
        return fresh.__rawExecForTest(
          "sh",
          ["-c", "sleep 0.3; echo '{\"nodes\":[]}'"],
          opts,
        );
      };
      const tickets = fresh.runEligibleQuery(
        { team: "CTL", status: "Todo" },
        { exec: realExec, delegateExec: () => null },
      );
      expect(observedOpts).toEqual({ uncapped: true }); // the sentinel reached rawExec
      expect(tickets).toEqual([]); // 0.3s > 50ms floor, yet NOT killed → no throw
    } finally {
      delete process.env.CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS;
    }
  });
});

// CTL-1364 — fetchTicketState's `onExec` seam fires ONLY on the live-read path
// (cache+replica miss + stale/absent gateway). The scheduler's Tier-3 scheduler.op
// span tier hangs off this callback: a slow terminal-read on a miss gets a span; a
// cheap cache/gateway/replica hit gets NONE (the callback never fires). This is the
// seam that lets the flame graph attribute a 15s recovery-filter spike to the exact
// ticket + source without wrapping the synchronous tick in span-context callbacks.
describe("fetchTicketState — onExec span seam (CTL-1364)", () => {
  test("fires onExec on the LIVE read with source/execMs/result/timedOut", () => {
    const exec = fakeExec({
      code: 0,
      stdout: JSON.stringify({ identifier: "CTL-9", state: { name: "In Progress" } }),
    });
    let seen = null;
    const state = fetchTicketState("CTL-9", { exec, onExec: (info) => { seen = info; } });
    expect(state).toBe("In Progress");
    expect(seen).not.toBeNull();
    expect(seen.source).toBe("live");
    expect(seen.code).toBe(0);
    expect(seen.result).toBe("In Progress");
    expect(seen.timedOut).toBe(false);
    expect(typeof seen.execMs).toBe("number");
  });

  test("a cache HIT does NOT fire onExec (no op span for a fast hit)", () => {
    const cache = createTicketStateCache({ now: () => 0 });
    cache.set("CTL-1", "Done");
    const exec = fakeExec({ code: 0, stdout: "{}" });
    let fired = false;
    const state = fetchTicketState("CTL-1", { exec, cache, onExec: () => { fired = true; } });
    expect(state).toBe("Done");
    expect(exec.calls.length).toBe(0); // pure cache hit
    expect(fired).toBe(false); // seam never fired → no op span
  });

  test("a replica HIT does NOT fire onExec", () => {
    const replica = fakeReplica({ terminal: true, state: "Done" });
    const exec = fakeExec({ code: 0, stdout: "{}" });
    let fired = false;
    const state = fetchTicketState("CTL-1", { exec, replica, onExec: () => { fired = true; } });
    expect(state).toBe("Done");
    expect(exec.calls.length).toBe(0);
    expect(fired).toBe(false);
  });

  test("a fresh gateway HIT does NOT fire onExec", () => {
    const gateway = fakeGateway({ state: "Todo", removed: false, updatedAt: FRESH() });
    const exec = fakeExec({ code: 0, stdout: "{}" });
    let fired = false;
    const state = fetchTicketState("CTL-9", { exec, gateway, onExec: () => { fired = true; } });
    expect(state).toBe("Todo");
    expect(exec.calls.length).toBe(0);
    expect(fired).toBe(false);
  });

  test("fires onExec with result:null + code on a non-zero exit (fail-safe path)", () => {
    const exec = () => ({ code: 1, stdout: "", stderr: "not found" });
    let seen = null;
    const state = fetchTicketState("CTL-9", { exec, onExec: (info) => { seen = info; } });
    expect(state).toBeNull();
    expect(seen.code).toBe(1);
    expect(seen.result).toBeNull();
  });

  test("fires onExec with timedOut:true when the read tripped the wall-clock cap", () => {
    const exec = () => ({ code: 127, stdout: "", stderr: "killed", timedOut: true });
    let seen = null;
    const state = fetchTicketState("CTL-9", { exec, onExec: (info) => { seen = info; } });
    expect(state).toBeNull();
    expect(seen.timedOut).toBe(true);
  });

  test("a throwing onExec never escapes fetchTicketState (best-effort seam)", () => {
    const exec = fakeExec({ code: 0, stdout: JSON.stringify({ state: { name: "Done" } }) });
    const onExec = () => { throw new Error("seam boom"); };
    expect(() => fetchTicketState("CTL-9", { exec, onExec })).not.toThrow();
    // the read still resolves despite the throwing seam
    expect(fetchTicketState("CTL-9", { exec, onExec })).toBe("Done");
  });
});
