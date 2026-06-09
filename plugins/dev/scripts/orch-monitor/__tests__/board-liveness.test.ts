// CTL-928 — the queue board must truthfully account for every in-flight ticket:
// a DEAD background worker must never look active, and an IDLE-between-phases
// ticket must never disappear. A signal file that says `running` is NOT proof of
// life (on 2026-06-09 four sources disagreed on liveness) — so liveness is derived
// from the DURABLE `claude --bg` job state.json, not the phase signal.
//
// These tests exercise the four fix sites in board-data.mjs as PURE functions
// (assembleBoard itself shells out to `claude agents` + reads homedir consts, so
// it is not directly unit-testable — same convention as board-current-phase.test.ts
// / board-data-worker-ids.test.ts):
//   • deriveActiveState  — a dead bg-job renders "dead", not "active"
//   • laneFor            — a terminal-intermediate / dead-but-running ticket lands
//                          in the between-phases lane, not recent-done, not dropped
//   • deriveCapacity     — freeSlots/inFlight reflect LIVE workers only
//   • bgJobLifecycle     — the durable-state liveness primitive
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readBgJobState,
  bgJobLifecycle,
  isBgJobDead,
  isWorkerDead,
  deriveActiveState,
  deriveCapacity,
  laneFor,
  TERMINAL_JOB_STATES,
  PIPELINE_DONE_PHASE,
} from "../lib/board-data.mjs";
import type { BoardActiveState } from "../lib/board-data.d.mts";

// Minimal shapes the pure helpers consume — typed so literals widen to the union,
// not to bare `string`.
type CapWorker = { activeState: BoardActiveState; working: boolean };
type LaneTicket = { workerStatus: string | null; activeState: BoardActiveState; phase: string };

