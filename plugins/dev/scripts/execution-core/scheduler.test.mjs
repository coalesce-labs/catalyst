// Unit + filesystem-fixture tests for the pull-loop scheduler (CTL-536).
// Run: cd plugins/dev/scripts/execution-core && bun test scheduler.test.mjs
//
// Phase 3 adds the selection-core blocks; Phases 4-5 extend this same file.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPhaseSignals,
  isTicketInFlight,
  listInFlightTickets,
  readMaxParallel,
  computeFreeSlots,
  computeReadyTickets,
  selectDispatchable,
  deriveAdvancement,
  listStartedTickets,
  schedulerTick,
  readAllEligibleTickets,
  hydrateOutOfSetBlockers,
  startScheduler,
  stopScheduler,
  __resetForTests,
} from "./scheduler.mjs";

let orchDir;
let catalystDir;
let prevCatalystDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "sched-"));
  // Redirect CATALYST_DIR so getEventLogPath() resolves under a fixture —
  // the same redirect monitor.test.mjs uses.
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "sched-cat-"));
  process.env.CATALYST_DIR = catalystDir;
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

function writeSignal(ticket, phase, status) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify({ ticket, phase, status }));
}

// appendToEventLog — mkdirSync <CATALYST_DIR>/events/ and append to the
// current UTC YYYY-MM.jsonl (the path getEventLogPath() resolves).
function appendToEventLog(line) {
  const dir = join(catalystDir, "events");
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  appendFileSync(join(dir, `${ym}.jsonl`), line);
}

// eligibleDir / writeEligibleProjection — getEligibleDir() resolves to
// <CATALYST_DIR>/execution-core/eligible (config.mjs); write a per-project
// projection there so readAllEligibleTickets() reads a fixture. `raw` writes
// arbitrary file content (used for the malformed-JSON case).
const eligibleDir = () => join(catalystDir, "execution-core", "eligible");
function writeEligibleProjection(projectKey, body, { raw = false } = {}) {
  mkdirSync(eligibleDir(), { recursive: true });
  writeFileSync(join(eligibleDir(), `${projectKey}.json`), raw ? body : JSON.stringify(body));
}

// waitFor — poll `predicate` every `intervalMs` until it returns truthy, or
// throw after `timeoutMs`. Replaces fixed-duration sleeps in the daemon tests:
// fs.watch / timer delivery latency is variable (macOS FSEvents spikes well past
// a fixed sleep, and can drop an event that lands before the watch finishes
// registering), so a fixed sleep races the watcher and flakes. A bounded poll is
// deterministic — it returns as soon as the condition holds and only fails if it
// genuinely never does. `onTick` runs once per poll, so a test can re-trigger a
// droppable event each iteration instead of relying on a single delivery.
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    onTick?.();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!predicate()) {
    throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
  }
}

describe("readPhaseSignals", () => {
  test("returns a phase→status map for a worker dir", () => {
    writeSignal("CTL-1", "triage", "done");
    writeSignal("CTL-1", "research", "running");
    expect(readPhaseSignals(orchDir, "CTL-1")).toEqual({
      triage: "done",
      research: "running",
    });
  });
  test("returns {} when the worker dir does not exist", () => {
    expect(readPhaseSignals(orchDir, "CTL-404")).toEqual({});
  });
});

describe("isTicketInFlight", () => {
  test("a non-terminal signal means in-flight", () => {
    expect(isTicketInFlight({ triage: "done", research: "running" })).toBe(true);
  });
  test("plan done + no later signal (advance window) is still in-flight", () => {
    expect(isTicketInFlight({ triage: "done", research: "done", plan: "done" })).toBe(true);
  });
  test("monitor-deploy done is terminal success → NOT in-flight", () => {
    expect(isTicketInFlight({ "monitor-deploy": "done" })).toBe(false);
  });
  test("a failed or stalled signal is terminal → NOT in-flight", () => {
    expect(isTicketInFlight({ implement: "failed" })).toBe(false);
    expect(isTicketInFlight({ verify: "stalled" })).toBe(false);
  });
  test("an 'aborted' signal frees the slot (CTL-565 kill-on-drag-out)", () => {
    expect(isTicketInFlight({ research: "done", implement: "aborted" })).toBe(false);
  });
  test("no signals at all → NOT in-flight", () => {
    expect(isTicketInFlight({})).toBe(false);
  });
});

