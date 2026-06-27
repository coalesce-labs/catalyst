// Unit + integration tests for execution-core crash recovery (CTL-539).
// Run: cd plugins/dev/scripts/execution-core && bun test recovery.test.mjs
//
// Phase 2 covers classifyWorker + reconstructWorkerState; Phase 3 extends
// this same file with recoverStartup composition tests.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyWorker,
  jobLifecycle,
  reconstructWorkerState,
  defaultStatJob,
  recoverStartup,
  reclaimDeadWorkIfPossible,
  defaultReviveDispatch,
  resolvePhaseSessionId,
  defaultKillBgJob,
  defaultAppendReviveEvent,
  defaultAppendReclaimEvent,
  defaultPostReclaimMirror,
  defaultAppendDispatchRequestedEvent,
  defaultAppendDispatchLaunchedEvent,
  defaultAppendYieldFileSkipEvent,
  defaultAppendParallelismSampledEvent,
  defaultAppendParallelismAdjustedEvent,
  defaultAppendAutotuneGaugeEvent,
  defaultAppendPreemptedEvent,
  defaultAppendResumedAfterPreemptionEvent,
  defaultAppendRunawayEvent,
  defaultAppendOrphanDetectedEvent,
  defaultAppendHeldStoppedEvent,
  readBootEpoch,
  readDaemonEpoch,
  defaultReadRuntimeEpoch,
  detectColdStart,
  readBootSince,
  readExecCoreBootEpoch,
  clearProgressMarks,
  // CTL-1006
  defaultAppendBootResumePhaseRegressionEvent,
  // CTL-1044
  defaultAppendOperatorEvent,
} from "./recovery.mjs";
import { saveCursor } from "./event-cursor.mjs";
import { dropProject } from "./eligible-set.mjs";
import { existsSync, appendFileSync, chmodSync } from "node:fs";
import { WORK_DONE_PROBES } from "./work-done-probes.mjs";

let orchDir;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "exec-core-recovery-"));
});

afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

// --- helpers --------------------------------------------------------------

// Write a nested phase signal: workers/<T>/phase-<p>.json
function writeNested(ticket, phase, body) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `phase-${phase}.json`),
    JSON.stringify({ ticket, phase, ...body }),
  );
}

// Write a flat legacy signal: workers/<T>.json
function writeFlat(ticket, body) {
  const dir = join(orchDir, "workers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ticket}.json`), JSON.stringify({ ticket, ...body }));
}

// A bg-signal shape as readWorkerSignals produces it.
const bgSignal = (status, bgJobId) => ({
  ticket: "CTL-1",
  phase: "research",
  status,
  liveness: { kind: "bg", value: bgJobId },
  signalPath: "/x/phase-research.json",
});

// --- classifyWorker — pure given statJob ----------------------------------

describe("classifyWorker", () => {
  test("terminal status (done/failed/stalled/skipped/turn-cap-exhausted) → 'terminal' (CTL-830)", () => {
    for (const status of ["done", "failed", "stalled", "skipped", "turn-cap-exhausted"]) {
      expect(
        classifyWorker(bgSignal(status, "job-x"), { statJob: () => null }),
      ).toBe("terminal");
    }
  });

  test("turn-cap-exhausted IS terminal — CTL-748 removed turn caps (CTL-830)", () => {
    // Liveness is irrelevant: terminal short-circuits before the liveness probe.
    expect(
      classifyWorker(bgSignal("turn-cap-exhausted", "alive"), {
        statJob: () => ({ mtimeMs: Date.now() }),
      }),
    ).toBe("terminal");
    expect(
      classifyWorker(bgSignal("turn-cap-exhausted", "gone"), { statJob: () => null }),
    ).toBe("terminal");
  });

  test("non-terminal status + bg job dir present → 'running' (re-attached)", () => {
    expect(
      classifyWorker(bgSignal("running", "job-a"), {
        statJob: () => ({ exists: true, mtimeMs: 1, state: "running" }),
      }),
    ).toBe("running");
  });

  test("non-terminal status + bg job dir missing → 'dead' (lost worker)", () => {
    expect(
      classifyWorker(bgSignal("running", "job-b"), { statJob: () => null }),
    ).toBe("dead");
  });

  test("non-terminal status + bg_job_id null (orphan dispatch) → 'unknown'", () => {
    expect(
      classifyWorker(bgSignal("dispatched", null), { statJob: () => null }),
    ).toBe("unknown");
  });

  test("flat/legacy pid signal (liveness.kind !== 'bg') → 'unknown'", () => {
    const pidSignal = {
      ticket: "CTL-2",
      phase: 3,
      status: "implementing",
      liveness: { kind: "pid", value: 1234 },
      signalPath: "/x/CTL-2.json",
    };
    expect(classifyWorker(pidSignal, { statJob: () => null })).toBe("unknown");
  });

  test("statJob is never called for a terminal signal (short-circuit)", () => {
    let called = false;
    const statJob = () => {
      called = true;
      return null;
    };
    classifyWorker(bgSignal("done", "job-x"), { statJob });
    expect(called).toBe(false);
  });

  test("uses defaultStatJob when no statJob is injected (does not throw)", () => {
    // bg_job_id null short-circuits to 'unknown' without touching the fs.
    expect(() => classifyWorker(bgSignal("dispatched", null))).not.toThrow();
    expect(classifyWorker(bgSignal("dispatched", null))).toBe("unknown");
  });

  // CTL-736 Phase 2: classifyWorker now CONSULTS .state (it no longer treats
  // job-dir existence alone as "running"). A terminal job lifecycle is "dead"
  // even though the never-cleaned-up job dir still exists.
  test("CTL-736: terminal .state + dir present → 'dead' (job lifecycle, not dir existence)", () => {
    for (const state of ["stopped", "failed", "done", "blocked"]) {
      expect(
        classifyWorker(bgSignal("running", "job-term"), {
          statJob: () => ({ exists: true, mtimeMs: Date.now(), state }),
        }),
      ).toBe("dead");
    }
  });

  test("CTL-736: firstTerminalAt set + dir present → 'dead' even when .state name is unknown", () => {
    expect(
      classifyWorker(bgSignal("running", "job-ft"), {
        statJob: () => ({ exists: true, mtimeMs: Date.now(), state: "weird", firstTerminalAt: "2026-05-30T00:00:00Z" }),
      }),
    ).toBe("dead");
  });

  test("CTL-736: non-terminal 'working' .state + STALE mtime → 'running' (fan-out safe)", () => {
    // The CTL-662 killer: an in-process sub-agent fan-out keeps .state=working
    // while mtime ages. mtime must NOT be a death input.
    expect(
      classifyWorker(bgSignal("running", "job-fanout"), {
        statJob: () => ({ exists: true, mtimeMs: 0, state: "working" }),
      }),
    ).toBe("running");
  });
});

// --- jobLifecycle — authoritative state.json death verdict (CTL-736 Phase 2) ---

describe("jobLifecycle", () => {
  test("terminal .state ⇒ 'dead-terminal' (definitive, no grace/streak)", () => {
    for (const state of ["stopped", "failed", "done", "blocked"]) {
      expect(jobLifecycle("j", { statJob: () => ({ exists: true, state }) })).toBe("dead-terminal");
    }
  });

  test("firstTerminalAt set ⇒ 'dead-terminal' even if the .state name is unknown", () => {
    expect(
      jobLifecycle("j", { statJob: () => ({ exists: true, state: "x", firstTerminalAt: "2026-05-30T00:00:00Z" }) }),
    ).toBe("dead-terminal");
  });

  test("non-terminal 'working' .state ⇒ 'alive', INCLUDING during a fan-out (stale mtime)", () => {
    expect(jobLifecycle("j", { statJob: () => ({ exists: true, state: "working", mtimeMs: 0 }) })).toBe("alive");
  });

  test("a dir present with state:null (unreadable state.json) ⇒ 'alive' (presence proves liveness)", () => {
    expect(jobLifecycle("j", { statJob: () => ({ exists: true, state: null, mtimeMs: 1 }) })).toBe("alive");
  });

  test("missing job dir ⇒ 'dead-gone'", () => {
    expect(jobLifecycle("j", { statJob: () => null })).toBe("dead-gone");
  });
});

// --- reconstructWorkerState — scan + bucket --------------------------------

describe("reconstructWorkerState", () => {
  test("buckets workers into {running, dead, terminal, unknown} by classification", () => {
    writeNested("CTL-RUN", "research", { status: "running", bg_job_id: "job-run" });
    writeNested("CTL-DEAD", "plan", { status: "running", bg_job_id: "job-dead" });
    // phase-monitor-deploy.json is a signal-reader ARTIFACT, not a signal —
    // use a regular phase carrying a terminal status to exercise 'terminal'.
    writeNested("CTL-DONE", "implement", { status: "done", bg_job_id: "job-done" });
    writeNested("CTL-ORPH", "triage", { status: "dispatched", bg_job_id: null });

    const statJob = (id) => (id === "job-run" ? { exists: true, mtimeMs: 1 } : null);
    const buckets = reconstructWorkerState(orchDir, { statJob });

    expect(buckets.running.map((w) => w.ticket)).toEqual(["CTL-RUN"]);
    expect(buckets.dead.map((w) => w.ticket)).toEqual(["CTL-DEAD"]);
    expect(buckets.terminal.map((w) => w.ticket)).toEqual(["CTL-DONE"]);
    expect(buckets.unknown.map((w) => w.ticket)).toEqual(["CTL-ORPH"]);
  });

  test("empty / missing workers dir → all buckets empty (no throw)", () => {
    let buckets;
    expect(() => {
      buckets = reconstructWorkerState(orchDir, { statJob: () => null });
    }).not.toThrow();
    expect(buckets).toEqual({ running: [], dead: [], terminal: [], unknown: [] });
  });

  test("each bucketed worker carries ticket/phase/status/bgJobId/signalPath", () => {
    writeNested("CTL-RUN", "research", { status: "running", bg_job_id: "job-run" });
    const buckets = reconstructWorkerState(orchDir, {
      statJob: () => ({ exists: true, mtimeMs: 1 }),
    });
    const w = buckets.running[0];
    expect(w.ticket).toBe("CTL-RUN");
    expect(w.phase).toBe("research");
    expect(w.status).toBe("running");
    expect(w.bgJobId).toBe("job-run");
    expect(typeof w.signalPath).toBe("string");
  });

  test("one nested phase-agent signal per worker is classified once", () => {
    // readWorkerSignals returns the single active phase per worker dir.
    writeNested("CTL-A", "research", {
      status: "done",
      bg_job_id: "job-old",
      updatedAt: "2026-05-21T01:00:00Z",
    });
    writeNested("CTL-A", "implement", {
      status: "running",
      bg_job_id: "job-new",
      updatedAt: "2026-05-21T02:00:00Z",
    });
    const buckets = reconstructWorkerState(orchDir, {
      statJob: () => ({ exists: true, mtimeMs: 1 }),
    });
    const all = [
      ...buckets.running,
      ...buckets.dead,
      ...buckets.terminal,
      ...buckets.unknown,
    ];
    expect(all).toHaveLength(1);
    expect(all[0].phase).toBe("implement");
  });

  test("a malformed signal file is skipped, not fatal", () => {
    writeNested("CTL-OK", "research", { status: "running", bg_job_id: "job-ok" });
    writeFileSync(
      join(orchDir, "workers", "CTL-OK", "phase-plan.json"),
      "{ not json",
    );
    let buckets;
    expect(() => {
      buckets = reconstructWorkerState(orchDir, {
        statJob: () => ({ exists: true, mtimeMs: 1 }),
      });
    }).not.toThrow();
    // The valid phase-research signal still classifies.
    const all = [
      ...buckets.running,
      ...buckets.dead,
      ...buckets.terminal,
      ...buckets.unknown,
    ];
    expect(all).toHaveLength(1);
  });

  test("a flat legacy signal buckets as 'unknown'", () => {
    writeFlat("CTL-FLAT", { phase: 3, pid: 999, status: "implementing" });
    const buckets = reconstructWorkerState(orchDir, { statJob: () => null });
    expect(buckets.unknown.map((w) => w.ticket)).toEqual(["CTL-FLAT"]);
    expect(buckets.unknown[0].bgJobId).toBeNull();
  });
});

// --- defaultStatJob — real filesystem stat --------------------------------

describe("defaultStatJob", () => {
  let jobsRoot;
  let prevJobsRoot;

  beforeEach(() => {
    prevJobsRoot = process.env.CATALYST_HEALTHCHECK_JOBS_ROOT;
    jobsRoot = mkdtempSync(join(tmpdir(), "exec-core-jobs-"));
    process.env.CATALYST_HEALTHCHECK_JOBS_ROOT = jobsRoot;
  });

  afterEach(() => {
    if (prevJobsRoot === undefined) delete process.env.CATALYST_HEALTHCHECK_JOBS_ROOT;
    else process.env.CATALYST_HEALTHCHECK_JOBS_ROOT = prevJobsRoot;
    rmSync(jobsRoot, { recursive: true, force: true });
  });

  test("returns null when the job dir is gone", () => {
    expect(defaultStatJob("no-such-job")).toBeNull();
  });

  test("returns {exists, mtimeMs, state} when state.json is present", () => {
    const dir = join(jobsRoot, "job-live");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ state: "running" }));
    const res = defaultStatJob("job-live");
    expect(res?.exists).toBe(true);
    expect(typeof res?.mtimeMs).toBe("number");
    expect(res?.state).toBe("running");
  });

  // CTL-736 Phase 2: jobLifecycle needs the firstTerminalAt timestamp (set by
  // Claude when a job reaches a terminal lifecycle state) as a state-name-agnostic
  // death signal, so defaultStatJob must surface it.
  test("CTL-736: surfaces firstTerminalAt when present in state.json", () => {
    const dir = join(jobsRoot, "job-terminal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ state: "stopped", firstTerminalAt: "2026-05-30T12:00:00Z" }),
    );
    const res = defaultStatJob("job-terminal");
    expect(res?.state).toBe("stopped");
    expect(res?.firstTerminalAt).toBe("2026-05-30T12:00:00Z");
  });

  test("CTL-736: firstTerminalAt is null when absent (non-terminal job)", () => {
    const dir = join(jobsRoot, "job-working");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ state: "working" }));
    expect(defaultStatJob("job-working")?.firstTerminalAt).toBeNull();
  });

  test("returns liveness with state:null when state.json is unreadable JSON", () => {
    const dir = join(jobsRoot, "job-corrupt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), "{ not json");
    const res = defaultStatJob("job-corrupt");
    expect(res?.exists).toBe(true);
    expect(res?.state).toBeNull();
  });
});

// --- recoverStartup — composition (Phase 3) -------------------------------

describe("recoverStartup", () => {
  let catalystDir;
  let prevCatalystDir;
  const enrolledTeams = new Set();
  const registryEntries = [];

  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    catalystDir = mkdtempSync(join(tmpdir(), "exec-core-recover-"));
    process.env.CATALYST_DIR = catalystDir;
    mkdirSync(join(catalystDir, "execution-core"), { recursive: true });
    enrolledTeams.clear();
    registryEntries.length = 0;
  });

  afterEach(() => {
    for (const t of enrolledTeams) dropProject(t);
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(catalystDir, { recursive: true, force: true });
  });

  // Register a team in the central registry so reconcileAll has a project to
  // reconcile. Returns the stub repoRoot the registry entry points at.
  function enroll(team, eligibleQuery) {
    const repoRoot = mkdtempSync(join(catalystDir, `repo-${team}-`));
    registryEntries.push({ team, repoRoot, eligibleQuery: eligibleQuery ?? null });
    writeFileSync(
      join(catalystDir, "execution-core", "registry.json"),
      JSON.stringify({ projects: registryEntries }, null, 2),
    );
    enrolledTeams.add(team);
    return repoRoot;
  }

  // A mocked linearis exec keyed on the --team flag.
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

  const node = (identifier) => ({
    identifier,
    state: { name: "Todo" },
    priority: 2,
  });

  // Append a line to the current UTC month's event log.
  function eventLogPath() {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    return join(catalystDir, "events", `${ym}.jsonl`);
  }
  function appendEvent(line) {
    mkdirSync(join(catalystDir, "events"), { recursive: true });
    appendFileSync(eventLogPath(), line);
  }

  test("throws when orchDir is missing", () => {
    expect(() => recoverStartup({})).toThrow(/orchDir is required/);
  });

  test("rebuilds routing state — eligible projection exists after recoverStartup", () => {
    enroll("ENG", { status: "Todo" });
    const exec = mockExec({ ENG: [node("ENG-1")] });
    recoverStartup({ orchDir, exec, statJob: () => null });
    expect(
      existsSync(join(catalystDir, "execution-core", "eligible", "ENG.json")),
    ).toBe(true);
  });

  test("report.routing carries the enrolled project list", () => {
    enroll("ENG", { status: "Todo" });
    enroll("PLAT", { status: "Todo" });
    const exec = mockExec({ ENG: [], PLAT: [] });
    const report = recoverStartup({ orchDir, exec, statJob: () => null });
    expect(report.routing.projectCount).toBe(2);
    expect([...report.routing.projects].sort()).toEqual(["ENG", "PLAT"]);
  });

  test("report.cursor.resumed is true when a valid cursor is saved", () => {
    enroll("ENG", { status: "Todo" });
    const exec = mockExec({ ENG: [] });
    appendEvent('{"event":"x"}\n{"event":"y"}\n'); // non-empty log
    saveCursor({ logPath: eventLogPath(), byteOffset: 0 }); // cursor at start
    const report = recoverStartup({ orchDir, exec, statJob: () => null });
    expect(report.cursor.resumed).toBe(true);
    expect(report.cursor.byteOffset).toBe(0);
    expect(report.cursor.logPath).toBe(eventLogPath());
  });

  test("report.cursor.resumed is false when no cursor file exists", () => {
    enroll("ENG", { status: "Todo" });
    const exec = mockExec({ ENG: [] });
    appendEvent('{"event":"x"}\n');
    const report = recoverStartup({ orchDir, exec, statJob: () => null });
    expect(report.cursor.resumed).toBe(false);
  });

  test("report.workers carries the running/dead/terminal/unknown buckets", () => {
    enroll("ENG", { status: "Todo" });
    const exec = mockExec({ ENG: [] });
    writeNested("CTL-RUN", "research", { status: "running", bg_job_id: "job-run" });
    writeNested("CTL-DEAD", "plan", { status: "running", bg_job_id: "job-dead" });
    const report = recoverStartup({
      orchDir,
      exec,
      statJob: (id) => (id === "job-run" ? { exists: true, mtimeMs: 1 } : null),
    });
    expect(report.workers.running.map((w) => w.ticket)).toEqual(["CTL-RUN"]);
    expect(report.workers.dead.map((w) => w.ticket)).toEqual(["CTL-DEAD"]);
    expect(report.workers.terminal).toEqual([]);
    expect(report.workers.unknown).toEqual([]);
  });

  test("report.recoveredAt is an ISO-8601 timestamp", () => {
    enroll("ENG", { status: "Todo" });
    const exec = mockExec({ ENG: [] });
    const report = recoverStartup({ orchDir, exec, statJob: () => null });
    expect(report.recoveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(Number.isNaN(Date.parse(report.recoveredAt))).toBe(false);
  });

  test("a reconcile-poll failure does not abort recovery (routing best-effort)", () => {
    enroll("ENG", { status: "Todo" });
    writeNested("CTL-RUN", "research", { status: "running", bg_job_id: "job-run" });
    // exec returns a non-zero code → runEligibleQuery throws → reconcileProject
    // swallows it. recoverStartup must still return a report with workers.
    const failingExec = () => ({ code: 1, stdout: "", stderr: "linearis down" });
    let report;
    expect(() => {
      report = recoverStartup({
        orchDir,
        exec: failingExec,
        statJob: () => ({ exists: true, mtimeMs: 1 }),
      });
    }).not.toThrow();
    expect(report.workers.running.map((w) => w.ticket)).toEqual(["CTL-RUN"]);
  });

  test("no event log at all → cursor.byteOffset 0, resumed false (poll-only)", () => {
    enroll("ENG", { status: "Todo" });
    const exec = mockExec({ ENG: [] });
    const report = recoverStartup({ orchDir, exec, statJob: () => null });
    expect(report.cursor.byteOffset).toBe(0);
    expect(report.cursor.resumed).toBe(false);
  });

  test("RecoveryReport includes the coldStart verdict (CTL-640)", () => {
    enroll("ENG", { status: "Todo" });
    const exec = mockExec({ ENG: [] });
    const report = recoverStartup({
      orchDir,
      exec,
      statJob: () => null,
      detectCold: () => ({ coldStart: true, epoch: 5000, epochSource: "daemon", jobsChecked: 0, newestJobMtime: 0 }),
    });
    expect(report.coldStart).toMatchObject({ coldStart: true, epochSource: "daemon" });
  });
});

// --- CTL-574: reclaim-dead-work --------------------------------------------

// implementSignal — a bg-shaped phase-implement signal with the orchestrator +
// session-id fields the reclaim path threads into emit-complete.
function implementSignal({ ticket = "CTL-9", status = "running", bgJobId = "job-x", startedAt } = {}) {
  return {
    ticket,
    phase: "implement",
    status,
    liveness: { kind: "bg", value: bgJobId },
    signalPath: `/x/${ticket}/phase-implement.json`,
    raw: {
      ticket,
      phase: "implement",
      orchestrator: ticket,
      status,
      bg_job_id: bgJobId,
      catalystSessionId: `sess_${ticket}_abc`,
      // CTL-735: only present when a test exercises the post-(re)dispatch grace
      // window. Absent by default so the existing absent-revive tests (which can't
      // prove worker freshness) keep their pre-CTL-735 revive behaviour.
      ...(startedAt !== undefined ? { startedAt } : {}),
    },
  };
}

// spies — record calls without bun:test's mock() so the assertions read plain.
function recorder(returnValue) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return typeof returnValue === "function" ? returnValue(...args) : returnValue;
  };
  fn.calls = calls;
  return fn;
}

// CTL-701 Phase 1: reclaim sweep visits a monitor-deploy/running signal
describe("reclaimDeadWorkIfPossible — monitor-deploy (CTL-701)", () => {
  const orch = "/orch";

  test("classifies monitor-deploy/running/dead-bg as 'dead', visits probe (CTL-701)", () => {
    const sig = {
      ticket: "CTL-MD",
      phase: "monitor-deploy",
      status: "running",
      liveness: { kind: "bg", value: "job-md" },
      signalPath: `${orch}/workers/CTL-MD/phase-monitor-deploy.json`,
      raw: {
        ticket: "CTL-MD",
        phase: "monitor-deploy",
        orchestrator: "CTL-MD",
        status: "running",
        bg_job_id: "job-md",
      },
    };
    const klass = classifyWorker(sig, { statJob: () => null });
    expect(klass).toBe("dead");

    // reclaimDeadWorkIfPossible proceeds to probe (not short-circuited)
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => null,
      probes: { "monitor-deploy": probe },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      postReclaimMirror: () => {},
      liveness: () => "absent",
    });
    expect(r).toBe("reclaimed");
    expect(probe.calls.length).toBe(1);
    expect(emit.calls.length).toBe(1);
  });
});

// CTL-830: turn-cap-exhausted is terminal since CTL-748 removed turn caps —
// reclaim/revive no longer apply (terminal short-circuits to noop).
describe("reclaimDeadWorkIfPossible — turn-cap-exhausted is terminal (CTL-830)", () => {
  const orch = "/orch";

  test("turn-cap-exhausted short-circuits to noop — no reclaim probe, no emit", () => {
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal({ status: "turn-cap-exhausted" }), {
      statJob: () => null,
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      postReclaimMirror: () => {},
      liveness: () => "absent",
    });
    expect(r).toBe("noop");
    expect(probe.calls.length).toBe(0);
    expect(emit.calls.length).toBe(0);
  });

  test("turn-cap-exhausted short-circuits to noop — no revive dispatch", () => {
    const reviveDispatch = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal({ status: "turn-cap-exhausted" }), {
      statJob: () => null,
      probes: { implement: recorder(false) },
      emitComplete: recorder({ code: 0 }),
      appendEvent: recorder(undefined),
      appendReviveEvent: recorder(undefined),
      reviveDispatch,
      countReviveEvents: recorder(0),
      countDistinctRevivingTickets: recorder(1),
      writeReviveMarker: recorder(undefined),
      killBgJob: recorder(undefined),
      applyStalledLabel: recorder({ applied: true }),
      resolveSession: () => "uuid-resume",
      liveness: () => "absent",
    });
    expect(r).toBe("noop");
    expect(reviveDispatch.calls.length).toBe(0);
  });
});

// CTL-735: post-(re)dispatch grace window — the missing analog of the
// idle-confirmation streak for `absent`. A worker whose NEW bg_job_id is merely
// `absent` from the eventually-consistent `claude agents` snapshot but whose
// signal was (re)dispatched within REVIVE_GRACE_MS has almost certainly just not
// registered yet, NOT crashed. Without this the de-starved fast tick (CTL-731)
// re-classifies each just-revived worker as dead and revives it again every
// ~2-4s → the revive storm (5→18→62→74 workers, load 72).
// CTL-736 Phase 2: the CTL-735 post-revive grace window (`revive-pending`) is
// DELETED. It existed only to absorb the eventually-consistent `claude agents`
// snapshot lag (a freshly-spawned worker shows `absent`/`idle` before it
// registers). The authoritative local state.json lifecycle has no such lag — a
// just-(re)dispatched worker writes state=working immediately, so jobLifecycle
// reads `alive` and the grace window has nothing to guard against. Its test
// block is removed with the mechanism.

