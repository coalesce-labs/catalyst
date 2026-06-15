// reaper.test.mjs — Reaper reconciler unit tests (CTL-649 Phase 4).
// All executors are injected; no real claude / git invocations.
import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  Reaper,
  ticketFromCwd,
  groupBackgroundSessionsByTicket,
  CLEANUP_GRACE_MS,
  defaultAgents,
  defaultAssessWorktreeRemoval,
  defaultReadSignalBgJobId,
  isSweepReapableStatus,
} from "./reaper.mjs";
import {
  refreshAgents,
  getAgentsCached,
  resetLivenessCache,
} from "./claude-agents.mjs";

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function agentsFixture(rows = []) {
  return mock(() => Promise.resolve(rows));
}

beforeEach(() => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

// CTL-731 de-starvation: the reaper's default agent source must read through the
// warm, never-blocking getAgentsCached snapshot — NOT a synchronous
// execFileSync("claude agents --json") on the shared daemon loop (the starvation
// source). These lock in that defaultAgents delegates to the cached snapshot.
describe("defaultAgents (CTL-731 non-blocking agent source)", () => {
  beforeEach(() => resetLivenessCache());

  it("returns the warm getAgentsCached snapshot, never spawning synchronously", async () => {
    const rows = [
      { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", status: "idle", kind: "background" },
      { sessionId: "22222222-aaaa-bbbb-cccc-dddddddddddd", status: "busy", kind: "background" },
    ];
    // Populate the async snapshot via the same async seam the scheduler uses —
    // no real subprocess, and crucially no SYNC spawn.
    await refreshAgents({ execFileAsync: async () => JSON.stringify(rows) });

    const fromCache = getAgentsCached().agents;
    const fromReaper = await defaultAgents();

    expect(fromReaper).toEqual(rows);
    expect(fromReaper).toEqual(fromCache);
  });

  it("serves [] from a cold snapshot rather than blocking on a read", async () => {
    // Cold cache (just reset) → getter returns [] synchronously and only fires a
    // fire-and-forget refresh; defaultAgents must mirror that, never await a spawn.
    expect(await defaultAgents()).toEqual([]);
  });
});

describe("Reaper._handleBgReap", () => {
  it("consumes phase.yield.reap-requested and calls executorReap", async () => {
    const executor = mock(() => Promise.resolve({ ok: true }));
    const r = new Reaper({
      executorReap: executor,
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: "idle", cwd: "/wt/CTL-999" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({
      event: "phase.yield.reap-requested",
      bg_job_id: "abc12345",
      ticket: "CTL-999",
      phase: "implement",
    });
    expect(executor).toHaveBeenCalledWith("abc12345");
  });

  it("skips when bg_job_id is not in claude agents --json", async () => {
    const executor = mock();
    const r = new Reaper({
      executorReap: executor,
      agents: agentsFixture([]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "phase.yield.reap-requested", bg_job_id: "ghostgho" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("stops a busy/active session for an authoritative single-target intent (CTL-657)", async () => {
    // CTL-657: an authoritative intent (yield/predecessor/supersede/revive/abort)
    // is NOT idle-gated — a phase worker is almost always still busy finishing
    // its last turn when its reap is requested, and the producer already decided
    // it must die. Pre-CTL-657 the idle gate dropped the stop and never retried,
    // so the worker lingered forever (the 28GB pileup). `claude stop` works on a
    // busy session, so the executor MUST be invoked.
    const executor = mock(() => Promise.resolve({ ok: true }));
    const r = new Reaper({
      executorReap: executor,
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: "active", cwd: "/wt/x" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "phase.yield.reap-requested", bg_job_id: "abc12345" });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("never reaps the controlling session", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "abc12345-aaaa-bbbb-cccc-dddddddddddd";
    const executor = mock();
    const r = new Reaper({
      executorReap: executor,
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: "idle", cwd: "/wt/x" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "phase.yield.reap-requested", bg_job_id: "abc12345" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("emits *.reap-complete after successful executor call", async () => {
    const emitted = [];
    const r = new Reaper({
      executorReap: () => Promise.resolve({ ok: true }),
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: "idle", cwd: "/wt/x" },
      ]),
      emit: (evt, fields) => { emitted.push({ evt, fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.handle({ event: "phase.yield.reap-requested", bg_job_id: "abc12345" });
    expect(emitted.find((e) => e.evt === "phase.yield.reap-complete")).toBeTruthy();
  });

  it("emits *.reap-failed when executor returns non-ok", async () => {
    const emitted = [];
    const r = new Reaper({
      executorReap: () => Promise.resolve({ ok: false, error: "boom" }),
      // CTL-1165 D4: a non-ok stop now re-reads agents() and (since the target is
      // still listed) escalates to executorRmForce. Inject a fake so the test
      // never spawns a real `claude rm`; rm also no-ops → terminal reap-failed.
      executorRmForce: () => Promise.resolve({ ok: false, error: "rm boom" }),
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: "idle", cwd: "/wt/x" },
      ]),
      emit: (evt, fields) => { emitted.push({ evt, fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.handle({ event: "phase.yield.reap-requested", bg_job_id: "abc12345" });
    expect(emitted.find((e) => e.evt === "phase.yield.reap-failed")).toBeTruthy();
  });

  it("skips an interactive target (never reap a human window via protocol intent)", async () => {
    const executor = mock(() => Promise.resolve({ ok: true }));
    const r = new Reaper({
      executorReap: executor,
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: "idle", cwd: "/wt/x", kind: "interactive" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "phase.yield.reap-requested", bg_job_id: "abc12345" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("reaps a background target", async () => {
    const executor = mock(() => Promise.resolve({ ok: true }));
    const r = new Reaper({
      executorReap: executor,
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: "idle", cwd: "/wt/x", kind: "background" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "phase.yield.reap-requested", bg_job_id: "abc12345" });
    expect(executor).toHaveBeenCalledWith("abc12345");
  });

  it("routes phase.terminal.reap-requested to _handleBgReap (busy-OK, CTL-695)", async () => {
    // CTL-695: terminal-worker reap — must route to the single-target (busy-OK)
    // path, not the periodic orphan sweep or an unknown-handler warn.
    const executor = mock(() => Promise.resolve({ ok: true }));
    const emitted = [];
    const r = new Reaper({
      executorReap: executor,
      agents: agentsFixture([
        { sessionId: "abcd1234-aaaa-bbbb-cccc-dddddddddddd", status: "busy", kind: "background" },
      ]),
      emit: (evt, f) => { emitted.push({ evt, f }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.handle({ event: "phase.terminal.reap-requested", bg_job_id: "abcd1234", ticket: "CTL-695", phase: "monitor-deploy" });
    expect(executor).toHaveBeenCalled(); // reaped even though status==="busy"
    expect(emitted.find((e) => e.evt === "phase.terminal.reap-complete")).toBeTruthy();
  });

  it("reaps an unknown-kind target (avoids regressing the leak fix if claude omits .kind)", async () => {
    const executor = mock(() => Promise.resolve({ ok: true }));
    const r = new Reaper({
      executorReap: executor,
      agents: agentsFixture([
        // No `kind` field — an explicit protocol intent still reaps it.
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: "idle", cwd: "/wt/x" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "phase.yield.reap-requested", bg_job_id: "abc12345" });
    expect(executor).toHaveBeenCalledWith("abc12345");
  });

  it("includeInteractive:true reaps an interactive target via protocol intent", async () => {
    const executor = mock(() => Promise.resolve({ ok: true }));
    const r = new Reaper({
      includeInteractive: true,
      executorReap: executor,
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: "idle", cwd: "/wt/x", kind: "interactive" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "phase.yield.reap-requested", bg_job_id: "abc12345" });
    expect(executor).toHaveBeenCalledWith("abc12345");
  });

  it("dedupes back-to-back intents on the same bg_job_id", async () => {
    const executor = mock(() => Promise.resolve({ ok: true }));
    const r = new Reaper({
      executorReap: executor,
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: "idle", cwd: "/wt/x" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "phase.yield.reap-requested", bg_job_id: "abc12345" });
    await r.handle({ event: "phase.yield.reap-requested", bg_job_id: "abc12345" });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  // ─── CTL-1165 D4: claude stop → claude rm escalation for stuck registrations ──
  // On mini, 6 reboot-survivor `status:null` sessions no-op'd `claude stop`. When
  // stop fails AND a fresh agents() re-read still lists the same shortId, escalate
  // to `claude rm <shortId>`. If rm also no-ops, emit *.reap-failed reason
  // stop-and-rm-noop ONCE (the handle() de-dupe drops a re-delivered identical event).
  it("escalates to `claude rm` when stop is non-ok and the session is still registered", async () => {
    const executorReap = mock(() => Promise.resolve({ ok: false, error: "background service may be restarting" }));
    const executorRmForce = mock(() => Promise.resolve({ ok: true }));
    const r = new Reaper({
      executorReap,
      executorRmForce,
      // agents() lists the target on BOTH the initial find AND the post-stop re-read.
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: null, cwd: "/wt/x", kind: "background" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "phase.abort.reap-requested", bg_job_id: "abc12345" });
    expect(executorReap).toHaveBeenCalledTimes(1);
    expect(executorReap).toHaveBeenCalledWith("abc12345");
    expect(executorRmForce).toHaveBeenCalledTimes(1);
    expect(executorRmForce).toHaveBeenCalledWith("abc12345");
  });

  it("does NOT escalate to `claude rm` when stop succeeds (emits reap-complete)", async () => {
    const executorReap = mock(() => Promise.resolve({ ok: true }));
    const executorRmForce = mock(() => Promise.resolve({ ok: true }));
    const emitted = [];
    const r = new Reaper({
      executorReap,
      executorRmForce,
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: null, cwd: "/wt/x", kind: "background" },
      ]),
      emit: (evt, fields) => { emitted.push({ evt, fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.handle({ event: "phase.abort.reap-requested", bg_job_id: "abc12345" });
    expect(executorRmForce).not.toHaveBeenCalled();
    expect(emitted.find((e) => e.evt === "phase.abort.reap-complete")).toBeTruthy();
  });

  it("does NOT escalate when stop fails but a fresh re-read shows the session gone", async () => {
    // stop returned non-ok but the session disappeared from the re-read → nothing
    // to rm; surface reap-failed without an rm call (next tick is a no-op).
    let call = 0;
    const executorReap = mock(() => Promise.resolve({ ok: false, error: "rc=1" }));
    const executorRmForce = mock(() => Promise.resolve({ ok: true }));
    const r = new Reaper({
      executorReap,
      executorRmForce,
      // First agents() (the find) lists the target; the post-stop re-read is empty.
      agents: mock(() => {
        call += 1;
        return Promise.resolve(
          call === 1
            ? [{ sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: null, cwd: "/wt/x", kind: "background" }]
            : [],
        );
      }),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "phase.abort.reap-requested", bg_job_id: "abc12345" });
    expect(executorRmForce).not.toHaveBeenCalled();
  });

  it("stop-noop then rm-noop logs + emits reap-failed reason stop-and-rm-noop ONCE (no loop)", async () => {
    const executorReap = mock(() => Promise.resolve({ ok: false, error: "stop noop" }));
    const executorRmForce = mock(() => Promise.resolve({ ok: false, error: "rm noop" }));
    const emitted = [];
    const warns = [];
    const logger = { info: () => {}, warn: (o) => warns.push(o), error: () => {} };
    const r = new Reaper({
      executorReap,
      executorRmForce,
      // The stuck session is listed on every agents() read.
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: null, cwd: "/wt/x", kind: "background" },
      ]),
      emit: (evt, fields) => { emitted.push({ evt, fields }); return Promise.resolve(); },
      log: logger,
    });
    const ev = { event: "phase.abort.reap-requested", bg_job_id: "abc12345" };
    await r.handle(ev);
    const failed = emitted.filter((e) => e.evt === "phase.abort.reap-failed");
    expect(failed.length).toBe(1);
    expect(failed[0].fields.reason).toBe("stop-and-rm-noop");
    expect(warns.length).toBe(1);
    // A second identical handle() is dropped by the per-event de-dupe — no loop.
    await r.handle(ev);
    expect(executorReap).toHaveBeenCalledTimes(1);
    expect(executorRmForce).toHaveBeenCalledTimes(1);
    expect(emitted.filter((e) => e.evt === "phase.abort.reap-failed").length).toBe(1);
  });
});

describe("Reaper._handleWorktreePresweep", () => {
  it("stops every idle session whose cwd is under the worktree", async () => {
    const stopped = [];
    const r = new Reaper({
      executorReap: (id) => { stopped.push(id); return Promise.resolve({ ok: true }); },
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/CTL-1", status: "idle" },
        { sessionId: "22222222-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/CTL-1/sub", status: "idle" },
        { sessionId: "33333333-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/CTL-2", status: "idle" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "worktree.presweep.reap-requested", worktree_path: "/wt/CTL-1" });
    expect(stopped.sort()).toEqual(["11111111", "22222222"]);
  });

  it("skips active sessions in the worktree", async () => {
    const stopped = [];
    const r = new Reaper({
      executorReap: (id) => { stopped.push(id); return Promise.resolve({ ok: true }); },
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/x", status: "active" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "worktree.presweep.reap-requested", worktree_path: "/wt/x" });
    expect(stopped).toEqual([]);
  });

  it("does not stop a sibling whose path only shares a prefix (CTL-64 vs CTL-649)", async () => {
    const stopped = [];
    const r = new Reaper({
      executorReap: (id) => { stopped.push(id); return Promise.resolve({ ok: true }); },
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/CTL-64", status: "idle" },
        { sessionId: "22222222-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/CTL-649", status: "idle" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "worktree.presweep.reap-requested", worktree_path: "/wt/CTL-64" });
    // Only the exact-match worktree is swept; the sibling /wt/CTL-649 is safe.
    expect(stopped).toEqual(["11111111"]);
  });

  it("counts an interactive session as unstoppable and does not stop it", async () => {
    const stopped = [];
    const r = new Reaper({
      executorReap: (id) => { stopped.push(id); return Promise.resolve({ ok: true }); },
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/x", status: "idle", kind: "interactive" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    // _handleWorktreePresweep returns the count of still-live (unstoppable)
    // sessions so a downstream worktree-remove refuses.
    const unstoppable = await r._handleWorktreePresweep({ worktree_path: "/wt/x" });
    expect(stopped).toEqual([]);
    expect(unstoppable).toBe(1);
  });

  it("normalizes a trailing slash on the worktree path", async () => {
    const stopped = [];
    const r = new Reaper({
      executorReap: (id) => { stopped.push(id); return Promise.resolve({ ok: true }); },
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/CTL-1", status: "idle" },
        { sessionId: "22222222-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/CTL-1/sub", status: "idle" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "worktree.presweep.reap-requested", worktree_path: "/wt/CTL-1/" });
    expect(stopped.sort()).toEqual(["11111111", "22222222"]);
  });
});

describe("Reaper._handlePrMergedCleanup", () => {
  it("presweeps, removes worktree, deletes branch — in that order", async () => {
    const trace = [];
    const r = new Reaper({
      executorReap: (id) => { trace.push(["reap", id]); return Promise.resolve({ ok: true }); },
      agents: agentsFixture([]),
      assessWorktreeRemoval: async () => ({ safe: true, reasons: [] }), // CTL-791: gate satisfied
      archiveWorktree: () => ({ ok: true }),
      gitWorktreeRemove: (p) => { trace.push(["wt", p]); return Promise.resolve({ ok: true }); },
      gitBranchDelete: (b, force) => { trace.push(["br", b, force]); return Promise.resolve({ ok: true }); },
      emit: (evt) => { trace.push(["emit", evt]); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.handle({
      event: "pr.merged.cleanup-requested",
      ticket: "CTL-1",
      worktree_path: "/wt/CTL-1",
      branch: "ryan/ctl-1",
    });
    // No `force` on the event → non-force branch delete (false).
    expect(trace).toEqual([
      ["wt", "/wt/CTL-1"],
      ["br", "ryan/ctl-1", false],
      ["emit", "pr.merged.cleanup-complete"],
    ]);
  });

  it("forwards force=true to gitBranchDelete only when event.force is set", async () => {
    const calls = [];
    const r = new Reaper({
      executorReap: () => Promise.resolve({ ok: true }),
      agents: agentsFixture([]),
      assessWorktreeRemoval: async () => ({ safe: true, reasons: [] }), // CTL-791: gate satisfied
      archiveWorktree: () => ({ ok: true }),
      gitWorktreeRemove: () => Promise.resolve({ ok: true }),
      gitBranchDelete: (b, force) => { calls.push({ b, force }); return Promise.resolve({ ok: true }); },
      emit: () => Promise.resolve(),
      log: silentLog(),
    });
    await r.handle({
      event: "pr.merged.cleanup-requested",
      ticket: "CTL-1",
      worktree_path: "/wt/CTL-1",
      branch: "ryan/ctl-1",
      force: true,
    });
    expect(calls).toEqual([{ b: "ryan/ctl-1", force: true }]);
  });

  it("reflects branch-delete failure in cleanup-complete (no silent clean complete)", async () => {
    const emitted = [];
    const r = new Reaper({
      executorReap: () => Promise.resolve({ ok: true }),
      agents: agentsFixture([]),
      assessWorktreeRemoval: async () => ({ safe: true, reasons: [] }), // CTL-791: gate satisfied
      archiveWorktree: () => ({ ok: true }),
      gitWorktreeRemove: () => Promise.resolve({ ok: true }),
      // Non-force `-d` refuses an unmerged branch.
      gitBranchDelete: () => Promise.resolve({ ok: false, error: "not fully merged" }),
      emit: (evt, fields) => { emitted.push({ evt, fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.handle({
      event: "pr.merged.cleanup-requested",
      ticket: "CTL-1",
      worktree_path: "/wt/CTL-1",
      branch: "ryan/ctl-1",
      // closed/abandoned → no force → unmerged commits preserved.
    });
    const complete = emitted.find((e) => e.evt === "pr.merged.cleanup-complete");
    expect(complete).toBeTruthy();
    expect(complete.fields.branchDeleted).toBe(false);
    expect(complete.fields.branchDeleteError).toBe("not fully merged");
  });

  it("emits cleanup-failed when worktree-remove returns non-ok", async () => {
    const emitted = [];
    const r = new Reaper({
      executorReap: () => Promise.resolve({ ok: true }),
      agents: agentsFixture([]),
      gitWorktreeRemove: () => Promise.resolve({ ok: false, error: "dirty" }),
      gitBranchDelete: mock(),
      emit: (evt) => { emitted.push(evt); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.handle({
      event: "pr.merged.cleanup-requested",
      ticket: "CTL-1",
      worktree_path: "/wt/CTL-1",
      branch: "ryan/ctl-1",
    });
    expect(emitted).toContain("pr.merged.cleanup-failed");
  });

  it("skips worktree-remove and emits cleanup-failed when a non-idle session remains under the path", async () => {
    const wtRemove = mock(() => Promise.resolve({ ok: true }));
    const emitted = [];
    const r = new Reaper({
      // An active session can't be stopped (CTL-619 gate) → stays live.
      executorReap: mock(() => Promise.resolve({ ok: true })),
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/CTL-1", status: "active" },
      ]),
      gitWorktreeRemove: wtRemove,
      gitBranchDelete: mock(() => Promise.resolve({ ok: true })),
      emit: (evt, fields) => { emitted.push({ evt, fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.handle({
      event: "pr.merged.cleanup-requested",
      ticket: "CTL-1",
      worktree_path: "/wt/CTL-1",
      branch: "ryan/ctl-1",
    });
    expect(wtRemove).not.toHaveBeenCalled();
    const failed = emitted.find((e) => e.evt === "pr.merged.cleanup-failed");
    expect(failed).toBeTruthy();
    expect(failed.fields.reason).toBe("sessions-still-live");
  });

  it("does not sweep a sibling worktree sharing a path prefix (/wt/CTL-64 vs /wt/CTL-649)", async () => {
    const stopped = [];
    const wtRemove = mock(() => Promise.resolve({ ok: true }));
    const r = new Reaper({
      executorReap: (id) => { stopped.push(id); return Promise.resolve({ ok: true }); },
      // Idle session lives in the *sibling* /wt/CTL-649, not the target /wt/CTL-64.
      agents: agentsFixture([
        { sessionId: "99999999-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/CTL-649", status: "idle" },
      ]),
      assessWorktreeRemoval: async () => ({ safe: true, reasons: [] }), // CTL-791: gate satisfied
      archiveWorktree: () => ({ ok: true }),
      gitWorktreeRemove: wtRemove,
      gitBranchDelete: () => Promise.resolve({ ok: true }),
      emit: () => Promise.resolve(),
      log: silentLog(),
    });
    await r.handle({
      event: "pr.merged.cleanup-requested",
      ticket: "CTL-64",
      worktree_path: "/wt/CTL-64",
      branch: "CTL-64",
    });
    // Sibling session untouched, and cleanup proceeds for the real target.
    expect(stopped).toEqual([]);
    expect(wtRemove).toHaveBeenCalled();
  });

  it("CTL-791: defaultAssessWorktreeRemoval is FAIL-CLOSED on a failed `claude agents` read (agents-stale)", async () => {
    // The production seam must NOT treat an unreadable/cold fleet as empty: a
    // failed read ({ ok:false }) → agents-stale → unsafe (never a false no-session).
    const verdict = await defaultAssessWorktreeRemoval(
      { worktree_path: "/nonexistent/wt/CTL-1", ticket: "CTL-1", branch: "b", force: true },
      () => ({ agents: [], ok: false }), // injected failed read
    );
    expect(verdict.safe).toBe(false);
    expect(verdict.reasons).toContain("agents-stale");
  });

  it("CTL-791: an UNSAFE gate verdict DEFERS — no worktree remove, no branch delete, emits cleanup-deferred + failed", async () => {
    const wtRemove = mock(() => Promise.resolve({ ok: true }));
    const brDelete = mock(() => Promise.resolve({ ok: true }));
    const emitted = [];
    const r = new Reaper({
      executorReap: () => Promise.resolve({ ok: true }),
      agents: agentsFixture([]),
      assessWorktreeRemoval: async () => ({ safe: false, reasons: ["dirty-worktree", "unknown-provenance"] }),
      archiveWorktree: () => ({ ok: true }),
      gitWorktreeRemove: wtRemove,
      gitBranchDelete: brDelete,
      emit: (evt, fields) => { emitted.push({ evt, fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.handle({
      event: "pr.merged.cleanup-requested",
      ticket: "CTL-1",
      worktree_path: "/wt/CTL-1",
      branch: "ryan/ctl-1",
      force: true,
    });
    expect(wtRemove).not.toHaveBeenCalled();
    expect(brDelete).not.toHaveBeenCalled();
    expect(emitted.find((e) => e.evt === "worktree.cleanup-deferred")).toBeTruthy();
    expect(emitted.find((e) => e.evt === "pr.merged.cleanup-failed")).toBeTruthy();
  });
});

describe("Reaper.scanOrphans", () => {
  it("emits phase.abort.reap-requested for sessions with missing cwd", async () => {
    const emitted = [];
    const r = new Reaper({
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/missing", status: "idle", kind: "background" },
        { sessionId: "22222222-aaaa-bbbb-cccc-dddddddddddd", cwd: "/tmp", status: "idle", kind: "background" },
      ]),
      cwdExists: (p) => Promise.resolve(p === "/tmp"),
      lastSeenMs: () => null, // no transcript → does not block reaping
      emit: (evt, fields) => { emitted.push({ evt, ...fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.scanOrphans();
    expect(emitted.length).toBe(1);
    expect(emitted[0].evt).toBe("phase.abort.reap-requested");
    expect(emitted[0].bgJobId).toBe("11111111");
    expect(emitted[0].reason).toBe("orphan-cwd-missing");
  });

  it("never emits for the controlling session even if cwd is missing", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "11111111-aaaa-bbbb-cccc-dddddddddddd";
    const emitted = [];
    const r = new Reaper({
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/missing", status: "idle", kind: "background" },
      ]),
      cwdExists: () => Promise.resolve(false),
      lastSeenMs: () => null,
      emit: (evt) => { emitted.push(evt); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.scanOrphans();
    expect(emitted.length).toBe(0);
  });

  it("skips an interactive cwd-missing session (never auto-reap a human window)", async () => {
    const emitted = [];
    const r = new Reaper({
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/missing", status: "idle", kind: "interactive" },
      ]),
      cwdExists: () => Promise.resolve(false),
      lastSeenMs: () => null,
      emit: (evt) => { emitted.push(evt); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.scanOrphans();
    expect(emitted.length).toBe(0);
  });

  it("skips an unknown/null-kind cwd-missing session (never auto-reap an ambiguous session)", async () => {
    const emitted = [];
    const r = new Reaper({
      agents: agentsFixture([
        // No `kind` field at all — ambiguous, must not be auto-reaped.
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/missing", status: "idle" },
      ]),
      cwdExists: () => Promise.resolve(false),
      lastSeenMs: () => null,
      emit: (evt) => { emitted.push(evt); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.scanOrphans();
    expect(emitted.length).toBe(0);
  });

  it("skips a recently-active background orphan (lastSeenMs < minIdleMs)", async () => {
    const emitted = [];
    const r = new Reaper({
      minIdleMs: 15 * 60 * 1000,
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/missing", status: "idle", kind: "background" },
      ]),
      cwdExists: () => Promise.resolve(false),
      lastSeenMs: () => 60_000, // touched 1 min ago — still in use
      emit: (evt) => { emitted.push(evt); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.scanOrphans();
    expect(emitted.length).toBe(0);
  });

  it("reaps a background orphan whose lastSeenMs >= minIdleMs", async () => {
    const emitted = [];
    const r = new Reaper({
      minIdleMs: 15 * 60 * 1000,
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/missing", status: "idle", kind: "background" },
      ]),
      cwdExists: () => Promise.resolve(false),
      lastSeenMs: () => 30 * 60 * 1000, // touched 30 min ago — stale
      emit: (evt, fields) => { emitted.push({ evt, ...fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.scanOrphans();
    expect(emitted.length).toBe(1);
    expect(emitted[0].bgJobId).toBe("11111111");
  });

  it("reaps a background orphan whose lastSeenMs is null (no transcript does not block)", async () => {
    const emitted = [];
    const r = new Reaper({
      minIdleMs: 15 * 60 * 1000,
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/missing", status: "idle", kind: "background" },
      ]),
      cwdExists: () => Promise.resolve(false),
      lastSeenMs: () => null,
      emit: (evt, fields) => { emitted.push({ evt, ...fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.scanOrphans();
    expect(emitted.length).toBe(1);
    expect(emitted[0].bgJobId).toBe("11111111");
  });

  it("includeInteractive:true lets scanOrphans reap an interactive orphan", async () => {
    const emitted = [];
    const r = new Reaper({
      includeInteractive: true,
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/missing", status: "idle", kind: "interactive" },
      ]),
      cwdExists: () => Promise.resolve(false),
      lastSeenMs: () => null,
      emit: (evt, fields) => { emitted.push({ evt, ...fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.scanOrphans();
    expect(emitted.length).toBe(1);
    expect(emitted[0].bgJobId).toBe("11111111");
  });

  // ─── CTL-1165 D4: status:null sweep gap ────────────────────────────────────
  // The 6 reboot-survivor zombies on mini are `kind:"background"` `status:null`
  // sessions whose cwd vanished. Pre-D4 scanOrphans hard-skipped at
  // `if (a.status !== "idle") continue;`, so they were NEVER considered. D4 swaps
  // that gate to `isSweepReapableStatus(a.status)` so idle|null|undefined|"" are
  // all eligible-to-consider (still subject to the background-only + cwd-vanished
  // + recency gates).
  it("reaps a null-status background orphan whose cwd vanished (CTL-1165 D4 — THE RED CASE)", async () => {
    const emitted = [];
    const r = new Reaper({
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/missing", status: null, kind: "background" },
      ]),
      cwdExists: () => Promise.resolve(false),
      lastSeenMs: () => null,
      emit: (evt, fields) => { emitted.push({ evt, ...fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.scanOrphans();
    expect(emitted.length).toBe(1);
    expect(emitted[0].evt).toBe("phase.abort.reap-requested");
    expect(emitted[0].bgJobId).toBe("11111111");
    expect(emitted[0].reason).toBe("orphan-cwd-missing");
  });

  it("still reaps an idle background orphan whose cwd vanished (regression guard)", async () => {
    const emitted = [];
    const r = new Reaper({
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/missing", status: "idle", kind: "background" },
      ]),
      cwdExists: () => Promise.resolve(false),
      lastSeenMs: () => null,
      emit: (evt, fields) => { emitted.push({ evt, ...fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.scanOrphans();
    expect(emitted.length).toBe(1);
    expect(emitted[0].bgJobId).toBe("11111111");
  });

  it("still spares a busy session even with a vanished cwd (never weaken busy-spare)", async () => {
    const emitted = [];
    const r = new Reaper({
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/missing", status: "busy", kind: "background" },
      ]),
      cwdExists: () => Promise.resolve(false),
      lastSeenMs: () => null,
      emit: (evt, fields) => { emitted.push({ evt, ...fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.scanOrphans();
    expect(emitted.length).toBe(0);
  });

  it("spares a null-status background orphan whose cwd STILL exists", async () => {
    const emitted = [];
    const r = new Reaper({
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/present", status: null, kind: "background" },
      ]),
      cwdExists: () => Promise.resolve(true), // cwd still on disk → not an orphan
      lastSeenMs: () => null,
      emit: (evt, fields) => { emitted.push({ evt, ...fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.scanOrphans();
    expect(emitted.length).toBe(0);
  });

  it("spares a recently-active null-status orphan (lastSeenMs < minIdleMs)", async () => {
    const emitted = [];
    const r = new Reaper({
      minIdleMs: 15 * 60 * 1000,
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/missing", status: null, kind: "background" },
      ]),
      cwdExists: () => Promise.resolve(false),
      lastSeenMs: () => 60_000, // touched 1 min ago — still in use
      emit: (evt, fields) => { emitted.push({ evt, ...fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.scanOrphans();
    expect(emitted.length).toBe(0);
  });
});

// ─── CTL-1165 D4: isSweepReapableStatus pure predicate ───────────────────────
describe("isSweepReapableStatus (CTL-1165 D4)", () => {
  it("treats idle/null/undefined/'' as eligible-to-consider, busy/active as not", () => {
    expect(isSweepReapableStatus("idle")).toBe(true);
    expect(isSweepReapableStatus(null)).toBe(true);
    expect(isSweepReapableStatus(undefined)).toBe(true);
    expect(isSweepReapableStatus("")).toBe(true); // empty string → null-like
    expect(isSweepReapableStatus("busy")).toBe(false);
    expect(isSweepReapableStatus("active")).toBe(false);
  });
});

// CTL-1004: the stall-janitor's J1 reap is a TARGETED orphans.reap-requested —
// it names a specific worktree_path + ticket so the reaper acts on THAT tree (the
// targeted removal + CTL-791 evidence path), not a blanket session sweep. An
// untargeted orphans.reap-requested (the legacy 600s timer, payload {}) still
// runs the blanket scanOrphans. This locks the consumption contract the janitor
// depends on.
describe("Reaper.handle orphans.reap-requested routing (CTL-1004)", () => {
  it("UNTARGETED (no worktree_path) → blanket scanOrphans, NOT a targeted removal", async () => {
    let scanned = false;
    let removed = false;
    const r = new Reaper({
      agents: agentsFixture([]),
      gitWorktreeRemove: () => { removed = true; return Promise.resolve({ ok: true }); },
      emit: () => Promise.resolve(),
      log: silentLog(),
    });
    r.scanOrphans = async () => { scanned = true; };
    await r.handle({ event: "orphans.reap-requested" });
    expect(scanned).toBe(true);
    expect(removed).toBe(false);
  });

  it("TARGETED (worktree_path present) → targeted removal path (presweep+CTL-791+remove), NOT a blanket scan", async () => {
    let scanned = false;
    const trace = [];
    const r = new Reaper({
      executorReap: () => Promise.resolve({ ok: true }),
      agents: agentsFixture([]),
      assessWorktreeRemoval: async () => ({ safe: true, reasons: [] }), // CTL-791 gate satisfied
      archiveWorktree: () => ({ ok: true }),
      gitWorktreeRemove: (p) => { trace.push(["wt", p]); return Promise.resolve({ ok: true }); },
      gitBranchDelete: (b, force) => { trace.push(["br", b, force]); return Promise.resolve({ ok: true }); },
      emit: (evt) => { trace.push(["emit", evt]); return Promise.resolve(); },
      log: silentLog(),
    });
    r.scanOrphans = async () => { scanned = true; };
    await r.handle({
      event: "orphans.reap-requested",
      ticket: "CTL-100",
      worktree_path: "/wt/CTL-100",
      branch: "CTL-100",
    });
    // Blanket scan is NOT used for a targeted event.
    expect(scanned).toBe(false);
    // The named worktree is removed via the evidence-gated path.
    expect(trace).toContainEqual(["wt", "/wt/CTL-100"]);
    expect(trace.some((t) => t[0] === "emit" && t[1] === "pr.merged.cleanup-complete")).toBe(true);
  });

  it("TARGETED reap honors the CTL-791 evidence gate — unsafe tree is deferred, NOT removed", async () => {
    let removed = false;
    const emitted = [];
    const r = new Reaper({
      executorReap: () => Promise.resolve({ ok: true }),
      agents: agentsFixture([]),
      assessWorktreeRemoval: async () => ({ safe: false, reasons: ["dirty-worktree"] }),
      archiveWorktree: () => ({ ok: true }),
      gitWorktreeRemove: () => { removed = true; return Promise.resolve({ ok: true }); },
      gitBranchDelete: () => Promise.resolve({ ok: true }),
      emit: (evt, fields) => { emitted.push({ evt, fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.handle({
      event: "orphans.reap-requested",
      ticket: "CTL-100",
      worktree_path: "/wt/CTL-100",
      branch: "CTL-100",
    });
    expect(removed).toBe(false);
    expect(emitted.some((e) => e.evt === "pr.merged.cleanup-failed")).toBe(true);
  });
});

describe("Reaper.bootReplay", () => {
  it("replays outstanding requests, skips already-completed", async () => {
    const tmpdir = (await import("node:os")).tmpdir();
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir, "reaper-boot-"));
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath,
      JSON.stringify({ event: "phase.yield.reap-requested", bg_job_id: "aaaaaaaa" }) + "\n" +
      JSON.stringify({ event: "phase.yield.reap-requested", bg_job_id: "bbbbbbbb" }) + "\n" +
      JSON.stringify({ event: "phase.yield.reap-complete",  bg_job_id: "aaaaaaaa" }) + "\n");
    const reaped = [];
    const r = new Reaper({
      executorReap: (id) => { reaped.push(id); return Promise.resolve({ ok: true }); },
      agents: agentsFixture([
        { sessionId: "bbbbbbbb-aaaa-bbbb-cccc-dddddddddddd", cwd: "/x", status: "idle" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.bootReplay(logPath);
    expect(reaped).toEqual(["bbbbbbbb"]);
  });

  it("returns silently when log path does not exist", async () => {
    const r = new Reaper({ log: silentLog() });
    await r.bootReplay("/nonexistent/log/path.jsonl");
    // No throw == pass
    expect(true).toBe(true);
  });

  // CTL-673: bootReplay streams the log in bounded chunks, retaining ONLY
  // reap-relevant events, so a huge log dominated by irrelevant events never
  // materializes into a whole-file string + array. The replay decision (skip
  // already-completed, reap outstanding) must stay byte-identical.
  it("streams a large log dominated by irrelevant events (only outstanding reaped)", async () => {
    const tmpdir = (await import("node:os")).tmpdir();
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir, "reaper-boot-big-"));
    const logPath = join(dir, "log.jsonl");
    const lines = [];
    for (let i = 0; i < 5000; i++) lines.push(JSON.stringify({ event: "session.heartbeat", i }));
    lines.push(JSON.stringify({ event: "phase.yield.reap-requested", bg_job_id: "aaaaaaaa" }));
    lines.push(JSON.stringify({ event: "phase.yield.reap-requested", bg_job_id: "bbbbbbbb" }));
    lines.push(JSON.stringify({ event: "phase.yield.reap-complete", bg_job_id: "aaaaaaaa" }));
    writeFileSync(logPath, lines.join("\n") + "\n");
    const reaped = [];
    const r = new Reaper({
      executorReap: (id) => { reaped.push(id); return Promise.resolve({ ok: true }); },
      agents: agentsFixture([
        { sessionId: "bbbbbbbb-aaaa-bbbb-cccc-dddddddddddd", cwd: "/x", status: "idle" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.bootReplay(logPath);
    expect(reaped).toEqual(["bbbbbbbb"]); // aaaaaaaa already completed → skipped
  });

  it("tolerates malformed lines interleaved in the stream", async () => {
    const tmpdir = (await import("node:os")).tmpdir();
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir, "reaper-boot-bad-"));
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath,
      "not json\n" +
      JSON.stringify({ event: "phase.yield.reap-requested", bg_job_id: "bbbbbbbb" }) + "\n" +
      "{ truncated\n");
    const reaped = [];
    const r = new Reaper({
      executorReap: (id) => { reaped.push(id); return Promise.resolve({ ok: true }); },
      agents: agentsFixture([
        { sessionId: "bbbbbbbb-aaaa-bbbb-cccc-dddddddddddd", cwd: "/x", status: "idle" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.bootReplay(logPath);
    expect(reaped).toEqual(["bbbbbbbb"]); // malformed lines skipped, valid intent replayed
  });
});

// ─── CTL-661 hole #4: pure grouping helpers ──────────────────────────────────
describe("ticketFromCwd", () => {
  it("derives the ticket from the worktree basename", () => {
    expect(ticketFromCwd("/Users/x/catalyst/wt/CTL-661")).toBe("CTL-661");
    expect(ticketFromCwd("/wt/CTL-661")).toBe("CTL-661");
    expect(ticketFromCwd("/wt/CTL-661/")).toBe("CTL-661"); // trailing slash
  });

  it("keeps the /wt/CTL-64 vs /wt/CTL-649 boundary distinct", () => {
    expect(ticketFromCwd("/wt/CTL-64")).toBe("CTL-64");
    expect(ticketFromCwd("/wt/CTL-649")).toBe("CTL-649");
    expect(ticketFromCwd("/wt/CTL-64")).not.toBe(ticketFromCwd("/wt/CTL-649"));
  });

  it("returns null for empty / non-string input", () => {
    expect(ticketFromCwd("")).toBeNull();
    expect(ticketFromCwd(null)).toBeNull();
    expect(ticketFromCwd(undefined)).toBeNull();
  });
});

describe("groupBackgroundSessionsByTicket", () => {
  const bg = (sessionId, cwd) => ({ sessionId, cwd, kind: "background", status: "busy" });

  it("buckets background sessions by ticket and groups distinct worktrees apart", () => {
    const groups = groupBackgroundSessionsByTicket([
      bg("aaaa1111-0000-0000-0000-000000000000", "/wt/CTL-661"),
      bg("bbbb2222-0000-0000-0000-000000000000", "/wt/CTL-661"),
      bg("cccc3333-0000-0000-0000-000000000000", "/wt/CTL-660"),
    ]);
    expect(groups.get("CTL-661")).toHaveLength(2);
    expect(groups.get("CTL-660")).toHaveLength(1);
  });

  it("drops interactive/unknown-kind sessions and sessions with no cwd", () => {
    const groups = groupBackgroundSessionsByTicket([
      bg("aaaa1111-0000-0000-0000-000000000000", "/wt/CTL-661"),
      { sessionId: "dddd4444-0000-0000-0000-000000000000", cwd: "/wt/CTL-661", kind: "interactive" },
      { sessionId: "eeee5555-0000-0000-0000-000000000000", kind: "background" }, // no cwd
    ]);
    expect(groups.get("CTL-661")).toHaveLength(1);
  });
});

// ─── CTL-661 hole #4: reconcileTicketWorkers ─────────────────────────────────
describe("Reaper.reconcileTicketWorkers", () => {
  const bg = (sessionId, cwd, status = "busy") => ({ sessionId, cwd, kind: "background", status });

  it("keeps the canonical bg_job_id owner and reaps the rest", async () => {
    const emit = mock(() => Promise.resolve());
    const r = new Reaper({
      agents: agentsFixture([
        bg("aaaa1111-0000-0000-0000-000000000000", "/wt/CTL-661"),
        bg("bbbb2222-0000-0000-0000-000000000000", "/wt/CTL-661"),
      ]),
      emit,
      readActivePhaseSignal: () => ({ bg_job_id: "aaaa1111", phase: "verify" }),
      lastSeenMs: () => null, // null does NOT trip the cleanup-grace skip
      log: silentLog(),
    });
    await r.reconcileTicketWorkers();
    expect(emit).toHaveBeenCalledTimes(1);
    const [evt, fields] = emit.mock.calls[0];
    expect(evt).toBe("phase.reconcile.reap-requested");
    expect(fields.bgJobId).toBe("bbbb2222");
    expect(fields.canonicalBgJobId).toBe("aaaa1111");
    expect(fields.dominantPhase).toBe("verify");
    expect(fields.reason).toBe("ctl-661-one-worker-per-ticket");
  });

  it("leaves a ticket with a single live session alone", async () => {
    const emit = mock(() => Promise.resolve());
    const r = new Reaper({
      agents: agentsFixture([bg("aaaa1111-0000-0000-0000-000000000000", "/wt/CTL-661")]),
      emit,
      readActivePhaseSignal: () => ({ bg_job_id: "aaaa1111", phase: "verify" }),
      lastSeenMs: () => null,
      log: silentLog(),
    });
    await r.reconcileTicketWorkers();
    expect(emit).not.toHaveBeenCalled();
  });

  it("falls back to newest-by-last_seen when the signal is unresolvable", async () => {
    const emit = mock(() => Promise.resolve());
    // lastSeenMs is an AGE: aaaa1111 is 10s old (newest), bbbb2222 is 5min old.
    const ages = {
      "aaaa1111-0000-0000-0000-000000000000": 10_000,
      "bbbb2222-0000-0000-0000-000000000000": 300_000,
    };
    const r = new Reaper({
      agents: agentsFixture([
        bg("aaaa1111-0000-0000-0000-000000000000", "/wt/CTL-661"),
        bg("bbbb2222-0000-0000-0000-000000000000", "/wt/CTL-661"),
      ]),
      emit,
      readActivePhaseSignal: () => null, // unresolvable → newest fallback
      lastSeenMs: (sid) => ages[sid] ?? null,
      log: silentLog(),
    });
    await r.reconcileTicketWorkers();
    expect(emit).toHaveBeenCalledTimes(1);
    // newest (aaaa1111) kept → older bbbb2222 reaped.
    expect(emit.mock.calls[0][1].bgJobId).toBe("bbbb2222");
  });

  it("never reconciles interactive sessions sharing the cwd", async () => {
    const emit = mock(() => Promise.resolve());
    const r = new Reaper({
      agents: agentsFixture([
        bg("aaaa1111-0000-0000-0000-000000000000", "/wt/CTL-661"),
        { sessionId: "dddd4444-0000-0000-0000-000000000000", cwd: "/wt/CTL-661", kind: "interactive", status: "busy" },
      ]),
      emit,
      readActivePhaseSignal: () => ({ bg_job_id: "aaaa1111", phase: "verify" }),
      lastSeenMs: () => null,
      log: silentLog(),
    });
    await r.reconcileTicketWorkers();
    // only 1 background session in the group → nothing to reap.
    expect(emit).not.toHaveBeenCalled();
  });

  it("reconciles distinct worktrees independently", async () => {
    const emit = mock(() => Promise.resolve());
    const r = new Reaper({
      agents: agentsFixture([
        bg("aaaa1111-0000-0000-0000-000000000000", "/wt/CTL-661"),
        bg("bbbb2222-0000-0000-0000-000000000000", "/wt/CTL-661"),
        bg("cccc3333-0000-0000-0000-000000000000", "/wt/CTL-660"), // lone session, untouched
      ]),
      emit,
      readActivePhaseSignal: (ticket) =>
        ticket === "CTL-661" ? { bg_job_id: "aaaa1111", phase: "verify" } : null,
      lastSeenMs: () => null,
      log: silentLog(),
    });
    await r.reconcileTicketWorkers();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1].bgJobId).toBe("bbbb2222");
  });

  it("routes a no-target reconcile event (timer trigger) to the sweep", async () => {
    const emit = mock(() => Promise.resolve());
    const r = new Reaper({
      agents: agentsFixture([
        bg("aaaa1111-0000-0000-0000-000000000000", "/wt/CTL-661"),
        bg("bbbb2222-0000-0000-0000-000000000000", "/wt/CTL-661"),
      ]),
      emit,
      readActivePhaseSignal: () => ({ bg_job_id: "aaaa1111", phase: "verify" }),
      lastSeenMs: () => null,
      log: silentLog(),
    });
    await r.handle({ event: "phase.reconcile.reap-requested" }); // no bg_job_id → trigger
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1].bgJobId).toBe("bbbb2222");
  });
});

// ─── CTL-661 Phase 5: cleanup-grace ──────────────────────────────────────────
describe("Reaper.reconcileTicketWorkers — CLEANUP_GRACE_MS spawn grace", () => {
  const bg = (sessionId, cwd) => ({ sessionId, cwd, kind: "background", status: "busy" });

  function reconciler(emit, ageMs) {
    return new Reaper({
      agents: agentsFixture([
        bg("aaaa1111-0000-0000-0000-000000000000", "/wt/CTL-661"),
        bg("bbbb2222-0000-0000-0000-000000000000", "/wt/CTL-661"),
      ]),
      emit,
      readActivePhaseSignal: () => ({ bg_job_id: "aaaa1111", phase: "verify" }),
      lastSeenMs: (sid) => (sid.startsWith("bbbb2222") ? ageMs : null),
      log: silentLog(),
    });
  }

  it("spares a non-canonical session younger than the cleanup grace", async () => {
    const emit = mock(() => Promise.resolve());
    await reconciler(emit, 30_000).reconcileTicketWorkers(); // 30s < 60s grace
    expect(emit).not.toHaveBeenCalled();
  });

  it("reaps the same session once it is past the grace", async () => {
    const emit = mock(() => Promise.resolve());
    await reconciler(emit, 90_000).reconcileTicketWorkers(); // 90s > 60s grace
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1].bgJobId).toBe("bbbb2222");
  });

  it("CLEANUP_GRACE_MS is distinct from STALE_MS (5m) and minIdleMs (15m)", () => {
    expect(CLEANUP_GRACE_MS).toBe(60_000);
    expect(CLEANUP_GRACE_MS).not.toBe(5 * 60 * 1000); // STALE_MS
    expect(CLEANUP_GRACE_MS).not.toBe(15 * 60 * 1000); // DEFAULT_MIN_IDLE_MS
  });
});

// CTL-778 Step 2B — reaper backstop on phase.*.complete events.
// Safety net for a worker that emits complete but fails to self-stop.
describe("Reaper — CTL-778 complete-event reap backstop", () => {
  it("emits terminal reap-request on phase.<phase>.complete.<ticket>", async () => {
    const emitted = [];
    const r = new Reaper({
      agents: agentsFixture([{ sessionId: "abc12345-0000-0000-0000-000000000000", kind: "background" }]),
      emit: mock((type, fields) => { emitted.push([type, fields]); return Promise.resolve(); }),
      readSignalBgJobId: () => "abc12345",
      log: silentLog(),
    });
    await r.handle({ event: "phase.plan.complete.CTL-1", attributes: { "event.name": "phase.plan.complete.CTL-1" } });
    expect(emitted.length).toBe(1);
    expect(emitted[0][0]).toBe("phase.terminal.reap-requested");
    expect(emitted[0][1].ticket).toBe("CTL-1");
    expect(emitted[0][1].phase).toBe("plan");
  });

  it("complete-event reap is once-guarded — duplicate event is a no-op", async () => {
    const emitted = [];
    const r = new Reaper({
      agents: agentsFixture([{ sessionId: "abc12345-0000-0000-0000-000000000000", kind: "background" }]),
      emit: mock((type, fields) => { emitted.push([type, fields]); return Promise.resolve(); }),
      readSignalBgJobId: () => "abc12345",
      log: silentLog(),
    });
    const ev = { event: "phase.plan.complete.CTL-1", attributes: { "event.name": "phase.plan.complete.CTL-1" } };
    await r.handle(ev);
    await r.handle(ev); // duplicate — should be a no-op
    expect(emitted.length).toBe(1);
  });

  it("no bg_job_id (readSignalBgJobId returns null) → no emit", async () => {
    const emitted = [];
    const r = new Reaper({
      agents: agentsFixture([]),
      emit: mock((type, fields) => { emitted.push([type, fields]); return Promise.resolve(); }),
      readSignalBgJobId: () => null,
      log: silentLog(),
    });
    await r.handle({ event: "phase.plan.complete.CTL-1", attributes: { "event.name": "phase.plan.complete.CTL-1" } });
    expect(emitted.length).toBe(0);
  });

  it("non-complete phase events (e.g. phase.plan.revive.CTL-1) are not processed", async () => {
    const emitted = [];
    const r = new Reaper({
      agents: agentsFixture([]),
      emit: mock((type, fields) => { emitted.push([type, fields]); return Promise.resolve(); }),
      readSignalBgJobId: () => "abc12345",
      log: silentLog(),
    });
    await r.handle({ event: "phase.plan.revive.CTL-1", attributes: { "event.name": "phase.plan.revive.CTL-1" } });
    expect(emitted.length).toBe(0);
  });

  it("emit throwing in _handleCompleteEvent is caught at the outer handle() catch", async () => {
    const warns = [];
    const logger = { info: () => {}, warn: (o) => warns.push(o), error: (o) => warns.push(o) };
    const r = new Reaper({
      agents: agentsFixture([]),
      emit: mock(() => { throw new Error("emit boom"); }),
      readSignalBgJobId: () => "abc12345",
      log: logger,
    });
    // Should not throw — outer catch in handle() absorbs the error.
    await expect(r.handle({ event: "phase.plan.complete.CTL-1", attributes: {} })).resolves.toBeUndefined();
    expect(warns.length).toBeGreaterThan(0); // logged by outer catch
  });
});

// CTL-778: defaultReadSignalBgJobId — production signal-file reader.
describe("defaultReadSignalBgJobId (CTL-778)", () => {
  it("returns bg_job_id from a valid signal file", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const orchDir = mkdtempSync(join(tmpdir(), "reaper-sig-"));
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "phase-plan.json"), JSON.stringify({ bg_job_id: "abc12345", status: "running" }));
    expect(defaultReadSignalBgJobId(orchDir, "CTL-1", "plan")).toBe("abc12345");
  });

  it("returns null when signal file is missing", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const orchDir = mkdtempSync(join(tmpdir(), "reaper-sig-"));
    expect(defaultReadSignalBgJobId(orchDir, "CTL-1", "plan")).toBeNull();
  });

  it("returns null when bg_job_id field is absent", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const orchDir = mkdtempSync(join(tmpdir(), "reaper-sig-"));
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "phase-plan.json"), JSON.stringify({ status: "running" }));
    expect(defaultReadSignalBgJobId(orchDir, "CTL-1", "plan")).toBeNull();
  });

  it("returns null when file content is invalid JSON", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const orchDir = mkdtempSync(join(tmpdir(), "reaper-sig-"));
    const workerDir = join(orchDir, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "phase-plan.json"), "not json");
    expect(defaultReadSignalBgJobId(orchDir, "CTL-1", "plan")).toBeNull();
  });

  it("returns null when called with missing args", () => {
    expect(defaultReadSignalBgJobId(null, "CTL-1", "plan")).toBeNull();
    expect(defaultReadSignalBgJobId("/orch", null, "plan")).toBeNull();
    expect(defaultReadSignalBgJobId("/orch", "CTL-1", null)).toBeNull();
  });
});

// CTL-1165 D2: the orphan child-process reaper seam. reaper.mjs gains a
// `procReaper=null` constructor arg + a `procOrphans.reap-requested` switch case
// (`_handleProcOrphansSweep`) that delegates to procReaper.sweep — a NO-OP when
// no ProcReaper is injected, so all pre-D2 reaper tests are unaffected.
describe("Reaper.handle procOrphans.reap-requested (CTL-1165 D2)", () => {
  it("routes procOrphans.reap-requested to the injected procReaper.sweep", async () => {
    let swept = 0;
    const fakeProcReaper = {
      sweep: async () => {
        swept++;
        return { reaped: [], wouldReap: [], spared: [] };
      },
    };
    const r = new Reaper({
      agents: agentsFixture([]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
      procReaper: fakeProcReaper,
    });
    await r.handle({ event: "procOrphans.reap-requested" });
    expect(swept).toBe(1);
  });

  it("is a SAFE no-op when no procReaper is injected (default null) — does not throw", async () => {
    const r = new Reaper({
      agents: agentsFixture([]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    // No procReaper → the case must not throw and must not touch any executor.
    await expect(r.handle({ event: "procOrphans.reap-requested" })).resolves.toBeUndefined();
  });

  it("a throwing procReaper.sweep is swallowed by handle()'s try/catch (never wedges the loop)", async () => {
    const r = new Reaper({
      agents: agentsFixture([]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
      procReaper: {
        sweep: async () => {
          throw new Error("sweep boom");
        },
      },
    });
    await expect(r.handle({ event: "procOrphans.reap-requested" })).resolves.toBeUndefined();
  });
});
