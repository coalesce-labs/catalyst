// turn-zero-gate.test.mjs — CTL-932: the wedged-never-started turn-zero gate.
//
// A `claude --bg` worker can register but never resolve its slash-command
// prompt ("Unknown command: /catalyst-dev:phase-*"): it idles forever at an
// empty input prompt, holding a concurrency slot. Detection facts (2026-06-09
// incident, 6/6 slots starved for up to 10.4h):
//   • NO transcript file ever appears for the session (a healthy session
//     creates one ~0.3s after its first turn — session-recency.mjs resolver);
//   • `claude agents --json` lists it with state === "blocked";
//   • ~/.claude/jobs/<id>/state.json self-reports tempo:"blocked" with
//     detail/needs fields (previously never read by statJob).
//
// The gate runs inside reclaimDeadWorkIfPossible's alive branch: a running-
// signal worker past CATALYST_NEVER_STARTED_MS (default 120s) with NO
// transcript AND a FRESH agents-snapshot state of "blocked" is classified
// wedged-never-started → capture `claude logs`, stop, flip the signal through
// the normal revive/redispatch path; after 2 ineffective replacement attempts
// (tracked durably in the worker dir) escalate needs-human instead of looping.
//
// Run: cd plugins/dev/scripts/execution-core && bun test turn-zero-gate.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reclaimDeadWorkIfPossible,
  defaultStatJob,
  defaultReadNeverStartedAttempts,
  defaultRecordNeverStartedAttempt,
  neverStartedAttemptsPath,
  defaultAppendWedgedNeverStartedEvent,
} from "./recovery.mjs";
import { claudeLogs, agentStateForShortId } from "./claude-agents.mjs";

// Frozen clock — all tests pin `now` so no wall-clock leaks in.
const NOW = Date.parse("2026-06-09T18:35:00Z");

// The CTL-722 fixture: dispatched 9h ago, bg job f377750c…, signal running.
const BG_JOB_ID = "f377750c-aaaa-bbbb-cccc-dddddddddddd";
const SHORT_ID = "f377750c";
const SESSION_UUID = "11111111-2222-3333-4444-555555555555";
const NINE_H_AGO = new Date(NOW - 9 * 60 * 60_000).toISOString();

const WEDGE_LOGS =
  "⏺ Unknown command: /catalyst-dev:phase-plan\n" +
  "⏺ Args from unknown skill: CTL-722 --orch-dir /Users/x/catalyst/runs/r\n" +
  "⏵⏵ bypass permissions on · Ctx: 0";

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl932-turn-zero-"));
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

function recorder(returnValue) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return typeof returnValue === "function" ? returnValue(...args) : returnValue;
  };
  fn.calls = calls;
  return fn;
}

function wedgedSignal({
  ticket = "CTL-722",
  phase = "implement",
  status = "running",
  bgJobId = BG_JOB_ID,
  startedAt = NINE_H_AGO,
} = {}) {
  return {
    ticket,
    phase,
    status,
    liveness: { kind: "bg", value: bgJobId },
    signalPath: join(orchDir, "workers", ticket, `phase-${phase}.json`),
    raw: {
      ticket,
      phase,
      orchestrator: ticket,
      status,
      bg_job_id: bgJobId,
      startedAt,
      updatedAt: startedAt,
    },
  };
}

// The wedged worker's state.json self-report (the fields statJob now parses).
const wedgedStatJob = () => ({
  exists: true,
  mtimeMs: NOW - 9 * 60 * 60_000 + 45_000, // frozen ≤60s after spawn
  state: "working",
  firstTerminalAt: null,
  tempo: "blocked",
  detail: "stuck on a startup dialog",
  needs: "open this session to continue setup",
});

// Fresh agents snapshot listing the worker as kind=background state=blocked.
const blockedSnapshot = () => ({
  agents: [
    {
      sessionId: BG_JOB_ID,
      kind: "background",
      status: "idle",
      state: "blocked",
    },
  ],
  isFresh: true,
  ageMs: 1_000,
});

