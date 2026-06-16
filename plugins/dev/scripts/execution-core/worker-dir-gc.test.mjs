// worker-dir-gc.test.mjs — CTL-1205. GC of stale execution-core/workers/<TICKET>/ dirs.
//
// Every fs/agents/clock/emit primitive is an injected, defaulted constructor
// param (mirrors job-dir-gc.test.mjs). NO test reads real disk or spawns `claude`.

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { sweepWorkerDirs } from "./worker-dir-gc.mjs";

const HOUR = 3600_000;
const RETENTION_24H = 24 * HOUR;
const ORCH = "/fake/execution-core";
const WORKERS = join(ORCH, "workers");

// Recording rm spy: records every (path, opts) tuple, never touches disk.
function rmSpy() {
  const calls = [];
  const fn = async (p, opts) => { calls.push({ path: p, opts }); };
  fn.calls = calls;
  return fn;
}

// Recording emit spy: records (eventType, fields) tuples, resolves true.
function emitSpy() {
  const calls = [];
  const fn = async (eventType, fields) => {
    calls.push({ eventType, fields });
    return true;
  };
  fn.calls = calls;
  return fn;
}

// Recording log spy with warn().
function logSpy() {
  const warn = [];
  return {
    warn: (...args) => warn.push(args),
    info: () => {},
    error: () => {},
    debug: () => {},
    _warn: warn,
  };
}

// A live agent row matching claude agents --json shape.
const agent = (sessionId) => ({ sessionId, status: "idle", kind: "background" });

// Fake readDir that returns an array of dir entries (with isDirectory).
function fakeDirs(names) {
  return async () => names.map((n) => ({ name: n, isDirectory: () => true }));
}

// Build a fake readWorkerMeta returning {statuses, shortIds} for a ticket.
function fakeWorkerMeta(map) {
  return async (ticket) => map[ticket] ?? { statuses: {}, shortIds: new Set() };
}

