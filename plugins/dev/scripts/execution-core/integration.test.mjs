// End-to-end integration tests for the execution-core Todo-state monitor
// (CTL-535 Phase 5). Each test builds a temp CATALYST_DIR with a stubbed
// enrollment dir + repo config and a mocked linearis exec — nothing touches
// the real Linear API or the developer's ~/catalyst. The four AC* tests map
// 1:1 onto the ticket's acceptance criteria.
// Run: cd plugins/dev/scripts/execution-core && bun test integration.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startMonitor,
  stopMonitor,
  reconcileAll,
  handleStateChangedEvent,
  readNewEvents,
  __resetForTests,
} from "./monitor.mjs";
import { getEligibleSet, dropProject } from "./eligible-set.mjs";
import {
  startScheduler,
  stopScheduler,
  __resetForTests as __resetScheduler,
} from "./scheduler.mjs";
import { recoverStartup, defaultStatJob } from "./recovery.mjs";
import { loadCursor } from "./event-cursor.mjs";

let catalystDir;
let enrollmentDir;
let prevCatalystDir;
let jobsRoot;
let prevJobsRoot;
const enrolledKeys = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-int-"));
  process.env.CATALYST_DIR = catalystDir;
  enrollmentDir = join(catalystDir, "execution-core", "projects");
  mkdirSync(enrollmentDir, { recursive: true });
  // A fake ~/.claude/jobs root so the worker-liveness scan never touches real
  // Claude state (the env var orchestrate-healthcheck + getJobsRoot share).
  prevJobsRoot = process.env.CATALYST_HEALTHCHECK_JOBS_ROOT;
  jobsRoot = mkdtempSync(join(tmpdir(), "exec-core-int-jobs-"));
  process.env.CATALYST_HEALTHCHECK_JOBS_ROOT = jobsRoot;
  __resetForTests();
  __resetScheduler();
  enrolledKeys.clear();
});

afterEach(() => {
  stopMonitor();
  stopScheduler();
  __resetForTests();
  __resetScheduler();
  for (const k of enrolledKeys) dropProject(k);
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  if (prevJobsRoot === undefined) delete process.env.CATALYST_HEALTHCHECK_JOBS_ROOT;
  else process.env.CATALYST_HEALTHCHECK_JOBS_ROOT = prevJobsRoot;
  rmSync(jobsRoot, { recursive: true, force: true });
  rmSync(catalystDir, { recursive: true, force: true });
});

