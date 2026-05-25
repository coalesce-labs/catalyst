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
  readFileSync,
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
  preflightWorkspaceLabels,
  inDispatchCooldown,
  recordDispatchFailure,
  clearDispatchCooldown,
  dispatchCooldownPath,
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
  test("monitor-deploy skipped is terminal success → NOT in-flight (CTL-512)", () => {
    expect(isTicketInFlight({ "monitor-deploy": "skipped" })).toBe(false);
  });
  test("monitor-deploy skipped with earlier phases done → NOT in-flight (CTL-512)", () => {
    expect(
      isTicketInFlight({
        triage: "done",
        research: "done",
        plan: "done",
        implement: "done",
        verify: "done",
        review: "done",
        pr: "done",
        "monitor-merge": "done",
        "monitor-deploy": "skipped",
      })
    ).toBe(false);
  });
  test("non-terminal phase with status=skipped (defensive) → still in-flight (CTL-512)", () => {
    // skipped is only a recognized terminal for monitor-deploy. Treating it as
    // terminal on any other phase would silently free slots on producer bugs.
    expect(isTicketInFlight({ triage: "skipped" })).toBe(true);
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

// ── CTL-624: per-(ticket,phase) dispatch cool-down helpers ──
describe("dispatch cool-down helpers", () => {
  test("no marker → not in cool-down", () => {
    expect(inDispatchCooldown(orchDir, "CTL-1", "research", 1_000)).toBe(false);
  });

  test("recordDispatchFailure writes a timestamped marker", () => {
    recordDispatchFailure(orchDir, "CTL-1", "research", 2, 5_000);
    const p = dispatchCooldownPath(orchDir, "CTL-1", "research");
    expect(existsSync(p)).toBe(true);
    const m = JSON.parse(readFileSync(p, "utf8"));
    expect(m).toMatchObject({ phase: "research", code: 2, failedAt: 5_000 });
  });

  test("within the window → in cool-down; past the window → not", () => {
    recordDispatchFailure(orchDir, "CTL-1", "research", 2, 5_000);
    // 30 s later (< 60 s window) → still cooling down.
    expect(inDispatchCooldown(orchDir, "CTL-1", "research", 35_000)).toBe(true);
    // 61 s later (> 60 s window) → window elapsed.
    expect(inDispatchCooldown(orchDir, "CTL-1", "research", 66_000)).toBe(false);
  });

  test("cool-down is per-(ticket,phase)", () => {
    recordDispatchFailure(orchDir, "CTL-1", "research", 2, 5_000);
    expect(inDispatchCooldown(orchDir, "CTL-1", "plan", 6_000)).toBe(false);
    expect(inDispatchCooldown(orchDir, "CTL-2", "research", 6_000)).toBe(false);
  });

  test("clearDispatchCooldown removes the marker (idempotent if absent)", () => {
    recordDispatchFailure(orchDir, "CTL-1", "research", 2, 5_000);
    clearDispatchCooldown(orchDir, "CTL-1", "research");
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-1", "research"))).toBe(false);
    expect(() => clearDispatchCooldown(orchDir, "CTL-1", "research")).not.toThrow();
  });

  test("a malformed marker is treated as absent (not in cool-down)", () => {
    // recordDispatchFailure creates the cool-down dir + a valid marker; then
    // corrupt the file in place so the path stays decoupled from its location.
    recordDispatchFailure(orchDir, "CTL-1", "research", 2, 5_000);
    writeFileSync(dispatchCooldownPath(orchDir, "CTL-1", "research"), "not json");
    expect(inDispatchCooldown(orchDir, "CTL-1", "research", 6_000)).toBe(false);
  });
});

// ── CTL-624: dispatch cool-down wired into schedulerTick ──
describe("dispatch cool-down (schedulerTick)", () => {
  const eligibleOne = (id) => [
    {
      identifier: id,
      priority: 1,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    },
  ];

  test("a refused new-work dispatch (code 2) writes a cool-down marker and stops re-dispatching", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 2 });
    const marker = dispatchCooldownPath(orchDir, "CTL-3", "research");

    // Tick 1 at t=1000: dispatch refused → 1 call, marker written.
    schedulerTick(orchDir, { readEligible: () => eligibleOne("CTL-3"), dispatch, now: () => 1_000 });
    expect(dispatch.calls).toHaveLength(1);
    expect(existsSync(marker)).toBe(true);

    // Tick 2 at t=30_000 (< 60 s window): suppressed → still 1 call.
    schedulerTick(orchDir, { readEligible: () => eligibleOne("CTL-3"), dispatch, now: () => 30_000 });
    expect(dispatch.calls).toHaveLength(1);

    // Tick 3 at t=70_000 (> 60 s window): re-dispatch fires → 2 calls.
    schedulerTick(orchDir, { readEligible: () => eligibleOne("CTL-3"), dispatch, now: () => 70_000 });
    expect(dispatch.calls).toHaveLength(2);
  });

  test("a successful dispatch clears any prior cool-down marker", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const marker = dispatchCooldownPath(orchDir, "CTL-4", "research");

    // First a refusal seeds the marker.
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-4"),
      dispatch: fakeDispatch({ code: 2 }),
      now: () => 1_000,
    });
    expect(existsSync(marker)).toBe(true);

    // After the window, a successful dispatch clears it.
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-4"),
      dispatch: fakeDispatch({ code: 0 }),
      now: () => 70_000,
    });
    expect(existsSync(marker)).toBe(false);
  });

  test("a pre-seeded in-window marker suppresses the dispatch entirely (calls === 0)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    recordDispatchFailure(orchDir, "CTL-5", "research", 2, 1_000);
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, { readEligible: () => eligibleOne("CTL-5"), dispatch, now: () => 20_000 });
    expect(dispatch.calls).toHaveLength(0);
  });

  test("a refused advancement dispatch is throttled by the cool-down", () => {
    writeSignal("CTL-6", "research", "done"); // FSM next = plan
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 2 });

    schedulerTick(orchDir, { readEligible: () => [], dispatch, now: () => 1_000 });
    expect(dispatch.calls).toHaveLength(1);
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-6", "plan"))).toBe(true);

    schedulerTick(orchDir, { readEligible: () => [], dispatch, now: () => 30_000 });
    expect(dispatch.calls).toHaveLength(1); // suppressed within window
  });
});

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

  test("writes terminal Done when a ticket's monitor-deploy signal is skipped (CTL-589)", () => {
    // CTL-512 fixed isTicketInFlight to treat `skipped` as terminal; this is
    // the matching half — the terminal-Done sweep must also fire on `skipped`
    // so the Linear ticket actually lands at Done (not stale at PR).
    writeSignal("CTL-4", "monitor-deploy", "skipped");
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

  // CTL-585: short-circuit the per-tick retry on an unrecoverable miss.
  test("writes the .skipped marker on reason:'missing-label' and stops retrying", () => {
    writeSignal("CTL-10", "triage", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const skipped = join(orchDir, "workers", "CTL-10", ".linear-label-triaged.skipped");
    const applied = join(orchDir, "workers", "CTL-10", ".linear-label-triaged.applied");

    let calls = 0;
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => {
        calls += 1;
        return { applied: false, reason: "missing-label" };
      },
    };

    // Tick 1: missing-label → .skipped written, .applied not written.
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(existsSync(skipped)).toBe(true);
    expect(existsSync(applied)).toBe(false);
    expect(calls).toBe(1);

    // Tick 2: marker present → applyLabel never invoked again.
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(calls).toBe(1);
  });

  test("a transient failure still retries on the next tick", () => {
    writeSignal("CTL-11", "triage", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const skipped = join(orchDir, "workers", "CTL-11", ".linear-label-triaged.skipped");

    let calls = 0;
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => {
        calls += 1;
        return { applied: false, reason: "transient" };
      },
    };

    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(calls).toBe(2);
    expect(existsSync(skipped)).toBe(false);
  });

  test("a rate-limited failure still retries on the next tick", () => {
    writeSignal("CTL-12", "triage", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    let calls = 0;
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => {
        calls += 1;
        return { applied: false, reason: "rate-limited" };
      },
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(calls).toBe(2);
  });

  test("a pre-existing .skipped marker prevents re-attempt", () => {
    writeSignal("CTL-13", "triage", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // Pre-seed the .skipped marker (simulates a previous daemon run that hit
    // the missing-label path).
    writeFileSync(
      join(orchDir, "workers", "CTL-13", ".linear-label-triaged.skipped"),
      ""
    );
    let calls = 0;
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => {
        calls += 1;
        return { applied: true, reason: null };
      },
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(calls).toBe(0);
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

  test("calls teardownWorktree when monitor-deploy is skipped (CTL-589)", () => {
    // CTL-512 followup — `skipped` is the second terminal status for
    // monitor-deploy; without this, the worktree leaks on disk forever for
    // tickets whose deploy verification was skipped.
    writeSignal("CTL-4", "monitor-deploy", "skipped");
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

  test("no teardown + no marker when the ticket's team has no registry entry", () => {
    writeSignal("CTL-4", "monitor-deploy", "done");
    // deliberately no writeRegistry — getProjectConfig("CTL") resolves to null
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
    expect(existsSync(markerPath("CTL-4"))).toBe(false); // retryable — no marker
  });
});

// --- CTL-574: reclaim-dead-work step in schedulerTick -----------------------

describe("schedulerTick — CTL-574 reclaim-dead-work sweep", () => {
  // writeNestedSignal — write a worker signal with the full shape signal-reader
  // produces (status + bg_job_id), so classifyWorker can be driven by the real
  // pipeline. The reclaim path uses this signal's phase + ticket.
  function writeNestedSignal(ticket, phase, body) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `phase-${phase}.json`),
      JSON.stringify({ ticket, phase, ...body }),
    );
  }

  test("schedulerTick calls the injected reclaimDeadWork once per worker signal", () => {
    // Two in-flight tickets with a single phase signal each — readWorkerSignals
    // returns one (active) per ticket, so reclaimDeadWork is called twice.
    writeNestedSignal("CTL-1", "implement", { status: "running", bg_job_id: "j1" });
    writeNestedSignal("CTL-2", "implement", { status: "running", bg_job_id: "j2" });

    const reclaimDeadWork = recorder("noop");
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: { applyPhaseStatus: () => {}, applyTerminalDone: () => {} },
      teardownWorktree: () => true,
      reclaimDeadWork,
    });
    expect(reclaimDeadWork.calls.length).toBe(2);
    // each call gets (orchDir, signal, { repoRoot }).
    for (const args of reclaimDeadWork.calls) {
      expect(args[0]).toBe(orchDir);
      expect(args[1].phase).toBe("implement");
      expect(["CTL-1", "CTL-2"]).toContain(args[1].ticket);
      expect(typeof args[2]).toBe("object");
      expect(args[2]).toHaveProperty("repoRoot");
    }
  });

  test("a 'reclaimed' result flips the signal (via emit-complete) so advancement fires the next phase same tick", () => {
    // The reclaim's emit-complete spawns phase-agent-emit-complete which flips
    // the signal on disk. In this unit test we don't actually run that script,
    // so we simulate it by mutating the on-disk signal inside the injected
    // reclaimDeadWork itself — the canonical "reclaim outcome" the production
    // path produces.
    writeNestedSignal("CTL-1", "implement", { status: "running", bg_job_id: "j1" });
    writeNestedSignal("CTL-1", "research", { status: "done" });
    writeNestedSignal("CTL-1", "plan", { status: "done" });
    writeNestedSignal("CTL-1", "triage", { status: "done" });

    const reclaimDeadWork = (_orchDir, sig) => {
      // simulate the emit-complete signal flip
      const signalPath = join(orchDir, "workers", sig.ticket, `phase-${sig.phase}.json`);
      writeFileSync(
        signalPath,
        JSON.stringify({ ticket: sig.ticket, phase: sig.phase, status: "done", completedAt: "t" }),
      );
      return "reclaimed";
    };
    const dispatch = recorder({ code: 0 });
    const writeStatus = { applyPhaseStatus: () => {}, applyTerminalDone: () => {} };

    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork,
    });

    // Advancement saw the reclaimed implement: dispatch was called with the
    // next phase (`verify`) for CTL-1. dispatchTicket invokes the seam as
    // `dispatch({ orchDir, ticket, phase })`, so calls[i][0] is the object.
    const verifyDispatches = dispatch.calls.filter((args) => args[0]?.phase === "verify");
    expect(verifyDispatches.length).toBe(1);
    expect(verifyDispatches[0][0].ticket).toBe("CTL-1");

    // The tick's return object reports the reclaim alongside the advance.
    expect(result.reclaimed).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
    expect(result.advanced).toEqual([{ ticket: "CTL-1", phase: "verify" }]);
  });

  test("a 'noop' / 'not-done' / 'not-applicable' result is invisible to advancement", () => {
    writeNestedSignal("CTL-1", "implement", { status: "running", bg_job_id: "j1" });

    // reclaim returns not-done — signal stays running, advancement skips.
    const reclaimDeadWork = () => "not-done";
    const dispatch = recorder({ code: 0 });
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: { applyPhaseStatus: () => {}, applyTerminalDone: () => {} },
      teardownWorktree: () => true,
      reclaimDeadWork,
    });
    expect(dispatch.calls.length).toBe(0);
    expect(result.reclaimed).toEqual([]);
  });

  test("default reclaimDeadWork is wired to the real recovery function (no injection still safe)", () => {
    // No injected reclaimDeadWork. With no dead workers in the fixture, the
    // real reclaim short-circuits to 'noop' for every signal and the tick is
    // a normal-path no-op. This proves the default seam doesn't throw on a
    // clean tick.
    expect(() =>
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: () => ({ code: 0 }),
        writeStatus: { applyPhaseStatus: () => {}, applyTerminalDone: () => {} },
        teardownWorktree: () => true,
      }),
    ).not.toThrow();
  });
});

