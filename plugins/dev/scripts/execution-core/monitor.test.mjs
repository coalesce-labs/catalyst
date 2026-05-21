// Unit tests for the execution-core monitor core (CTL-535 Phase 4).
// Run: cd plugins/dev/scripts/execution-core && bun test monitor.test.mjs

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
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
let enrollmentDir;
let prevCatalystDir;
const enrolledKeys = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-mon-"));
  process.env.CATALYST_DIR = catalystDir;
  enrollmentDir = join(catalystDir, "execution-core", "projects");
  mkdirSync(enrollmentDir, { recursive: true });
  __resetForTests();
  enrolledKeys.clear();
});

afterEach(() => {
  stopMonitor();
  __resetForTests();
  for (const k of enrolledKeys) dropProject(k);
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

// Create a stub repo + enrollment record. `eligibleQuery` null => enrolled
// but unconfigured. Returns the repoRoot.
function enroll(projectKey, eligibleQuery) {
  const repoRoot = mkdtempSync(join(catalystDir, `repo-${projectKey}-`));
  mkdirSync(join(repoRoot, ".catalyst"), { recursive: true });
  const catalyst = { linear: { teamKey: eligibleQuery?.team ?? "T" } };
  if (eligibleQuery) {
    catalyst.orchestration = { executionCore: { eligibleQuery } };
  }
  writeFileSync(
    join(repoRoot, ".catalyst", "config.json"),
    JSON.stringify({ catalyst }),
  );
  writeFileSync(
    join(enrollmentDir, `${projectKey}.json`),
    JSON.stringify({ projectKey, repoRoot }),
  );
  enrolledKeys.add(projectKey);
  return repoRoot;
}

function unenroll(projectKey) {
  unlinkSync(join(enrollmentDir, `${projectKey}.json`));
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
    const repoRoot = enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1"), node("ENG-2")] });
    reconcileProject("alpha", repoRoot, { exec });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-1", "ENG-2"]);
  });

  test("preserves the prior eligible set when runEligibleQuery throws", () => {
    const repoRoot = enroll("alpha", { team: "ENG", status: "Todo" });
    setProjectEligible("alpha", [node("ENG-PRIOR")], { source: "reconcile", query: {} });
    const throwingExec = () => ({ code: 1, stdout: "", stderr: "linearis down" });
    reconcileProject("alpha", repoRoot, { exec: throwingExec });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-PRIOR"]);
  });

  test("skips (no crash) a project whose loadProjectConfig returns null", () => {
    const repoRoot = enroll("alpha", null); // enrolled, no executionCore config
    const exec = execReturning({});
    expect(() => reconcileProject("alpha", repoRoot, { exec })).not.toThrow();
    expect(exec.calls).toBe(0);
  });

  test("does not crash the daemon when the projection write fails", () => {
    const repoRoot = enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1")] });
    // Make the projection path a non-empty directory so renameSync fails,
    // simulating a disk/permission fault during the projection write. The
    // throw must be swallowed: reconcileProject runs inside the setInterval
    // reconcile timer, so an uncaught error would kill the monitor process.
    const projDir = join(catalystDir, "execution-core", "eligible", "alpha.json");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "sentinel"), "x");
    expect(() => reconcileProject("alpha", repoRoot, { exec })).not.toThrow();
    rmSync(projDir, { recursive: true, force: true });
  });
});

describe("handleStateChangedEvent", () => {
  test("an event whose toState != eligible status fast-path-removes the ticket", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    setProjectEligible("alpha", [node("ENG-1"), node("ENG-2")], {
      source: "reconcile",
      query: { team: "ENG", status: "Todo" },
    });
    handleStateChangedEvent({
      event: "linear.issue.state_changed",
      detail: { ticket: "ENG-1", teamKey: "ENG", toState: "In Progress" },
    });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-2"]);
  });

  test("an event whose toState == eligible status schedules a debounced reconcile (no immediate poll)", async () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
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
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-9"]);
  });

  test("multiple events for one project within the debounce window coalesce into one reconcile", async () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
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

  test("an event whose teamKey matches no enrolled project's query team is ignored", async () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    setProjectEligible("alpha", [node("ENG-1")], {
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
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-1"]);
  });
});