// CTL-735 Guard 2 — per-tick revive cap. The scheduler passes the remaining
// per-tick revive budget; once exhausted, an otherwise-revivable worker is
// `revive-capped` (deferred to a later tick) instead of dispatched. This bounds
// a fast loop that would otherwise outrun the event-count-lagged storm-breaker.
// CTL-735 Guard 3 — keep long-dead tickets inert. isTicketInFlight treats any
// ticket with a non-terminal signal as in-flight, so a worker that crashed at
// `running` and never flipped terminal stays swept forever. Reviving such an
// abandoned historical dir wastes budget and — once MAX_REVIVES is hit —
// escalates dozens of long-dead tickets to needs-human. An absent/idle worker
// whose signal has not been touched in REVIVE_MAX_AGE_MS (24h, well above any
// real phase) is inert: no revive, no escalate. Branch (B) reclaim (work IS done)
// still runs, so a genuinely-completed old worker is still cleaned up.
describe("reclaimDeadWorkIfPossible — CTL-735 inert stale tickets", () => {
  const orch = "/orch";
  const NOW = 10_000_000_000; // a large epoch so "24h ago" is positive
  const AGE = 24 * 60 * 60_000;

  const seams = (reviveDispatch, escalate, probeDone, extra = {}) => ({
    statJob: () => null,
    probes: { implement: recorder(probeDone) },
    emitComplete: recorder({ code: 0 }),
    appendEvent: recorder(undefined),
    appendReviveEvent: recorder(true),
    appendEscalatedEvent: escalate,
    reviveDispatch,
    countReviveEvents: recorder(0),
    countDistinctRevivingTickets: recorder(1),
    writeReviveMarker: recorder(undefined),
    killBgJob: recorder(undefined),
    applyStalledLabel: recorder({ applied: true }),
    resolveSession: () => null,
    postReclaimMirror: () => {},
    liveness: () => "absent",
    reviveMaxAgeMs: AGE,
    now: () => NOW,
    ...extra,
  });

  test("absent, work-not-done, signal older than REVIVE_MAX_AGE_MS → 'inert-stale' (no revive, no escalate)", () => {
    const reviveDispatch = recorder({ code: 0 });
    const escalate = recorder(undefined);
    const sig = implementSignal({
      // updatedAt 25h ago — past the 24h inert threshold.
      startedAt: new Date(NOW - 25 * 60 * 60_000).toISOString(),
    });
    sig.raw.updatedAt = new Date(NOW - 25 * 60 * 60_000).toISOString();
    const r = reclaimDeadWorkIfPossible(orch, sig, seams(reviveDispatch, escalate, false));
    expect(r).toBe("inert-stale");
    expect(reviveDispatch.calls.length).toBe(0);
    expect(escalate.calls.length).toBe(0);
  });

  test("absent, work-not-done, signal WITHIN the age window → revives (fresh crash, not abandoned)", () => {
    const reviveDispatch = recorder({ code: 0 });
    const escalate = recorder(undefined);
    // 10 min ago: past the 90s grace window (Guard 1) but well within the 24h
    // inert threshold (Guard 3) — a genuine recent crash that should revive.
    const sig = implementSignal({
      startedAt: new Date(NOW - 10 * 60_000).toISOString(),
    });
    sig.raw.updatedAt = new Date(NOW - 10 * 60_000).toISOString();
    const r = reclaimDeadWorkIfPossible(orch, sig, seams(reviveDispatch, escalate, false));
    expect(r).toBe("revived");
    expect(reviveDispatch.calls.length).toBe(1);
  });

  test("old signal but work IS done → still reclaimed (branch B), NOT left inert", () => {
    const reviveDispatch = recorder({ code: 0 });
    const escalate = recorder(undefined);
    const sig = implementSignal({
      startedAt: new Date(NOW - 25 * 60 * 60_000).toISOString(),
    });
    sig.raw.updatedAt = new Date(NOW - 25 * 60 * 60_000).toISOString();
    const r = reclaimDeadWorkIfPossible(orch, sig, seams(reviveDispatch, escalate, true));
    expect(r).toBe("reclaimed");
    expect(reviveDispatch.calls.length).toBe(0);
  });

  test("old signal with NO parseable timestamps → revives (back-compat: cannot judge age)", () => {
    const reviveDispatch = recorder({ code: 0 });
    const escalate = recorder(undefined);
    const sig = implementSignal(); // no startedAt/updatedAt
    const r = reclaimDeadWorkIfPossible(orch, sig, seams(reviveDispatch, escalate, false));
    expect(r).toBe("revived");
    expect(reviveDispatch.calls.length).toBe(1);
  });
});

// CTL-736 Phase 3: the CTL-735 per-tick revive cap (`revive-capped`) is DELETED.
// The progress gate (revive only while forward progress advances; stop on zero
// progress) plus the Phase-1 O_EXCL claim bound retries structurally, so a single
// tick can no longer mass-revive a backlog of dead workers. Its test block is
// removed with the mechanism; see the CTL-736 progress-gate block below.

describe("reclaimDeadWorkIfPossible", () => {
  const orch = "/orch";

  test("'noop' for a terminal signal (no emit, no probe)", () => {
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const appendEvent = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(orch, implementSignal({ status: "done" }), {
      statJob: () => null,
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent,
    });
    expect(r).toBe("noop");
    expect(probe.calls.length).toBe(0);
    expect(emit.calls.length).toBe(0);
    expect(appendEvent.calls.length).toBe(0);
  });

  test("CTL-736: an ALIVE worker (state.json non-terminal) is 'alive-suppressed', never reclaimed (regardless of mtime)", () => {
    // The CTL-736 fan-out-safe fix: an alive worker (state.json .state=working,
    // e.g. an in-process sub-agent fan-out) is NEVER auto-reclaimed, even though
    // its state.json mtime may be arbitrarily stale (mtime is not consulted).
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => ({ exists: true, mtimeMs: 1_000, state: "working" }),
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      now: () => 1_000 + 60 * 60 * 1000, // an hour past mtime — irrelevant now
    });
    expect(r).toBe("alive-suppressed");
    expect(probe.calls.length).toBe(0); // alive short-circuits before the probe
    expect(emit.calls.length).toBe(0);
  });

  test("CTL-736: a DEAD-GONE worker (job dir gone) with work done is reclaimed immediately", () => {
    // dead-gone = the job dir vanished (crashed/exited) → reclaim-eligible
    // immediately, no idle-confirmation, no grace window. Replaces the
    // pre-CTL-736 `claude agents` absent trigger.
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const appendEvent = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => null, // job dir gone → dead-gone
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent,
      postReclaimMirror: () => {}, // CTL-664: keep the test hermetic (no linearis spawn)
      now: () => 1_000,
    });
    expect(r).toBe("reclaimed");
    expect(probe.calls.length).toBe(1);
    expect(emit.calls.length).toBe(1);
    expect(appendEvent.calls.length).toBe(1);
  });

  test("CTL-736: an ALIVE worker with work done is still suppressed (left to emit its own complete)", () => {
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => ({ exists: true, mtimeMs: 1_000_000, state: "working" }),
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      now: () => 1_000_000 + 60_000,
    });
    expect(r).toBe("alive-suppressed");
    expect(emit.calls.length).toBe(0);
  });

  // CTL-809 — GHOST BREAKER. jobLifecycle reports a crashed/wedged --bg worker
  // "alive" forever (CC 2.x never flips its state.json terminal). The alive branch
  // cross-checks a FRESH `claude agents` snapshot: absent-from-fresh + past grace =
  // genuinely dead → fall through to reclaim. Strictly gated to preserve CTL-662
  // (busy fan-out stays listed) and CTL-731/657 (stale snapshot never reclaims).
  const GHOST_GRACE = 60_000;
  const STARTED = "2026-06-06T00:00:00Z";
  const STARTED_MS = Date.parse(STARTED);

  test("CTL-809: alive worker ABSENT from a FRESH snapshot, past grace, work done → ghost-breaker reclaims", () => {
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const appendEvent = recorder(undefined);
    const sig = implementSignal({ bgJobId: "807b77bd", startedAt: STARTED });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => ({ exists: true, state: "working" }), // jobLifecycle → alive
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent,
      postReclaimMirror: () => {}, // hermetic — no linearis spawn
      // FRESH snapshot, our worker absent (only an unrelated agent present)
      agentsSnapshot: () => ({
        agents: [{ sessionId: "deadbeef-1111-2222-3333-444444444444" }],
        isFresh: true,
        ageMs: 1_000,
      }),
      ghostGraceMs: GHOST_GRACE,
      now: () => STARTED_MS + 5 * 60_000, // > grace, < busy ceiling
    });
    expect(r).toBe("reclaimed");
    expect(probe.calls.length).toBe(1);
    expect(emit.calls.length).toBe(1);
  });

  test("CTL-809: alive worker PRESENT in a FRESH snapshot (busy fan-out) → still alive-suppressed (CTL-662)", () => {
    const emit = recorder({ code: 0 });
    const sig = implementSignal({ bgJobId: "807b77bd", startedAt: STARTED });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => ({ exists: true, state: "working" }),
      probes: { implement: recorder(true) },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      // our worker's shortId IS in the fresh snapshot → busy, not a ghost
      agentsSnapshot: () => ({
        agents: [{ sessionId: "807b77bd-0000-0000-0000-000000000000" }],
        isFresh: true,
        ageMs: 1_000,
      }),
      ghostGraceMs: GHOST_GRACE,
      now: () => STARTED_MS + 5 * 60_000,
    });
    expect(r).toBe("alive-suppressed");
    expect(emit.calls.length).toBe(0);
  });

  test("CTL-809: alive worker absent but snapshot STALE/cold → still alive-suppressed (CTL-731/657, no cold storm)", () => {
    const emit = recorder({ code: 0 });
    const sig = implementSignal({ bgJobId: "807b77bd", startedAt: STARTED });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => ({ exists: true, state: "working" }),
      probes: { implement: recorder(true) },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      agentsSnapshot: () => ({ agents: [], isFresh: false, ageMs: Infinity }), // cold
      ghostGraceMs: GHOST_GRACE,
      now: () => STARTED_MS + 5 * 60_000,
    });
    expect(r).toBe("alive-suppressed");
    expect(emit.calls.length).toBe(0);
  });

  test("CTL-809: alive worker absent from a FRESH snapshot but WITHIN grace → suppress (just-spawned-safe)", () => {
    const emit = recorder({ code: 0 });
    let snapCalls = 0;
    const sig = implementSignal({ bgJobId: "807b77bd", startedAt: STARTED });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => ({ exists: true, state: "working" }),
      probes: { implement: recorder(true) },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      agentsSnapshot: () => {
        snapCalls++;
        return { agents: [], isFresh: true, ageMs: 1 };
      },
      ghostGraceMs: GHOST_GRACE,
      now: () => STARTED_MS + 30_000, // 30s < 60s grace
    });
    expect(r).toBe("alive-suppressed");
    expect(snapCalls).toBe(0); // within grace → snapshot never consulted
    expect(emit.calls.length).toBe(0);
  });

  test("CTL-809: alive worker PAST busy-ceiling with work done but PRESENT in a fresh snapshot → still suppressed (busy-ceiling × ghost-breaker)", () => {
    // The dangerous intersection: past busy-ceiling with workDone:true skips the
    // escalation and reaches the ghost-breaker. A worker still LISTED in a fresh
    // snapshot is a live busy worker and must NEVER be reclaimed (CTL-662).
    const emit = recorder({ code: 0 });
    const sig = implementSignal({ bgJobId: "807b77bd", startedAt: STARTED });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => ({ exists: true, state: "working" }),
      probes: { implement: recorder(true) }, // workDone → skips busy-ceiling escalate
      emitComplete: emit,
      appendEvent: recorder(undefined),
      agentsSnapshot: () => ({
        agents: [{ sessionId: "807b77bd-0000-0000-0000-000000000000" }], // PRESENT
        isFresh: true,
        ageMs: 1_000,
      }),
      ghostGraceMs: GHOST_GRACE,
      busyCeilingMs: 1, // tiny → now() is far past it
      now: () => STARTED_MS + 5 * 60_000,
    });
    expect(r).toBe("alive-suppressed");
    expect(emit.calls.length).toBe(0);
  });

  test("CTL-809: malformed bg_job_id → ghost-breaker suppresses without throwing (snapshot not consulted)", () => {
    const emit = recorder({ code: 0 });
    let snapCalls = 0;
    const sig = implementSignal({ bgJobId: "zzzzzzzz", startedAt: STARTED });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => ({ exists: true, state: "working" }),
      probes: { implement: recorder(true) },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      agentsSnapshot: () => {
        snapCalls++;
        return { agents: [], isFresh: true, ageMs: 1 };
      },
      ghostGraceMs: GHOST_GRACE,
      now: () => STARTED_MS + 5 * 60_000,
    });
    expect(r).toBe("alive-suppressed"); // shortIdFromSessionId throws → caught → suppress
    expect(snapCalls).toBe(0);
  });

  // CTL-868 — ZOMBIE BREAKER. The CTL-809 ghost-breaker only fires on a FRESH
  // `claude agents` snapshot; on a headless host that snapshot is unreliable
  // (CTL-829), so a corpse stuck at state:"working" stays alive-suppressed and
  // starves a slot forever. When no fresh snapshot is available, the alive branch
  // falls back to a state.json mtime staleness floor. These prove the breaker fires
  // for a genuine zombie yet never overrides a fresh "present" verdict (CTL-662).
  const ZOMBIE_FLOOR = 2 * 60 * 60_000;

  test("CTL-868: alive worker, state.json mtime past the zombie floor, NO fresh snapshot, work done → reclaimed", () => {
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const sig = implementSignal({ bgJobId: "807b77bd", startedAt: STARTED });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      // state=working (jobLifecycle → alive) but state.json untouched for 3h → corpse
      statJob: () => ({ exists: true, state: "working", mtimeMs: STARTED_MS }),
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      postReclaimMirror: () => {}, // hermetic — no linearis spawn
      agentsSnapshot: () => ({ agents: [], isFresh: false, ageMs: Infinity }), // mini: stale/cold
      ghostGraceMs: GHOST_GRACE,
      zombieStaleFloorMs: ZOMBIE_FLOOR,
      now: () => STARTED_MS + 3 * 60 * 60_000, // 3h past mtime > 2h floor, < 6h busy ceiling
    });
    expect(r).toBe("reclaimed");
    expect(emit.calls.length).toBe(1);
  });

  test("CTL-868: alive worker mtime past the floor but PRESENT in a FRESH snapshot → still suppressed (CTL-662, fresh-present wins over mtime)", () => {
    const emit = recorder({ code: 0 });
    const sig = implementSignal({ bgJobId: "807b77bd", startedAt: STARTED });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => ({ exists: true, state: "working", mtimeMs: STARTED_MS }), // 3h stale
      probes: { implement: recorder(true) },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      // a FRESH snapshot lists the worker → busy fan-out, NOT a zombie (mtime ignored)
      agentsSnapshot: () => ({
        agents: [{ sessionId: "807b77bd-0000-0000-0000-000000000000" }],
        isFresh: true,
        ageMs: 1_000,
      }),
      ghostGraceMs: GHOST_GRACE,
      zombieStaleFloorMs: ZOMBIE_FLOOR,
      now: () => STARTED_MS + 3 * 60 * 60_000,
    });
    expect(r).toBe("alive-suppressed");
    expect(emit.calls.length).toBe(0);
  });

  test("CTL-868: alive worker, mtime WITHIN the zombie floor, no fresh snapshot → still suppressed", () => {
    const emit = recorder({ code: 0 });
    const sig = implementSignal({ bgJobId: "807b77bd", startedAt: STARTED });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => ({ exists: true, state: "working", mtimeMs: STARTED_MS }),
      probes: { implement: recorder(true) },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      agentsSnapshot: () => ({ agents: [], isFresh: false, ageMs: Infinity }),
      ghostGraceMs: GHOST_GRACE,
      zombieStaleFloorMs: ZOMBIE_FLOOR,
      now: () => STARTED_MS + 30 * 60_000, // 30min stale < 2h floor
    });
    expect(r).toBe("alive-suppressed");
    expect(emit.calls.length).toBe(0);
  });

  // CTL-927 — DOC-PHASE ZOMBIE-FLOOR EXEMPTION. The CTL-868 cold-snapshot mtime
  // floor fires only when no FRESH `claude agents` snapshot exists (CTL-829, the
  // headless mini). For long-fan-out doc phases (research/plan/triage/verify/review)
  // the worker's state.json legitimately ages during a multi-minute in-process
  // sub-agent fan-out, so the 2h mtime guess false-kills a LIVE worker → the observed
  // fleet-wide no-progress storm. Doc phases use BUSY_CEILING_MS (6h) instead, where
  // the busy-ceiling escalation routes to needs-human (escalate, never silent kill).
  // implement/remediate keep the 2h floor.
  const BUSY_CEILING = 6 * 60 * 60_000;
  const docSignal = (phase, { bgJobId = "807b77bd", startedAt = STARTED } = {}) => ({
    ticket: "CTL-9",
    phase,
    status: "running",
    liveness: { kind: "bg", value: bgJobId },
    signalPath: `/x/CTL-9/phase-${phase}.json`,
    raw: {
      ticket: "CTL-9",
      phase,
      orchestrator: "CTL-9",
      status: "running",
      bg_job_id: bgJobId,
      catalystSessionId: "sess_CTL-9_abc",
      startedAt,
    },
  });

  test("CTL-927: research worker, state.json mtime 3h stale, NO fresh snapshot → alive-suppressed (doc phase exempt from the 2h zombie floor)", () => {
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, docSignal("research"), {
      // state=working (jobLifecycle → alive); state.json untouched 3h (sub-agent fan-out)
      statJob: () => ({ exists: true, state: "working", mtimeMs: STARTED_MS }),
      probes: { research: recorder(false) }, // research doc not written yet (artifact-bytes = 0)
      emitComplete: emit,
      appendEvent: recorder(undefined),
      postReclaimMirror: () => {}, // hermetic — no linearis spawn
      agentsSnapshot: () => ({ agents: [], isFresh: false, ageMs: Infinity }), // mini: stale/cold (CTL-829)
      ghostGraceMs: GHOST_GRACE,
      zombieStaleFloorMs: ZOMBIE_FLOOR, // 2h
      busyCeilingMs: BUSY_CEILING, // 6h
      now: () => STARTED_MS + 3 * 60 * 60_000, // 3h: past the 2h floor, under the 6h ceiling
    });
    expect(r).toBe("alive-suppressed"); // pre-fix: the 2h zombie-floor wrongly reclaims it
    expect(emit.calls.length).toBe(0);
  });

  test("CTL-927 regression: implement worker, mtime 3h stale, NO fresh snapshot, work done → still reclaimed (implement keeps the 2h floor)", () => {
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, docSignal("implement"), {
      statJob: () => ({ exists: true, state: "working", mtimeMs: STARTED_MS }),
      probes: { implement: recorder(true) },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      postReclaimMirror: () => {},
      agentsSnapshot: () => ({ agents: [], isFresh: false, ageMs: Infinity }),
      ghostGraceMs: GHOST_GRACE,
      zombieStaleFloorMs: ZOMBIE_FLOOR,
      busyCeilingMs: BUSY_CEILING,
      now: () => STARTED_MS + 3 * 60 * 60_000,
    });
    expect(r).toBe("reclaimed");
    expect(emit.calls.length).toBe(1);
  });

  test("CTL-927 regression: research worker mtime 3h stale but PRESENT in a FRESH snapshot → alive-suppressed (fresh-present still wins; ghost-breaker unchanged)", () => {
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, docSignal("research"), {
      statJob: () => ({ exists: true, state: "working", mtimeMs: STARTED_MS }),
      probes: { research: recorder(false) },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      agentsSnapshot: () => ({
        agents: [{ sessionId: "807b77bd-0000-0000-0000-000000000000" }],
        isFresh: true,
        ageMs: 1_000,
      }),
      ghostGraceMs: GHOST_GRACE,
      zombieStaleFloorMs: ZOMBIE_FLOOR,
      busyCeilingMs: BUSY_CEILING,
      now: () => STARTED_MS + 3 * 60 * 60_000,
    });
    expect(r).toBe("alive-suppressed");
    expect(emit.calls.length).toBe(0);
  });

  test("CTL-927 regression: research worker ABSENT from a FRESH snapshot, past grace, work done → ghost-breaker still reclaims (doc exemption only relaxes the COLD path)", () => {
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, docSignal("research"), {
      statJob: () => ({ exists: true, state: "working", mtimeMs: STARTED_MS }),
      probes: { research: probe },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      postReclaimMirror: () => {},
      agentsSnapshot: () => ({
        agents: [{ sessionId: "deadbeef-1111-2222-3333-444444444444" }], // our worker absent
        isFresh: true,
        ageMs: 1_000,
      }),
      ghostGraceMs: GHOST_GRACE,
      zombieStaleFloorMs: ZOMBIE_FLOOR,
      busyCeilingMs: BUSY_CEILING,
      now: () => STARTED_MS + 3 * 60 * 60_000,
    });
    expect(r).toBe("reclaimed");
    expect(emit.calls.length).toBe(1);
  });

  // CTL-1245 — DEAD-BUT-RUNNING DOC-WORKER BREAKER. A --bg doc worker
  // (triage/research/plan/verify/review) that dies WITHOUT Claude stamping its
  // state.json terminal (SIGKILL/OOM) reads jobLifecycle "alive" forever. On the
  // headless mini (no fresh agents snapshot — CTL-829) the CTL-868 cold floor for
  // these phases is the 6h busy ceiling, so a genuinely-dead triage/plan corpse
  // sits alive-suppressed up to 6h, starving slots (the 2026-06-17 evidence).
  // The corroborator: a LIVE doc worker keeps WRITING its transcript (subagents
  // folded in by transcriptAgeMs → fan-out safe); a transcript silent past the
  // floor on an alive-by-state.json doc worker is a corpse. Gated off-by-default.
  //
  // The conjunction (mode≠off ∧ doc phase ∧ mtime floor NOT already tripped ∧
  // measurable transcript age > floor) sets ghostAbsent and the worker falls
  // through to the existing branch-(C) revive under the CTL-736 progress gate.
  const DEAD_DOC_SILENCE = 30 * 60_000; // 30min default
  // A worker whose state.json mtime is RECENT (within the 2h zombie floor and far
  // under the 6h doc ceiling) so the mtime-floor branch never fires — isolating
  // the transcript corroborator as the sole death signal. now is 31min past start.
  const docNow = STARTED_MS + 31 * 60_000;
  // Full branch-(C) revive seams (work-not-done) so a corroborated-dead doc worker
  // routes through the progress gate exactly like any other reclaim-eligible worker.
  const docReviveSeams = (extra = {}) => ({
    repoRoot: "/repo",
    statJob: () => ({ exists: true, state: "working", mtimeMs: docNow - 60_000 }), // mtime fresh → mtime floor inert
    probes: { research: () => false, plan: () => false, triage: () => false }, // work NOT done → branch (C)
    emitComplete: recorder({ code: 0 }),
    appendEvent: recorder(undefined),
    appendReviveEvent: recorder(true),
    appendEscalatedEvent: recorder(undefined),
    appendReviveSuppressedEvent: recorder(undefined),
    reviveDispatch: recorder({ code: 0 }),
    applyStalledLabel: recorder({ applied: true }),
    killBgJob: recorder(undefined),
    countReviveEvents: recorder(0),
    writeReviveMarker: recorder(undefined),
    writeProgressMark: recorder(undefined),
    resolveSession: () => null,
    readBootSince: () => undefined,
    inEscalationCooldownFn: () => false,
    recordEscalationFn: recorder(undefined),
    emitReapIntent: () => Promise.resolve(),
    breaker: { isOpen: () => false },
    agentsSnapshot: () => ({ agents: [], isFresh: false, ageMs: Infinity }), // mini: cold (CTL-829)
    ghostGraceMs: GHOST_GRACE,
    zombieStaleFloorMs: ZOMBIE_FLOOR,
    busyCeilingMs: BUSY_CEILING,
    deadDocSilenceMs: DEAD_DOC_SILENCE,
    now: () => docNow,
    ...extra,
  });

  test("CTL-1245: enforce — dead plan worker, transcript silent past floor, no fresh snapshot, work-not-done → REVIVED once (the core fix)", () => {
    const reviveDispatch = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, docSignal("plan"), docReviveSeams({
      deadDocWorkerMode: "enforce",
      transcriptAgeMs: () => 45 * 60_000, // 45min silent > 30min floor → corpse
      progressMark: () => 0,
      readProgressMark: () => -1, // first death, no prior mark → one revive
      reviveDispatch,
    }));
    expect(r).toBe("revived");
    expect(reviveDispatch.calls.length).toBe(1);
  });

  test("CTL-1245: enforce — LIVE doc worker mid fan-out (FRESH transcript) → alive-suppressed, NEVER touched (#1 correctness case)", () => {
    const reviveDispatch = recorder({ code: 0 });
    const killBgJob = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(orch, docSignal("research"), docReviveSeams({
      deadDocWorkerMode: "enforce",
      transcriptAgeMs: () => 2 * 60_000, // 2min ago — sub-agent fan-out alive < 30min floor
      reviveDispatch,
      killBgJob,
    }));
    expect(r).toBe("alive-suppressed");
    expect(reviveDispatch.calls.length).toBe(0);
    expect(killBgJob.calls.length).toBe(0);
  });

  test("CTL-1245: mode=off (default) — dead doc worker with silent transcript → alive-suppressed (strict no-op, feature inert)", () => {
    const reviveDispatch = recorder({ code: 0 });
    let transcriptCalled = 0;
    const r = reclaimDeadWorkIfPossible(orch, docSignal("triage"), docReviveSeams({
      deadDocWorkerMode: "off",
      transcriptAgeMs: () => { transcriptCalled++; return 99 * 60_000; }, // would be silent
      reviveDispatch,
    }));
    expect(r).toBe("alive-suppressed");
    expect(reviveDispatch.calls.length).toBe(0);
    expect(transcriptCalled).toBe(0); // off short-circuits before measuring — strict no-op
  });

  test("CTL-1245: mode=shadow — dead doc worker with silent transcript → alive-suppressed (measures + logs, takes NO action)", () => {
    const reviveDispatch = recorder({ code: 0 });
    let transcriptCalled = 0;
    const r = reclaimDeadWorkIfPossible(orch, docSignal("plan"), docReviveSeams({
      deadDocWorkerMode: "shadow",
      transcriptAgeMs: () => { transcriptCalled++; return 99 * 60_000; }, // silent
      reviveDispatch,
    }));
    expect(r).toBe("alive-suppressed");
    expect(reviveDispatch.calls.length).toBe(0);
    expect(transcriptCalled).toBe(1); // shadow DOES measure (to log the would-be verdict)…
    // …but takes no action: still suppressed.
  });

  test("CTL-1245: enforce — transcript age NULL (can't measure) → alive-suppressed (fail to false-negative, never touch a possibly-live worker)", () => {
    const reviveDispatch = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, docSignal("research"), docReviveSeams({
      deadDocWorkerMode: "enforce",
      transcriptAgeMs: () => null, // no session / no transcript file → unmeasurable
      reviveDispatch,
    }));
    expect(r).toBe("alive-suppressed");
    expect(reviveDispatch.calls.length).toBe(0);
  });

  test("CTL-1245: enforce — NON-doc phase (implement) is untouched by the corroborator (it keeps the 2h mtime floor only)", () => {
    const reviveDispatch = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, docSignal("implement"), docReviveSeams({
      deadDocWorkerMode: "enforce",
      probes: { implement: () => false },
      transcriptAgeMs: () => 99 * 60_000, // silent, but implement is not a doc phase
      reviveDispatch,
    }));
    expect(r).toBe("alive-suppressed"); // mtime fresh + not a doc phase → corroborator never runs
    expect(reviveDispatch.calls.length).toBe(0);
  });

  test("CTL-1245: enforce — FRESH snapshot lists the worker → alive-suppressed even with a silent transcript (CTL-662: fresh-present wins)", () => {
    const reviveDispatch = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, docSignal("plan", { bgJobId: "807b77bd" }), docReviveSeams({
      deadDocWorkerMode: "enforce",
      agentsSnapshot: () => ({
        agents: [{ sessionId: "807b77bd-0000-0000-0000-000000000000" }], // listed → busy
        isFresh: true,
        ageMs: 1_000,
      }),
      transcriptAgeMs: () => 99 * 60_000, // silent, but a fresh-present verdict dominates
      reviveDispatch,
    }));
    expect(r).toBe("alive-suppressed");
    expect(reviveDispatch.calls.length).toBe(0);
  });

  test("CTL-1245: enforce — corroborated-dead worker that RE-DIES at zero progress hits the gate → no-progress-stopped, NEVER loops", () => {
    const reviveDispatch = recorder({ code: 0 });
    const appendEscalatedEvent = recorder(undefined);
    const killBgJob = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(orch, docSignal("plan"), docReviveSeams({
      deadDocWorkerMode: "enforce",
      transcriptAgeMs: () => 45 * 60_000, // silent → corpse, falls to branch (C)
      progressMark: () => 0,
      readProgressMark: () => 0, // first revive already recorded 0; still 0 → STOP (no second revive)
      reviveDispatch,
      appendEscalatedEvent,
      killBgJob,
    }));
    expect(r).toBe("no-progress-stopped");
    expect(reviveDispatch.calls.length).toBe(0); // the futile respawn is suppressed
    expect(appendEscalatedEvent.calls[0][0].reason).toBe("no-progress");
    expect(killBgJob.calls.length).toBe(1);
  });

  test("CTL-1245: storm — N corroborated-dead doc workers each route through the progress gate independently (no batch bypass)", () => {
    // The fix admits dead doc workers ONE SIGNAL AT A TIME through the existing
    // reclaim path: there is no new batch/queue, so the per-(ticket,phase) O_EXCL
    // claim + progress gate bound each independently. A worker that progressed is
    // revived; a flat one is stopped — exactly as the gate dictates, at any N.
    const tickets = ["CTL-1240", "CTL-1241", "CTL-1242", "CTL-1243"];
    const results = tickets.map((t, i) => {
      const sig = docSignal("plan");
      sig.ticket = t;
      sig.raw.ticket = t;
      sig.raw.orchestrator = t;
      // even-index workers progressed (revive), odd-index flat (stop) — proving
      // the gate, not a batch cap, decides each one.
      const progressed = i % 2 === 0;
      return reclaimDeadWorkIfPossible(orch, sig, docReviveSeams({
        deadDocWorkerMode: "enforce",
        transcriptAgeMs: () => 45 * 60_000,
        progressMark: () => (progressed ? 3 : 0),
        readProgressMark: () => (progressed ? 1 : 0),
      }));
    });
    expect(results).toEqual(["revived", "no-progress-stopped", "revived", "no-progress-stopped"]);
  });

  test("'noop' for an unknown signal (no bg_job_id)", () => {
    const sig = implementSignal();
    sig.liveness = { kind: "bg", value: null };
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => null,
      probes: { implement: recorder(true) },
      emitComplete: emit,
      appendEvent: recorder(undefined),
    });
    expect(r).toBe("noop");
    expect(emit.calls.length).toBe(0);
  });

  // CTL-736: the reachable "dead worker → needs-human" path is the branch-(C)
  // no-progress STOP (a dead worker that made zero forward progress is flagged,
  // never respawned), replacing the deleted MAX_REVIVES budget-exhausted path.
  test("CTL-736: dead worker, probe NOT done + ZERO progress → 'no-progress-stopped' + needs-human label", () => {
    const sig = { ...implementSignal(), phase: "verify" };
    sig.raw.phase = "verify";
    const emit = recorder({ code: 0 });
    const appendEscalated = recorder(undefined);
    const applyLabel = recorder({ applied: true });
    const reviveDispatch = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => null, // bg dead → dead-gone
      probes: { verify: recorder(false) }, // artifact NOT complete
      emitComplete: emit,
      appendEvent: recorder(undefined),
      appendEscalatedEvent: appendEscalated,
      applyStalledLabel: applyLabel,
      reviveDispatch,
      // zero forward progress (current 0 <= prior 0) → STOP, never respawn.
      progressMark: () => 0,
      readProgressMark: () => 0,
    });
    expect(r).toBe("no-progress-stopped");
    expect(emit.calls.length).toBe(0);
    expect(reviveDispatch.calls.length).toBe(0);
    expect(appendEscalated.calls[0][0].reason).toBe("no-progress");
    expect(applyLabel.calls[0][0].ticket).toBe("CTL-9");
  });

  // CTL-587: this case used to return 'not-done' (the other silent dead-end).
  // It now enters the revive path. With reviveCount=0 and storm window open
  // the return is 'revived' and the dispatcher seam fires once.
  test("CTL-587: dead worker + probe says NOT done → 'revived' (first attempt)", () => {
    const emit = recorder({ code: 0 });
    const appendRevive = recorder(undefined);
    const reviveDispatch = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => null, // bg dead
      probes: { implement: recorder(false) }, // probe: work NOT done
      emitComplete: emit,
      appendEvent: recorder(undefined),
      appendReviveEvent: appendRevive,
      reviveDispatch,
      countReviveEvents: recorder(0),
      countDistinctRevivingTickets: recorder(1),
      writeReviveMarker: recorder(undefined),
      killBgJob: recorder(undefined),
      applyStalledLabel: recorder({ applied: true }),
    });
    expect(r).toBe("revived");
    expect(emit.calls.length).toBe(0); // CTL-574 reclaim path NOT taken
    expect(appendRevive.calls.length).toBe(1);
    expect(reviveDispatch.calls.length).toBe(1);
  });

  test("'reclaimed' fires append-event THEN emit-complete (in that order, with full flag set)", () => {
    const order = [];
    const appendEvent = (...args) => {
      order.push(["append", ...args]);
    };
    const emit = (...args) => {
      order.push(["emit", ...args]);
      return { code: 0 };
    };
    const sig = implementSignal();
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => null, // bg dead
      probes: { implement: () => true }, // work done
      emitComplete: emit,
      appendEvent,
      postReclaimMirror: () => {}, // CTL-664: keep the test hermetic (no linearis spawn)
      repoRoot: "/repo",
    });
    expect(r).toBe("reclaimed");
    // order: append first, then emit.
    expect(order[0][0]).toBe("append");
    expect(order[1][0]).toBe("emit");
    // append-event payload includes the phase + ticket + orch id (CTL-574) PLUS
    // the CTL-664 enrichment.
    expect(order[0][1]).toMatchObject({
      phase: "implement",
      ticket: "CTL-9",
      orchId: "CTL-9",
      death_signal: "dead-gone", // statJob:()=>null → jobLifecycle 'dead-gone'
      probe_passed: true,
      probe_checked: expect.any(String),
      completion_origin: "inferred",
      reclaimed_bg_job_id: "job-x", // implementSignal default bgJobId
    });
    expect(order[0][1].stopped_bg_job_ids).toEqual([]); // CTL-661 placeholder
    // emit-complete receives the orchDir and the signal.
    expect(order[1][1]).toEqual({ orchDir: orch, signal: sig });
  });

  // CTL-736: mtime is no longer a reclaim trigger, so a reclaim is never
  // labeled death_signal='mtime'. The branch-(B) reclaim is reached only for a
  // dead-terminal or dead-gone job — the death signal must report that
  // jobLifecycle verdict. prev_state_json_mtime survives as pure telemetry (the
  // last state.json write time), independent of the death-signal decision.
  test("CTL-736: reclaim of a dead-terminal worker reports death_signal='dead-terminal' (never 'mtime') + prev_state_json_mtime", () => {
    const staleMtime = 1_000;
    let appended = null;
    const r = reclaimDeadWorkIfPossible(orch, implementSignal({ status: "running" }), {
      // state.json present, stale mtime, but .state terminal → dead-terminal.
      statJob: () => ({ exists: true, mtimeMs: staleMtime, state: "stopped" }),
      probes: { implement: () => true },
      emitComplete: () => ({ code: 0 }),
      appendEvent: (args) => {
        appended = args;
      },
      postReclaimMirror: () => {}, // keep hermetic (no linearis spawn)
      repoRoot: "/repo",
    });
    expect(r).toBe("reclaimed");
    expect(appended.death_signal).toBe("dead-terminal");
    expect(appended.death_signal).not.toBe("mtime");
    expect(appended.prev_state_json_mtime).toBe(staleMtime);
  });

  test("'reclaim-failed' when emit-complete returns non-zero (event still appended)", () => {
    const appendEvent = recorder(undefined);
    const emit = recorder({ code: 1, stderr: "boom" });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => null,
      probes: { implement: () => true },
      emitComplete: emit,
      appendEvent,
    });
    expect(r).toBe("reclaim-failed");
    expect(appendEvent.calls.length).toBe(1);
    expect(emit.calls.length).toBe(1);
  });

  test("repoRoot + orchDir are forwarded to the probe (CTL-641: probes resolve worker-dir + worktree artifacts)", () => {
    let seen = null;
    const probe = (args) => {
      seen = args;
      return true;
    };
    reclaimDeadWorkIfPossible(orch, implementSignal({ ticket: "CTL-42" }), {
      statJob: () => null,
      probes: { implement: probe },
      emitComplete: () => ({ code: 0 }),
      appendEvent: () => {},
      postReclaimMirror: () => {}, // CTL-664: keep the test hermetic (no linearis spawn)
      repoRoot: "/repo/x",
    });
    // orchDir is the function's first positional arg (`orch` === "/orch").
    expect(seen).toEqual({ ticket: "CTL-42", repoRoot: "/repo/x", orchDir: orch });
  });

  // CTL-641: a dead NON-implement worker is reclaimed when its probe says the
  // artifact is complete (branch B). When the probe says it is NOT complete it
  // enters CTL-604's phase-agnostic revive path (branch C) — CTL-604 removed the
  // earlier "re-dispatch stays implement-only" rule, so every probe-backed phase
  // (including the CTL-641 JSON worker-dir phases) is re-dispatched fresh rather
  // than dead-ended at needs-human.
  test("CTL-641: non-implement phase with probe true → 'reclaimed' (emit-complete called)", () => {
    const sig = { ...implementSignal({ ticket: "CTL-7" }), phase: "verify" };
    sig.raw.phase = "verify";
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => null, // bg dead
      probes: { verify: () => true }, // artifact complete
      emitComplete: emit,
      appendEvent: recorder(undefined),
      postReclaimMirror: () => {}, // CTL-664: keep the test hermetic (no linearis spawn)
      repoRoot: "/repo",
    });
    expect(r).toBe("reclaimed");
    expect(emit.calls.length).toBe(1);
  });

  test("CTL-641: non-implement phase with probe false → 'revived' (CTL-604 phase-agnostic re-dispatch)", () => {
    const sig = { ...implementSignal({ ticket: "CTL-7" }), phase: "verify" };
    sig.raw.phase = "verify";
    const emit = recorder({ code: 0 });
    const appendRevive = recorder(undefined);
    const reviveDispatch = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => null, // bg dead
      probes: { verify: () => false }, // artifact NOT complete
      emitComplete: emit,
      appendEvent: recorder(undefined),
      appendReviveEvent: appendRevive,
      reviveDispatch,
      countReviveEvents: recorder(0),
      countDistinctRevivingTickets: recorder(1),
      writeReviveMarker: recorder(undefined),
      killBgJob: recorder(undefined),
      applyStalledLabel: recorder({ applied: true }),
      repoRoot: "/repo",
    });
    expect(r).toBe("revived");
    expect(emit.calls.length).toBe(0); // not reclaimed
    expect(appendRevive.calls.length).toBe(1);
    expect(reviveDispatch.calls.length).toBe(1); // CTL-604: non-implement phases re-dispatch too
  });
});