// ── readBgJobState + deriveActiveState end-to-end against a REAL temp jobs dir ──
// Validates the actual fs read path (the CATALYST_REVIVE_JOBS_DIR override) and the
// failed-bg-state + fresh-transcript scenario through to the "dead" verdict.
test("readBgJobState reads a failed state.json from a temp jobs dir, and deriveActiveState renders 'dead' despite a fresh (<30m) transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "ctl928-jobs-"));
  const prev = process.env.CATALYST_REVIVE_JOBS_DIR;
  process.env.CATALYST_REVIVE_JOBS_DIR = root;
  try {
    const bgJobId = "abc12345";
    mkdirSync(join(root, bgJobId), { recursive: true });
    writeFileSync(
      join(root, bgJobId, "state.json"),
      JSON.stringify({ state: "failed", firstTerminalAt: "2026-06-09T08:00:00Z", detail: "API Error" }),
    );

    const jobState = await readBgJobState(bgJobId);
    expect(jobState).toEqual({ state: "failed", firstTerminalAt: "2026-06-09T08:00:00Z" });
    expect(isBgJobDead(jobState)).toBe(true);

    // 8-minute-fresh transcript — under STUCK_MS — would have been "active" pre-CTL-928.
    const state = await deriveActiveState("CTL-722", "plan", 8 * 60_000, jobState, /* bgKnown */ true);
    expect(state).toBe("dead");
  } finally {
    if (prev === undefined) delete process.env.CATALYST_REVIVE_JOBS_DIR;
    else process.env.CATALYST_REVIVE_JOBS_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBgJobState: gone job dir → null (dead-gone); a 'working' state.json → alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "ctl928-jobs-"));
  const prev = process.env.CATALYST_REVIVE_JOBS_DIR;
  process.env.CATALYST_REVIVE_JOBS_DIR = root;
  try {
    expect(await readBgJobState("does-not-exist")).toBeNull();
    const alive = "live9999";
    mkdirSync(join(root, alive), { recursive: true });
    writeFileSync(join(root, alive, "state.json"), JSON.stringify({ state: "working" }));
    const js = await readBgJobState(alive);
    expect(js).toEqual({ state: "working", firstTerminalAt: null });
    expect(bgJobLifecycle(js)).toBe("alive");
  } finally {
    if (prev === undefined) delete process.env.CATALYST_REVIVE_JOBS_DIR;
    else process.env.CATALYST_REVIVE_JOBS_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── bgJobLifecycle: the durable-state liveness primitive (mirrors recovery.mjs) ─
test("bgJobLifecycle: gone job dir (null state) → dead-gone", () => {
  expect(bgJobLifecycle(null)).toBe("dead-gone");
});

test("bgJobLifecycle: terminal .state (stopped/failed/done/blocked) → dead-terminal", () => {
  for (const s of ["stopped", "failed", "done", "blocked"]) {
    expect(bgJobLifecycle({ state: s, firstTerminalAt: null })).toBe("dead-terminal");
  }
});

test("bgJobLifecycle: firstTerminalAt set → dead-terminal even on an unknown state", () => {
  expect(bgJobLifecycle({ state: "weird-unenumerated", firstTerminalAt: "2026-06-09T08:00:00Z" }))
    .toBe("dead-terminal");
});

test("bgJobLifecycle: 'working' (or unreadable-but-present) → alive (mtime NOT consulted)", () => {
  expect(bgJobLifecycle({ state: "working", firstTerminalAt: null })).toBe("alive");
  // an unreadable-but-present state.json surfaces { state:null } → alive (dir exists)
  expect(bgJobLifecycle({ state: null, firstTerminalAt: null })).toBe("alive");
});

test("isBgJobDead: true for terminal/gone, false for alive", () => {
  expect(isBgJobDead(null)).toBe(true);
  expect(isBgJobDead({ state: "failed", firstTerminalAt: null })).toBe(true);
  expect(isBgJobDead({ state: "working", firstTerminalAt: null })).toBe(false);
});

test("TERMINAL_JOB_STATES is exactly the four Claude bg terminal states", () => {
  expect([...TERMINAL_JOB_STATES].sort()).toEqual(["blocked", "done", "failed", "stopped"]);
  expect(TERMINAL_JOB_STATES.has("working")).toBe(false);
});

// ── SCENARIO: A worker whose background job has FAILED is shown as dead ──────────
//   Given a ticket's phase worker has a background job in state "failed"
//   And that worker's transcript was last touched 8 minutes ago
//   Then the worker is shown as dead (not "active"), excluded from inFlight + capacity
test("deriveActiveState: failed bg-job + FRESH (<30m) transcript → 'dead' (signal-age does not resurrect it)", async () => {
  const eightMinMs = 8 * 60_000; // well under STUCK_MS (30m) — would have rendered "active" before CTL-928
  const state = await deriveActiveState(
    "CTL-722", "plan", eightMinMs,
    { state: "failed", firstTerminalAt: "2026-06-09T08:00:00Z" },
    /* bgKnown */ true,
  );
  expect(state).toBe("dead");
});

test("deriveActiveState: gone job dir (null) with bgKnown → 'dead'", async () => {
  const state = await deriveActiveState("CTL-865", "plan", 1000, null, true);
  expect(state).toBe("dead");
});

test("deriveActiveState: alive 'working' bg-job + fresh transcript → 'active'", async () => {
  const state = await deriveActiveState(
    "CTL-999", "implement", 1000,
    { state: "working", firstTerminalAt: null }, true,
  );
  expect(state).toBe("active");
});

test("deriveActiveState: NO resolvable bg_job_id (bgKnown=false) → falls back to transcript age, never fabricates dead", async () => {
  // bgKnown=false: we cannot prove death from the durable state, so a fresh
  // transcript stays "active" (matches the daemon's classifyWorker "unknown" path).
  const fresh = await deriveActiveState("CTL-1", "implement", 1000, null, false);
  expect(fresh).toBe("active");
  // a >30m-stale transcript with no bg state is the pre-existing "stuck" verdict.
  const stale = await deriveActiveState("CTL-1", "implement", 31 * 60_000, null, false);
  expect(stale).toBe("stuck");
});

test("isWorkerDead: keys off the derived activeState 'dead'", () => {
  expect(isWorkerDead({ activeState: "dead" })).toBe(true);
  expect(isWorkerDead({ activeState: "active" })).toBe(false);
  expect(isWorkerDead({ activeState: "stuck" })).toBe(false);
  expect(isWorkerDead(null)).toBe(false);
});

// ── SCENARIO: Free-slot count reflects LIVE capacity, not worker-dir count ───────
//   Given 6 in-flight workers and 3 of their background jobs are dead
//   Then the board reports 3 live in-flight and 3 free slots
test("deriveCapacity: 6 listed, 3 dead → inFlight 3, freeSlots 3, dead 3 (dead workers do not consume capacity)", () => {
  const workers: CapWorker[] = [
    { activeState: "active", working: true },
    { activeState: "active", working: true },
    { activeState: "stuck", working: false },
    { activeState: "dead", working: false },
    { activeState: "dead", working: false },
    { activeState: "dead", working: false },
  ];
  const cfg = deriveCapacity(workers, 6);
  expect(cfg.inFlight).toBe(3); // only the 3 live workers
  expect(cfg.freeSlots).toBe(3); // 6 − 3 live
  expect(cfg.dead).toBe(3);
  expect(cfg.active).toBe(2);
  expect(cfg.stuck).toBe(1);
  expect(cfg.working).toBe(2);
  expect(cfg.maxParallel).toBe(6);
});

test("deriveCapacity: all dead → 0 inFlight, full free capacity", () => {
  const workers: CapWorker[] = [
    { activeState: "dead", working: false },
    { activeState: "dead", working: false },
  ];
  const cfg = deriveCapacity(workers, 6);
  expect(cfg.inFlight).toBe(0);
  expect(cfg.freeSlots).toBe(6);
  expect(cfg.dead).toBe(2);
});

// ── SCENARIO: A triaged ticket waiting for its next phase is between-phases ──────
//   Given a ticket has finished triage (worker dir exists, latest signal "done")
//   And no live worker is currently assigned to it
//   Then the ticket appears in an "idle / between-phases" lane (not recent-done, not dropped)
test("laneFor: triage/done + no live worker → 'between-phases' (NOT recent-done, NOT dropped)", () => {
  // deriveCurrentPhase surfaces a terminal-intermediate triage as phase:"triage".
  const ticket = { workerStatus: null, activeState: null, phase: "triage" };
  expect(laneFor(ticket)).toBe("between-phases");
});

test("laneFor: verify/done + no live worker → 'between-phases' (a mid-pipeline terminal is idle, not done)", () => {
  expect(laneFor({ workerStatus: null, activeState: null, phase: "verify" })).toBe("between-phases");
});

test("laneFor: a DEAD-but-running worker's ticket → 'between-phases', never 'live'", () => {
  // A dead worker is stripped from inFlightTickets, so its ticket has workerStatus
  // null; even if a stale activeState leaked through, a "dead" worker is not live.
  expect(laneFor({ workerStatus: "running", activeState: "dead", phase: "plan" })).toBe("between-phases");
});

test("laneFor: a LIVE worker (active/stuck) → 'live'", () => {
  expect(laneFor({ workerStatus: "running", activeState: "active", phase: "implement" })).toBe("live");
  expect(laneFor({ workerStatus: "running", activeState: "stuck", phase: "implement" })).toBe("live");
});

test("laneFor: only the synthetic pipeline-done phase is 'recent-done'", () => {
  expect(laneFor({ workerStatus: null, activeState: null, phase: PIPELINE_DONE_PHASE })).toBe("recent-done");
  expect(PIPELINE_DONE_PHASE).toBe("done");
});

// ── SCENARIO: every non-terminal ticket is in EXACTLY one lane ───────────────────
test("laneFor: every ticket lands in exactly one of live | between-phases | recent-done", () => {
  const tickets: LaneTicket[] = [
    { workerStatus: "running", activeState: "active", phase: "implement" }, // live
    { workerStatus: "running", activeState: "dead", phase: "plan" },         // between-phases (dead)
    { workerStatus: null, activeState: null, phase: "triage" },              // between-phases (idle)
    { workerStatus: null, activeState: null, phase: "research" },            // between-phases (idle)
    { workerStatus: null, activeState: null, phase: "done" },                // recent-done
  ];
  const lanes = tickets.map(laneFor);
  const valid = new Set(["live", "between-phases", "recent-done"]);
  for (const l of lanes) expect(valid.has(l)).toBe(true);
  // partition is total: live(1) + between(3) + done(1) = 5, none dropped
  expect(lanes.filter((l) => l === "live").length).toBe(1);
  expect(lanes.filter((l) => l === "between-phases").length).toBe(3);
  expect(lanes.filter((l) => l === "recent-done").length).toBe(1);
});
