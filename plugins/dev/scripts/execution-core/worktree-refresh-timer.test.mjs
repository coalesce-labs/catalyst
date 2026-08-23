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

// CTL-1214 Phase 1: the Layer-2 fallback. catalyst.orchestration.worktreeRefresh
// was a Layer-1-ONLY read that fails open to {}, so slimming the committed config
// would have silently reverted the knob to its code defaults. Layer-2 now supplies
// it, Layer-2 winning per field (D8).
describe("readWorktreeRefreshConfig Layer-2 fallback (CTL-1214)", () => {
  let dirs = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  // Layer-2 siblings resolve off the given layer2Path's DIRECTORY, exactly as
  // resolveNodeConfigPath() does — so a fixture dir stays hermetic (no node.json
  // there) instead of reaching into the real ~/.config/catalyst.
  const mkLayer2 = ({ legacy, node }) => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1214-l2-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(legacy ?? {}));
    if (node !== undefined) writeFileSync(join(dir, "node.json"), JSON.stringify(node));
    return path;
  };
  const mkLayer1 = (obj) => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1214-l1-"));
    dirs.push(dir);
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(obj));
    return path;
  };

  it("Layer-1 present, Layer-2 absent -> Layer-1 value (un-slimmed repo)", () => {
    const l1 = mkLayer1({
      catalyst: { orchestration: { worktreeRefresh: { enabled: true, intervalSeconds: 300 } } },
    });
    const l2 = mkLayer2({ legacy: {} });
    expect(readWorktreeRefreshConfig(l1, l2)).toEqual({ enabled: true, intervalSeconds: 300 });
  });

  it("Layer-1 absent, node.json present -> node.json value (the slimmed repo)", () => {
    const l1 = mkLayer1({ catalyst: { projectKey: "x" } });
    const l2 = mkLayer2({
      legacy: {},
      node: { catalyst: { orchestration: { worktreeRefresh: { enabled: true, intervalSeconds: 300, quietSeconds: 30 } } } },
    });
    expect(readWorktreeRefreshConfig(l1, l2)).toEqual({
      enabled: true,
      intervalSeconds: 300,
      quietSeconds: 30,
    });
  });

  it("both present, differing fields -> Layer-2 wins per field, Layer-1 fills the rest (D8)", () => {
    const l1 = mkLayer1({
      catalyst: {
        orchestration: { worktreeRefresh: { enabled: true, intervalSeconds: 300, quietSeconds: 30 } },
      },
    });
    const l2 = mkLayer2({
      legacy: {},
      node: { catalyst: { orchestration: { worktreeRefresh: { intervalSeconds: 60 } } } },
    });
    expect(readWorktreeRefreshConfig(l1, l2)).toEqual({
      enabled: true,
      intervalSeconds: 60,
      quietSeconds: 30,
    });
  });

  it("both absent -> {} (unchanged)", () => {
    const l1 = mkLayer1({ catalyst: {} });
    const l2 = mkLayer2({ legacy: {} });
    expect(readWorktreeRefreshConfig(l1, l2)).toEqual({});
  });

  it("Layer-2 malformed -> Layer-1 preserved, never a throw", () => {
    const l1 = mkLayer1({
      catalyst: { orchestration: { worktreeRefresh: { enabled: true, intervalSeconds: 300 } } },
    });
    const dir = mkdtempSync(join(tmpdir(), "ctl1214-l2bad-"));
    dirs.push(dir);
    const l2 = join(dir, "config.json");
    writeFileSync(l2, "{ not json");
    writeFileSync(join(dir, "node.json"), "{ also not json");
    expect(() => readWorktreeRefreshConfig(l1, l2)).not.toThrow();
    expect(readWorktreeRefreshConfig(l1, l2)).toEqual({ enabled: true, intervalSeconds: 300 });
  });

  it("the one-argument signature still works (daemon.mjs:3149 call site)", () => {
    const l1 = mkLayer1({
      catalyst: { orchestration: { worktreeRefresh: { enabled: false } } },
    });
    expect(readWorktreeRefreshConfig(l1)).toEqual({ enabled: false });
  });
});
