// Unit tests for the execution-core monitor core (CTL-535 Phase 4, CTL-582).
// Run: cd plugins/dev/scripts/execution-core && bun test monitor.test.mjs
//
// CTL-582: the monitor discovers projects from the central registry.json
// (registry.mjs) and keys the eligible projection on Linear team — the
// per-repo enrollment records are gone.

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { ownerForTicket } from "./hrw.mjs"; // CTL-862: HRW owner computation for ownership-filter tests
import { __resetLivenessState } from "./liveness-roster.mjs"; // CTL-1091: test isolation
import { readClusterGeneration } from "./scheduler.mjs"; // CTL-1028: persistence assertion
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStateChangedEvent,
  parseIssueUpdatedEvent,
  parseCommentCreatedEvent,
  reconcileProject,
  reconcileAll,
  handleStateChangedEvent,
  handleIssueUpdatedEvent,
  handleCommentCreatedEvent,
  sweepMissingTriage,
  startMonitor,
  stopMonitor,
  seedTailerFromCursor,
  readNewEvents,
  __tailerOffset,
  __resetForTests,
} from "./monitor.mjs";
import { setProjectEligible, getEligibleSet, dropProject } from "./eligible-set.mjs";
import { loadCursor, saveCursor } from "./event-cursor.mjs";
import { createTicketStateCache } from "./linear-cache.mjs";
import { fetchTicketState } from "./linear-query.mjs";
import {
  getReconcileHealth,
  readReconcileHealthMarkers,
  recordReconcileFailure,
  __resetReconcileHealthForTests,
} from "./reconcile-health.mjs";

let catalystDir;
let prevCatalystDir;
const enrolledTeams = new Set();
const registryEntries = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-mon-"));
  process.env.CATALYST_DIR = catalystDir;
  mkdirSync(join(catalystDir, "execution-core"), { recursive: true });
  __resetForTests();
  enrolledTeams.clear();
  registryEntries.length = 0;
  // CTL-1091: reset liveness singleton so hysteresis state does not bleed
  // across tests (the module is shared when bun runs files in one process).
  __resetLivenessState();
});

afterEach(() => {
  stopMonitor();
  __resetForTests();
  for (const t of enrolledTeams) dropProject(t);
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

// writeRegistry — persist the current registryEntries to registry.json (the
// file the monitor reads via registry.mjs).
function writeRegistry() {
  writeFileSync(
    join(catalystDir, "execution-core", "registry.json"),
    JSON.stringify({ projects: registryEntries }, null, 2)
  );
}

// enroll — register a team in the central registry. `eligibleQuery` is the
// inner query object ({status, ...}); `team` is the top-level registry key.
// Returns a stub repoRoot the registry entry points at.
function enroll(team, eligibleQuery) {
  const repoRoot = mkdtempSync(join(catalystDir, `repo-${team}-`));
  registryEntries.push({ team, repoRoot, eligibleQuery: eligibleQuery ?? null });
  writeRegistry();
  enrolledTeams.add(team);
  return repoRoot;
}

// writeTriageArtifact — mark a ticket as already-triaged (CTL-625). orchDir is
// a real tmpdir; the monitor checks workers/<ticket>/triage.json.
function writeTriageArtifact(orchDir, ticket) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "triage.json"), JSON.stringify({ ticket }));
}

// unenroll — drop a team from the registry (an operator registry edit).
function unenroll(team) {
  const i = registryEntries.findIndex((e) => e.team === team);
  if (i >= 0) registryEntries.splice(i, 1);
  writeRegistry();
}

// A fake exec keyed on the linearis `--team` argv flag. Tracks call count.
function execReturning(nodesByTeam) {
  const fn = (_cmd, args) => {
    fn.calls += 1;
    const team = args[args.indexOf("--team") + 1];
    return {
      code: 0,
      stdout: JSON.stringify({ nodes: nodesByTeam[team] ?? [] }),
      stderr: "",
    };
  };
  fn.calls = 0;
  return fn;
}

const node = (identifier, priority = 2) => ({
  identifier,
  state: { name: "Todo" },
  priority,
});

describe("parseStateChangedEvent", () => {
  test("reads attributes['event.name'] + body.payload (canonical OTel shape)", () => {
    const parsed = parseStateChangedEvent({
      attributes: {
        "event.name": "linear.issue.state_changed",
        "linear.issue.identifier": "ENG-1",
      },
      body: { payload: { teamKey: "ENG", toState: "In Progress" } },
    });
    expect(parsed).toEqual({
      identifier: "ENG-1",
      teamKey: "ENG",
      toState: "In Progress",
      toLabels: null,
      toProject: null,
      toPriority: null,
    });
  });

  test("reads event.event + event.detail (legacy flat shape)", () => {
    const parsed = parseStateChangedEvent({
      event: "linear.issue.state_changed",
      detail: { ticket: "ENG-2", teamKey: "ENG", toState: "Done" },
    });
    expect(parsed).toEqual({
      identifier: "ENG-2",
      teamKey: "ENG",
      toState: "Done",
      toLabels: null,
      toProject: null,
      toPriority: null,
    });
  });

  test("returns null for a non-state_changed event", () => {
    expect(parseStateChangedEvent({ event: "pr.merged" })).toBeNull();
    expect(parseStateChangedEvent({})).toBeNull();
  });

  test("returns null when no ticket identifier can be extracted", () => {
    expect(
      parseStateChangedEvent({
        attributes: { "event.name": "linear.issue.state_changed" },
        body: { payload: { teamKey: "ENG", toState: "Todo" } },
      })
    ).toBeNull();
  });
});

