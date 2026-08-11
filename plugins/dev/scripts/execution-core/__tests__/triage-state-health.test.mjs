import { beforeEach, describe, expect, test } from "bun:test";
import { recordTriageStateWrite, isTriageStateFaulted, shouldProbeTriageState, markTriageStateProbe, resetTriageStateHealth } from "../triage-state-health.mjs";
import { TRANSITION_STATE_ABSENT } from "../linear-write.mjs";

let marker;
let events;
const deps = (over = {}) => ({
  readMarker: () => marker,
  writeMarker: (_team, state) => { marker = structuredClone(state); },
  appendEvent: (event) => { events.push(event); return true; },
  nowMs: 1000,
  ...over,
});

beforeEach(() => { marker = null; events = []; resetTriageStateHealth(); });

describe("recordTriageStateWrite (CAT-140)", () => {
  test("structural writes latch once and verified recovery clears once", () => {
    recordTriageStateWrite("CAT", { reason: TRANSITION_STATE_ABSENT, expectedState: "Triage" }, deps());
    recordTriageStateWrite("CAT", { reason: TRANSITION_STATE_ABSENT, expectedState: "Triage" }, deps({ nowMs: 1100 }));
    expect(events.map((e) => e.action)).toEqual(["missing"]);
    expect(isTriageStateFaulted("CAT", deps())).toBe(true);
    recordTriageStateWrite("CAT", { verified: true, expectedState: "Triage" }, deps({ nowMs: 1200 }));
    recordTriageStateWrite("CAT", { verified: true, expectedState: "Triage" }, deps({ nowMs: 1300 }));
    expect(events.map((e) => e.action)).toEqual(["missing", "recovered"]);
    expect(isTriageStateFaulted("CAT", deps())).toBe(false);
  });

  test("transient reasons do not latch", () => {
    recordTriageStateWrite("CAT", { reason: "exit-2", verified: false }, deps());
    expect(isTriageStateFaulted("CAT", deps())).toBe(false);
    expect(events).toHaveLength(0);
  });

  test("failed recovery append preserves the alert latch for retry", () => {
    recordTriageStateWrite("CAT", { reason: TRANSITION_STATE_ABSENT, expectedState: "Triage" }, deps());
    recordTriageStateWrite("CAT", { verified: true }, deps({ appendEvent: () => false }));
    expect(marker.alerting).toBe(true);
    recordTriageStateWrite("CAT", { verified: true }, deps());
    expect(events.at(-1).action).toBe("recovered");
  });

  test("hydrates a durable fault and malformed marker fails open", () => {
    marker = { faulted: true, alerting: true, expectedState: "Triage", consecutiveStructural: 1, lastProbeAt: 1000 };
    expect(isTriageStateFaulted("CAT", deps())).toBe(true);
    resetTriageStateHealth(); marker = "bad";
    expect(isTriageStateFaulted("CAT", deps())).toBe(false);
  });

  test("dependency throws are swallowed", () => {
    expect(() => recordTriageStateWrite("CAT", { reason: TRANSITION_STATE_ABSENT }, deps({ writeMarker: () => { throw new Error("disk"); } }))).not.toThrow();
  });
});

describe("probe scheduling", () => {
  test("unknown teams are unfaulted and probeable", () => {
    expect(isTriageStateFaulted("CAT", deps())).toBe(false);
    expect(shouldProbeTriageState("CAT", { nowMs: 1000, reprobeMs: 100 }, deps())).toBe(true);
  });

  test("latched team waits for the interval and marking restarts it", () => {
    recordTriageStateWrite("CAT", { reason: TRANSITION_STATE_ABSENT }, deps({ nowMs: 1000 }));
    expect(shouldProbeTriageState("CAT", { nowMs: 1050, reprobeMs: 100 }, deps())).toBe(false);
    expect(shouldProbeTriageState("CAT", { nowMs: 1100, reprobeMs: 100 }, deps())).toBe(true);
    markTriageStateProbe("CAT", deps({ nowMs: 1100 }));
    expect(shouldProbeTriageState("CAT", { nowMs: 1150, reprobeMs: 100 }, deps())).toBe(false);
  });
});
