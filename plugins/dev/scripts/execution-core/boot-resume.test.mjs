// boot-resume.test.mjs — CTL-654. Daemon boot-resume: re-dispatch in-flight
// tickets that have no live --bg worker after a cold start.
//
// Phase 1 (this block): pure selection logic — hasLiveBgWorker,
// activePhaseForTicket, selectBootResumeCandidates. No ambient I/O beyond
// mkdtempSync signal fixtures (mirrors recovery.test.mjs idiom).
// Phase 2 (below): reconcileBootResume orchestration with injected
// dispatch/agents/appendEvent/report.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasLiveBgWorker,
  activePhaseForTicket,
  selectBootResumeCandidates,
  reconcileBootResume,
  isCheapPhase,
  bootResumePendingPath,
  bootResumeApprovedPath,
} from "./boot-resume.mjs";

let orchDir;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "exec-core-boot-"));
});

afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

// writeSignal — write workers/<ticket>/phase-<phase>.json with the canonical
// fields. Defaults model a running, freshly-dispatched phase worker.
function writeSignal(dir, ticket, phase, overrides = {}) {
  const wdir = join(dir, "workers", ticket);
  mkdirSync(wdir, { recursive: true });
  const sig = {
    ticket,
    phase,
    status: "running",
    bg_job_id: "deadbeef",
    worktreePath: `/wt/${ticket}`,
    updatedAt: "2026-05-27T02:00:00Z",
    ...overrides,
  };
  writeFileSync(join(wdir, `phase-${phase}.json`), JSON.stringify(sig, null, 2));
  return sig;
}

// writeMaxParallel — minimal state.json so readMaxParallel resolves a known cap.
function writeMaxParallel(dir, n) {
  writeFileSync(join(dir, "state.json"), JSON.stringify({ maxParallel: n }));
}

describe("hasLiveBgWorker", () => {
  test("true for a background agent whose cwd matches the worktree", () => {
    expect(hasLiveBgWorker([{ kind: "background", cwd: "/wt/A" }], "/wt/A")).toBe(true);
  });

  test("false when the only matching-cwd entry is interactive (human session)", () => {
    expect(hasLiveBgWorker([{ kind: "interactive", cwd: "/wt/A" }], "/wt/A")).toBe(false);
  });

  test("false when no entry's cwd equals the worktree", () => {
    expect(hasLiveBgWorker([{ kind: "background", cwd: "/wt/B" }], "/wt/A")).toBe(false);
  });

  test("false for an empty or undefined agents array (defensive)", () => {
    expect(hasLiveBgWorker([], "/wt/A")).toBe(false);
    expect(hasLiveBgWorker(undefined, "/wt/A")).toBe(false);
  });

  test("requires exact-string cwd equality — no trailing-slash normalization", () => {
    expect(hasLiveBgWorker([{ kind: "background", cwd: "/wt/A/" }], "/wt/A")).toBe(false);
  });
});

describe("activePhaseForTicket", () => {
  test("returns the single non-terminal phase, ignoring terminal siblings", () => {
    const sigs = [
      { phase: "plan", status: "done", updatedAt: "2026-05-27T01:00:00Z" },
      { phase: "implement", status: "running", updatedAt: "2026-05-27T02:00:00Z" },
    ];
    expect(activePhaseForTicket(sigs)?.phase).toBe("implement");
  });

  test("returns the most-recently-updated when more than one is non-terminal", () => {
    const sigs = [
      { phase: "implement", status: "running", updatedAt: "2026-05-27T01:00:00Z" },
      { phase: "verify", status: "dispatched", updatedAt: "2026-05-27T03:00:00Z" },
    ];
    expect(activePhaseForTicket(sigs)?.phase).toBe("verify");
  });

  test("returns null when every phase is terminal (nothing to resume)", () => {
    const sigs = [
      { phase: "plan", status: "done", updatedAt: "2026-05-27T01:00:00Z" },
      { phase: "implement", status: "failed", updatedAt: "2026-05-27T02:00:00Z" },
    ];
    expect(activePhaseForTicket(sigs)).toBeNull();
  });

  test("returns null for an empty list", () => {
    expect(activePhaseForTicket([])).toBeNull();
  });
});

