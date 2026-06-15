// job-dir-gc.test.mjs — CTL-1165 D3. GC of stale ~/.claude/jobs/<id> dirs.
//
// Every fs/agents/clock/emit primitive is an injected, defaulted constructor
// param (mirrors detectColdStart + Reaper). NO test reads the real jobs root,
// calls real rmSync, or spawns `claude`.

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { sweepJobDirs } from "./job-dir-gc.mjs";

const HOUR = 3600_000;
const RETENTION_24H = 24 * HOUR;

// Recording rm spy: records every (path, opts) tuple, never touches disk.
function rmSpy() {
  const calls = [];
  const fn = (p, opts) => calls.push({ path: p, opts });
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

// A live agent row: claude agents --json shape. Only sessionId matters for GC.
const agent = (sessionId, extra = {}) => ({ sessionId, status: "idle", kind: "background", ...extra });

const ROOT = "/fake/.claude/jobs";

describe("sweepJobDirs", () => {
  it("deletes an old non-live dir", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const emit = emitSpy();
    const res = await sweepJobDirs({
      jobsRoot: ROOT,
      readDir: () => ["deadbeef"],
      statDir: () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit,
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(1);
    expect(rm.calls[0].path).toBe(join(ROOT, "deadbeef"));
    expect(rm.calls[0].opts).toEqual({ recursive: true, force: true });
    expect(res.reclaimed).toBe(1);
    const swept = emit.calls.find((c) => c.eventType === "jobs.gc.swept");
    expect(swept).toBeTruthy();
    expect(swept.fields.reclaimed).toBe(1);
  });

  it("preserves a live registered session", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweepJobDirs({
      jobsRoot: ROOT,
      readDir: () => ["abc12345"],
      statDir: () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [agent("abc12345-0000-0000-0000-000000000000")] }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.skippedLive).toBe(1);
    expect(res.reclaimed).toBe(0);
  });

  it("preserves a recent dir", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweepJobDirs({
      jobsRoot: ROOT,
      readDir: () => ["recent01"],
      statDir: () => ({ mtimeMs: now - 1 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.skippedRecent).toBe(1);
    expect(res.reclaimed).toBe(0);
  });

  it("fail-closed on agents-unreadable", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const emit = emitSpy();
    const log = logSpy();
    const res = await sweepJobDirs({
      jobsRoot: ROOT,
      readDir: () => ["deadbeef"],
      statDir: () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: false, agents: [] }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit,
      env: {},
      log,
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(log._warn.length).toBe(1);
    // No delete (jobs.gc.swept) emit on a fail-closed abort.
    expect(emit.calls.find((c) => c.eventType === "jobs.gc.swept")).toBeUndefined();
  });

  it("tolerates an un-stattable dir (ENOENT) without throwing", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweepJobDirs({
      jobsRoot: ROOT,
      readDir: () => ["gone0001"],
      statDir: () => {
        const e = new Error("ENOENT: no such file");
        e.code = "ENOENT";
        throw e;
      },
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
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

  it("honors the batch cap", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const basenames = Array.from({ length: 300 }, (_, i) => `dead${String(i).padStart(4, "0")}`);
    const res = await sweepJobDirs({
      jobsRoot: ROOT,
      readDir: () => basenames,
      statDir: () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      now: () => now,
      retentionMs: RETENTION_24H,
      batchCap: 200,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(200);
    expect(res.reclaimed).toBe(200);
    expect(res.batchCapped).toBe(true);
  });

  it("never deletes the self/controlling session dir", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    // basename is a valid 8-char hex short-id matching the env session prefix.
    const res = await sweepJobDirs({
      jobsRoot: ROOT,
      readDir: () => ["5e1f0001"],
      statDir: () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: { CLAUDE_CODE_SESSION_ID: "5e1f0001-0000-0000-0000-000000000000" },
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
  });
});