describe("listInFlightTickets / readMaxParallel / computeFreeSlots", () => {
  test("counts only in-flight worker dirs", () => {
    writeSignal("CTL-1", "implement", "running");
    writeSignal("CTL-2", "monitor-deploy", "done");
    writeSignal("CTL-3", "triage", "failed");
    expect([...listInFlightTickets(orchDir)]).toEqual(["CTL-1"]);
  });
  test("readMaxParallel reads state.json, defaults to 1", () => {
    expect(readMaxParallel(orchDir)).toBe(1);
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 3 }));
    expect(readMaxParallel(orchDir)).toBe(3);
  });
  test("computeFreeSlots never goes negative", () => {
    expect(computeFreeSlots(3, 1)).toBe(2);
    expect(computeFreeSlots(3, 5)).toBe(0);
  });
});

describe("computeReadyTickets", () => {
  const tk = (id, priority, createdAt, relations) => ({
    identifier: id,
    priority,
    createdAt,
    state: "Todo",
    relations: relations ?? { nodes: [] },
    inverseRelations: { nodes: [] },
  });

  test("returns ranked ready tickets, excluding blocked ones", () => {
    // CTL-2 blocks CTL-1 → CTL-1 blocked; CTL-2 and CTL-3 ready. Distinct
    // priorities (CTL-2 Urgent=1, CTL-3 High=2) make the ranked order exact.
    const eligible = [
      tk("CTL-1", 3, "x", {
        nodes: [{ type: "blocked_by", relatedIssue: { identifier: "CTL-2" } }],
      }),
      tk("CTL-2", 1, "x"),
      tk("CTL-3", 2, "x"),
    ];
    const ready = computeReadyTickets(eligible);
    expect(ready.map((t) => t.identifier)).toEqual(["CTL-2", "CTL-3"]);
  });
  test("with no relations every eligible ticket is ready, priority-ranked", () => {
    const ready = computeReadyTickets([tk("CTL-9", 4, "x"), tk("CTL-8", 1, "x")]);
    expect(ready.map((t) => t.identifier)).toEqual(["CTL-8", "CTL-9"]);
  });
  test("empty eligible set → empty ready set", () => {
    expect(computeReadyTickets([])).toEqual([]);
  });
  test("a blocker outside the eligible set does not block (finished/non-Todo)", () => {
    // The eligible set is all-Todo; a finished (Done/Canceled) or otherwise
    // non-Todo blocker is simply absent from it. buildDependencyEdges drops
    // any edge with an out-of-set endpoint, so CTL-1's blocked_by edge to the
    // absent CTL-99 is dropped and CTL-1 is ready.
    const ready = computeReadyTickets([
      tk("CTL-1", 2, "x", {
        nodes: [{ type: "blocked_by", relatedIssue: { identifier: "CTL-99" } }],
      }),
    ]);
    expect(ready.map((t) => t.identifier)).toEqual(["CTL-1"]);
  });
  test("a mutual dependency cycle leaves both tickets blocked — no crash", () => {
    // CTL-A blocked_by CTL-B and CTL-B blocked_by CTL-A. The scheduler must
    // tolerate the cycle: both partition as blocked, neither is dispatched.
    const ready = computeReadyTickets([
      tk("CTL-A", 1, "x", {
        nodes: [{ type: "blocked_by", relatedIssue: { identifier: "CTL-B" } }],
      }),
      tk("CTL-B", 1, "x", {
        nodes: [{ type: "blocked_by", relatedIssue: { identifier: "CTL-A" } }],
      }),
    ]);
    expect(ready).toEqual([]);
  });
});