describe("selectBootResumeCandidates", () => {
  test("returns [] when there are no in-flight tickets", () => {
    // A fully-completed ticket: monitor-deploy done is terminal-not-in-flight.
    writeSignal(orchDir, "CTL-1", "monitor-deploy", { status: "done" });
    expect(selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 3 })).toEqual([]);
  });

  test("returns only the in-flight ticket WITHOUT a live bg worker", () => {
    // CTL-A has a live bg worker; CTL-B does not.
    writeSignal(orchDir, "CTL-A", "implement", { worktreePath: "/wt/CTL-A" });
    writeSignal(orchDir, "CTL-B", "verify", { worktreePath: "/wt/CTL-B" });
    const agents = [{ kind: "background", cwd: "/wt/CTL-A" }];
    const out = selectBootResumeCandidates({ orchDir, agents, maxParallel: 3 });
    // CTL-690: bgJobId is now also captured on each candidate so reconcile
    // can resolve a resume UUID. writeSignal's default bg_job_id is 'deadbeef'.
    expect(out).toEqual([
      { ticket: "CTL-B", phase: "verify", worktreePath: "/wt/CTL-B", bgJobId: "deadbeef" },
    ]);
  });

  // CTL-690: every candidate exposes bgJobId from the active signal's liveness
  // field so reconcileBootResume can map it to a `--resume`-compatible UUID.
  // Legacy signals without a bg_job_id surface bgJobId === null and fall back
  // to fresh dispatch downstream.
  test("captures bgJobId per candidate; null when the signal lacks bg_job_id (CTL-690)", () => {
    writeSignal(orchDir, "CTL-1", "implement", {
      worktreePath: "/wt/CTL-1",
      bg_job_id: "abc12345",
    });
    writeSignal(orchDir, "CTL-2", "implement", {
      worktreePath: "/wt/CTL-2",
      bg_job_id: null,
    });
    const out = selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 3 });
    expect(out.map((c) => ({ ticket: c.ticket, bgJobId: c.bgJobId }))).toEqual([
      { ticket: "CTL-1", bgJobId: "abc12345" },
      { ticket: "CTL-2", bgJobId: null },
    ]);
  });

  test("excludes an in-flight ticket whose active signal lacks a worktreePath, recording a warn", () => {
    writeSignal(orchDir, "CTL-NOWT", "implement", { worktreePath: null });
    const warns = [];
    const logger = { warn: (obj, msg) => warns.push({ obj, msg }), info: () => {} };
    const out = selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 3, logger });
    expect(out).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0].obj.ticket).toBe("CTL-NOWT");
  });

  test("slot bound: maxParallel=2 with 3 no-live-worker tickets returns exactly 2", () => {
    writeSignal(orchDir, "CTL-1", "implement", { worktreePath: "/wt/CTL-1" });
    writeSignal(orchDir, "CTL-2", "implement", { worktreePath: "/wt/CTL-2" });
    writeSignal(orchDir, "CTL-3", "implement", { worktreePath: "/wt/CTL-3" });
    const out = selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 2 });
    expect(out).toHaveLength(2);
  });

  test("slot bound subtracts in-flight tickets that DO have a live worker", () => {
    // maxParallel=3; CTL-LIVE has a live worker, 3 others do not → free = 3-1 = 2.
    writeSignal(orchDir, "CTL-LIVE", "implement", { worktreePath: "/wt/CTL-LIVE" });
    writeSignal(orchDir, "CTL-1", "implement", { worktreePath: "/wt/CTL-1" });
    writeSignal(orchDir, "CTL-2", "implement", { worktreePath: "/wt/CTL-2" });
    writeSignal(orchDir, "CTL-3", "implement", { worktreePath: "/wt/CTL-3" });
    const agents = [{ kind: "background", cwd: "/wt/CTL-LIVE" }];
    const out = selectBootResumeCandidates({ orchDir, agents, maxParallel: 3 });
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.ticket !== "CTL-LIVE")).toBe(true);
  });

  test("slices deterministically by ticket id so the cap is reproducible", () => {
    writeSignal(orchDir, "CTL-3", "implement", { worktreePath: "/wt/CTL-3" });
    writeSignal(orchDir, "CTL-1", "implement", { worktreePath: "/wt/CTL-1" });
    writeSignal(orchDir, "CTL-2", "implement", { worktreePath: "/wt/CTL-2" });
    const out = selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 2 });
    expect(out.map((c) => c.ticket)).toEqual(["CTL-1", "CTL-2"]);
  });

  test("defaults maxParallel from state.json when not passed", () => {
    writeMaxParallel(orchDir, 1);
    writeSignal(orchDir, "CTL-1", "implement", { worktreePath: "/wt/CTL-1" });
    writeSignal(orchDir, "CTL-2", "implement", { worktreePath: "/wt/CTL-2" });
    const out = selectBootResumeCandidates({ orchDir, agents: [] });
    expect(out).toHaveLength(1);
  });

  test("selectBootResumeCandidates picks up monitor-deploy/running (CTL-701)", () => {
    writeSignal(orchDir, "CTL-MD", "monitor-deploy", {
      worktreePath: "/wt/CTL-MD",
      bg_job_id: "md-job-1",
      status: "running",
    });
    const out = selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 3 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      ticket: "CTL-MD",
      phase: "monitor-deploy",
      worktreePath: "/wt/CTL-MD",
      bgJobId: "md-job-1",
    });
  });

  test("selectBootResumeCandidates picks up implement/turn-cap-exhausted (CTL-701)", () => {
    writeSignal(orchDir, "CTL-TCE", "implement", {
      worktreePath: "/wt/CTL-TCE",
      bg_job_id: "tce-job-1",
      status: "turn-cap-exhausted",
    });
    const out = selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 3 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      ticket: "CTL-TCE",
      phase: "implement",
      worktreePath: "/wt/CTL-TCE",
      bgJobId: "tce-job-1",
    });
  });

  // CTL-665: a committed executionCore.maxParallel (threaded via `concurrency`)
  // overrides state.json for the boot-resume ceiling, mirroring the new-work pull.
  test("concurrency.maxParallel overrides state.json for the boot ceiling (CTL-665)", () => {
    writeMaxParallel(orchDir, 1); // state.json caps at 1
    writeSignal(orchDir, "CTL-1", "implement", { worktreePath: "/wt/CTL-1" });
    writeSignal(orchDir, "CTL-2", "implement", { worktreePath: "/wt/CTL-2" });
    writeSignal(orchDir, "CTL-3", "implement", { worktreePath: "/wt/CTL-3" });
    const out = selectBootResumeCandidates({
      orchDir,
      agents: [],
      concurrency: { maxParallel: 3, minParallel: 1, maxParallelCeiling: 10 },
    });
    // committed config (3) wins over state.json (1) → 3 candidates, not 1.
    expect(out).toHaveLength(3);
  });
});

