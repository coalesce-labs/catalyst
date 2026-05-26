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
  defaultKillBgJob,
  defaultAppendReviveEvent,
  readBootEpoch,
  readDaemonEpoch,
  defaultReadRuntimeEpoch,
  detectColdStart,
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

  test("'noop' for a running signal whose bg job is FRESH (state.json mtime within staleMs)", () => {
    // CTL-588: a `running` classification + fresh state.json mtime → live worker.
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => ({ exists: true, mtimeMs: 1_000_000 }),
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      // Pin "now" near the bg mtime so the staleness check sees a fresh worker.
      now: () => 1_000_500,
    });
    expect(r).toBe("noop");
    expect(emit.calls.length).toBe(0);
  });

  test("CTL-588: 'running' with a STALE bg state.json (> staleMs) is treated as effectively dead", () => {
    // The bug CTL-588 fixes: claude --bg leaves the job dir behind after the
    // worker exits, so classifyWorker stays `running` indefinitely. We catch
    // this via mtime — a real worker updates state.json every few seconds.
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const appendEvent = recorder(undefined);
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => ({ exists: true, mtimeMs: 1_000 }),
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent,
      now: () => 1_000 + 6 * 60 * 1000, // 6 minutes past mtime — stale
    });
    expect(r).toBe("reclaimed");
    expect(probe.calls.length).toBe(1);
    expect(emit.calls.length).toBe(1);
    expect(appendEvent.calls.length).toBe(1);
  });

  test("CTL-588: 'running' with a FRESH bg state.json (under staleMs) is NOT reclaimed", () => {
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => ({ exists: true, mtimeMs: 1_000_000 }),
      probes: { implement: probe },
      emitComplete: emit,
      appendEvent: recorder(undefined),
      now: () => 1_000_000 + 4 * 60 * 1000, // 4 minutes — under threshold
    });
    expect(r).toBe("noop");
    expect(probe.calls.length).toBe(0);
    expect(emit.calls.length).toBe(0);
  });

  test("CTL-588: staleMs is honored when explicitly passed (override)", () => {
    const r = reclaimDeadWorkIfPossible(orch, implementSignal(), {
      statJob: () => ({ exists: true, mtimeMs: 100 }),
      probes: { implement: () => true },
      emitComplete: () => ({ code: 0 }),
      appendEvent: () => {},
      now: () => 100 + 60_000,
      staleMs: 30_000, // 30s threshold — 1 min IS stale
    });
    expect(r).toBe("reclaimed");
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
  test("CTL-587: dead worker on a no-probe phase → 'escalated' + needs-human label", () => {
    const sig = { ...implementSignal(), phase: "research" };
    sig.raw.phase = "research";
    const emit = recorder({ code: 0 });
    const appendEscalated = recorder(undefined);
    const applyLabel = recorder({ applied: true });
    const r = reclaimDeadWorkIfPossible(orch, sig, {
      statJob: () => null, // bg dead
      probes: { implement: recorder(true) }, // research not registered
      emitComplete: emit,
      appendEvent: recorder(undefined),
      appendEscalatedEvent: appendEscalated,
      applyStalledLabel: applyLabel,
    });
    expect(r).toBe("escalated");
    expect(emit.calls.length).toBe(0);
    expect(appendEscalated.calls[0][0].reason).toBe("no-probe-for-phase");
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
      repoRoot: "/repo",
    });
    expect(r).toBe("reclaimed");
    // order: append first, then emit.
    expect(order[0][0]).toBe("append");
    expect(order[1][0]).toBe("emit");
    // append-event payload mentions the phase + ticket + orch id.
    expect(order[0][1]).toEqual({
      phase: "implement",
      ticket: "CTL-9",
      orchId: "CTL-9",
    });
    // emit-complete receives the orchDir and the signal.
    expect(order[1][1]).toEqual({ orchDir: orch, signal: sig });
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

  test("repoRoot is forwarded to the probe (so the probe can resolve the worktree)", () => {
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
      repoRoot: "/repo/x",
    });
    expect(seen).toEqual({ ticket: "CTL-42", repoRoot: "/repo/x" });
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
        probes: phase === "implement" ? { implement: recorder(probeResult) } : {},
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
        now: () => nowMs,
        staleMs: 5 * 60 * 1000,
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

  test("not-applicable (no probe registered for phase) → 'escalated' immediately", () => {
    const s = setupReviveScenario({ phase: "pr" });
    const r = reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(r).toBe("escalated");
    expect(s.opts.appendEscalatedEvent.calls[0][0].phase).toBe("pr");
    expect(s.opts.appendEscalatedEvent.calls[0][0].reason).toBe("no-probe-for-phase");
    expect(s.opts.applyStalledLabel.calls.length).toBe(1);
    expect(s.opts.reviveDispatch.calls.length).toBe(0);
  });

  test("defensive kill: fires when state.json mtime > KILL_RECENT_ACTIVITY_MS old", () => {
    // 60s past now — older than the 30s kill threshold.
    const s = setupReviveScenario({
      stateJsonMtime: 1_000,
      nowMs: 1_000 + 6 * 60 * 1000, // 6min past — also stale
    });
    reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(s.opts.killBgJob.calls.length).toBe(1);
    expect(s.opts.killBgJob.calls[0][0].bgJobId).toBe("bg-9");
  });

  test("defensive kill: does NOT fire when classifyWorker:dead path is taken (no mtime captured)", () => {
    // When statJob returns null (bg dir gone), classifyWorker returns 'dead'
    // directly → prevStateJsonMtime stays null → the kill gate at
    // recovery.mjs sees no mtime and skips. The separate freshness-vs-kill
    // gate is exercised by the next test.
    const sig = implementSignal({ ticket: "CTL-9", status: "running", bgJobId: "bg-9" });
    const opts = {
      ...setupReviveScenario().opts,
      statJob: () => null,
      now: () => 0,
    };
    reclaimDeadWorkIfPossible("/orch", sig, opts);
    expect(opts.killBgJob.calls.length).toBe(0);
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

  // Defensive-kill freshness gate: a `running` worker with a stale-but-not-yet-
  // KILL_RECENT_ACTIVITY_MS-stale state.json mtime must NOT be SIGKILL'd. We
  // override staleMs so the worker still classifies as effectively dead (via
  // the freshness path) but the kill threshold (30s) is NOT crossed.
  test("defensive kill: state.json mtime within KILL_RECENT_ACTIVITY_MS → no kill", () => {
    const s = setupReviveScenario({
      stateJsonMtime: 1_000,
      nowMs: 1_000 + 20_000, // 20s past mtime — under 30s kill threshold
    });
    // Override staleMs so the worker IS effectively dead via the freshness
    // path even though only 20s have elapsed. This isolates the kill gate
    // from the staleness gate.
    s.opts.staleMs = 10_000;
    reclaimDeadWorkIfPossible(s.orch, s.sig, s.opts);
    expect(s.opts.killBgJob.calls.length).toBe(0);
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
        probes: overrides.phase === "implement" || !overrides.phase
          ? { implement: recorder(overrides.probeResult ?? false) }
          : {},
        emitComplete: recorder({ code: 0 }),
        appendEvent: recorder(undefined),
        appendReviveEvent: recorder(undefined),
        appendEscalatedEvent: recorder(undefined),
        appendReviveSuppressedEvent: recorder(undefined),
        reviveDispatch: recorder({ code: 0 }),
        applyStalledLabel: recorder({ applied: true }),
        killBgJob: recorder(undefined),
        countReviveEvents: recorder(overrides.reviveCount ?? 0),
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
    const s = setupAt(orchDir, { phase: "pr" }); // no-probe branch

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
    expect(recCd.calls[0][3]).toBe("no-probe-for-phase");
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
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl587-revdisp-"));
  });
  afterEach(() => {
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
});

describe("defaultKillBgJob — pid-recycling guard", () => {
  let jobsRootDir;
  beforeEach(() => {
    jobsRootDir = mkdtempSync(join(tmpdir(), "ctl587-jobs-"));
  });
  afterEach(() => {
    rmSync(jobsRootDir, { recursive: true, force: true });
  });

  function seedPid(bgJobId, pid) {
    const dir = join(jobsRootDir, bgJobId);
    mkdirSync(dir, { recursive: true });
    if (pid !== undefined) writeFileSync(join(dir, "pid"), String(pid));
  }

  test("missing bgJobId → no spawn invocation", () => {
    const spawn = recorder({ status: 0, stdout: "claude\n", stderr: "" });
    defaultKillBgJob({ bgJobId: null }, { spawn, jobsRoot: () => jobsRootDir });
    expect(spawn.calls.length).toBe(0);
  });

  test("missing pid file → no spawn invocation", () => {
    // bgJobId set but no pid file written.
    const spawn = recorder({ status: 0, stdout: "claude\n", stderr: "" });
    defaultKillBgJob({ bgJobId: "bg-9" }, { spawn, jobsRoot: () => jobsRootDir });
    expect(spawn.calls.length).toBe(0);
  });

  test("pid <= 1 (init / invalid) → no spawn invocation", () => {
    seedPid("bg-9", "1");
    const spawn = recorder({ status: 0, stdout: "claude\n", stderr: "" });
    defaultKillBgJob({ bgJobId: "bg-9" }, { spawn, jobsRoot: () => jobsRootDir });
    expect(spawn.calls.length).toBe(0);
  });

  test("non-numeric pid → no spawn invocation", () => {
    seedPid("bg-9", "abc");
    const spawn = recorder({ status: 0, stdout: "claude\n", stderr: "" });
    defaultKillBgJob({ bgJobId: "bg-9" }, { spawn, jobsRoot: () => jobsRootDir });
    expect(spawn.calls.length).toBe(0);
  });

  test("ps exit non-zero (pid gone) → ps invoked, kill is NOT invoked", () => {
    seedPid("bg-9", "12345");
    const calls = [];
    const spawn = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "ps") return { status: 1, stdout: "", stderr: "" };
      return { status: 0 };
    };
    defaultKillBgJob({ bgJobId: "bg-9" }, { spawn, jobsRoot: () => jobsRootDir });
    expect(calls.filter((c) => c.cmd === "ps").length).toBe(1);
    expect(calls.filter((c) => c.cmd === "kill").length).toBe(0);
  });

  test("ps says pid is 'node' (recycled to non-claude process) → kill skipped", () => {
    seedPid("bg-9", "12345");
    const calls = [];
    const spawn = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "ps") return { status: 0, stdout: "node\n", stderr: "" };
      return { status: 0 };
    };
    defaultKillBgJob({ bgJobId: "bg-9" }, { spawn, jobsRoot: () => jobsRootDir });
    expect(calls.filter((c) => c.cmd === "kill").length).toBe(0);
  });

  test("happy path: ps confirms 'claude' → kill -9 issued with the pid", () => {
    seedPid("bg-9", "12345");
    const calls = [];
    const spawn = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "ps") return { status: 0, stdout: "claude\n", stderr: "" };
      if (cmd === "kill") return { status: 0, stdout: "", stderr: "" };
      return { status: 127 };
    };
    defaultKillBgJob({ bgJobId: "bg-9" }, { spawn, jobsRoot: () => jobsRootDir });
    const killCalls = calls.filter((c) => c.cmd === "kill");
    expect(killCalls).toHaveLength(1);
    expect(killCalls[0].args).toEqual(["-9", "12345"]);
  });
});

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