describe("selectDispatchable", () => {
  const tk = (id) => ({ identifier: id });
  test("takes the top freeSlots ready tickets not already in-flight", () => {
    const ranked = [tk("A"), tk("B"), tk("C"), tk("D")];
    const sel = selectDispatchable(ranked, new Set(["B"]), 2);
    expect(sel.map((t) => t.identifier)).toEqual(["A", "C"]);
  });
  test("freeSlots 0 → selects nothing", () => {
    expect(selectDispatchable([tk("A")], new Set(), 0)).toEqual([]);
  });
  test("caps the selection at freeSlots when more tickets are ready", () => {
    const ranked = [tk("A"), tk("B"), tk("C")];
    expect(selectDispatchable(ranked, new Set(), 1).map((t) => t.identifier)).toEqual(["A"]);
  });
});

// ── Phase 4: dispatch and FSM-driven phase advancement ──

// A dispatch stub: records every call, returns a configurable exit code.
function fakeDispatch({ code = 0 } = {}) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    return { code, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

describe("deriveAdvancement", () => {
  test("latest phase done → returns the FSM successor", () => {
    expect(deriveAdvancement({ triage: "done" })).toBe("research");
    expect(deriveAdvancement({ triage: "done", research: "done", plan: "done" })).toBe("implement");
  });
  test("latest phase not done → null (nothing owed)", () => {
    expect(deriveAdvancement({ triage: "done", research: "running" })).toBeNull();
  });
  test("successor already has a signal → null (already advanced)", () => {
    expect(deriveAdvancement({ triage: "done", research: "running" })).toBeNull();
    expect(deriveAdvancement({ research: "done", plan: "dispatched" })).toBeNull();
  });
  test("monitor-deploy done → null (pipeline terminal)", () => {
    expect(deriveAdvancement({ "monitor-deploy": "done" })).toBeNull();
  });
  test("latest phase failed → null (nothing owed — revive is another owner's job)", () => {
    expect(deriveAdvancement({ implement: "failed" })).toBeNull();
  });
  test("no signals → null", () => {
    expect(deriveAdvancement({})).toBeNull();
  });
});

describe("schedulerTick — new-work pull", () => {
  test("dispatches research for the top-ranked ready ticket into a free slot", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const dispatch = fakeDispatch();
    const eligible = [
      {
        identifier: "CTL-9",
        priority: 4,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
      {
        identifier: "CTL-8",
        priority: 1,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    const r = schedulerTick(orchDir, { readEligible: () => eligible, dispatch });
    // 2 free slots, both ready → both dispatched, urgent (CTL-8) first.
    expect(dispatch.calls.map((c) => c.ticket)).toEqual(["CTL-8", "CTL-9"]);
    // CTL-565: new-work enters the pipeline at research, not triage.
    expect(dispatch.calls.every((c) => c.phase === "research")).toBe(true);
    expect(r.dispatched).toEqual(["CTL-8", "CTL-9"]);
  });

  test("new-work pull dispatches Ready tickets at the research phase, not triage (CTL-565)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch();
    const eligible = [
      {
        identifier: "CTL-1",
        priority: 2,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    schedulerTick(orchDir, { readEligible: () => eligible, dispatch });
    expect(dispatch.calls).toHaveLength(1);
    expect(dispatch.calls[0]).toMatchObject({ ticket: "CTL-1", phase: "research" });
  });

  test("respects maxParallel — no dispatch when slots are full", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "implement", "running"); // 1 in-flight, ceiling 1
    const dispatch = fakeDispatch();
    const eligible = [
      {
        identifier: "CTL-2",
        priority: 1,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    const r = schedulerTick(orchDir, { readEligible: () => eligible, dispatch });
    expect(dispatch.calls).toHaveLength(0);
    expect(r.dispatched).toEqual([]);
  });

  test("is idempotent — a second tick re-dispatches nothing", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const eligible = [
      {
        identifier: "CTL-5",
        priority: 2,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    // First tick dispatches; the stub also writes the signal
    // phase-agent-dispatch would.
    const dispatch = (args) => {
      writeSignal(args.ticket, args.phase, "dispatched");
      return { code: 0, stdout: "", stderr: "" };
    };
    schedulerTick(orchDir, { readEligible: () => eligible, dispatch });
    const second = fakeDispatch();
    schedulerTick(orchDir, { readEligible: () => eligible, dispatch: second });
    expect(second.calls).toHaveLength(0); // CTL-5 already started → not re-pulled
  });

  test("advancement sweep dispatches the owed next phase for an in-flight ticket", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-7", "triage", "done"); // research is owed
    const dispatch = fakeDispatch();
    const r = schedulerTick(orchDir, { readEligible: () => [], dispatch });
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-7", phase: "research" }]);
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
  });

  test("a failed-dispatch (non-zero exit) is a soft skip, not a throw", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 1 });
    const eligible = [
      {
        identifier: "CTL-3",
        priority: 1,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    const r = schedulerTick(orchDir, { readEligible: () => eligible, dispatch });
    expect(r.dispatched).toEqual([]); // dispatch failed → not recorded
    // no throw — the tick completes
  });

  test("one tick both advances an in-flight ticket and pulls new work", () => {
    // maxParallel 2; CTL-7 in-flight at triage:done (advances to research,
    // still 1 in-flight); 1 free slot remains → CTL-X is pulled. The
    // advancement sweep must NOT consume the slot the pull then fills.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    const dispatch = fakeDispatch();
    const eligible = [
      {
        identifier: "CTL-X",
        priority: 1,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    const r = schedulerTick(orchDir, { readEligible: () => eligible, dispatch });
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
    expect(r.dispatched).toEqual(["CTL-X"]);
    expect(dispatch.calls).toEqual([
      { orchDir, ticket: "CTL-7", phase: "research" },
      // CTL-565: new-work pull enters at research, not triage.
      { orchDir, ticket: "CTL-X", phase: "research" },
    ]);
  });
});

describe("listStartedTickets", () => {
  test("returns every worker dir regardless of status (started ≠ in-flight)", () => {
    writeSignal("CTL-1", "implement", "running");
    writeSignal("CTL-2", "triage", "failed");
    writeSignal("CTL-3", "monitor-deploy", "done");
    expect([...listStartedTickets(orchDir)].sort()).toEqual(["CTL-1", "CTL-2", "CTL-3"]);
  });
});

describe("readAllEligibleTickets", () => {
  test("returns [] when the eligible dir does not exist", () => {
    expect(readAllEligibleTickets()).toEqual([]);
  });
  test("concatenates tickets across every per-project projection", () => {
    writeEligibleProjection("alpha", { tickets: [{ identifier: "A-1" }] });
    writeEligibleProjection("beta", {
      tickets: [{ identifier: "B-1" }, { identifier: "B-2" }],
    });
    expect(
      readAllEligibleTickets()
        .map((t) => t.identifier)
        .sort()
    ).toEqual(["A-1", "B-1", "B-2"]);
  });
  test("skips a malformed projection file and still returns the valid ones", () => {
    writeEligibleProjection("good", { tickets: [{ identifier: "G-1" }] });
    writeEligibleProjection("bad", "{ not valid json", { raw: true });
    expect(readAllEligibleTickets().map((t) => t.identifier)).toEqual(["G-1"]);
  });
  test("skips a projection whose `tickets` field is not an array", () => {
    writeEligibleProjection("shapeless", { tickets: "nope" });
    writeEligibleProjection("ok", { tickets: [{ identifier: "OK-1" }] });
    expect(readAllEligibleTickets().map((t) => t.identifier)).toEqual(["OK-1"]);
  });
});

// ── CTL-565 D5: out-of-set blocker-state hydration ──

describe("hydrateOutOfSetBlockers / D5 readiness", () => {
  // blkTk — an eligible ticket carrying a `blocked_by` relation to `blockedBy`.
  const blkTk = (id, { priority = 2, blockedBy } = {}) => ({
    identifier: id,
    priority,
    createdAt: "x",
    state: "Todo",
    relations: blockedBy
      ? { nodes: [{ type: "blocked_by", relatedIssue: { identifier: blockedBy } }] }
      : { nodes: [] },
    inverseRelations: { nodes: [] },
  });

  test("fetches each unique out-of-set blocker once (deduped)", () => {
    const fetched = [];
    const exec = (_cmd, args) => {
      fetched.push(args[2]);
      return { code: 0, stdout: JSON.stringify({ state: { name: "Backlog" } }), stderr: "" };
    };
    const map = hydrateOutOfSetBlockers(
      [blkTk("CTL-1", { blockedBy: "CTL-99" }), blkTk("CTL-2", { blockedBy: "CTL-99" })],
      { exec },
    );
    expect(fetched).toEqual(["CTL-99"]); // deduped — one fetch
    expect(map).toEqual({ "CTL-99": "Backlog" });
  });

  test("an in-set blocker is not fetched (only out-of-set blockers hydrate)", () => {
    const fetched = [];
    const exec = (_cmd, args) => {
      fetched.push(args[2]);
      return { code: 0, stdout: JSON.stringify({ state: { name: "Backlog" } }), stderr: "" };
    };
    // CTL-2 is in the eligible set, so the CTL-1→CTL-2 edge is in-set.
    hydrateOutOfSetBlockers(
      [blkTk("CTL-1", { blockedBy: "CTL-2" }), blkTk("CTL-2")],
      { exec },
    );
    expect(fetched).toEqual([]);
  });

  test("a Ready ticket blocked by a Backlog out-of-set blocker is not dispatched", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ state: { name: "Backlog" } }),
      stderr: "",
    });
    schedulerTick(orchDir, {
      readEligible: () => [blkTk("CTL-1", { blockedBy: "CTL-99" })],
      dispatch,
      exec,
    });
    expect(dispatch.calls).toHaveLength(0);
  });

  test("a Ready ticket blocked by a Done out-of-set blocker IS dispatched", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ state: { name: "Done" } }),
      stderr: "",
    });
    schedulerTick(orchDir, {
      readEligible: () => [blkTk("CTL-1", { blockedBy: "CTL-99" })],
      dispatch,
      exec,
    });
    expect(dispatch.calls.map((c) => c.ticket)).toEqual(["CTL-1"]);
  });

  test("a failed blocker fetch fails safe — the dependent is held back, not dispatched", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    const exec = () => ({ code: 1, stdout: "", stderr: "boom" });
    schedulerTick(orchDir, {
      readEligible: () => [blkTk("CTL-1", { blockedBy: "CTL-99" })],
      dispatch,
      exec,
    });
    expect(dispatch.calls).toHaveLength(0);
  });
});