// --- CTL-736 Phase 2: the state.json death trigger + LIVENESS_SOURCE modes ---

describe("reclaimDeadWorkIfPossible — CTL-736 state.json death trigger", () => {
  const orch = "/orch";

  // Deterministic seam set: all downstream gates open so the verdict from the
  // death trigger is what the test observes. now() is fixed; the breaker/cooldown
  // are stubbed so escalateOnce is hermetic.
  function seams(extra = {}) {
    return {
      repoRoot: "/repo",
      probes: { implement: () => false },
      emitComplete: recorder({ code: 0 }),
      appendEvent: recorder(undefined),
      appendReviveEvent: recorder(true),
      appendEscalatedEvent: recorder(undefined),
      appendReviveSuppressedEvent: recorder(undefined),
      reviveDispatch: recorder({ code: 0 }),
      applyStalledLabel: recorder({ applied: true }),
      killBgJob: recorder(undefined),
      countReviveEvents: recorder(0),
      countDistinctRevivingTickets: recorder(0),
      writeReviveMarker: recorder(undefined),
      resolveSession: () => null,
      postReclaimMirror: recorder(undefined),
      listTicketPhases: () => ["implement"],
      inEscalationCooldownFn: () => false,
      recordEscalationFn: recorder(undefined),
      emitReapIntent: () => Promise.resolve(),
      readBootSince: () => undefined,
      breaker: { isOpen: () => false },
      now: () => 1_000_000,
      ...extra,
    };
  }

  test("alive (state=working) ⇒ 'alive-suppressed' — never reclaimed, no idle streak/grace", () => {
    const r = reclaimDeadWorkIfPossible(orch, implementSignal({ status: "running" }), seams({
      jobLifecycle: () => "alive",
    }));
    expect(r).toBe("alive-suppressed");
  });

  test("dead-terminal + work done ⇒ 'reclaimed' immediately (no grace/streak)", () => {
    const emitComplete = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal({ status: "running" }), seams({
      jobLifecycle: () => "dead-terminal",
      probes: { implement: () => true },
      emitComplete,
    }));
    expect(r).toBe("reclaimed");
    expect(emitComplete.calls.length).toBe(1);
  });

  test("dead-gone + work NOT done ⇒ 'revived' immediately, even with a fresh startedAt (no grace window)", () => {
    const reviveDispatch = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(
      orch,
      // startedAt = now: pre-CTL-736 this was deferred 'revive-pending' by the 90s grace.
      implementSignal({ status: "running", startedAt: new Date(1_000_000).toISOString() }),
      seams({ jobLifecycle: () => "dead-gone", reviveDispatch }),
    );
    expect(r).toBe("revived");
    expect(reviveDispatch.calls.length).toBe(1);
  });

  test("the death trigger is jobLifecycle (state.json), consulted with the worker's bg_job_id", () => {
    const jobLifecycle = recorder("alive");
    reclaimDeadWorkIfPossible(orch, implementSignal({ status: "running", bgJobId: "bg-77" }), seams({
      jobLifecycle,
    }));
    expect(jobLifecycle.calls.length).toBe(1);
    expect(jobLifecycle.calls[0][0]).toBe("bg-77");
  });

  test("alive past BUSY_CEILING_MS with no committed work ⇒ 'escalated' (no silent reclaim)", () => {
    const appendEscalatedEvent = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(
      orch,
      implementSignal({ status: "running", startedAt: new Date(0).toISOString() }),
      seams({
        jobLifecycle: () => "alive",
        busyCeilingMs: 1,
        now: () => 10_000,
        probes: { implement: () => false },
        appendEscalatedEvent,
      }),
    );
    expect(r).toBe("escalated");
    expect(appendEscalatedEvent.calls[0][0].reason).toBe("busy-ceiling-exceeded");
  });
});

// --- CTL-642: TERMINAL SHORT-CIRCUIT ---------------------------------------
//
// Placed BEFORE the lifecycle/alive branch so it DOMINATES all three escalateOnce
// sites (alive busy-ceiling, no-probe, no-progress). A ticket already terminal
// (Linear Done/Canceled) or whose PR merged must NEVER escalate to needs-human
// nor revive — it flips its signal to done (emitComplete), audits with
// completion_origin:"terminal-short-circuit", and returns the new outcome.
describe("reclaimDeadWorkIfPossible — CTL-642 terminal short-circuit", () => {
  const orch = "/orch";

  // Deterministic seam set with the short-circuit ENABLED (fetchState threaded).
  // Every escalateOnce-feeding gate is reachable; the short-circuit must win.
  function seams(extra = {}) {
    return {
      repoRoot: "/repo",
      probes: { implement: () => false },
      emitComplete: recorder({ code: 0 }),
      appendEvent: recorder(undefined),
      appendReviveEvent: recorder(true),
      appendEscalatedEvent: recorder(undefined),
      appendReviveSuppressedEvent: recorder(undefined),
      reviveDispatch: recorder({ code: 0 }),
      applyStalledLabel: recorder({ applied: true }),
      killBgJob: recorder(undefined),
      countReviveEvents: recorder(0),
      writeReviveMarker: recorder(undefined),
      resolveSession: () => null,
      postReclaimMirror: recorder(undefined),
      listTicketPhases: () => ["implement"],
      inEscalationCooldownFn: () => false,
      recordEscalationFn: recorder(undefined),
      emitReapIntent: () => Promise.resolve(),
      readBootSince: () => undefined,
      breaker: { isOpen: () => false },
      now: () => 1_000_000,
      ...extra,
    };
  }

  // ── PATH 1: alive busy-ceiling. An alive worker past BUSY_CEILING_MS with no
  // committed work would escalate "busy-ceiling-exceeded" — UNLESS terminal.
  test("alive busy-ceiling path: terminal Linear state ⇒ 'terminal-short-circuit', emitComplete, NO escalated event", () => {
    const emitComplete = recorder({ code: 0 });
    const appendEscalatedEvent = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(
      orch,
      implementSignal({ status: "running", startedAt: new Date(0).toISOString() }),
      seams({
        jobLifecycle: () => "alive",
        busyCeilingMs: 1,
        now: () => 10_000,
        probes: { implement: () => false },
        fetchState: () => "Done",
        emitComplete,
        appendEscalatedEvent,
      }),
    );
    expect(r).toBe("terminal-short-circuit");
    expect(emitComplete.calls.length).toBe(1);
    expect(appendEscalatedEvent.calls.length).toBe(0); // never escalated
  });

  // ── PATH 2: no-probe-for-phase. A dead worker on a probe-less phase escalates
  // "no-probe-for-phase" — UNLESS terminal.
  test("no-probe path: merged PR ⇒ 'terminal-short-circuit', emitComplete, NO escalated event", () => {
    const emitComplete = recorder({ code: 0 });
    const appendEscalatedEvent = recorder(undefined);
    const sig = { ...implementSignal({ status: "running" }), phase: "research" };
    sig.raw.phase = "research";
    sig.raw.pr = { number: 7, repo: "o/r" };
    const r = reclaimDeadWorkIfPossible(
      orch,
      sig,
      seams({
        jobLifecycle: () => "dead-gone",
        // research has a probe by default; force the no-probe branch with empty probes
        probes: {},
        listTicketPhases: () => ["research"],
        fetchState: () => "PR", // non-terminal Linear → falls to PR check
        prAdapter: { prView: () => ({ state: "MERGED", mergedAt: "2026-06-04T00:00:00Z" }) },
        emitComplete,
        appendEscalatedEvent,
      }),
    );
    expect(r).toBe("terminal-short-circuit");
    expect(emitComplete.calls.length).toBe(1);
    expect(appendEscalatedEvent.calls.length).toBe(0);
  });

  // ── PATH 3: no-progress. A dead worker with zero forward progress would be
  // stopped + escalated "no-progress" — UNLESS terminal.
  test("no-progress path: terminal Linear state ⇒ 'terminal-short-circuit', emitComplete, NO escalated event", () => {
    const emitComplete = recorder({ code: 0 });
    const appendEscalatedEvent = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(
      orch,
      implementSignal({ status: "running" }),
      seams({
        jobLifecycle: () => "dead-gone",
        probes: { implement: () => false }, // work not done → would head to no-progress
        progressMark: () => 0,
        readProgressMark: () => 0, // 0 <= 0 → no-progress STOP
        fetchState: () => "Canceled",
        emitComplete,
        appendEscalatedEvent,
      }),
    );
    expect(r).toBe("terminal-short-circuit");
    expect(emitComplete.calls.length).toBe(1);
    expect(appendEscalatedEvent.calls.length).toBe(0);
  });

  test("audit event carries completion_origin:'terminal-short-circuit'", () => {
    const appendEvent = recorder(undefined);
    reclaimDeadWorkIfPossible(
      orch,
      implementSignal({ status: "running" }),
      seams({ jobLifecycle: () => "dead-gone", fetchState: () => "Done", appendEvent }),
    );
    expect(appendEvent.calls.length).toBe(1);
    expect(appendEvent.calls[0][0].completion_origin).toBe("terminal-short-circuit");
  });

  test("NON-terminal + open PR ⇒ does NOT short-circuit (normal path runs)", () => {
    const emitComplete = recorder({ code: 0 });
    const appendEscalatedEvent = recorder(undefined);
    const sig = implementSignal({ status: "running", startedAt: new Date(0).toISOString() });
    sig.raw.pr = { number: 7, repo: "o/r" };
    const r = reclaimDeadWorkIfPossible(
      orch,
      sig,
      seams({
        jobLifecycle: () => "alive",
        busyCeilingMs: 1,
        now: () => 10_000,
        probes: { implement: () => false },
        fetchState: () => "PR",
        prAdapter: { prView: () => ({ state: "OPEN", mergedAt: null }) },
        emitComplete,
        appendEscalatedEvent,
      }),
    );
    expect(r).not.toBe("terminal-short-circuit");
    expect(r).toBe("escalated"); // the busy-ceiling escalation runs as before
    expect(appendEscalatedEvent.calls.length).toBe(1);
  });

  test("INERT when no fetchState threaded (legacy callers unchanged)", () => {
    // No fetchState/prAdapter → isTicketTerminalOrMerged no-ops → normal escalate.
    const appendEscalatedEvent = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(
      orch,
      implementSignal({ status: "running", startedAt: new Date(0).toISOString() }),
      seams({
        jobLifecycle: () => "alive",
        busyCeilingMs: 1,
        now: () => 10_000,
        probes: { implement: () => false },
        appendEscalatedEvent,
        // no fetchState
      }),
    );
    expect(r).toBe("escalated");
    expect(appendEscalatedEvent.calls[0][0].reason).toBe("busy-ceiling-exceeded");
  });

  test("a failed emitComplete falls through to the normal lifecycle path (never strands)", () => {
    const appendEscalatedEvent = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(
      orch,
      implementSignal({ status: "running", startedAt: new Date(0).toISOString() }),
      seams({
        jobLifecycle: () => "alive",
        busyCeilingMs: 1,
        now: () => 10_000,
        probes: { implement: () => false },
        fetchState: () => "Done",
        emitComplete: recorder({ code: 1, stderr: "emit boom" }),
        appendEscalatedEvent,
      }),
    );
    // emitComplete failed → did NOT return terminal-short-circuit; the alive
    // busy-ceiling escalation ran as the fallthrough.
    expect(r).toBe("escalated");
  });
});

// --- CTL-661 Phase 2: reap-intent on the reclaim happy path (B) -------------
//
// When a stale-by-mtime worker reaches branch (B) (probe says work IS done) it
// has already cleared the hoisted alive-quiet gate, so it is either pid-dead or
// genuinely hung. Before emitComplete, the reclaim emits a fire-and-forget
// phase.reclaim.reap-requested so the reaper stops any lingering session.
describe("reclaimDeadWorkIfPossible — CTL-661 reclaim happy-path reap-intent", () => {
  const orch = "/orch";

  // A stale (6-min-quiet) running implement signal that reaches branch (B):
  // probe true, pidAlive false (so the alive-quiet gate does NOT suppress).
  function staleReclaimable({ bgJobId = "job-x", worktreePath = "/wt/CTL-9" } = {}) {
    const sig = implementSignal({ bgJobId });
    sig.raw.worktreePath = worktreePath;
    return sig;
  }

  test("branch (B) emits phase.reclaim.reap-requested with bgJobId before reclaiming", () => {
    const emitReap = recorder(Promise.resolve(true));
    const r = reclaimDeadWorkIfPossible(orch, staleReclaimable(), {
      statJob: () => ({ exists: true, mtimeMs: 1_000 }),
      jobLifecycle: () => "dead-gone", // CTL-736: reclaim-eligible via state.json
      probes: { implement: () => true },
      emitComplete: recorder({ code: 0 }),
      appendEvent: recorder(undefined),
      emitReapIntent: emitReap,
      now: () => 1_000 + 6 * 60 * 1000,
    });
    expect(r).toBe("reclaimed");
    expect(emitReap.calls.length).toBe(1);
    const [eventType, fields] = emitReap.calls[0];
    expect(eventType).toBe("phase.reclaim.reap-requested");
    expect(fields).toMatchObject({
      ticket: "CTL-9",
      phase: "implement",
      bgJobId: "job-x",
      worktreePath: "/wt/CTL-9",
      reason: "ctl-661-reclaim-happy-path",
    });
  });

  test("branch (B) does NOT emit a reap-intent when the worker has no bg_job_id", () => {
    // liveness.value present (so statJob can stale-flag it) but raw.bg_job_id
    // absent — mirrors the supersede-guard no-op.
    const sig = {
      ticket: "CTL-9",
      phase: "implement",
      status: "running",
      liveness: { kind: "bg", value: "job-x" },
      signalPath: "/x/CTL-9/phase-implement.json",
      raw: {
        ticket: "CTL-9",
        phase: "implement",
        orchestrator: "CTL-9",
        status: "running",
        catalystSessionId: "sess_CTL-9_abc",
        // no bg_job_id
      },
    };
    const emitReap = recorder(Promise.resolve(true));
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => ({ exists: true, mtimeMs: 1_000 }),
      jobLifecycle: () => "dead-gone", // CTL-736: reclaim-eligible via state.json
      probes: { implement: () => true },
      emitComplete: recorder({ code: 0 }),
      appendEvent: recorder(undefined),
      emitReapIntent: emitReap,
      now: () => 1_000 + 6 * 60 * 1000,
    });
    expect(r).toBe("reclaimed");
    expect(emitReap.calls.length).toBe(0);
  });
});