// ── Phase 2: reconcileBootResume orchestration ────────────────────────────
describe("reconcileBootResume", () => {
  test("cold-start gate: report.coldStart === false ⇒ 0 dispatches, no-op", () => {
    writeSignal(orchDir, "CTL-1", "implement", { worktreePath: "/wt/CTL-1" });
    const calls = [];
    const dispatch = (a) => {
      calls.push(a);
      return { code: 0 };
    };
    const appendEvent = () => calls.push("event");
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: false },
      agents: [],
      dispatch,
      appendEvent,
    });
    expect(res.dispatched).toBe(0);
    expect(calls).toHaveLength(0);
    expect(res.skipped).toBe("not-cold-start");
  });

  test("missing/undefined report ⇒ no-op (defensive)", () => {
    const calls = [];
    const res = reconcileBootResume({
      orchDir,
      report: undefined,
      agents: [],
      dispatch: () => calls.push("d"),
      appendEvent: () => calls.push("e"),
    });
    expect(res.dispatched).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("happy path: dispatches once with expectedWorktreePath and resets the signal to stalled", () => {
    // Uses 'plan' (cheap phase) so dispatch is not gated.
    writeSignal(orchDir, "CTL-1", "plan", { worktreePath: "/wt/CTL-1", status: "running" });
    const dispatched = [];
    const events = [];
    const dispatch = (a) => {
      dispatched.push(a);
      return { code: 0 };
    };
    const appendEvent = (a) => events.push(a);
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [],
      dispatch,
      appendEvent,
    });
    expect(res.dispatched).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      orchDir,
      ticket: "CTL-1",
      phase: "plan",
      expectedWorktreePath: "/wt/CTL-1",
    });
    // Went through defaultReviveDispatch: the signal on disk is reset to stalled.
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-1", "phase-plan.json"), "utf8")
    );
    expect(sig.status).toBe("stalled");
    // One audit event routed through the injected appendEvent.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ticket: "CTL-1", phase: "plan" });
  });

  test("slot bound end-to-end: maxParallel=1, 2 no-live tickets ⇒ exactly 1 dispatch + 1 event", () => {
    writeMaxParallel(orchDir, 1);
    writeSignal(orchDir, "CTL-1", "plan", { worktreePath: "/wt/CTL-1" });
    writeSignal(orchDir, "CTL-2", "plan", { worktreePath: "/wt/CTL-2" });
    const dispatched = [];
    const events = [];
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [],
      dispatch: (a) => {
        dispatched.push(a);
        return { code: 0 };
      },
      appendEvent: (a) => events.push(a),
    });
    expect(res.dispatched).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  test("skip-when-live: a ticket WITH a live bg worker is never dispatched", () => {
    writeMaxParallel(orchDir, 3);
    writeSignal(orchDir, "CTL-LIVE", "plan", { worktreePath: "/wt/CTL-LIVE" });
    const dispatched = [];
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [{ kind: "background", cwd: "/wt/CTL-LIVE" }],
      dispatch: (a) => {
        dispatched.push(a);
        return { code: 0 };
      },
      appendEvent: () => {},
    });
    expect(res.dispatched).toBe(0);
    expect(dispatched).toHaveLength(0);
  });

  test("dispatch failure is isolated: ticket B still attempted, failure counted, no throw", () => {
    writeMaxParallel(orchDir, 3);
    writeSignal(orchDir, "CTL-A", "plan", { worktreePath: "/wt/CTL-A" });
    writeSignal(orchDir, "CTL-B", "research", { worktreePath: "/wt/CTL-B" });
    const attempted = [];
    const events = [];
    const dispatch = (a) => {
      attempted.push(a.ticket);
      return a.ticket === "CTL-A" ? { code: 1, stderr: "boom" } : { code: 0 };
    };
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [],
      dispatch,
      appendEvent: (a) => events.push(a),
    });
    expect(attempted.sort()).toEqual(["CTL-A", "CTL-B"]);
    expect(res.dispatched).toBe(1);
    expect(res.failed).toBe(1);
    // No audit event for the failed dispatch.
    expect(events).toHaveLength(1);
    expect(events[0].ticket).toBe("CTL-B");
  });

  test("missing-signal safety: a reviveDispatch signal-missing return is a failure, not a throw", () => {
    writeMaxParallel(orchDir, 3);
    writeSignal(orchDir, "CTL-1", "plan", { worktreePath: "/wt/CTL-1" });
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [],
      reviveDispatch: () => ({ code: 1, stderr: "signal-missing" }),
      appendEvent: () => {},
    });
    expect(res.dispatched).toBe(0);
    expect(res.failed).toBe(1);
  });

  test("a throwing reviveDispatch is contained and counted as a failure", () => {
    writeMaxParallel(orchDir, 3);
    writeSignal(orchDir, "CTL-1", "plan", { worktreePath: "/wt/CTL-1" });
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [],
      reviveDispatch: () => {
        throw new Error("kaboom");
      },
      appendEvent: () => {},
    });
    expect(res.dispatched).toBe(0);
    expect(res.failed).toBe(1);
  });

  // ── CTL-690: --resume-session continuation ─────────────────────────────
  //
  // The reconcile pass must thread the dead worker's bg_job_id through
  // resolveSession() and forward the resulting UUID to reviveDispatch as
  // `resumeSession`. The downstream phase-agent-dispatch (CTL-658) translates
  // that into `claude --bg --resume <uuid>`. When resolveSession returns null
  // (no transcript on disk, legacy signal, etc.) the candidate falls back to
  // today's fresh-dispatch behavior — preserving the unchanged-from-CTL-654
  // fallback path.
  test("forwards resumeSession to reviveDispatch when resolveSession returns a UUID (CTL-690)", () => {
    writeMaxParallel(orchDir, 3);
    // Uses 'plan' (cheap phase) so dispatch is not gated.
    writeSignal(orchDir, "CTL-1", "plan", {
      worktreePath: "/wt/CTL-1",
      bg_job_id: "abc12345",
    });
    const calls = [];
    const reviveDispatch = (args, _opts) => {
      calls.push(args);
      return { code: 0 };
    };
    const resolveSession = (bgJobId) => (bgJobId === "abc12345" ? "uuid-1111" : null);
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [],
      reviveDispatch,
      resolveSession,
      appendEvent: () => {},
    });
    expect(res.dispatched).toBe(1);
    expect(res.resumed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      orchDir,
      ticket: "CTL-1",
      phase: "plan",
      resumeSession: "uuid-1111",
    });
  });

  test("falls back to fresh dispatch (resumeSession=null) when resolveSession returns null (CTL-690)", () => {
    writeMaxParallel(orchDir, 3);
    // bg_job_id is recorded but the transcript is gone → resolveSession → null.
    writeSignal(orchDir, "CTL-1", "research", {
      worktreePath: "/wt/CTL-1",
      bg_job_id: "nope9999",
    });
    const calls = [];
    const reviveDispatch = (args, _opts) => {
      calls.push(args);
      return { code: 0 };
    };
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [],
      reviveDispatch,
      resolveSession: () => null,
      appendEvent: () => {},
    });
    expect(res.dispatched).toBe(1);
    expect(res.resumed).toBe(0);
    expect(calls[0]).toMatchObject({
      orchDir,
      ticket: "CTL-1",
      phase: "research",
      resumeSession: null,
    });
  });

  test("legacy signal with no bg_job_id skips resolveSession and falls back to fresh dispatch (CTL-690)", () => {
    writeMaxParallel(orchDir, 3);
    writeSignal(orchDir, "CTL-1", "triage", {
      worktreePath: "/wt/CTL-1",
      bg_job_id: null,
    });
    const resolveCalls = [];
    const reviveCalls = [];
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [],
      reviveDispatch: (a) => {
        reviveCalls.push(a);
        return { code: 0 };
      },
      resolveSession: (id) => {
        resolveCalls.push(id);
        return "should-not-resolve";
      },
      appendEvent: () => {},
    });
    expect(resolveCalls).toEqual([]); // never called for null bgJobId
    expect(reviveCalls[0]).toMatchObject({ resumeSession: null });
    expect(res.dispatched).toBe(1);
    expect(res.resumed).toBe(0);
  });

  test("a throwing resolveSession is contained and treated as unresumable (CTL-690)", () => {
    writeMaxParallel(orchDir, 3);
    writeSignal(orchDir, "CTL-1", "plan", {
      worktreePath: "/wt/CTL-1",
      bg_job_id: "boom",
    });
    const reviveCalls = [];
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [],
      reviveDispatch: (a) => {
        reviveCalls.push(a);
        return { code: 0 };
      },
      resolveSession: () => {
        throw new Error("transcript read failed");
      },
      appendEvent: () => {},
    });
    // Dispatch still happens — the resume optimization is best-effort.
    expect(res.dispatched).toBe(1);
    expect(res.resumed).toBe(0);
    expect(reviveCalls[0]).toMatchObject({ resumeSession: null });
  });

  test("mixed batch: some resume, some fresh, all dispatch (CTL-690)", () => {
    writeMaxParallel(orchDir, 3);
    // All cheap phases (plan/research/triage) so none are gated.
    writeSignal(orchDir, "CTL-A", "plan", {
      worktreePath: "/wt/CTL-A",
      bg_job_id: "aaa",
    });
    writeSignal(orchDir, "CTL-B", "research", {
      worktreePath: "/wt/CTL-B",
      bg_job_id: "bbb",
    });
    writeSignal(orchDir, "CTL-C", "triage", {
      worktreePath: "/wt/CTL-C",
      bg_job_id: null,
    });
    const calls = [];
    const resolveSession = (id) => (id === "aaa" ? "uuid-A" : null);
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [],
      reviveDispatch: (a) => {
        calls.push(a);
        return { code: 0 };
      },
      resolveSession,
      appendEvent: () => {},
    });
    expect(res.dispatched).toBe(3);
    expect(res.resumed).toBe(1);
    const byTicket = Object.fromEntries(calls.map((c) => [c.ticket, c.resumeSession]));
    expect(byTicket).toEqual({
      "CTL-A": "uuid-A",
      "CTL-B": null,
      "CTL-C": null,
    });
  });
});