// ── Phase 5: the pull-loop daemon ──

describe("startScheduler / stopScheduler", () => {
  afterEach(() => __resetForTests());

  test("startScheduler runs one tick immediately", () => {
    const dispatch = fakeDispatch();
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "triage", "done"); // research owed
    startScheduler({
      orchDir,
      dispatch,
      readEligible: () => [],
      tickIntervalMs: 60_000,
      debounceMs: 5,
    });
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-1", phase: "research" }]);
  });

  test("the periodic timer fires another tick", async () => {
    const dispatch = fakeDispatch();
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    startScheduler({
      orchDir,
      dispatch,
      readEligible: () => [],
      tickIntervalMs: 20,
      debounceMs: 5,
    });
    writeSignal("CTL-2", "triage", "done"); // becomes owed after the first tick
    await waitFor(() => dispatch.calls.some((c) => c.ticket === "CTL-2"));
    expect(dispatch.calls.some((c) => c.ticket === "CTL-2")).toBe(true);
  });

  test("an event-log change triggers a debounced tick", async () => {
    const dispatch = fakeDispatch();
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // Pre-create the event log so the later append is an in-place change
    // (fs.watch fires `change`), not a create (`rename`). In production the
    // event log always exists — workers append to it continuously.
    appendToEventLog("");
    startScheduler({
      orchDir,
      dispatch,
      readEligible: () => [],
      tickIntervalMs: 60_000,
      debounceMs: 10,
    });
    writeSignal("CTL-3", "triage", "done");
    const dispatched = () =>
      dispatch.calls.some((c) => c.ticket === "CTL-3" && c.phase === "research");
    // Appending to the event log must wake the scheduler. macOS FSEvents can
    // drop an append that lands before the watcher finishes registering, so
    // re-append once per poll — each append is a fresh chance for the watcher to
    // fire — instead of racing a single fixed sleep against watcher latency.
    await waitFor(dispatched, {
      intervalMs: 100,
      onTick: () => appendToEventLog('{"event":"phase.triage.complete.CTL-3"}\n'),
    });
    expect(dispatched()).toBe(true);
  });

  test("stopScheduler is idempotent and safe before start", () => {
    expect(() => {
      stopScheduler();
      stopScheduler();
    }).not.toThrow();
  });
});

