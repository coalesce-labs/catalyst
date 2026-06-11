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
  // CTL-1006
  isBootResumeEligible,
  supersededByTerminalPhase,
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

  test("selectBootResumeCandidates EXCLUDES turn-cap-exhausted — terminal since CTL-748 (CTL-830)", () => {
    writeSignal(orchDir, "CTL-TCE", "implement", {
      worktreePath: "/wt/CTL-TCE",
      bg_job_id: "tce-job-1",
      status: "turn-cap-exhausted",
    });
    const out = selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 3 });
    expect(out).toHaveLength(0);
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
    // CTL-1006: the eligibility gate's skip reason is now "not-eligible"
    // (it admits a daemon bounce, not only a cold start).
    expect(res.skipped).toBe("not-eligible");
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

// ── CTL-830: turn-cap-exhausted is terminal — boot-resume must NOT relaunch it ──
describe("reconcileBootResume — turn-cap-exhausted is terminal (CTL-830)", () => {
  test("does NOT relaunch turn-cap-exhausted on cold start", () => {
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
    expect(res.dispatched).toBe(0);
    expect(res.resumed).toBe(0);
    expect(calls).toHaveLength(0);
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

// ─── CTL-1006 Scenario 1: eligibility predicate (real object shape + bounce) ──
//
// In production recoverStartup (recovery.mjs:2576/2583) sets report.coldStart to
// the detectColdStart OBJECT — { coldStart, epoch, epochSource, ... } — never a
// bare boolean. The legacy `coldStart !== true` gate is therefore a permanent
// no-op in production: an object is never === true. isBootResumeEligible
// normalizes both shapes AND admits a daemon bounce (exec-core boot epoch wins
// the verdict, CTL-701) so a daemon restart resumes in-flight tickets instead of
// letting the budget-gated per-tick reclaim false-escalate them to needs-human.
describe("isBootResumeEligible (CTL-1006)", () => {
  test("undefined/null report ⇒ false (defensive)", () => {
    expect(isBootResumeEligible(undefined)).toBe(false);
    expect(isBootResumeEligible(null)).toBe(false);
  });

  test("legacy synthetic boolean { coldStart: true } ⇒ true (back-compat)", () => {
    expect(isBootResumeEligible({ coldStart: true })).toBe(true);
  });

  test("legacy synthetic boolean { coldStart: false } ⇒ false (back-compat no-op)", () => {
    expect(isBootResumeEligible({ coldStart: false })).toBe(false);
  });

  test("REAL object cold start { coldStart: { coldStart: true, epochSource: 'os-boot' } } ⇒ true", () => {
    // This is the production shape (detectColdStart return). The dead gate
    // treated it as false (object !== true). This is the literal Scenario-1 bug.
    expect(
      isBootResumeEligible({ coldStart: { coldStart: true, epochSource: "os-boot" } })
    ).toBe(true);
  });

  test("real object warm, OS epoch wins { coldStart: { coldStart: false, epochSource: 'os-boot' } } ⇒ false", () => {
    // Scenario-1 "solely because the daemon restarted": an OS-warm, NON-bounce
    // start stays a no-op — only genuine cold starts / bounces are eligible.
    expect(
      isBootResumeEligible({ coldStart: { coldStart: false, epochSource: "os-boot" } })
    ).toBe(false);
  });

  test("DAEMON BOUNCE { coldStart: { coldStart: false, epochSource: 'exec-core' } } ⇒ true", () => {
    // exec-core boot epoch is the winning cold-start source (CTL-701): a daemon
    // restart without OS/socket reboot. The Scenario-1 fix admits it so in-flight
    // tickets resume rather than being false-escalated by the reclaim sweep.
    expect(
      isBootResumeEligible({ coldStart: { coldStart: false, epochSource: "exec-core" } })
    ).toBe(true);
  });

  test("explicit { daemonBounce: true } override seam ⇒ true", () => {
    expect(isBootResumeEligible({ daemonBounce: true })).toBe(true);
  });
});

// ─── CTL-1006 Scenario 1 end-to-end: reconcile runs on the production shape ───
describe("reconcileBootResume — runs on real object shape + bounce (CTL-1006)", () => {
  test("real object cold start dispatches a cheap phase (was a dead no-op pre-CTL-1006)", () => {
    writeSignal(orchDir, "CTL-1", "plan", { worktreePath: "/wt/CTL-1", status: "running" });
    const dispatched = [];
    const events = [];
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: { coldStart: true, epochSource: "os-boot" } },
      agents: [],
      dispatch: (a) => {
        dispatched.push(a);
        return { code: 0 };
      },
      appendEvent: (a) => events.push(a),
    });
    expect(res.dispatched).toBe(1);
    expect(dispatched).toHaveLength(1);
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-1", "phase-plan.json"), "utf8")
    );
    expect(sig.status).toBe("stalled"); // went through defaultReviveDispatch
    expect(events).toHaveLength(1);
  });

  test("daemon bounce (epochSource exec-core) dispatches a cheap phase — the Scenario-1 fix", () => {
    writeSignal(orchDir, "CTL-2", "research", { worktreePath: "/wt/CTL-2", status: "running" });
    const dispatched = [];
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: { coldStart: false, epochSource: "exec-core" } },
      agents: [],
      dispatch: (a) => {
        dispatched.push(a);
        return { code: 0 };
      },
      appendEvent: () => {},
    });
    expect(res.dispatched).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ ticket: "CTL-2", phase: "research" });
  });

  test("OS-warm non-bounce object ⇒ no-op (in-flight ticket NOT escalated solely because of restart)", () => {
    writeSignal(orchDir, "CTL-3", "research", { worktreePath: "/wt/CTL-3", status: "running" });
    const dispatched = [];
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: { coldStart: false, epochSource: "os-boot" } },
      agents: [],
      dispatch: (a) => {
        dispatched.push(a);
        return { code: 0 };
      },
      appendEvent: () => {},
    });
    expect(res.dispatched).toBe(0);
    expect(dispatched).toHaveLength(0);
    expect(res.skipped).toBe("not-eligible");
  });
});

