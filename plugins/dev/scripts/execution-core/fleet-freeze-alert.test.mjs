// Unit tests for the CTL-1420 fleet-frozen-for-admission alert.
// Run: cd plugins/dev/scripts/execution-core && bun test fleet-freeze-alert.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getReconcileHealthDir } from "./config.mjs";
import {
  buildFleetFreezeAlertEvent,
  checkFleetFreeze,
  classifyFreezeCause,
  isFleetFrozenRaised,
  __resetFleetFreezeLatch,
  ALERT_RAISED,
  ALERT_CLEARED,
  ALERT_KIND_FLEET_FROZEN_ADMISSION,
  FLEET_FREEZE_CAUSE_ALL_POLL,
  FLEET_FREEZE_CAUSE_ALL_PERSIST,
  FLEET_FREEZE_CAUSE_MIXED,
} from "./fleet-freeze-alert.mjs";

// markerPath — mirrors the module-private helper so tests can write/inspect
// the on-disk marker directly (legacy-shape simulation, persist-failure
// simulation) without going through checkFleetFreeze.
function markerPath() {
  return join(getReconcileHealthDir(), "fleet-freeze.json");
}

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

  // CTL-1628 r3: `cause` must land in BOTH attributes and body.payload —
  // otel-forward's OTLP conversion never reads body.payload (the same gap the
  // CTL-1628 r1 fix closed for reconcile-health-event.mjs's `reason`), so a
  // cause confined to the body would be silently dropped for every
  // Loki/Grafana consumer, defeating the point of distinguishing outage causes.
  test("raised with a cause: mirrored into attributes.\"alert.cause\" and body.payload.cause", () => {
    const ev = JSON.parse(
      buildFleetFreezeAlertEvent({
        action: "raised",
        teams: ["CTL"],
        reason: "disk fault",
        cause: FLEET_FREEZE_CAUSE_ALL_PERSIST,
      }),
    );
    expect(ev.attributes["alert.cause"]).toBe(FLEET_FREEZE_CAUSE_ALL_PERSIST);
    expect(ev.body.payload.cause).toBe(FLEET_FREEZE_CAUSE_ALL_PERSIST);
  });

  test("no cause given: attributes omit \"alert.cause\" entirely (not even empty-string)", () => {
    const ev = JSON.parse(buildFleetFreezeAlertEvent({ action: "cleared", teams: ["CTL"] }));
    expect(ev.attributes["alert.cause"]).toBeUndefined();
    expect(ev.body.payload.cause).toBeNull();
  });

  // CTL-1628 r4: a cause-drift reclassification reuses the SAME "raised" event
  // name/topic (the fleet IS still frozen) but is marked distinctly so a
  // consumer can tell it apart from the initial raise.
  test("causeChanged:true sets attributes.\"alert.cause_changed\" and carries previousCause in the body", () => {
    const ev = JSON.parse(
      buildFleetFreezeAlertEvent({
        action: "raised",
        teams: ["CTL"],
        cause: FLEET_FREEZE_CAUSE_ALL_PERSIST,
        reason: "disk fault",
        causeChanged: true,
        previousCause: FLEET_FREEZE_CAUSE_ALL_POLL,
      }),
    );
    expect(ev.attributes["event.name"]).toBe(ALERT_RAISED); // same topic as a fresh raise
    expect(ev.attributes["alert.cause_changed"]).toBe(true);
    expect(ev.attributes["alert.cause"]).toBe(FLEET_FREEZE_CAUSE_ALL_PERSIST);
    // CTL-1628 r4 post-merge: previousCause must ALSO land in attributes —
    // otel-forward's OTLP conversion never reads body.payload, so a
    // previousCause confined to the body would be silently dropped for every
    // Loki/Grafana consumer, leaving a cause-drift alert with no record of
    // what it changed FROM (same gap the r1/r3 fixes closed for reason/cause).
    expect(ev.attributes["alert.previous_cause"]).toBe(FLEET_FREEZE_CAUSE_ALL_POLL);
    expect(ev.body.payload.causeChanged).toBe(true);
    expect(ev.body.payload.previousCause).toBe(FLEET_FREEZE_CAUSE_ALL_POLL);
  });

  test("causeChanged omitted (default false): no cause_changed/previous_cause attributes, payload carries false/null", () => {
    const ev = JSON.parse(
      buildFleetFreezeAlertEvent({ action: "raised", teams: ["CTL"], cause: FLEET_FREEZE_CAUSE_ALL_POLL }),
    );
    expect(ev.attributes["alert.cause_changed"]).toBeUndefined();
    expect(ev.attributes["alert.previous_cause"]).toBeUndefined();
    expect(ev.body.payload.causeChanged).toBe(false);
    expect(ev.body.payload.previousCause).toBeNull();
  });
});

