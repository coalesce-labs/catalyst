// Unit tests for the execution-core monitor core (CTL-535 Phase 4, CTL-582).
// Run: cd plugins/dev/scripts/execution-core && bun test monitor.test.mjs
//
// CTL-582: the monitor discovers projects from the central registry.json
// (registry.mjs) and keys the eligible projection on Linear team — the
// per-repo enrollment records are gone.

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStateChangedEvent,
  reconcileProject,
  reconcileAll,
  handleStateChangedEvent,
  startMonitor,
  stopMonitor,
  seedTailerFromCursor,
  readNewEvents,
  __tailerOffset,
  __resetForTests,
} from "./monitor.mjs";
import { setProjectEligible, getEligibleSet, dropProject } from "./eligible-set.mjs";
import { loadCursor, saveCursor } from "./event-cursor.mjs";

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
    JSON.stringify({ projects: registryEntries }, null, 2),
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
    expect(parsed).toEqual({ identifier: "ENG-1", teamKey: "ENG", toState: "In Progress" });
  });

  test("reads event.event + event.detail (legacy flat shape)", () => {
    const parsed = parseStateChangedEvent({
      event: "linear.issue.state_changed",
      detail: { ticket: "ENG-2", teamKey: "ENG", toState: "Done" },
    });
    expect(parsed).toEqual({ identifier: "ENG-2", teamKey: "ENG", toState: "Done" });
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
      }),
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

describe("handleStateChangedEvent", () => {
  // CTL-584: the pre-CTL-565 "toState != eligible status → fast-path-remove"
  // case is now covered by the parameterized DRAG_OUT_STATES test in the
  // CTL-565 two-state-trigger block below (Backlog/Canceled/Duplicate). The
  // old single-case version is dropped as redundant — its example toState
  // ("In Progress") was a pipeline state under the new model, not a leave-path
  // trigger.

  test("an event whose toState == eligible status schedules a debounced reconcile (no immediate poll)", async () => {
    enroll("ENG", { status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-9")] });
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-9", teamKey: "ENG", toState: "Todo" },
      },
      { exec, debounceMs: 30 },
    );
    expect(exec.calls).toBe(0); // not polled synchronously
    await sleep(70);
    expect(exec.calls).toBe(1);
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-9"]);
  });

  test("multiple events for one project within the debounce window coalesce into one reconcile", async () => {
    enroll("ENG", { status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-9")] });
    for (const ticket of ["ENG-7", "ENG-8", "ENG-9"]) {
      handleStateChangedEvent(
        {
          event: "linear.issue.state_changed",
          detail: { ticket, teamKey: "ENG", toState: "Todo" },
        },
        { exec, debounceMs: 30 },
      );
    }
    await sleep(80);
    expect(exec.calls).toBe(1);
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
      { exec, debounceMs: 30 },
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
      { dispatch, orchDir },
    );
    expect(dispatch).toHaveBeenCalledWith({ orchDir, ticket: "ENG-1", phase: "triage" });
  });

  test("→Ready with an existing triage.json reconciles, never a triage dispatch", async () => {
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
      { exec, dispatch, orchDir: realOrchDir, debounceMs: 30 },
    );
    expect(dispatch).not.toHaveBeenCalled();
    await sleep(70);
    expect(exec.calls).toBe(1); // the debounced reconcile ran
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
      { exec, dispatch, orchDir: realOrchDir, debounceMs: 30 },
    );
    expect(dispatch).toHaveBeenCalledWith({
      orchDir: realOrchDir,
      ticket: "ENG-9",
      phase: "triage",
    });
    expect(exec.calls).toBe(0); // did NOT reconcile (no new-work pull → no storm)
  });

  test("CTL-625: →Ready with no orchDir wired falls back to reconcile, never throws", async () => {
    enroll("ENG", { status: "Ready" });
    const exec = execReturning({ ENG: [node("ENG-9")] });
    const dispatch = mock(() => ({ code: 0 }));
    expect(() =>
      handleStateChangedEvent(
        {
          event: "linear.issue.state_changed",
          detail: { ticket: "ENG-9", teamKey: "ENG", toState: "Ready" },
        },
        { exec, dispatch, debounceMs: 30 }, // no orchDir
      ),
    ).not.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    await sleep(70);
    expect(exec.calls).toBe(1);
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
    },
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
        { dispatch, orchDir },
      ),
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
        { dispatch },
      ),
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
        { orchDir, abortWorker },
      );
      expect(abortWorker).toHaveBeenCalledWith("/orch", "ENG-1", {
        repoRoot: expect.any(String),
      });
    },
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
        { abortWorker },
      ),
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
        { orchDir, abortWorker, dispatch },
      );
      expect(abortWorker).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-1", "ENG-2"]);
    },
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
      { orchDir, abortWorker },
    );
    expect(abortWorker).not.toHaveBeenCalled();
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-1"]);
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
      { exec, debounceMs: 40 },
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
      })}\n`,
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
      })}\n`,
    );
    saveCursor({ logPath: eventLogPath(), byteOffset: 0 });
    startMonitor({ exec, reconcileIntervalMs: 60_000 }); // no resumeFromCursor
    expect(getEligibleSet("ENG").map((t) => t.identifier)).toEqual(["ENG-2"]);
  });
});