describe("sweepWorkerDirs", () => {
  it("deletes a terminal, idle, aged worker dir", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const emit = emitSpy();
    const res = await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9000"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9000": {
          statuses: { teardown: "done" },
          shortIds: new Set(["deadbeef"]),
        },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit,
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(1);
    expect(rm.calls[0].path).toBe(join(WORKERS, "CTL-9000"));
    expect(rm.calls[0].opts).toEqual({ recursive: true, force: true });
    expect(res.reclaimed).toBe(1);
    expect(res.scanned).toBe(1);
    const swept = emit.calls.find((c) => c.eventType === "workers.gc.swept");
    expect(swept).toBeTruthy();
    expect(swept.fields.reclaimed).toBe(1);
  });

  it("fails closed when `claude agents` is unreadable", async () => {
    const rm = rmSpy();
    const emit = emitSpy();
    const log = logSpy();
    const res = await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9000"]),
      statDir: async () => ({ mtimeMs: 0 }),
      rm,
      readAgents: () => ({ ok: false, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9000": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => 1_000_000_000_000,
      retentionMs: RETENTION_24H,
      emit,
      env: {},
      log,
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.skipped).toBe("agents-unreadable");
    expect(log._warn.length).toBeGreaterThanOrEqual(1);
    expect(emit.calls.find((c) => c.eventType === "workers.gc.swept")).toBeUndefined();
  });

  it("fails closed when `claude agents` throws", async () => {
    const rm = rmSpy();
    const res = await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9000"]),
      statDir: async () => ({ mtimeMs: 0 }),
      rm,
      readAgents: () => { throw new Error("exec failed"); },
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9000": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => 1_000_000_000_000,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.skipped).toBe("agents-unreadable");
  });

  it("never deletes an in-flight dir (has signals, still running)", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9001"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        // implement running — not terminal
        "CTL-9001": { statuses: { implement: "running" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.skippedInFlight).toBe(1);
  });

  it("never deletes a dir with no phase signals (empty statuses)", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9002"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9002": { statuses: {}, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.skippedInFlight).toBe(1);
  });

  it("never deletes a dir whose session is still live", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    // teardown done = terminal, but bg_job_id is still in live agents
    const res = await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9003"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [agent("abc12345-0000-0000-0000-000000000000")] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9003": {
          statuses: { teardown: "done" },
          shortIds: new Set(["abc12345"]),
        },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.skippedLive).toBe(1);
  });

  it("never deletes a dir younger than retention", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9004"]),
      statDir: async () => ({ mtimeMs: now - 1 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9004": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.skippedRecent).toBe(1);
  });

  it("bounds deletions to batchCap and drains the rest next tick", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const tickets = Array.from({ length: 20 }, (_, i) => `CTL-${9100 + i}`);
    const metaMap = Object.fromEntries(
      tickets.map((t) => [t, { statuses: { teardown: "done" }, shortIds: new Set() }])
    );
    const res = await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(tickets),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta(metaMap),
      now: () => now,
      retentionMs: RETENTION_24H,
      batchCap: 5,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(5);
    expect(res.reclaimed).toBe(5);
    expect(res.batchCapped).toBe(true);
  });

  it("counts a vanished dir as an error and continues", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9010"]),
      statDir: async () => {
        const e = new Error("ENOENT: no such file");
        e.code = "ENOENT";
        throw e;
      },
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9010": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.errors).toBe(1);
    expect(res.reclaimed).toBe(0);
  });

  it("emits workers.gc.swept only after a real reclaim", async () => {
    const now = 1_000_000_000_000;
    const emit = emitSpy();
    // All dirs are recent — nothing to reclaim
    await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9011"]),
      statDir: async () => ({ mtimeMs: now - 1 * HOUR }),
      rm: rmSpy(),
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9011": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit,
      env: {},
      log: logSpy(),
    });
    expect(emit.calls.length).toBe(0);

    // Now reclaim one
    const emit2 = emitSpy();
    await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9012"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm: rmSpy(),
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9012": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emit2,
      env: {},
      log: logSpy(),
    });
    expect(emit2.calls.length).toBe(1);
    expect(emit2.calls[0].eventType).toBe("workers.gc.swept");
  });

  it("rm's the worker dir alone with recursive+force", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9020"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9020": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(1);
    expect(rm.calls[0].path).toBe(join(WORKERS, "CTL-9020"));
    expect(rm.calls[0].opts).toEqual({ recursive: true, force: true });
  });

  it("never deletes a dir matching the self/controlling session", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9030"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9030": {
          statuses: { teardown: "done" },
          shortIds: new Set(["5e1f0001"]),
        },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: { CLAUDE_CODE_SESSION_ID: "5e1f0001-0000-0000-0000-000000000000" },
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.skippedLive).toBe(1);
  });

  it("handles teardown skipped as terminal (not in-flight, CTL-512 pattern)", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    // teardown: "skipped" is terminal per the CTL-512 skipped-as-done pattern on TERMINAL_PHASE
    const res = await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9040"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9040": {
          statuses: { "monitor-deploy": "skipped", teardown: "skipped" },
          shortIds: new Set(),
        },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(1);
    expect(res.reclaimed).toBe(1);
  });

  it("keeps a dir with only monitor-deploy skipped (teardown still pending)", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    // monitor-deploy: "skipped" alone is still in-flight — teardown has not run yet
    const res = await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9041"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9041": {
          statuses: { "monitor-deploy": "skipped" },
          shortIds: new Set(),
        },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.skippedInFlight).toBe(1);
  });

  it("handles failed/stalled/aborted tickets as terminal (deletable)", async () => {
    const now = 1_000_000_000_000;
    for (const status of ["failed", "stalled", "aborted"]) {
      const rm = rmSpy();
      const res = await sweepWorkerDirs({
        orchDir: ORCH,
        readDir: fakeDirs([`CTL-90${status}`]),
        statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
        rm,
        readAgents: () => ({ ok: true, agents: [] }),
        readWorkerMeta: fakeWorkerMeta({
          [`CTL-90${status}`]: {
            statuses: { implement: status },
            shortIds: new Set(),
          },
        }),
        now: () => now,
        retentionMs: RETENTION_24H,
        emit: emitSpy(),
        env: {},
        log: logSpy(),
      });
      expect(rm.calls.length).toBe(1);
      expect(res.reclaimed).toBe(1);
    }
  });

  it("handles an unreadable workers root gracefully (returns zeros)", async () => {
    const rm = rmSpy();
    const res = await sweepWorkerDirs({
      orchDir: ORCH,
      readDir: async (p) => {
        // workers root throws ENOENT; ticket subdir readDir never called
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      },
      statDir: async () => ({ mtimeMs: 0 }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      now: () => 1_000_000_000_000,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.scanned).toBe(0);
  });
});