// ─── CTL-1006 Scenario 2: supersededByTerminalPhase pure unit ────────────────
//
// True iff some signal is TERMINAL at a phase strictly LATER than the resume
// candidate's phase. Mirrors recovery's CTL-606 supersede guard but keyed on the
// resume candidate: a later terminal phase (research=stalled) means re-dispatching
// an earlier phase (triage) is a phase regression, not a resume.
describe("supersededByTerminalPhase (CTL-1006)", () => {
  test("a later TERMINAL phase supersedes the candidate — returns its name", () => {
    const signals = [
      { phase: "triage", status: "running" },
      { phase: "research", status: "stalled" },
    ];
    expect(supersededByTerminalPhase(signals, "triage")).toBe("research");
  });

  test("only EARLIER terminal phases present ⇒ null (forward resume is fine)", () => {
    const signals = [
      { phase: "triage", status: "done" },
      { phase: "research", status: "done" },
      { phase: "plan", status: "done" },
      { phase: "implement", status: "running" },
    ];
    expect(supersededByTerminalPhase(signals, "implement")).toBeNull();
  });

  test("equal-index terminal (remediate vs verify) is NOT a supersede (strictly-greater only)", () => {
    // remediate ranks at verify's index — a remediate terminal must not shadow a
    // verify resume candidate.
    const signals = [{ phase: "remediate", status: "stalled" }];
    expect(supersededByTerminalPhase(signals, "verify")).toBeNull();
  });

  test("a NON-terminal later phase does NOT supersede (keys on terminal only)", () => {
    const signals = [{ phase: "research", status: "running" }];
    expect(supersededByTerminalPhase(signals, "triage")).toBeNull();
  });

  test("unknown candidate phase ⇒ null, no throw (CTL-702 posture)", () => {
    const signals = [{ phase: "research", status: "stalled" }];
    expect(supersededByTerminalPhase(signals, "bogus-phase")).toBeNull();
  });

  test("unknown signal phase in the list is skipped, no throw", () => {
    const signals = [
      { phase: "tombstone-xyz", status: "stalled" },
      { phase: "research", status: "stalled" },
    ];
    expect(supersededByTerminalPhase(signals, "triage")).toBe("research");
  });

  test("undefined / empty signal list ⇒ null", () => {
    expect(supersededByTerminalPhase(undefined, "triage")).toBeNull();
    expect(supersededByTerminalPhase([], "triage")).toBeNull();
  });
});

