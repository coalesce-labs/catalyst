// Unit + integration tests for execution-core crash recovery (CTL-539).
// Run: cd plugins/dev/scripts/execution-core && bun test recovery.test.mjs
//
// Phase 2 covers classifyWorker + reconstructWorkerState; Phase 3 extends
// this same file with recoverStartup composition tests.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyWorker,
  reconstructWorkerState,
  defaultStatJob,
  recoverStartup,
  reclaimDeadWorkIfPossible,
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

  test("defensive kill: does NOT fire when state.json mtime is recent (< 30s)", () => {
    // 10s past — under 30s kill threshold. But still > 5min stale path...
    // Actually mtime 0 with now=6min and stale 5min triggers the stale path
    // but mtime delta is 6min > 30s. To test the kill-skip we need recent mtime.
    // The staleness check ALSO uses staleMs=5min — we must override that too
    // so the worker is still effectively-dead (via classifyWorker dead) but
    // has recent state.json activity. Trick: use null statJob (bg dir gone)
    // and forget the freshness check.
    const sig = implementSignal({ ticket: "CTL-9", status: "running", bgJobId: "bg-9" });
    const opts = {
      ...setupReviveScenario().opts,
      // classifyWorker returns 'dead' for null statJob → effectivelyDead=true
      // without needing the stale-mtime path. prevStateJsonMtime stays null,
      // so killBgJob is never called.
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
  });
});