// ── CTL-701: turn-cap-exhausted boot-resume ───────────────────────────────────
describe("reconcileBootResume — turn-cap-exhausted (CTL-701)", () => {
  test("relaunches turn-cap-exhausted with --resume when session resolvable", () => {
    writeMaxParallel(orchDir, 3);
    // Uses 'plan' (cheap phase) so dispatch is not gated by CTL-644.
    writeSignal(orchDir, "CTL-TCE", "plan", {
      worktreePath: "/wt/CTL-TCE",
      bg_job_id: "tce-abc",
      status: "turn-cap-exhausted",
    });
    const calls = [];
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [],
      reviveDispatch: (a) => {
        calls.push(a);
        return { code: 0 };
      },
      resolveSession: (id) => (id === "tce-abc" ? "uuid-resume" : null),
      appendEvent: () => {},
    });
    expect(res.dispatched).toBe(1);
    expect(res.resumed).toBe(1);
    expect(calls[0]).toMatchObject({
      ticket: "CTL-TCE",
      phase: "plan",
      resumeSession: "uuid-resume",
    });
  });
});

// ── Phase 2: audit event round-trip — boot-resume must NOT count as a revive ──
describe("defaultAppendBootResumeEvent envelope", () => {
  let envCatalystDir;
  let prevCatalystDir;
  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    envCatalystDir = mkdtempSync(join(tmpdir(), "ctl654-rt-"));
    process.env.CATALYST_DIR = envCatalystDir;
    mkdirSync(join(envCatalystDir, "events"), { recursive: true });
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(envCatalystDir, { recursive: true, force: true });
  });

  test("writes phase.<phase>.boot-resume.<ticket> and is NOT counted by countReviveEvents", async () => {
    const { defaultAppendBootResumeEvent } = await import("./recovery.mjs");
    const { countReviveEvents } = await import("./event-scan.mjs");
    const ok = defaultAppendBootResumeEvent({
      phase: "implement",
      ticket: "CTL-RT-654",
      orchId: "orch-654",
    });
    expect(ok).toBe(true);
    // boot-resume is a distinct action: the implement-only revive counter must
    // stay at 0 so a reboot does not consume the chronic-failure budget.
    expect(countReviveEvents({ ticket: "CTL-RT-654" })).toBe(0);
  });
});