// CTL-587: scheduler Step 0 returns parallel arrays for the new outcomes
// from reclaimDeadWorkIfPossible — revived, reviveSuppressed, escalated —
// alongside the pre-existing reclaimed[]. Existing consumers that ignore
// unknown keys are unaffected.
describe("schedulerTick — CTL-587 Step 0 multi-result shape", () => {
  function writeNestedSignal(ticket, phase, body) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `phase-${phase}.json`),
      JSON.stringify({ ticket, phase, ...body }),
    );
  }

  const writeStatus = {
    applyPhaseStatus: () => {},
    applyTerminalDone: () => {},
    applyLabel: () => ({ applied: true }),
  };

  test("'revived' result populates result.revived (and leaves reclaimed empty)", () => {
    writeNestedSignal("CTL-7", "implement", { status: "running", bg_job_id: "bg-7" });
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork: () => "revived",
    });
    expect(result.revived).toEqual([{ ticket: "CTL-7", phase: "implement" }]);
    expect(result.reclaimed).toEqual([]);
    expect(result.escalated).toEqual([]);
    expect(result.reviveSuppressed).toEqual([]);
  });

  test("'revive-suppressed' result populates result.reviveSuppressed", () => {
    writeNestedSignal("CTL-8", "implement", { status: "running", bg_job_id: "bg-8" });
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork: () => "revive-suppressed",
    });
    expect(result.reviveSuppressed).toEqual([{ ticket: "CTL-8", phase: "implement" }]);
    expect(result.revived).toEqual([]);
  });

  test("'escalated' result populates result.escalated", () => {
    writeNestedSignal("CTL-9", "pr", { status: "running", bg_job_id: "bg-9" });
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork: () => "escalated",
    });
    expect(result.escalated).toEqual([{ ticket: "CTL-9", phase: "pr" }]);
  });

  test("mixed returns across multiple signals end up in the right buckets", () => {
    writeNestedSignal("CTL-7", "implement", { status: "running", bg_job_id: "bg-7" });
    writeNestedSignal("CTL-8", "implement", { status: "running", bg_job_id: "bg-8" });
    writeNestedSignal("CTL-9", "pr", { status: "running", bg_job_id: "bg-9" });
    const reclaimDeadWork = (_orchDir, sig) => {
      if (sig.ticket === "CTL-7") return "revived";
      if (sig.ticket === "CTL-8") return "reclaimed";
      if (sig.ticket === "CTL-9") return "escalated";
      return "noop";
    };
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork,
    });
    expect(result.revived).toEqual([{ ticket: "CTL-7", phase: "implement" }]);
    expect(result.escalated).toEqual([{ ticket: "CTL-9", phase: "pr" }]);
    // reclaimed: emit-complete is stubbed via the seam, but the canonical
    // path mutates the signal — we just check the array is populated.
    expect(result.reclaimed.map((e) => e.ticket)).toContain("CTL-8");
  });

  test("clean tick (no dead workers) returns empty arrays for every CTL-587 outcome", () => {
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork: () => "noop",
    });
    expect(result.revived).toEqual([]);
    expect(result.reviveSuppressed).toEqual([]);
    expect(result.escalated).toEqual([]);
    expect(result.reclaimed).toEqual([]);
  });
});