describe("classifyFreezeCause", () => {
  test("every team poll-origin → all-poll-failing (the documented replica+linearis double outage)", () => {
    expect(classifyFreezeCause(["poll", "poll", "poll"])).toBe(FLEET_FREEZE_CAUSE_ALL_POLL);
  });

  test("every team persist-origin → all-persist-failing (a local filesystem fault)", () => {
    expect(classifyFreezeCause(["persist", "persist"])).toBe(FLEET_FREEZE_CAUSE_ALL_PERSIST);
  });

  test("a mix of poll and persist origins across teams → mixed", () => {
    expect(classifyFreezeCause(["poll", "persist"])).toBe(FLEET_FREEZE_CAUSE_MIXED);
    expect(classifyFreezeCause(["persist", "poll", "persist"])).toBe(FLEET_FREEZE_CAUSE_MIXED);
  });
});

describe("checkFleetFreeze", () => {
  beforeEach(() => __resetFleetFreezeLatch());

  test("ALL teams frozen → raises exactly once (latched), then stays silent while frozen", () => {
    const lines = [];
    const append = (l) => lines.push(JSON.parse(l));
    const opts = { teams: ["CTL", "ADV", "OTL"], isTeamFrozen: () => true, append };

    const r1 = checkFleetFreeze(opts);
    // CTL-1628 r3: no getTeamOrigin passed → defaults to "poll" for every
    // team → cause classifies as the documented all-poll double-outage story.
    expect(r1).toEqual({ frozen: true, emitted: "raised", cause: FLEET_FREEZE_CAUSE_ALL_POLL });
    expect(isFleetFrozenRaised()).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0].attributes["event.name"]).toBe(ALERT_RAISED);
    expect(lines[0].body.payload.teams).toEqual(["CTL", "ADV", "OTL"]);

    // Still frozen next pass → no duplicate emit.
    const r2 = checkFleetFreeze(opts);
    expect(r2).toEqual({ frozen: true, emitted: null, cause: null });
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
    expect(r).toEqual({ frozen: false, emitted: "cleared", cause: null });
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
    expect(r).toEqual({ frozen: false, emitted: null, cause: null });
    expect(lines).toHaveLength(0);
  });

  test("empty registry from a CLOSED latch never raises (no teams to evaluate)", () => {
    const lines = [];
    const r = checkFleetFreeze({ teams: [], isTeamFrozen: () => true, append: (l) => lines.push(l) });
    expect(r).toEqual({ frozen: false, emitted: null, cause: null });
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
    expect(r).toEqual({ frozen: true, emitted: null, cause: null }); // latch preserved
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
    expect(r).toEqual({ frozen: true, emitted: null, cause: null });
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

  // CTL-1628 r3 (Codex #2960 round 3): before this fix, checkFleetFreeze had
  // no way to distinguish WHY every team was frozen — the raised event always
  // used the same "replica or linearis" reason, even when the true cause was
  // a local eligible-set disk fault affecting every team. getTeamOrigin lets
  // the caller (monitor.mjs's reconcileAll) thread each team's actual origin.
  test("getTeamOrigin all \"poll\" → cause all-poll-failing, reason names replica/linearis", () => {
    const lines = [];
    const append = (l) => lines.push(JSON.parse(l));
    const r = checkFleetFreeze({
      teams: ["CTL", "ADV"],
      isTeamFrozen: () => true,
      getTeamOrigin: () => "poll",
      append,
    });
    expect(r.cause).toBe(FLEET_FREEZE_CAUSE_ALL_POLL);
    expect(lines[0].body.payload.cause).toBe(FLEET_FREEZE_CAUSE_ALL_POLL);
    expect(lines[0].body.payload.reason).toMatch(/replica or linearis/);
    expect(lines[0].attributes["alert.cause"]).toBe(FLEET_FREEZE_CAUSE_ALL_POLL);
  });

  test("getTeamOrigin all \"persist\" → cause all-persist-failing, reason names a local filesystem fault, not replica/linearis", () => {
    const lines = [];
    const append = (l) => lines.push(JSON.parse(l));
    const r = checkFleetFreeze({
      teams: ["CTL", "ADV"],
      isTeamFrozen: () => true,
      getTeamOrigin: () => "persist",
      append,
    });
    expect(r.cause).toBe(FLEET_FREEZE_CAUSE_ALL_PERSIST);
    expect(lines[0].body.payload.cause).toBe(FLEET_FREEZE_CAUSE_ALL_PERSIST);
    expect(lines[0].body.payload.reason).toMatch(/local filesystem fault/);
    expect(lines[0].body.payload.reason).not.toMatch(/replica or linearis/);
    expect(lines[0].attributes["alert.cause"]).toBe(FLEET_FREEZE_CAUSE_ALL_PERSIST);
  });

  test("getTeamOrigin mixed across teams → cause mixed", () => {
    const lines = [];
    const append = (l) => lines.push(JSON.parse(l));
    const originByTeam = { CTL: "poll", ADV: "persist" };
    const r = checkFleetFreeze({
      teams: ["CTL", "ADV"],
      isTeamFrozen: () => true,
      getTeamOrigin: (t) => originByTeam[t],
      append,
    });
    expect(r.cause).toBe(FLEET_FREEZE_CAUSE_MIXED);
    expect(lines[0].body.payload.cause).toBe(FLEET_FREEZE_CAUSE_MIXED);
  });

  test("no getTeamOrigin provided → defaults every team to \"poll\" (pre-r3 behavior preserved)", () => {
    const lines = [];
    const append = (l) => lines.push(JSON.parse(l));
    const r = checkFleetFreeze({ teams: ["CTL"], isTeamFrozen: () => true, append });
    expect(r.cause).toBe(FLEET_FREEZE_CAUSE_ALL_POLL);
  });

  test("cleared transitions never carry a cause (cause is a raised-only classification)", () => {
    const lines = [];
    const append = (l) => lines.push(JSON.parse(l));
    checkFleetFreeze({ teams: ["CTL"], isTeamFrozen: () => true, getTeamOrigin: () => "persist", append });
    const r = checkFleetFreeze({ teams: ["CTL"], isTeamFrozen: () => false, append });
    expect(r.emitted).toBe("cleared");
    expect(r.cause).toBeNull();
    expect(lines[1].body.payload.cause).toBeNull();
    expect(lines[1].attributes["alert.cause"]).toBeUndefined();
  });

  // CTL-1628 r4 (Codex #2960 round 4): before this fix, cause classification
  // only ran on the initial raise — the one standing alert would keep
  // reporting the ORIGINAL cause for the freeze's entire duration even if the
  // origins driving it changed underneath it.
  describe("cause reclassification on origin drift (CTL-1628 r4)", () => {
    test("origins drift all-poll → all-persist mid-freeze: exactly one cause_changed emission with the persist reason", () => {
      const lines = [];
      const append = (l) => lines.push(JSON.parse(l));
      let origin = "poll";
      const opts = {
        teams: ["CTL", "ADV"],
        isTeamFrozen: () => true,
        getTeamOrigin: () => origin,
        append,
      };

      const raise = checkFleetFreeze(opts);
      expect(raise).toEqual({ frozen: true, emitted: "raised", cause: FLEET_FREEZE_CAUSE_ALL_POLL });
      expect(lines).toHaveLength(1);

      // Still frozen, no drift yet → silent, exactly like a steady-state check.
      const steady = checkFleetFreeze(opts);
      expect(steady).toEqual({ frozen: true, emitted: null, cause: null });
      expect(lines).toHaveLength(1);

      // Origins drift: the poll/linearis outage recovered, but now every
      // team's local disk persist is failing instead.
      origin = "persist";
      const drift = checkFleetFreeze(opts);
      expect(drift).toEqual({ frozen: true, emitted: "cause_changed", cause: FLEET_FREEZE_CAUSE_ALL_PERSIST });
      expect(lines).toHaveLength(2);
      expect(lines[1].attributes["event.name"]).toBe(ALERT_RAISED); // same topic, not a new alert kind
      expect(lines[1].attributes["alert.cause_changed"]).toBe(true);
      expect(lines[1].attributes["alert.cause"]).toBe(FLEET_FREEZE_CAUSE_ALL_PERSIST);
      // CTL-1628 r4 post-merge: previousCause must survive otel-forward's OTLP
      // conversion (attributes-only), not just live in the body.
      expect(lines[1].attributes["alert.previous_cause"]).toBe(FLEET_FREEZE_CAUSE_ALL_POLL);
      expect(lines[1].body.payload.previousCause).toBe(FLEET_FREEZE_CAUSE_ALL_POLL);
      expect(lines[1].body.payload.reason).toMatch(/local filesystem fault/);

      // No further drift → no duplicate cause_changed emission.
      const steady2 = checkFleetFreeze(opts);
      expect(steady2).toEqual({ frozen: true, emitted: null, cause: null });
      expect(lines).toHaveLength(2);
    });

    test("origins drift into mixed, then back out: two cause_changed emissions total, none while unchanged", () => {
      const lines = [];
      const append = (l) => lines.push(JSON.parse(l));
      const originByTeam = { CTL: "poll", ADV: "poll" };
      const opts = {
        teams: ["CTL", "ADV"],
        isTeamFrozen: () => true,
        getTeamOrigin: (t) => originByTeam[t],
        append,
      };

      checkFleetFreeze(opts); // raise: all-poll
      expect(lines).toHaveLength(1);
      expect(lines[0].body.payload.cause).toBe(FLEET_FREEZE_CAUSE_ALL_POLL);

      // One team's origin flips to persist → mixed.
      originByTeam.ADV = "persist";
      const r1 = checkFleetFreeze(opts);
      expect(r1.emitted).toBe("cause_changed");
      expect(r1.cause).toBe(FLEET_FREEZE_CAUSE_MIXED);
      expect(lines).toHaveLength(2);

      // Repeating the same mixed state does NOT re-emit (avoid spamming).
      checkFleetFreeze(opts);
      checkFleetFreeze(opts);
      expect(lines).toHaveLength(2);

      // Both teams now persist → all-persist (still a drift from mixed).
      originByTeam.CTL = "persist";
      const r2 = checkFleetFreeze(opts);
      expect(r2.emitted).toBe("cause_changed");
      expect(r2.cause).toBe(FLEET_FREEZE_CAUSE_ALL_PERSIST);
      expect(lines).toHaveLength(3);
      expect(lines[2].body.payload.previousCause).toBe(FLEET_FREEZE_CAUSE_MIXED);
    });

    test("a daemon restart mid-freeze rehydrates the last-emitted cause, so drift detection survives the restart", () => {
      const lines = [];
      const append = (l) => lines.push(JSON.parse(l));
      let origin = "poll";
      const opts = { teams: ["CTL"], isTeamFrozen: () => true, getTeamOrigin: () => origin, append };

      checkFleetFreeze(opts); // raise: all-poll, persisted to the marker
      expect(lines).toHaveLength(1);

      // Simulate a RESTART: in-memory state cleared, disk marker survives.
      __resetFleetFreezeLatch();
      expect(isFleetFrozenRaised()).toBe(false);

      // First post-restart check, no drift yet: hydrate restores BOTH the
      // raised latch and the last-emitted cause → still silent.
      const r1 = checkFleetFreeze(opts);
      expect(r1).toEqual({ frozen: true, emitted: null, cause: null });
      expect(lines).toHaveLength(1);

      // NOW origins drift post-restart — the rehydrated cause is what drift
      // is measured against, so this still correctly detects the change.
      origin = "persist";
      const r2 = checkFleetFreeze(opts);
      expect(r2.emitted).toBe("cause_changed");
      expect(r2.cause).toBe(FLEET_FREEZE_CAUSE_ALL_PERSIST);
      expect(lines).toHaveLength(2);
    });
  });

  // CTL-1628 r4 post-merge (Codex #2960 post-merge finding 2): a marker
  // written before the r3 cause field existed has raised:true with no
  // `cause` at all — hydrating that as null would make the FIRST post-
  // upgrade tick misreport a real cause as "changed" even though nothing
  // about the freeze itself moved; it's just that the field is new.
  describe("legacy marker hydration (no cause field) defaults to all-poll (CTL-1628 r4 post-merge)", () => {
    test("a still-raised legacy marker ({raised:true}, no cause) + unchanged all-poll origins emits nothing on the first post-upgrade tick", () => {
      mkdirSync(getReconcileHealthDir(), { recursive: true });
      writeFileSync(markerPath(), JSON.stringify({ raised: true }));

      const lines = [];
      const append = (l) => lines.push(JSON.parse(l));
      const r = checkFleetFreeze({
        teams: ["CTL"],
        isTeamFrozen: () => true,
        getTeamOrigin: () => "poll",
        append,
      });
      expect(r).toEqual({ frozen: true, emitted: null, cause: null });
      expect(lines).toHaveLength(0);
    });

    test("a still-raised legacy marker + a REAL drift to all-persist still emits exactly one cause_changed", () => {
      mkdirSync(getReconcileHealthDir(), { recursive: true });
      writeFileSync(markerPath(), JSON.stringify({ raised: true }));

      const lines = [];
      const append = (l) => lines.push(JSON.parse(l));
      const r = checkFleetFreeze({
        teams: ["CTL"],
        isTeamFrozen: () => true,
        getTeamOrigin: () => "persist",
        append,
      });
      expect(r.emitted).toBe("cause_changed");
      expect(r.cause).toBe(FLEET_FREEZE_CAUSE_ALL_PERSIST);
      expect(lines).toHaveLength(1);
      expect(lines[0].body.payload.previousCause).toBe(FLEET_FREEZE_CAUSE_ALL_POLL);
    });

    test("a legacy marker that is NOT raised ({raised:false}) hydrates cause as null, not all-poll", () => {
      mkdirSync(getReconcileHealthDir(), { recursive: true });
      writeFileSync(markerPath(), JSON.stringify({ raised: false }));

      const lines = [];
      const append = (l) => lines.push(JSON.parse(l));
      // Not frozen → no transition, no emission either way; this just
      // confirms hydrate() doesn't fabricate a cause for a closed latch.
      const r = checkFleetFreeze({ teams: ["CTL"], isTeamFrozen: () => false, append });
      expect(r).toEqual({ frozen: false, emitted: null, cause: null });
      expect(lines).toHaveLength(0);
    });
  });

  // CTL-1628 r4 post-merge (Codex #2960 post-merge finding 3): persist()
  // previously swallowed a transient marker-write failure with no retry —
  // _lastEmittedCause (and _fleetFrozenRaised) had already advanced in
  // memory, so the stale on-disk marker would sit there forever unless
  // ANOTHER transition happened to trigger a fresh persist() call.
  describe("persist retry after a transient marker-write failure (CTL-1628 r4 post-merge)", () => {
    // Block the marker path so writeFileSync/renameSync inside persist()
    // throws (same disk-fault simulation used in monitor.test.mjs). Removes
    // any existing marker FILE first — a prior successful persist() may have
    // already created one, and mkdirSync would EEXIST on top of a file.
    function blockMarkerPath() {
      rmSync(markerPath(), { recursive: true, force: true });
      mkdirSync(markerPath(), { recursive: true });
      writeFileSync(join(markerPath(), "sentinel"), "x");
    }
    function unblockMarkerPath() {
      rmSync(markerPath(), { recursive: true, force: true });
    }

    test("a transient persist failure on the raise does NOT re-emit on retry — only the marker catches up", () => {
      blockMarkerPath();
      const lines = [];
      const append = (l) => lines.push(JSON.parse(l));
      const opts = { teams: ["CTL"], isTeamFrozen: () => true, getTeamOrigin: () => "poll", append };

      // The raise event still fires (append happens before persist), but the
      // marker write fails — event count is 1 despite the persist fault.
      const r1 = checkFleetFreeze(opts);
      expect(r1.emitted).toBe("raised");
      expect(lines).toHaveLength(1);

      // Still blocked: a further check must NOT re-emit "raised" again (the
      // in-memory latch already advanced) and must not spuriously detect a
      // cause drift either (origins are unchanged).
      const r2 = checkFleetFreeze(opts);
      expect(r2).toEqual({ frozen: true, emitted: null, cause: null });
      expect(lines).toHaveLength(1);

      // Unblock: the NEXT check retries the persist (no new transition, so
      // still no event emitted) and the marker catches up.
      unblockMarkerPath();
      const r3 = checkFleetFreeze(opts);
      expect(r3).toEqual({ frozen: true, emitted: null, cause: null });
      expect(lines).toHaveLength(1); // still exactly one — the retry emitted nothing

      // Prove the marker actually caught up: a simulated restart now
      // rehydrates the correct raised+cause state from disk.
      __resetFleetFreezeLatch();
      const r4 = checkFleetFreeze(opts); // no drift → silent, proving hydrate saw raised:true + cause:all-poll
      expect(r4).toEqual({ frozen: true, emitted: null, cause: null });
      expect(lines).toHaveLength(1);
    });

    test("a transient persist failure on a cause_changed drift retries without duplicating the alert", () => {
      let origin = "poll";
      const lines = [];
      const append = (l) => lines.push(JSON.parse(l));
      const opts = { teams: ["CTL"], isTeamFrozen: () => true, getTeamOrigin: () => origin, append };

      checkFleetFreeze(opts); // raise: all-poll (persist succeeds, unblocked)
      expect(lines).toHaveLength(1);

      // Drift to persist, but block the marker write for this transition.
      origin = "persist";
      blockMarkerPath();
      const r1 = checkFleetFreeze(opts);
      expect(r1.emitted).toBe("cause_changed");
      expect(lines).toHaveLength(2); // the drift event still fires

      // Still blocked, no further drift: no duplicate cause_changed.
      const r2 = checkFleetFreeze(opts);
      expect(r2).toEqual({ frozen: true, emitted: null, cause: null });
      expect(lines).toHaveLength(2);

      // Unblock: the retry succeeds silently (no third emission).
      unblockMarkerPath();
      const r3 = checkFleetFreeze(opts);
      expect(r3).toEqual({ frozen: true, emitted: null, cause: null });
      expect(lines).toHaveLength(2);
    });

    // CTL-1628 post-merge (Codex #2968 follow-up): persist() previously used
    // a randomBytes-suffixed tmp filename, so writeFileSync succeeding but
    // renameSync failing left a NEW orphaned .tmp file on EVERY failed
    // attempt — and the r4-post-merge retry loop calls persist() again on
    // every subsequent tick while the fault persists, so tmp files
    // accumulated without bound for as long as the underlying disk fault
    // lasted. persist() now uses a deterministic tmp name (`${markerPath()}.tmp`,
    // matching every other atomic-write helper in this directory), so a
    // repeated failure overwrites the SAME tmp file in place.
    test("repeated failed persists leave at most one .tmp file, not one per attempt", () => {
      blockMarkerPath();
      const lines = [];
      const append = (l) => lines.push(JSON.parse(l));
      const opts = { teams: ["CTL"], isTeamFrozen: () => true, getTeamOrigin: () => "poll", append };

      checkFleetFreeze(opts); // raise → persist fails, tmp written
      checkFleetFreeze(opts); // retry #1 → persist fails again
      checkFleetFreeze(opts); // retry #2 → persist fails again

      const tmpFiles = readdirSync(getReconcileHealthDir()).filter(
        (f) => f.includes("fleet-freeze") && f.endsWith(".tmp"),
      );
      expect(tmpFiles).toHaveLength(1);
      expect(tmpFiles[0]).toBe("fleet-freeze.json.tmp");
    });
  });
});