// --- CTL-664: reclaim Linear mirror -----------------------------------------
//
// On the successful reclaim path (branch B) the daemon posts the "Phase Reclaim"
// Linear comment the dead worker's skill End block never ran. The seam is
// marker-guarded (first-writer-wins vs a surviving skill mirror) and fail-open.
describe("CTL-664: reclaim Linear mirror", () => {
  const orch = "/orch";

  test("postReclaimMirror is called once on a successful reclaim, after emit-complete", () => {
    const order = [];
    reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => null,
      probes: { implement: () => true },
      emitComplete: () => {
        order.push("emit");
        return { code: 0 };
      },
      appendEvent: () => order.push("append"),
      postReclaimMirror: (args) => order.push(["mirror", args]),
      repoRoot: "/repo",
    });
    expect(order).toEqual([
      "append",
      "emit",
      [
        "mirror",
        expect.objectContaining({
          orchDir: orch,
          ticket: "CTL-9",
          phase: "implement",
          deathSignal: "dead-gone", // statJob:()=>null → jobLifecycle 'dead-gone'
          reclaimedBgJobId: "job-x", // implementSignal default bgJobId
        }),
      ],
    ]);
  });

  test("postReclaimMirror is NOT called when emit-complete fails (reclaim-failed)", () => {
    const mirror = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => null,
      probes: { implement: () => true },
      emitComplete: () => ({ code: 1, stderr: "boom" }),
      appendEvent: () => {},
      postReclaimMirror: mirror,
    });
    expect(r).toBe("reclaim-failed");
    expect(mirror.calls.length).toBe(0);
  });
});

// defaultPostReclaimMirror — driven through its injected existsSync / writeMarker
// / runCommentPost seams (no filesystem or network I/O in the test). CTL-550.
describe("defaultPostReclaimMirror (CTL-664)", () => {
  const base = {
    orchDir: "/orch",
    ticket: "CTL-9",
    phase: "implement",
    deathSignal: "absent",
    probeChecked: "commits ahead of origin/main",
    reclaimedBgJobId: "job-x",
  };

  test("marker absent → posts the comment and writes the marker", () => {
    const written = [];
    const post = recorder({ status: 0 });
    defaultPostReclaimMirror(base, {
      existsSync: () => false,
      writeMarker: (p) => written.push(p),
      runCommentPost: post,
    });
    expect(post.calls.length).toBe(1);
    const [t, body] = post.calls[0];
    expect(t).toBe("CTL-9");
    expect(body).toContain("**Phase Reclaim**");
    expect(body).toContain("work-done-despite-dead-bg");
    expect(body).toContain("absent");
    expect(written).toEqual(["/orch/workers/CTL-9/.linear-mirror-implement"]);
  });

  test("marker present → skips the post (first-writer-wins)", () => {
    const post = recorder({ status: 0 });
    const written = [];
    defaultPostReclaimMirror(base, {
      existsSync: () => true,
      writeMarker: (p) => written.push(p),
      runCommentPost: post,
    });
    expect(post.calls.length).toBe(0);
    expect(written.length).toBe(0);
  });

  test("runCommentPost non-zero → no marker written, no throw (fail-open)", () => {
    const written = [];
    expect(() =>
      defaultPostReclaimMirror(base, {
        existsSync: () => false,
        writeMarker: (p) => written.push(p),
        runCommentPost: () => ({ status: 1, stderr: "offline" }),
      }),
    ).not.toThrow();
    expect(written.length).toBe(0);
  });

  test("runCommentPost throws → swallowed, no marker, no throw (fail-open)", () => {
    const written = [];
    expect(() =>
      defaultPostReclaimMirror(base, {
        existsSync: () => false,
        writeMarker: (p) => written.push(p),
        runCommentPost: () => {
          throw new Error("spawn EACCES");
        },
      }),
    ).not.toThrow();
    expect(written.length).toBe(0);
  });
});

// --- CTL-587: revive / revive-suppressed / escalated branches ---------------
//
// The pre-CTL-587 'not-applicable' and 'not-done' returns were silent dead-ends.
// CTL-587 turns them into actions:
//   - 'not-applicable' (no probe)             → 'escalated' + needs-human label
//   - 'not-done' + budget available + no storm → 'revived' (re-dispatch)
//   - 'not-done' + budget exhausted           → 'escalated' + needs-human label
//   - 'not-done' + storm-breaker open         → 'revive-suppressed' (next tick)

describe("reclaimDeadWorkIfPossible — CTL-587 revive/suppress/escalate", () => {
  // setupReviveScenario stages an effectively-dead worker (running signal +
  // stale state.json mtime) and threads every CTL-587 seam through opts.
  function setupReviveScenario({
    reviveCount = 0,
    probeResult = false, // false = "work not done" → enters CTL-587 territory
    phase = "implement",
    ticket = "CTL-9",
    bgJobId = "bg-9",
    stateJsonMtime = 1_000, // far in the past — staleness triggers
    nowMs = 1_000 + 6 * 60 * 1000, // 6 min past mtime — > STALE_MS
    // CTL-655: boot-time window seam. Default to a no-marker reader so every
    // existing scenario behaves exactly as before (since=undefined → the
    // injected countReviveEvents recorder value is the unwindowed attempt count).
    readBootSince = () => undefined,
    // CTL-736 Phase 3: progress gate. Default = progressed (current 1 > prior 0)
    // so the scenario revives; noProgress:true → current 0 <= prior 0 → STOP path.
    noProgress = false,
  } = {}) {
    const sig = {
      ...implementSignal({ ticket, status: "running", bgJobId }),
      phase,
    };
    sig.raw.phase = phase;
    return {
      orch: "/orch",
      sig,
      opts: {
        repoRoot: "/repo",
        statJob: () => ({ exists: true, mtimeMs: stateJsonMtime }),
        // CTL-641: every pipeline phase now has a probe, so inject one for
        // whatever phase the scenario uses (an unregistered phase still hits
        // branch (A) before the probe is dereferenced, so a stub is harmless).
        probes: { [phase]: recorder(probeResult) },
        emitComplete: recorder({ code: 0 }),
        appendEvent: recorder(undefined),
        appendReviveEvent: recorder(undefined),
        appendEscalatedEvent: recorder(undefined),
        appendReviveSuppressedEvent: recorder(undefined),
        reviveDispatch: recorder({ code: 0 }),
        applyStalledLabel: recorder({ applied: true }),
        killBgJob: recorder(undefined),
        countReviveEvents: recorder(reviveCount),
        writeReviveMarker: recorder(undefined),
        // CTL-664: stub the reclaim mirror so the probeResult:true scenarios
        // (branch B) stay hermetic and don't spawn a real `linearis`.
        postReclaimMirror: recorder(undefined),
        readBootSince, // CTL-655: inject the boot-time window reader
        // CTL-736: the death trigger is now the state.json lifecycle (jobLifecycle),
        // not the `claude agents` snapshot. "dead-gone" (the job dir vanished) is
        // the reclaim-eligible case these revive/escalate scenarios exercise.
        // statJob above still supplies the prev_state_json_mtime telemetry.
        jobLifecycle: () => "dead-gone",
        // CTL-736 Phase 3 progress-gate seams (replace MAX_REVIVES/storm/per-tick).
        progressMark: () => (noProgress ? 0 : 1),
        readProgressMark: () => 0,
        writeProgressMark: recorder(undefined),
        now: () => nowMs,
      },
    };
  }

  test("first revive: count=0, no storm → 'revived', event before dispatch, marker written", () => {
    const s = setupReviveScenario({ reviveCount: 0 });
    const r = reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(r).toBe("revived");
    expect(s.opts.appendReviveEvent.calls.length).toBe(1);
    expect(s.opts.reviveDispatch.calls.length).toBe(1);
    expect(s.opts.writeReviveMarker.calls.length).toBe(1);
    expect(s.opts.appendReviveEvent.calls[0][0].attempt).toBe(1);
  });

  test("second revive: count=1 → still 'revived', attempt=2", () => {
    const s = setupReviveScenario({ reviveCount: 1 });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("revived");
    expect(s.opts.appendReviveEvent.calls[0][0].attempt).toBe(2);
  });

  // CTL-736 Phase 3: the MAX_REVIVES budget-exhausted escalation and the
  // fleet-wide storm-breaker (revive-suppressed) are DELETED — a worker now
  // revives as long as it makes forward progress, and STOPS (no-progress-stopped)
  // when it does not. The escalation MECHANISM (CTL-679 breaker, CTL-638 cool-down)
  // is now exercised through that no-progress STOP path instead of budget-exhausted.

  test("CTL-679: breaker open on the no-progress STOP → 'rate-limited-deferred', no escalation event, no label write", () => {
    const s = setupReviveScenario({ noProgress: true }); // zero progress → STOP path
    const r = reclaimDeadWorkIfPossible(s.orch, s.sig, {
      ...s.opts,
      breaker: { isOpen: () => true },
    });
    expect(r).toBe("rate-limited-deferred");
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(0);
    expect(s.opts.applyStalledLabel.calls.length).toBe(0);
    expect(s.opts.reviveDispatch.calls.length).toBe(0); // never respawned
  });

  test("CTL-679: breaker closed on the no-progress STOP → 'no-progress-stopped', needs-human applied, no respawn", () => {
    const s = setupReviveScenario({ noProgress: true });
    const r = reclaimDeadWorkIfPossible(s.orch, s.sig, {
      ...s.opts,
      breaker: { isOpen: () => false },
    });
    expect(r).toBe("no-progress-stopped");
    expect(s.opts.appendEscalatedEvent.calls[0][0].reason).toBe("no-progress");
    expect(s.opts.applyStalledLabel.calls.length).toBe(1);
    expect(s.opts.reviveDispatch.calls.length).toBe(0); // never respawned
    expect(s.opts.killBgJob.calls.length).toBe(1); // the dead worker is stopped
  });

  // CTL-604: research/plan now share the bounded revive/re-dispatch path with
  // implement. A worker that died before writing its artifact (probe=false) is
  // re-dispatched, not dead-ended at needs-human.
  test("dead research worker, probe NOT done, budget+storm OK → 'revived', no escalation", () => {
    const s = setupReviveScenario({ phase: "research", probeResult: false, reviveCount: 0 });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("revived");
    expect(s.opts.reviveDispatch.calls.length).toBe(1);
    expect(s.opts.appendReviveEvent.calls.length).toBe(1);
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(0);
  });

  // CTL-655: the daemon-boot timestamp must reach countReviveEvents as `since`
  // so the per-ticket budget windows to the current daemon run.
  test("threads boot 'since' into countReviveEvents", () => {
    const s = setupReviveScenario({
      reviveCount: 0,
      readBootSince: () => "2026-05-27T03:30:00Z",
    });
    const r = reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(r).toBe("revived");
    // The boot value reached the budget counter…
    expect(s.opts.countReviveEvents.calls[0][0].since).toBe("2026-05-27T03:30:00Z");
    // …and the pre-existing args are still passed (no regression).
    expect(s.opts.countReviveEvents.calls[0][0].ticket).toBe("CTL-9");
    expect(s.opts.countReviveEvents.calls[0][0]).toHaveProperty("orchId");
  });

  // CTL-655: the boot 'since' windows the attempt counter; a missing marker is
  // fail-open (since=undefined → unwindowed count). CTL-736: the count is now the
  // revive ATTEMPT NUMBER (telemetry), not a budget gate, so the worker revives.
  test("omits 'since' when boot marker is absent (fail-open)", () => {
    const s = setupReviveScenario({
      reviveCount: 2,
      readBootSince: () => undefined,
    });
    const r = reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(r).toBe("revived"); // CTL-736: no MAX_REVIVES gate — progress drives it
    expect(s.opts.countReviveEvents.calls[0][0].since).toBeUndefined();
    expect(s.opts.appendReviveEvent.calls[0][0].attempt).toBe(3); // count 2 + 1
  });

  test("dead plan worker, probe NOT done → 'revived'", () => {
    const s = setupReviveScenario({ phase: "plan", probeResult: false, reviveCount: 0 });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("revived");
    expect(s.opts.reviveDispatch.calls.length).toBe(1);
  });

  test("CTL-662: defensive stop fires on the revive path unconditionally (the mtime quiet-window gate is gone)", () => {
    // Pre-CTL-662 the kill was gated on KILL_RECENT_ACTIVITY_MS (state.json quiet
    // for ≥30s). CTL-662 removed that gate: a reclaim-eligible worker (absent, or
    // idle-confirmed) is by definition not mid-turn, so the stop is always safe.
    // It now fires whenever the revive path runs with a known bg_job_id.
    const s = setupReviveScenario(); // liveness "absent", probe false → revive
    reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(s.opts.killBgJob.calls.length).toBe(1);
    expect(s.opts.killBgJob.calls[0][0].bgJobId).toBe("bg-9");
  });

  test("revive event payload contains attempt, reason, prev_state_json_mtime, prev_bg_job_id", () => {
    const s = setupReviveScenario({ reviveCount: 0 });
    reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    const body = s.opts.appendReviveEvent.calls[0][0];
    expect(body.attempt).toBe(1);
    expect(body.reason).toBe("work-not-done-after-stale-bg");
    expect(typeof body.prev_state_json_mtime).toBe("number");
    expect(body.prev_bg_job_id).toBe("bg-9");
  });

  test("no-progress escalation still records the outcome even when applyStalledLabel fails (no dispatch)", () => {
    // CTL-736: a failed label apply still returns 'no-progress-stopped' so the
    // scheduler records the outcome. labelOnce guards re-application — a
    // verify-failed result returns no marker, so the next tick retries the apply.
    const s = setupReviveScenario({ noProgress: true });
    s.opts.applyStalledLabel = recorder({ applied: false, reason: "verify-failed" });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("no-progress-stopped");
    expect(s.opts.reviveDispatch.calls.length).toBe(0);
  });

  test("revive emits event BEFORE dispatch (audit-survives-crash ordering)", () => {
    // If the daemon crashes mid-revive AFTER appending the event but BEFORE
    // dispatch, the next tick correctly sees attempt N in events.jsonl and
    // enters attempt N+1. The reverse order would lose the attempt counter.
    const order = [];
    const s = setupReviveScenario({ reviveCount: 0 });
    s.opts.appendReviveEvent = (...args) => {
      order.push(["event", ...args]);
    };
    s.opts.reviveDispatch = (...args) => {
      order.push(["dispatch", ...args]);
      return { code: 0 };
    };
    reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(order[0][0]).toBe("event");
    expect(order[1][0]).toBe("dispatch");
  });

  test("revive dispatch failure does NOT write the marker (next tick retries)", () => {
    const s = setupReviveScenario({ reviveCount: 0 });
    s.opts.appendReviveEvent = recorder(true); // event lands
    s.opts.reviveDispatch = recorder({ code: 1, stderr: "dispatch boom" });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("revived");
    // The event still gets appended (it tracks the attempt), but the marker
    // is only written on a successful dispatch.
    expect(s.opts.appendReviveEvent.calls.length).toBe(1);
    expect(s.opts.writeReviveMarker.calls.length).toBe(0);
  });

  // Audit-budget invariant: if the revive event append fails (disk full,
  // EROFS, permissions), the per-ticket counter cannot be enforced on the
  // next tick. Better to skip the dispatch and retry next tick than to spawn
  // a worker we cannot account for. Returns 'revive-suppressed' so the
  // scheduler logs the suppression and re-evaluates.
  test("audit-append failure → 'revive-suppressed', dispatch NOT invoked, no marker", () => {
    const s = setupReviveScenario({ reviveCount: 0 });
    s.opts.appendReviveEvent = recorder(false); // simulate append failure
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("revive-suppressed");
    expect(s.opts.reviveDispatch.calls.length).toBe(0);
    expect(s.opts.writeReviveMarker.calls.length).toBe(0);
    // Operator forensics trail: a 'revive-suppressed' audit event is emitted
    // with reason: audit-append-failed so the suppression is visible in
    // events.jsonl (distinct from the storm-breaker case).
    expect(s.opts.appendReviveSuppressedEvent.calls.length).toBe(1);
    expect(s.opts.appendReviveSuppressedEvent.calls[0][0].reason).toBe("audit-append-failed");
  });

  // CTL-662: the pre-CTL-662 "no kill within the quiet window" case is gone —
  // the mtime quiet-window gate no longer exists. The only remaining "no kill"
  // scenario is CTL-658 resume-on-revive (the session's jsonl must stay intact
  // for --resume), exercised below.

  // ── CTL-658: resume-on-revive. When a resume UUID resolves from the dead
  //    worker's bg_job_id, the revive dispatches with `resumeSession` AND skips
  //    the defensive kill (we are continuing the session, not retiring it).
  test("CTL-658: resolved resume UUID is forwarded to reviveDispatch", () => {
    const s = setupReviveScenario({ reviveCount: 0 });
    s.opts.resolveSession = recorder("uuid-1");
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("revived");
    expect(s.opts.reviveDispatch.calls.length).toBe(1);
    expect(s.opts.reviveDispatch.calls[0][0].resumeSession).toBe("uuid-1");
    // The resolver was asked about the dead worker's bg_job_id.
    expect(s.opts.resolveSession.calls[0][0]).toBe("bg-9");
  });

  test("CTL-658: resume viable → defensive kill is SKIPPED", () => {
    // Same quiet-state fixture that fires the kill in the test above, but with a
    // resolvable session: the kill must not fire (its jsonl must stay intact).
    const s = setupReviveScenario({
      stateJsonMtime: 1_000,
      nowMs: 1_000 + 6 * 60 * 1000, // 6min past — stale + past kill threshold
    });
    s.opts.resolveSession = () => "uuid-1";
    reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(s.opts.killBgJob.calls.length).toBe(0);
    expect(s.opts.reviveDispatch.calls[0][0].resumeSession).toBe("uuid-1");
  });

  test("CTL-658: unresumable (resolver null) → kill fires, no resumeSession (unchanged)", () => {
    const s = setupReviveScenario({
      stateJsonMtime: 1_000,
      nowMs: 1_000 + 6 * 60 * 1000,
    });
    s.opts.resolveSession = () => null;
    reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(s.opts.killBgJob.calls.length).toBe(1);
    // resumeSession is null on the dispatch (the fresh-start path).
    expect(s.opts.reviveDispatch.calls[0][0].resumeSession).toBeNull();
  });

  // CTL-761: attempt is the DISPATCH ordinal (revive ordinal + 1), so the
  // revived worker's signal.attempt carries a value > 1 → revive_count > 0.
  test("CTL-761: first revive (priorRevives=0) forwards attempt=2 (dispatch ordinal) to reviveDispatch", () => {
    const s = setupReviveScenario({ reviveCount: 0 });
    reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(s.opts.reviveDispatch.calls.length).toBe(1);
    // revive ordinal = 0+1=1; dispatch ordinal = 1+1=2
    expect(s.opts.reviveDispatch.calls[0][0].attempt).toBe(2);
  });

  test("CTL-761: second revive (priorRevives=1) forwards attempt=3 to reviveDispatch", () => {
    const s = setupReviveScenario({ reviveCount: 1 });
    reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    // revive ordinal = 1+1=2; dispatch ordinal = 2+1=3
    expect(s.opts.reviveDispatch.calls[0][0].attempt).toBe(3);
  });
});

// --- CTL-736 Phase 3: the progress gate (revive-while-progressing vs stop) -----

describe("reclaimDeadWorkIfPossible — CTL-736 progress gate", () => {
  const orch = "/orch";

  // A reclaim-eligible (dead-gone), work-not-done worker with the downstream
  // revive/escalate seams stubbed; progressMark / readProgressMark are the levers.
  function gateSeams(extra = {}) {
    return {
      repoRoot: "/repo",
      jobLifecycle: () => "dead-gone",
      probes: { implement: () => false }, // work NOT done → branch (C)
      emitComplete: recorder({ code: 0 }),
      appendEvent: recorder(undefined),
      appendReviveEvent: recorder(true),
      appendEscalatedEvent: recorder(undefined),
      appendReviveSuppressedEvent: recorder(undefined),
      reviveDispatch: recorder({ code: 0 }),
      applyStalledLabel: recorder({ applied: true }),
      killBgJob: recorder(undefined),
      countReviveEvents: recorder(0),
      writeReviveMarker: recorder(undefined),
      writeProgressMark: recorder(undefined),
      resolveSession: () => null,
      readBootSince: () => undefined,
      inEscalationCooldownFn: () => false,
      recordEscalationFn: recorder(undefined),
      emitReapIntent: () => Promise.resolve(),
      breaker: { isOpen: () => false },
      now: () => 1_000_000,
      ...extra,
    };
  }

  test("progress advanced since the last attempt ⇒ 'revived' + new high-water recorded (gen+1 via dispatch)", () => {
    const writeProgressMark = recorder(undefined);
    const reviveDispatch = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal({ status: "running" }), gateSeams({
      progressMark: () => 5, // 5 commits now…
      readProgressMark: () => 2, // …vs 2 recorded → advanced
      writeProgressMark,
      reviveDispatch,
    }));
    expect(r).toBe("revived");
    expect(reviveDispatch.calls.length).toBe(1);
    expect(writeProgressMark.calls.length).toBe(1);
    expect(writeProgressMark.calls[0]).toEqual([orch, "CTL-9", "implement", 5]);
  });

  test("zero progress since the last attempt ⇒ 'no-progress-stopped', NEVER respawned + needs-human", () => {
    const reviveDispatch = recorder({ code: 0 });
    const appendEscalatedEvent = recorder(undefined);
    const killBgJob = recorder(undefined);
    const writeProgressMark = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(orch, implementSignal({ status: "running" }), gateSeams({
      progressMark: () => 2, // unchanged…
      readProgressMark: () => 2, // …same high-water → no forward progress
      reviveDispatch,
      appendEscalatedEvent,
      killBgJob,
      writeProgressMark,
    }));
    expect(r).toBe("no-progress-stopped");
    expect(reviveDispatch.calls.length).toBe(0); // the futile respawn is suppressed
    expect(appendEscalatedEvent.calls[0][0].reason).toBe("no-progress");
    expect(killBgJob.calls.length).toBe(1); // the dead worker is stopped
    expect(writeProgressMark.calls.length).toBe(0); // no new high-water on a stop
  });

  test("first death with no prior mark (readProgressMark -1) always gets one revive — even at zero progress", () => {
    const reviveDispatch = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal({ status: "running" }), gateSeams({
      progressMark: () => 0, // a worker that crashed before its first commit…
      readProgressMark: () => -1, // …no prior mark → 0 > -1 → one retry
      reviveDispatch,
    }));
    expect(r).toBe("revived");
    expect(reviveDispatch.calls.length).toBe(1);
  });

  test("the SECOND zero-progress death (mark now recorded at 0) stops — bounds the futile loop", () => {
    const reviveDispatch = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal({ status: "running" }), gateSeams({
      progressMark: () => 0,
      readProgressMark: () => 0, // the first revive recorded 0; still 0 → stop
      reviveDispatch,
    }));
    expect(r).toBe("no-progress-stopped");
    expect(reviveDispatch.calls.length).toBe(0);
  });
});

// CTL-736 Phase 2: the CTL-662 busy-suppression and idle-confirmation+absent
// describe blocks are DELETED. The busy/idle/absent three-valued `claude agents`
// snapshot trigger is replaced by the state.json lifecycle (jobLifecycle →
// alive | dead-terminal | dead-gone). `alive` (≈ the old `busy`) is covered by
// the new "CTL-736 state.json death trigger" block + the main-block alive tests;
// dead-terminal/dead-gone reclaim/revive is covered by the CTL-587 block. The
// idle-confirmation streak and its markers no longer exist.

// --- CTL-638: per-(ticket, phase) escalation cool-down ---------------------
//
// Pre-CTL-638 the recovery sweep re-fired `appendEscalatedEvent` +
// `applyStalledLabel` on every tick the same (ticket, phase) classified
// effectively-dead — and each `appendEscalatedEvent` append to events.jsonl
// re-triggered the scheduler's own fs.watch fast path, debouncing to ~2s
// (a self-feeding ~28/min storm that exhausted Linear's 2,500/hr quota in <1h).
//
// The cool-down throttles the audit-event + label-call pair so a tight
// scheduler-tick loop emits at most one escalation per (ticket, phase) per
// window. `applyStalledLabel` is ALSO routed through labelOnce for a second
// layer of protection — if the cool-down marker is deleted mid-incident, the
// `.linear-label-needs-human.applied` marker still prevents re-attempts.