// CTL-549: selectBootResumeCandidates skips needs-input signals
describe("selectBootResumeCandidates — needs-input guard (CTL-549)", () => {
  test("skips tickets with needs-input signal (not re-dispatched on reboot)", () => {
    writeSignal(orchDir, "CTL-1", "implement", {
      status: "needs-input",
      parkedFrom: "implement",
      worktreePath: "/wt/CTL-1",
    });
    const out = selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 4 });
    expect(out.map((c) => c.ticket)).not.toContain("CTL-1");
  });

  test("other in-flight tickets are still resumed normally alongside a parked one", () => {
    writeSignal(orchDir, "CTL-1", "implement", {
      status: "needs-input",
      parkedFrom: "implement",
      worktreePath: "/wt/CTL-1",
    });
    writeSignal(orchDir, "CTL-2", "verify", { worktreePath: "/wt/CTL-2" });
    const out = selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 4 });
    expect(out.map((c) => c.ticket)).not.toContain("CTL-1");
    expect(out.map((c) => c.ticket)).toContain("CTL-2");
  });
});

// ─── CTL-644: isCheapPhase classifier ───

describe("isCheapPhase (CTL-644)", () => {
  test("returns true for cheap phases (triage, research, plan) and false for all expensive phases", () => {
    expect(isCheapPhase("triage")).toBe(true);
    expect(isCheapPhase("research")).toBe(true);
    expect(isCheapPhase("plan")).toBe(true);

    expect(isCheapPhase("implement")).toBe(false);
    expect(isCheapPhase("verify")).toBe(false);
    expect(isCheapPhase("review")).toBe(false);
    expect(isCheapPhase("pr")).toBe(false);
    expect(isCheapPhase("monitor-merge")).toBe(false);
    expect(isCheapPhase("monitor-deploy")).toBe(false);
    expect(isCheapPhase("remediate")).toBe(false);
  });
});