// ── CTL-539: idempotent-dispatch proof — re-deriving the tick after a
// "crash" can never double-dispatch the same {ticket, phase} ──

describe("CTL-539 — idempotent dispatch across a crash", () => {
  const tk = (id, priority = 2) => ({
    identifier: id,
    priority,
    createdAt: "x",
    state: "Todo",
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  });

  test("re-running schedulerTick after a 'crash' never dispatches the same {ticket,phase} twice", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const eligible = [tk("CTL-9")];

    // Tick 1 — dispatches the new-work entry phase (research, CTL-565) for the
    // ready ticket. The stub writes the dispatched signal the real
    // phase-agent-dispatch would have written BEFORE spawning claude --bg
    // (signal-first ordering).
    const calls = [];
    const dispatch = (args) => {
      calls.push(`${args.ticket}:${args.phase}`);
      writeSignal(args.ticket, args.phase, "dispatched");
      return { code: 0, stdout: "", stderr: "" };
    };
    const r1 = schedulerTick(orchDir, { readEligible: () => eligible, dispatch });
    expect(r1.dispatched).toEqual(["CTL-9"]);

    // "Crash" — the daemon dies; the dispatched signal survives on disk.
    // Tick 2 (post-restart) re-derives everything from the filesystem.
    const r2 = schedulerTick(orchDir, { readEligible: () => eligible, dispatch });

    // CTL-9 now has a worker dir → excluded from the pull. research:dispatched
    // is not 'done' → deriveAdvancement returns null. No re-dispatch.
    expect(r2.dispatched).toEqual([]);
    expect(r2.advanced).toEqual([]);
    // Every {ticket,phase} appears exactly once across both ticks.
    const byKey = new Map();
    for (const k of calls) byKey.set(k, (byKey.get(k) ?? 0) + 1);
    expect([...byKey.values()].every((n) => n === 1)).toBe(true);
    expect(calls).toEqual(["CTL-9:research"]);
  });

  test("an orphan 'dispatched' signal (bg_job_id:null) is not re-dispatched", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    // Pre-write the orphan signal a crash mid-dispatch leaves: the signal was
    // written but claude --bg never spawned, so bg_job_id is null.
    const dir = join(orchDir, "workers", "CTL-7");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-triage.json"),
      JSON.stringify({
        ticket: "CTL-7",
        phase: "triage",
        status: "dispatched",
        bg_job_id: null,
      }),
    );
    const dispatch = fakeDispatch();
    const r = schedulerTick(orchDir, {
      readEligible: () => [tk("CTL-7")],
      dispatch,
    });
    // CTL-7 has a worker dir → excluded from the new-work pull; triage is
    // dispatched (not done) → nothing owed. The orphan is not re-dispatched.
    expect(dispatch.calls).toHaveLength(0);
    expect(r.dispatched).toEqual([]);
    expect(r.advanced).toEqual([]);
  });
});