describe("reconcileProject", () => {
  test("runs the query and writes the eligible set", () => {
    enroll("ENG", { status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1"), node("ENG-2")] });
    reconcileProject("ENG", { exec });
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-1", "ENG-2"]);
  });

  test("preserves the prior eligible set when runEligibleQuery throws", () => {
    enroll("ENG", { status: "Todo" });
    setProjectEligible("ENG", [node("ENG-PRIOR")], { source: "reconcile", query: {} });
    const throwingExec = () => ({ code: 1, stdout: "", stderr: "linearis down" });
    reconcileProject("ENG", { exec: throwingExec });
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-PRIOR"]);
  });

  test("skips (no crash) a team with no registry entry", () => {
    const exec = execReturning({});
    expect(() => reconcileProject("NOSUCH", { exec })).not.toThrow();
    expect(exec.calls).toBe(0);
  });

  test("does not crash the daemon when the projection write fails", () => {
    enroll("ENG", { status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1")] });
    // Make the projection path a non-empty directory so renameSync fails,
    // simulating a disk/permission fault during the projection write. The
    // throw must be swallowed: reconcileProject runs inside the setInterval
    // reconcile timer, so an uncaught error would kill the monitor process.
    const projDir = join(catalystDir, "execution-core", "eligible", "ENG.json");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "sentinel"), "x");
    expect(() => reconcileProject("ENG", { exec })).not.toThrow();
    rmSync(projDir, { recursive: true, force: true });
  });
});

// --- CTL-867: per-team reconcile-health escalation --------------------------
//
// A team whose eligibleQuery errors every poll (e.g. its status references a
// removed Linear state) freezes its eligible projection stale for hours while
// the daemon looks healthy — invisible starvation. reconcileProject now records
// per-team reconcile health and, after N consecutive failures, escalates a
// canonical monitor.reconcile.failing.<TEAM> event onto the unified event log;
// a recovering poll clears the alert.

describe("reconcileProject — CTL-867 reconcile-health escalation", () => {
  const throwingExec = () => ({ code: 1, stdout: "", stderr: "removed-state: Ready" });

  test("a reconcile that throws N consecutive times emits the failing alert exactly once", () => {
    enroll("ENG", { status: "Ready" });
    const events = [];
    const appendHealthEvent = (e) => events.push(e);

    // First two failures: under the default threshold (3) → no alert yet.
    reconcileProject("ENG", { exec: throwingExec, appendHealthEvent });
    reconcileProject("ENG", { exec: throwingExec, appendHealthEvent });
    expect(events).toHaveLength(0);
    expect(getReconcileHealth("ENG").consecutiveFailures).toBe(2);
    expect(getReconcileHealth("ENG").alerting).toBe(false);

    // Third consecutive failure crosses the threshold → exactly one alert.
    reconcileProject("ENG", { exec: throwingExec, appendHealthEvent });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ team: "ENG", action: "failing", consecutiveFailures: 3 });
    expect(getReconcileHealth("ENG").alerting).toBe(true);

    // Further failures do NOT re-fire the alert (latched until recovery).
    reconcileProject("ENG", { exec: throwingExec, appendHealthEvent });
    reconcileProject("ENG", { exec: throwingExec, appendHealthEvent });
    expect(events).toHaveLength(1);
    expect(getReconcileHealth("ENG").consecutiveFailures).toBe(5);
  });

  test("a recovering query clears the alert and resets the counter (emits a recovery event)", () => {
    enroll("ENG", { status: "Ready" });
    const events = [];
    const appendHealthEvent = (e) => events.push(e);

    // Drive past the threshold so the team is alerting.
    for (let i = 0; i < 3; i++) reconcileProject("ENG", { exec: throwingExec, appendHealthEvent });
    expect(getReconcileHealth("ENG").alerting).toBe(true);
    expect(events).toHaveLength(1);

    // A successful poll: counter resets, alert clears, recovery event fires.
    const goodExec = execReturning({ ENG: [node("ENG-1")] });
    reconcileProject("ENG", { exec: goodExec, appendHealthEvent });
    const health = getReconcileHealth("ENG");
    expect(health.consecutiveFailures).toBe(0);
    expect(health.alerting).toBe(false);
    expect(health.lastSuccessTs).toBeTruthy();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ team: "ENG", action: "recovered" });
    // The successful poll also rebuilt the eligible set (no longer frozen stale).
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-1"]);
  });

  test("a single transient failure under the threshold never alerts; recovery emits nothing", () => {
    enroll("ENG", { status: "Ready" });
    const events = [];
    const appendHealthEvent = (e) => events.push(e);

    reconcileProject("ENG", { exec: throwingExec, appendHealthEvent }); // 1 failure
    const goodExec = execReturning({ ENG: [node("ENG-1")] });
    reconcileProject("ENG", { exec: goodExec, appendHealthEvent }); // recovers before alert

    // No alert was ever raised, so the recovery must NOT emit a spurious clear.
    expect(events).toHaveLength(0);
    expect(getReconcileHealth("ENG").consecutiveFailures).toBe(0);
    expect(getReconcileHealth("ENG").alerting).toBe(false);
  });

  test("a new streak after a recovery re-alerts (alert is per-streak, not once-ever)", () => {
    enroll("ENG", { status: "Ready" });
    const events = [];
    const appendHealthEvent = (e) => events.push(e);

    for (let i = 0; i < 3; i++) reconcileProject("ENG", { exec: throwingExec, appendHealthEvent });
    reconcileProject("ENG", { exec: execReturning({ ENG: [node("ENG-1")] }), appendHealthEvent });
    // failing(1) + recovered(1) so far.
    expect(events.filter((e) => e.action === "failing")).toHaveLength(1);

    for (let i = 0; i < 3; i++) reconcileProject("ENG", { exec: throwingExec, appendHealthEvent });
    expect(events.filter((e) => e.action === "failing")).toHaveLength(2);
  });

  test("each call persists a per-team health marker the orch-monitor server reads", () => {
    enroll("ENG", { status: "Ready" });
    const appendHealthEvent = () => {};
    reconcileProject("ENG", { exec: execReturning({ ENG: [node("ENG-1")] }), appendHealthEvent });

    const markers = readReconcileHealthMarkers();
    expect(markers.ENG).toBeDefined();
    expect(markers.ENG.lastSuccessTs).toBeTruthy();
    expect(markers.ENG.alerting).toBe(false);
    expect(markers.ENG.consecutiveFailures).toBe(0);

    // After persistent failures the marker reflects the alert + frozen lastSuccessTs.
    const priorTs = markers.ENG.lastSuccessTs;
    for (let i = 0; i < 3; i++) reconcileProject("ENG", { exec: throwingExec, appendHealthEvent });
    const failed = readReconcileHealthMarkers();
    expect(failed.ENG.alerting).toBe(true);
    expect(failed.ENG.consecutiveFailures).toBe(3);
    expect(failed.ENG.lastSuccessTs).toBe(priorTs); // unchanged — eligible set is frozen stale
  });

  // CTL-867 cross-restart fix: the in-memory health map is empty on every process
  // start. Without rehydration, the first post-restart failure for a team that has
  // been failing for hours would seed a FRESH entry and writeHealthMarker would
  // OVERWRITE the truthful disk marker — resetting consecutiveFailures to 1,
  // dropping the real lastSuccessTs to null, and clearing the alerting latch. That
  // is the exact starvation scenario CTL-867 targets, so it must survive a restart.
  test("a daemon restart rehydrates per-team health from the disk marker (preserves lastSuccessTs + alerting, increments the failure count)", () => {
    enroll("ENG", { status: "Ready" });
    const appendHealthEvent = () => {};
    const throwingExec = () => ({ code: 1, stdout: "", stderr: "removed-state: Ready" });

    // Establish a truthful marker: one success (stamps a real lastSuccessTs), then
    // drive past the threshold so the team is alerting with N consecutive failures.
    reconcileProject("ENG", { exec: execReturning({ ENG: [node("ENG-1")] }), appendHealthEvent });
    const staleSuccessTs = readReconcileHealthMarkers().ENG.lastSuccessTs;
    expect(staleSuccessTs).toBeTruthy();
    for (let i = 0; i < 3; i++) reconcileProject("ENG", { exec: throwingExec, appendHealthEvent });

    const beforeRestart = readReconcileHealthMarkers().ENG;
    expect(beforeRestart.alerting).toBe(true);
    expect(beforeRestart.consecutiveFailures).toBe(3);
    expect(beforeRestart.lastSuccessTs).toBe(staleSuccessTs);

    // Simulate a daemon RESTART: the in-memory map is cleared, but the disk marker
    // (the durable starvation truth) persists in the per-test reconcile-health dir.
    __resetReconcileHealthForTests();
    expect(getReconcileHealth("ENG")).toBeNull(); // confirm the in-memory map is empty

    // ONE more failure after the restart. The seed must come from the disk marker,
    // not fresh defaults — so the count increments to N+1, lastSuccessTs is the
    // preserved stale timestamp (NOT null), and the alerting latch stays set.
    recordReconcileFailure("ENG", "removed-state: Ready");

    const afterRestart = readReconcileHealthMarkers().ENG;
    expect(afterRestart.consecutiveFailures).toBe(4); // N+1, not reset to 1
    expect(afterRestart.lastSuccessTs).toBe(staleSuccessTs); // preserved, not nulled
    expect(afterRestart.alerting).toBe(true); // latch survives the restart

    // The in-memory entry now mirrors the rehydrated-then-incremented state.
    const inMem = getReconcileHealth("ENG");
    expect(inMem.consecutiveFailures).toBe(4);
    expect(inMem.lastSuccessTs).toBe(staleSuccessTs);
    expect(inMem.alerting).toBe(true);
  });
});

describe("handleStateChangedEvent", () => {
  // CTL-584: the pre-CTL-565 "toState != eligible status → fast-path-remove"
  // case is now covered by the parameterized DRAG_OUT_STATES test in the
  // CTL-565 two-state-trigger block below (Backlog/Canceled/Duplicate). The
  // old single-case version is dropped as redundant — its example toState
  // ("In Progress") was a pipeline state under the new model, not a leave-path
  // trigger.

  test("CTL-681: an event whose toState == eligible status does NOT trigger a poll (per-event scoping reconcile removed)", async () => {
    enroll("ENG", { status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-9")] });
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-9", teamKey: "ENG", toState: "Todo" },
      },
      { exec, debounceMs: 30 }
    );
    expect(exec.calls).toBe(0); // not polled synchronously
    await sleep(70);
    // Pre-CTL-681 this was 1 (the debounced reconcile fired). Post-CTL-681
    // the eligible set is refreshed only by startup + 10-min reconcile; the
    // event itself does not trigger a poll. The 10-min timer is mocked out
    // of this test (no setInterval) so exec stays at 0.
    expect(exec.calls).toBe(0);
  });

  test("CTL-681: multiple →Ready events do not trigger any poll (no debounced reconcile to coalesce)", async () => {
    enroll("ENG", { status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-9")] });
    for (const ticket of ["ENG-7", "ENG-8", "ENG-9"]) {
      handleStateChangedEvent(
        {
          event: "linear.issue.state_changed",
          detail: { ticket, teamKey: "ENG", toState: "Todo" },
        },
        { exec, debounceMs: 30 }
      );
    }
    await sleep(80);
    // Pre-CTL-681 a 3-event burst coalesced into 1 reconcile (calls === 1).
    // Post-CTL-681 there is no per-event reconcile to coalesce; calls stays 0.
    expect(exec.calls).toBe(0);
  });

  test("an event whose teamKey matches no registered team is ignored", async () => {
    enroll("ENG", { status: "Todo" });
    setProjectEligible("ENG", [node("ENG-1")], {
      source: "reconcile",
      query: { team: "ENG", status: "Todo" },
    });
    const exec = execReturning({});
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "OTHER-1", teamKey: "OTHER", toState: "In Progress" },
      },
      { exec, debounceMs: 30 }
    );
    await sleep(60);
    expect(exec.calls).toBe(0);
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-1"]);
  });
});

// --- CTL-565 Phase 1: three-way toState split + triage one-shot dispatch -----