// Common seams for the gate tests. Every side effect is an injected spy; the
// committed-work probe defaults to false (a never-started worker has no work).
function gateSeams(overrides = {}) {
  return {
    repoRoot: "/repo",
    statJob: wedgedStatJob,
    probes: { implement: recorder(false) },
    emitComplete: recorder({ code: 0 }),
    appendEvent: recorder(undefined),
    appendReviveEvent: recorder(true),
    appendEscalatedEvent: recorder(true),
    reviveDispatch: recorder({ code: 0 }),
    applyStalledLabel: recorder({ applied: true }),
    killBgJob: recorder(undefined),
    countReviveEvents: recorder(0),
    writeReviveMarker: recorder(undefined),
    resolveSession: () => SESSION_UUID,
    postReclaimMirror: () => {},
    emitReapIntent: () => Promise.resolve(),
    agentsSnapshot: blockedSnapshot,
    transcriptExists: () => false,
    captureWedgeLogs: recorder(WEDGE_LOGS),
    appendWedgedEvent: recorder(true),
    inEscalationCooldownFn: () => false,
    recordEscalationFn: recorder(undefined),
    progressMark: () => 0,
    readProgressMark: () => -1,
    writeProgressMark: recorder(undefined),
    now: () => NOW,
    ...overrides,
  };
}