// ─── CTL-644: reconcileBootResume cheap/expensive branching ───

describe("reconcileBootResume — cheap/expensive classification (CTL-644)", () => {
  // Shared cold-start report used across tests in this block.
  const coldReport = { coldStart: true };

  function makeDispatch(code = 0) {
    const calls = [];
    const fn = (...args) => { calls.push(args); return { code }; };
    fn.calls = calls;
    return fn;
  }

  function makeAppendEvent() {
    const calls = [];
    const fn = (...args) => { calls.push(args); return true; };
    fn.calls = calls;
    return fn;
  }

  test("cheap phases (triage/research/plan) auto-dispatch — reviveDispatch called, no pending marker", () => {
    writeSignal(orchDir, "CTL-10", "triage", { worktreePath: "/wt/CTL-10" });
    writeSignal(orchDir, "CTL-11", "research", { worktreePath: "/wt/CTL-11" });
    writeSignal(orchDir, "CTL-12", "plan", { worktreePath: "/wt/CTL-12" });
    writeMaxParallel(orchDir, 10);

    const reviveDispatch = makeDispatch(0);
    const appendEvent = makeAppendEvent();
    const appendGatedEvent = makeAppendEvent();

    const result = reconcileBootResume({
      orchDir,
      report: coldReport,
      agents: [],
      reviveDispatch,
      dispatch: () => {},
      appendEvent,
      appendGatedEvent,
      resolveSession: () => null,
    });

    expect(reviveDispatch.calls.length).toBe(3);
    expect(result.dispatched).toBe(3);
    expect(result.gated).toBe(0);

    // No pending markers written for cheap phases
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-10"))).toBe(false);
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-11"))).toBe(false);
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-12"))).toBe(false);
  });

  test("expensive phases are gated — reviveDispatch not called, pending marker written, gated event emitted", () => {
    writeSignal(orchDir, "CTL-20", "implement", { worktreePath: "/wt/CTL-20" });
    writeSignal(orchDir, "CTL-21", "verify", { worktreePath: "/wt/CTL-21" });
    writeSignal(orchDir, "CTL-22", "pr", { worktreePath: "/wt/CTL-22" });
    writeMaxParallel(orchDir, 10);

    const reviveDispatch = makeDispatch(0);
    const appendGatedEvent = makeAppendEvent();

    const result = reconcileBootResume({
      orchDir,
      report: coldReport,
      agents: [],
      reviveDispatch,
      dispatch: () => {},
      appendEvent: makeAppendEvent(),
      appendGatedEvent,
      resolveSession: () => null,
    });

    expect(reviveDispatch.calls.length).toBe(0);
    expect(result.dispatched).toBe(0);
    expect(result.gated).toBe(3);
    expect(appendGatedEvent.calls.length).toBe(3);

    // Pending markers written for each expensive ticket
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-20"))).toBe(true);
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-21"))).toBe(true);
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-22"))).toBe(true);
  });

  test("mixed set — cheap auto-dispatched, expensive gated, done phases skipped", () => {
    writeSignal(orchDir, "CTL-30", "plan", { worktreePath: "/wt/CTL-30" });
    writeSignal(orchDir, "CTL-31", "implement", { worktreePath: "/wt/CTL-31" });
    // CTL-32 is at terminal done — selectBootResumeCandidates will skip it
    writeSignal(orchDir, "CTL-32", "monitor-deploy", {
      status: "done",
      worktreePath: "/wt/CTL-32",
    });
    writeMaxParallel(orchDir, 10);

    const reviveDispatch = makeDispatch(0);
    const appendGatedEvent = makeAppendEvent();

    const result = reconcileBootResume({
      orchDir,
      report: coldReport,
      agents: [],
      reviveDispatch,
      dispatch: () => {},
      appendEvent: makeAppendEvent(),
      appendGatedEvent,
      resolveSession: () => null,
    });

    expect(result.dispatched).toBe(1);
    expect(result.gated).toBe(1);
    expect(reviveDispatch.calls.length).toBe(1);
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-30"))).toBe(false);
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-31"))).toBe(true);
  });

  test("idempotent re-gate — second call with pending marker already present skips gated event", () => {
    writeSignal(orchDir, "CTL-40", "review", { worktreePath: "/wt/CTL-40" });
    writeMaxParallel(orchDir, 10);

    const appendGatedEvent = makeAppendEvent();
    const opts = {
      orchDir,
      report: coldReport,
      agents: [],
      reviveDispatch: makeDispatch(0),
      dispatch: () => {},
      appendEvent: makeAppendEvent(),
      appendGatedEvent,
      resolveSession: () => null,
    };

    // First call — marker created + event emitted
    reconcileBootResume(opts);
    expect(appendGatedEvent.calls.length).toBe(1);
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-40"))).toBe(true);

    // Second call — marker already exists, no re-emit
    reconcileBootResume({ ...opts, reviveDispatch: makeDispatch(0), appendGatedEvent });
    expect(appendGatedEvent.calls.length).toBe(1); // still 1, not 2
  });
});