describe("handleStateChangedEvent — CTL-565 two-state trigger", () => {
  const orchDir = "/orch";

  test("toState === triageStatus one-shot-dispatches the triage phase agent", () => {
    enroll("ENG", { status: "Ready" }); // triageStatus defaults to "Triage"
    const dispatch = mock(() => ({ code: 0 }));
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Triage" },
      },
      { dispatch, orchDir }
    );
    expect(dispatch).toHaveBeenCalledWith({ orchDir, ticket: "ENG-1", phase: "triage" });
  });

  test("CTL-681: →Ready with an existing triage.json is a no-op (was: debounced reconcile, now: 10-min reconcile picks it up)", async () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core"); // real dir (beforeEach made it)
    writeTriageArtifact(realOrchDir, "ENG-9");
    const exec = execReturning({ ENG: [node("ENG-9")] });
    const dispatch = mock(() => ({ code: 0 }));
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-9", teamKey: "ENG", toState: "Ready" },
      },
      { exec, dispatch, orchDir: realOrchDir, debounceMs: 30 }
    );
    expect(dispatch).not.toHaveBeenCalled();
    await sleep(70);
    // Pre-CTL-681 the debounced reconcile fired (calls === 1). Post-CTL-681
    // an already-triaged →Ready is a no-op; the 10-min periodic reconcile is
    // what picks it up.
    expect(exec.calls).toBe(0);
  });

  test("CTL-625: →Ready with no triage.json auto-dispatches triage (Backlog→Ready-direct)", () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core"); // real dir, NO triage.json
    const exec = execReturning({ ENG: [node("ENG-9")] });
    const dispatch = mock(() => ({ code: 0 }));
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-9", teamKey: "ENG", toState: "Ready" },
      },
      { exec, dispatch, orchDir: realOrchDir, debounceMs: 30 }
    );
    expect(dispatch).toHaveBeenCalledWith({
      orchDir: realOrchDir,
      ticket: "ENG-9",
      phase: "triage",
    });
    expect(exec.calls).toBe(0); // did NOT reconcile (no new-work pull → no storm)
  });

  test("CTL-625 + CTL-681: →Ready with no orchDir wired is a no-op (was: fallback reconcile), never throws", async () => {
    enroll("ENG", { status: "Ready" });
    const exec = execReturning({ ENG: [node("ENG-9")] });
    const dispatch = mock(() => ({ code: 0 }));
    expect(() =>
      handleStateChangedEvent(
        {
          event: "linear.issue.state_changed",
          detail: { ticket: "ENG-9", teamKey: "ENG", toState: "Ready" },
        },
        { exec, dispatch, debounceMs: 30 } // no orchDir
      )
    ).not.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    await sleep(70);
    // Pre-CTL-681 the no-orchDir branch fell back to the debounced reconcile
    // (calls === 1). Post-CTL-681 there is no reconcile to fall back to; the
    // 10-min periodic reconcile handles it. The throw-safety property is
    // preserved (still no throw).
    expect(exec.calls).toBe(0);
  });

  // CTL-584: drag-out kill fires only for the enumerated DRAG_OUT_STATES.
  // Backlog/Canceled/Duplicate each fast-path-remove the ticket from the
  // eligible projection. Daemon-written pipeline states (covered below) do
  // NOT.
  test.each(["Backlog", "Canceled", "Duplicate"])(
    "toState %s fast-path-removes the ticket from the eligible projection",
    (toState) => {
      enroll("ENG", { status: "Ready" });
      setProjectEligible("ENG", [node("ENG-1"), node("ENG-2")], {
        source: "reconcile",
        query: { team: "ENG", status: "Ready" },
      });
      handleStateChangedEvent({
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-1", teamKey: "ENG", toState },
      });
      expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-2"]);
    }
  );

  test("a triage dispatch failure is logged and never throws", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = () => ({ code: 9, stderr: "x" });
    expect(() =>
      handleStateChangedEvent(
        {
          event: "linear.issue.state_changed",
          detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Triage" },
        },
        { dispatch, orchDir }
      )
    ).not.toThrow();
  });

  test("a →Triage transition with no orchDir wired does not throw or dispatch", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    expect(() =>
      handleStateChangedEvent(
        {
          event: "linear.issue.state_changed",
          detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Triage" },
        },
        { dispatch }
      )
    ).not.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  // CTL-584: every DRAG_OUT_STATES toState invokes abortWorker. The drop of
  // the parallel "a drag-out still removes" test is intentional — the
  // parameterized fast-path-remove test above already covers Canceled, the
  // dropped test's distinguishing case.
  test.each(["Backlog", "Canceled", "Duplicate"])(
    "toState %s invokes abortWorker for the in-flight worker",
    (toState) => {
      enroll("ENG", { status: "Ready" });
      const abortWorker = mock(() => ({ aborted: true }));
      handleStateChangedEvent(
        {
          event: "linear.issue.state_changed",
          detail: { ticket: "ENG-1", teamKey: "ENG", toState },
        },
        { orchDir, abortWorker }
      );
      expect(abortWorker).toHaveBeenCalledWith("/orch", "ENG-1", {
        repoRoot: expect.any(String),
      });
    }
  );

  test("a drag-out with no orchDir wired removes the ticket and does not throw", () => {
    enroll("ENG", { status: "Ready" });
    const abortWorker = mock(() => ({ aborted: true }));
    expect(() =>
      handleStateChangedEvent(
        {
          event: "linear.issue.state_changed",
          detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Backlog" },
        },
        { abortWorker }
      )
    ).not.toThrow();
    expect(abortWorker).not.toHaveBeenCalled(); // no orchDir → abort skipped
  });

  // CTL-584: the daemon's own CTL-558 status write-backs (Research / Plan /
  // Implement / Validate / PR / Done) must be no-ops in the monitor — the
  // pipeline must never kill its own worker on hearing its own write echo.
  // The eligible projection is unchanged; abortWorker + dispatch are never
  // called. This is the negative coverage the original test suite missed.
  test.each(["Research", "Plan", "Implement", "Validate", "PR", "Done"])(
    "toState %s (daemon-written pipeline state) is a no-op — no removal, no abortWorker",
    (toState) => {
      enroll("ENG", { status: "Ready" });
      setProjectEligible("ENG", [node("ENG-1"), node("ENG-2")], {
        source: "reconcile",
        query: { team: "ENG", status: "Ready" },
      });
      const abortWorker = mock(() => ({ aborted: true }));
      const dispatch = mock(() => ({ code: 0 }));
      handleStateChangedEvent(
        {
          event: "linear.issue.state_changed",
          detail: { ticket: "ENG-1", teamKey: "ENG", toState },
        },
        { orchDir, abortWorker, dispatch }
      );
      expect(abortWorker).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-1", "ENG-2"]);
    }
  );

  // CTL-584: an unknown toState is conservatively treated as a no-op — a
  // missed kill is recoverable (next reconcile drops it from the eligible
  // set); a wrong kill destroys live work.
  test("an unknown toState is a no-op — no removal, no abortWorker (conservative default)", () => {
    enroll("ENG", { status: "Ready" });
    setProjectEligible("ENG", [node("ENG-1")], {
      source: "reconcile",
      query: { team: "ENG", status: "Ready" },
    });
    const abortWorker = mock(() => ({ aborted: true }));
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Mystery" },
      },
      { orchDir, abortWorker }
    );
    expect(abortWorker).not.toHaveBeenCalled();
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-1"]);
  });
});

// --- CTL-704: verified Todo→Triage write-back wiring in dispatchTriage ---------

describe("handleStateChangedEvent — CTL-704 triage write-back wiring", () => {
  const orchDir = "/orch";

  test("CTL-704: writes Triage after successful dispatch — applyTriageStatus + appendEvent called", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const applyTriageStatus = mock(() => ({
      applied: true,
      verified: true,
      from_state: "Todo",
      to_state: "Triage",
      reason: null,
    }));
    const appendEvent = mock(() => true);
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Triage" },
      },
      { dispatch, orchDir, applyTriageStatus, appendEvent }
    );
    expect(dispatch).toHaveBeenCalledWith({ orchDir, ticket: "ENG-1", phase: "triage" });
    expect(applyTriageStatus).toHaveBeenCalledTimes(1);
    const applyArg = applyTriageStatus.mock.calls[0][0];
    expect(applyArg.ticket).toBe("ENG-1");
    expect(appendEvent).toHaveBeenCalledTimes(1);
    const appendArg = appendEvent.mock.calls[0][0];
    expect(appendArg.ticket).toBe("ENG-1");
    expect(appendArg.from_state).toBe("Todo");
    expect(appendArg.to_state).toBe("Triage");
    expect(appendArg.verified).toBe(true);
  });

  test("CTL-704: dispatch fails → applyTriageStatus and appendEvent are NOT called", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 1 }));
    const applyTriageStatus = mock(() => ({ applied: false, verified: false }));
    const appendEvent = mock(() => true);
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Triage" },
      },
      { dispatch, orchDir, applyTriageStatus, appendEvent }
    );
    expect(applyTriageStatus).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });

  test("CTL-704: write unverified → appendEvent still called with verified:false, never throws", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const applyTriageStatus = mock(() => ({
      applied: true,
      verified: false,
      from_state: "Todo",
      to_state: "Todo",
      reason: "verify-failed",
    }));
    const appendEvent = mock(() => true);
    expect(() =>
      handleStateChangedEvent(
        {
          event: "linear.issue.state_changed",
          detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Triage" },
        },
        { dispatch, orchDir, applyTriageStatus, appendEvent }
      )
    ).not.toThrow();
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(appendEvent.mock.calls[0][0].verified).toBe(false);
  });

  test("CTL-704: no orchDir → unchanged no-op, applyTriageStatus not called", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const applyTriageStatus = mock(() => ({ applied: true, verified: true }));
    const appendEvent = mock(() => true);
    expect(() =>
      handleStateChangedEvent(
        {
          event: "linear.issue.state_changed",
          detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Triage" },
        },
        { dispatch, applyTriageStatus, appendEvent } // no orchDir
      )
    ).not.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(applyTriageStatus).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });
});