describe("turn-zero gate — wedged-never-started detection (CTL-932)", () => {
  test("(1) CTL-722 fixture: running 9h, blocked in fresh snapshot, no transcript → stop + redispatch flip + wedged event carrying the captured logs", () => {
    const seams = gateSeams();
    const r = reclaimDeadWorkIfPossible(orchDir, wedgedSignal(), seams);

    expect(r).toBe("wedged-redispatched");
    // committed-work probe ran BEFORE the kill (the invariant).
    expect(seams.probes.implement.calls.length).toBe(1);
    // the session was stopped…
    expect(seams.killBgJob.calls.length).toBe(1);
    expect(seams.killBgJob.calls[0][0]).toEqual({ bgJobId: BG_JOB_ID });
    // …and the signal flipped through the normal revive/redispatch path.
    expect(seams.reviveDispatch.calls.length).toBe(1);
    expect(seams.reviveDispatch.calls[0][0]).toMatchObject({
      orchDir,
      ticket: "CTL-722",
      phase: "implement",
    });
    // the escalation event carries the captured `claude logs` text.
    expect(seams.appendWedgedEvent.calls.length).toBe(1);
    const evt = seams.appendWedgedEvent.calls[0][0];
    expect(evt.ticket).toBe("CTL-722");
    expect(evt.phase).toBe("implement");
    expect(evt.attempt).toBe(1);
    expect(evt.bg_job_id).toBe(BG_JOB_ID);
    expect(evt.captured_logs).toContain("Unknown command: /catalyst-dev:phase-plan");
    // the kill happened AFTER the logs capture (stop destroys the screen buffer).
    expect(seams.captureWedgeLogs.calls.length).toBe(1);
    // the attempt count is tracked durably in the worker dir.
    const attempts = defaultReadNeverStartedAttempts(orchDir, "CTL-722", "implement");
    expect(attempts.count).toBe(1);
    expect(attempts.captures.length).toBe(1);
    expect(attempts.captures[0]).toContain("Unknown command");
  });

  test("(2) healthy worker (transcript exists) → untouched (alive-suppressed, no stop, no event)", () => {
    const seams = gateSeams({ transcriptExists: () => true });
    // 10 min old: past the 120s gate threshold but below the 6h busy ceiling,
    // so "untouched" is observable as a clean alive-suppressed.
    const sig = wedgedSignal({ startedAt: new Date(NOW - 10 * 60_000).toISOString() });
    const r = reclaimDeadWorkIfPossible(orchDir, sig, seams);
    expect(r).toBe("alive-suppressed");
    expect(seams.killBgJob.calls.length).toBe(0);
    expect(seams.reviveDispatch.calls.length).toBe(0);
    expect(seams.appendWedgedEvent.calls.length).toBe(0);
  });

  test("(3) young worker (<120s since dispatch) → untouched, snapshot never consulted by the gate", () => {
    let snapCalls = 0;
    const seams = gateSeams({
      agentsSnapshot: () => {
        snapCalls++;
        return blockedSnapshot();
      },
    });
    const sig = wedgedSignal({ startedAt: new Date(NOW - 60_000).toISOString() });
    const r = reclaimDeadWorkIfPossible(orchDir, sig, seams);
    expect(r).toBe("alive-suppressed");
    // 60s < 120s gate threshold AND < 90s ghost grace → no snapshot read at all.
    expect(snapCalls).toBe(0);
    expect(seams.killBgJob.calls.length).toBe(0);
    expect(seams.appendWedgedEvent.calls.length).toBe(0);
  });

  test("(4) dead job (dir gone) → existing dead/revive path unchanged, gate silent", () => {
    const seams = gateSeams({ statJob: () => null });
    const r = reclaimDeadWorkIfPossible(orchDir, wedgedSignal(), seams);
    // branch (C): work not done, first death → normal revive. The gate's seams
    // (logs capture / wedged event) never fire on a dead worker.
    expect(r).toBe("revived");
    expect(seams.captureWedgeLogs.calls.length).toBe(0);
    expect(seams.appendWedgedEvent.calls.length).toBe(0);
  });

  test("(5) attempt cap: 2 prior ineffective replacements → needs-human escalation instead of a third redispatch", () => {
    defaultRecordNeverStartedAttempt(orchDir, "CTL-722", "implement", "capture-1");
    defaultRecordNeverStartedAttempt(orchDir, "CTL-722", "implement", "capture-2");
    const seams = gateSeams();
    const r = reclaimDeadWorkIfPossible(orchDir, wedgedSignal(), seams);

    expect(r).toBe("escalated");
    // no third replacement — the loop stops.
    expect(seams.reviveDispatch.calls.length).toBe(0);
    // needs-human applied via the escalation path.
    expect(seams.applyStalledLabel.calls.length).toBe(1);
    expect(seams.appendEscalatedEvent.calls.length).toBe(1);
    const esc = seams.appendEscalatedEvent.calls[0][0];
    expect(esc.reason).toBe("wedged-never-started-exhausted");
    // the escalation carries the screen captures from ALL attempts.
    const allLogs = JSON.stringify(esc);
    expect(allLogs).toContain("capture-1");
    expect(allLogs).toContain("capture-2");
    expect(allLogs).toContain("Unknown command");
    // the wedged corpse is still stopped (it holds a slot).
    expect(seams.killBgJob.calls.length).toBe(1);
  });

  test("stale snapshot → gate is a no-op (only a FRESH blocked verdict counts)", () => {
    const seams = gateSeams({
      agentsSnapshot: () => ({ agents: [], isFresh: false, ageMs: Infinity }),
      // keep the CTL-868 zombie mtime floor out of the picture: recent mtime.
      statJob: () => ({ ...wedgedStatJob(), mtimeMs: NOW - 60_000 }),
    });
    // 10 min old: past the gate threshold, below the busy ceiling.
    const sig = wedgedSignal({ startedAt: new Date(NOW - 10 * 60_000).toISOString() });
    const r = reclaimDeadWorkIfPossible(orchDir, sig, seams);
    expect(r).toBe("alive-suppressed");
    expect(seams.killBgJob.calls.length).toBe(0);
    expect(seams.appendWedgedEvent.calls.length).toBe(0);
  });

  test("snapshot state not 'blocked' (live running session) → gate is a no-op", () => {
    const seams = gateSeams({
      agentsSnapshot: () => ({
        agents: [
          { sessionId: BG_JOB_ID, kind: "background", status: "active", state: "running" },
        ],
        isFresh: true,
        ageMs: 1_000,
      }),
      // < busy ceiling so the busy-ceiling escalation stays out of the picture.
      now: () => Date.parse(NINE_H_AGO) + 10 * 60_000,
    });
    const r = reclaimDeadWorkIfPossible(orchDir, wedgedSignal(), seams);
    expect(r).toBe("alive-suppressed");
    expect(seams.killBgJob.calls.length).toBe(0);
    expect(seams.appendWedgedEvent.calls.length).toBe(0);
  });

  test("committed-work probe passes → NEVER killed by the gate (existing paths own it)", () => {
    const probe = recorder(true);
    const seams = gateSeams({
      probes: { implement: probe },
      now: () => Date.parse(NINE_H_AGO) + 10 * 60_000, // < busy ceiling
    });
    const r = reclaimDeadWorkIfPossible(orchDir, wedgedSignal(), seams);
    expect(r).toBe("alive-suppressed");
    expect(probe.calls.length).toBe(1); // probe ran before any kill decision
    expect(seams.killBgJob.calls.length).toBe(0);
    expect(seams.appendWedgedEvent.calls.length).toBe(0);
  });
});

