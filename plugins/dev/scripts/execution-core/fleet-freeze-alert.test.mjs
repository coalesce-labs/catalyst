// Unit tests for the CTL-1420 fleet-frozen-for-admission alert.
// Run: cd plugins/dev/scripts/execution-core && bun test fleet-freeze-alert.test.mjs

import { describe, test, expect, beforeEach } from "bun:test";
import {
  buildFleetFreezeAlertEvent,
  checkFleetFreeze,
  isFleetFrozenRaised,
  __resetFleetFreezeLatch,
  ALERT_RAISED,
  ALERT_CLEARED,
  ALERT_KIND_FLEET_FROZEN_ADMISSION,
} from "./fleet-freeze-alert.mjs";

describe("buildFleetFreezeAlertEvent", () => {
  test("raised: catalyst.alert.raised envelope, WARN, fleet_frozen_admission label, execution-core resource", () => {
    const line = buildFleetFreezeAlertEvent({ action: "raised", teams: ["CTL", "ADV"], reason: "double outage" });
    expect(line.endsWith("\n")).toBe(true);
    const ev = JSON.parse(line);
    expect(ev.attributes["event.name"]).toBe(ALERT_RAISED);
    expect(ev.attributes["event.entity"]).toBe("alert");
    expect(ev.attributes["event.action"]).toBe("raised");
    expect(ev.attributes["event.label"]).toBe(ALERT_KIND_FLEET_FROZEN_ADMISSION);
    expect(ev.severityText).toBe("WARN");
    expect(ev.severityNumber).toBe(13);
    expect(ev.resource["service.name"]).toBe("catalyst.execution-core");
    expect(ev.body.payload).toMatchObject({
      kind: ALERT_KIND_FLEET_FROZEN_ADMISSION,
      reason: "double outage",
      count: 2,
      teams: ["CTL", "ADV"],
    });
  });

  test("cleared: catalyst.alert.cleared envelope, INFO", () => {
    const ev = JSON.parse(buildFleetFreezeAlertEvent({ action: "cleared", teams: ["CTL"] }));
    expect(ev.attributes["event.name"]).toBe(ALERT_CLEARED);
    expect(ev.attributes["event.action"]).toBe("cleared");
    expect(ev.severityText).toBe("INFO");
    expect(ev.severityNumber).toBe(9);
  });
});

describe("checkFleetFreeze", () => {
  beforeEach(() => __resetFleetFreezeLatch());

  test("ALL teams frozen → raises exactly once (latched), then stays silent while frozen", () => {
    const lines = [];
    const append = (l) => lines.push(JSON.parse(l));
    const opts = { teams: ["CTL", "ADV", "OTL"], isTeamFrozen: () => true, append };

    const r1 = checkFleetFreeze(opts);
    expect(r1).toEqual({ frozen: true, emitted: "raised" });
    expect(isFleetFrozenRaised()).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0].attributes["event.name"]).toBe(ALERT_RAISED);
    expect(lines[0].body.payload.teams).toEqual(["CTL", "ADV", "OTL"]);

    // Still frozen next pass → no duplicate emit.
    const r2 = checkFleetFreeze(opts);
    expect(r2).toEqual({ frozen: true, emitted: null });
    expect(lines).toHaveLength(1);
  });

  test("one team recovers → clears exactly once, then silent", () => {
    const lines = [];
    const append = (l) => lines.push(JSON.parse(l));
    checkFleetFreeze({ teams: ["CTL", "ADV"], isTeamFrozen: () => true, append }); // raise
    expect(lines).toHaveLength(1);

    // ADV recovers → not all frozen → cleared.
    const frozenSet = new Set(["CTL"]);
    const r = checkFleetFreeze({ teams: ["CTL", "ADV"], isTeamFrozen: (t) => frozenSet.has(t), append });
    expect(r).toEqual({ frozen: false, emitted: "cleared" });
    expect(lines).toHaveLength(2);
    expect(lines[1].attributes["event.name"]).toBe(ALERT_CLEARED);
    expect(isFleetFrozenRaised()).toBe(false);

    // Still not frozen → no duplicate clear.
    const r2 = checkFleetFreeze({ teams: ["CTL", "ADV"], isTeamFrozen: (t) => frozenSet.has(t), append });
    expect(r2.emitted).toBe(null);
    expect(lines).toHaveLength(2);
  });

  test("partial freeze (some teams healthy) never raises", () => {
    const lines = [];
    const frozenSet = new Set(["CTL"]); // ADV healthy
    const r = checkFleetFreeze({
      teams: ["CTL", "ADV"],
      isTeamFrozen: (t) => frozenSet.has(t),
      append: (l) => lines.push(l),
    });
    expect(r).toEqual({ frozen: false, emitted: null });
    expect(lines).toHaveLength(0);
  });

  test("empty registry never raises (no teams ⇒ not frozen)", () => {
    const lines = [];
    const r = checkFleetFreeze({ teams: [], isTeamFrozen: () => true, append: (l) => lines.push(l) });
    expect(r).toEqual({ frozen: false, emitted: null });
    expect(lines).toHaveLength(0);
  });

  test("a throwing append never propagates, and does NOT latch → the alert retries next tick", () => {
    const boom = () => {
      throw new Error("disk full");
    };
    expect(() =>
      checkFleetFreeze({ teams: ["CTL"], isTeamFrozen: () => true, append: boom })
    ).not.toThrow();
    // The append failed before the latch flipped, so the freeze is NOT yet
    // recorded as raised — the next successful pass emits it.
    expect(isFleetFrozenRaised()).toBe(false);
    const lines = [];
    const r = checkFleetFreeze({ teams: ["CTL"], isTeamFrozen: () => true, append: (l) => lines.push(l) });
    expect(r.emitted).toBe("raised");
    expect(lines).toHaveLength(1);
  });
});