describe("reclaimDeadWorkIfPossible — CTL-638 escalation storm prevention", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl638-"));
  });
  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
  });

  // Re-create setupReviveScenario inline so we can swap `s.orch` to a REAL
  // tmpdir without disturbing the upper-scope helper. The cool-down primitives
  // need a writable orchDir to record markers.
  function setupAt(orchPath, overrides = {}) {
    const sig = {
      ...implementSignal({ ticket: "CTL-9", status: "running", bgJobId: "bg-9" }),
      phase: overrides.phase ?? "implement",
    };
    sig.raw.phase = overrides.phase ?? "implement";
    return {
      orch: orchPath,
      sig,
      opts: {
        repoRoot: "/repo",
        statJob: () => ({ exists: true, mtimeMs: 1_000 }),
        // CTL-736: the death trigger is the state.json lifecycle. "dead-gone"
        // (job dir vanished) is reclaim-eligible, the case these escalation
        // cool-down scenarios exercise.
        jobLifecycle: () => "dead-gone",
        // CTL-736 Phase 3: drive escalation through the reachable no-progress STOP
        // path (zero forward progress → escalateOnce + needs-human, never respawn),
        // replacing the deleted MAX_REVIVES budget-exhausted escalation.
        progressMark: () => 0,
        readProgressMark: () => 0,
        writeProgressMark: recorder(undefined),
        probes: { [overrides.phase ?? "implement"]: recorder(overrides.probeResult ?? false) },
        emitComplete: recorder({ code: 0 }),
        appendEvent: recorder(undefined),
        appendReviveEvent: recorder(undefined),
        appendEscalatedEvent: recorder(undefined),
        appendReviveSuppressedEvent: recorder(undefined),
        reviveDispatch: recorder({ code: 0 }),
        applyStalledLabel: recorder({ applied: true }),
        killBgJob: recorder(undefined),
        countReviveEvents: recorder(overrides.reviveCount ?? 0),
        writeReviveMarker: recorder(undefined),
        now: () => overrides.nowMs ?? 1_000 + 6 * 60 * 1000,
        staleMs: 5 * 60 * 1000,
        // inEscalationCooldownFn / recordEscalationFn use real defaults so we
        // exercise the actual filesystem-backed cool-down primitive end-to-end.
      },
    };
  }

  test("acceptance: second tick on same (ticket, phase) suppresses — exactly one event + one label write", () => {
    const s = setupAt(orchDir, { phase: "pr" }); // branch (C): no-progress STOP

    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("no-progress-stopped");
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(1);
    expect(s.opts.applyStalledLabel.calls.length).toBe(1);

    // 1,500 simulated ticks in the storm window — the escalation cool-down keeps
    // the event + label at exactly one even though every tick re-stops the worker.
    for (let i = 0; i < 1500; i++) {
      expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("no-progress-stopped");
    }
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(1); // NOT 1,501
    expect(s.opts.applyStalledLabel.calls.length).toBe(1); // NOT 1,501
  });

  test("escalation re-fires after the cool-down window elapses", () => {
    let clock = 5_000_000;
    const s = setupAt(orchDir, { phase: "pr", nowMs: clock });
    s.opts.now = () => clock;

    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("no-progress-stopped");
    clock += 10 * 60 * 1000 + 1; // jump past the 10-min default window
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("no-progress-stopped");
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(2);
  });

  test("different phase on the same ticket gets an independent cool-down (pr → monitor-merge advancement)", () => {
    // Reproduces the live CTL-624 timeline: escalations on `pr` for a stretch,
    // then on `monitor-merge` after `pr` completes. Both should escalate; only
    // the WITHIN-phase repeats are suppressed (cool-down keeps the event count
    // pinned, even though the return is no-progress-stopped each time).
    const sPr = setupAt(orchDir, { phase: "pr" });
    expect(reclaimDeadWorkIfPossible(sPr.orch, sPr.sig, sPr.opts)).toBe("no-progress-stopped");
    const eventsAfterPr = sPr.opts.appendEscalatedEvent.calls.length;
    expect(reclaimDeadWorkIfPossible(sPr.orch, sPr.sig, sPr.opts)).toBe("no-progress-stopped");
    expect(sPr.opts.appendEscalatedEvent.calls.length).toBe(eventsAfterPr); // suppressed

    const sMm = setupAt(orchDir, { phase: "monitor-merge" });
    expect(reclaimDeadWorkIfPossible(sMm.orch, sMm.sig, sMm.opts)).toBe("no-progress-stopped");
    expect(sMm.opts.appendEscalatedEvent.calls.length).toBe(1); // independent cool-down → fired
  });

  test("the no-progress escalation branch also respects the cool-down", () => {
    // Repro: implement phase, zero progress → escalation path. Second tick must
    // suppress the escalation event/label just like any other escalation.
    const s = setupAt(orchDir, { phase: "implement" });

    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("no-progress-stopped");
    expect(s.opts.appendEscalatedEvent.calls[0][0].reason).toBe("no-progress");
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("no-progress-stopped");
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(1);
  });

  test("injected cool-down seams (inEscalationCooldownFn / recordEscalationFn) are honored", () => {
    // The cool-down primitives are overridable for tests that want to drive
    // the gate independently of the filesystem (or to assert calls).
    const inCd = recorder(false);
    const recCd = recorder(undefined);
    const s = setupAt(orchDir, { phase: "pr" });
    s.opts.inEscalationCooldownFn = inCd;
    s.opts.recordEscalationFn = recCd;

    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("no-progress-stopped");
    expect(inCd.calls.length).toBe(1);
    expect(recCd.calls.length).toBe(1);
    // recordEscalationFn signature: (orchDir, ticket, phase, reason, now)
    expect(recCd.calls[0][1]).toBe("CTL-9");
    expect(recCd.calls[0][2]).toBe("pr");
    expect(recCd.calls[0][3]).toBe("no-progress");
  });

  test("cool-down-suppressed escalation does NOT call appendEscalatedEvent / applyStalledLabel / recordEscalationFn", () => {
    // Pure-fake seams to make the suppression observable as zero side-effects.
    // The worker is still STOPPED (no-progress-stopped); only the escalation
    // event/label is throttled by the cool-down.
    const s = setupAt(orchDir, { phase: "pr" });
    s.opts.inEscalationCooldownFn = recorder(true); // cool-down already armed
    s.opts.recordEscalationFn = recorder(undefined);

    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("no-progress-stopped");
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(0);
    expect(s.opts.applyStalledLabel.calls.length).toBe(0);
    expect(s.opts.recordEscalationFn.calls.length).toBe(0);
  });

  test("applyStalledLabel is called with orchDir (so labelOnce can scope its marker)", () => {
    // Regression guard for the signature change. The default seam now needs
    // orchDir to drive labelOnce's per-ticket marker; without it, labelOnce
    // would write to /workers/<T>/.linear-label-needs-human.applied — a
    // relative path that depends on cwd and silently fails on most systems.
    const s = setupAt(orchDir, { phase: "pr" });
    reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(s.opts.applyStalledLabel.calls[0][0]).toEqual({
      orchDir: s.orch,
      ticket: "CTL-9",
    });
  });
});

// --- CTL-587: default-seam behavioural tests --------------------------------
// The above describe block uses injected stubs for all seams. These tests
// exercise the REAL defaults — the load-bearing logic inside
// defaultReviveDispatch, defaultKillBgJob, and the audit-event envelope shape.
// Without these, a regression in (a) the signal-reset half of revive dispatch,
// (b) the pid-recycling guard, or (c) the envelope shape would slip past every
// other test, because every other test stubs them out.

describe("defaultReviveDispatch — signal-reset behaviour", () => {
  let orchDir;
  let prevCatalystDir;
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl587-revdisp-"));
    // CTL-660: defaultReviveDispatch now emits real dispatch-lifecycle events
    // by default (appendRequested/appendLaunched default to the real helpers).
    // Tests here inject only `dispatch`, so redirect CATALYST_DIR into the temp
    // orchDir to keep those default emits out of the operator's real
    // ~/catalyst/events log.
    prevCatalystDir = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = orchDir;
    mkdirSync(join(orchDir, "events"), { recursive: true });
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(orchDir, { recursive: true, force: true });
  });

  function seed(ticket, phase, body) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `phase-${phase}.json`),
      JSON.stringify({ ticket, phase, ...body }),
    );
    return join(dir, `phase-${phase}.json`);
  }

  test("missing signal file → returns code:1 stderr:'signal-missing', no dispatch", () => {
    const dispatch = recorder({ code: 0 });
    const r = defaultReviveDispatch(
      { orchDir, ticket: "CTL-9", phase: "implement" },
      { dispatch },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("signal-missing");
    expect(dispatch.calls.length).toBe(0);
  });

  test("signal present → flips to 'stalled' with attentionReason and calls dispatch", () => {
    const signalPath = seed("CTL-9", "implement", {
      status: "running",
      bg_job_id: "bg-9",
      orchestrator: "test-orch",
    });
    const dispatch = recorder({ code: 0 });
    const r = defaultReviveDispatch(
      { orchDir, ticket: "CTL-9", phase: "implement" },
      { dispatch },
    );
    expect(r.code).toBe(0);
    const sig = JSON.parse(readFileSync(signalPath, "utf8"));
    expect(sig.status).toBe("stalled");
    expect(sig.attentionReason).toBe("ctl-587-revive-reset");
    expect(typeof sig.updatedAt).toBe("string");
    // Original fields preserved.
    expect(sig.bg_job_id).toBe("bg-9");
    expect(sig.orchestrator).toBe("test-orch");
    expect(dispatch.calls.length).toBe(1);
    expect(dispatch.calls[0][0]).toEqual({
      orchDir,
      ticket: "CTL-9",
      phase: "implement",
    });
  });

  // CTL-1367 P1: an ASYNC (executor=sdk) dispatch returns a Promise whose
  // synchronous prelaunch already wrote the `dispatched` signal. defaultReviveDispatch
  // must settle it synchronously off that signal (NOT see `undefined` code and record
  // a revive failure). This exercises the injected fn's BEHAVIOR end-to-end.
  test("an async dispatch is settled synchronously off the prelaunch signal (code 0)", async () => {
    const signalPath = seed("CTL-async", "implement", { status: "running", bg_job_id: "bg-a" });
    let resolveQuery;
    const queryDone = new Promise((res) => { resolveQuery = res; });
    // Mimic the SDK launch verb: synchronously (before returning the Promise)
    // re-write the signal to dispatched (the prelaunch), then return a Promise.
    const dispatch = (args) => {
      expect(args.ticket).toBe("CTL-async"); // routed through the injected fn
      writeFileSync(signalPath, JSON.stringify({ ticket: "CTL-async", phase: "implement", status: "dispatched", bg_job_id: null }));
      return queryDone;
    };
    const r = defaultReviveDispatch({ orchDir, ticket: "CTL-async", phase: "implement" }, { dispatch });
    expect(r.code).toBe(0); // settled synchronously off the dispatched signal
    expect(r.async).toBe(true);
    resolveQuery({ code: 0 }); // detached query completes
    await queryDone;
  });

  test("an async dispatch whose prelaunch left NO runnable signal settles to code 1", async () => {
    const signalPath = seed("CTL-asyncfail", "implement", { status: "running", bg_job_id: "bg-b" });
    // dispatch returns a Promise but does NOT write a dispatched signal (prelaunch
    // failed) — defaultReviveDispatch resets to stalled, so sdkSignalRunnable is false.
    const dispatch = () => Promise.resolve({ code: 1 });
    const r = defaultReviveDispatch({ orchDir, ticket: "CTL-asyncfail", phase: "implement" }, { dispatch });
    expect(r.code).toBe(1); // the reset-to-stalled signal is not runnable → failure
    void signalPath;
  });

  // CTL-1367 P1: a REJECTED async (sdk) revive dispatch must NOT be silently
  // swallowed — the onSettled backstop logs it AND emits the failed-terminal
  // backstop (flip signal stalled + phase.<phase>.failed) so the ticket can't strand
  // at "dispatched". This is the third of the three async-dispatch entry points.
  test("a REJECTED async dispatch fires the failed backstop (CTL-1367 P1)", async () => {
    seed("CTL-rej", "implement", { status: "running", bg_job_id: "bg-r" });
    const backstops = [];
    let rejectQuery;
    const queryFailed = new Promise((_res, rej) => { rejectQuery = rej; });
    // The dispatch returns a rejecting Promise (e.g. buildSdkEnv throwing after the
    // prelaunch). It writes no runnable signal, so the synchronous result is code:1.
    const dispatch = () => queryFailed;
    const r = defaultReviveDispatch(
      { orchDir, ticket: "CTL-rej", phase: "implement" },
      { dispatch, emitBackstop: (a) => backstops.push(a) },
    );
    expect(r.code).toBe(1); // the reset-to-stalled signal is not runnable
    rejectQuery(new Error("buildSdkEnv exploded"));
    await queryFailed.catch(() => {}); // settle the rejection
    await Promise.resolve(); await Promise.resolve(); // let the detached handler run
    expect(backstops).toHaveLength(1);
    expect(backstops[0]).toMatchObject({ ticket: "CTL-rej", phase: "implement", status: "failed" });
    expect(backstops[0].reason).toMatch(/buildSdkEnv exploded/);
  });

  test("a RESOLVED async dispatch does NOT fire the backstop (CTL-1367 P1)", async () => {
    const signalPath = seed("CTL-ok", "implement", { status: "running", bg_job_id: "bg-ok" });
    const backstops = [];
    const dispatch = () => {
      writeFileSync(signalPath, JSON.stringify({ ticket: "CTL-ok", phase: "implement", status: "dispatched", bg_job_id: null }));
      return Promise.resolve({ code: 0 });
    };
    const r = defaultReviveDispatch(
      { orchDir, ticket: "CTL-ok", phase: "implement" },
      { dispatch, emitBackstop: (a) => backstops.push(a) },
    );
    expect(r.code).toBe(0);
    await Promise.resolve(); await Promise.resolve();
    expect(backstops).toHaveLength(0); // clean resolution → worker owns its terminal event
  });

  test("signal.worktreePath is forwarded to dispatch as expectedWorktreePath (CTL-615)", () => {
    seed("CTL-15", "implement", {
      status: "running",
      bg_job_id: "bg-15",
      worktreePath: "/wt/CTL/CTL-15",
    });
    const dispatch = recorder({ code: 0 });
    defaultReviveDispatch(
      { orchDir, ticket: "CTL-15", phase: "implement" },
      { dispatch },
    );
    expect(dispatch.calls.length).toBe(1);
    expect(dispatch.calls[0][0]).toEqual({
      orchDir,
      ticket: "CTL-15",
      phase: "implement",
      expectedWorktreePath: "/wt/CTL/CTL-15",
    });
  });

  test("signal without worktreePath → dispatch called without expectedWorktreePath (CTL-615 migration)", () => {
    seed("CTL-16", "implement", { status: "running", bg_job_id: "bg-16" });
    const dispatch = recorder({ code: 0 });
    defaultReviveDispatch(
      { orchDir, ticket: "CTL-16", phase: "implement" },
      { dispatch },
    );
    expect(dispatch.calls[0][0]).toEqual({
      orchDir,
      ticket: "CTL-16",
      phase: "implement",
    });
    // No expectedWorktreePath key at all — undefined means "no check".
    expect("expectedWorktreePath" in dispatch.calls[0][0]).toBe(false);
  });

  // CTL-658: a resolved resume UUID is forwarded to dispatch so the spawned
  // phase-agent-dispatch runs `claude --bg --resume <uuid>`.
  test("resumeSession is forwarded to dispatch when set (CTL-658)", () => {
    seed("CTL-658-A", "implement", { status: "running", bg_job_id: "bg-a" });
    const dispatch = recorder({ code: 0 });
    defaultReviveDispatch(
      { orchDir, ticket: "CTL-658-A", phase: "implement", resumeSession: "9f8e-uuid" },
      { dispatch },
    );
    expect(dispatch.calls[0][0].resumeSession).toBe("9f8e-uuid");
  });

  test("resumeSession absent → dispatch called without the key (CTL-658)", () => {
    seed("CTL-658-B", "implement", { status: "running", bg_job_id: "bg-b" });
    const dispatch = recorder({ code: 0 });
    defaultReviveDispatch(
      { orchDir, ticket: "CTL-658-B", phase: "implement" },
      { dispatch },
    );
    expect("resumeSession" in dispatch.calls[0][0]).toBe(false);
  });

  test("signal flip happens BEFORE dispatch (so dispatcher sees 'stalled')", () => {
    const signalPath = seed("CTL-9", "implement", { status: "running" });
    let seenStatus = null;
    const dispatch = () => {
      seenStatus = JSON.parse(readFileSync(signalPath, "utf8")).status;
      return { code: 0 };
    };
    defaultReviveDispatch({ orchDir, ticket: "CTL-9", phase: "implement" }, { dispatch });
    expect(seenStatus).toBe("stalled");
  });

  test("malformed JSON in signal → returns code:1 with err message, no dispatch", () => {
    const dir = join(orchDir, "workers", "CTL-9");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phase-implement.json"), "{ not json");
    const dispatch = recorder({ code: 0 });
    const r = defaultReviveDispatch(
      { orchDir, ticket: "CTL-9", phase: "implement" },
      { dispatch },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/JSON|json/i);
    expect(dispatch.calls.length).toBe(0);
  });

  test("signal write uses tmp + rename (atomic — no partial file visible)", () => {
    // We can't observe the rename directly without racing it, but we can
    // confirm no `.tmp.*` files linger after the call — proves the rename
    // actually moved the tmp into place.
    seed("CTL-9", "implement", { status: "running", bg_job_id: "bg-9" });
    defaultReviveDispatch({ orchDir, ticket: "CTL-9", phase: "implement" }, {
      dispatch: () => ({ code: 0 }),
    });
    const dir = join(orchDir, "workers", "CTL-9");
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });

  // ── CTL-660: revive-path dispatch-lifecycle emission ────────────────────
  test("CTL-660: revive success emits requested(revive) + launched with the relaunched signal's bg_job_id + worktreePath", () => {
    const signalPath = seed("CTL-660-R", "implement", {
      status: "running",
      bg_job_id: "bg-orig",
      worktreePath: "/wt/CTL/CTL-660-R",
      orchestrator: "orch-rev",
    });
    // The real dispatcher rewrites the signal with the relaunched worker's
    // bg_job_id; mimic that so the launched emit re-reads the NEW id.
    const dispatch = () => {
      const sig = JSON.parse(readFileSync(signalPath, "utf8"));
      sig.status = "running";
      sig.bg_job_id = "bg-new";
      writeFileSync(signalPath, JSON.stringify(sig));
      return { code: 0 };
    };
    const appendRequested = recorder(true);
    const appendLaunched = recorder(true);

    const r = defaultReviveDispatch(
      { orchDir, ticket: "CTL-660-R", phase: "implement" },
      { dispatch, appendRequested, appendLaunched },
    );

    expect(r.code).toBe(0);
    expect(appendRequested.calls.length).toBe(1);
    expect(appendRequested.calls[0][0]).toMatchObject({
      orchId: "orch-rev",
      ticket: "CTL-660-R",
      target_phase: "implement",
      reason: "revive",
    });
    expect(appendLaunched.calls.length).toBe(1);
    expect(appendLaunched.calls[0][0]).toMatchObject({
      orchId: "orch-rev",
      ticket: "CTL-660-R",
      target_phase: "implement",
      bg_job_id: "bg-new",
      worktree_path: "/wt/CTL/CTL-660-R",
    });
  });

  test("CTL-660: revive dispatch failure (code!=0) emits requested but NOT launched", () => {
    seed("CTL-660-F", "implement", {
      status: "running",
      bg_job_id: "bg-f",
      orchestrator: "orch-rev",
    });
    const dispatch = recorder({ code: 2, stderr: "boom" });
    const appendRequested = recorder(true);
    const appendLaunched = recorder(true);

    const r = defaultReviveDispatch(
      { orchDir, ticket: "CTL-660-F", phase: "implement" },
      { dispatch, appendRequested, appendLaunched },
    );

    expect(r.code).toBe(2);
    expect(appendRequested.calls.length).toBe(1);
    expect(appendRequested.calls[0][0]).toMatchObject({ reason: "revive", target_phase: "implement" });
    expect(appendLaunched.calls.length).toBe(0);
  });

  test("CTL-660: signal-missing early return emits neither requested nor launched", () => {
    const dispatch = recorder({ code: 0 });
    const appendRequested = recorder(true);
    const appendLaunched = recorder(true);

    const r = defaultReviveDispatch(
      { orchDir, ticket: "CTL-660-MISSING", phase: "implement" },
      { dispatch, appendRequested, appendLaunched },
    );

    expect(r.code).toBe(1);
    expect(r.stderr).toBe("signal-missing");
    expect(appendRequested.calls.length).toBe(0);
    expect(appendLaunched.calls.length).toBe(0);
  });
});

describe("defaultKillBgJob — claude stop termination (CTL-657)", () => {
  // CTL-657: the pre-CTL-657 pid-file SIGKILL was a guaranteed no-op on CC
  // 2.1.152 (no ~/.claude/jobs/<id>/pid). killBgJob now issues
  // `claude stop <shortId>` — the primitive that actually deregisters a session.
  const FULL_UUID = "12345678-aaaa-bbbb-cccc-0123456789ab";

  test("missing bgJobId → no stop invocation", () => {
    const stop = recorder({ ok: true });
    defaultKillBgJob({ bgJobId: null }, { stop });
    expect(stop.calls.length).toBe(0);
  });

  test("malformed bgJobId (not a short/UUID id) → no stop invocation", () => {
    // "bg-9" is the legacy revive fixture: not a valid short id, so it must
    // short-circuit WITHOUT shelling out (keeps those revive tests deterministic).
    const stop = recorder({ ok: true });
    defaultKillBgJob({ bgJobId: "bg-9" }, { stop });
    expect(stop.calls.length).toBe(0);
  });

  test("valid 8-char short id → claude stop issued with that id", () => {
    const stop = recorder({ ok: true });
    defaultKillBgJob({ bgJobId: "12345678" }, { stop });
    expect(stop.calls).toHaveLength(1);
    expect(stop.calls[0][0]).toBe("12345678");
  });

  test("full UUID → claude stop issued with the 8-char short id (UUIDs are rejected rc=1)", () => {
    const stop = recorder({ ok: true });
    defaultKillBgJob({ bgJobId: FULL_UUID }, { stop });
    expect(stop.calls).toHaveLength(1);
    expect(stop.calls[0][0]).toBe("12345678");
  });

  test("stop failure ({ok:false}) does not throw", () => {
    const stop = recorder({ ok: false, error: "no such session" });
    expect(() => defaultKillBgJob({ bgJobId: "12345678" }, { stop })).not.toThrow();
    expect(stop.calls).toHaveLength(1);
  });
});

// CTL-662 removed defaultPidAlive (the CTL-610/657 positive keep-alive seam) and
// its tests: its sole consumer was the alive-quiet gate's `pidAlive` injection,
// which is gone. Reclaim eligibility no longer asks "is the bg pid alive?" (a
// binary presence check) but "what is the worker's `claude agents` status?" (the
// three-valued busy|idle|absent reader livenessForBgJob, covered in
// claude-agents.test.mjs). Presence is subsumed by `absent` (not listed → dead).

describe("revive event envelope round-trip (write → countReviveEvents)", () => {
  let envCatalystDir;
  let prevCatalystDir;
  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    envCatalystDir = mkdtempSync(join(tmpdir(), "ctl587-rt-"));
    process.env.CATALYST_DIR = envCatalystDir;
    mkdirSync(join(envCatalystDir, "events"), { recursive: true });
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(envCatalystDir, { recursive: true, force: true });
  });

  test("defaultAppendReviveEvent writes an envelope that countReviveEvents counts", async () => {
    // Dynamic-import so the test sees process.env.CATALYST_DIR set above.
    const { countReviveEvents } = await import("./event-scan.mjs");
    const ok = defaultAppendReviveEvent({
      phase: "implement",
      ticket: "CTL-RT-1",
      orchId: "orch-rt",
      attempt: 1,
      reason: "work-not-done-after-stale-bg",
      prev_state_json_mtime: 12345,
      prev_bg_job_id: "bg-rt-1",
    });
    expect(ok).toBe(true);
    // The default path resolves the event log via getEventLogPath, so a no-
    // arg call must find the envelope we just wrote.
    expect(countReviveEvents({ ticket: "CTL-RT-1" })).toBe(1);
    expect(countReviveEvents({ ticket: "CTL-RT-1", orchId: "orch-rt" })).toBe(1);
    // orchId mismatch returns 0 — proves the orchId attribute round-trips.
    expect(countReviveEvents({ ticket: "CTL-RT-1", orchId: "wrong-orch" })).toBe(0);
  });
});