// ── CTL-558: deterministic Linear status write-back from the scheduler ──

describe("schedulerTick — Linear status write-back (CTL-558)", () => {
  const readyTicket = (id, priority = 2) => ({
    identifier: id,
    priority,
    createdAt: "x",
    state: "Todo",
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  });
  const okDispatch = fakeDispatch();
  const failDispatch = fakeDispatch({ code: 1 });

  test("writes the dispatched phase's status after a successful advancement dispatch", () => {
    // research done → advancement owes `plan`
    writeSignal("CTL-1", "research", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const writes = [];
    const writeStatus = {
      applyPhaseStatus: (a) => writes.push(a),
      applyTerminalDone: () => {},
      applyLabel: () => {},
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: okDispatch, writeStatus });
    expect(writes).toContainEqual(
      expect.objectContaining({ ticket: "CTL-1", phase: "plan" })
    );
  });

  test("writes `research` status for a new-work pull dispatch", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const writes = [];
    const writeStatus = {
      applyPhaseStatus: (a) => writes.push(a),
      applyTerminalDone: () => {},
      applyLabel: () => {},
    };
    schedulerTick(orchDir, {
      readEligible: () => [readyTicket("CTL-2")],
      dispatch: okDispatch,
      writeStatus,
    });
    expect(writes).toContainEqual(
      expect.objectContaining({ ticket: "CTL-2", phase: "research" })
    );
  });

  test("does NOT write status when the dispatch fails", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const writes = [];
    const writeStatus = {
      applyPhaseStatus: (a) => writes.push(a),
      applyTerminalDone: () => {},
      applyLabel: () => {},
    };
    schedulerTick(orchDir, {
      readEligible: () => [readyTicket("CTL-3")],
      dispatch: failDispatch,
      writeStatus,
    });
    expect(writes).toHaveLength(0);
  });

  test("writes terminal Done when a ticket's monitor-deploy signal is done", () => {
    writeSignal("CTL-4", "monitor-deploy", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dones = [];
    const writeStatus = {
      applyPhaseStatus: () => {},
      applyTerminalDone: (a) => dones.push(a),
      applyLabel: () => {},
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: okDispatch, writeStatus });
    expect(dones).toContainEqual(expect.objectContaining({ ticket: "CTL-4" }));
  });

  test("a status-write throw never aborts the tick", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const writeStatus = {
      applyPhaseStatus: () => {
        throw new Error("boom");
      },
      applyTerminalDone: () => {},
      applyLabel: () => {},
    };
    expect(() =>
      schedulerTick(orchDir, {
        readEligible: () => [readyTicket("CTL-5")],
        dispatch: okDispatch,
        writeStatus,
      })
    ).not.toThrow();
  });
});