describe("lifecycle", () => {
  test("startMonitor runs an immediate reconcileAll", () => {
    enroll("ENG", { status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1")] });
    startMonitor({ exec, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-1"]);
  });

  test("reconcileAll re-reads the registry — a new team is picked up, a removed one is dropped", () => {
    enroll("ENG", { status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1")], PLAT: [node("PLAT-1")] });
    reconcileAll({ exec });
    expect(getEligibleSet("ENG")).toHaveLength(1);

    enroll("PLAT", { status: "Todo" });
    reconcileAll({ exec });
    expect(getEligibleSet("PLAT").map((t) => t.identifier)).toEqual(["PLAT-1"]);

    unenroll("ENG");
    reconcileAll({ exec });
    expect(getEligibleSet("ENG")).toEqual([]); // dropProject'd
  });

  test("stopMonitor clears pending debounce timers (a queued reconcile never fires)", async () => {
    enroll("ENG", { status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-9")] });
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-9", teamKey: "ENG", toState: "Todo" },
      },
      { exec, debounceMs: 40 }
    );
    stopMonitor(); // clears the queued debounce timer
    await sleep(80);
    expect(exec.calls).toBe(0);
  });
});

// --- CTL-539: durable cursor wiring ---------------------------------------

// eventLogPath / appendEventLog — resolve and append to the current UTC
// month's log under the temp CATALYST_DIR (the path getEventLogPath() uses).
function eventLogPath() {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(catalystDir, "events", `${ym}.jsonl`);
}
function appendEventLog(line) {
  mkdirSync(join(catalystDir, "events"), { recursive: true });
  appendFileSync(eventLogPath(), line);
}

describe("seedTailerFromCursor", () => {
  test("no cursor file → tailer offset = EOF (poll-only parity)", () => {
    appendEventLog('{"event":"a"}\n{"event":"b"}\n');
    const size = statSync(eventLogPath()).size;
    seedTailerFromCursor();
    expect(__tailerOffset()).toBe(size);
  });

  test("no event log file at all → tailer offset = 0 (poll-only mode)", () => {
    seedTailerFromCursor();
    expect(__tailerOffset()).toBe(0);
  });

  test("valid cursor → tailer offset = saved offset", () => {
    appendEventLog('{"event":"a"}\n{"event":"b"}\n{"event":"c"}\n');
    const midpoint = 14; // a partial offset into the log
    saveCursor({ logPath: eventLogPath(), byteOffset: midpoint });
    seedTailerFromCursor();
    expect(__tailerOffset()).toBe(midpoint);
  });

  test("stale cursor (offset > size) → tailer offset = EOF", () => {
    appendEventLog('{"event":"a"}\n');
    const size = statSync(eventLogPath()).size;
    saveCursor({ logPath: eventLogPath(), byteOffset: 999999 });
    seedTailerFromCursor();
    expect(__tailerOffset()).toBe(size);
  });
});

describe("readNewEvents — cursor persistence", () => {
  test("persists the cursor after draining new bytes", () => {
    appendEventLog('{"event":"first"}\n');
    seedTailerFromCursor(); // seed at EOF of the one-line log
    appendEventLog('{"event":"second"}\n'); // a new append while tailing
    readNewEvents();
    const size = statSync(eventLogPath()).size;
    expect(loadCursor()).toEqual({ logPath: eventLogPath(), byteOffset: size });
    expect(__tailerOffset()).toBe(size);
  });
});

describe("startMonitor — resumeFromCursor", () => {
  test("resumeFromCursor:false keeps the seed-at-EOF behavior", () => {
    enroll("ENG", { status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1")] });
    appendEventLog('{"event":"a"}\n{"event":"b"}\n');
    const size = statSync(eventLogPath()).size;
    startMonitor({
      exec,
      resumeFromCursor: false,
      reconcileIntervalMs: 60_000,
    });
    expect(__tailerOffset()).toBe(size); // EOF — no cursor consulted
  });

  test("resumeFromCursor:true drains the gap between cursor and EOF", () => {
    // ENG holds ENG-1 + ENG-2; an event in the downtime gap dragged ENG-1
    // OUT (Backlog — DRAG_OUT_STATES). resumeFromCursor:true must drain that
    // gap on startup and remove ENG-1 — proving the durable cursor, not a
    // re-seed, drove the resume. CTL-584: toState must be a drag-out for the
    // leave-path to fire (was "In Progress" pre-CTL-584 when the leave-path
    // fired on anything non-Triage/non-Ready).
    enroll("ENG", { status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1"), node("ENG-2")] });
    // Pre-write a downtime-gap event and pin the cursor at offset 0.
    appendEventLog(
      `${JSON.stringify({
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Backlog" },
      })}\n`
    );
    saveCursor({ logPath: eventLogPath(), byteOffset: 0 });
    startMonitor({ exec, resumeFromCursor: true, reconcileIntervalMs: 60_000 });
    // startup reconcileAll seeded {ENG-1, ENG-2}; the gap drain removed ENG-1.
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-2"]);
  });

  test("resumeFromCursor defaults to true (the gap is drained without the flag)", () => {
    enroll("ENG", { status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1"), node("ENG-2")] });
    appendEventLog(
      `${JSON.stringify({
        event: "linear.issue.state_changed",
        // CTL-584: a drag-out state — "Done" was a pipeline state under the
        // new model (not a leave-trigger), so we use Canceled here to drive
        // the gap-drain removal.
        detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Canceled" },
      })}\n`
    );
    saveCursor({ logPath: eventLogPath(), byteOffset: 0 });
    startMonitor({ exec, reconcileIntervalMs: 60_000 }); // no resumeFromCursor
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-2"]);
  });

  // CTL-731 Phase 00: the boot gap-drain must be FOLD-ONLY. It advances the
  // cursor and applies idempotent projection folds (upsert/remove), but must NOT
  // re-run dispatch side-effects (dispatchTriage) for events already acted on
  // before the restart — both to avoid duplicate triage dispatches AND to keep
  // startMonitor from blocking on a burst of synchronous subprocess spawns.
  test("CTL-731: boot gap-drain folds eligibility but does NOT dispatch triage for a gap →status event", () => {
    const orchDir = join(catalystDir, "execution-core");
    enroll("ENG", { status: "Todo" });
    const exec = execReturning({ ENG: [] }); // reconcile + sweep see nothing eligible
    // A →Todo transition in the downtime gap. In steady-state this folds ENG-5
    // into the eligible set AND (CTL-625, no triage.json) auto-dispatches triage.
    appendEventLog(
      `${JSON.stringify({
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-5", teamKey: "ENG", toState: "Todo", toPriority: 2 },
      })}\n`
    );
    saveCursor({ logPath: eventLogPath(), byteOffset: 0 });
    const dispatch = mock(() => ({ code: 0 }));
    startMonitor({
      exec,
      orchDir,
      dispatch,
      resumeFromCursor: true,
      reconcileIntervalMs: 60_000,
      tailerPollMs: 0, // no steady-state poll during this synchronous test
    });
    // Fold KEPT — ENG-5 is eligible (folded from the gap event, no Linear poll).
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-5"]);
    // Side-effect SKIPPED — the fold-only boot drain did not dispatch triage.
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("CTL-731: boot gap-drain does NOT dispatch triage for a gap →Triage transition (no duplicate on restart)", () => {
    const orchDir = join(catalystDir, "execution-core");
    enroll("ENG", { status: "Todo" }); // triageStatus defaults to "Triage"
    const exec = execReturning({ ENG: [] });
    appendEventLog(
      `${JSON.stringify({
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-7", teamKey: "ENG", toState: "Triage" },
      })}\n`
    );
    saveCursor({ logPath: eventLogPath(), byteOffset: 0 });
    const dispatch = mock(() => ({ code: 0 }));
    startMonitor({
      exec,
      orchDir,
      dispatch,
      resumeFromCursor: true,
      reconcileIntervalMs: 60_000,
      tailerPollMs: 0,
    });
    expect(dispatch).not.toHaveBeenCalled(); // a Triage ticket is never re-dispatched at boot
  });
});

// CTL-634 Tier 1 — every state_changed event write-through-refreshes the
// cached state so the next scheduler tick's out-of-set blocker hydration is a
// hit instead of a re-read. The write-through runs before the project loop, so
// it needs no enrolled team — set() ignores a null toState, making an event
// with no extractable state a safe no-op.
describe("handleStateChangedEvent — cache write-through (CTL-634)", () => {
  test("writes the toState into the cache so a later read is a hit (zero exec)", () => {
    const cache = createTicketStateCache({ now: () => 0 });
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "CTL-99", teamKey: "ENG", toState: "Done" },
      },
      { cache }
    );
    let calls = 0;
    const execProbe = () => {
      calls += 1;
      return { code: 0, stdout: "{}", stderr: "" };
    };
    expect(fetchTicketState("CTL-99", { exec: execProbe, cache })).toBe("Done");
    expect(calls).toBe(0); // served entirely from the written-through cache
  });

  test("a missing toState does not write a bogus cache entry", () => {
    const cache = createTicketStateCache({ now: () => 0 });
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "CTL-99", teamKey: "ENG" }, // no toState
      },
      { cache }
    );
    expect(cache.get("CTL-99")).toBeUndefined();
  });
});

// --- CTL-711: sweepMissingTriage — reconcile-path triage dispatch ---------------

describe("sweepMissingTriage (CTL-711)", () => {
  test("dispatches triage for an eligible ticket with no triage.json", () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core"); // real dir, NO triage.json
    const exec = execReturning({ ENG: [node("ENG-9")] });
    reconcileAll({ exec }); // populate the eligible set first
    const dispatch = mock(() => ({ code: 0 }));
    sweepMissingTriage({
      orchDir: realOrchDir,
      dispatch,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
    });
    expect(dispatch).toHaveBeenCalledWith({
      orchDir: realOrchDir,
      ticket: "ENG-9",
      phase: "triage",
    });
  });

  test("does NOT dispatch for an already-triaged eligible ticket", () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core");
    writeTriageArtifact(realOrchDir, "ENG-9"); // already triaged
    const exec = execReturning({ ENG: [node("ENG-9")] });
    reconcileAll({ exec });
    const dispatch = mock(() => ({ code: 0 }));
    sweepMissingTriage({ orchDir: realOrchDir, dispatch });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("dispatches only the un-triaged subset across a mixed eligible set", () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core");
    writeTriageArtifact(realOrchDir, "ENG-1"); // triaged
    // ENG-2 left un-triaged
    const exec = execReturning({ ENG: [node("ENG-1"), node("ENG-2")] });
    reconcileAll({ exec });
    const dispatch = mock(() => ({ code: 0 }));
    sweepMissingTriage({
      orchDir: realOrchDir,
      dispatch,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
      readMaxParallelFn: () => 6, // CTL-716: explicit ceiling for determinism
      liveBackgroundCount: () => 0,
    });
    const dispatched = dispatch.mock.calls.map((c) => c[0].ticket);
    expect(dispatched).toEqual(["ENG-2"]);
  });

  test("no orchDir wired → no dispatch, never throws", () => {
    enroll("ENG", { status: "Ready" });
    const exec = execReturning({ ENG: [node("ENG-9")] });
    reconcileAll({ exec });
    const dispatch = mock(() => ({ code: 0 }));
    expect(() => sweepMissingTriage({ dispatch })).not.toThrow(); // no orchDir
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("a dispatch failure is logged and never throws (one bad ticket does not abort the sweep)", () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core");
    const exec = execReturning({ ENG: [node("ENG-1"), node("ENG-2")] });
    reconcileAll({ exec });
    const dispatch = mock(() => ({ code: 9, stderr: "boom" })); // non-zero
    expect(() =>
      sweepMissingTriage({
        orchDir: realOrchDir,
        dispatch,
        applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
        appendEvent: () => {},
        readMaxParallelFn: () => 6, // CTL-716: ceiling high enough for both tickets
        liveBackgroundCount: () => 0,
      })
    ).not.toThrow();
    // both tickets attempted despite the first failing
    expect(dispatch.mock.calls.map((c) => c[0].ticket)).toEqual(["ENG-1", "ENG-2"]);
  });

  test("startMonitor dispatches triage for a pre-existing eligible ticket lacking triage.json (CTL-711)", () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core"); // real, NO triage.json
    const exec = execReturning({ ENG: [node("ENG-1")] });
    const dispatch = mock(() => ({ code: 0 }));
    startMonitor({
      exec,
      orchDir: realOrchDir,
      dispatch,
      reconcileIntervalMs: 60_000,
      resumeFromCursor: false, // avoid cursor/tailer side effects in the unit test
    });
    expect(dispatch).toHaveBeenCalledWith({
      orchDir: realOrchDir,
      ticket: "ENG-1",
      phase: "triage",
    });
  });

  test("the periodic reconcile timer also runs the triage sweep (CTL-711)", async () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core"); // NO triage.json
    // First poll returns empty (nothing eligible yet at boot), later polls return ENG-1.
    let polls = 0;
    const exec = (_cmd, args) => {
      polls += 1;
      const team = args[args.indexOf("--team") + 1];
      const nodes = polls === 1 ? [] : team === "ENG" ? [node("ENG-1")] : [];
      return { code: 0, stdout: JSON.stringify({ nodes }), stderr: "" };
    };
    const dispatch = mock(() => ({ code: 0 }));
    startMonitor({
      exec,
      orchDir: realOrchDir,
      dispatch,
      reconcileIntervalMs: 30, // fast periodic tick for the test
      resumeFromCursor: false,
      readMaxParallelFn: () => 6, // CTL-716: inject seam so async liveness refresh doesn't block the triage sweep
      liveBackgroundCount: () => 0,
    });
    // Startup sweep saw an empty eligible set → no dispatch yet.
    expect(dispatch).not.toHaveBeenCalled();
    await sleep(80); // let the periodic reconcile + sweep fire
    expect(dispatch).toHaveBeenCalledWith({
      orchDir: realOrchDir,
      ticket: "ENG-1",
      phase: "triage",
    });
    stopMonitor();
  });
});

// --- CTL-716: slot-gate triage dispatch against maxParallel -----------------

describe("handleStateChangedEvent — CTL-716 slot gate", () => {
  const orchDir = "/orch";

  test("→Triage when slots are FULL → does NOT dispatch", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    handleStateChangedEvent(
      { event: "linear.issue.state_changed",
        detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Triage" } },
      { dispatch, orchDir,
        applyTriageStatus: () => ({ applied: false, verified: false }),
        appendEvent: () => {},
        readMaxParallelFn: () => 3,
        liveBackgroundCount: () => 3 }, // ceiling 3, live 3 ⇒ 0 free
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("→Triage when a slot is FREE → dispatches exactly once", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    handleStateChangedEvent(
      { event: "linear.issue.state_changed",
        detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Triage" } },
      { dispatch, orchDir,
        applyTriageStatus: () => ({ applied: true, verified: true, from_state: "Todo", to_state: "Triage", reason: null }),
        appendEvent: () => {},
        readMaxParallelFn: () => 3,
        liveBackgroundCount: () => 2 }, // 1 free
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test("→Todo (no triage.json) when slots FULL → does NOT dispatch", () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core"); // NO triage.json
    const dispatch = mock(() => ({ code: 0 }));
    handleStateChangedEvent(
      { event: "linear.issue.state_changed",
        detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Ready" } },
      { dispatch, orchDir: realOrchDir,
        applyTriageStatus: () => ({ applied: false, verified: false }),
        appendEvent: () => {},
        readMaxParallelFn: () => 1,
        liveBackgroundCount: () => 1 }, // 0 free
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("a deferred dispatch leaves the eligible projection intact (→Todo fold still happens)", () => {
    enroll("ENG", { status: "Todo" });
    const realOrchDir = join(catalystDir, "execution-core"); // NO triage.json
    const dispatch = mock(() => ({ code: 0 }));
    handleStateChangedEvent(
      { event: "linear.issue.state_changed",
        detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Todo" } },
      { dispatch, orchDir: realOrchDir,
        applyTriageStatus: () => ({ applied: false, verified: false }),
        appendEvent: () => {},
        readMaxParallelFn: () => 1,
        liveBackgroundCount: () => 1 }, // 0 free slots
    );
    expect(dispatch).not.toHaveBeenCalled();
    // upsertTicket ran before the gate — ticket is in the eligible set for sweepMissingTriage.
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toContain("ENG-1");
  });

  test("default liveness source is countBackgroundAgents (no throw, dispatches when fleet empty)", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    // no readMaxParallelFn / liveBackgroundCount injected → real defaults.
    // In the unit env getAgentsCached() is cold ⇒ [] ⇒ count 0 ⇒ free > 0.
    handleStateChangedEvent(
      { event: "linear.issue.state_changed",
        detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Triage" } },
      { dispatch, orchDir,
        applyTriageStatus: () => ({ applied: true, verified: true, from_state: "Todo", to_state: "Triage", reason: null }),
        appendEvent: () => {} },
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("readNewEvents — CTL-716 burst budget", () => {
  test("7 →Triage events drained in ONE pass with 6 free slots → exactly 6 triage dispatches", () => {
    enroll("ENG", { status: "Ready" }); // triageStatus defaults to "Triage"
    const realOrchDir = join(catalystDir, "execution-core"); // no triage.json for any ticket
    const dispatch = mock(() => ({ code: 0 }));
    startMonitor({
      exec: execReturning({}),
      reconcileIntervalMs: 60_000,
      resumeFromCursor: false,
      orchDir: realOrchDir,
      dispatch,
      readMaxParallelFn: () => 6,
      liveBackgroundCount: () => 0, // 6 free slots
    });
    // Startup saw no eligible tickets → 0 dispatches so far.
    expect(dispatch.mock.calls.length).toBe(0);
    // Append 7 distinct →Triage events.
    for (let i = 1; i <= 7; i++) {
      appendEventLog(JSON.stringify({
        event: "linear.issue.state_changed",
        detail: { ticket: `ENG-${i}`, teamKey: "ENG", toState: "Triage" },
      }) + "\n");
    }
    readNewEvents();
    // Budget: 6 free slots → exactly 6 dispatches, 7th dropped (retry on next sweep).
    expect(dispatch.mock.calls.length).toBe(6);
    stopMonitor();
  });

  test("burst with 0 free slots → 0 dispatches in the drain", () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core");
    const dispatch = mock(() => ({ code: 0 }));
    startMonitor({
      exec: execReturning({}),
      reconcileIntervalMs: 60_000,
      resumeFromCursor: false,
      orchDir: realOrchDir,
      dispatch,
      readMaxParallelFn: () => 1,
      liveBackgroundCount: () => 1, // 0 free
    });
    for (let i = 1; i <= 5; i++) {
      appendEventLog(JSON.stringify({
        event: "linear.issue.state_changed",
        detail: { ticket: `ENG-${i}`, teamKey: "ENG", toState: "Triage" },
      }) + "\n");
    }
    readNewEvents();
    expect(dispatch).not.toHaveBeenCalled();
    stopMonitor();
  });

  test("foldOnly drain dispatches nothing regardless of budget", () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core");
    const dispatch = mock(() => ({ code: 0 }));
    startMonitor({
      exec: execReturning({}),
      reconcileIntervalMs: 60_000,
      resumeFromCursor: false,
      orchDir: realOrchDir,
      dispatch,
      readMaxParallelFn: () => 10,
      liveBackgroundCount: () => 0, // plenty of free slots
    });
    appendEventLog(JSON.stringify({
      event: "linear.issue.state_changed",
      detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Triage" },
    }) + "\n");
    readNewEvents({ foldOnly: true }); // fold-only: no dispatch side-effects
    expect(dispatch).not.toHaveBeenCalled();
    stopMonitor();
  });
});

describe("sweepMissingTriage — CTL-716 slot gate", () => {
  test("CTL-716: dispatches at most freeSlots tickets per sweep", () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core");
    const exec = execReturning({ ENG: [node("ENG-1"), node("ENG-2"), node("ENG-3")] });
    reconcileAll({ exec });
    const dispatch = mock(() => ({ code: 0 }));
    sweepMissingTriage({
      orchDir: realOrchDir,
      dispatch,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
      readMaxParallelFn: () => 2,
      liveBackgroundCount: () => 0, // 2 free
    });
    // 2 of the 3 tickets dispatched; ENG-3 deferred to the next sweep.
    expect(dispatch.mock.calls.length).toBe(2);
  });

  test("CTL-716: a second sweep with freed slots dispatches the remainder (idempotent retry)", () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core");
    const exec = execReturning({ ENG: [node("ENG-1"), node("ENG-2"), node("ENG-3")] });
    reconcileAll({ exec });

    // First sweep: 2 free slots → dispatch ENG-1 + ENG-2, write their triage artifacts.
    const dispatchFirstSweep = (args) => {
      writeTriageArtifact(args.orchDir, args.ticket);
      return { code: 0 };
    };
    const dispatch1 = mock(dispatchFirstSweep);
    sweepMissingTriage({
      orchDir: realOrchDir,
      dispatch: dispatch1,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
      readMaxParallelFn: () => 2,
      liveBackgroundCount: () => 0,
    });
    expect(dispatch1.mock.calls.length).toBe(2);

    // Second sweep: slots free again → only ENG-3 remains un-triaged.
    const dispatch2 = mock(() => ({ code: 0 }));
    sweepMissingTriage({
      orchDir: realOrchDir,
      dispatch: dispatch2,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
      readMaxParallelFn: () => 2,
      liveBackgroundCount: () => 0,
    });
    expect(dispatch2.mock.calls.map((c) => c[0].ticket)).toEqual(["ENG-3"]);
  });

  test("CTL-716: zero free slots → no dispatch", () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core");
    const exec = execReturning({ ENG: [node("ENG-1"), node("ENG-2")] });
    reconcileAll({ exec });
    const dispatch = mock(() => ({ code: 0 }));
    sweepMissingTriage({
      orchDir: realOrchDir,
      dispatch,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
      readMaxParallelFn: () => 1,
      liveBackgroundCount: () => 1, // 0 free
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

// --- CTL-681 Phase 3: parseIssueUpdatedEvent + handleIssueUpdatedEvent ------

// Helper to build a canonical OTel-shaped linear.issue.updated event.
function issueUpdatedEvent({ identifier, teamKey, toState, toLabels, toProject, toPriority, description, descriptionChanged, actorId, actorName } = {}) {
  return {
    attributes: {
      "event.name": "linear.issue.updated",
      "linear.issue.identifier": identifier ?? "ENG-9",
    },
    body: {
      payload: {
        ticket: identifier ?? "ENG-9",
        teamKey: teamKey ?? "ENG",
        toState: toState ?? "Todo",
        toLabels: toLabels ?? null,
        toProject: toProject ?? null,
        toPriority: toPriority ?? null,
        description: description ?? null,
        descriptionChanged: descriptionChanged ?? false,
        actorId: actorId ?? null,
        actorName: actorName ?? null,
      },
    },
  };
}

describe("parseIssueUpdatedEvent (CTL-681)", () => {
  test("canonical OTel shape → returns parsed object", () => {
    const parsed = parseIssueUpdatedEvent(issueUpdatedEvent({ identifier: "ENG-5" }));
    expect(parsed).toMatchObject({ identifier: "ENG-5", teamKey: "ENG", toState: "Todo" });
  });

  test("legacy flat shape → returns parsed object", () => {
    const parsed = parseIssueUpdatedEvent({
      event: "linear.issue.updated",
      detail: { ticket: "ENG-7", teamKey: "ENG", toState: "Backlog", toLabels: ["p0"] },
    });
    expect(parsed).toMatchObject({ identifier: "ENG-7", toState: "Backlog" });
    expect(parsed.toLabels).toEqual(["p0"]);
  });

  test("returns null for linear.issue.state_changed", () => {
    expect(
      parseIssueUpdatedEvent({
        attributes: { "event.name": "linear.issue.state_changed", "linear.issue.identifier": "ENG-1" },
        body: { payload: {} },
      })
    ).toBeNull();
  });

  test("returns null for linear.comment.created", () => {
    expect(
      parseIssueUpdatedEvent({
        attributes: { "event.name": "linear.comment.created", "linear.issue.identifier": "ENG-1" },
        body: { payload: {} },
      })
    ).toBeNull();
  });

  test("returns null for empty object", () => {
    expect(parseIssueUpdatedEvent({})).toBeNull();
  });

  test("returns null when no identifier extractable", () => {
    expect(
      parseIssueUpdatedEvent({
        attributes: { "event.name": "linear.issue.updated" },
        body: { payload: { teamKey: "ENG" } },
      })
    ).toBeNull();
  });
});

describe("handleIssueUpdatedEvent (CTL-681)", () => {
  test("adds a newly-eligible ticket when it matches the query", () => {
    enroll("ENG", { status: "Todo", label: "p0" });
    handleIssueUpdatedEvent(
      issueUpdatedEvent({ identifier: "ENG-9", toState: "Todo", toLabels: ["p0"] })
    );
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toContain("ENG-9");
  });

  test("label-only change with no label filter: ticket is added when state matches", () => {
    enroll("ENG", { status: "Todo", label: null });
    handleIssueUpdatedEvent(
      issueUpdatedEvent({ identifier: "ENG-9", toState: "Todo", toLabels: ["something"] })
    );
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toContain("ENG-9");
  });

  test("removes a now-ineligible ticket when it loses the required label", () => {
    enroll("ENG", { status: "Todo", label: "p0" });
    setProjectEligible("ENG", [{ identifier: "ENG-9", state: "Todo", priority: 1 }], {
      source: "reconcile",
      query: {},
    });
    handleIssueUpdatedEvent(
      issueUpdatedEvent({ identifier: "ENG-9", toState: "Todo", toLabels: [] })
    );
    expect(getEligibleSet("ENG").map((t) => t.identifier)).not.toContain("ENG-9");
  });

  test("team mismatch is a no-op (wrong teamKey)", () => {
    enroll("ENG", { status: "Todo" });
    handleIssueUpdatedEvent(
      issueUpdatedEvent({ identifier: "PROJ-1", teamKey: "PROJ", toState: "Todo" })
    );
    expect(getEligibleSet("ENG")).toEqual([]);
  });

  test("wrong state is not eligible (ticket absent after fold)", () => {
    enroll("ENG", { status: "Todo" });
    handleIssueUpdatedEvent(
      issueUpdatedEvent({ identifier: "ENG-9", toState: "In Progress" })
    );
    expect(getEligibleSet("ENG").map((t) => t.identifier)).not.toContain("ENG-9");
  });

  test("priority floor respected: toPriority exceeds query.priority → not eligible", () => {
    enroll("ENG", { status: "Todo", priority: 2 });
    handleIssueUpdatedEvent(
      issueUpdatedEvent({ identifier: "ENG-9", toState: "Todo", toPriority: 3 })
    );
    expect(getEligibleSet("ENG").map((t) => t.identifier)).not.toContain("ENG-9");
  });

  test("cache write-through: toState written to cache", () => {
    enroll("ENG", { status: "Todo" });
    const cache = createTicketStateCache({ now: () => 0 });
    handleIssueUpdatedEvent(
      issueUpdatedEvent({ identifier: "ENG-9", toState: "Done" }),
      { cache }
    );
    expect(cache.get("ENG-9")).toBe("Done");
  });

  test("no orchDir: does not throw", () => {
    enroll("ENG", { status: "Todo" });
    expect(() =>
      handleIssueUpdatedEvent(issueUpdatedEvent(), { orchDir: undefined })
    ).not.toThrow();
  });

  test("abortWorker is NEVER called (issue-updated is a projection edit, not a kill)", () => {
    enroll("ENG", { status: "Todo" });
    const abortWorker = mock(() => {});
    handleIssueUpdatedEvent(
      issueUpdatedEvent({ identifier: "ENG-9", toState: "Backlog" }),
      { abortWorker }
    );
    expect(abortWorker).not.toHaveBeenCalled();
  });

  test("no poll: the injected exec is never called by handleIssueUpdatedEvent", () => {
    enroll("ENG", { status: "Todo" });
    const exec = mock(() => ({ code: 0, stdout: "{}", stderr: "" }));
    handleIssueUpdatedEvent(issueUpdatedEvent(), { exec });
    expect(exec).not.toHaveBeenCalled();
  });

  test("readNewEvents integration: a linear.issue.updated line triggers the eligible fold", () => {
    enroll("ENG", { status: "Todo" });
    // Write the event first (using appendEventLog which creates the dir), seed
    // the tailer at offset 0 so readNewEvents drains from the start.
    const line = JSON.stringify(issueUpdatedEvent({ identifier: "ENG-42", toState: "Todo" }));
    appendEventLog(line + "\n");
    saveCursor({ logPath: eventLogPath(), byteOffset: 0 });
    seedTailerFromCursor();
    readNewEvents();
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toContain("ENG-42");
  });
});

// --- CTL-681 Phase 4: parseCommentCreatedEvent + handleCommentCreatedEvent ---

function commentCreatedEvent({ ticket, commentId, body, authorId, authorName } = {}) {
  return {
    attributes: {
      "event.name": "linear.comment.created",
      "linear.issue.identifier": ticket ?? "ENG-9",
    },
    body: {
      payload: {
        ticket: ticket ?? "ENG-9",
        commentId: commentId ?? "c-1",
        issueId: "i-1",
        body: body ?? "a comment",
        authorId: authorId ?? "u-1",
        authorName: authorName ?? "Alice",
      },
    },
  };
}

describe("parseCommentCreatedEvent (CTL-681)", () => {
  test("canonical shape → parsed payload with all fields", () => {
    const parsed = parseCommentCreatedEvent(commentCreatedEvent({ ticket: "ENG-5" }));
    expect(parsed).toMatchObject({ ticket: "ENG-5", commentId: "c-1", body: "a comment" });
  });

  test("legacy flat shape via event.detail → same result", () => {
    const parsed = parseCommentCreatedEvent({
      event: "linear.comment.created",
      detail: { ticket: "ENG-7", commentId: "c-7", issueId: "i-1", body: "hi", authorId: "u2", authorName: "Bob" },
    });
    expect(parsed).toMatchObject({ ticket: "ENG-7", body: "hi", authorId: "u2" });
  });

  test("returns null for other event names", () => {
    expect(parseCommentCreatedEvent({ attributes: { "event.name": "linear.issue.updated" }, body: { payload: {} } })).toBeNull();
    expect(parseCommentCreatedEvent({ attributes: { "event.name": "linear.comment.updated" }, body: { payload: {} } })).toBeNull();
  });

  test("returns null for empty object", () => {
    expect(parseCommentCreatedEvent({})).toBeNull();
  });
});

describe("handleCommentCreatedEvent (CTL-681)", () => {
  test("invokes onComment with parsed payload when provided", () => {
    const onComment = mock(() => {});
    handleCommentCreatedEvent(commentCreatedEvent(), { onComment });
    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onComment.mock.calls[0][0]).toMatchObject({ ticket: "ENG-9", body: "a comment" });
  });

  test("no-op when onComment is undefined (never throws)", () => {
    expect(() => handleCommentCreatedEvent(commentCreatedEvent())).not.toThrow();
  });

  test("no-op (no throw) when event is non-comment (parsed = null)", () => {
    expect(() =>
      handleCommentCreatedEvent(
        { attributes: { "event.name": "linear.issue.updated" }, body: { payload: {} } },
        { onComment: mock(() => {}) }
      )
    ).not.toThrow();
  });

  test("does not touch the eligible set (no upsert/remove)", () => {
    enroll("ENG", { status: "Todo" });
    setProjectEligible("ENG", [{ identifier: "ENG-1", state: "Todo", priority: 1 }], {
      source: "reconcile",
      query: {},
    });
    handleCommentCreatedEvent(commentCreatedEvent({ ticket: "ENG-1" }));
    expect(getEligibleSet("ENG")).toHaveLength(1); // unchanged
  });

  test("bot-authored comment fires onComment (not suppressed)", () => {
    const onComment = mock(() => {});
    handleCommentCreatedEvent(
      commentCreatedEvent({ authorId: "bot-uuid-123" }),
      { onComment }
    );
    expect(onComment).toHaveBeenCalledTimes(1);
  });

  test("readNewEvents integration: a linear.comment.created line invokes onComment via tailerOpts", () => {
    const onComment = mock(() => {});
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    const line = JSON.stringify(commentCreatedEvent({ ticket: "ENG-10" }));
    appendFileSync(eventLogPath(), line + "\n");
    readNewEvents();
    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onComment.mock.calls[0][0]).toMatchObject({ ticket: "ENG-10" });
    stopMonitor();
  });
});

// --- CTL-749: parseIssueUpdatedEvent description fields + onUpdate seam -----

describe("parseIssueUpdatedEvent — description fields (CTL-749)", () => {
  test("extracts description and descriptionChanged from payload", () => {
    const parsed = parseIssueUpdatedEvent(
      issueUpdatedEvent({ description: "new text", descriptionChanged: true })
    );
    expect(parsed).toMatchObject({ description: "new text", descriptionChanged: true });
  });

  test("description is null and descriptionChanged false when absent from payload", () => {
    const parsed = parseIssueUpdatedEvent(issueUpdatedEvent({}));
    expect(parsed.description).toBeNull();
    expect(parsed.descriptionChanged).toBe(false);
  });
});

describe("handleIssueUpdatedEvent — onUpdate seam (CTL-749)", () => {
  test("calls onUpdate with parsed payload when descriptionChanged", () => {
    const onUpdate = mock(() => {});
    handleIssueUpdatedEvent(
      issueUpdatedEvent({ descriptionChanged: true, description: "new" }),
      { onUpdate }
    );
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0]).toMatchObject({ descriptionChanged: true, description: "new" });
  });

  test("calls onUpdate even when descriptionChanged is false (subscriber decides)", () => {
    const onUpdate = mock(() => {});
    handleIssueUpdatedEvent(issueUpdatedEvent({ descriptionChanged: false }), { onUpdate });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  test("no-op when onUpdate is undefined (never throws)", () => {
    expect(() => handleIssueUpdatedEvent(issueUpdatedEvent())).not.toThrow();
  });

  test("onUpdate subscriber throw is swallowed (fail-open)", () => {
    const onUpdate = mock(() => { throw new Error("subscriber boom"); });
    expect(() => handleIssueUpdatedEvent(issueUpdatedEvent(), { onUpdate })).not.toThrow();
  });

  test("readNewEvents integration: a linear.issue.updated line invokes onUpdate via tailerOpts", () => {
    const onUpdate = mock(() => {});
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onUpdate });
    const line = JSON.stringify(issueUpdatedEvent({ identifier: "ENG-20", descriptionChanged: true, description: "updated" }));
    appendFileSync(eventLogPath(), line + "\n");
    readNewEvents();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0]).toMatchObject({ identifier: "ENG-20", descriptionChanged: true });
    stopMonitor();
  });
});

// ── CTL-781: respect-assignment + self-assign in dispatchTriage + sweep ──────

describe("dispatchTriage — CTL-781 respect-assignment + self-assign", () => {
  const BOT = "ff78d890-7906-4c22-b2f5-020bd150c790";
  const HUMAN = "11111111-1111-1111-1111-111111111111";
  const orchDir = "/orch-781";

  function toTriageEvent(ticket) {
    return {
      event: "linear.issue.state_changed",
      detail: { ticket, teamKey: "ENG", toState: "Triage" },
    };
  }

  test("→Triage for a human-assigned ticket → NO dispatch, budget not decremented", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const applyAssignee = mock(() => ({ applied: true, reason: null }));
    const fetchAssignee = () => ({ known: true, assignee: HUMAN });
    handleStateChangedEvent(toTriageEvent("ENG-H1"), {
      dispatch,
      orchDir,
      botUserIds: new Set([BOT]),
      botWriteId: BOT,
      fetchAssignee,
      applyAssignee,
      triageBudget: { remaining: 5 },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(applyAssignee).not.toHaveBeenCalled();
  });

  test("→Triage for an unassigned ticket → dispatch fires AND applyAssignee called with botWriteId", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const applyTriageStatus = mock(() => ({ applied: true, verified: true, from_state: "Todo", to_state: "Triage", reason: null }));
    const appendEvent = mock(() => {});
    const applyAssignee = mock(() => ({ applied: true, reason: null }));
    const fetchAssignee = () => ({ known: true, assignee: null });
    handleStateChangedEvent(toTriageEvent("ENG-N1"), {
      dispatch,
      orchDir,
      applyTriageStatus,
      appendEvent,
      botUserIds: new Set([BOT]),
      botWriteId: BOT,
      fetchAssignee,
      applyAssignee,
      triageBudget: { remaining: 5 },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(applyAssignee).toHaveBeenCalledTimes(1);
    expect(applyAssignee.mock.calls[0][0]).toMatchObject({ ticket: "ENG-N1", userId: BOT });
  });

  test("→Triage for a bot-assigned ticket → dispatch fires (re-claim of own ticket OK)", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const fetchAssignee = () => ({ known: true, assignee: BOT });
    handleStateChangedEvent(toTriageEvent("ENG-B1"), {
      dispatch,
      orchDir,
      botUserIds: new Set([BOT]),
      fetchAssignee,
      triageBudget: { remaining: 5 },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test("assignee unknown (no gateway, live read fails) → dispatch SKIPPED this event (sweep retries)", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const fetchAssignee = () => ({ known: false });
    handleStateChangedEvent(toTriageEvent("ENG-U1"), {
      dispatch,
      orchDir,
      botUserIds: new Set([BOT]),
      fetchAssignee,
      triageBudget: { remaining: 5 },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("no botUserIds threaded → gate skipped, dispatches as today (all existing tests unchanged)", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const fetchAssignee = mock(() => ({ known: true, assignee: HUMAN }));
    handleStateChangedEvent(toTriageEvent("ENG-ND1"), {
      dispatch,
      orchDir,
      fetchAssignee,
      triageBudget: { remaining: 5 },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(fetchAssignee).not.toHaveBeenCalled();
  });

  test("applyAssignee absent/failing → dispatch still completes, applyTriageStatus + appendEvent unaffected", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const applyTriageStatus = mock(() => ({ applied: true, verified: true, from_state: "Todo", to_state: "Triage", reason: null }));
    const appendEvent = mock(() => {});
    const applyAssignee = mock(() => ({ applied: false, reason: "transient" }));
    const fetchAssignee = () => ({ known: true, assignee: null });
    handleStateChangedEvent(toTriageEvent("ENG-FA1"), {
      dispatch,
      orchDir,
      applyTriageStatus,
      appendEvent,
      botUserIds: new Set([BOT]),
      botWriteId: BOT,
      fetchAssignee,
      applyAssignee,
      triageBudget: { remaining: 5 },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(applyTriageStatus).toHaveBeenCalledTimes(1);
    expect(appendEvent).toHaveBeenCalledTimes(1);
  });
});

describe("sweepMissingTriage — CTL-781 threading", () => {
  const BOT = "ff78d890-7906-4c22-b2f5-020bd150c790";
  const HUMAN = "11111111-1111-1111-1111-111111111111";

  test("sweep passes botUserIds/botWriteId/gateway through to dispatchTriage (human-assigned eligible ticket skipped)", () => {
    enroll("ENG", { status: "Ready" });
    setProjectEligible("ENG", [{ identifier: "ENG-SW1", state: "Todo", priority: 2, project: null }]);
    const orchDir = mkdtempSync(join(tmpdir(), "sw-orch-"));
    try {
      const dispatch = mock(() => ({ code: 0 }));
      const fetchAssignee = mock(() => ({ known: true, assignee: HUMAN }));
      sweepMissingTriage({
        orchDir,
        dispatch,
        botUserIds: new Set([BOT]),
        fetchAssignee,
        readMaxParallelFn: () => 5,
        liveBackgroundCount: () => 0,
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(fetchAssignee).toHaveBeenCalledWith("ENG-SW1", expect.anything());
    } finally {
      rmSync(orchDir, { recursive: true, force: true });
    }
  });
});

// ── CTL-862: HRW ownership filter + claim-on-dispatch (monitor dispatchTriage) ──
//
// Mirrors scheduler.test.mjs:7092-7206 but drives dispatchTriage through the
// exported handleStateChangedEvent (→Triage branch) and sweepMissingTriage,
// since dispatchTriage is not exported. The entry phase asserted in the claim
// payload is "triage" (not "research" as in the scheduler). Safe-by-construction:
// a single-host roster is an exact no-op until a 2nd host joins.
describe("CTL-862 — HRW ownership + claim-on-dispatch (monitor dispatchTriage)", () => {
  const ROSTER = ["mini", "mac-studio"];
  const TICKET = "ENG-1";
  const OWNER = ownerForTicket(TICKET, ROSTER);
  const OTHER = ROSTER.find((h) => h !== OWNER);

  const triageEvent = () => ({
    event: "linear.issue.state_changed",
    detail: { ticket: TICKET, teamKey: "ENG", toState: "Triage" },
  });

  const recordClaim = (verdict) => {
    const calls = [];
    const fn = (arg) => { calls.push(arg); return verdict; };
    fn.calls = calls;
    return fn;
  };

  const fakeOrchDir = "/fake-orch-862";

  test("single-host roster is an exact no-op: claim NEVER attempted, dispatch proceeds", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const claimDispatch = recordClaim({ won: false, generation: null });
    handleStateChangedEvent(triageEvent(), {
      dispatch,
      orchDir: fakeOrchDir,
      hosts: ["solo"],
      hostName: "solo",
      claimDispatch,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
    });
    expect(claimDispatch.calls).toHaveLength(0);
    expect(dispatch).toHaveBeenCalledWith({ orchDir: fakeOrchDir, ticket: TICKET, phase: "triage" });
  });

  test("CTL-1057: single-host roster with a NON-matching hostName is still a no-op — dispatch proceeds, no claim", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const claimDispatch = recordClaim({ won: false, generation: null });
    handleStateChangedEvent(triageEvent(), {
      dispatch,
      orchDir: fakeOrchDir,
      hosts: ["mini"],                   // roster entry...
      hostName: "RyansMini250233.rozich", // ...does NOT match resolved host
      claimDispatch,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
    });
    // With the ungated filter this fails: dispatch is skipped because
    // ownedBy("ENG-1", ["mini"], "RyansMini250233.rozich") === false.
    expect(dispatch).toHaveBeenCalledWith({ orchDir: fakeOrchDir, ticket: TICKET, phase: "triage" });
    expect(claimDispatch.calls).toHaveLength(0); // single-host never touches Linear
  });

  test("multi-host: a ticket OWNED by this host is dispatched + claim ran with phase 'triage'", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const claimDispatch = recordClaim({ won: true, generation: 1 });
    handleStateChangedEvent(triageEvent(), {
      dispatch,
      orchDir: fakeOrchDir,
      hosts: ROSTER,
      hostName: OWNER,
      claimDispatch,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(claimDispatch.calls).toHaveLength(1);
    expect(claimDispatch.calls[0]).toEqual({ ticket: TICKET, hostName: OWNER, phase: "triage" });
  });

  test("multi-host: a ticket owned by ANOTHER host is filtered — no claim, no dispatch", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const claimDispatch = recordClaim({ won: true, generation: 1 });
    handleStateChangedEvent(triageEvent(), {
      dispatch,
      orchDir: fakeOrchDir,
      hosts: ROSTER,
      hostName: OTHER,
      claimDispatch,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(claimDispatch.calls).toHaveLength(0);
  });

  test("multi-host: a LOST claim defers — no dispatch, no triage status write", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const claimDispatch = recordClaim({ won: false, generation: 2 });
    const applyTriageStatus = mock(() => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }));
    handleStateChangedEvent(triageEvent(), {
      dispatch,
      orchDir: fakeOrchDir,
      hosts: ROSTER,
      hostName: OWNER,
      claimDispatch,
      applyTriageStatus,
      appendEvent: () => {},
    });
    expect(claimDispatch.calls).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(applyTriageStatus).not.toHaveBeenCalled();
  });

  test("sweepMissingTriage path: OWNED ticket is dispatched + claim ran with phase 'triage'", () => {
    enroll("ENG", { status: "Ready" });
    setProjectEligible("ENG", [{ identifier: TICKET, state: "Todo", priority: 1, project: null }]);
    const dispatch = mock(() => ({ code: 0 }));
    const claimDispatch = recordClaim({ won: true, generation: 1 });
    sweepMissingTriage({
      orchDir: fakeOrchDir,
      dispatch,
      hosts: ROSTER,
      hostName: OWNER,
      claimDispatch,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
      readMaxParallelFn: () => 5,
      liveBackgroundCount: () => 0,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(claimDispatch.calls).toHaveLength(1);
    expect(claimDispatch.calls[0]).toMatchObject({ ticket: TICKET, phase: "triage" });
  });
});

// ── CTL-1028: triage forwards + persists cluster generation (monitor dispatchTriage) ──
//
// Mirrors the CTL-864 scheduler tests but drives dispatchTriage through the
// exported handleStateChangedEvent (→Triage branch), since dispatchTriage is not
// exported. The CTL-862 single-host exact-args assertion doubles as a regression
// guard that single-host remains a true no-op after this change.
describe("CTL-1028 — triage forwards + persists cluster generation (monitor dispatchTriage)", () => {
  const ROSTER = ["mini", "mac-studio"];
  const TICKET = "ENG-1";
  const OWNER = ownerForTicket(TICKET, ROSTER);

  const triageEvent = () => ({
    event: "linear.issue.state_changed",
    detail: { ticket: TICKET, teamKey: "ENG", toState: "Triage" },
  });

  const recordClaim = (verdict) => {
    const calls = [];
    const fn = (arg) => { calls.push(arg); return verdict; };
    fn.calls = calls;
    return fn;
  };

  test("multi-host won claim forwards claim.generation as clusterGeneration", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const claimDispatch = recordClaim({ won: true, generation: 7 });
    handleStateChangedEvent(triageEvent(), {
      dispatch,
      orchDir: "/fake-orch-1028",
      hosts: ROSTER,
      hostName: OWNER,
      claimDispatch,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
    });
    expect(dispatch.mock.calls[0][0].clusterGeneration).toBe(7);
  });

  test("single-host passes NO clusterGeneration key (exact no-op)", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const claimDispatch = recordClaim({ won: false, generation: null });
    handleStateChangedEvent(triageEvent(), {
      dispatch,
      orchDir: "/fake-orch-1028",
      hosts: ["solo"],
      hostName: "solo",
      claimDispatch,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
    });
    expect("clusterGeneration" in dispatch.mock.calls[0][0]).toBe(false);
  });

  test("won multi-host claim persists cluster-generation.json", () => {
    enroll("ENG", { status: "Ready" });
    const orchDir = mkdtempSync(join(tmpdir(), "ctl-1028-persist-"));
    try {
      // dispatch stub creates the worker dir (mirrors dispatchCreatesDir in scheduler.test.mjs)
      // so writeClusterGeneration's tmp+rename succeeds.
      const dispatch = mock((args) => {
        mkdirSync(join(orchDir, "workers", args.ticket), { recursive: true });
        return { code: 0 };
      });
      const claimDispatch = recordClaim({ won: true, generation: 7 });
      handleStateChangedEvent(triageEvent(), {
        dispatch,
        orchDir,
        hosts: ROSTER,
        hostName: OWNER,
        claimDispatch,
        applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
        appendEvent: () => {},
      });
      expect(readClusterGeneration(orchDir, TICKET)).toBe(7);
    } finally {
      rmSync(orchDir, { recursive: true, force: true });
    }
  });
});

describe("dispatchTriage — drain gate (CTL-1095)", () => {
  const orchDir = "/orch-1095-drain";

  function toTriageEvent(ticket) {
    return {
      event: "linear.issue.state_changed",
      detail: { ticket, teamKey: "ENG", toState: "Triage" },
    };
  }

  test("dispatchTriage returns false and does not dispatch while draining", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    handleStateChangedEvent(toTriageEvent("ENG-DR1"), {
      dispatch,
      orchDir,
      isDraining: () => true,
      triageBudget: { remaining: 5 },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("dispatchTriage dispatches normally when not draining (regression guard)", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    handleStateChangedEvent(toTriageEvent("ENG-DR2"), {
      dispatch,
      orchDir,
      isDraining: () => false,
      triageBudget: { remaining: 5 },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

// ── CTL-1091: liveness-filtered HRW ownership (monitor triage gate) ──
//
// Mirrors the CTL-850/CTL-1091 scheduler pattern but drives dispatchTriage
// via handleStateChangedEvent (→Triage / →Ready branches). ENG-1 HRW-hashes
// to "laptop" under ["mini","laptop"]. When laptop is shed (liveHosts=["mini"]),
// mini dispatches triage for ENG-1 — the new-work entry never starves.
describe("CTL-1091 — liveness-filtered triage gate (monitor)", () => {
  const ROSTER = ["mini", "laptop"];
  // ENG-1 hashes to "laptop" under this roster (verified with ownerForTicket).
  const LAPTOP_TICKET = ownerForTicket("ENG-1", ROSTER) === "laptop" ? "ENG-1" : "ENG-2";

  const triageEvent = () => ({
    event: "linear.issue.state_changed",
    detail: { ticket: LAPTOP_TICKET, teamKey: "ENG", toState: "Triage" },
  });

  const recordClaim = (verdict) => {
    const calls = [];
    const fn = (arg) => { calls.push(arg); return verdict; };
    fn.calls = calls;
    return fn;
  };

  const fakeOrchDir = "/fake-orch-1091";

  test("laptop shed (liveHosts=['mini']) → mini dispatches triage for laptop-hashing ticket", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const claimDispatch = recordClaim({ won: true, generation: 1 });
    handleStateChangedEvent(triageEvent(), {
      dispatch,
      orchDir: fakeOrchDir,
      hosts: ROSTER,
      hostName: "mini",
      resolveLiveRoster: () => ["mini"], // laptop shed
      claimDispatch,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test("both live (liveHosts=ROSTER) → laptop-hashing ticket skipped on mini", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    const claimDispatch = recordClaim({ won: true, generation: 1 });
    handleStateChangedEvent(triageEvent(), {
      dispatch,
      orchDir: fakeOrchDir,
      hosts: ROSTER,
      hostName: "mini",
      resolveLiveRoster: () => ROSTER, // both live
      claimDispatch,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(claimDispatch.calls).toHaveLength(0);
  });

  test("single-host roster: resolveLiveRoster not consulted, dispatch proceeds", () => {
    enroll("ENG", { status: "Ready" });
    const dispatch = mock(() => ({ code: 0 }));
    let resolverCalled = false;
    handleStateChangedEvent(triageEvent(), {
      dispatch,
      orchDir: fakeOrchDir,
      hosts: ["mini"],
      hostName: "mini",
      resolveLiveRoster: () => { resolverCalled = true; return ["mini"]; },
      claimDispatch: recordClaim({ won: false, generation: null }),
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: null, to_state: null, reason: null }),
      appendEvent: () => {},
    });
    expect(resolverCalled).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
