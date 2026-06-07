// stale-pr-rescue-timer.test.mjs — CTL-782 seam-injected timer tests.
// Run: bun test plugins/dev/scripts/execution-core/stale-pr-rescue-timer.test.mjs

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startStalePrRescueTimer,
  readStalePrRescueConfig,
} from "./stale-pr-rescue-timer.mjs";

// ── fake clock (same pattern as worktree-refresh-timer.test.mjs) ───────────
function fakeClock(nowMs = 1_800_000_000_000) {
  let reg = null;
  let _now = nowMs;
  return {
    setInterval: (fn, ms) => {
      reg = { fn, ms };
      return { unref() {} };
    },
    clearInterval: () => { reg = null; },
    advance: (elapsedMs) => {
      if (!reg) return;
      _now += elapsedMs;
      const ticks = Math.floor(elapsedMs / reg.ms);
      for (let i = 0; i < ticks; i++) reg.fn();
    },
    now: () => _now,
    registered: () => reg,
  };
}

// ── test-dir helpers ────────────────────────────────────────────────────────
let dirs = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), "ctl782-timer-"));
  dirs.push(d);
  return d;
}
function mkOrchDir() {
  const d = tmpDir();
  mkdirSync(join(d, "workers"), { recursive: true });
  return d;
}
function mkTicketDir(orchDir, ticket) {
  const d = join(orchDir, "workers", ticket);
  mkdirSync(d, { recursive: true });
  return d;
}
function writeSignal(orchDir, ticket, phase, obj) {
  const p = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
function writeRescueState(orchDir, ticket, obj) {
  const p = join(orchDir, "workers", ticket, "rescue.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
function readRescueState(orchDir, ticket) {
  try {
    return JSON.parse(readFileSync(join(orchDir, "workers", ticket, "rescue.json"), "utf8"));
  } catch { return null; }
}

// ── seam builder ────────────────────────────────────────────────────────────
function makeSeams(overrides = {}) {
  return {
    jobLifecycle: () => "dead-terminal",
    prView: async () => ({ state: "OPEN", mergeStateStatus: "DIRTY", baseRefName: "main", headRefName: "CTL-TEST" }),
    compareBehind: async () => 0,
    mergeTree: async () => ({ exitCode: 1, output: "deadbeef\na.mjs\n\nCONFLICT (content): Merge conflict in a.mjs" }),
    worktreeExists: () => true,
    dispatchRescue: () => {},
    escalate: () => {},
    emit: () => {},
    ...overrides,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────
describe("startStalePrRescueTimer", () => {
  it("is a no-op when enabled:false", () => {
    const clock = fakeClock();
    const dispatched = [];
    startStalePrRescueTimer({
      enabled: false,
      orchDir: mkOrchDir(),
      clock,
      ...makeSeams({ dispatchRescue: (t) => dispatched.push(t) }),
    });
    clock.advance(600_000);
    expect(dispatched.length).toBe(0);
    expect(clock.registered()).toBeNull();
  });

  it("is a no-op when orchDir is missing", () => {
    const clock = fakeClock();
    const dispatched = [];
    startStalePrRescueTimer({
      enabled: true,
      clock,
      ...makeSeams({ dispatchRescue: (t) => dispatched.push(t) }),
    });
    clock.advance(600_000);
    expect(dispatched.length).toBe(0);
  });

  it("stop() clears the interval", () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    const handle = startStalePrRescueTimer({ enabled: true, orchDir, clock, ...makeSeams() });
    handle.stop();
    clock.advance(600_000);
    expect(clock.registered()).toBeNull();
  });

  it("tick: no PR signal → no prView call (cheap skip)", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-1");
    // no phase-pr.json, no phase-monitor-merge.json with .pr
    writeSignal(orchDir, "CTL-1", "implement", { status: "done", bg_job_id: "abc" });

    const prViewCalls = [];
    startStalePrRescueTimer({
      enabled: true,
      orchDir,
      intervalSeconds: 1,
      clock,
      ...makeSeams({ prView: async (slug, num) => { prViewCalls.push(num); return { state: "OPEN", mergeStateStatus: "DIRTY", baseRefName: "main" }; } }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 10));
    expect(prViewCalls.length).toBe(0);
  });

  it("tick: live phase job on ticket → no prView call (cheap skip)", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-2");
    writeSignal(orchDir, "CTL-2", "pr", {
      status: "running",
      bg_job_id: "live-job",
      pr: { number: 5, url: "https://github.com/org/repo/pull/5" },
    });

    const prViewCalls = [];
    startStalePrRescueTimer({
      enabled: true,
      orchDir,
      intervalSeconds: 1,
      clock,
      ...makeSeams({
        jobLifecycle: (id) => id === "live-job" ? "alive" : "dead-terminal",
        prView: async () => { prViewCalls.push(1); return { state: "OPEN", mergeStateStatus: "DIRTY", baseRefName: "main" }; },
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 10));
    expect(prViewCalls.length).toBe(0);
  });

  it("tick: DIRTY first sighting → writes rescue.json firstSeenAt, no dispatch", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-3");
    writeSignal(orchDir, "CTL-3", "pr", {
      status: "done",
      bg_job_id: "dead-job",
      pr: { number: 10, url: "https://github.com/org/repo/pull/10" },
      worktreePath: "/some/wt",
    });

    const dispatched = [];
    startStalePrRescueTimer({
      enabled: true,
      orchDir,
      intervalSeconds: 1,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      clock,
      ...makeSeams({
        dispatchRescue: (t) => dispatched.push(t),
        mergeTree: async () => ({ exitCode: 1, output: "CONFLICT (content): Merge conflict in a.mjs" }),
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));

    expect(dispatched.length).toBe(0);
    const rs = readRescueState(orchDir, "CTL-3");
    expect(rs?.firstSeenAt).toBeTruthy();
  });

  it("tick: stable DIRTY resolvable → dispatchRescue called; rescueAttempts incremented", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-4");
    writeSignal(orchDir, "CTL-4", "pr", {
      status: "done",
      bg_job_id: "dead-job",
      pr: { number: 20, url: "https://github.com/org/repo/pull/20" },
      worktreePath: "/some/wt",
    });
    // stamp firstSeenAt in the far past (11 minutes ago relative to clock.now())
    writeRescueState(orchDir, "CTL-4", {
      firstSeenAt: new Date(fakeClock().now() - 660_000).toISOString(),
    });

    const dispatched = [];
    const emitted = [];
    startStalePrRescueTimer({
      enabled: true,
      orchDir,
      intervalSeconds: 1,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      clock,
      ...makeSeams({
        dispatchRescue: (ticket, opts) => dispatched.push({ ticket, opts }),
        emit: (name) => emitted.push(name),
        mergeTree: async () => ({ exitCode: 1, output: "CONFLICT (content): Merge conflict in a.mjs" }),
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));

    expect(dispatched.length).toBe(1);
    expect(dispatched[0].ticket).toBe("CTL-4");
    const rs = readRescueState(orchDir, "CTL-4");
    expect(rs?.rescueAttempts).toBe(1);
    expect(emitted.some(e => e.includes("rescue.dispatched"))).toBe(true);
  });

  it("tick: unresolvable conflicts → escalate called with files; escalatedAt stamped; second tick no re-escalation", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-5");
    writeSignal(orchDir, "CTL-5", "pr", {
      status: "done",
      bg_job_id: "dead-job",
      pr: { number: 30, url: "https://github.com/org/repo/pull/30" },
      worktreePath: "/some/wt",
    });
    writeRescueState(orchDir, "CTL-5", {
      firstSeenAt: new Date(fakeClock().now() - 660_000).toISOString(),
    });

    const escalated = [];
    startStalePrRescueTimer({
      enabled: true,
      orchDir,
      intervalSeconds: 1,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      clock,
      ...makeSeams({
        escalate: (ticket, detail) => escalated.push({ ticket, detail }),
        mergeTree: async () => ({
          exitCode: 1,
          output: "CONFLICT (modify/delete): x.mjs deleted in HEAD",
        }),
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));
    expect(escalated.length).toBe(1);
    const rs = readRescueState(orchDir, "CTL-5");
    expect(rs?.escalatedAt).toBeTruthy();

    // second tick: already-escalated → no second call
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));
    expect(escalated.length).toBe(1);
  });

  it("tick: rescue.json status=rescue-stalled → escalate", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-6");
    writeSignal(orchDir, "CTL-6", "pr", {
      status: "done",
      bg_job_id: "dead-job",
      pr: { number: 40, url: "https://github.com/org/repo/pull/40" },
      worktreePath: "/some/wt",
    });
    writeRescueState(orchDir, "CTL-6", {
      firstSeenAt: new Date(fakeClock().now() - 660_000).toISOString(),
      status: "rescue-stalled",
      rescueAttempts: 1,
    });

    const escalated = [];
    startStalePrRescueTimer({
      enabled: true,
      orchDir,
      intervalSeconds: 1,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      clock,
      ...makeSeams({ escalate: (t) => escalated.push(t) }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));
    expect(escalated.length).toBe(1);
    expect(escalated[0]).toBe("CTL-6");
  });

  it("tick: MERGED → no action, rescue state ignored", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-7");
    writeSignal(orchDir, "CTL-7", "pr", {
      status: "done",
      bg_job_id: "dead-job",
      pr: { number: 50, url: "https://github.com/org/repo/pull/50" },
      worktreePath: "/some/wt",
    });
    writeRescueState(orchDir, "CTL-7", {
      firstSeenAt: new Date(fakeClock().now() - 660_000).toISOString(),
    });

    const dispatched = [];
    const escalated = [];
    startStalePrRescueTimer({
      enabled: true,
      orchDir,
      intervalSeconds: 1,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      clock,
      ...makeSeams({
        prView: async () => ({ state: "MERGED", mergeStateStatus: "MERGED", baseRefName: "main" }),
        dispatchRescue: (t) => dispatched.push(t),
        escalate: (t) => escalated.push(t),
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));
    expect(dispatched.length).toBe(0);
    expect(escalated.length).toBe(0);
  });

  it("tick: prView throws → ticket skipped, tick continues without crash", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    // Two tickets: CTL-8a (prView throws), CTL-8b (normal)
    mkTicketDir(orchDir, "CTL-8a");
    writeSignal(orchDir, "CTL-8a", "pr", {
      status: "done", bg_job_id: "dead",
      pr: { number: 60, url: "https://github.com/org/repo/pull/60" },
      worktreePath: "/wt",
    });
    mkTicketDir(orchDir, "CTL-8b");
    writeSignal(orchDir, "CTL-8b", "pr", {
      status: "done", bg_job_id: "dead",
      pr: { number: 61, url: "https://github.com/org/repo/pull/61" },
      worktreePath: "/wt",
    });

    const prViewCalls = [];
    startStalePrRescueTimer({
      enabled: true,
      orchDir,
      intervalSeconds: 1,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      clock,
      ...makeSeams({
        prView: async (slug, num) => {
          prViewCalls.push(num);
          if (num === 60) throw new Error("gh API timeout");
          return { state: "OPEN", mergeStateStatus: "DIRTY", baseRefName: "main" };
        },
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));
    // Both were attempted; CTL-8b got through despite CTL-8a failing
    expect(prViewCalls).toContain(61);
  });

  it("tick: BEHIND > threshold → dispatchRescue; mergeTree NOT called", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-9");
    writeSignal(orchDir, "CTL-9", "pr", {
      status: "done",
      bg_job_id: "dead-job",
      pr: { number: 70, url: "https://github.com/org/repo/pull/70" },
      worktreePath: "/some/wt",
    });
    writeRescueState(orchDir, "CTL-9", {
      firstSeenAt: new Date(fakeClock().now() - 660_000).toISOString(),
    });

    const dispatched = [];
    const mergeTreeCalls = [];
    startStalePrRescueTimer({
      enabled: true,
      orchDir,
      intervalSeconds: 1,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      clock,
      ...makeSeams({
        prView: async () => ({ state: "OPEN", mergeStateStatus: "BEHIND", baseRefName: "main" }),
        compareBehind: async () => 25,
        mergeTree: async () => { mergeTreeCalls.push(1); return { exitCode: 0, output: "" }; },
        dispatchRescue: (t) => dispatched.push(t),
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));

    expect(dispatched.length).toBe(1);
    expect(mergeTreeCalls.length).toBe(0);
  });
});

describe("readStalePrRescueConfig", () => {
  it("reads catalyst.orchestration.stalePrRescue", () => {
    const orchDir = mkOrchDir();
    const path = join(orchDir, "config.json");
    writeFileSync(path, JSON.stringify({
      catalyst: { orchestration: { stalePrRescue: { enabled: false, intervalSeconds: 900 } } },
    }));
    expect(readStalePrRescueConfig(path)).toEqual({ enabled: false, intervalSeconds: 900 });
  });

  it("returns {} when key is absent", () => {
    const orchDir = mkOrchDir();
    const path = join(orchDir, "config.json");
    writeFileSync(path, JSON.stringify({ catalyst: { orchestration: {} } }));
    expect(readStalePrRescueConfig(path)).toEqual({});
  });

  it("returns {} for a missing file", () => {
    expect(readStalePrRescueConfig("/no/such/config.json")).toEqual({});
  });

  it("returns {} for null/empty path", () => {
    expect(readStalePrRescueConfig(null)).toEqual({});
    expect(readStalePrRescueConfig("")).toEqual({});
  });
});