// ── CTL-558: deterministic label write-back (triaged / needs-human) ──

describe("schedulerTick — label write-back (CTL-558)", () => {
  const noWrites = () => ({
    applyPhaseStatus() {},
    applyTerminalDone() {},
  });

  test("applies the `triaged` label when a ticket's triage signal is done", () => {
    writeSignal("CTL-6", "triage", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const labels = [];
    const writeStatus = { ...noWrites(), applyLabel: (a) => labels.push(a) };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(labels).toContainEqual(
      expect.objectContaining({ ticket: "CTL-6", label: "triaged" })
    );
  });

  test("applies `needs-human` when any phase signal is stalled", () => {
    writeSignal("CTL-7", "implement", "stalled");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const labels = [];
    const writeStatus = { ...noWrites(), applyLabel: (a) => labels.push(a) };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(labels).toContainEqual(
      expect.objectContaining({ ticket: "CTL-7", label: "needs-human" })
    );
  });

  test("does not re-apply a label once the .applied marker exists", () => {
    writeSignal("CTL-7", "implement", "stalled");
    writeFileSync(
      join(orchDir, "workers", "CTL-7", ".linear-label-needs-human.applied"),
      ""
    );
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const labels = [];
    const writeStatus = { ...noWrites(), applyLabel: (a) => labels.push(a) };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(labels).toHaveLength(0);
  });

  test("writes the .applied marker only after applyLabel reports applied:true", () => {
    writeSignal("CTL-8", "triage", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const markerPath = join(orchDir, "workers", "CTL-8", ".linear-label-triaged.applied");
    // applyLabel reports failure → no marker written → retried next tick.
    const failWrite = { ...noWrites(), applyLabel: () => ({ applied: false }) };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus: failWrite });
    expect(existsSync(markerPath)).toBe(false);
    // applyLabel succeeds → marker written → not retried.
    const okWrite = { ...noWrites(), applyLabel: () => ({ applied: true }) };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus: okWrite });
    expect(existsSync(markerPath)).toBe(true);
  });

  test("a label-write throw never aborts the tick", () => {
    writeSignal("CTL-9", "triage", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => {
        throw new Error("label boom");
      },
    };
    expect(() =>
      schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus })
    ).not.toThrow();
  });
});