// recorder — small spy that records args and returns either a constant value or
// a function-derived value. Local to this describe to avoid leaking into the
// existing block-scope helpers.
function recorder(returnValue) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return typeof returnValue === "function" ? returnValue(...args) : returnValue;
  };
  fn.calls = calls;
  return fn;
}

// ── CTL-585: daemon-start preflight for missing workspace labels ──

describe("preflightWorkspaceLabels (CTL-585)", () => {
  test("warns once per missing label per team", () => {
    const warnings = [];
    const fakeLog = {
      warn: (obj, msg) => warnings.push({ obj, msg }),
      info: () => {},
      error: () => {},
    };
    const exec = (cmd, args) => {
      expect(cmd).toBe("linearis");
      expect(args.slice(0, 3)).toEqual(["labels", "list", "--team"]);
      const team = args[3];
      // linearis labels list emits JSON ({nodes:[{name,...},...]}).
      // CTL is missing both expected labels; ENG has both.
      const nodes = team === "CTL"
        ? [{ name: "orchestrate" }, { name: "enhancement" }]
        : [{ name: "triaged" }, { name: "needs-human" }, { name: "bug" }];
      return { code: 0, stdout: JSON.stringify({ nodes }), stderr: "" };
    };
    preflightWorkspaceLabels({
      teams: ["CTL", "ENG"],
      exec,
      log: fakeLog,
    });
    const ctlWarns = warnings.filter(
      (w) => w.obj?.team === "CTL" && w.msg.includes("missing required label"),
    );
    expect(ctlWarns.map((w) => w.obj.label).sort()).toEqual([
      "needs-human",
      "triaged",
    ]);
    const engWarns = warnings.filter((w) => w.obj?.team === "ENG");
    expect(engWarns).toHaveLength(0);
  });

  test("does not throw on a linearis spawn failure", () => {
    const fakeLog = { warn: () => {}, info: () => {}, error: () => {} };
    const exec = () => ({ code: 127, stdout: "", stderr: "ENOENT" });
    expect(() =>
      preflightWorkspaceLabels({ teams: ["CTL"], exec, log: fakeLog }),
    ).not.toThrow();
  });

  test("does not throw on a thrown exec", () => {
    const fakeLog = { warn: () => {}, info: () => {}, error: () => {} };
    const exec = () => {
      throw new Error("boom");
    };
    expect(() =>
      preflightWorkspaceLabels({ teams: ["CTL"], exec, log: fakeLog }),
    ).not.toThrow();
  });

  test("real JSON shape with both labels present produces zero warnings", () => {
    // Regression: an early draft split stdout on newlines, which produced
    // false-positive warnings against the real JSON output every daemon start.
    const warnings = [];
    const fakeLog = {
      warn: (obj, msg) => warnings.push({ obj, msg }),
      info: () => {},
      error: () => {},
    };
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({
        nodes: [
          { name: "triaged", color: "#000" },
          { name: "needs-human", color: "#fff" },
          { name: "bug" },
        ],
      }),
      stderr: "",
    });
    preflightWorkspaceLabels({ teams: ["CTL"], exec, log: fakeLog });
    expect(warnings).toHaveLength(0);
  });

  test("non-JSON stdout is a soft skip, not a throw", () => {
    const infos = [];
    const fakeLog = {
      warn: () => {},
      info: (obj, msg) => infos.push({ obj, msg }),
      error: () => {},
    };
    const exec = () => ({ code: 0, stdout: "not json at all", stderr: "" });
    expect(() =>
      preflightWorkspaceLabels({ teams: ["CTL"], exec, log: fakeLog }),
    ).not.toThrow();
    expect(infos.some((i) => i.msg.includes("stdout is not JSON"))).toBe(true);
  });

  test("empty teams list is a no-op", () => {
    const fakeLog = { warn: () => {}, info: () => {}, error: () => {} };
    let calls = 0;
    const exec = () => {
      calls += 1;
      return { code: 0, stdout: "", stderr: "" };
    };
    preflightWorkspaceLabels({ teams: [], exec, log: fakeLog });
    expect(calls).toBe(0);
  });
});

