// worktree-refresh-timer.test.mjs — unit tests for CTL-707 Layer 1 timer.
// Run: cd plugins/dev/scripts/execution-core && bun test worktree-refresh-timer.test.mjs

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startWorktreeRefreshTimer,
  readWorktreeRefreshConfig,
} from "./worktree-refresh-timer.mjs";

// Fake clock mirroring orphan-reaper-timer.test.mjs.
function fakeClock() {
  let reg = null;
  return {
    setInterval: (fn, ms) => {
      reg = { fn, ms };
      return { unref() {} };
    },
    clearInterval: () => {
      reg = null;
    },
    advance: (elapsedMs) => {
      if (!reg) return;
      const ticks = Math.floor(elapsedMs / reg.ms);
      for (let i = 0; i < ticks; i++) reg.fn();
    },
    registered: () => reg,
  };
}

// Fake signal factory — status is "running" by default.
function mkSignal(worktreePath, opts = {}) {
  return {
    ticket: opts.ticket ?? "CTL-TEST",
    status: opts.status ?? "running",
    worktreePath,
    liveness: { kind: "bg", value: opts.bgJobId ?? null },
  };
}

describe("startWorktreeRefreshTimer", () => {
  it("refreshes quiet running workers each interval", async () => {
    const clock = fakeClock();
    const emitted = [];
    const refreshed = [];
    startWorktreeRefreshTimer({
      intervalSeconds: 60,
      quietSeconds: 10,
      orchDir: "/fake/orch",
      readSignals: () => [mkSignal("/wt/CTL-TEST")],
      statWorktree: () => ({ mtimeMs: Date.now() - 20_000 }),
      isSessionLive: () => false,
      refresh: (wt, base) => { refreshed.push([wt, base]); return 0; },
      emit: (name) => emitted.push(name),
      clock,
    });
    clock.advance(60_000);
    expect(refreshed.length).toBe(1);
    expect(refreshed[0]).toEqual(["/wt/CTL-TEST", "main"]);
    expect(emitted[0]).toContain("auto-rebased.clean");
  });

  it("skips workers with a live --bg session", () => {
    const clock = fakeClock();
    const refreshed = [];
    startWorktreeRefreshTimer({
      intervalSeconds: 60,
      quietSeconds: 0,
      orchDir: "/fake/orch",
      readSignals: () => [mkSignal("/wt/A", { bgJobId: "abc123" })],
      statWorktree: () => ({ mtimeMs: 0 }),
      isSessionLive: (id) => id === "abc123",
      refresh: (wt) => { refreshed.push(wt); return 0; },
      clock,
    });
    clock.advance(60_000);
    expect(refreshed.length).toBe(0);
  });

  it("skips workers with a live in-process SDK worker (bg id null) — CTL-1410 Phase B", () => {
    const clock = fakeClock();
    const refreshed = [];
    startWorktreeRefreshTimer({
      intervalSeconds: 60,
      quietSeconds: 0,
      orchDir: "/fake/orch",
      readSignals: () => [
        mkSignal("/wt/A", { ticket: "CTL-SDK" }), // live in the registry — must be skipped
        mkSignal("/wt/B", { ticket: "CTL-IDLE" }), // not registered — still refreshed
      ],
      statWorktree: () => ({ mtimeMs: 0 }),
      isSessionLive: () => false, // bg leg sees nothing (bg id is null)
      isSdkWorkerLive: (ticket) => ticket === "CTL-SDK",
      refresh: (wt) => { refreshed.push(wt); return 0; },
      clock,
    });
    clock.advance(60_000);
    expect(refreshed).toEqual(["/wt/B"]);
  });

  it("skips workers whose worktree mtime is too recent", () => {
    const clock = fakeClock();
    const refreshed = [];
    startWorktreeRefreshTimer({
      intervalSeconds: 60,
      quietSeconds: 30,
      orchDir: "/fake/orch",
      readSignals: () => [mkSignal("/wt/A")],
      statWorktree: () => ({ mtimeMs: Date.now() - 5_000 }),
      isSessionLive: () => false,
      refresh: (wt) => { refreshed.push(wt); return 0; },
      clock,
    });
    clock.advance(60_000);
    expect(refreshed.length).toBe(0);
  });

  it("skips non-running/dispatched statuses", () => {
    const clock = fakeClock();
    const refreshed = [];
    for (const status of ["done", "stalled", "failed", "skipped"]) {
      startWorktreeRefreshTimer({
        intervalSeconds: 60,
        quietSeconds: 0,
        orchDir: "/fake/orch",
        readSignals: () => [mkSignal("/wt/A", { status })],
        statWorktree: () => ({ mtimeMs: 0 }),
        isSessionLive: () => false,
        refresh: (wt) => { refreshed.push(wt); return 0; },
        clock,
      });
      clock.advance(60_000);
    }
    expect(refreshed.length).toBe(0);
  });

  it("emits stale-base-detected on non-zero refresh rc", () => {
    const clock = fakeClock();
    const emitted = [];
    startWorktreeRefreshTimer({
      intervalSeconds: 60,
      quietSeconds: 0,
      orchDir: "/fake/orch",
      readSignals: () => [mkSignal("/wt/CTL-X", { ticket: "CTL-X" })],
      statWorktree: () => ({ mtimeMs: 0 }),
      isSessionLive: () => false,
      refresh: () => 2,
      emit: (name) => emitted.push(name),
      clock,
    });
    clock.advance(60_000);
    expect(emitted[0]).toContain("stale-base-detected");
  });

  it("is a no-op when disabled", () => {
    const clock = fakeClock();
    const refreshed = [];
    const handle = startWorktreeRefreshTimer({
      enabled: false,
      orchDir: "/fake/orch",
      refresh: (wt) => { refreshed.push(wt); return 0; },
      clock,
    });
    clock.advance(600_000);
    expect(refreshed.length).toBe(0);
    expect(clock.registered()).toBeNull();
    expect(typeof handle.stop).toBe("function");
  });

  it("is a no-op when orchDir is missing", () => {
    const clock = fakeClock();
    const refreshed = [];
    startWorktreeRefreshTimer({
      enabled: true,
      orchDir: undefined,
      refresh: (wt) => { refreshed.push(wt); return 0; },
      clock,
    });
    clock.advance(600_000);
    expect(refreshed.length).toBe(0);
  });

  it("stop() clears the interval", () => {
    const clock = fakeClock();
    const refreshed = [];
    const handle = startWorktreeRefreshTimer({
      intervalSeconds: 60,
      quietSeconds: 0,
      orchDir: "/fake/orch",
      readSignals: () => [mkSignal("/wt/A")],
      statWorktree: () => ({ mtimeMs: 0 }),
      isSessionLive: () => false,
      refresh: (wt) => { refreshed.push(wt); return 0; },
      clock,
    });
    handle.stop();
    clock.advance(600_000);
    expect(refreshed.length).toBe(0);
  });

  it("skips workers with no worktreePath", () => {
    const clock = fakeClock();
    const refreshed = [];
    startWorktreeRefreshTimer({
      intervalSeconds: 60,
      quietSeconds: 0,
      orchDir: "/fake/orch",
      readSignals: () => [{ ticket: "CTL-A", status: "running", worktreePath: null, liveness: {} }],
      statWorktree: () => ({ mtimeMs: 0 }),
      isSessionLive: () => false,
      refresh: (wt) => { refreshed.push(wt); return 0; },
      clock,
    });
    clock.advance(60_000);
    expect(refreshed.length).toBe(0);
  });

  it("handles multiple workers independently", () => {
    const clock = fakeClock();
    const refreshed = [];
    startWorktreeRefreshTimer({
      intervalSeconds: 60,
      quietSeconds: 0,
      orchDir: "/fake/orch",
      readSignals: () => [
        mkSignal("/wt/A", { ticket: "CTL-A" }),
        mkSignal("/wt/B", { ticket: "CTL-B", bgJobId: "live123" }),
        mkSignal("/wt/C", { ticket: "CTL-C", status: "done" }),
        mkSignal("/wt/D", { ticket: "CTL-D" }),
      ],
      statWorktree: () => ({ mtimeMs: 0 }),
      isSessionLive: (id) => id === "live123",
      refresh: (wt) => { refreshed.push(wt); return 0; },
      clock,
    });
    clock.advance(60_000);
    expect(refreshed).toContain("/wt/A");
    expect(refreshed).not.toContain("/wt/B");
    expect(refreshed).not.toContain("/wt/C");
    expect(refreshed).toContain("/wt/D");
    expect(refreshed.length).toBe(2);
  });
});

