import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  recordTriageSweep,
  resetTriageSweepHealth,
} from "./triage-sweep-health.mjs";
import {
  buildTriageSweepHealthEvent,
  TRIAGE_HELD_ACTION,
  TRIAGE_RECOVERED_ACTION,
} from "./triage-sweep-health-event.mjs";

beforeEach(() => resetTriageSweepHealth());

function harness(initial = null, appendResult = true) {
  let marker = initial;
  const events = [];
  return {
    events,
    marker: () => marker,
    deps: {
      threshold: 3,
      readMarker: () => marker,
      writeMarker: (_team, state) => { marker = { ...state }; },
      appendEvent: (event) => { events.push(event); return appendResult; },
    },
  };
}

describe("CAT-82 triage sweep health", () => {
  test("below threshold persists the streak without emitting", () => {
    const h = harness();
    recordTriageSweep("CAT", { considered: 3, heldDelegateUnreadable: 3 }, h.deps);
    recordTriageSweep("CAT", { considered: 3, heldDelegateUnreadable: 3 }, h.deps);
    expect(h.events).toHaveLength(0);
    expect(h.marker()).toEqual({ consecutiveHeld: 2, alerting: false });
  });

  test("threshold raises exactly once while latched", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) recordTriageSweep("CAT", { considered: 3, heldDelegateUnreadable: 3 }, h.deps);
    expect(h.events.map((e) => e.action)).toEqual([TRIAGE_HELD_ACTION]);
    expect(h.marker()).toEqual({ consecutiveHeld: 5, alerting: true });
  });

  test("first healthy sweep recovers and later healthy sweeps stay quiet", () => {
    const h = harness({ consecutiveHeld: 3, alerting: true });
    recordTriageSweep("CAT", { considered: 3, heldDelegateUnreadable: 2 }, h.deps);
    recordTriageSweep("CAT", { considered: 3, heldDelegateUnreadable: 1 }, h.deps);
    expect(h.events.map((e) => e.action)).toEqual([TRIAGE_RECOVERED_ACTION]);
    expect(h.marker()).toEqual({ consecutiveHeld: 0, alerting: false });
  });

  // Review R1: a candidate-less sweep is absence of evidence, not recovery.
  test("zero candidates leaves both the streak and a raised latch untouched", () => {
    const h = harness({ consecutiveHeld: 3, alerting: true });
    recordTriageSweep("CAT", { considered: 0, heldDelegateUnreadable: 0 }, h.deps);
    expect(h.events).toHaveLength(0);
    expect(h.marker()).toEqual({ consecutiveHeld: 3, alerting: true });
    // and the latch still recovers on a real, candidate-bearing healthy sweep
    recordTriageSweep("CAT", { considered: 2, heldDelegateUnreadable: 0 }, h.deps);
    expect(h.events.map((e) => e.action)).toEqual([TRIAGE_RECOVERED_ACTION]);
    expect(h.marker()).toEqual({ consecutiveHeld: 0, alerting: false });
  });

  test("zero candidates does not restart an un-raised streak either", () => {
    const h = harness({ consecutiveHeld: 2, alerting: false });
    recordTriageSweep("CAT", { considered: 0, heldDelegateUnreadable: 0 }, h.deps);
    expect(h.marker()).toEqual({ consecutiveHeld: 2, alerting: false });
    recordTriageSweep("CAT", { considered: 1, heldDelegateUnreadable: 1 }, h.deps);
    expect(h.events.map((e) => e.action)).toEqual([TRIAGE_HELD_ACTION]);
  });

  test("failed event appends leave both raise and recovery latches retryable", () => {
    const raise = harness({ consecutiveHeld: 2, alerting: false }, false);
    recordTriageSweep("CAT", { considered: 1, heldDelegateUnreadable: 1 }, raise.deps);
    expect(raise.marker().alerting).toBe(false);
    recordTriageSweep("CAT", { considered: 1, heldDelegateUnreadable: 1 }, raise.deps);
    expect(raise.events).toHaveLength(2);

    resetTriageSweepHealth();
    const recover = harness({ consecutiveHeld: 3, alerting: true }, false);
    recordTriageSweep("CAT", { considered: 2, heldDelegateUnreadable: 0 }, recover.deps);
    expect(recover.marker().alerting).toBe(true);
    recordTriageSweep("CAT", { considered: 2, heldDelegateUnreadable: 0 }, recover.deps);
    expect(recover.events).toHaveLength(2);
  });

  test("durable markers resume a streak and teams remain independent", () => {
    const cat = harness({ consecutiveHeld: 2, alerting: false });
    const eng = harness();
    recordTriageSweep("CAT", { considered: 1, heldDelegateUnreadable: 1 }, cat.deps);
    recordTriageSweep("ENG", { considered: 1, heldDelegateUnreadable: 1 }, eng.deps);
    expect(cat.events).toHaveLength(1);
    expect(eng.events).toHaveLength(0);
    expect(eng.marker().consecutiveHeld).toBe(1);
  });

  test("event builder mirrors counts onto attributes", () => {
    const held = JSON.parse(buildTriageSweepHealthEvent({ team: "CAT", action: TRIAGE_HELD_ACTION, consecutiveHeld: 3, considered: 4, heldDelegateUnreadable: 4 }));
    expect(held.attributes["event.name"]).toBe("monitor.triage.held.CAT");
    expect(held.severityText).toBe("WARN");
    expect(held.attributes["triage.consecutive_held"]).toBe(3);
    expect(held.attributes["triage.considered"]).toBe(4);
    expect(held.attributes["triage.held_delegate_unreadable"]).toBe(4);
    const recovered = JSON.parse(buildTriageSweepHealthEvent({ team: "CAT", action: TRIAGE_RECOVERED_ACTION }));
    expect(recovered.severityText).toBe("INFO");
  });

  test("marker write failures never escape", () => {
    const warn = mock(() => {});
    expect(() => recordTriageSweep("CAT", { considered: 1, heldDelegateUnreadable: 1 }, {
      threshold: 3,
      readMarker: () => null,
      writeMarker: () => { throw new Error("disk full"); },
      appendEvent: mock(() => true),
    })).not.toThrow();
    expect(warn).toBeDefined();
  });
});