function enroll(projectKey, eligibleQuery) {
  const repoRoot = mkdtempSync(join(catalystDir, `repo-${projectKey}-`));
  mkdirSync(join(repoRoot, ".catalyst"), { recursive: true });
  const catalyst = { linear: { teamKey: eligibleQuery?.team ?? "T" } };
  if (eligibleQuery) catalyst.orchestration = { executionCore: { eligibleQuery } };
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

const node = (identifier, priority = 2) => ({
  identifier,
  state: { name: "Todo" },
  priority,
});

// Legacy flat state_changed event — the tailer feeds these to the handler.
const evt = (ticket, teamKey, toState) => ({
  event: "linear.issue.state_changed",
  detail: { ticket, teamKey, toState },
});

// A mocked linearis exec keyed on the --team flag, reading a live `nodesByTeam`
// object so a test can change what linearis "reports" between calls.
function mockExec(nodesByTeam) {
  return (_cmd, args) => {
    const team = args[args.indexOf("--team") + 1];
    return {
      code: 0,
      stdout: JSON.stringify({ nodes: nodesByTeam[team] ?? [] }),
      stderr: "",
    };
  };
}

describe("execution-core integration — acceptance criteria", () => {
  test("AC1 — a state_changed event INTO the eligible state triggers a reconcile that adds the ticket", async () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const reported = { ENG: [] };
    const exec = mockExec(reported);
    startMonitor({ exec, debounceMs: 25, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("alpha")).toEqual([]); // startup reconcile: empty

    reported.ENG = [node("ENG-9")]; // linearis now reports ENG-9 as Todo
    handleStateChangedEvent(evt("ENG-9", "ENG", "Todo"), { exec, debounceMs: 25 });
    await sleep(70);
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-9"]);
  });

  test("AC1b — a state_changed event OUT of the eligible state removes the ticket immediately", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = mockExec({ ENG: [node("ENG-1"), node("ENG-2")] });
    startMonitor({ exec, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("alpha")).toHaveLength(2);

    handleStateChangedEvent(evt("ENG-1", "ENG", "In Progress"));
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-2"]);
  });

  test("AC2 — the reconcile poll catches a missed webhook (no event written, the poll still converges)", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const reported = { ENG: [] };
    const exec = mockExec(reported);
    startMonitor({ exec, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("alpha")).toEqual([]);

    reported.ENG = [node("ENG-5")]; // webhook missed — linearis truth changed
    reconcileAll({ exec }); // the periodic backstop tick
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-5"]);
  });

  test("AC3 — poll-only mode: with no event log file at all, startMonitor + the reconcile poll produce a correct set", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = mockExec({ ENG: [node("ENG-1")] });
    // no events/ directory, no log file exists
    expect(() => startMonitor({ exec, reconcileIntervalMs: 60_000 })).not.toThrow();
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-1"]);
  });

  test("AC4 — the configurable query is honored: a priority floor narrows which tickets land in the set", () => {
    enroll("alpha", { team: "ENG", status: "Todo", priority: 2 });
    const exec = mockExec({
      ENG: [node("ENG-1", 1), node("ENG-2", 2), node("ENG-3", 3), node("ENG-0", 0)],
    });
    startMonitor({ exec, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-1", "ENG-2"]);
  });
});

describe("execution-core integration — rebuild + isolation", () => {
  test("the startup reconcile rebuilds the eligible set from scratch (no persisted state needed)", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = mockExec({ ENG: [node("ENG-1")] });
    startMonitor({ exec, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-1"]);
    expect(
      existsSync(join(catalystDir, "execution-core", "eligible", "alpha.json")),
    ).toBe(true);
  });

  test("a second enrolled project is served independently (per-project isolation)", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    enroll("beta", { team: "PLAT", status: "Todo" });
    const exec = mockExec({
      ENG: [node("ENG-1")],
      PLAT: [node("PLAT-1"), node("PLAT-2")],
    });
    startMonitor({ exec, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-1"]);
    expect(getEligibleSet("beta").map((t) => t.identifier)).toEqual([
      "PLAT-1",
      "PLAT-2",
    ]);
  });
});

// --- AC5: crash recovery — kill mid-run + restart (CTL-539) ---------------

describe("execution-core integration — crash recovery (CTL-539)", () => {
  // appendEventLog — append a line to the current UTC month's event log.
  function eventLogPath() {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    return join(catalystDir, "events", `${ym}.jsonl`);
  }
  function appendEventLog(line) {
    mkdirSync(join(catalystDir, "events"), { recursive: true });
    appendFileSync(eventLogPath(), line);
  }
  // stateChangedLine — a legacy flat state_changed event as a log line.
  const stateChangedLine = (ticket, teamKey, toState) =>
    `${JSON.stringify({
      event: "linear.issue.state_changed",
      detail: { ticket, teamKey, toState },
    })}\n`;

  // writeWorkerSignal — a nested phase-agent signal: workers/<T>/phase-<p>.json.
  function writeWorkerSignal(orchDir, ticket, phase, body) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `phase-${phase}.json`),
      JSON.stringify({ ticket, phase, ...body }),
    );
  }
  // makeJobDir — a fake claude --bg job state dir under the fake jobs root.
  function makeJobDir(bgJobId) {
    const dir = join(jobsRoot, bgJobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ state: "running" }));
  }

  test("AC5 — kill mid-run + restart: resumes with no double-dispatch and no lost workers", () => {
    // ── Setup ──
    const orchDir = mkdtempSync(join(catalystDir, "orch-"));
    mkdirSync(join(orchDir, "workers"), { recursive: true });
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    enroll("alpha", { team: "ENG", status: "Todo" });

    const reported = { ENG: [node("ENG-NEW")] };
    const exec = mockExec(reported);

    // A counting dispatch mock spanning the WHOLE kill/restart cycle. It also
    // writes the dispatched signal the real phase-agent-dispatch would write
    // (signal-first), so the post-restart tick sees the started ticket.
    const dispatchCalls = [];
    const dispatch = (args) => {
      dispatchCalls.push(`${args.ticket}:${args.phase}`);
      writeWorkerSignal(args.orchDir, args.ticket, args.phase, {
        status: "dispatched",
        bg_job_id: `job-${args.ticket}`,
      });
      return { code: 0, stdout: "", stderr: "" };
    };
    const readEligible = () => getEligibleSet("alpha");

    // Pre-create the event log so later appends are in-place changes.
    appendEventLog("");

    // ── Run — compose the real monitor + scheduler ──
    startMonitor({ exec, resumeFromCursor: true, reconcileIntervalMs: 60_000 });
    startScheduler({
      orchDir,
      dispatch,
      readEligible,
      tickIntervalMs: 60_000,
      debounceMs: 5,
    });
    // startScheduler ran one tick → ENG-NEW (the eligible ready ticket) was
    // dispatched into a free slot at the research entry phase (CTL-565: a Ready
    // ticket is already triaged, so new work enters at research, not triage).
    expect(dispatchCalls).toContain("ENG-NEW:research");

    // An event lands; drain the tailer deterministically (fs.watch is flaky).
    appendEventLog(stateChangedLine("ENG-NEW", "ENG", "Todo"));
    readNewEvents();
    // The cursor now tracks the log size — a non-zero durable offset.
    const preKillSize = statSync(eventLogPath()).size;
    expect(loadCursor()).toEqual({
      logPath: eventLogPath(),
      byteOffset: preKillSize,
    });
    expect(preKillSize).toBeGreaterThan(0);

    // ── Seed in-flight workers ── one with a live bg job dir, one without.
    writeWorkerSignal(orchDir, "CTL-A", "research", {
      status: "running",
      bg_job_id: "job-a",
    });
    makeJobDir("job-a"); // CTL-A's process is alive → must classify 'running'
    writeWorkerSignal(orchDir, "CTL-B", "plan", {
      status: "running",
      bg_job_id: "job-b",
    });
    // no job dir for job-b → CTL-B is a lost worker → must classify 'dead'

    // ── Kill ── the daemon dies mid-run.
    stopMonitor();
    stopScheduler();

    // ── Downtime ── an event arrives while the daemon is down.
    appendEventLog(stateChangedLine("ENG-NEW", "ENG", "In Progress"));

    // ── Restart — recoverStartup reconstructs everything ──
    const report = recoverStartup({ orchDir, exec, statJob: defaultStatJob });

    // The cursor resumed from the pre-kill saved offset — history is not
    // reprocessed from 0, and the downtime gap is not skipped.
    expect(report.cursor.resumed).toBe(true);
    expect(report.cursor.byteOffset).toBe(preKillSize);

    // No lost workers — every in-flight worker is accounted for.
    expect(report.workers.running.map((w) => w.ticket)).toContain("CTL-A");
    expect(report.workers.dead.map((w) => w.ticket)).toContain("CTL-B");
    const allWorkers = [
      ...report.workers.running,
      ...report.workers.dead,
      ...report.workers.terminal,
      ...report.workers.unknown,
    ].map((w) => w.ticket);
    expect(allWorkers).toContain("CTL-A");
    expect(allWorkers).toContain("CTL-B");
    expect(allWorkers).toContain("ENG-NEW"); // the dispatched ticket survives

    // ── Re-run — restart the composed daemon; it drains the downtime gap ──
    startMonitor({ exec, resumeFromCursor: true, reconcileIntervalMs: 60_000 });
    startScheduler({
      orchDir,
      dispatch,
      readEligible,
      tickIntervalMs: 60_000,
      debounceMs: 5,
    });

    // ── Assert no double-dispatch ── across the WHOLE kill/restart cycle,
    // every {ticket,phase} key was dispatched exactly once.
    const byKey = new Map();
    for (const k of dispatchCalls) byKey.set(k, (byKey.get(k) ?? 0) + 1);
    const duplicates = [...byKey.entries()].filter(([, n]) => n > 1);
    expect(duplicates).toEqual([]);
    // ENG-NEW:research in particular is never re-dispatched after the restart.
    expect(byKey.get("ENG-NEW:research")).toBe(1);

    rmSync(orchDir, { recursive: true, force: true });
  });
});
