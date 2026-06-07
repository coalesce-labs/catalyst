// stale-pr-rescue-timer.test.mjs — CTL-782 seam-injected timer tests.
// Run: bun test plugins/dev/scripts/execution-core/stale-pr-rescue-timer.test.mjs

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startStalePrRescueTimer,
  readStalePrRescueConfig,
  buildRescueDispatchArgs,
  defaultMergeTree,
  defaultLinearWrite,
} from "./stale-pr-rescue-timer.mjs";
import * as linearWriteModule from "./linear-write.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

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
    // PR view's headRefName must reach the dispatch opts — orchestrate-rebase
    // otherwise defaults to the legacy <orch>-<TICKET> branch name, which
    // does not exist for execution-core PRs (review finding, CTL-782).
    expect(dispatched[0].opts.headRef).toBe("CTL-TEST");
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
        prView: async () => ({ state: "OPEN", mergeStateStatus: "BEHIND", baseRefName: "main", headRefName: "CTL-9-branch" }),
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

// ── CTL-782 remediation: production-glue coverage (verify findings) ─────────

describe("call-site argument assembly", () => {
  // Guards against the self-compare regression: processTicket must hand
  // mergeTree the PR HEAD branch from view.headRefName, never origin/<base>.
  it("stable DIRTY: mergeTree receives (worktree, base, PR head) — not base vs itself", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-20");
    writeSignal(orchDir, "CTL-20", "pr", {
      status: "done", bg_job_id: "dead",
      pr: { number: 200, url: "https://github.com/org/repo/pull/200" },
      worktreePath: "/some/wt",
    });
    writeRescueState(orchDir, "CTL-20", {
      firstSeenAt: new Date(fakeClock().now() - 660_000).toISOString(),
    });

    const mergeTreeArgs = [];
    startStalePrRescueTimer({
      enabled: true, orchDir, intervalSeconds: 1, clock,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      ...makeSeams({
        mergeTree: async (...args) => {
          mergeTreeArgs.push(args);
          return { exitCode: 1, output: "CONFLICT (content): Merge conflict in a.mjs" };
        },
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));

    expect(mergeTreeArgs.length).toBe(1);
    expect(mergeTreeArgs[0]).toEqual(["/some/wt", "main", "CTL-TEST"]);
  });

  it("dispatch: opts carry non-empty orchId (signal .orchestrator preferred) + rescue.json signalFile", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-21");
    writeSignal(orchDir, "CTL-21", "pr", {
      status: "done", bg_job_id: "dead",
      orchestrator: "ORCH-X",
      pr: { number: 210, url: "https://github.com/org/repo/pull/210" },
      worktreePath: "/some/wt",
    });
    writeRescueState(orchDir, "CTL-21", {
      firstSeenAt: new Date(fakeClock().now() - 660_000).toISOString(),
    });

    const dispatched = [];
    startStalePrRescueTimer({
      enabled: true, orchDir, intervalSeconds: 1, clock,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      ...makeSeams({
        dispatchRescue: (ticket, opts) => { dispatched.push({ ticket, opts }); },
        mergeTree: async () => ({ exitCode: 1, output: "CONFLICT (content): Merge conflict in a.mjs" }),
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));

    expect(dispatched.length).toBe(1);
    expect(dispatched[0].opts.orchId).toBe("ORCH-X");
    expect(dispatched[0].opts.signalFile).toBe(join(orchDir, "workers", "CTL-21", "rescue.json"));
    expect(dispatched[0].opts.base).toBe("main");
    expect(dispatched[0].opts.worktreePath).toBe("/some/wt");
    // atomic write left no temp files behind
    const leftovers = readdirSync(join(orchDir, "workers", "CTL-21")).filter(f => f.includes("rescue.json.tmp"));
    expect(leftovers).toEqual([]);
  });

  it("dispatch: orchId falls back to the ticket when the signal has no .orchestrator (daemon call shape)", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-22");
    writeSignal(orchDir, "CTL-22", "pr", {
      status: "done", bg_job_id: "dead",
      pr: { number: 220, url: "https://github.com/org/repo/pull/220" },
      worktreePath: "/some/wt",
    });
    writeRescueState(orchDir, "CTL-22", {
      firstSeenAt: new Date(fakeClock().now() - 660_000).toISOString(),
    });

    const dispatched = [];
    // No orchId param — exactly how daemon.mjs wires the timer.
    startStalePrRescueTimer({
      enabled: true, orchDir, intervalSeconds: 1, clock,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      ...makeSeams({
        dispatchRescue: (_ticket, opts) => { dispatched.push(opts); },
        mergeTree: async () => ({ exitCode: 1, output: "CONFLICT (content): Merge conflict in a.mjs" }),
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));

    expect(dispatched.length).toBe(1);
    expect(dispatched[0].orchId).toBe("CTL-22");
  });
});

describe("buildRescueDispatchArgs", () => {
  it("emits a non-empty --orch value and the rescue flags orchestrate-rebase expects", () => {
    const args = buildRescueDispatchArgs("CTL-30", {
      prNumber: 300, orchId: "CTL-30", orchDir: "/orch",
      worktreePath: "/wt", base: "main", signalFile: "/orch/workers/CTL-30/rescue.json",
    });
    const orchIdx = args.indexOf("--orch");
    expect(orchIdx).toBeGreaterThan(-1);
    expect(args[orchIdx + 1]).toBe("CTL-30");
    expect(args[orchIdx + 1]).not.toBe("");
    const sigIdx = args.indexOf("--signal-file");
    expect(args[sigIdx + 1]).toBe("/orch/workers/CTL-30/rescue.json");
    expect(args).toContain("--dispatch");
    expect(args[args.indexOf("--pr") + 1]).toBe("300");
    expect(args[args.indexOf("--base-branch") + 1]).toBe("main");
    expect(args[args.indexOf("--worker-dir") + 1]).toBe("/wt");
  });

  it("passes the PR headRef as --branch (execution-core branches are <TICKET>, not <orch>-<TICKET>)", () => {
    const args = buildRescueDispatchArgs("CTL-30", {
      prNumber: 300, orchId: "CTL-30", orchDir: "/orch",
      worktreePath: "/wt", base: "main", signalFile: "/orch/workers/CTL-30/rescue.json",
      headRef: "CTL-30",
    });
    const brIdx = args.indexOf("--branch");
    expect(brIdx).toBeGreaterThan(-1);
    expect(args[brIdx + 1]).toBe("CTL-30");
    // --dispatch must stay terminal so orchestrate-rebase's arg loop sees it
    expect(args[args.length - 1]).toBe("--dispatch");
  });

  it("omits --branch when headRef is absent (legacy <orch>-<TICKET> default applies)", () => {
    const args = buildRescueDispatchArgs("CTL-30", {
      prNumber: 300, orchId: "CTL-30", orchDir: "/orch",
      worktreePath: "/wt", base: "main", signalFile: "/orch/workers/CTL-30/rescue.json",
    });
    expect(args).not.toContain("--branch");
    expect(args).toContain("--dispatch");
  });
});

describe("escalation default seam", () => {
  it("module default linearWrite is the real linear-write transport", () => {
    expect(defaultLinearWrite).toBe(linearWriteModule);
    expect(typeof defaultLinearWrite.applyLabel).toBe("function");
  });

  it("default escalate fires labelOnce through the injected linearWrite (needs-human + marker)", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-31");
    writeSignal(orchDir, "CTL-31", "pr", {
      status: "done", bg_job_id: "dead",
      pr: { number: 310, url: "https://github.com/org/repo/pull/310" },
      worktreePath: "/some/wt",
    });
    writeRescueState(orchDir, "CTL-31", {
      firstSeenAt: new Date(fakeClock().now() - 660_000).toISOString(),
    });

    const labels = [];
    const seams = makeSeams({
      mergeTree: async () => ({
        exitCode: 1,
        output: "CONFLICT (modify/delete): x.mjs deleted in HEAD",
      }),
    });
    delete seams.escalate; // exercise defaultEscalate, not a stub
    startStalePrRescueTimer({
      enabled: true, orchDir, intervalSeconds: 1, clock,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      linearWrite: { applyLabel: (opts) => { labels.push(opts); return { applied: true }; } },
      ...seams,
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));

    expect(labels).toEqual([{ ticket: "CTL-31", label: "needs-human" }]);
    expect(existsSync(join(orchDir, "workers", "CTL-31", ".linear-label-needs-human.applied"))).toBe(true);
  });
});

describe("timer-level decision paths (previously only covered in the pure core)", () => {
  it("CLOSED PR → no dispatch, no escalate", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-40");
    writeSignal(orchDir, "CTL-40", "pr", {
      status: "done", bg_job_id: "dead",
      pr: { number: 400, url: "https://github.com/org/repo/pull/400" },
      worktreePath: "/some/wt",
    });
    writeRescueState(orchDir, "CTL-40", {
      firstSeenAt: new Date(fakeClock().now() - 660_000).toISOString(),
    });

    const dispatched = [];
    const escalated = [];
    startStalePrRescueTimer({
      enabled: true, orchDir, intervalSeconds: 1, clock,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      ...makeSeams({
        prView: async () => ({ state: "CLOSED", mergeStateStatus: "UNKNOWN", baseRefName: "main", headRefName: "h" }),
        dispatchRescue: (t) => dispatched.push(t),
        escalate: (t) => escalated.push(t),
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));
    expect(dispatched.length).toBe(0);
    expect(escalated.length).toBe(0);
  });

  it("worktree missing → escalate worktree_missing", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-41");
    writeSignal(orchDir, "CTL-41", "pr", {
      status: "done", bg_job_id: "dead",
      pr: { number: 410, url: "https://github.com/org/repo/pull/410" },
      worktreePath: "/gone/wt",
    });

    const escalated = [];
    startStalePrRescueTimer({
      enabled: true, orchDir, intervalSeconds: 1, clock,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      ...makeSeams({
        worktreeExists: () => false,
        escalate: (ticket, detail) => escalated.push({ ticket, detail }),
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));
    expect(escalated.length).toBe(1);
    const rs = readRescueState(orchDir, "CTL-41");
    expect(rs?.escalateReason).toBe("worktree_missing");
  });

  it("budget exhausted → escalate rescue_budget_exhausted, no dispatch", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-42");
    writeSignal(orchDir, "CTL-42", "pr", {
      status: "done", bg_job_id: "dead",
      pr: { number: 420, url: "https://github.com/org/repo/pull/420" },
      worktreePath: "/some/wt",
    });
    writeRescueState(orchDir, "CTL-42", {
      firstSeenAt: new Date(fakeClock().now() - 660_000).toISOString(),
      rescueAttempts: 1,
    });

    const dispatched = [];
    const escalated = [];
    startStalePrRescueTimer({
      enabled: true, orchDir, intervalSeconds: 1, clock,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      ...makeSeams({
        dispatchRescue: (t) => dispatched.push(t),
        escalate: (t) => escalated.push(t),
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));
    expect(dispatched.length).toBe(0);
    expect(escalated.length).toBe(1);
    const rs = readRescueState(orchDir, "CTL-42");
    expect(rs?.escalateReason).toBe("rescue_budget_exhausted");
    expect(rs?.rescueAttempts).toBe(1); // untouched
  });
});

describe("state-integrity hardening", () => {
  it("corrupt rescue.json → ticket skipped this tick (no prView, no dispatch, attempts not reset)", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-50");
    writeSignal(orchDir, "CTL-50", "pr", {
      status: "done", bg_job_id: "dead",
      pr: { number: 500, url: "https://github.com/org/repo/pull/500" },
      worktreePath: "/some/wt",
    });
    writeFileSync(join(orchDir, "workers", "CTL-50", "rescue.json"), "{ torn write");

    const prViewCalls = [];
    const dispatched = [];
    startStalePrRescueTimer({
      enabled: true, orchDir, intervalSeconds: 1, clock,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      ...makeSeams({
        prView: async () => { prViewCalls.push(1); return { state: "OPEN", mergeStateStatus: "DIRTY", baseRefName: "main", headRefName: "h" }; },
        dispatchRescue: (t) => dispatched.push(t),
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));
    expect(prViewCalls.length).toBe(0);
    expect(dispatched.length).toBe(0);
  });

  it("failed dispatch ({ok:false}) → rescueAttempts NOT burned, lastDispatchError recorded, dispatch-failed emitted", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-51");
    writeSignal(orchDir, "CTL-51", "pr", {
      status: "done", bg_job_id: "dead",
      pr: { number: 510, url: "https://github.com/org/repo/pull/510" },
      worktreePath: "/some/wt",
    });
    writeRescueState(orchDir, "CTL-51", {
      firstSeenAt: new Date(fakeClock().now() - 660_000).toISOString(),
    });

    const emitted = [];
    startStalePrRescueTimer({
      enabled: true, orchDir, intervalSeconds: 1, clock,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      ...makeSeams({
        dispatchRescue: () => ({ ok: false, error: "spawn blew up" }),
        emit: (name) => emitted.push(name),
        mergeTree: async () => ({ exitCode: 1, output: "CONFLICT (content): Merge conflict in a.mjs" }),
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));

    const rs = readRescueState(orchDir, "CTL-51");
    expect(rs?.rescueAttempts ?? 0).toBe(0);
    expect(rs?.lastDispatchError).toBe("spawn blew up");
    expect(emitted.some(e => e.includes("rescue.dispatch-failed"))).toBe(true);
    expect(emitted.some(e => e.includes("rescue.dispatched."))).toBe(false);
  });

  it("BEHIND with missing headRefName → skip with no compareBehind call (no base-vs-base substitute)", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-52");
    writeSignal(orchDir, "CTL-52", "pr", {
      status: "done", bg_job_id: "dead",
      pr: { number: 520, url: "https://github.com/org/repo/pull/520" },
      worktreePath: "/some/wt",
    });

    const compareCalls = [];
    const dispatched = [];
    startStalePrRescueTimer({
      enabled: true, orchDir, intervalSeconds: 1, clock,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      ...makeSeams({
        prView: async () => ({ state: "OPEN", mergeStateStatus: "BEHIND", baseRefName: "main" }),
        compareBehind: async (...a) => { compareCalls.push(a); return 25; },
        dispatchRescue: (t) => dispatched.push(t),
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));
    expect(compareCalls.length).toBe(0);
    expect(dispatched.length).toBe(0);
  });

  it("stalled rescue whose PR merged externally → no escalation, status marked resolved", async () => {
    const clock = fakeClock();
    const orchDir = mkOrchDir();
    mkTicketDir(orchDir, "CTL-53");
    writeSignal(orchDir, "CTL-53", "pr", {
      status: "done", bg_job_id: "dead",
      pr: { number: 530, url: "https://github.com/org/repo/pull/530" },
      worktreePath: "/some/wt",
    });
    writeRescueState(orchDir, "CTL-53", {
      status: "rescue-stalled",
      rescueAttempts: 1,
    });

    const escalated = [];
    startStalePrRescueTimer({
      enabled: true, orchDir, intervalSeconds: 1, clock,
      config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
      ...makeSeams({
        prView: async () => ({ state: "MERGED", mergeStateStatus: "MERGED", baseRefName: "main", headRefName: "h" }),
        escalate: (t) => escalated.push(t),
      }),
    });
    clock.advance(1_000);
    await new Promise(r => setTimeout(r, 20));
    expect(escalated.length).toBe(0);
    const rs = readRescueState(orchDir, "CTL-53");
    expect(rs?.status).toBe("rescue-stalled-resolved");
    expect(rs?.stalledResolvedAt).toBeTruthy();
  });
});

describe("defaultMergeTree (real git)", () => {
  function git(cwd, ...args) {
    const res = spawnSync(
      "git",
      ["-C", cwd, "-c", "user.email=t@t.t", "-c", "user.name=t", ...args],
      { encoding: "utf8" }
    );
    if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
    return res.stdout;
  }

  // Builds origin (bare) + a clone, with `main` and a `feature` branch.
  // mutate(originWorkDir) shapes the divergence before the clone fetches.
  function mkRepoPair() {
    const root = tmpDir();
    const originWork = join(root, "origin-work");
    const originBare = join(root, "origin.git");
    const clone = join(root, "clone");
    mkdirSync(originWork, { recursive: true });
    git(root, "init", "-b", "main", originWork);
    writeFileSync(join(originWork, "a.txt"), "line1\nline2\n");
    git(originWork, "add", "a.txt");
    git(originWork, "commit", "-m", "base");
    git(root, "clone", "--bare", originWork, originBare);
    git(root, "clone", originBare, clone);
    return { originWork, originBare, clone };
  }

  it("classifies a genuine content conflict (exit 1, CONFLICT in output) — no self-compare", async () => {
    const { originWork, originBare, clone } = mkRepoPair();
    // feature branch edits line1 one way…
    git(originWork, "checkout", "-b", "feature");
    writeFileSync(join(originWork, "a.txt"), "feature-edit\nline2\n");
    git(originWork, "commit", "-am", "feature edit");
    git(originWork, "push", originBare, "feature");
    // …main edits line1 the other way, AFTER the clone was cut.
    git(originWork, "checkout", "main");
    writeFileSync(join(originWork, "a.txt"), "main-edit\nline2\n");
    git(originWork, "commit", "-am", "main edit");
    git(originWork, "push", originBare, "main");

    const mt = await defaultMergeTree(clone, "main", "feature");
    expect(mt.exitCode).toBe(1);
    expect(mt.output).toContain("CONFLICT");
  });

  it("classifies a clean merge (exit 0) when branches touch different files", async () => {
    const { originWork, originBare, clone } = mkRepoPair();
    git(originWork, "checkout", "-b", "feature2");
    writeFileSync(join(originWork, "b.txt"), "new file\n");
    git(originWork, "add", "b.txt");
    git(originWork, "commit", "-m", "feature2 adds b");
    git(originWork, "push", originBare, "feature2");

    const mt = await defaultMergeTree(clone, "main", "feature2");
    expect(mt.exitCode).toBe(0);
  });

  it("throws when the fetch fails (no silent stale-base classification)", async () => {
    const root = tmpDir();
    const lonely = join(root, "lonely");
    mkdirSync(lonely, { recursive: true });
    git(root, "init", "-b", "main", lonely);
    // no `origin` remote → fetch must fail
    await expect(defaultMergeTree(lonely, "main", "feature")).rejects.toThrow();
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
