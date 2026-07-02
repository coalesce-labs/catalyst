// Unit tests for the CTL-1420 fleet-frozen-for-admission alert.
// Run: cd plugins/dev/scripts/execution-core && bun test fleet-freeze-alert.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFleetFreezeAlertEvent,
  checkFleetFreeze,
  isFleetFrozenRaised,
  __resetFleetFreezeLatch,
  ALERT_RAISED,
  ALERT_CLEARED,
  ALERT_KIND_FLEET_FROZEN_ADMISSION,
} from "./fleet-freeze-alert.mjs";

// The latch persists under getReconcileHealthDir() (CATALYST_DIR-scoped), so give
// each test an isolated CATALYST_DIR — no cross-test marker leakage, no writes to
// the real ~/catalyst tree.
let catalystDir;
let prevCatalystDir;
beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "fleet-freeze-"));
  process.env.CATALYST_DIR = catalystDir;
  __resetFleetFreezeLatch(); // clear in-memory latch + force re-hydrate from the fresh (empty) dir
});
afterEach(() => {
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

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

  test("empty registry from a CLOSED latch never raises (no teams to evaluate)", () => {
    const lines = [];
    const r = checkFleetFreeze({ teams: [], isTeamFrozen: () => true, append: (l) => lines.push(l) });
    expect(r).toEqual({ frozen: false, emitted: null });
    expect(lines).toHaveLength(0);
  });

  // CTL-1420 review finding: a transient empty listProjects() (registry.json
  // momentarily unreadable/malformed — listProjects returns [] instead of
  // throwing) must NOT flap a genuinely-raised latch to `cleared`. An empty team
  // set is a NO-TRANSITION, not evidence of recovery.
  test("empty team list is a NO-TRANSITION: a RAISED latch survives an empty read (no spurious clear, then re-raise)", () => {
    const lines = [];
    const append = (l) => lines.push(JSON.parse(l));
    checkFleetFreeze({ teams: ["CTL", "ADV"], isTeamFrozen: () => true, append }); // raise
    expect(lines).toHaveLength(1);
    expect(isFleetFrozenRaised()).toBe(true);

    // Registry momentarily unreadable → teams=[] → must NOT emit `cleared`.
    const r = checkFleetFreeze({ teams: [], isTeamFrozen: () => true, append });
    expect(r).toEqual({ frozen: true, emitted: null }); // latch preserved
    expect(lines).toHaveLength(1); // no spurious cleared
    expect(isFleetFrozenRaised()).toBe(true);

    // Registry restored, still frozen → still no duplicate raise.
    const r2 = checkFleetFreeze({ teams: ["CTL", "ADV"], isTeamFrozen: () => true, append });
    expect(r2.emitted).toBe(null);
    expect(lines).toHaveLength(1);
  });

  // CTL-1420 review finding: the latch is persisted + hydrated, so a daemon
  // restart mid-freeze does NOT re-emit `raised` with no intervening `cleared`.
  test("a daemon restart mid-freeze (in-memory reset, marker persists) does NOT re-emit raised", () => {
    const lines = [];
    const append = (l) => lines.push(JSON.parse(l));
    const teams = ["CTL", "ADV"];
    checkFleetFreeze({ teams, isTeamFrozen: () => true, append }); // raise + persist
    expect(lines).toHaveLength(1);

    // Simulate a RESTART: the in-memory latch + hydration flag reset, but the
    // persisted marker (in this test's CATALYST_DIR) survives.
    __resetFleetFreezeLatch();
    expect(isFleetFrozenRaised()).toBe(false); // in-memory cleared

    // First post-restart check, still frozen: hydrate reads the marker → already
    // raised → NO second `raised` emitted.
    const r = checkFleetFreeze({ teams, isTeamFrozen: () => true, append });
    expect(r).toEqual({ frozen: true, emitted: null });
    expect(lines).toHaveLength(1); // still exactly one raised, no duplicate
    expect(isFleetFrozenRaised()).toBe(true); // hydrated from disk

    // Recovery after restart still clears exactly once.
    const r2 = checkFleetFreeze({ teams, isTeamFrozen: () => false, append });
    expect(r2.emitted).toBe("cleared");
    expect(lines).toHaveLength(2);
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