describe("readWorktreeRefreshConfig", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const writeConfig = (obj) => {
    dir = mkdtempSync(join(tmpdir(), "ctl707-cfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(obj));
    return path;
  };

  it("reads catalyst.orchestration.worktreeRefresh", () => {
    const path = writeConfig({
      catalyst: {
        orchestration: {
          worktreeRefresh: { enabled: false, intervalSeconds: 120, quietSeconds: 60 },
        },
      },
    });
    expect(readWorktreeRefreshConfig(path)).toEqual({
      enabled: false,
      intervalSeconds: 120,
      quietSeconds: 60,
    });
  });

  it("returns {} when key is absent", () => {
    const path = writeConfig({ catalyst: { orchestration: {} } });
    expect(readWorktreeRefreshConfig(path)).toEqual({});
  });

  it("returns {} for a missing file", () => {
    expect(readWorktreeRefreshConfig("/no/such/config.json")).toEqual({});
  });

  it("returns {} for malformed JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "ctl707-cfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "{ not json");
    expect(readWorktreeRefreshConfig(path)).toEqual({});
  });

  it("returns {} for a null/empty path", () => {
    expect(readWorktreeRefreshConfig(null)).toEqual({});
    expect(readWorktreeRefreshConfig("")).toEqual({});
  });
});