describe("durable attempt tracking — worker-dir marker (CTL-932)", () => {
  test("read returns {count: 0, captures: []} when no marker exists", () => {
    expect(defaultReadNeverStartedAttempts(orchDir, "CTL-1", "plan")).toEqual({
      count: 0,
      captures: [],
    });
  });

  test("record increments count and retains truncated captures", () => {
    defaultRecordNeverStartedAttempt(orchDir, "CTL-1", "plan", "first screen");
    defaultRecordNeverStartedAttempt(orchDir, "CTL-1", "plan", "second screen");
    const a = defaultReadNeverStartedAttempts(orchDir, "CTL-1", "plan");
    expect(a.count).toBe(2);
    expect(a.captures).toEqual(["first screen", "second screen"]);
  });

  test("marker is per-(ticket, phase) under the worker dir", () => {
    const p = neverStartedAttemptsPath(orchDir, "CTL-1", "plan");
    expect(p).toBe(join(orchDir, "workers", "CTL-1", ".never-started-plan.json"));
    defaultRecordNeverStartedAttempt(orchDir, "CTL-1", "plan", "x");
    expect(JSON.parse(readFileSync(p, "utf8")).count).toBe(1);
  });

  test("corrupt marker fails open to zero attempts", () => {
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true });
    writeFileSync(neverStartedAttemptsPath(orchDir, "CTL-1", "plan"), "not json");
    expect(defaultReadNeverStartedAttempts(orchDir, "CTL-1", "plan")).toEqual({
      count: 0,
      captures: [],
    });
  });
});

describe("defaultStatJob — tempo/detail/needs observability (CTL-932)", () => {
  let jobsRoot;
  let prevEnv;
  beforeEach(() => {
    jobsRoot = mkdtempSync(join(tmpdir(), "ctl932-jobs-"));
    prevEnv = process.env.CATALYST_HEALTHCHECK_JOBS_ROOT;
    process.env.CATALYST_HEALTHCHECK_JOBS_ROOT = jobsRoot;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CATALYST_HEALTHCHECK_JOBS_ROOT;
    else process.env.CATALYST_HEALTHCHECK_JOBS_ROOT = prevEnv;
    rmSync(jobsRoot, { recursive: true, force: true });
  });

  test("parses tempo, detail, and needs alongside state/firstTerminalAt", () => {
    mkdirSync(join(jobsRoot, "job-1"), { recursive: true });
    writeFileSync(
      join(jobsRoot, "job-1", "state.json"),
      JSON.stringify({
        state: "working",
        tempo: "blocked",
        detail: "stuck on a startup dialog",
        needs: "open this session to continue setup",
      }),
    );
    const job = defaultStatJob("job-1");
    expect(job.state).toBe("working");
    expect(job.tempo).toBe("blocked");
    expect(job.detail).toBe("stuck on a startup dialog");
    expect(job.needs).toBe("open this session to continue setup");
  });

  test("absent fields default to null (back-compat with old schemas)", () => {
    mkdirSync(join(jobsRoot, "job-2"), { recursive: true });
    writeFileSync(join(jobsRoot, "job-2", "state.json"), JSON.stringify({ state: "working" }));
    const job = defaultStatJob("job-2");
    expect(job.tempo).toBeNull();
    expect(job.detail).toBeNull();
    expect(job.needs).toBeNull();
  });
});