// --- CTL-565 Phase 1: three-way toState split + triage one-shot dispatch -----

describe("handleStateChangedEvent — CTL-565 two-state trigger", () => {
  const orchDir = "/orch";

  test("toState === triageStatus one-shot-dispatches the triage phase agent", () => {
    enroll("alpha", { team: "ENG", status: "Ready" }); // triageStatus defaults to "Triage"
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

  test("toState === eligible status (Ready) schedules a reconcile, never a triage dispatch", async () => {
    enroll("alpha", { team: "ENG", status: "Ready" });
    const exec = execReturning({ ENG: [node("ENG-9")] });
    const dispatch = mock(() => ({ code: 0 }));
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-9", teamKey: "ENG", toState: "Ready" },
      },
      { exec, dispatch, orchDir, debounceMs: 30 },
    );
    expect(dispatch).not.toHaveBeenCalled();
    await sleep(70);
    expect(exec.calls).toBe(1); // the debounced reconcile ran
  });

  test("toState that is neither Triage nor Ready fast-path-removes the ticket", () => {
    enroll("alpha", { team: "ENG", status: "Ready" });
    setProjectEligible("alpha", [node("ENG-1"), node("ENG-2")], {
      source: "reconcile",
      query: { team: "ENG", status: "Ready" },
    });
    handleStateChangedEvent({
      event: "linear.issue.state_changed",
      detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Backlog" },
    });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-2"]);
  });

  test("a triage dispatch failure is logged and never throws", () => {
    enroll("alpha", { team: "ENG", status: "Ready" });
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
    enroll("alpha", { team: "ENG", status: "Ready" });
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
});

describe("lifecycle", () => {
  test("startMonitor runs an immediate reconcileAll", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1")] });
    startMonitor({ exec, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-1"]);
  });

  test("reconcileAll re-globs the enrollment dir — a new record is picked up, a removed one is dropped", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1")], PLAT: [node("PLAT-1")] });
    reconcileAll({ exec });
    expect(getEligibleSet("alpha")).toHaveLength(1);

    enroll("beta", { team: "PLAT", status: "Todo" });
    reconcileAll({ exec });
    expect(getEligibleSet("beta").map((t) => t.identifier)).toEqual(["PLAT-1"]);

    unenroll("alpha");
    reconcileAll({ exec });
    expect(getEligibleSet("alpha")).toEqual([]); // dropProject'd
  });

  test("stopMonitor clears pending debounce timers (a queued reconcile never fires)", async () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
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
    enroll("alpha", { team: "ENG", status: "Todo" });
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
    // alpha holds ENG-1 + ENG-2; an event in the downtime gap moved ENG-1 OUT
    // of Todo. resumeFromCursor:true must drain that gap on startup and remove
    // ENG-1 — proving the durable cursor, not a re-seed, drove the resume.
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1"), node("ENG-2")] });
    // Pre-write a downtime-gap event and pin the cursor at offset 0.
    appendEventLog(
      `${JSON.stringify({
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-1", teamKey: "ENG", toState: "In Progress" },
      })}\n`,
    );
    saveCursor({ logPath: eventLogPath(), byteOffset: 0 });
    startMonitor({ exec, resumeFromCursor: true, reconcileIntervalMs: 60_000 });
    // startup reconcileAll seeded {ENG-1, ENG-2}; the gap drain removed ENG-1.
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-2"]);
  });

  test("resumeFromCursor defaults to true (the gap is drained without the flag)", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1"), node("ENG-2")] });
    appendEventLog(
      `${JSON.stringify({
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-1", teamKey: "ENG", toState: "Done" },
      })}\n`,
    );
    saveCursor({ logPath: eventLogPath(), byteOffset: 0 });
    startMonitor({ exec, reconcileIntervalMs: 60_000 }); // no resumeFromCursor
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-2"]);
  });
});
