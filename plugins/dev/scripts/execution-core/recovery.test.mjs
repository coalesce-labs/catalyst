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
  readBootEpoch,
  readDaemonEpoch,
  defaultReadRuntimeEpoch,
  detectColdStart,
  readBootSince,
} from "./recovery.mjs";
import { saveCursor } from "./event-cursor.mjs";
import { dropProject } from "./eligible-set.mjs";
import { existsSync, appendFileSync } from "node:fs";

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
  test("terminal status (done/failed/stalled/turn-cap-exhausted) → 'terminal'", () => {
    for (const status of ["done", "failed", "stalled", "turn-cap-exhausted"]) {
      expect(
        classifyWorker(bgSignal(status, "job-x"), { statJob: () => null }),
      ).toBe("terminal");
    }
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
function implementSignal({ ticket = "CTL-9", status = "running", bgJobId = "job-x" } = {}) {
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

  test("CTL-662: a BUSY worker is 'alive-busy-suppressed', never reclaimed (regardless of elapsed time)", () => {
    // The CTL-662 fix: a busy worker (a live `claude agents` session with an open
    // turn — e.g. an in-process sub-agent fan-out) is NEVER auto-reclaimed, even
    // though its state.json mtime may be arbitrarily stale.
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => ({ exists: true, mtimeMs: 1_000 }),
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      liveness: () => "busy",
      now: () => 1_000 + 60 * 60 * 1000, // an hour past mtime — irrelevant now
    });
    expect(r).toBe("alive-busy-suppressed");
    expect(probe.calls.length).toBe(0); // busy short-circuits before the probe
    expect(emit.calls.length).toBe(0);
  });

  test("CTL-662: an ABSENT worker (no live session) with work done is reclaimed", () => {
    // absent = not listed by `claude agents` (crashed/exited) → reclaim-eligible
    // immediately, no idle-confirmation needed. Replaces the pre-CTL-662
    // stale-mtime "effectively dead" trigger.
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const appendEvent = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => ({ exists: true, mtimeMs: 1_000 }),
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent,
      postReclaimMirror: () => {}, // CTL-664: keep the test hermetic (no linearis spawn)
      liveness: () => "absent",
      now: () => 1_000,
    });
    expect(r).toBe("reclaimed");
    expect(probe.calls.length).toBe(1);
    expect(emit.calls.length).toBe(1);
    expect(appendEvent.calls.length).toBe(1);
  });

  test("CTL-662: a BUSY worker with work done is still suppressed (left to emit its own complete)", () => {
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => ({ exists: true, mtimeMs: 1_000_000 }),
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      liveness: () => "busy",
      now: () => 1_000_000 + 60_000,
    });
    expect(r).toBe("alive-busy-suppressed");
    expect(emit.calls.length).toBe(0);
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

  // CTL-587: this case used to return 'not-applicable' (a silent dead-end).
  // It now escalates immediately — no probe means no way to verify the work,
  // so the human must look. needs-human label is applied via the injected seam.
  test("CTL-587: dead worker, probe NOT done + revive budget exhausted → 'escalated' + needs-human label", () => {
    // CTL-641: every pipeline phase now has a probe, so the old branch-(A)
    // "no-probe-for-phase" escalation is unreachable for real phases (and CTL-606's
    // supersede guard throws on a non-PHASES phase before branch (A) is reached).
    // The reachable "dead worker → needs-human" path is branch (C) once the revive
    // budget is spent.
    const sig = { ...implementSignal(), phase: "verify" };
    sig.raw.phase = "verify";
    const emit = recorder({ code: 0 });
    const appendEscalated = recorder(undefined);
    const applyLabel = recorder({ applied: true });
    const reviveDispatch = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => null, // bg dead
      probes: { verify: recorder(false) }, // artifact NOT complete
      emitComplete: emit,
      appendEvent: recorder(undefined),
      appendEscalatedEvent: appendEscalated,
      applyStalledLabel: applyLabel,
      reviveDispatch,
      countReviveEvents: recorder(2), // budget exhausted (MAX_REVIVES)
    });
    expect(r).toBe("escalated");
    expect(emit.calls.length).toBe(0);
    expect(reviveDispatch.calls.length).toBe(0);
    expect(appendEscalated.calls[0][0].reason).toBe("revive-budget-exhausted");
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
      death_signal: "absent", // statJob:()=>null → klass 'dead' → absent
      probe_passed: true,
      probe_checked: expect.any(String),
      completion_origin: "inferred",
      reclaimed_bg_job_id: "job-x", // implementSignal default bgJobId
    });
    expect(order[0][1].stopped_bg_job_ids).toEqual([]); // CTL-661 placeholder
    // emit-complete receives the orchDir and the signal.
    expect(order[1][1]).toEqual({ orchDir: orch, signal: sig });
  });

  test("CTL-664: reclaim of an mtime-stale worker reports death_signal='mtime' + prev_state_json_mtime", () => {
    const staleMtime = 1_000;
    let appended = null;
    const r = reclaimDeadWorkIfPossible(orch, implementSignal({ status: "running" }), {
      statJob: () => ({ mtimeMs: staleMtime }), // exists but stale
      now: () => staleMtime + 10 * 60_000, // > STALE_MS
      probes: { implement: () => true },
      emitComplete: () => ({ code: 0 }),
      appendEvent: (args) => {
        appended = args;
      },
      postReclaimMirror: () => {}, // stubbed (Phase 3 seam)
      repoRoot: "/repo",
    });
    expect(r).toBe("reclaimed");
    expect(appended.death_signal).toBe("mtime");
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
      probes: { implement: () => true },
      emitComplete: recorder({ code: 0 }),
      appendEvent: recorder(undefined),
      pidAlive: () => false, // genuinely dead → alive-quiet gate stays open
      emitReapIntent: emitReap,
      now: () => 1_000 + 6 * 60 * 1000, // 6 min past mtime — stale
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
      probes: { implement: () => true },
      emitComplete: recorder({ code: 0 }),
      appendEvent: recorder(undefined),
      pidAlive: () => false,
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
          deathSignal: "absent", // statJob:()=>null → klass 'dead' → absent
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
// / runLinearis seams (no filesystem or `linearis` spawn in the test).
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
    const linearis = recorder({ status: 0 });
    defaultPostReclaimMirror(base, {
      existsSync: () => false,
      writeMarker: (p) => written.push(p),
      runLinearis: linearis,
    });
    expect(linearis.calls.length).toBe(1);
    const [t, body] = linearis.calls[0];
    expect(t).toBe("CTL-9");
    expect(body).toContain("**Phase Reclaim**");
    expect(body).toContain("work-done-despite-dead-bg");
    expect(body).toContain("absent");
    expect(written).toEqual(["/orch/workers/CTL-9/.linear-mirror-implement"]);
  });

  test("marker present → skips the post (first-writer-wins)", () => {
    const linearis = recorder({ status: 0 });
    const written = [];
    defaultPostReclaimMirror(base, {
      existsSync: () => true,
      writeMarker: (p) => written.push(p),
      runLinearis: linearis,
    });
    expect(linearis.calls.length).toBe(0);
    expect(written.length).toBe(0);
  });

  test("linearis non-zero → no marker written, no throw (fail-open)", () => {
    const written = [];
    expect(() =>
      defaultPostReclaimMirror(base, {
        existsSync: () => false,
        writeMarker: (p) => written.push(p),
        runLinearis: () => ({ status: 1, stderr: "offline" }),
      }),
    ).not.toThrow();
    expect(written.length).toBe(0);
  });

  test("runLinearis throws → swallowed, no marker, no throw (fail-open)", () => {
    const written = [];
    expect(() =>
      defaultPostReclaimMirror(base, {
        existsSync: () => false,
        writeMarker: (p) => written.push(p),
        runLinearis: () => {
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
    distinctRevivingTickets = 1,
    probeResult = false, // false = "work not done" → enters CTL-587 territory
    phase = "implement",
    ticket = "CTL-9",
    bgJobId = "bg-9",
    stateJsonMtime = 1_000, // far in the past — staleness triggers
    nowMs = 1_000 + 6 * 60 * 1000, // 6 min past mtime — > STALE_MS
    // CTL-655: boot-time window seam. Default to a no-marker reader so every
    // existing scenario behaves exactly as before (since=undefined → the
    // injected countReviveEvents recorder value is the unwindowed count).
    readBootSince = () => undefined,
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
        countDistinctRevivingTickets: recorder(distinctRevivingTickets),
        writeReviveMarker: recorder(undefined),
        // CTL-664: stub the reclaim mirror so the probeResult:true scenarios
        // (branch B) stay hermetic and don't spawn a real `linearis`.
        postReclaimMirror: recorder(undefined),
        readBootSince, // CTL-655: inject the boot-time window reader
        // CTL-662: the death trigger is now status, not mtime. "absent" (no live
        // `claude agents` session) is the reclaim-eligible case these revive/
        // escalate/storm scenarios exercise — equivalent to the pre-CTL-662
        // stale-mtime "effectively dead" they used to stage.
        liveness: () => "absent",
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

  test("budget exhausted: count=2 → 'escalated', applies needs-human label, no dispatch", () => {
    const s = setupReviveScenario({ reviveCount: 2 });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("escalated");
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(1);
    expect(s.opts.applyStalledLabel.calls[0][0].ticket).toBe("CTL-9");
    expect(s.opts.reviveDispatch.calls.length).toBe(0);
    expect(s.opts.appendEscalatedEvent.calls[0][0].reason).toBe("revive-budget-exhausted");
    expect(s.opts.appendEscalatedEvent.calls[0][0].final_attempt_count).toBe(2);
  });

  test("storm-breaker: distinct=4 > 3 → 'revive-suppressed', no dispatch", () => {
    const s = setupReviveScenario({ reviveCount: 0, distinctRevivingTickets: 4 });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("revive-suppressed");
    expect(s.opts.reviveDispatch.calls.length).toBe(0);
    expect(s.opts.appendReviveSuppressedEvent.calls.length).toBe(1);
    expect(s.opts.appendReviveSuppressedEvent.calls[0][0].window_distinct_tickets).toBe(4);
  });

  test("storm-breaker at the threshold: distinct=3 is NOT suppressed (>3, not >=3)", () => {
    const s = setupReviveScenario({ reviveCount: 0, distinctRevivingTickets: 3 });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("revived");
  });

  // CTL-641: pr/monitor-merge are now registered, so branch (A) is reached only
  // by a genuinely-unknown phase. Use one to keep the no-probe guard under test.
  test("probe NOT done + revive budget exhausted → 'escalated' immediately", () => {
    // CTL-641/CTL-606: branch (A) "no-probe-for-phase" is now unreachable (all
    // real phases are probed; unknown phases throw at the supersede guard). The
    // budget-exhausted escalation is the reachable dead-end-to-human path.
    const s = setupReviveScenario({ phase: "verify", probeResult: false, reviveCount: 2 });
    const r = reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(r).toBe("escalated");
    expect(s.opts.appendEscalatedEvent.calls[0][0].phase).toBe("verify");
    expect(s.opts.appendEscalatedEvent.calls[0][0].reason).toBe("revive-budget-exhausted");
    expect(s.opts.applyStalledLabel.calls.length).toBe(1);
    expect(s.opts.reviveDispatch.calls.length).toBe(0);
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

  // CTL-655: fail-open — a missing/unreadable marker yields no `since`, so the
  // counter is unwindowed and the budget still exhausts (today's behavior).
  test("omits 'since' when boot marker is absent (fail-open)", () => {
    const s = setupReviveScenario({
      reviveCount: 2,
      readBootSince: () => undefined,
    });
    const r = reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(r).toBe("escalated");
    expect(s.opts.countReviveEvents.calls[0][0].since).toBeUndefined();
  });

  test("dead plan worker, probe NOT done → 'revived'", () => {
    const s = setupReviveScenario({ phase: "plan", probeResult: false, reviveCount: 0 });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("revived");
    expect(s.opts.reviveDispatch.calls.length).toBe(1);
  });

  test("dead research worker, revive budget exhausted → 'escalated' (revive-budget-exhausted)", () => {
    const s = setupReviveScenario({ phase: "research", probeResult: false, reviveCount: 2 });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("escalated");
    expect(s.opts.appendEscalatedEvent.calls[0][0].reason).toBe("revive-budget-exhausted");
    expect(s.opts.reviveDispatch.calls.length).toBe(0);
  });

  test("dead research worker, storm-breaker open → 'revive-suppressed'", () => {
    const s = setupReviveScenario({ phase: "research", probeResult: false, distinctRevivingTickets: 4 });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("revive-suppressed");
    expect(s.opts.reviveDispatch.calls.length).toBe(0);
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

  test("escalation still records 'escalated' even when applyStalledLabel fails (no dispatch)", () => {
    // Failure to apply the label still returns 'escalated' so the scheduler
    // records the outcome. The labelOnce semantics in scheduler.mjs guard
    // re-application — a verify-failed result returns no marker, so the next
    // tick retries the label apply.
    const s = setupReviveScenario({ reviveCount: 2 });
    s.opts.applyStalledLabel = recorder({ applied: false, reason: "verify-failed" });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("escalated");
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
});

// --- CTL-662: busy-suppression (replaces the CTL-610/661 alive-quiet gate) -
//
// The pre-CTL-662 reclaim trigger was state.json mtime (5min stale → dead), with
// the CTL-610/661 alive-quiet gate papering over false positives by checking the
// bg pid within a 15min hung cutoff. CTL-662 deletes that whole time-based
// machinery: the trigger is now the worker's `claude agents` status
// (livenessForBgJob → busy|idle|absent). A `busy` worker — including the
// in-process Task sub-agent fan-out that keeps the parent's turn busy while
// state.json mtime goes arbitrarily stale (the proven worker-10d6f123 failure) —
// is NEVER auto-reclaimed, escalated, or revived, regardless of elapsed time,
// revive budget, or storm conditions. The sole permitted action on a busy worker
// is the high-ceiling no-progress backstop (escalateOnce past BUSY_CEILING_MS
// with no committed work — never a silent reclaim-and-advance).

describe("reclaimDeadWorkIfPossible — CTL-662 busy-suppression", () => {
  // A `busy` worker (a live `claude agents` session with an open turn). Defaults
  // to probe=false (work not done) so we prove a busy worker is suppressed even
  // when the work-done probe would otherwise revive it. `startedAt` is omitted by
  // default so the busy-ceiling backstop never trips unless a test supplies it.
  function setupBusyScenario({
    reviveCount = 0,
    distinctRevivingTickets = 1,
    probeResult = false,
    phase = "implement",
    ticket = "CTL-9",
    bgJobId = "bg-9",
    startedAt,
    nowMs = 2_000_000,
  } = {}) {
    const sig = {
      ...implementSignal({ ticket, status: "running", bgJobId }),
      phase,
    };
    sig.raw.phase = phase;
    if (startedAt !== undefined) sig.raw.startedAt = startedAt;
    return {
      orch: "/orch",
      sig,
      opts: {
        repoRoot: "/repo",
        // mtime is arbitrarily stale — it is no longer a decision input.
        statJob: () => ({ exists: true, mtimeMs: 1_000 }),
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
        countDistinctRevivingTickets: recorder(distinctRevivingTickets),
        writeReviveMarker: recorder(undefined),
        inEscalationCooldownFn: () => false,
        recordEscalationFn: recorder(undefined),
        liveness: recorder("busy"),
        bumpIdleStreak: recorder(1),
        resetIdleStreak: recorder(undefined),
        // CTL-664: stub the reclaim mirror so a probeResult:true scenario
        // (reclaim branch) stays hermetic (no `linearis` spawn).
        postReclaimMirror: recorder(undefined),
        now: () => nowMs,
      },
    };
  }

  test("busy → 'alive-busy-suppressed' (no dispatch, no budget, no marker, no kill, no escalate, no events)", () => {
    const s = setupBusyScenario({ reviveCount: 0 });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("alive-busy-suppressed");
    expect(s.opts.reviveDispatch.calls.length).toBe(0);
    expect(s.opts.appendReviveEvent.calls.length).toBe(0);
    expect(s.opts.appendReviveSuppressedEvent.calls.length).toBe(0);
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(0);
    expect(s.opts.writeReviveMarker.calls.length).toBe(0);
    expect(s.opts.killBgJob.calls.length).toBe(0);
    expect(s.opts.applyStalledLabel.calls.length).toBe(0);
    // The trigger MUST consult liveness with the signal's bg_job_id.
    expect(s.opts.liveness.calls.length).toBeGreaterThanOrEqual(1);
    expect(s.opts.liveness.calls[0][0]).toBe("bg-9");
  });

  test("busy + revive budget exhausted → still 'alive-busy-suppressed' (NEVER false-escalate a busy worker)", () => {
    // The worst case the fix exists to prevent: a busy worker (a long sub-agent
    // fan-out) whose budget two prior false-revives consumed must NOT be escalated
    // to needs-human just because the budget is spent — it is alive and working.
    const s = setupBusyScenario({ reviveCount: 2 });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("alive-busy-suppressed");
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(0);
    expect(s.opts.applyStalledLabel.calls.length).toBe(0);
  });

  test("busy + storm-breaker open → still 'alive-busy-suppressed' (status check precedes storm bookkeeping)", () => {
    const s = setupBusyScenario({ distinctRevivingTickets: 4 });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("alive-busy-suppressed");
    expect(s.opts.appendReviveSuppressedEvent.calls.length).toBe(0);
  });

  test("busy + work appears done → 'alive-busy-suppressed', NOT reclaimed (left to emit its own complete)", () => {
    // A busy worker whose probe reads done is still suppressed: it is live and its
    // own emit-complete is authoritative. Reclaiming it would flip the signal out
    // from under a running worker (the pre-CTL-661 hole the gate exists to close).
    const s = setupBusyScenario({ probeResult: true });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("alive-busy-suppressed");
    expect(s.opts.emitComplete.calls.length).toBe(0);
    expect(s.opts.appendEvent.calls.length).toBe(0);
  });

  test("busy resets any in-progress idle-confirmation streak", () => {
    // A single busy observation between idle ticks must reset the streak so a
    // worker that flickers idle→busy→idle is never reclaimed on a stale count.
    const s = setupBusyScenario();
    reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(s.opts.resetIdleStreak.calls.length).toBe(1);
    expect(s.opts.resetIdleStreak.calls[0]).toEqual(["/orch", "CTL-9", "implement"]);
    expect(s.opts.bumpIdleStreak.calls.length).toBe(0);
  });

  test("busy past BUSY_CEILING_MS with NO committed work → 'escalated' (busy-ceiling-exceeded), never silent reclaim", () => {
    // The sole long backstop. A worker busy longer than the ceiling whose
    // work-done probe is STILL false is flagged for a human — genuinely wedged,
    // not progressing. It is escalated, NEVER silently reclaimed-and-advanced.
    const startedAt = "2026-05-27T00:00:00Z";
    const s = setupBusyScenario({
      probeResult: false,
      startedAt,
      nowMs: Date.parse(startedAt) + 7 * 60 * 60 * 1000, // 7h > 6h ceiling
    });
    const r = reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(r).toBe("escalated");
    expect(s.opts.appendEscalatedEvent.calls[0][0].reason).toBe("busy-ceiling-exceeded");
    expect(s.opts.applyStalledLabel.calls.length).toBe(1);
    expect(s.opts.reviveDispatch.calls.length).toBe(0);
  });

  test("busy past BUSY_CEILING_MS but work IS done → 'alive-busy-suppressed' (progressing, not wedged)", () => {
    // Past the ceiling but the probe reads done → it is making progress, not
    // wedged. Suppress and let it emit its own complete; do not escalate.
    const startedAt = "2026-05-27T00:00:00Z";
    const s = setupBusyScenario({
      probeResult: true,
      startedAt,
      nowMs: Date.parse(startedAt) + 7 * 60 * 60 * 1000,
    });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("alive-busy-suppressed");
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(0);
  });

  test("busy WITHIN BUSY_CEILING_MS is suppressed regardless of work-done (backstop not yet armed)", () => {
    const startedAt = "2026-05-27T00:00:00Z";
    const s = setupBusyScenario({
      probeResult: false,
      startedAt,
      nowMs: Date.parse(startedAt) + 60 * 60 * 1000, // 1h < 6h ceiling
    });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("alive-busy-suppressed");
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(0);
  });
});

// --- CTL-662: idle-confirmation + absent reclaim --------------------------
//
// `absent` (not listed by `claude agents` → crashed/exited) is reclaim-eligible
// immediately — absence is unambiguous. `idle` (live, between turns) is
// reclaim-eligible only after IDLE_CONFIRM_TICKS CONSECUTIVE idle observations,
// counted by a persisted per-(ticket, phase) streak marker (NOT an mtime window).
// Once reclaim-eligible, the existing CTL-574/587/604 branches decide:
// work-done → reclaim+advance; work-not-done → revive (budget/storm permitting).
// This path replaces the pre-CTL-662 stale-mtime "effectively dead" trigger; the
// revive/escalate/storm behaviour on it is otherwise unchanged.

describe("reclaimDeadWorkIfPossible — CTL-662 idle-confirmation + absent reclaim", () => {
  function setup({
    live = "idle",
    streak = 0, // the NEW post-increment count bumpIdleStreak returns this tick
    idleConfirmTicks = 2,
    probeResult = false,
    reviveCount = 0,
    distinctRevivingTickets = 1,
    phase = "implement",
    ticket = "CTL-9",
    bgJobId = "bg-9",
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
        statJob: () => ({ exists: true, mtimeMs: 1_000 }),
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
        countDistinctRevivingTickets: recorder(distinctRevivingTickets),
        writeReviveMarker: recorder(undefined),
        inEscalationCooldownFn: () => false,
        recordEscalationFn: recorder(undefined),
        listTicketPhases: () => ["triage", "research", "plan", "implement"],
        liveness: recorder(live),
        bumpIdleStreak: recorder(streak),
        resetIdleStreak: recorder(undefined),
        idleConfirmTicks,
        now: () => 2_000_000,
      },
    };
  }

  test("idle, streak below confirm threshold → 'idle-pending' (bumped, not reclaimed)", () => {
    const s = setup({ live: "idle", streak: 1, idleConfirmTicks: 2 });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("idle-pending");
    expect(s.opts.bumpIdleStreak.calls.length).toBe(1);
    expect(s.opts.bumpIdleStreak.calls[0]).toEqual(["/orch", "CTL-9", "implement"]);
    // No reclaim/revive/escalate this tick — the streak is still building.
    expect(s.opts.emitComplete.calls.length).toBe(0);
    expect(s.opts.reviveDispatch.calls.length).toBe(0);
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(0);
  });

  test("idle, streak reaches confirm threshold + work done → 'reclaimed' (streak cleared)", () => {
    const s = setup({ live: "idle", streak: 2, idleConfirmTicks: 2, probeResult: true });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("reclaimed");
    expect(s.opts.emitComplete.calls.length).toBe(1);
    // Once we proceed to act, the persisted streak is cleared.
    expect(s.opts.resetIdleStreak.calls.length).toBe(1);
  });

  test("idle, streak reaches confirm threshold + work NOT done → 'revived' (streak cleared)", () => {
    const s = setup({ live: "idle", streak: 2, idleConfirmTicks: 2, probeResult: false });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("revived");
    expect(s.opts.reviveDispatch.calls.length).toBe(1);
    expect(s.opts.resetIdleStreak.calls.length).toBe(1);
  });

  test("absent → reclaim-eligible immediately (no idle-confirmation), work done → 'reclaimed'", () => {
    const s = setup({ live: "absent", probeResult: true });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("reclaimed");
    expect(s.opts.emitComplete.calls.length).toBe(1);
    // Absence skips the streak entirely — bump is never called.
    expect(s.opts.bumpIdleStreak.calls.length).toBe(0);
  });

  test("absent + work NOT done → 'revived' (no idle-confirmation needed)", () => {
    const s = setup({ live: "absent", probeResult: false });
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("revived");
    expect(s.opts.reviveDispatch.calls.length).toBe(1);
    expect(s.opts.bumpIdleStreak.calls.length).toBe(0);
  });

  test("the trigger consults liveness with the signal's bg_job_id (not a stale value)", () => {
    const s = setup({ live: "absent", probeResult: true, bgJobId: "bg-77" });
    reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(s.opts.liveness.calls[0][0]).toBe("bg-77");
  });
});

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
        // CTL-641 + CTL-606: every real phase now has a probe (so branch (A) is
        // skipped) and CTL-606's supersede guard throws on a non-PHASES phase, so
        // these storm-prevention tests can no longer reach the old branch-(A)
        // no-probe escalation. They instead drive the reachable branch-(C)
        // revive-budget-exhausted escalation: a probe-false real phase with the
        // revive budget exhausted (reviveCount default below = MAX_REVIVES).
        probes: { [overrides.phase ?? "implement"]: recorder(overrides.probeResult ?? false) },
        emitComplete: recorder({ code: 0 }),
        appendEvent: recorder(undefined),
        appendReviveEvent: recorder(undefined),
        appendEscalatedEvent: recorder(undefined),
        appendReviveSuppressedEvent: recorder(undefined),
        reviveDispatch: recorder({ code: 0 }),
        applyStalledLabel: recorder({ applied: true }),
        killBgJob: recorder(undefined),
        countReviveEvents: recorder(overrides.reviveCount ?? 2), // default = MAX_REVIVES → budget-exhausted escalation
        countDistinctRevivingTickets: recorder(1),
        writeReviveMarker: recorder(undefined),
        now: () => overrides.nowMs ?? 1_000 + 6 * 60 * 1000,
        staleMs: 5 * 60 * 1000,
        // inEscalationCooldownFn / recordEscalationFn use real defaults so we
        // exercise the actual filesystem-backed cool-down primitive end-to-end.
      },
    };
  }

  test("acceptance: second tick on same (ticket, phase) suppresses — exactly one event + one label write", () => {
    const s = setupAt(orchDir, { phase: "pr" }); // branch (C): revive-budget-exhausted

    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("escalated");
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(1);
    expect(s.opts.applyStalledLabel.calls.length).toBe(1);

    // 1,500 simulated ticks in the storm window — every one suppressed.
    for (let i = 0; i < 1500; i++) {
      expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("escalation-suppressed");
    }
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(1); // NOT 1,501
    expect(s.opts.applyStalledLabel.calls.length).toBe(1); // NOT 1,501
  });

  test("escalation re-fires after the cool-down window elapses", () => {
    let clock = 5_000_000;
    const s = setupAt(orchDir, { phase: "pr", nowMs: clock });
    s.opts.now = () => clock;

    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("escalated");
    clock += 10 * 60 * 1000 + 1; // jump past the 10-min default window
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("escalated");
    expect(s.opts.appendEscalatedEvent.calls.length).toBe(2);
  });

  test("different phase on the same ticket gets an independent cool-down (pr → monitor-merge advancement)", () => {
    // Reproduces the live CTL-624 timeline: escalations on `pr` for a stretch,
    // then on `monitor-merge` after `pr` completes. Both should escalate; only
    // the WITHIN-phase repeats are suppressed.
    const sPr = setupAt(orchDir, { phase: "pr" });
    expect(reclaimDeadWorkIfPossible(sPr.orch, sPr.sig, sPr.opts)).toBe("escalated");
    expect(reclaimDeadWorkIfPossible(sPr.orch, sPr.sig, sPr.opts)).toBe("escalation-suppressed");

    const sMm = setupAt(orchDir, { phase: "monitor-merge" });
    expect(reclaimDeadWorkIfPossible(sMm.orch, sMm.sig, sMm.opts)).toBe("escalated");
  });

  test("revive-budget-exhausted branch also respects the cool-down", () => {
    // Repro: implement phase, budget exhausted → escalation path. Second tick
    // must suppress just like the no-probe branch.
    const s = setupAt(orchDir, { phase: "implement", reviveCount: 2 });

    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("escalated");
    expect(s.opts.appendEscalatedEvent.calls[0][0].reason).toBe("revive-budget-exhausted");
    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("escalation-suppressed");
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

    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("escalated");
    expect(inCd.calls.length).toBe(1);
    expect(recCd.calls.length).toBe(1);
    // recordEscalationFn signature: (orchDir, ticket, phase, reason, now)
    expect(recCd.calls[0][1]).toBe("CTL-9");
    expect(recCd.calls[0][2]).toBe("pr");
    expect(recCd.calls[0][3]).toBe("revive-budget-exhausted");
  });

  test("escalation-suppressed return path does NOT call appendEscalatedEvent / applyStalledLabel / recordEscalationFn", () => {
    // Pure-fake seams to make the suppression observable as zero side-effects.
    const s = setupAt(orchDir, { phase: "pr" });
    s.opts.inEscalationCooldownFn = recorder(true); // cool-down already armed
    s.opts.recordEscalationFn = recorder(undefined);

    expect(reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts)).toBe("escalation-suppressed");
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

  test("guard never fires for a busy (live) signal — no listTicketPhases read on the hot path", () => {
    // CTL-662: a live worker is now `busy`, which returns 'alive-busy-suppressed'
    // from the status branch ABOVE the supersede guard — so the guard's
    // listTicketPhases read is never reached for a live worker.
    const listSpy = recorder(["triage", "research", "plan", "implement"]);
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => ({ exists: true, mtimeMs: Date.now() }),
      liveness: () => "busy",
      listTicketPhases: listSpy,
    });
    expect(r).toBe("alive-busy-suppressed");
    expect(listSpy.calls.length).toBe(0); // guard runs only on the reclaim-eligible path
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

// CTL-658 — JS port of orchestrate-revive's resolve_phase_session_id. Resolves a
// `claude --resume`-compatible session UUID from a dead worker's bg_job_id by
// reading <jobsDir>/<bg_job_id>/state.json → .linkScanPath → basename minus .jsonl.
// Mirrors the bash unit tests at __tests__/orchestrate-revive.test.sh:578-617.
describe("resolvePhaseSessionId", () => {
  let jobsDir;
  beforeEach(() => {
    jobsDir = mkdtempSync(join(tmpdir(), "exec-core-jobs-"));
  });
  afterEach(() => {
    rmSync(jobsDir, { recursive: true, force: true });
  });

  test("happy path — linkScanPath .jsonl returns the UUID basename", () => {
    mkdirSync(join(jobsDir, "cafe1234"), { recursive: true });
    writeFileSync(
      join(jobsDir, "cafe1234", "state.json"),
      JSON.stringify({ linkScanPath: "/p/9f8e-uuid.jsonl" }),
    );
    expect(resolvePhaseSessionId("cafe1234", { jobsDir })).toBe("9f8e-uuid");
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

  test("state.json without linkScanPath returns null", () => {
    mkdirSync(join(jobsDir, "nolink"), { recursive: true });
    writeFileSync(join(jobsDir, "nolink", "state.json"), JSON.stringify({}));
    expect(resolvePhaseSessionId("nolink", { jobsDir })).toBeNull();
  });
});