// ─── CTL-1006 Scenario 2: phase-regression guard in candidate selection ──────
//
// The CTL-997/998 regression: a LATER phase is already terminal while an OLDER
// earlier-phase signal is non-terminal (e.g. research=done but a stale triage
// signal got re-touched to running). activePhaseForTicket is recency-ranked, so
// it would resolve the earlier phase as the resume candidate. The guard reads the
// FULL per-file signal set (readAllPhaseSignals — the collapsed readWorkerSignals
// hides sibling terminal phases) and must NOT re-dispatch the earlier phase behind
// a later terminal one; it surfaces a phase_regression observation instead.
//
// NOTE: the dominant phase here is terminal-`done` (not `stalled`). A `stalled`
// sibling would make the ticket not-in-flight (scheduler.isTicketInFlight), so
// the in-flight gate is the FIRST line of defense; this guard is defense-in-depth
// for the in-flight, already-advanced-then-shadowed case.
describe("selectBootResumeCandidates — phase-regression guard (CTL-1006)", () => {
  test("research=done + older triage=running ⇒ candidate dropped (no triage re-dispatch)", () => {
    writeSignal(orchDir, "CTL-997", "research", {
      status: "done",
      worktreePath: "/wt/CTL-997",
      updatedAt: "2026-05-27T03:00:00Z",
    });
    writeSignal(orchDir, "CTL-997", "triage", {
      status: "running",
      worktreePath: "/wt/CTL-997",
      updatedAt: "2026-05-27T01:00:00Z",
    });
    const out = selectBootResumeCandidates({ orchDir, agents: [], maxParallel: 3 });
    expect(out.map((c) => c.ticket)).not.toContain("CTL-997");
    expect(out).toEqual([]);
  });

  test("onPhaseRegression fires once with the candidate + dominant phase", () => {
    writeSignal(orchDir, "CTL-997", "research", {
      status: "done",
      worktreePath: "/wt/CTL-997",
      updatedAt: "2026-05-27T03:00:00Z",
    });
    writeSignal(orchDir, "CTL-997", "triage", {
      status: "running",
      worktreePath: "/wt/CTL-997",
      updatedAt: "2026-05-27T01:00:00Z",
    });
    const observed = [];
    selectBootResumeCandidates({
      orchDir,
      agents: [],
      maxParallel: 3,
      onPhaseRegression: (o) => observed.push(o),
    });
    expect(observed).toEqual([
      { ticket: "CTL-997", phase: "triage", dominantPhase: "research" },
    ]);
  });

  test("negative control: research=running (non-terminal) ⇒ NOT a regression, candidate selected", () => {
    writeSignal(orchDir, "CTL-998", "research", {
      status: "running",
      worktreePath: "/wt/CTL-998",
      updatedAt: "2026-05-27T03:00:00Z",
    });
    writeSignal(orchDir, "CTL-998", "triage", {
      status: "running",
      worktreePath: "/wt/CTL-998",
      updatedAt: "2026-05-27T01:00:00Z",
    });
    const observed = [];
    const out = selectBootResumeCandidates({
      orchDir,
      agents: [],
      maxParallel: 3,
      onPhaseRegression: (o) => observed.push(o),
    });
    // active phase is research (freshest non-terminal); no later terminal phase.
    expect(out.map((c) => c.ticket)).toContain("CTL-998");
    expect(observed).toEqual([]);
  });

  test("negative control: forward resume — implement=running with earlier phases done ⇒ selected", () => {
    writeSignal(orchDir, "CTL-999", "triage", { status: "done", worktreePath: "/wt/CTL-999" });
    writeSignal(orchDir, "CTL-999", "research", { status: "done", worktreePath: "/wt/CTL-999" });
    writeSignal(orchDir, "CTL-999", "plan", { status: "done", worktreePath: "/wt/CTL-999" });
    writeSignal(orchDir, "CTL-999", "implement", {
      status: "running",
      worktreePath: "/wt/CTL-999",
      updatedAt: "2026-05-27T04:00:00Z",
    });
    const observed = [];
    const out = selectBootResumeCandidates({
      orchDir,
      agents: [],
      maxParallel: 3,
      onPhaseRegression: (o) => observed.push(o),
    });
    expect(out.map((c) => c.ticket)).toContain("CTL-999");
    expect(out.find((c) => c.ticket === "CTL-999").phase).toBe("implement");
    expect(observed).toEqual([]);
  });
});

// ─── CTL-1006 Scenario 2 wiring: regression observation through reconcile ─────
describe("reconcileBootResume — phase-regression observation routing (CTL-1006)", () => {
  test("emits the regression event and never revives the earlier phase", () => {
    writeSignal(orchDir, "CTL-997", "research", {
      status: "done",
      worktreePath: "/wt/CTL-997",
      updatedAt: "2026-05-27T03:00:00Z",
    });
    writeSignal(orchDir, "CTL-997", "triage", {
      status: "running",
      worktreePath: "/wt/CTL-997",
      updatedAt: "2026-05-27T01:00:00Z",
    });
    writeMaxParallel(orchDir, 3);

    const revived = [];
    const regressions = [];
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [],
      reviveDispatch: (a) => {
        revived.push(a);
        return { code: 0 };
      },
      dispatch: () => {},
      appendEvent: () => {},
      appendRegressionEvent: (o) => regressions.push(o),
    });

    // No fresh triage worker spawned.
    expect(revived.find((r) => r.ticket === "CTL-997")).toBeUndefined();
    expect(res.dispatched).toBe(0);
    // The regression observation was routed through the appender seam.
    expect(regressions).toEqual([
      { phase: "triage", ticket: "CTL-997", dominantPhase: "research", orchId: undefined },
    ]);
  });
});

// ─── CTL-1006 Scenario 3: expensive-phase gate still holds under bounce ──────
describe("reconcileBootResume — expensive gate holds under bounce shape (CTL-1006)", () => {
  test("implement gated behind .boot-resume-pending-approval even via the bounce path", () => {
    writeSignal(orchDir, "CTL-50", "implement", { worktreePath: "/wt/CTL-50" });
    writeMaxParallel(orchDir, 10);

    const revived = [];
    const gatedEvents = [];
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: { coldStart: false, epochSource: "exec-core" } }, // bounce
      agents: [],
      reviveDispatch: (a) => {
        revived.push(a);
        return { code: 0 };
      },
      dispatch: () => {},
      appendEvent: () => {},
      appendGatedEvent: (o) => gatedEvents.push(o),
    });

    expect(res.gated).toBe(1);
    expect(res.dispatched).toBe(0);
    expect(revived).toHaveLength(0); // expensive phase NOT auto-revived
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-50"))).toBe(true);
    expect(gatedEvents).toHaveLength(1);
    expect(gatedEvents[0]).toMatchObject({ ticket: "CTL-50", phase: "implement" });
  });
});
