// Unit + filesystem-fixture tests for the pull-loop scheduler (CTL-536).
// Run: cd plugins/dev/scripts/execution-core && bun test scheduler.test.mjs
//
// Phase 3 adds the selection-core blocks; Phases 4-5 extend this same file.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
} from "./scheduler.mjs";

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "sched-"));
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

function writeSignal(ticket, phase, status) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `phase-${phase}.json`),
    JSON.stringify({ ticket, phase, status }),
  );
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
    expect(isTicketInFlight({ triage: "done", research: "running" })).toBe(
      true,
    );
  });
  test("plan done + no later signal (advance window) is still in-flight", () => {
    expect(
      isTicketInFlight({ triage: "done", research: "done", plan: "done" }),
    ).toBe(true);
  });
  test("monitor-deploy done is terminal success → NOT in-flight", () => {
    expect(isTicketInFlight({ "monitor-deploy": "done" })).toBe(false);
  });
  test("a failed or stalled signal is terminal → NOT in-flight", () => {
    expect(isTicketInFlight({ implement: "failed" })).toBe(false);
    expect(isTicketInFlight({ verify: "stalled" })).toBe(false);
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
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({ maxParallel: 3 }),
    );
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
    expect(
      deriveAdvancement({ triage: "done", research: "done", plan: "done" }),
    ).toBe("implement");
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
  test("no signals → null", () => {
    expect(deriveAdvancement({})).toBeNull();
  });
});

describe("schedulerTick — new-work pull", () => {
  test("dispatches triage for the top-ranked ready ticket into a free slot", () => {
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({ maxParallel: 2 }),
    );
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
    expect(dispatch.calls.every((c) => c.phase === "triage")).toBe(true);
    expect(r.dispatched).toEqual(["CTL-8", "CTL-9"]);
  });

  test("respects maxParallel — no dispatch when slots are full", () => {
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({ maxParallel: 1 }),
    );
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
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({ maxParallel: 2 }),
    );
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
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({ maxParallel: 1 }),
    );
    writeSignal("CTL-7", "triage", "done"); // research is owed
    const dispatch = fakeDispatch();
    const r = schedulerTick(orchDir, { readEligible: () => [], dispatch });
    expect(dispatch.calls).toEqual([
      { orchDir, ticket: "CTL-7", phase: "research" },
    ]);
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
  });

  test("a failed-dispatch (non-zero exit) is a soft skip, not a throw", () => {
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({ maxParallel: 1 }),
    );
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
});

describe("listStartedTickets", () => {
  test("returns every worker dir regardless of status (started ≠ in-flight)", () => {
    writeSignal("CTL-1", "implement", "running");
    writeSignal("CTL-2", "triage", "failed");
    writeSignal("CTL-3", "monitor-deploy", "done");
    expect([...listStartedTickets(orchDir)].sort()).toEqual([
      "CTL-1",
      "CTL-2",
      "CTL-3",
    ]);
  });
});
