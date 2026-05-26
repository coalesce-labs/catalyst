// reaper.test.mjs — Reaper reconciler unit tests (CTL-649 Phase 4).
// All executors are injected; no real claude / git invocations.
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Reaper } from "./reaper.mjs";

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function agentsFixture(rows = []) {
  return mock(() => Promise.resolve(rows));
}

beforeEach(() => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
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

  it("skips active sessions (await CTL-619 liveness gate)", async () => {
    const executor = mock();
    const r = new Reaper({
      executorReap: executor,
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: "active", cwd: "/wt/x" },
      ]),
      emit: mock(() => Promise.resolve()),
      log: silentLog(),
    });
    await r.handle({ event: "phase.yield.reap-requested", bg_job_id: "abc12345" });
    expect(executor).not.toHaveBeenCalled();
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
      agents: agentsFixture([
        { sessionId: "abc12345-aaaa-bbbb-cccc-dddddddddddd", status: "idle", cwd: "/wt/x" },
      ]),
      emit: (evt, fields) => { emitted.push({ evt, fields }); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.handle({ event: "phase.yield.reap-requested", bg_job_id: "abc12345" });
    expect(emitted.find((e) => e.evt === "phase.yield.reap-failed")).toBeTruthy();
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
});

describe("Reaper._handlePrMergedCleanup", () => {
  it("presweeps, removes worktree, deletes branch — in that order", async () => {
    const trace = [];
    const r = new Reaper({
      executorReap: (id) => { trace.push(["reap", id]); return Promise.resolve({ ok: true }); },
      agents: agentsFixture([]),
      gitWorktreeRemove: (p) => { trace.push(["wt", p]); return Promise.resolve({ ok: true }); },
      gitBranchDelete: (b) => { trace.push(["br", b]); return Promise.resolve({ ok: true }); },
      emit: (evt) => { trace.push(["emit", evt]); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.handle({
      event: "pr.merged.cleanup-requested",
      ticket: "CTL-1",
      worktree_path: "/wt/CTL-1",
      branch: "ryan/ctl-1",
    });
    expect(trace).toEqual([
      ["wt", "/wt/CTL-1"],
      ["br", "ryan/ctl-1"],
      ["emit", "pr.merged.cleanup-complete"],
    ]);
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
});

describe("Reaper.scanOrphans", () => {
  it("emits phase.abort.reap-requested for sessions with missing cwd", async () => {
    const emitted = [];
    const r = new Reaper({
      agents: agentsFixture([
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/missing", status: "idle" },
        { sessionId: "22222222-aaaa-bbbb-cccc-dddddddddddd", cwd: "/tmp", status: "idle" },
      ]),
      cwdExists: (p) => Promise.resolve(p === "/tmp"),
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
        { sessionId: "11111111-aaaa-bbbb-cccc-dddddddddddd", cwd: "/wt/missing", status: "idle" },
      ]),
      cwdExists: () => Promise.resolve(false),
      emit: (evt) => { emitted.push(evt); return Promise.resolve(); },
      log: silentLog(),
    });
    await r.scanOrphans();
    expect(emitted.length).toBe(0);
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
});