// ── CTL-582: worktree teardown on terminal Done ──

describe("schedulerTick — worktree teardown on Done (CTL-582)", () => {
  // teardownWorktreeOnce resolves repoRoot from the registry; write a fixture
  // under the test's CATALYST_DIR so the resolution succeeds.
  function writeRegistry(team, repoRoot) {
    const ecDir = join(catalystDir, "execution-core");
    mkdirSync(ecDir, { recursive: true });
    writeFileSync(
      join(ecDir, "registry.json"),
      JSON.stringify({ projects: [{ team, repoRoot, eligibleQuery: {} }] }),
    );
  }
  const noStatusWrites = () => ({
    applyPhaseStatus() {},
    applyTerminalDone() {},
    applyLabel() {},
  });
  const markerPath = (ticket) =>
    join(orchDir, "workers", ticket, ".worktree-removed");

  test("calls teardownWorktree with { repoRoot, ticket } when monitor-deploy is done", () => {
    writeSignal("CTL-4", "monitor-deploy", "done");
    writeRegistry("CTL", "/repo/ctl");
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: noStatusWrites(),
      teardownWorktree: (a) => {
        calls.push(a);
        return true;
      },
    });
    expect(calls).toEqual([{ repoRoot: "/repo/ctl", ticket: "CTL-4" }]);
  });

  test("a once-marker makes teardown fire a single time across ticks", () => {
    writeSignal("CTL-4", "monitor-deploy", "done");
    writeRegistry("CTL", "/repo/ctl");
    let count = 0;
    const opts = {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: noStatusWrites(),
      teardownWorktree: () => {
        count += 1;
        return true;
      },
    };
    schedulerTick(orchDir, opts);
    schedulerTick(orchDir, opts);
    expect(count).toBe(1);
    expect(existsSync(markerPath("CTL-4"))).toBe(true);
  });

  test("a teardown that returns false is retried — no once-marker written", () => {
    writeSignal("CTL-4", "monitor-deploy", "done");
    writeRegistry("CTL", "/repo/ctl");
    let count = 0;
    const opts = {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: noStatusWrites(),
      teardownWorktree: () => {
        count += 1;
        return false; // git failure — not yet torn down
      },
    };
    schedulerTick(orchDir, opts);
    schedulerTick(orchDir, opts);
    expect(count).toBe(2);
    expect(existsSync(markerPath("CTL-4"))).toBe(false);
  });

  test("a thrown teardown never aborts the tick", () => {
    writeSignal("CTL-4", "monitor-deploy", "done");
    writeRegistry("CTL", "/repo/ctl");
    expect(() =>
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: fakeDispatch(),
        writeStatus: noStatusWrites(),
        teardownWorktree: () => {
          throw new Error("boom");
        },
      }),
    ).not.toThrow();
  });

  test("no teardown when the ticket has not reached terminal Done", () => {
    writeSignal("CTL-5", "implement", "done"); // mid-pipeline, not monitor-deploy
    writeRegistry("CTL", "/repo/ctl");
    let called = false;
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: noStatusWrites(),
      teardownWorktree: () => {
        called = true;
        return true;
      },
    });
    expect(called).toBe(false);
  });
});
