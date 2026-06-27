import { test, expect } from "bun:test";
import {
  runReconcileDrain,
  startLinearReconcileTimer,
  readLinearReconcileConfig,
  makeApplyCorrection,
} from "./linear-reconcile-timer.mjs";

const CTL_MAP = {
  backlog: "Backlog",
  inProgress: "Implement",
  inReview: "PR",
  done: "Done",
  canceled: "Canceled",
};
const TERMINAL = ["Done", "Canceled", "Duplicate"];

function harness({ states = {}, pending = [], mode = "notify" } = {}) {
  const writes = [];
  const events = [];
  const reconciled = [];
  let persisted = null;
  return {
    writes,
    events,
    reconciled,
    get persisted() {
      return persisted;
    },
    args: {
      stateMap: CTL_MAP,
      terminalStates: TERMINAL,
      mode,
      listPending: () => pending,
      readState: async (t) => states[t] ?? null,
      applyCorrection: async ({ ticket, kind }) => {
        writes.push({ ticket, kind });
        return {
          applied: true,
          action: "transitioned",
          from_state: states[ticket] ?? null,
          to_state: kind === "done" ? "Done" : "PR",
        };
      },
      markReconciledFn: (t, s) => reconciled.push({ t, s }),
      emit: (name, payload) => events.push({ name, payload }),
      persist: (s) => {
        persisted = s;
      },
      nowMs: 1000,
    },
  };
}

test("write mode: drains pending declarations, marks reconciled, emits reconciled events", async () => {
  const h = harness({
    pending: [
      { ticket: "CTL-1", state: "done" },
      { ticket: "CTL-2", state: "done" },
    ],
    states: { "CTL-1": "Done", "CTL-2": "Implement" }, // CTL-1 already Done
    mode: "write",
  });
  const res = await runReconcileDrain(h.args);
  expect(h.writes).toEqual([{ ticket: "CTL-2", kind: "done" }]); // CTL-1 in-sync → no write
  // Both are reconciled: CTL-1 was already Done (in-sync), CTL-2 just written.
  expect(h.reconciled).toEqual([
    { t: "CTL-1", s: "Done" },
    { t: "CTL-2", s: "Done" },
  ]);
  expect(h.events.map((e) => e.name)).toEqual(["ticket.completion.reconciled.CTL-2"]);
  expect(res.summary.corrected).toBe(1);
  expect(res.summary.inSync).toBe(1);
});

test("notify mode: writes nothing, marks nothing, emits confident drift only", async () => {
  const h = harness({
    pending: [{ ticket: "CTL-2", state: "done" }],
    states: { "CTL-2": "Implement" },
    mode: "notify",
  });
  await runReconcileDrain(h.args);
  expect(h.writes).toEqual([]);
  expect(h.reconciled).toEqual([]);
  expect(h.events.map((e) => e.name)).toEqual(["ticket.completion.drift.CTL-2"]);
});

test("no pending declarations → no-op tick with an empty summary", async () => {
  const h = harness({ pending: [], mode: "write" });
  const res = await runReconcileDrain(h.args);
  expect(res.summary.tickets).toBe(0);
  expect(h.writes).toEqual([]);
  expect(h.persisted.summary.tickets).toBe(0);
});

test("a 'done' declaration with unreadable state is unconfirmed (no write), not silent", async () => {
  const h = harness({ pending: [{ ticket: "CTL-9", state: "done" }], states: {}, mode: "write" });
  const res = await runReconcileDrain(h.args);
  expect(h.writes).toEqual([]);
  expect(res.summary.unconfirmed).toBe(1);
});

// ── makeApplyCorrection routing ──────────────────────────────────────────────

test("makeApplyCorrection routes done→applyTerminalDone and inReview→applyPhaseStatus({phase:'pr'})", () => {
  const calls = [];
  const apply = makeApplyCorrection({
    applyTerminalDone: (a) => {
      calls.push(["done", a]);
      return { applied: true };
    },
    applyPhaseStatus: (a) => {
      calls.push(["phase", a]);
      return { applied: true };
    },
  });
  apply({ ticket: "CTL-1", kind: "done" });
  apply({ ticket: "CTL-2", kind: "inReview" });
  expect(calls).toEqual([
    ["done", { ticket: "CTL-1" }],
    ["phase", { ticket: "CTL-2", phase: "pr" }],
  ]);
});

// ── startLinearReconcileTimer gating + tick-error isolation (fake clock) ──────

function fakeClock() {
  let cb = null;
  return {
    setInterval: (fn) => {
      cb = fn;
      return { unref() {} };
    },
    clearInterval: () => {
      cb = null;
    },
    now: () => 1000,
    started: () => cb !== null,
    async tick() {
      if (cb) await cb();
    },
  };
}

test("mode 'off' never starts the interval", () => {
  const clock = fakeClock();
  startLinearReconcileTimer({ mode: "off", orchDir: "/tmp/x", clock });
  expect(clock.started()).toBe(false);
});

test("missing orchDir → no-op handle", () => {
  const clock = fakeClock();
  startLinearReconcileTimer({ mode: "write", orchDir: undefined, clock });
  expect(clock.started()).toBe(false);
});

test("a tick that throws is isolated — does not propagate", async () => {
  const clock = fakeClock();
  let persisted = false;
  startLinearReconcileTimer({
    mode: "notify",
    orchDir: "/tmp/x",
    configPath: "/ignored",
    clock,
    readFullConfig: () => ({ catalyst: { linear: { stateMap: CTL_MAP } } }),
    listPending: () => {
      throw new Error("store boom");
    },
    readState: async () => null,
    persist: () => {
      persisted = true;
    },
  });
  await clock.tick();
  expect(persisted).toBe(false);
});

test("write-mode tick wires config stateMap through to a real drain", async () => {
  const clock = fakeClock();
  const writes = [];
  startLinearReconcileTimer({
    mode: "write",
    orchDir: "/tmp/x",
    configPath: "/ignored",
    clock,
    readFullConfig: () => ({ catalyst: { linear: { stateMap: CTL_MAP } } }),
    listPending: () => [{ ticket: "CTL-2", state: "done" }],
    readState: async () => "Implement",
    applyCorrection: async ({ ticket, kind }) => {
      writes.push({ ticket, kind });
      return { applied: true, action: "transitioned", from_state: "Implement", to_state: "Done" };
    },
    markReconciledFn: () => {},
    emit: () => {},
    persist: () => {},
  });
  await clock.tick();
  expect(writes).toEqual([{ ticket: "CTL-2", kind: "done" }]);
});

test("readLinearReconcileConfig returns {} on absent file and reads the nested block", () => {
  expect(readLinearReconcileConfig(null)).toEqual({});
  expect(readLinearReconcileConfig("/nonexistent/config.json")).toEqual({});
});