// CTL-660: success-path dispatch lifecycle events — phase.dispatch.requested
// and phase.dispatch.launched. Mirror the revive envelope round-trip: point
// CATALYST_DIR at a temp dir, call the helper, read back the JSONL line and
// assert the envelope shape (event.name, body.payload, service.name).
describe("dispatch lifecycle event envelopes (CTL-660)", () => {
  let envCatalystDir;
  let prevCatalystDir;
  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    envCatalystDir = mkdtempSync(join(tmpdir(), "ctl660-disp-"));
    process.env.CATALYST_DIR = envCatalystDir;
    mkdirSync(join(envCatalystDir, "events"), { recursive: true });
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(envCatalystDir, { recursive: true, force: true });
  });

  // Read back the single envelope written this test (current UTC month log).
  function readBackEnvelope() {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const lines = readFileSync(join(envCatalystDir, "events", `${ym}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }

  test("defaultAppendDispatchRequestedEvent writes a requested envelope", () => {
    const ok = defaultAppendDispatchRequestedEvent({
      orchId: "orch-rq",
      ticket: "CTL-RQ-1",
      target_phase: "implement",
      reason: "advance",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe("phase.dispatch.requested.CTL-RQ-1");
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.body.payload.status).toBe("requested");
    expect(env.body.payload.reason).toBe("advance");
    expect(env.body.payload.target_phase).toBe("implement");
    expect(env.attributes["catalyst.orchestration"]).toBe("orch-rq");
    // CTL-700 (Item B): healthy lifecycle events must emit INFO, not WARN
    expect(env.severityText).toBe("INFO");
    expect(env.severityNumber).toBe(9);
  });

  test("defaultAppendDispatchLaunchedEvent writes a launched envelope", () => {
    const ok = defaultAppendDispatchLaunchedEvent({
      orchId: "orch-lc",
      ticket: "CTL-LC-1",
      target_phase: "research",
      bg_job_id: "deadbeef",
      worktree_path: "/wt/CTL/CTL-LC-1",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe("phase.dispatch.launched.CTL-LC-1");
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.body.payload.status).toBe("launched");
    expect(env.body.payload.target_phase).toBe("research");
    expect(env.body.payload.bg_job_id).toBe("deadbeef");
    expect(env.body.payload.worktree_path).toBe("/wt/CTL/CTL-LC-1");
    // CTL-700 (Item B): healthy lifecycle events must emit INFO, not WARN
    expect(env.severityText).toBe("INFO");
    expect(env.severityNumber).toBe(9);
  });

  // CTL-1023: the work-type dimension rides on every dispatch lifecycle event.
  // Resolved from workers/<ticket>/triage.json .classification; "unknown" when
  // no triage.json exists yet (the pre-triage first dispatch).
  test("CTL-1023: dispatch-requested carries catalyst.ticket.type from triage.json", () => {
    const orchDir = mkdtempSync(join(tmpdir(), "ctl1023-disp-"));
    mkdirSync(join(orchDir, "workers", "CTL-TT-1"), { recursive: true });
    writeFileSync(
      join(orchDir, "workers", "CTL-TT-1", "triage.json"),
      JSON.stringify({ classification: "bug" }),
    );
    const ok = defaultAppendDispatchRequestedEvent({
      orchId: "orch-tt",
      orchDir,
      ticket: "CTL-TT-1",
      target_phase: "implement",
      reason: "advance",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["catalyst.ticket.type"]).toBe("bug");
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("CTL-1023: dispatch-requested defaults catalyst.ticket.type to 'unknown' pre-triage", () => {
    const ok = defaultAppendDispatchRequestedEvent({
      orchId: "orch-tt",
      orchDir: undefined,
      ticket: "CTL-TT-2",
      target_phase: "triage",
      reason: "new-work",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["catalyst.ticket.type"]).toBe("unknown");
  });

  test("defaultAppendRunawayEvent writes a runaway envelope (CTL-671)", () => {
    const ok = defaultAppendRunawayEvent({
      ticket: "CTL-9",
      orchId: "orch-rw",
      count: 312,
      window_ms: 600_000,
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe("phase.dispatch.runaway.CTL-9");
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.body.payload.status).toBe("runaway");
    expect(env.body.payload.reason).toBe("event-rate-domination");
    expect(env.body.payload.count).toBe(312);
    expect(env.body.payload.window_ms).toBe(600_000);
    // CTL-700 (Item B): regression-lock — abnormal events keep WARN
    expect(env.severityText).toBe("WARN");
    expect(env.attributes["catalyst.orchestration"]).toBe("orch-rw");
  });

  test("CTL-868: defaultAppendOrphanDetectedEvent writes a phase.<phase>.orphan-detected.<ticket> envelope", () => {
    const ok = defaultAppendOrphanDetectedEvent({
      phase: "implement",
      ticket: "CTL-OD-1",
      orchId: "orch-od",
      reason: "stalled-no-recovery",
      stalled_phases: ["implement", "verify"],
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    // The real builder output (not a spy) — guards the event.name convention and
    // the stalled_phases payload the orch-monitor dashboard consumes.
    expect(env.attributes["event.name"]).toBe("phase.implement.orphan-detected.CTL-OD-1");
    expect(env.attributes["event.action"]).toBe("orphan-detected");
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.body.payload.status).toBe("orphan-detected");
    expect(env.body.payload.reason).toBe("stalled-no-recovery");
    expect(env.body.payload.stalled_phases).toEqual(["implement", "verify"]);
    expect(env.attributes["catalyst.orchestration"]).toBe("orch-od");
  });

  test("CTL-768: defaultAppendHeldStoppedEvent writes a phase.<phase>.held-stopped.<ticket> envelope", () => {
    // Exercises the REAL emitter (not the scheduler's stub seam): guards the
    // buildEventEnvelope output — event.name convention, action, and the
    // bg_job_id payload the revive --resume path + HUD/audit consumers read.
    const ok = defaultAppendHeldStoppedEvent({
      orchId: "orch-hs",
      ticket: "CTL-HS-1",
      phase: "implement",
      bgJobId: "deadbeef",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe("phase.implement.held-stopped.CTL-HS-1");
    expect(env.attributes["event.action"]).toBe("held-stopped");
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.body.payload.status).toBe("held-stopped");
    expect(env.body.payload.bg_job_id).toBe("deadbeef");
    expect(env.attributes["catalyst.orchestration"]).toBe("orch-hs");
  });

  test("CTL-768: defaultAppendHeldStoppedEvent is fail-open — returns falsy, never throws, on an unwriteable log dir", () => {
    const filePath = join(envCatalystDir, "not-a-dir-hs");
    writeFileSync(filePath, "x");
    process.env.CATALYST_DIR = join(filePath, "nested");
    expect(
      defaultAppendHeldStoppedEvent({
        orchId: "orch-hs",
        ticket: "CTL-HS-FAIL",
        phase: "implement",
        bgJobId: "deadbeef",
      }),
    ).toBe(false);
  });

  test("both helpers are fail-open: return false when the log dir is unwriteable", () => {
    // Point CATALYST_DIR at a path whose parent is a regular file, so the
    // events/ mkdir + append cannot succeed. Mirrors appendEnvelopeBestEffort's
    // documented fail-open contract (return false, never throw).
    const filePath = join(envCatalystDir, "not-a-dir");
    writeFileSync(filePath, "x");
    process.env.CATALYST_DIR = join(filePath, "nested");
    expect(
      defaultAppendDispatchRequestedEvent({
        orchId: "o",
        ticket: "CTL-FAIL-1",
        target_phase: "implement",
        reason: "revive",
      }),
    ).toBe(false);
    expect(
      defaultAppendDispatchLaunchedEvent({
        orchId: "o",
        ticket: "CTL-FAIL-1",
        target_phase: "implement",
        bg_job_id: "x",
        worktree_path: "/x",
      }),
    ).toBe(false);
  });

  // CTL-771: autotune-gauge envelope round-trip. The metric values live as flat
  // scalars in body.payload so otel-forward processLine keeps the line (it has
  // truthy .attributes) and toAttrArray maps the numbers as the OTLP precedent.
  test("defaultAppendAutotuneGaugeEvent writes a gauge envelope", () => {
    const ok = defaultAppendAutotuneGaugeEvent({
      label: "execution-core",
      maxParallelEffective: 4,
      maxParallelTarget: 6,
      runningWorkers: 3,
      load1: 2.4,
      loadPerCore: 0.3,
      memFreePct: 42.5,
      reason: "converge-to-setpoint",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe("phase.scheduler.autotune-gauge.execution-core");
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.body.payload.status).toBe("autotune-gauge");
    expect(env.body.payload.max_parallel_effective).toBe(4);
    expect(env.body.payload.max_parallel_target).toBe(6);
    expect(env.body.payload.running_workers).toBe(3);
    expect(env.body.payload.load1).toBe(2.4);
    expect(env.body.payload.load_per_core).toBe(0.3);
    expect(env.body.payload.mem_free_pct).toBe(42.5);
    expect(env.body.payload.decision_reason).toBe("converge-to-setpoint");
  });

  // CTL-1291: the gauge numbers must ride out as ATTRIBUTES (not just
  // body.payload) so a dashboard can chart parallelism + slots-in-use as a
  // numeric series. Free-text (decision_reason/reason) stays in body.payload —
  // never promoted (cardinality). body.payload is left intact (dual-write).
  test("autotune-gauge promotes numeric gauges to attributes (CTL-1291)", () => {
    const ok = defaultAppendAutotuneGaugeEvent({
      label: "execution-core",
      maxParallelEffective: 4,
      maxParallelTarget: 6,
      runningWorkers: 3,
      load1: 2.4,
      loadPerCore: 0.3,
      memFreePct: 42.5,
      reason: "converge-to-setpoint",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    const a = env.attributes;
    expect(a["scheduler.max_parallel_effective"]).toBe(4);
    expect(a["scheduler.max_parallel_target"]).toBe(6);
    expect(a["scheduler.running_workers"]).toBe(3);
    expect(a["scheduler.load1"]).toBe(2.4);
    expect(a["scheduler.load_per_core"]).toBe(0.3);
    expect(a["scheduler.mem_free_pct"]).toBe(42.5);
    // free-text NOT promoted to an attribute (stays in body.payload only)
    expect(a["scheduler.decision_reason"]).toBeUndefined();
    expect(a["decision_reason"]).toBeUndefined();
    // body.payload intact (back-compat)
    expect(env.body.payload.running_workers).toBe(3);
    expect(env.body.payload.decision_reason).toBe("converge-to-setpoint");
  });

  test("parallelism-sampled promotes slots/parallelism to attributes (CTL-1291)", () => {
    const ok = defaultAppendParallelismSampledEvent({
      label: "execution-core",
      load1: 1.5,
      load5: 1.2,
      load15: 1.0,
      memFreePct: 55.0,
      bgCount: 2,
      maxParallelCurrent: 5,
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    const a = env.attributes;
    expect(a["scheduler.bg_count"]).toBe(2); // slots-in-use
    expect(a["scheduler.max_parallel_current"]).toBe(5); // parallelism
    expect(a["scheduler.load1"]).toBe(1.5);
    expect(a["scheduler.mem_free_pct"]).toBe(55.0);
    // body.payload intact (back-compat)
    expect(env.body.payload.bg_count).toBe(2);
    expect(env.body.payload.maxParallel_current).toBe(5);
  });
});

// CTL-1044: the generic operator-event appender. This is the PRODUCTION default
// for the scheduler's `appendIntentEvent` seam (advance-shadow disagree/tick,
// CTL-936 intent.ineffective, executeEscalations). The seam contract is a RAW
// `{ "event.name": string, payload: object }` object that does NOT fit
// buildEventEnvelope's phase/action schema — so this helper wraps it in a valid
// unified-event-log envelope, carrying event.name VERBATIM and payload intact.
describe("defaultAppendOperatorEvent (CTL-1044)", () => {
  let envCatalystDir;
  let prevCatalystDir;
  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    envCatalystDir = mkdtempSync(join(tmpdir(), "ctl1044-op-"));
    process.env.CATALYST_DIR = envCatalystDir;
    mkdirSync(join(envCatalystDir, "events"), { recursive: true });
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(envCatalystDir, { recursive: true, force: true });
  });

  function readBackEnvelope() {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const lines = readFileSync(join(envCatalystDir, "events", `${ym}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }

  test("writes a parseable envelope carrying event.name verbatim and payload intact", () => {
    // Exactly the object the advance-shadow comparator hands the seam
    // (advance-shadow.mjs:177-180): the disagree event.
    const disagreement = {
      ticket: "CTL-9",
      procedural: "research",
      belief: null,
      procedural_exhausted: false,
      belief_exhausted: false,
      signals: { triage: "done" },
      differingInput: { verdict: null, remediateCycleCount: 0 },
    };
    const ok = defaultAppendOperatorEvent({
      "event.name": "beliefs.advance_shadow.disagree",
      payload: disagreement,
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    // event.name is preserved VERBATIM — NOT mangled into phase.<phase>.<action>.
    expect(env.attributes["event.name"]).toBe("beliefs.advance_shadow.disagree");
    // payload survives the round-trip byte-for-byte.
    expect(env.body.payload).toEqual(disagreement);
    // Same resource/service fields every other daemon emitter stamps.
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.resource["service.namespace"]).toBe("catalyst");
    expect(env.resource["host.name"]).toBeTruthy();
    expect(env.resource["host.id"]).toBeTruthy();
    // Required envelope scaffold the log reader/otel-forward depend on.
    expect(typeof env.id).toBe("string");
    expect(env.id.length).toBeGreaterThan(0);
    expect(env.ts).toBeTruthy();
    expect(env.severityText).toBe("INFO");
    expect(env.severityNumber).toBe(9);
  });

  test("writes the tick-summary event with its agree/disagree counts", () => {
    const ok = defaultAppendOperatorEvent({
      "event.name": "beliefs.advance_shadow.tick",
      payload: { agree: 3, disagree: 1 },
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe("beliefs.advance_shadow.tick");
    expect(env.body.payload).toEqual({ agree: 3, disagree: 1 });
  });

  test("is best-effort: returns false (never throws) on a malformed event with no event.name", () => {
    expect(defaultAppendOperatorEvent({ payload: { x: 1 } })).toBe(false);
    expect(defaultAppendOperatorEvent(null)).toBe(false);
    expect(defaultAppendOperatorEvent({})).toBe(false);
  });

  test("is fail-open: returns false (never throws) when the log dir is unwriteable", () => {
    const filePath = join(envCatalystDir, "not-a-dir-op");
    writeFileSync(filePath, "x");
    process.env.CATALYST_DIR = join(filePath, "nested");
    expect(
      defaultAppendOperatorEvent({
        "event.name": "beliefs.advance_shadow.disagree",
        payload: { ticket: "CTL-FAIL" },
      }),
    ).toBe(false);
  });
});

// CTL-1006 Scenario 2: boot-resume phase-regression audit envelope. Emitted when
// boot-resume would have re-dispatched an EARLIER phase whose ticket already has
// a LATER terminal phase signal — surfaces the regression for forensics INSTEAD
// of spawning a fresh earlier-phase worker. Audit-only: distinct action
// (broker-ignored) + NOT counted by countReviveEvents (the Scenario-4 invariant —
// a regression must never consume the chronic-failure revive budget).
describe("boot-resume phase-regression event envelope (CTL-1006)", () => {
  let envCatalystDir;
  let prevCatalystDir;
  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    envCatalystDir = mkdtempSync(join(tmpdir(), "ctl1006-pr-"));
    process.env.CATALYST_DIR = envCatalystDir;
    mkdirSync(join(envCatalystDir, "events"), { recursive: true });
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(envCatalystDir, { recursive: true, force: true });
  });

  function readBackEnvelope() {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const lines = readFileSync(join(envCatalystDir, "events", `${ym}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }

  test("writes phase.<phase>.boot-resume-phase-regression.<ticket> with dominantPhase payload", () => {
    const ok = defaultAppendBootResumePhaseRegressionEvent({
      phase: "triage",
      ticket: "CTL-997",
      dominantPhase: "research",
      orchId: "orch-1006",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe(
      "phase.triage.boot-resume-phase-regression.CTL-997"
    );
    expect(env.attributes["event.action"]).toBe("boot-resume-phase-regression");
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.body.payload.status).toBe("boot-resume-phase-regression");
    expect(env.body.payload.dominantPhase).toBe("research");
    expect(env.attributes["catalyst.orchestration"]).toBe("orch-1006");
  });

  test("Scenario-4 invariant: NOT counted by countReviveEvents (revive budget preserved)", async () => {
    const { countReviveEvents } = await import("./event-scan.mjs");
    // Use the implement phase so the event.name collides with the implement-only
    // revive shape if the action were mis-named — countReviveEvents must still 0.
    defaultAppendBootResumePhaseRegressionEvent({
      phase: "implement",
      ticket: "CTL-RG-1006",
      dominantPhase: "verify",
      orchId: "orch-1006",
    });
    expect(countReviveEvents({ ticket: "CTL-RG-1006" })).toBe(0);
  });
});

// CTL-664: enriched reclaim event envelope round-trip. Mirror the CTL-660
// dispatch round-trip: point CATALYST_DIR at a temp dir, call the helper, read
// back the JSONL line, and assert the enriched payload fields the HUD DETAILS
// fallback (title/body) and the audit consumers (completion_origin etc.) read.
describe("reclaim event envelope round-trip (CTL-664)", () => {
  let envCatalystDir;
  let prevCatalystDir;
  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    envCatalystDir = mkdtempSync(join(tmpdir(), "ctl664-reclaim-"));
    process.env.CATALYST_DIR = envCatalystDir;
    mkdirSync(join(envCatalystDir, "events"), { recursive: true });
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(envCatalystDir, { recursive: true, force: true });
  });

  function readBackEnvelope() {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const lines = readFileSync(join(envCatalystDir, "events", `${ym}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }

  test("defaultAppendReclaimEvent writes the enriched payload + HUD title/body", () => {
    const ok = defaultAppendReclaimEvent({
      phase: "implement",
      ticket: "CTL-RC-1",
      orchId: "orch-rc",
      death_signal: "absent",
      prev_state_json_mtime: null,
      probe_passed: true,
      probe_checked: "commits ahead of origin/main + clean worktree",
      completion_origin: "inferred",
      reclaimed_bg_job_id: "bg-rc",
      stopped_bg_job_ids: [],
      title: "phase implement reclaimed (work-done-despite-dead-bg)",
      body: "Daemon reclaimed dead implement worker for CTL-RC-1.",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe("phase.implement.reclaim.CTL-RC-1");
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.body.payload.status).toBe("reclaim");
    expect(env.body.payload.reason).toBe("work-done-despite-dead-bg");
    expect(env.body.payload.completion_origin).toBe("inferred");
    expect(env.body.payload.death_signal).toBe("absent");
    expect(env.body.payload.probe_passed).toBe(true);
    expect(env.body.payload.reclaimed_bg_job_id).toBe("bg-rc");
    expect(env.body.payload.stopped_bg_job_ids).toEqual([]);
    expect(env.body.payload.title).toContain("reclaimed");
    expect(typeof env.body.payload.body).toBe("string");
    expect(env.attributes["catalyst.orchestration"]).toBe("orch-rc");
  });
});

// CTL-702: yield-file-skip OTEL emitter round-trip.
describe("yield-file-skip event envelope (CTL-702)", () => {
  let envCatalystDir;
  let prevCatalystDir;
  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    envCatalystDir = mkdtempSync(join(tmpdir(), "ctl702-yield-"));
    process.env.CATALYST_DIR = envCatalystDir;
    mkdirSync(join(envCatalystDir, "events"), { recursive: true });
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(envCatalystDir, { recursive: true, force: true });
  });

  function readBackEnvelope() {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const lines = readFileSync(join(envCatalystDir, "events", `${ym}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }

  test("defaultAppendYieldFileSkipEvent emits the expected envelope shape (CTL-702)", () => {
    const ok = defaultAppendYieldFileSkipEvent({
      ticket: "CTL-FOO",
      orchId: "ORCH-1",
      filename: "phase-plan-yield-20260528T050740Z.json",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe("phase.scheduler.yield-file-skip.CTL-FOO");
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.body.payload.filename).toBe("phase-plan-yield-20260528T050740Z.json");
    expect(env.body.payload.reason).toBe("yield_tombstone_filtered");
    expect(env.attributes["catalyst.orchestration"]).toBe("ORCH-1");
  });
});

// CTL-640: cold-start detection — runtime epoch readers + detectColdStart.
describe("runtime epoch readers", () => {
  describe("readBootEpoch", () => {
    test("darwin: parses `sec = <n>` from kern.boottime → ms", () => {
      const spawn = (cmd, args) => {
        expect(cmd).toBe("sysctl");
        expect(args).toEqual(["-n", "kern.boottime"]);
        return {
          status: 0,
          stdout: "{ sec = 1779212952, usec = 3402 } Tue May 19 12:49:12 2026\n",
          stderr: "",
        };
      };
      expect(readBootEpoch({ platform: "darwin", spawn })).toBe(1779212952 * 1000);
    });

    test("linux: parses `btime <n>` from /proc/stat → ms", () => {
      const readFile = (p) => {
        expect(p).toBe("/proc/stat");
        return "cpu  1 2 3\nbtime 1779212952\nprocesses 99\n";
      };
      expect(readBootEpoch({ platform: "linux", readFile })).toBe(1779212952 * 1000);
    });

    test("unknown platform → 0", () => {
      expect(readBootEpoch({ platform: "sunos" })).toBe(0);
    });

    test("spawn failure / unparseable output → 0", () => {
      const spawn = () => ({ status: 1, stdout: "", stderr: "boom" });
      expect(readBootEpoch({ platform: "darwin", spawn })).toBe(0);
    });
  });

  describe("readDaemonEpoch", () => {
    test("returns newest immediate-subdir mtime (ms)", () => {
      const readDir = (root) => {
        expect(root).toContain("cc-daemon-");
        return ["old", "new"];
      };
      const statDir = (p) => (p.endsWith("new") ? { mtimeMs: 2000 } : { mtimeMs: 1000 });
      expect(readDaemonEpoch({ socketRoot: "/tmp/cc-daemon-501", readDir, statDir })).toBe(2000);
    });

    test("missing socket root → 0", () => {
      const readDir = () => {
        throw new Error("ENOENT");
      };
      expect(readDaemonEpoch({ socketRoot: "/tmp/cc-daemon-501", readDir })).toBe(0);
    });

    test("no subdirs → 0", () => {
      expect(readDaemonEpoch({ socketRoot: "/tmp/cc-daemon-501", readDir: () => [] })).toBe(0);
    });
  });

  describe("defaultReadRuntimeEpoch", () => {
    test("epoch = max(boot, daemon); epochSource names the winner", () => {
      const res = defaultReadRuntimeEpoch({ readBoot: () => 1000, readDaemon: () => 5000 });
      expect(res).toMatchObject({
        epoch: 5000,
        epochSource: "daemon",
        bootEpoch: 1000,
        daemonEpoch: 5000,
      });
    });

    test("boot wins when daemon unreadable (0)", () => {
      const res = defaultReadRuntimeEpoch({ readBoot: () => 8000, readDaemon: () => 0 });
      expect(res).toMatchObject({ epoch: 8000, epochSource: "boot" });
    });

    test("both 0 → epoch 0, epochSource none", () => {
      const res = defaultReadRuntimeEpoch({ readBoot: () => 0, readDaemon: () => 0 });
      expect(res).toMatchObject({ epoch: 0, epochSource: "none" });
    });
  });

  describe("detectColdStart", () => {
    // Helper: build a statJob that maps job id → mtimeMs (or null when absent).
    const statJobFrom = (map) => (id) =>
      id in map ? { exists: true, mtimeMs: map[id], state: {} } : null;

    test("(a) cold when epoch newer than ALL job mtimes", () => {
      const res = detectColdStart({
        readEpoch: () => ({ epoch: 5000, epochSource: "daemon", bootEpoch: 1000, daemonEpoch: 5000 }),
        readDir: () => ["j1", "j2"],
        statJob: statJobFrom({ j1: 1000, j2: 4000 }),
      });
      expect(res).toMatchObject({ coldStart: true, epoch: 5000, epochSource: "daemon", jobsChecked: 2, newestJobMtime: 4000 });
    });

    test("(b) NOT cold when any job mtime >= epoch", () => {
      const res = detectColdStart({
        readEpoch: () => ({ epoch: 5000, epochSource: "boot", bootEpoch: 5000, daemonEpoch: 0 }),
        readDir: () => ["j1", "j2"],
        statJob: statJobFrom({ j1: 1000, j2: 6000 }), // j2 touched after epoch → alive
      });
      expect(res.coldStart).toBe(false);
      expect(res.newestJobMtime).toBe(6000);
    });

    test("(c) zero jobs + readable epoch → vacuously cold", () => {
      const res = detectColdStart({
        readEpoch: () => ({ epoch: 5000, epochSource: "boot", bootEpoch: 5000, daemonEpoch: 0 }),
        readDir: () => [],
        statJob: () => null,
      });
      expect(res).toMatchObject({ coldStart: true, jobsChecked: 0, newestJobMtime: 0 });
    });

    test("(d) unreadable epoch (0 / 'none') → NOT cold, regardless of jobs", () => {
      const res = detectColdStart({
        readEpoch: () => ({ epoch: 0, epochSource: "none", bootEpoch: 0, daemonEpoch: 0 }),
        readDir: () => ["j1"],
        statJob: statJobFrom({ j1: 1000 }),
      });
      expect(res.coldStart).toBe(false);
      expect(res.epochSource).toBe("none");
    });

    test("job dir present but state.json missing (statJob null) is ignored, not counted alive", () => {
      const res = detectColdStart({
        readEpoch: () => ({ epoch: 5000, epochSource: "daemon", bootEpoch: 0, daemonEpoch: 5000 }),
        readDir: () => ["j1", "ghost"],
        statJob: statJobFrom({ j1: 1000 }), // "ghost" → null (no state.json)
      });
      // ghost has no mtime evidence; j1 < epoch → still cold. jobsChecked counts dirs with a usable mtime.
      expect(res.coldStart).toBe(true);
      expect(res.jobsChecked).toBe(1);
    });

    test("missing jobs root (readDir throws) → jobsChecked 0, vacuously cold when epoch readable", () => {
      const res = detectColdStart({
        readEpoch: () => ({ epoch: 5000, epochSource: "boot", bootEpoch: 5000, daemonEpoch: 0 }),
        readDir: () => { throw new Error("ENOENT"); },
        statJob: () => null,
      });
      expect(res).toMatchObject({ coldStart: true, jobsChecked: 0 });
    });
  });
});

// CTL-701 Phase 3: readExecCoreBootEpoch + detectColdStart exec-core epoch
describe("readExecCoreBootEpoch (CTL-701)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctl701-epoch-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads daemon-boot.json bootedAt as epoch-ms", () => {
    writeFileSync(
      join(dir, "daemon-boot.json"),
      JSON.stringify({ bootedAt: "2026-05-28T15:00:00Z" }),
    );
    expect(readExecCoreBootEpoch(dir)).toBe(Date.parse("2026-05-28T15:00:00Z"));
  });

  test("returns 0 when file is missing (fail-open)", () => {
    expect(readExecCoreBootEpoch(dir)).toBe(0);
  });

  test("returns 0 when file is malformed JSON (fail-open)", () => {
    writeFileSync(join(dir, "daemon-boot.json"), "not json");
    expect(readExecCoreBootEpoch(dir)).toBe(0);
  });

  test("returns 0 when bootedAt is wrong type (fail-open)", () => {
    writeFileSync(join(dir, "daemon-boot.json"), JSON.stringify({ bootedAt: 12345 }));
    expect(readExecCoreBootEpoch(dir)).toBe(0);
    writeFileSync(join(dir, "daemon-boot.json"), JSON.stringify({ bootedAt: "" }));
    expect(readExecCoreBootEpoch(dir)).toBe(0);
  });

  test("returns 0 for null orchDir (fail-open)", () => {
    expect(readExecCoreBootEpoch(null)).toBe(0);
    expect(readExecCoreBootEpoch(undefined)).toBe(0);
  });
});

describe("detectColdStart — exec-core epoch (CTL-701)", () => {
  const statJobFrom = (map) => (id) =>
    id in map ? { exists: true, mtimeMs: map[id], state: {} } : null;

  test("uses exec-core epoch when newer than OS/daemon (CTL-701 Option A)", () => {
    const T1 = 1000; // runtime epoch (daemon)
    const T2 = 2000; // job mtime — between T1 and T3
    const T3 = 3000; // exec-core boot epoch — newest
    const res = detectColdStart({
      readEpoch: () => ({ epoch: T1, epochSource: "daemon", bootEpoch: 0, daemonEpoch: T1 }),
      readDir: () => ["j1"],
      statJob: statJobFrom({ j1: T2 }),
      readExecCoreEpoch: () => T3,
    });
    // T2 < T3 → cold; exec-core epoch wins
    expect(res.coldStart).toBe(true);
    expect(res.epochSource).toBe("exec-core");
    expect(res.epoch).toBe(T3);
  });

  test("keeps OS/daemon path when newer than exec-core (CTL-701)", () => {
    const T1 = 5000; // runtime epoch (boot) — newest
    const T2 = 3000; // job mtime < T1 → cold regardless
    const T3 = 2000; // exec-core epoch — lower
    const res = detectColdStart({
      readEpoch: () => ({ epoch: T1, epochSource: "boot", bootEpoch: T1, daemonEpoch: 0 }),
      readDir: () => ["j1"],
      statJob: statJobFrom({ j1: T2 }),
      readExecCoreEpoch: () => T3,
    });
    expect(res.coldStart).toBe(true);
    expect(res.epochSource).toBe("boot"); // runtime wins
    expect(res.epoch).toBe(T1);
  });

  test("unreadable exec-core epoch (0) falls through to runtime epoch (CTL-701)", () => {
    const T1 = 5000;
    const T2 = 3000;
    const res = detectColdStart({
      readEpoch: () => ({ epoch: T1, epochSource: "daemon", bootEpoch: 0, daemonEpoch: T1 }),
      readDir: () => ["j1"],
      statJob: statJobFrom({ j1: T2 }),
      readExecCoreEpoch: () => 0, // missing / malformed
    });
    expect(res.coldStart).toBe(true);
    expect(res.epochSource).toBe("daemon");
    expect(res.epoch).toBe(T1);
  });
});

describe("reclaimDeadWorkIfPossible — CTL-606 supersede guard", () => {
  const orch = "/orch";

  test("dead predecessor (triage) while a later phase is dispatched → 'superseded-noop', NO escalate", () => {
    const escalate = recorder(undefined); // appendEscalatedEvent spy
    const applyLabel = recorder(undefined); // applyStalledLabel spy
    const triageSig = {
      ticket: "CTL-9",
      phase: "triage",
      status: "running",
      liveness: { kind: "bg", value: "job-old" },
      raw: {
        ticket: "CTL-9",
        phase: "triage",
        orchestrator: "CTL-9",
        status: "running",
        bg_job_id: "job-old",
      },
    };
    const r = reclaimDeadWorkIfPossible(orch, triageSig, {
      statJob: () => null, // dead bg job
      listTicketPhases: () => ["triage", "research", "plan", "implement"],
      appendEscalatedEvent: escalate,
      applyStalledLabel: applyLabel,
    });
    expect(r).toBe("superseded-noop");
    expect(escalate.calls.length).toBe(0);
    expect(applyLabel.calls.length).toBe(0);
  });

  test("dead signal IS the latest dispatched phase → guard does NOT fire (existing behavior)", () => {
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => null,
      listTicketPhases: () => ["triage", "research", "plan", "implement"],
      probes: { implement: recorder(true) }, // work done → 'reclaimed'
      emitComplete: recorder({ code: 0 }),
      appendEvent: recorder(undefined),
      postReclaimMirror: () => {}, // CTL-664: keep the test hermetic (no linearis spawn)
    });
    expect(r).toBe("reclaimed");
  });

  test("guard never fires for an alive (state=working) signal — no listTicketPhases read on the hot path", () => {
    // CTL-736: a live worker has a non-terminal state.json lifecycle (`alive`),
    // which returns 'alive-suppressed' from the trigger branch ABOVE the
    // supersede guard — so the guard's listTicketPhases read is never reached.
    const listSpy = recorder(["triage", "research", "plan", "implement"]);
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => ({ exists: true, mtimeMs: Date.now(), state: "working" }),
      listTicketPhases: listSpy,
    });
    expect(r).toBe("alive-suppressed");
    expect(listSpy.calls.length).toBe(0); // guard runs only on the reclaim-eligible path
  });

  test("supersede guard tolerates unknown phase names in listTicketPhases (CTL-702)", () => {
    // listTicketPhases returns a yield-tombstone name. The reduce must skip it
    // via isKnownPhase, not throw PhaseFsmError. The triage signal is the dead
    // predecessor; implement is the latest KNOWN dispatched phase, so the
    // guard fires and returns 'superseded-noop'.
    const triasSig = {
      ticket: "CTL-702D",
      phase: "triage",
      status: "running",
      liveness: { kind: "bg", value: "job-old" },
      raw: { ticket: "CTL-702D", phase: "triage", status: "running", bg_job_id: "job-old" },
    };
    expect(() => {
      reclaimDeadWorkIfPossible(orch, triasSig, {
        statJob: () => null,
        listTicketPhases: () => ["triage", "plan-yield-20260528T050740Z", "plan", "implement"],
        appendEscalatedEvent: recorder(undefined),
        applyStalledLabel: recorder(undefined),
      });
    }).not.toThrow();
  });
});

describe("readBootSince — CTL-655 boot-time window reader", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctl655-boot-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns bootedAt from daemon-boot.json", () => {
    writeFileSync(join(dir, "daemon-boot.json"), JSON.stringify({ bootedAt: "2026-05-27T03:30:00Z" }));
    expect(readBootSince(dir)).toBe("2026-05-27T03:30:00Z");
  });

  test("returns undefined when marker missing / malformed (fail-open)", () => {
    // Empty dir → no marker.
    expect(readBootSince(dir)).toBeUndefined();
    // Non-JSON body.
    writeFileSync(join(dir, "daemon-boot.json"), "not json");
    expect(readBootSince(dir)).toBeUndefined();
    // Wrong-typed bootedAt (number, not ISO string).
    writeFileSync(join(dir, "daemon-boot.json"), JSON.stringify({ bootedAt: 123 }));
    expect(readBootSince(dir)).toBeUndefined();
    // Empty-string bootedAt is also rejected.
    writeFileSync(join(dir, "daemon-boot.json"), JSON.stringify({ bootedAt: "" }));
    expect(readBootSince(dir)).toBeUndefined();
  });
});

// CTL-736 Phase 3: at daemon boot, every per-(ticket, phase) progress high-water
// marker is cleared so a stale mark from a prior run cannot false-STOP this run's
// first death (the gate's "first death gets one revive" guarantee is per-run).
describe("clearProgressMarks — CTL-736 boot-time progress reset", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl736-progress-"));
  });
  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
  });

  function writeWorkerFile(ticket, name, body = "x") {
    const d = join(orchDir, "workers", ticket);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, name), body);
  }

  test("deletes every .progress-<phase> marker across all worker dirs", () => {
    writeWorkerFile("CTL-1", ".progress-implement", "4");
    writeWorkerFile("CTL-1", ".progress-verify", "120");
    writeWorkerFile("CTL-2", ".progress-research", "800");
    clearProgressMarks(orchDir);
    expect(existsSync(join(orchDir, "workers", "CTL-1", ".progress-implement"))).toBe(false);
    expect(existsSync(join(orchDir, "workers", "CTL-1", ".progress-verify"))).toBe(false);
    expect(existsSync(join(orchDir, "workers", "CTL-2", ".progress-research"))).toBe(false);
  });

  test("leaves non-progress worker files untouched (signals, claims, revive markers)", () => {
    writeWorkerFile("CTL-1", "phase-implement.json", "{}");
    writeWorkerFile("CTL-1", "implement.claim.1", "{}");
    writeWorkerFile("CTL-1", ".revive-1.applied", "ts");
    writeWorkerFile("CTL-1", ".progress-implement", "4");
    clearProgressMarks(orchDir);
    expect(existsSync(join(orchDir, "workers", "CTL-1", "phase-implement.json"))).toBe(true);
    expect(existsSync(join(orchDir, "workers", "CTL-1", "implement.claim.1"))).toBe(true);
    expect(existsSync(join(orchDir, "workers", "CTL-1", ".revive-1.applied"))).toBe(true);
    expect(existsSync(join(orchDir, "workers", "CTL-1", ".progress-implement"))).toBe(false);
  });

  test("no workers dir → no-op (fail-open, no throw)", () => {
    expect(() => clearProgressMarks(orchDir)).not.toThrow();
  });
});

// CTL-658 — JS port of orchestrate-revive's resolve_phase_session_id. Resolves a
// `claude --resume`-compatible session UUID from a dead worker's bg_job_id by
// reading <jobsDir>/<bg_job_id>/state.json to extract a claude --resume UUID.
// Two schemas supported:
//   New (Claude Code ≥2.x): state.json contains .resumeSessionId directly.
//   Legacy (Claude Code <2.x): state.json contains .linkScanPath; basename minus .jsonl = UUID.
// Mirrors the bash unit tests at __tests__/orchestrate-revive.test.sh:578-617.
describe("resolvePhaseSessionId", () => {
  let jobsDir;
  beforeEach(() => {
    jobsDir = mkdtempSync(join(tmpdir(), "exec-core-jobs-"));
  });
  afterEach(() => {
    rmSync(jobsDir, { recursive: true, force: true });
  });

  test("new schema — resumeSessionId returns UUID directly", () => {
    mkdirSync(join(jobsDir, "cafe1234"), { recursive: true });
    writeFileSync(
      join(jobsDir, "cafe1234", "state.json"),
      JSON.stringify({ resumeSessionId: "cc820da8-5e10-420b-bb54-dab3b61a3f8b" }),
    );
    expect(resolvePhaseSessionId("cafe1234", { jobsDir })).toBe(
      "cc820da8-5e10-420b-bb54-dab3b61a3f8b",
    );
  });

  test("new schema — resumeSessionId takes priority over linkScanPath", () => {
    mkdirSync(join(jobsDir, "dualschema"), { recursive: true });
    writeFileSync(
      join(jobsDir, "dualschema", "state.json"),
      JSON.stringify({
        resumeSessionId: "cc820da8-5e10-420b-bb54-dab3b61a3f8b",
        linkScanPath: "/p/9f8e-uuid.jsonl",
      }),
    );
    expect(resolvePhaseSessionId("dualschema", { jobsDir })).toBe(
      "cc820da8-5e10-420b-bb54-dab3b61a3f8b",
    );
  });

  test("legacy schema — linkScanPath .jsonl returns the UUID basename", () => {
    mkdirSync(join(jobsDir, "legacy1234"), { recursive: true });
    writeFileSync(
      join(jobsDir, "legacy1234", "state.json"),
      JSON.stringify({ linkScanPath: "/p/9f8e-uuid.jsonl" }),
    );
    expect(resolvePhaseSessionId("legacy1234", { jobsDir })).toBe("9f8e-uuid");
  });

  test("missing state.json returns null", () => {
    mkdirSync(join(jobsDir, "nostate"), { recursive: true });
    expect(resolvePhaseSessionId("nostate", { jobsDir })).toBeNull();
  });

  test("malformed linkScanPath (not .jsonl) returns null", () => {
    mkdirSync(join(jobsDir, "baddir"), { recursive: true });
    writeFileSync(
      join(jobsDir, "baddir", "state.json"),
      JSON.stringify({ linkScanPath: "/p/some-dir" }),
    );
    expect(resolvePhaseSessionId("baddir", { jobsDir })).toBeNull();
  });

  test("empty / null bgJobId returns null without fs access", () => {
    expect(resolvePhaseSessionId(null, { jobsDir })).toBeNull();
    expect(resolvePhaseSessionId("", { jobsDir })).toBeNull();
  });

  test("state.json with neither resumeSessionId nor linkScanPath returns null", () => {
    mkdirSync(join(jobsDir, "nolink"), { recursive: true });
    writeFileSync(join(jobsDir, "nolink", "state.json"), JSON.stringify({ state: "stopped" }));
    expect(resolvePhaseSessionId("nolink", { jobsDir })).toBeNull();
  });
});

// CTL-705 Phase 4/5: preemption and resume-after-preemption event envelopes.
describe("preemption event envelopes (CTL-705)", () => {
  let envCatalystDir;
  let prevCatalystDir;
  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    envCatalystDir = mkdtempSync(join(tmpdir(), "ctl705-preempt-"));
    process.env.CATALYST_DIR = envCatalystDir;
    mkdirSync(join(envCatalystDir, "events"), { recursive: true });
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(envCatalystDir, { recursive: true, force: true });
  });

  function readBackEnvelope() {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const lines = readFileSync(join(envCatalystDir, "events", `${ym}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }

  test("defaultAppendPreemptedEvent writes phase.<phase>.preempted.<TICKET> envelope", () => {
    const ok = defaultAppendPreemptedEvent({
      orchId: "CTL-2",
      ticket: "CTL-2",
      phase: "research",
      preemptedBy: "CTL-9",
      bgJobId: "abc12345",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe("phase.research.preempted.CTL-2");
    expect(env.attributes["event.action"]).toBe("preempted");
    expect(env.body.payload.preempted_by).toBe("CTL-9");
    expect(env.body.payload.bg_job_id).toBe("abc12345");
  });

  test("defaultAppendPreemptedEvent returns false on write failure, never throws", () => {
    // Remove the events dir and make envCatalystDir read-only to force a write failure.
    rmSync(join(envCatalystDir, "events"), { recursive: true, force: true });
    chmodSync(envCatalystDir, 0o555);
    let result;
    try {
      result = defaultAppendPreemptedEvent({
        orchId: "CTL-2", ticket: "CTL-2", phase: "research", preemptedBy: "CTL-9", bgJobId: "x",
      });
    } finally {
      chmodSync(envCatalystDir, 0o755);
    }
    expect(result).toBe(false);
  });

  test("defaultAppendResumedAfterPreemptionEvent writes phase.<phase>.resumed-after-preemption.<T>", () => {
    const ok = defaultAppendResumedAfterPreemptionEvent({
      orchId: "CTL-2",
      ticket: "CTL-2",
      phase: "research",
      resumeSession: "sess-uuid",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe("phase.research.resumed-after-preemption.CTL-2");
    expect(env.attributes["event.action"]).toBe("resumed-after-preemption");
    expect(env.body.payload.resume_session).toBe("sess-uuid");
  });
});

// CTL-684: parallelism-sampled + parallelism-adjusted event emitter round-trips.
describe("parallelism event envelopes (CTL-684)", () => {
  let envCatalystDir;
  let prevCatalystDir;
  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    envCatalystDir = mkdtempSync(join(tmpdir(), "ctl684-parallelism-"));
    process.env.CATALYST_DIR = envCatalystDir;
    mkdirSync(join(envCatalystDir, "events"), { recursive: true });
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(envCatalystDir, { recursive: true, force: true });
  });

  function readBackEnvelope() {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const lines = readFileSync(join(envCatalystDir, "events", `${ym}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }

  test("defaultAppendParallelismSampledEvent emits the expected envelope (CTL-684)", () => {
    const ok = defaultAppendParallelismSampledEvent({
      label: "execution-core",
      load1: 8.5,
      load5: 5.2,
      load15: 3.1,
      memFreePct: 45.0,
      bgCount: 7,
      maxParallelCurrent: 10,
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe("phase.scheduler.parallelism-sampled.execution-core");
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.attributes["event.action"]).toBe("parallelism-sampled");
    expect(env.attributes["catalyst.orchestration"]).toBe("execution-core");
    expect(env.body.payload.load1).toBe(8.5);
    expect(env.body.payload.load5).toBe(5.2);
    expect(env.body.payload.load15).toBe(3.1);
    expect(env.body.payload.mem_free_pct).toBe(45.0);
    expect(env.body.payload.bg_count).toBe(7);
    expect(env.body.payload.maxParallel_current).toBe(10);
  });

  test("defaultAppendParallelismSampledEvent uses 'execution-core' label by default (CTL-684)", () => {
    defaultAppendParallelismSampledEvent({
      load1: 1, load5: 1, load15: 1, memFreePct: 80, bgCount: 2, maxParallelCurrent: 5,
    });
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe("phase.scheduler.parallelism-sampled.execution-core");
  });

  test("defaultAppendParallelismAdjustedEvent emits the expected envelope (CTL-684)", () => {
    const ok = defaultAppendParallelismAdjustedEvent({
      label: "execution-core",
      oldMaxParallel: 10,
      newMaxParallel: 7,
      reason: "trend-up",
    });
    expect(ok).toBe(true);
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe("phase.scheduler.parallelism-adjusted.execution-core");
    expect(env.attributes["event.action"]).toBe("parallelism-adjusted");
    expect(env.body.payload.old_maxParallel).toBe(10);
    expect(env.body.payload.new_maxParallel).toBe(7);
    expect(env.body.payload.reason).toBe("trend-up");
  });

  test("defaultAppendParallelismAdjustedEvent uses 'execution-core' label by default (CTL-684)", () => {
    defaultAppendParallelismAdjustedEvent({
      oldMaxParallel: 5, newMaxParallel: 6, reason: "trend-down",
    });
    const env = readBackEnvelope();
    expect(env.attributes["event.name"]).toBe("phase.scheduler.parallelism-adjusted.execution-core");
  });
});

// CTL-549: reclaimDeadWorkIfPossible returns "noop" for needs-input signal
describe("reclaimDeadWorkIfPossible — needs-input guard (CTL-549)", () => {
  test("returns 'noop' for a needs-input signal without touching any seams", () => {
    const orch = "/orch";
    const sig = implementSignal({ status: "needs-input" });
    const probed = [];
    const dispatched = [];
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => ({ state: "stopped", firstTerminalAt: "2026-01-01T00:00:00Z" }),
      probes: { implement: () => { probed.push(true); return false; } },
      reviveDispatch: (...a) => { dispatched.push(a); return { code: 0 }; },
      emitComplete: () => ({ code: 0 }),
      appendEvent: () => {},
      appendReviveEvent: () => {},
      appendEscalatedEvent: () => {},
      appendReviveSuppressedEvent: () => {},
      applyStalledLabel: () => {},
      killBgJob: () => {},
      countReviveEvents: () => 0,
      writeReviveMarker: () => {},
      readBootSince: () => undefined,
      progressMark: () => 0,
      readProgressMark: () => 0,
      writeProgressMark: () => {},
      emitReapIntent: () => {},
      postReclaimMirror: () => {},
    });
    expect(r).toBe("noop");
    expect(probed).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
  });
});

// CTL-755 STEP D (CORRECTED) — a dead-but-work-done `triage` worker is reclaimed
// NORMALLY (emitComplete flips its signal to `triage:done`), exactly like any
// other phase. The admission gate is NOT enforced inside reclaim — it lives
// DOWNSTREAM at the scheduler's STEP-B advancement guard, which holds the
// triage→research promotion for any `triage:done` worker not in
// `admittedThisTick`. The earlier `reclaim-held` non-mutating outcome was a bug:
// a dead triage worker only reaches branch B with a NON-terminal signal (a `done`
// signal short-circuits to `noop` at the terminal gate), so holding it left the
// signal at `running` and the scheduler's STEP-A triaged-waiting pool (which keys
// on `triage === "done"`) skipped it FOREVER — the ticket stranded. Flipping the
// signal to `done` lands it exactly where STEP A expects, so the gate
// re-evaluates next tick (see scheduler.test.mjs "STEP D integration").
describe("reclaimDeadWorkIfPossible — CTL-755 dead-triage reclaim (gate is downstream)", () => {
  const orch = "/orch";

  // A dead (job dir gone) triage signal whose triage probe passes (work done) but
  // whose status never reached `done` (it died mid-flight as `running`). This is
  // the exact class the reclaim branch-B path recovers — and the class the old
  // `reclaim-held` early-return stranded.
  function triageSignal({ ticket = "CTL-7" } = {}) {
    return {
      ticket,
      phase: "triage",
      status: "running",
      liveness: { kind: "bg", value: "job-x" },
      signalPath: `/x/${ticket}/phase-triage.json`,
      raw: {
        ticket,
        phase: "triage",
        orchestrator: ticket,
        status: "running",
        bg_job_id: "job-x",
      },
    };
  }

  test("dead triage + work done → 'reclaimed', emit FIRES (signal flips to done; the gate is enforced downstream in the scheduler, not here)", () => {
    const probe = recorder(true); // triage.json present → work done
    const emit = recorder({ code: 0 });
    const appendEvent = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(orch, triageSignal(), {
      statJob: () => null, // dead-gone → reclaim-eligible
      probes: { triage: probe },
      emitComplete: emit,
      appendEvent,
      postReclaimMirror: () => {}, // keep hermetic
      now: () => 1_000,
    });
    expect(r).toBe("reclaimed");
    expect(probe.calls.length).toBe(1); // branch B was entered (probe ran)
    // The reclaim flips the signal to done so the scheduler's STEP A picks it up —
    // STEP B then holds the triage→research promotion until the ticket is admitted.
    expect(emit.calls.length).toBe(1);
    expect(appendEvent.calls.length).toBe(1);
  });

  test("triage reclaim emits the reap-intent for the dead bg job (no longer suppressed by a hold)", () => {
    const emitReapIntent = recorder(Promise.resolve());
    reclaimDeadWorkIfPossible(orch, triageSignal(), {
      statJob: () => null,
      probes: { triage: recorder(true) },
      emitComplete: recorder({ code: 0 }),
      appendEvent: recorder(undefined),
      emitReapIntent,
      postReclaimMirror: () => {},
      now: () => 1_000,
    });
    // The dead worker's lingering session is reaped (the old `reclaim-held`
    // non-mutating return skipped this, leaking the bg session).
    expect(emitReapIntent.calls.length).toBe(1);
  });

  test("a NON-triage dead worker (implement) with work done reclaims identically (no phase special-casing)", () => {
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const appendEvent = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => null,
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent,
      postReclaimMirror: () => {},
      now: () => 1_000,
    });
    expect(r).toBe("reclaimed");
    expect(emit.calls.length).toBe(1); // mid-pipeline reclaim proceeds
  });
});


describe("defaultReviveDispatch — CTL-761 attempt passthrough", () => {
  let orchDir;
  let prevCatalystDir;
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl761-revdisp-"));
    prevCatalystDir = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = orchDir;
    mkdirSync(join(orchDir, "events"), { recursive: true });
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(orchDir, { recursive: true, force: true });
  });

  function seed(ticket, phase, body) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify({ ticket, phase, ...body }));
  }

  test("attempt is forwarded to dispatch when set", () => {
    seed("CTL-761A", "implement", { status: "running", bg_job_id: "bg-a" });
    const dispatch = recorder({ code: 0 });
    defaultReviveDispatch(
      { orchDir, ticket: "CTL-761A", phase: "implement", attempt: 2 },
      { dispatch },
    );
    expect(dispatch.calls[0][0].attempt).toBe(2);
  });

  test("attempt absent → dispatch called without the key", () => {
    seed("CTL-761B", "implement", { status: "running", bg_job_id: "bg-b" });
    const dispatch = recorder({ code: 0 });
    defaultReviveDispatch(
      { orchDir, ticket: "CTL-761B", phase: "implement" },
      { dispatch },
    );
    expect("attempt" in dispatch.calls[0][0]).toBe(false);
  });
});

// --- CTL-663: partial-commit implement is resumed, not reclaimed ------------
// These tests lock the regression class discovered in CTL-661: a dead implement
// worker whose worktree has fewer commits than its plan has phases must be
// REVIVED (branch C), never RECLAIMED-AS-DONE (branch B). Uses the REAL
// implementProbe wired with fake git/fs seams through the `probes` injection.

describe("reclaimDeadWorkIfPossible — CTL-663 partial-commit implement is resumed, not reclaimed", () => {
  const orch = "/orch-663"; // hermetic fake orchDir (no disk writes succeed)

  // Local helpers (duplicated from work-done-probes.test.mjs for test clarity).
  function porcelainFor663(ticket, wt) {
    return [
      "worktree /repo",
      "HEAD abcdef0",
      "branch refs/heads/main",
      "",
      `worktree ${wt}`,
      "HEAD 1234567",
      `branch refs/heads/${ticket}`,
      "",
    ].join("\n");
  }
  function makeRunGit663(responses) {
    return (args) => {
      const key = args.join(" ");
      if (responses[key]) return responses[key];
      for (const [k, v] of Object.entries(responses)) {
        if (key.endsWith(k)) return v;
      }
      return { code: 1, stdout: "", stderr: `fake runGit: no match for ${key}` };
    };
  }

  // Five-phase plan fixture (>200 bytes, 5 ## Phase headers).
  const FIVE_PHASE_PLAN_BODY_663 = `# Plan: CTL-9

${"Overview and context for the five-phase implementation plan. ".repeat(5)}

## Phase 1: Setup

Establish the foundation and initial scaffolding.

## Phase 2: Core Logic

Implement the main business logic and algorithms.

## Phase 3: Integration

Wire up all components and integration points.

## Phase 4: Tests

Write comprehensive test coverage for all paths.

## Phase 5: Cleanup

Final polish, documentation, and code cleanup.

### Success Criteria
- [ ] All five phases land as discrete commits on the branch
`;

  // Minimal seam set for the revive/reclaim paths; override via the spread.
  function makeSeams663(extra = {}) {
    return {
      repoRoot: "/repo",
      emitComplete: recorder({ code: 0 }),
      appendEvent: recorder(undefined),
      appendReviveEvent: recorder(undefined),
      appendEscalatedEvent: recorder(undefined),
      appendReviveSuppressedEvent: recorder(undefined),
      reviveDispatch: recorder({ code: 0 }),
      applyStalledLabel: recorder({ applied: true }),
      killBgJob: recorder(undefined),
      countReviveEvents: recorder(0),
      writeReviveMarker: recorder(undefined),
      resolveSession: () => null,
      postReclaimMirror: recorder(undefined),
      listTicketPhases: () => ["implement"],
      inEscalationCooldownFn: () => false,
      recordEscalationFn: recorder(undefined),
      emitReapIntent: () => Promise.resolve(),
      readBootSince: () => undefined,
      breaker: { isOpen: () => false },
      now: () => 1_000_000,
      progressMark: () => 1,      // 1 commit ahead → has forward progress
      readProgressMark: () => 0,  // watermark 0 → progress advanced
      writeProgressMark: recorder(undefined),
      ...extra,
    };
  }

  // Factory: real implementProbe with fake git/fs at a given commit count.
  function makeRealProbe(commitCount) {
    const wt = "/wt/CTL-9";
    return (args) =>
      WORK_DONE_PROBES.implement(args, {
        runGit: makeRunGit663({
          "-C /repo worktree list --porcelain": { code: 0, stdout: porcelainFor663("CTL-9", wt), stderr: "" },
          [`-C ${wt} rev-list --count origin/main..HEAD`]: { code: 0, stdout: `${commitCount}\n`, stderr: "" },
          [`-C ${wt} status --porcelain`]: { code: 0, stdout: "", stderr: "" },
        }),
        listArtifacts: () => ["2026-06-07-ctl-9.md"],
        readArtifact: () => FIVE_PHASE_PLAN_BODY_663,
      });
  }

  test("dead worker, 1-of-5 commits → 'revived' (branch C), emitComplete NEVER called", () => {
    const emit = recorder({ code: 0 });
    const reviveDispatch = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), makeSeams663({
      probes: { implement: makeRealProbe(1) },
      jobLifecycle: () => "dead-gone",
      emitComplete: emit,
      reviveDispatch,
    }));
    expect(r).toBe("revived");
    expect(emit.calls.length).toBe(0);
    expect(reviveDispatch.calls.length).toBe(1);
  });

  test("dead worker, 5-of-5 commits → 'reclaimed' (branch B still works at true completion)", () => {
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), makeSeams663({
      probes: { implement: makeRealProbe(5) },
      jobLifecycle: () => "dead-gone",
      emitComplete: emit,
    }));
    expect(r).toBe("reclaimed");
    expect(emit.calls.length).toBe(1);
  });

  test("dead worker, 1 commit, NO plan doc → 'reclaimed' (backward-compatible planless path)", () => {
    const wt = "/wt/CTL-9";
    const emit = recorder({ code: 0 });
    const noPlanProbe = (args) =>
      WORK_DONE_PROBES.implement(args, {
        runGit: makeRunGit663({
          "-C /repo worktree list --porcelain": { code: 0, stdout: porcelainFor663("CTL-9", wt), stderr: "" },
          [`-C ${wt} rev-list --count origin/main..HEAD`]: { code: 0, stdout: "1\n", stderr: "" },
          [`-C ${wt} status --porcelain`]: { code: 0, stdout: "", stderr: "" },
        }),
        listArtifacts: () => [], // no plan doc → gate skipped
        readArtifact: () => "",
      });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), makeSeams663({
      probes: { implement: noPlanProbe },
      jobLifecycle: () => "dead-gone",
      emitComplete: emit,
    }));
    expect(r).toBe("reclaimed");
    expect(emit.calls.length).toBe(1);
  });
});

// ─── CTL-1090: readClusterHeartbeats cross-host merge ────────────────────────

import { readClusterHeartbeats } from "./recovery.mjs";

const makeHbLine = (host, ts) =>
  JSON.stringify({
    ts,
    attributes: { "event.name": "node.heartbeat" },
    body: { payload: { "host.name": host } },
  });

describe("readClusterHeartbeats — cross-host peer merge (CTL-1090)", () => {
  let tmpDir;
  let logPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctl1090-hb-"));
    logPath = join(tmpDir, "events.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("multi-host: merges injected peer timestamps over the local map", () => {
    writeFileSync(logPath, makeHbLine("mini", "2026-06-13T01:00:00Z") + "\n");
    const readPeers = () => ({
      laptop: { host: "laptop", last_seen: "2026-06-13T00:55:00Z", in_flight_tickets: [] },
    });
    const result = readClusterHeartbeats({
      logPath,
      roster: ["mini", "laptop"],
      anchorIssue: "CTL-9999",
      readPeers,
    });
    expect(result.mini).toBe("2026-06-13T01:00:00Z");
    expect(result.laptop).toBe("2026-06-13T00:55:00Z");
  });

  test("peer entry never clobbers a FRESHER local timestamp for the same host", () => {
    const localTs = "2026-06-13T01:05:00Z";
    const peerTs = "2026-06-13T00:50:00Z";
    writeFileSync(logPath, makeHbLine("mini", localTs) + "\n");
    const readPeers = () => ({
      mini: { host: "mini", last_seen: peerTs, in_flight_tickets: [] },
    });
    const result = readClusterHeartbeats({
      logPath,
      roster: ["mini", "laptop"],
      anchorIssue: "CTL-9999",
      readPeers,
    });
    expect(result.mini).toBe(localTs); // local fresher wins
  });

  test("single-host (roster<=1): peer reader is NEVER called — exact no-op", () => {
    const readPeers = () => { throw new Error("must not be called single-host"); };
    expect(() =>
      readClusterHeartbeats({
        logPath: join(tmpDir, "absent.jsonl"),
        roster: ["mini"],
        anchorIssue: "CTL-9999",
        readPeers,
      }),
    ).not.toThrow();
  });

  test("peer-read failure is swallowed — returns the local map", () => {
    writeFileSync(logPath, makeHbLine("mini", "2026-06-13T01:00:00Z") + "\n");
    const readPeers = () => { throw new Error("Linear down"); };
    const result = readClusterHeartbeats({
      logPath,
      roster: ["mini", "laptop"],
      anchorIssue: "CTL-9999",
      readPeers,
    });
    expect(result.mini).toBe("2026-06-13T01:00:00Z");
    expect(result.laptop).toBeUndefined();
  });

  test("no anchorIssue → no peer read, local map only", () => {
    const readPeers = () => { throw new Error("must not be called"); };
    const result = readClusterHeartbeats({
      logPath: join(tmpDir, "absent.jsonl"),
      roster: ["mini", "laptop"],
      anchorIssue: null,
      readPeers,
    });
    expect(result).toEqual({});
  });

  test("missing log file with multi-host + anchor → returns peers only", () => {
    const readPeers = () => ({
      laptop: { host: "laptop", last_seen: "2026-06-13T00:55:00Z", in_flight_tickets: [] },
    });
    const result = readClusterHeartbeats({
      logPath: join(tmpDir, "absent.jsonl"),
      roster: ["mini", "laptop"],
      anchorIssue: "CTL-9999",
      readPeers,
    });
    expect(result.laptop).toBe("2026-06-13T00:55:00Z");
    expect(result.mini).toBeUndefined();
  });

  // CTL-1090 review hardening: a peer's last_seen is untrusted. An unparseable
  // value must never enter the merged map — otherwise it sorts above real ISO
  // strings and (via deadHosts' Date.parse → NaN) makes the host look
  // forever-alive, silently defeating takeover.
  test("garbage peer last_seen is dropped, never poisons the merge", () => {
    const readPeers = () => ({
      laptop: { host: "laptop", last_seen: "zzz-not-a-date", in_flight_tickets: [] },
    });
    const result = readClusterHeartbeats({
      logPath: join(tmpDir, "absent.jsonl"),
      roster: ["mini", "laptop"],
      anchorIssue: "CTL-9999",
      readPeers,
    });
    expect(result.laptop).toBeUndefined();
  });

  // CTL-1090 review hardening: local ts is second-precision (millis stripped),
  // peers publish millisecond ISO. A genuinely newer peer ts within the same
  // second must win — a lexicographic compare would wrongly discard it because
  // "…00.500Z" < "…00Z".
  test("mixed-precision: a newer millisecond peer ts beats a second-precision local ts", () => {
    const localTs = "2026-06-13T01:00:00Z";        // second precision (from event log)
    const peerTs = "2026-06-13T01:00:00.500Z";     // 500ms later, same second
    writeFileSync(logPath, makeHbLine("mini", localTs) + "\n");
    const readPeers = () => ({
      mini: { host: "mini", last_seen: peerTs, in_flight_tickets: [] },
    });
    const result = readClusterHeartbeats({
      logPath,
      roster: ["mini", "laptop"],
      anchorIssue: "CTL-9999",
      readPeers,
    });
    expect(result.mini).toBe(peerTs); // newer peer wins under numeric compare
  });
});

// ─── CTL-1090: deadHosts flags a stale peer (pure function, no change needed) ─

describe("deadHosts — flags a stale peer in merged lastSeen (CTL-1090)", () => {
  test("a peer with an aged last_seen is flagged dead", () => {
    const now = Date.parse("2026-06-13T02:00:00Z");
    const lastSeen = {
      mini: "2026-06-13T01:59:30Z",   // 30s ago — alive
      laptop: "2026-06-13T01:40:00Z", // 20m ago — dead (past 10m grace)
    };
    // deadHosts is imported below; use the already-imported version
    const { deadHosts: dh } = { deadHosts };
    expect(dh({ lastSeen, roster: ["mini", "laptop"], graceMs: 600_000, nowMs: now }))
      .toEqual(["laptop"]);
  });
});

// ─── CTL-1090: reclaimDeadHostWork respects injected ownedTicketsForHost ──────
// defaultOwnedTicketsForHost is internal; its peer-ticket logic is covered by the
// reclaimDeadHostWork seam (ownedTicketsForHost option). The injectable seam is the
// correct test surface (same pattern used for all other collaborators).

describe("reclaimDeadHostWork — peer in_flight_tickets seam (CTL-1090)", () => {
  const nowISO1090 = () => new Date().toISOString();
  const oldISO1090 = () => new Date(Date.now() - 20 * 60_000).toISOString();

  test("ownedTicketsForHost returning peer tickets results in dispatch", async () => {
    const dispatched = [];
    await reclaimDeadHostWork(
      { orchDir: "/o" },
      {
        readHeartbeats: () => ({ mini: nowISO1090(), laptop: oldISO1090() }),
        roster: ["mini", "laptop"],
        self: "mini",
        graceMs: 600_000,
        nowMs: Date.now(),
        ownedTicketsForHost: () => ["CTL-7", "CTL-8"],
        ownerForTicket: () => "mini",
        claim: () => ({ won: true, generation: 1 }),
        inferResume: async () => "implement",
        alreadyComplete: () => false,
        rebuildWorktree: () => ({ ok: true, cwd: "/wt/CTL-7" }),
        thoughtsPull: () => ({ ok: true }),
        dispatch: (od, ticket) => { dispatched.push(ticket); return { code: 0 }; },
      },
    );
    expect(dispatched.sort()).toEqual(["CTL-7", "CTL-8"]);
  });

  test("single-host roster: exact no-op regardless of injected seams", async () => {
    let dispatched = false;
    const r = await reclaimDeadHostWork(
      { orchDir: "/o" },
      {
        roster: ["mini"],
        dispatch: () => { dispatched = true; return { code: 0 }; },
      },
    );
    expect(dispatched).toBe(false);
    expect(r.taken).toEqual([]);
  });
});

// ─── CTL-863: deadHosts, survivingRoster, inferResumePhase ───────────────────

import { deadHosts, survivingRoster, inferResumePhase } from "./recovery.mjs";

describe("deadHosts — grace-window evaluation (CTL-863)", () => {
  test("flags hosts past the grace window, keeps fresh ones", () => {
    const now = Date.parse("2026-06-08T20:00:00Z");
    const lastSeen = {
      mini: "2026-06-08T19:59:30Z",        // 30s ago — alive
      "mac-studio": "2026-06-08T19:40:00Z", // 20m ago — dead
    };
    const dead = deadHosts({ lastSeen, roster: ["mini", "mac-studio"], graceMs: 600_000, nowMs: now });
    expect(dead).toEqual(["mac-studio"]);
  });

  test("a host absent from lastSeen is not flagged dead (no cross-host visibility)", () => {
    const now = Date.parse("2026-06-08T20:00:00Z");
    const dead = deadHosts({
      lastSeen: { mini: "2026-06-08T19:59:55Z" },
      roster: ["mini", "ghost"],
      graceMs: 600_000,
      nowMs: now,
    });
    expect(dead).toEqual([]);
  });

  test("empty roster returns empty dead list", () => {
    const dead = deadHosts({ lastSeen: {}, roster: [], graceMs: 600_000, nowMs: Date.now() });
    expect(dead).toEqual([]);
  });

  test("host exactly at the grace boundary (equal) is NOT dead", () => {
    const now = Date.parse("2026-06-08T20:00:00Z");
    const cutoff = now - 600_000; // exactly at boundary
    const lastSeen = { mini: new Date(cutoff).toISOString() };
    const dead = deadHosts({ lastSeen, roster: ["mini"], graceMs: 600_000, nowMs: now });
    expect(dead).toEqual([]);
  });
});

describe("survivingRoster — in-memory dead-host removal (CTL-863)", () => {
  test("removes dead hosts without mutating the roster", () => {
    const roster = ["mini", "mac-studio", "laptop"];
    const survivors = survivingRoster(roster, ["mac-studio"]);
    expect(survivors).toEqual(["mini", "laptop"]);
    expect(roster).toEqual(["mini", "mac-studio", "laptop"]); // unchanged
  });

  test("empty dead list returns a copy of the full roster", () => {
    const roster = ["mini", "mac-studio"];
    expect(survivingRoster(roster, [])).toEqual(["mini", "mac-studio"]);
  });

  test("all dead → empty survivors", () => {
    expect(survivingRoster(["mini"], ["mini"])).toEqual([]);
  });
});

describe("inferResumePhase — reverse-order probe walk (CTL-863)", () => {
  // CTL-703 (on main at merge): `teardown` is the descriptor's TERMINAL_PHASE,
  // appended after monitor-deploy. inferResumePhase derives its walk order from
  // STAGE_RANK, so the full phase set the probes must cover now ends in teardown
  // (otherwise "all done" resumes at the unprobed teardown instead of terminating).
  const allPhases = [
    "triage", "research", "plan", "implement", "verify", "review",
    "pr", "monitor-merge", "monitor-deploy", "teardown",
  ];

  test("plan done, implement not → resume at implement", async () => {
    const probes = Object.fromEntries(allPhases.map((p) => {
      const done = ["triage", "research", "plan"].includes(p);
      return [p, async () => done];
    }));
    const next = await inferResumePhase("CTL-900", { probes, cwd: "/wt" });
    expect(next).toBe("implement");
  });

  test("nothing done → resume at entry phase (research)", async () => {
    const probes = Object.fromEntries(allPhases.map((p) => [p, async () => false]));
    const next = await inferResumePhase("CTL-900", { probes, cwd: "/wt" });
    expect(next).toBe("research");
  });

  test("all done → null (terminal; nothing to resume)", async () => {
    const probes = Object.fromEntries(allPhases.map((p) => [p, async () => true]));
    const next = await inferResumePhase("CTL-900", { probes, cwd: "/wt" });
    expect(next).toBeNull();
  });

  test("monitor-merge done, monitor-deploy not → resume at monitor-deploy", async () => {
    const done = new Set(["triage","research","plan","implement","verify","review","pr","monitor-merge"]);
    const probes = Object.fromEntries(allPhases.map((p) => [p, async () => done.has(p)]));
    const next = await inferResumePhase("CTL-900", { probes, cwd: "/wt" });
    expect(next).toBe("monitor-deploy");
  });

  test("only triage done → resume at research (entry phase)", async () => {
    const probes = Object.fromEntries(allPhases.map((p) => [p, async () => p === "triage"]));
    const next = await inferResumePhase("CTL-900", { probes, cwd: "/wt" });
    expect(next).toBe("research");
  });
});

// ─── CTL-863: phaseAlreadyComplete ───────────────────────────────────────────

import { phaseAlreadyComplete } from "./recovery.mjs";

describe("phaseAlreadyComplete — event-log dedup (CTL-863)", () => {
  test("true when a matching complete event is in the log", () => {
    const lines = [
      JSON.stringify({ attributes: { "event.name": "phase.research.complete.CTL-900" } }),
    ].join("\n");
    expect(phaseAlreadyComplete("CTL-900", "research", { readLog: () => lines })).toBe(true);
  });

  test("false when no matching event (different ticket)", () => {
    const lines = JSON.stringify({ attributes: { "event.name": "phase.research.complete.CTL-999" } });
    expect(phaseAlreadyComplete("CTL-900", "research", { readLog: () => lines })).toBe(false);
  });

  test("false when no matching event (different phase)", () => {
    const lines = JSON.stringify({ attributes: { "event.name": "phase.plan.complete.CTL-900" } });
    expect(phaseAlreadyComplete("CTL-900", "research", { readLog: () => lines })).toBe(false);
  });

  test("false on missing/unreadable log (never throws)", () => {
    expect(phaseAlreadyComplete("CTL-900", "research", {
      readLog: () => { throw new Error("no file"); },
    })).toBe(false);
  });

  test("false when log is empty", () => {
    expect(phaseAlreadyComplete("CTL-900", "research", { readLog: () => "" })).toBe(false);
  });

  test("handles malformed JSON lines gracefully", () => {
    const lines = "not-json\n" + JSON.stringify({ attributes: { "event.name": "phase.research.complete.CTL-900" } });
    expect(phaseAlreadyComplete("CTL-900", "research", { readLog: () => lines })).toBe(true);
  });
});

// ─── CTL-863: reclaimDeadHostWork ────────────────────────────────────────────

import { reclaimDeadHostWork } from "./recovery.mjs";

const nowISO = () => new Date().toISOString();
const oldISO = () => new Date(Date.now() - 20 * 60_000).toISOString(); // 20m ago

const makeBaseDeps = (overrides = {}) => ({
  readHeartbeats: () => ({ mini: nowISO(), dead: oldISO() }),
  roster: ["mini", "dead"],
  self: "mini",
  graceMs: 600_000,
  nowMs: Date.now(),
  ownedTicketsForHost: () => ["CTL-900"],
  ownerForTicket: () => "mini",
  claim: () => ({ won: true, generation: 5 }),
  inferResume: async () => "implement",
  alreadyComplete: () => false,
  rebuildWorktree: () => ({ ok: true, cwd: "/wt/CTL-900" }),
  dispatch: () => ({ code: 0 }),
  ...overrides,
});

describe("reclaimDeadHostWork — takeover sweep (CTL-863)", () => {
  test("single-host roster → no-op (no dispatch)", async () => {
    let dispatched = false;
    const r = await reclaimDeadHostWork(
      { orchDir: "/o" },
      makeBaseDeps({ roster: ["mini"], dispatch: () => { dispatched = true; return { code: 0 }; } }),
    );
    expect(dispatched).toBe(false);
    expect(r.taken).toEqual([]);
  });

  test("dead host owns a ticket we re-own → claim+infer+rebuild+dispatch, taken has entry", async () => {
    let dispatched = false;
    const r = await reclaimDeadHostWork(
      { orchDir: "/o" },
      makeBaseDeps({ dispatch: () => { dispatched = true; return { code: 0 }; } }),
    );
    expect(dispatched).toBe(true);
    expect(r.taken).toEqual([{ ticket: "CTL-900", phase: "implement", generation: 5 }]);
  });

  test("HRW says another survivor owns it → skip (no claim, no dispatch)", async () => {
    let claimed = false;
    let dispatched = false;
    const r = await reclaimDeadHostWork(
      { orchDir: "/o" },
      makeBaseDeps({
        ownerForTicket: () => "other-host",
        claim: () => { claimed = true; return { won: true, generation: 5 }; },
        dispatch: () => { dispatched = true; return { code: 0 }; },
      }),
    );
    expect(claimed).toBe(false);
    expect(dispatched).toBe(false);
    expect(r.taken).toEqual([]);
  });

  test("lost claim (another survivor won the read-back) → no dispatch", async () => {
    let dispatched = false;
    const r = await reclaimDeadHostWork(
      { orchDir: "/o" },
      makeBaseDeps({
        claim: () => ({ won: false, generation: null }),
        dispatch: () => { dispatched = true; return { code: 0 }; },
      }),
    );
    expect(dispatched).toBe(false);
    expect(r.taken).toEqual([]);
  });

  test("inferred phase already complete in the log → dedup, skip dispatch", async () => {
    let dispatched = false;
    const r = await reclaimDeadHostWork(
      { orchDir: "/o" },
      makeBaseDeps({
        alreadyComplete: () => true,
        dispatch: () => { dispatched = true; return { code: 0 }; },
      }),
    );
    expect(dispatched).toBe(false);
    expect(r.taken).toEqual([]);
  });

  test("inferResume returns null (terminal) → nothing to resume", async () => {
    let dispatched = false;
    const r = await reclaimDeadHostWork(
      { orchDir: "/o" },
      makeBaseDeps({
        inferResume: async () => null,
        dispatch: () => { dispatched = true; return { code: 0 }; },
      }),
    );
    expect(dispatched).toBe(false);
    expect(r.taken).toEqual([]);
  });

  test("no dead hosts → no-op (no dispatch)", async () => {
    let dispatched = false;
    const r = await reclaimDeadHostWork(
      { orchDir: "/o" },
      makeBaseDeps({
        readHeartbeats: () => ({ mini: nowISO(), dead: nowISO() }),
        dispatch: () => { dispatched = true; return { code: 0 }; },
      }),
    );
    expect(dispatched).toBe(false);
    expect(r.taken).toEqual([]);
  });

  test("rebuildWorktree fails → skip dispatch for that ticket", async () => {
    let dispatched = false;
    const r = await reclaimDeadHostWork(
      { orchDir: "/o" },
      makeBaseDeps({
        rebuildWorktree: () => ({ ok: false, cwd: null }),
        dispatch: () => { dispatched = true; return { code: 0 }; },
      }),
    );
    expect(dispatched).toBe(false);
    expect(r.taken).toEqual([]);
  });

  test("multiple tickets owned by dead host: processes all in taken", async () => {
    const dispatches = [];
    const r = await reclaimDeadHostWork(
      { orchDir: "/o" },
      makeBaseDeps({
        ownedTicketsForHost: () => ["CTL-900", "CTL-901"],
        dispatch: (od, t) => { dispatches.push(t); return { code: 0 }; },
      }),
    );
    expect(dispatches.sort()).toEqual(["CTL-900", "CTL-901"]);
    expect(r.taken).toHaveLength(2);
  });
});

// ─── CTL-866: thoughtsPull seam in reclaimDeadHostWork ───────────────────────

describe("reclaimDeadHostWork — thoughtsPull seam (CTL-866)", () => {
  test("CTL-866: thoughtsPull runs after rebuildWorktree and before inferResume", async () => {
    const order = [];
    await reclaimDeadHostWork({ orchDir: "/o" }, makeBaseDeps({
      rebuildWorktree: () => { order.push("rebuild"); return { ok: true, cwd: "/wt/CTL-900" }; },
      thoughtsPull: (cwd) => { order.push(`pull:${cwd}`); return { ok: true }; },
      inferResume: async () => { order.push("infer"); return "implement"; },
    }));
    expect(order).toEqual(["rebuild", "pull:/wt/CTL-900", "infer"]);
  });

  test("CTL-866: thoughtsPull failure is fail-open — reclaim still dispatches", async () => {
    let dispatched = false;
    const r = await reclaimDeadHostWork({ orchDir: "/o" }, makeBaseDeps({
      thoughtsPull: () => { throw new Error("pull boom"); },
      dispatch: () => { dispatched = true; return { code: 0 }; },
    }));
    expect(dispatched).toBe(true);
    expect(r.taken).toHaveLength(1);
  });

  test("CTL-866: single-host roster → no thoughtsPull (whole fn short-circuits)", async () => {
    let pulled = false;
    await reclaimDeadHostWork({ orchDir: "/o" }, makeBaseDeps({
      roster: ["mini"],
      thoughtsPull: () => { pulled = true; return { ok: true }; },
    }));
    expect(pulled).toBe(false);
  });

  test("CTL-866: rebuildWorktree failure → thoughtsPull NOT called (skipped with the ticket)", async () => {
    let pulled = false;
    await reclaimDeadHostWork({ orchDir: "/o" }, makeBaseDeps({
      rebuildWorktree: () => ({ ok: false, cwd: null }),
      thoughtsPull: () => { pulled = true; return { ok: true }; },
    }));
    expect(pulled).toBe(false);
  });
});

// CTL-778 Step 3 — alive-probe-reclaim: an alive worker that has emitted
// phase.<phase>.complete AND whose probe passes is reconciled without waiting
// for it to die. The completeEventSeen seam is the precise disambiguator
// between "done-but-idle" (reclaim) and "busy fan-out" (suppress).
describe("reclaimDeadWorkIfPossible — CTL-778 alive-probe-reclaim", () => {
  const orch = "/orch";
  const STARTED = "2026-06-08T00:00:00Z";

  test("CTL-778: alive + complete event seen + probe done → reclaimed", () => {
    const emit = recorder({ code: 0 });
    const reap = recorder(Promise.resolve());
    const appendEvent = recorder(undefined);
    const sig = implementSignal({ bgJobId: "abc12345", startedAt: STARTED });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => ({ exists: true, state: "working" }), // jobLifecycle → alive
      probes: { implement: recorder(true) },
      completeEventSeen: () => true,
      emitComplete: emit,
      emitReapIntent: reap,
      appendEvent,
      postReclaimMirror: () => {},
      agentsSnapshot: () => ({ agents: [{ sessionId: "abc12345-0000-0000-0000-000000000000" }], isFresh: true, ageMs: 0 }),
      now: () => Date.parse(STARTED) + 1000,
    });
    expect(r).toBe("reclaimed");
    expect(emit.calls.length).toBe(1);
    expect(reap.calls[0][0]).toBe("phase.reclaim.reap-requested");
    expect(appendEvent.calls.length).toBe(1);
  });

  test("CTL-778: alive + probe done but NO complete event → still alive-suppressed", () => {
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const sig = implementSignal({ bgJobId: "abc12345", startedAt: STARTED });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => ({ exists: true, state: "working" }),
      probes: { implement: probe },
      completeEventSeen: () => false, // gate closed
      emitComplete: emit,
      appendEvent: recorder(undefined),
      agentsSnapshot: () => ({ agents: [{ sessionId: "abc12345-0000-0000-0000-000000000000" }], isFresh: true, ageMs: 0 }),
      now: () => Date.parse(STARTED) + 1000,
    });
    expect(r).toBe("alive-suppressed");
    expect(emit.calls.length).toBe(0);
  });

  test("CTL-778: alive + complete event seen but probe NOT done → alive-suppressed (no false flip)", () => {
    const emit = recorder({ code: 0 });
    const sig = implementSignal({ bgJobId: "abc12345", startedAt: STARTED });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => ({ exists: true, state: "working" }),
      probes: { implement: recorder(false) },
      completeEventSeen: () => true,
      emitComplete: emit,
      appendEvent: recorder(undefined),
      agentsSnapshot: () => ({ agents: [{ sessionId: "abc12345-0000-0000-0000-000000000000" }], isFresh: true, ageMs: 0 }),
      now: () => Date.parse(STARTED) + 1000,
    });
    expect(r).toBe("alive-suppressed");
    expect(emit.calls.length).toBe(0);
  });

  test("CTL-778: alive + complete event + probe done but emitComplete fails → reclaim-failed, no mirror", () => {
    const mirror = recorder(undefined);
    const sig = implementSignal({ bgJobId: "abc12345", startedAt: STARTED });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => ({ exists: true, state: "working" }),
      probes: { implement: recorder(true) },
      completeEventSeen: () => true,
      emitComplete: recorder({ code: 1 }),
      emitReapIntent: recorder(Promise.resolve()),
      appendEvent: recorder(undefined),
      postReclaimMirror: mirror,
      agentsSnapshot: () => ({ agents: [{ sessionId: "abc12345-0000-0000-0000-000000000000" }], isFresh: true, ageMs: 0 }),
      now: () => Date.parse(STARTED) + 1000,
    });
    expect(r).toBe("reclaim-failed");
    expect(mirror.calls.length).toBe(0);
  });

  // Regression: the existing CTL-736 test (no completeEventSeen injected → seam defaults
  // to a fn that returns false from an empty/absent log) must still pass unchanged.
  test("CTL-736 regression: alive worker without complete event is still alive-suppressed, probe never called", () => {
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => ({ exists: true, mtimeMs: 1_000, state: "working" }),
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      now: () => 1_000 + 60 * 60 * 1000,
      // completeEventSeen NOT injected — defaults to hasCompleteEvent({path}) → false (empty log)
    });
    expect(r).toBe("alive-suppressed");
    expect(probe.calls.length).toBe(0);
    expect(emit.calls.length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// CTL-1065: escalateOnce carries a valid structured explanation
// ──────────────────────────────────────────────────────────────────────────
import { validateExplanation } from "./escalation-explanation.mjs";

describe("CTL-1065: reclaimDeadWorkIfPossible escalated event carries explanation", () => {
  const orch = mkdtempSync(join(tmpdir(), "ctl1065-reclaim-"));
  afterEach(() => { try { rmSync(orch, { recursive: true, force: true }); } catch { /* */ } });

  function impl1065(extra = {}) {
    mkdirSync(join(orch, "workers", "CTL-65"), { recursive: true });
    return {
      ticket: "CTL-65", phase: "implement", status: "running",
      startedAt: new Date(0).toISOString(),
      liveness: { kind: "bg", value: "abcd1234" },
      raw: { bg_job_id: "abcd1234", generation: 1, startedAt: new Date(0).toISOString() },
      ...extra,
    };
  }

  test("busy-ceiling escalation carries a valid explanation alongside reason", () => {
    const captured = [];
    const appendEscalatedEvent = (obj) => captured.push(obj);
    reclaimDeadWorkIfPossible(
      orch,
      impl1065(),
      {
        statJob: () => ({ mtimeMs: Date.now(), exists: true }),
        jobLifecycle: () => "alive",
        busyCeilingMs: 1,
        now: () => 10_000,
        probes: { implement: () => false },
        appendEscalatedEvent,
        applyStalledLabel: recorder({ applied: true }),
        inEscalationCooldownFn: () => false,
        recordEscalationFn: () => {},
        breaker: { isOpen: () => false },
      },
    );
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const call = captured[0];
    expect(call.reason).toBe("busy-ceiling-exceeded"); // unchanged
    const expl = call.extras?.explanation;
    expect(expl).toBeTruthy();
    expect(validateExplanation(expl).valid).toBe(true);
  });
});