describe("startScheduler — preflight wiring (CTL-585)", () => {
  afterEach(() => __resetForTests());

  test("invokes preflightWorkspaceLabels once at startup using listProjects() teams", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const calls = [];
    const fakePreflight = (opts) => calls.push(opts);
    startScheduler({
      orchDir,
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: { applyPhaseStatus() {}, applyTerminalDone() {}, applyLabel() {} },
      preflight: fakePreflight,
      tickIntervalMs: 1_000_000, // suppress the periodic tick from firing in-test
    });
    stopScheduler();
    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0].teams)).toBe(true);
  });
});

// ── CTL-597: terminal-Done once-marker (.terminal-done.applied) ──

describe("schedulerTick — terminal-Done once-marker (CTL-597)", () => {
  // Helper consistent with the existing suites: a writeStatus whose label/phase
  // writes are no-ops; only applyTerminalDone is the subject under test.
  function terminalNoWrites() {
    return { applyPhaseStatus() {}, applyLabel() {} };
  }

  test("does not re-write terminal Done once the .terminal-done.applied marker exists", () => {
    writeSignal("CTL-20", "monitor-deploy", "done");
    writeFileSync(
      join(orchDir, "workers", "CTL-20", ".terminal-done.applied"),
      ""
    );
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dones = [];
    const writeStatus = {
      ...terminalNoWrites(),
      applyTerminalDone: (a) => dones.push(a),
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    // Marker present → applyTerminalDone (and its Linear read) is never called.
    expect(dones).toHaveLength(0);
  });

  test("writes the .terminal-done.applied marker only after applyTerminalDone reports applied:true", () => {
    writeSignal("CTL-21", "monitor-deploy", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const markerPath = join(orchDir, "workers", "CTL-21", ".terminal-done.applied");
    // applied:false → no marker → retried next tick.
    const failWrite = { ...terminalNoWrites(), applyTerminalDone: () => ({ applied: false }) };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus: failWrite });
    expect(existsSync(markerPath)).toBe(false);
    // applied:true → marker written → not retried.
    const okWrite = { ...terminalNoWrites(), applyTerminalDone: () => ({ applied: true }) };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus: okWrite });
    expect(existsSync(markerPath)).toBe(true);
  });

  test("fires applyTerminalDone once across ticks (skipped is also terminal, CTL-589)", () => {
    writeSignal("CTL-22", "monitor-deploy", "skipped");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    let count = 0;
    const writeStatus = {
      ...terminalNoWrites(),
      applyTerminalDone: () => {
        count++;
        return { applied: true };
      },
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(count).toBe(1);
    expect(existsSync(join(orchDir, "workers", "CTL-22", ".terminal-done.applied"))).toBe(true);
  });

  test("a terminal-Done write throw never aborts the tick", () => {
    writeSignal("CTL-23", "monitor-deploy", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const writeStatus = {
      ...terminalNoWrites(),
      applyTerminalDone: () => {
        throw new Error("terminal boom");
      },
    };
    expect(() =>
      schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus })
    ).not.toThrow();
    // No marker on a thrown apply → retried next tick.
    expect(existsSync(join(orchDir, "workers", "CTL-23", ".terminal-done.applied"))).toBe(false);
  });
});