describe("agentStateForShortId — the snapshot's .state field (CTL-932)", () => {
  const agents = [
    { sessionId: BG_JOB_ID, kind: "background", status: "idle", state: "blocked" },
    { sessionId: "deadbeef-0000-0000-0000-000000000000", kind: "background", state: "running" },
  ];

  test("returns the matched agent's state", () => {
    expect(agentStateForShortId(SHORT_ID, agents)).toBe("blocked");
    expect(agentStateForShortId("deadbeef", agents)).toBe("running");
  });

  test("returns null when absent, when state missing, or on malformed input", () => {
    expect(agentStateForShortId("11223344", agents)).toBeNull();
    expect(agentStateForShortId(SHORT_ID, [{ sessionId: BG_JOB_ID }])).toBeNull();
    expect(agentStateForShortId(null, agents)).toBeNull();
    expect(agentStateForShortId(SHORT_ID, null)).toBeNull();
  });
});

describe("claudeLogs — screen capture for the escalation payload (CTL-932)", () => {
  test("invokes `claude logs <shortId>` and strips ANSI escapes", () => {
    const spawn = recorder({
      status: 0,
      stdout: "[1m⏺ Unknown command:[0m /catalyst-dev:phase-plan[2J",
      stderr: "",
    });
    const r = claudeLogs(SHORT_ID, { spawn });
    expect(r.ok).toBe(true);
    expect(spawn.calls[0][1]).toEqual(["logs", SHORT_ID]);
    expect(r.output).toBe("⏺ Unknown command: /catalyst-dev:phase-plan");
  });

  test("caps output length so the event payload stays bounded", () => {
    const spawn = recorder({ status: 0, stdout: "x".repeat(20_000), stderr: "" });
    const r = claudeLogs(SHORT_ID, { spawn });
    expect(r.ok).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(8_192);
  });

  test("returns ok:false (never throws) on rc!=0 or a spawn error", () => {
    expect(claudeLogs(SHORT_ID, { spawn: () => ({ status: 1, stdout: "", stderr: "no such job" }) }).ok).toBe(false);
    expect(claudeLogs(SHORT_ID, { spawn: () => { throw new Error("ENOENT"); } }).ok).toBe(false);
  });
});

describe("defaultAppendWedgedNeverStartedEvent — envelope round-trip (CTL-932)", () => {
  let envCatalystDir;
  let prevCatalystDir;
  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    envCatalystDir = mkdtempSync(join(tmpdir(), "ctl932-events-"));
    process.env.CATALYST_DIR = envCatalystDir;
    mkdirSync(join(envCatalystDir, "events"), { recursive: true });
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(envCatalystDir, { recursive: true, force: true });
  });

  test("writes phase.<phase>.wedged-never-started.<TICKET> with the captured logs in the payload", () => {
    const ok = defaultAppendWedgedNeverStartedEvent({
      phase: "plan",
      ticket: "CTL-722",
      orchId: "CTL-722",
      attempt: 1,
      bg_job_id: BG_JOB_ID,
      agents_state: "blocked",
      tempo: "blocked",
      detail: "stuck on a startup dialog",
      captured_logs: WEDGE_LOGS,
    });
    expect(ok).toBe(true);
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const lines = readFileSync(join(envCatalystDir, "events", `${ym}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean);
    const env = JSON.parse(lines[lines.length - 1]);
    expect(env.attributes["event.name"]).toBe("phase.plan.wedged-never-started.CTL-722");
    expect(env.attributes["event.action"]).toBe("wedged-never-started");
    expect(env.body.payload.captured_logs).toContain("Unknown command: /catalyst-dev:phase-plan");
    expect(env.body.payload.attempt).toBe(1);
    expect(env.body.payload.bg_job_id).toBe(BG_JOB_ID);
    expect(env.body.payload.agents_state).toBe("blocked");
  });
});
