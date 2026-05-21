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
} from "./recovery.mjs";

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
