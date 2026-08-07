// proc-reaper.test.mjs — CTL-1165 D2. The orphan child-process reaper (HIGHEST
// RISK). DEFAULT mode:"shadow" (emits would-reap, kills NOTHING). All IO is
// injected — no test spawns a subprocess, runs ps/lsof, touches ~/.claude, or
// signals a real pid. The CATASTROPHE GUARD (agents read {ok:false} → abort the
// sweep, kill nothing) is a first-class test.
//
// Run: cd plugins/dev/scripts/execution-core && bun test proc-reaper.test.mjs

import { describe, it, test, expect, mock } from "bun:test";
// CTL-1531 round 3: the BEHAVIOURAL parity suite spawns `bash __tests__/parity-scenario.sh`
// (a fully-mocked fixture — see that file's SAFETY note) and the probe-deadline tests
// spawn a deliberately hung mock `lsof` from a scratch $PATH. No test signals a real pid.
import { execFileSync } from "node:child_process";
// CTL-1531 P1-b drives the REAL default cwd probe against the REAL filesystem
// (the only disk-touching tests in this file; they read, and clean up after
// themselves under os.tmpdir()). No test here ever signals a real pid.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProcReaper,
  defaultCwdExists,
  lsofTimeoutMs,
  defaultProbeAlive,
  WIDEN_DEFAULT_MAX_KILLS,
  WIDEN_MODES,
  classifyProc,
  classifyPreCwd,
  isCommandDenylisted,
  isOrphaned,
  cwdUnderWorktreeRoot,
  buildAllowlist,
  collectLiveAgentSubtree,
  normalizeWidenMode,
  parseLsofCwdBatch,
  parsePsRows,
  parseEtime,
} from "./proc-reaper.mjs";

const WT_ROOT = "/Users/test/catalyst/wt";

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

// recordingKill — records every (pid, signal) tuple; NEVER calls process.kill.
// Mirrors the killProc seam contract (the production defaultKillProc wraps
// process.kill and NEVER throws): returns a boolean. For the signal-0 liveness
// re-probe it returns true (alive) only when the pid is in `alive`, else false
// (gone or foreign-uid) — exactly what defaultKillProc returns for ESRCH/EPERM.
// `survivesKill` (CTL-1531 P2-i) models a process that IGNORES or cannot receive
// SIGKILL — uninterruptible D-state on a hung mount, or EPERM. Default false: a
// delivered SIGKILL actually kills, so the post-SIGKILL confirmation probe sees it
// gone. Without this the fixture kept the pid alive forever, which quietly asserted
// the OLD fail-open contract ("SIGKILL delivered ⇒ assume reaped").
function recordingKill({ alive = new Set(), survivesKill = false } = {}) {
  const calls = [];
  const fn = (pid, signal) => {
    calls.push([pid, signal]);
    if (signal === 0) return alive.has(pid);
    if (signal === "SIGKILL" && !survivesKill) alive.delete(pid); // it actually died
    return true;
  };
  fn.calls = calls;
  return fn;
}

// recordingEmit — collects (type, fields) tuples.
function recordingEmit() {
  const calls = [];
  const fn = mock((type, fields) => {
    calls.push({ type, fields });
    return Promise.resolve(true);
  });
  fn.calls = calls;
  return fn;
}

// A canned ps snapshot builder for the 5-field `pid ppid rss etime command` spec.
function psLine({ pid, ppid, rss = 100000, etime = "10:00", command }) {
  return `${pid} ${ppid} ${rss} ${etime} ${command}`;
}

// ─── parseEtime ──────────────────────────────────────────────────────────────

describe("parseEtime", () => {
  test("MM:SS", () => expect(parseEtime("00:42")).toBe(42));
  test("HH:MM:SS", () => expect(parseEtime("01:02:03")).toBe(3723));
  test("DD-HH:MM:SS", () => expect(parseEtime("17-06:09:43")).toBe(1490983));
  test("malformed → 0", () => {
    expect(parseEtime("")).toBe(0);
    expect(parseEtime("garbage")).toBe(0);
    expect(parseEtime(undefined)).toBe(0);
  });
});

// ─── parsePsRows ─────────────────────────────────────────────────────────────

describe("parsePsRows", () => {
  test("parses pid/ppid/rss/etime/command and skips malformed", () => {
    const lines = [
      "  4321  4000 524288    10:00 /usr/local/bin/node server.mjs --port 8080",
      "  5000     1 100000 01:02:03 bun test foo.test.mjs",
      "", // blank skipped
      "not-a-row", // malformed skipped
    ];
    const rows = parsePsRows(lines);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      pid: 4321,
      ppid: 4000,
      rssKb: 524288,
      etimeSec: 600,
      command: "node",
    });
    // full argv kept for allowlist substring matching
    expect(rows[0].args).toBe("/usr/local/bin/node server.mjs --port 8080");
    expect(rows[1]).toMatchObject({ pid: 5000, ppid: 1, etimeSec: 3723, command: "bun" });
  });

  test("linux natural-width command column", () => {
    const rows = parsePsRows(["1234 1 50000 5-00:00:00 node /home/x/daemon.mjs"]);
    expect(rows[0]).toMatchObject({ pid: 1234, ppid: 1, etimeSec: 432000, command: "node" });
    expect(rows[0].args).toBe("node /home/x/daemon.mjs");
  });
});

// ─── cwdUnderWorktreeRoot (boundary-safe) ────────────────────────────────────

describe("cwdUnderWorktreeRoot", () => {
  test("exact + descendant match", () => {
    expect(cwdUnderWorktreeRoot(`${WT_ROOT}/CTL-X`, WT_ROOT)).toBe(true);
    expect(cwdUnderWorktreeRoot(`${WT_ROOT}/CTL-X/sub`, WT_ROOT)).toBe(true);
    expect(cwdUnderWorktreeRoot(WT_ROOT, WT_ROOT)).toBe(true);
  });
  test("sibling boundary is NOT a match (/wt/CTL-64 ≠ /wt/CTL-649)", () => {
    expect(cwdUnderWorktreeRoot("/wt/CTL-649", "/wt/CTL-64")).toBe(false);
  });
  test("null/empty → false", () => {
    expect(cwdUnderWorktreeRoot(null, WT_ROOT)).toBe(false);
    expect(cwdUnderWorktreeRoot(`${WT_ROOT}/x`, null)).toBe(false);
  });
});

// ─── collectLiveAgentSubtree ─────────────────────────────────────────────────

describe("collectLiveAgentSubtree", () => {
  test("DFS-descends from every live-agent root", () => {
    // tree: agent root 100 → 200 → 300 ; agent root 500 → 600
    const rows = [
      { pid: 100, ppid: 1, command: "claude" },
      { pid: 200, ppid: 100, command: "node" },
      { pid: 300, ppid: 200, command: "node" },
      { pid: 500, ppid: 1, command: "claude" },
      { pid: 600, ppid: 500, command: "bun" },
      { pid: 900, ppid: 1, command: "node" }, // unrelated orphan
    ];
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const childrenByPpid = new Map();
    for (const r of rows) {
      if (!childrenByPpid.has(r.ppid)) childrenByPpid.set(r.ppid, []);
      childrenByPpid.get(r.ppid).push(r.pid);
    }
    const liveAgents = [{ pid: 100 }, { pid: 500 }];
    const subtree = collectLiveAgentSubtree(liveAgents, byPid, childrenByPpid);
    expect(subtree.has(100)).toBe(true);
    expect(subtree.has(200)).toBe(true);
    expect(subtree.has(300)).toBe(true);
    expect(subtree.has(500)).toBe(true);
    expect(subtree.has(600)).toBe(true);
    expect(subtree.has(900)).toBe(false); // unrelated orphan never in LIVE_TREE
  });
});

// ─── buildAllowlist ──────────────────────────────────────────────────────────

describe("buildAllowlist", () => {
  test("includes selfPid + daemonPids + whole LIVE_TREE subtree pids", () => {
    const allow = buildAllowlist({
      selfPid: 42,
      daemonPids: [7, 8],
      liveAgentSubtreePids: new Set([100, 200]),
    });
    expect(allow.pids.has(42)).toBe(true);
    expect(allow.pids.has(7)).toBe(true);
    expect(allow.pids.has(8)).toBe(true);
    expect(allow.pids.has(100)).toBe(true);
    expect(allow.pids.has(200)).toBe(true);
  });
  test("carries the default + extra argv patterns (lowercased)", () => {
    const allow = buildAllowlist({ allowlistPatterns: ["MyCustomThing"] });
    expect(allow.patterns).toContain("execution-core/daemon.mjs");
    expect(allow.patterns).toContain("broker/index.mjs");
    expect(allow.patterns).toContain("orch-monitor/server.ts");
    expect(allow.patterns).toContain("tailscale");
    expect(allow.patterns).toContain("mycustomthing"); // case-insensitive
  });
});

// ─── isOrphaned ──────────────────────────────────────────────────────────────

describe("isOrphaned", () => {
  test("ppid===1 (reparented to launchd) → orphaned", () => {
    const row = { pid: 10, ppid: 1 };
    expect(isOrphaned(row, new Map())).toBe(true);
  });
  test("a live ancestor (ppid !== 1, parent present) → NOT orphaned", () => {
    const parent = { pid: 5, ppid: 100 };
    const row = { pid: 10, ppid: 5 };
    const byPid = new Map([[5, parent]]);
    expect(isOrphaned(row, byPid)).toBe(false);
  });
});

// ─── classifyProc (pure kill-gate) ───────────────────────────────────────────

function ctx(overrides = {}) {
  return {
    byPid: new Map(),
    liveAgentCwds: new Set(),
    liveAgentSubtreePids: new Set(),
    allowlist: buildAllowlist({ selfPid: 1, daemonPids: [] }),
    worktreeRoot: WT_ROOT,
    killableCommands: new Set(["node", "bun"]),
    minEtimeSec: 900,
    cwdForPid: () => `${WT_ROOT}/CTL-X`, // lsof cwd resolver; default = under wt
    // CTL-1531: cwd-deleted probe (widened-class ONLY). Default false = the cwd
    // is GONE, i.e. the kill-eligible direction, mirroring cwdForPid's default.
    cwdExists: () => false,
    worktreePath: null,
    ...overrides,
  };
}

describe("classifyProc kill-gate (ALL must hold else SPARE)", () => {
  test("orphan node under a worktree, not in LIVE_TREE, old enough → kill", async () => {
    const row = { pid: 10, ppid: 1, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const c = ctx();
    const v = await classifyProc(row, c);
    expect(v.action).toBe("kill");
  });
  test("allowlisted argv (daemon) → spare(reason allowlisted)", async () => {
    const row = {
      pid: 10,
      ppid: 1,
      command: "node",
      etimeSec: 1000,
      args: "node /x/execution-core/daemon.mjs --pid-file /y",
    };
    const v = await classifyProc(row, ctx());
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("allowlisted");
  });
  test("pid in allowlist.pids (self/daemon/LIVE_TREE) → spare(reason allowlisted)", async () => {
    const row = { pid: 100, ppid: 1, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const v = await classifyProc(row, ctx({ allowlist: buildAllowlist({ selfPid: 100 }) }));
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("allowlisted");
  });
  test("pid in LIVE_TREE subtree → spare(reason live-agent-owned)", async () => {
    const row = { pid: 222, ppid: 100, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const c = ctx({
      liveAgentSubtreePids: new Set([222]),
      byPid: new Map([[100, { pid: 100, ppid: 1 }]]),
    });
    const v = await classifyProc(row, c);
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("live-agent-owned");
  });
  test("cwd matches a live-agent cwd → spare(reason live-agent-owned)", async () => {
    const row = { pid: 10, ppid: 1, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const c = ctx({
      liveAgentCwds: new Set([`${WT_ROOT}/CTL-X`]),
      cwdForPid: () => `${WT_ROOT}/CTL-X`,
    });
    const v = await classifyProc(row, c);
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("live-agent-owned");
  });
  // CTL-1531: the command gate now admits a WIDENED class (any command, strict
  // ppid===1, deleted cwd under the worktree root). A non-killable command that
  // is NOT strictly ppid-1 still spares on the original reason.
  test("command not in killableCommands AND ppid!==1 → spare(reason command-not-killable)", async () => {
    const row = { pid: 10, ppid: 7, command: "python", etimeSec: 1000, args: "python x.py" };
    const v = await classifyProc(row, ctx());
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("command-not-killable");
  });
  test("not orphaned (has live ancestor) → spare(reason has-live-ancestor)", async () => {
    const row = { pid: 10, ppid: 5, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const c = ctx({ byPid: new Map([[5, { pid: 5, ppid: 100 }]]), cwdForPid: () => null });
    const v = await classifyProc(row, c);
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("has-live-ancestor");
  });
  test("lsof cwd unknown (null) → spare(reason cwd-unknown)", async () => {
    const row = { pid: 10, ppid: 1, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const v = await classifyProc(row, ctx({ cwdForPid: () => null }));
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("cwd-unknown");
  });
  test("cwd NOT under worktree root (interactive claude region) → spare(reason not-under-worktree-root)", async () => {
    const row = { pid: 10, ppid: 1, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const v = await classifyProc(row, ctx({ cwdForPid: () => "/Users/test/somewhere-else" }));
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("not-under-worktree-root");
  });
  test("etime below minEtimeSec → spare(reason too-young)", async () => {
    const row = { pid: 10, ppid: 1, command: "node", etimeSec: 100, args: "node x.mjs" };
    const v = await classifyProc(row, ctx({ minEtimeSec: 900 }));
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("too-young");
  });
  test("targeted worktreePath scopes the kill (boundary-safe: CTL-X ≠ CTL-X9)", async () => {
    const row = { pid: 10, ppid: 1, command: "node", etimeSec: 1000, args: "node x.mjs" };
    // candidate cwd under CTL-X9, sweep targets CTL-X → spared (out of scope)
    const c = ctx({
      worktreePath: `${WT_ROOT}/CTL-X`,
      cwdForPid: () => `${WT_ROOT}/CTL-X9`,
    });
    const v = await classifyProc(row, c);
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("outside-target-worktree");
  });
});

// ─── ProcReaper.sweep ────────────────────────────────────────────────────────

// Build a reaper with the canonical "one orphan node under a worktree" fixture.
function orphanFixture({ mode = "shadow", killAlive, agentsOk = true, extra = {} } = {}) {
  const ORPHAN_PID = 4242;
  const psLines = [
    psLine({ pid: ORPHAN_PID, ppid: 1, etime: "20:00", command: "node /x/foo.mjs" }),
  ];
  const emit = recordingEmit();
  const killProc = recordingKill({ alive: killAlive ?? new Set([ORPHAN_PID]) });
  const reaper = new ProcReaper({
    mode,
    worktreeRoot: WT_ROOT,
    graceMs: 5000,
    minEtimeSec: 900,
    psLister: () => psLines,
    lsofCwd: () => `${WT_ROOT}/CTL-X`,
    liveAgents: () => [],
    agentsResult: () => ({ ok: agentsOk, agents: [] }),
    killProc,
    sleep: async () => {},
    now: () => 0,
    selfPid: 1,
    daemonPids: [],
    emit,
    log: silentLog(),
    ...extra,
  });
  return { reaper, emit, killProc, ORPHAN_PID };
}

describe("ProcReaper.sweep — kill path (enforce)", () => {
  it("two-sweep persistence: first sweep spares, second sweep kills (SIGTERM→grace→SIGKILL)", async () => {
    const { reaper, emit, killProc, ORPHAN_PID } = orphanFixture({ mode: "enforce" });
    // Sweep 1: orphan seen once → NOT yet persisted across 2 sweeps → spared.
    const r1 = await reaper.sweep({});
    expect(r1.reaped).toHaveLength(0);
    expect(killProc.calls.filter(([, s]) => s !== 0)).toHaveLength(0);

    // Sweep 2: now persisted across 2 consecutive sweeps → killed.
    const r2 = await reaper.sweep({});
    expect(r2.reaped.map((x) => x.pid)).toContain(ORPHAN_PID);
    // SIGTERM first, then (re-probe alive) SIGKILL — never SIGKILL first.
    const signals = killProc.calls.map(([, s]) => s);
    expect(signals[0]).toBe("SIGTERM");
    expect(signals).toContain("SIGKILL");
    expect(signals.indexOf("SIGTERM")).toBeLessThan(signals.indexOf("SIGKILL"));
    const reapedEmits = emit.calls.filter((c) => c.type === "procOrphans.reaped");
    expect(reapedEmits.length).toBeGreaterThanOrEqual(1);
  });

  it("P2-i: a process that SURVIVES SIGKILL is NOT counted as reaped and emits no reclamation", async () => {
    // kill(2) returns on DELIVERY, not exit. A D-state process on a hung mount (or
    // an EPERM target) stays alive. The old code returned true unconditionally, so
    // the pid landed in report.reaped and emitted procOrphans.reaped while still
    // running — a phantom reclamation that would repeat on every single sweep.
    const { reaper, emit, killProc, ORPHAN_PID } = orphanFixture({
      mode: "enforce",
      killAlive: new Set([4242]),
      extra: { killProc: undefined },
    });
    // Rebuild the kill seam as a stubborn process.
    const stubborn = recordingKill({ alive: new Set([ORPHAN_PID]), survivesKill: true });
    reaper.killProc = stubborn;

    await reaper.sweep({}); // sweep 1 — persist
    const r2 = await reaper.sweep({}); // sweep 2 — act

    const signals = stubborn.calls.map(([, s]) => s);
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL"); // we DID try
    // ...but it never exited, so it must NOT be reported as reaped.
    expect(r2.reaped.map((x) => x.pid)).not.toContain(ORPHAN_PID);
    expect(emit.calls.filter((c) => c.type === "procOrphans.reaped")).toHaveLength(0);
  });

  it("P2-i: an unprobeable pid after SIGKILL fails CLOSED (not counted as reaped)", async () => {
    const { reaper, emit, ORPHAN_PID } = orphanFixture({ mode: "enforce" });
    const calls = [];
    reaper.killProc = (pid, signal) => {
      calls.push([pid, signal]);
      if (signal === 0) {
        // First re-probe (post-SIGTERM) says alive; every later probe THROWS.
        if (calls.filter(([, s]) => s === 0).length === 1) return true;
        throw new Error("EPERM: cannot probe");
      }
      return true;
    };
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    // Cannot prove it exited ⇒ under-report rather than emit a false reclamation.
    expect(r2.reaped.map((x) => x.pid)).not.toContain(ORPHAN_PID);
    expect(emit.calls.filter((c) => c.type === "procOrphans.reaped")).toHaveLength(0);
  });

  it("if the proc is gone after grace, SIGKILL is NOT sent", async () => {
    // killAlive empty → the post-grace re-probe (signal 0) throws ESRCH = gone.
    const { reaper, killProc, ORPHAN_PID } = orphanFixture({
      mode: "enforce",
      killAlive: new Set(), // gone after SIGTERM
    });
    await reaper.sweep({}); // sweep 1 (persist)
    const r2 = await reaper.sweep({}); // sweep 2 (act)
    const signals = killProc.calls.map(([, s]) => s);
    expect(signals).toContain("SIGTERM");
    expect(signals).not.toContain("SIGKILL");
    // It exited under SIGTERM → still counts as reaped.
    expect(r2.reaped.map((x) => x.pid)).toContain(ORPHAN_PID);
  });
});

describe("ProcReaper.sweep — shadow (default) + off", () => {
  it("shadow mode emits would-reap but kills NOTHING", async () => {
    const { reaper, emit, killProc, ORPHAN_PID } = orphanFixture({ mode: "shadow" });
    await reaper.sweep({}); // persist
    const r2 = await reaper.sweep({}); // would act
    expect(killProc.calls.filter(([, s]) => s !== 0)).toHaveLength(0);
    expect(r2.reaped).toHaveLength(0);
    expect(r2.wouldReap.map((x) => x.pid)).toContain(ORPHAN_PID);
    expect(emit.calls.some((c) => c.type === "procOrphans.would-reap")).toBe(true);
  });

  it("default mode is shadow (constructed without mode)", () => {
    const reaper = new ProcReaper({ psLister: () => [], log: silentLog() });
    expect(reaper.mode).toBe("shadow");
  });

  it("off mode → empty report, no emit, no kill", async () => {
    const { reaper, emit, killProc } = orphanFixture({ mode: "off" });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped).toHaveLength(0);
    expect(r2.wouldReap).toHaveLength(0);
    expect(killProc.calls).toHaveLength(0);
    expect(emit.calls).toHaveLength(0);
  });
});

describe("ProcReaper.sweep — allowlist + live-tree sparing", () => {
  it("allowlisted daemon/broker/monitor/self NEVER killed even when they look orphaned", async () => {
    const psLines = [
      psLine({ pid: 11, ppid: 1, etime: "99:00", command: "node /x/execution-core/daemon.mjs" }),
      psLine({ pid: 12, ppid: 1, etime: "99:00", command: "node /x/broker/index.mjs" }),
      psLine({ pid: 13, ppid: 1, etime: "99:00", command: "bun /x/orch-monitor/server.ts" }),
      psLine({ pid: 14, ppid: 1, etime: "99:00", command: "node selfproc.mjs" }), // pid === selfPid
    ];
    const emit = recordingEmit();
    const killProc = recordingKill({ alive: new Set([11, 12, 13, 14]) });
    const reaper = new ProcReaper({
      mode: "enforce",
      worktreeRoot: WT_ROOT,
      psLister: () => psLines,
      lsofCwd: () => `${WT_ROOT}/CTL-X`,
      liveAgents: () => [],
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc,
      sleep: async () => {},
      now: () => 0,
      selfPid: 14,
      daemonPids: [],
      emit,
      log: silentLog(),
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped).toHaveLength(0);
    expect(killProc.calls.filter(([, s]) => s !== 0)).toHaveLength(0);
    expect(r2.spared.length).toBeGreaterThanOrEqual(4);
  });

  it("live-agent-owned process tree spared (cwd match OR subtree pid)", async () => {
    // ps: a node child (pid 250) of a live agent root (pid 100).
    const psLines = [
      psLine({ pid: 100, ppid: 1, etime: "99:00", command: "claude --bg" }),
      psLine({ pid: 250, ppid: 100, etime: "99:00", command: "node mcp.mjs" }),
    ];
    const emit = recordingEmit();
    const killProc = recordingKill({ alive: new Set([250]) });
    const reaper = new ProcReaper({
      mode: "enforce",
      worktreeRoot: WT_ROOT,
      psLister: () => psLines,
      lsofCwd: () => `${WT_ROOT}/CTL-X`,
      liveAgents: () => [{ pid: 100, cwd: `${WT_ROOT}/CTL-X` }],
      agentsResult: () => ({ ok: true, agents: [{ pid: 100, cwd: `${WT_ROOT}/CTL-X` }] }),
      killProc,
      sleep: async () => {},
      now: () => 0,
      selfPid: 1,
      daemonPids: [],
      emit,
      log: silentLog(),
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped).toHaveLength(0);
    expect(killProc.calls.filter(([, s]) => s !== 0)).toHaveLength(0);
  });

  it("live-agent cwd protection (gate 7) uses the fresh agents read, not a stale cache", async () => {
    // An ORPHANED node (pid 250, ppid 1) sharing a live agent's worktree cwd.
    // isOrphaned does NOT save it (reparented to launchd), so it is spared ONLY
    // by the cwd gate — and that live-agent cwd set must come from the
    // catastrophe-guard's fresh agentsResult, NOT a stale/cold cache. With the
    // pre-hardening code (LIVE_TREE/cwds from a separate cached liveAgents that
    // returned []), this orphan would have been killed.
    const psLines = [
      psLine({ pid: 250, ppid: 1, etime: "99:00", command: "node leftover.mjs" }),
    ];
    const emit = recordingEmit();
    const killProc = recordingKill({ alive: new Set([250]) });
    const reaper = new ProcReaper({
      mode: "enforce",
      worktreeRoot: WT_ROOT,
      psLister: () => psLines,
      lsofCwd: () => `${WT_ROOT}/CTL-X`,
      liveAgents: () => [], // a stale/cold cache — MUST be ignored now
      agentsResult: () => ({ ok: true, agents: [{ pid: 100, cwd: `${WT_ROOT}/CTL-X` }] }),
      killProc,
      sleep: async () => {},
      now: () => 0,
      selfPid: 1,
      daemonPids: [],
      emit,
      log: silentLog(),
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "live-agent-owned")).toBe(true);
    expect(killProc.calls.filter(([, s]) => s !== 0)).toHaveLength(0);
  });

  it("spares a reparented grandchild running from a SUBDIR under a live agent's worktree (prefix cwd guard)", async () => {
    // An orphaned (ppid 1) node whose cwd is a SUBDIR of a live agent's worktree
    // — a reparented MCP-server / bun-test grandchild. Byte-exact cwd matching
    // would kill it (it left LIVE_TREE and its exact cwd isn't an agent's cwd);
    // the prefix-aware gate 6 spares it as live-agent-owned.
    const psLines = [
      psLine({ pid: 260, ppid: 1, etime: "99:00", command: "node mcp-server.mjs" }),
    ];
    const emit = recordingEmit();
    const killProc = recordingKill({ alive: new Set([260]) });
    const reaper = new ProcReaper({
      mode: "enforce",
      worktreeRoot: WT_ROOT,
      psLister: () => psLines,
      lsofCwd: () => `${WT_ROOT}/CTL-X/plugins/dev/scripts/execution-core`,
      agentsResult: () => ({ ok: true, agents: [{ pid: 100, cwd: `${WT_ROOT}/CTL-X` }] }),
      killProc,
      sleep: async () => {},
      now: () => 0,
      selfPid: 1,
      daemonPids: [],
      emit,
      log: silentLog(),
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "live-agent-owned")).toBe(true);
    expect(killProc.calls.filter(([, s]) => s !== 0)).toHaveLength(0);
  });

  it("does NOT SIGKILL when the pid is reused under a different argv during the grace window", async () => {
    // A killable orphan persists two sweeps → enforce SIGTERMs it. During the
    // grace window the pid is recycled into a DIFFERENT node/bun process (new
    // argv). The pre-SIGKILL re-match keys on FULL argv, so the innocent reused
    // pid must NOT be SIGKILL'd.
    const orphanLine = psLine({ pid: 270, ppid: 1, etime: "99:00", command: "node worker-a.mjs" });
    const reusedLine = psLine({ pid: 270, ppid: 1, etime: "00:05", command: "bun unrelated.mjs" });
    let psCall = 0;
    const psLister = () => {
      psCall += 1;
      // sweep1 snapshot (1) + sweep2 snapshot (2) → original; grace re-snapshot (3) → reused
      return psCall <= 2 ? [orphanLine] : [reusedLine];
    };
    const emit = recordingEmit();
    const killProc = recordingKill({ alive: new Set([270]) });
    const reaper = new ProcReaper({
      mode: "enforce",
      worktreeRoot: WT_ROOT,
      psLister,
      lsofCwd: () => `${WT_ROOT}/CTL-X`,
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc,
      sleep: async () => {},
      now: () => 0,
      selfPid: 1,
      daemonPids: [],
      emit,
      log: silentLog(),
    });
    await reaper.sweep({}); // sweep 1: first sighting → awaiting-second
    const r2 = await reaper.sweep({}); // sweep 2: persisted → SIGTERM, grace, re-match fails → NO SIGKILL
    expect(killProc.calls.filter(([, s]) => s === "SIGTERM")).toHaveLength(1);
    expect(killProc.calls.filter(([, s]) => s === "SIGKILL")).toHaveLength(0);
    expect(r2.reaped).toHaveLength(0);
  });

  it("interactive claude + children spared (cwd NOT under worktree root)", async () => {
    const psLines = [
      psLine({ pid: 300, ppid: 1, etime: "99:00", command: "node tool.mjs" }),
    ];
    const emit = recordingEmit();
    const killProc = recordingKill({ alive: new Set([300]) });
    const reaper = new ProcReaper({
      mode: "enforce",
      worktreeRoot: WT_ROOT,
      psLister: () => psLines,
      // cwd is the user's home, NOT under ~/catalyst/wt → the under-wt signal is REQUIRED.
      lsofCwd: () => "/Users/test/projects/myapp",
      liveAgents: () => [],
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc,
      sleep: async () => {},
      now: () => 0,
      selfPid: 1,
      daemonPids: [],
      emit,
      log: silentLog(),
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "not-under-worktree-root")).toBe(true);
  });
});

describe("ProcReaper.sweep — degrade-safe + CATASTROPHE GUARD", () => {
  it("CATASTROPHE GUARD: agents read {ok:false} ABORTS the whole sweep, kills nothing", async () => {
    const { reaper, emit, killProc } = orphanFixture({ mode: "enforce", agentsOk: false });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(killProc.calls.filter(([, s]) => s !== 0)).toHaveLength(0);
    expect(r2.reaped).toHaveLength(0);
    expect(r2.wouldReap).toHaveLength(0);
    // distinct from a genuine empty list — emit a degraded-skip flag.
    expect(emit.calls.some((c) => c.type === "procOrphans.spared")).toBe(true);
    const degraded = emit.calls.find((c) => c.type === "procOrphans.spared");
    expect(degraded.fields.reason).toBe("agents-unreadable");
  });

  it("a genuine empty agents list ({ok:true, agents:[]}) is NOT a catastrophe — sweep proceeds", async () => {
    // The canonical orphan fixture already uses agents:[] ok:true; it kills on sweep 2.
    const { reaper, killProc, ORPHAN_PID } = orphanFixture({ mode: "enforce", agentsOk: true });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped.map((x) => x.pid)).toContain(ORPHAN_PID);
  });

  it("lsof cwd null (ambiguous) → spared cwd-unknown, never killed", async () => {
    const { reaper, killProc } = orphanFixture({
      mode: "enforce",
      extra: { lsofCwd: () => null },
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(killProc.calls.filter(([, s]) => s !== 0)).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "cwd-unknown")).toBe(true);
  });

  it("an unreadable ps snapshot degrades safe (empty report, no kill)", async () => {
    const killProc = recordingKill();
    const reaper = new ProcReaper({
      mode: "enforce",
      worktreeRoot: WT_ROOT,
      psLister: () => {
        throw new Error("ps boom");
      },
      lsofCwd: () => `${WT_ROOT}/CTL-X`,
      liveAgents: () => [],
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc,
      sleep: async () => {},
      now: () => 0,
      selfPid: 1,
      emit: recordingEmit(),
      log: silentLog(),
    });
    const r = await reaper.sweep({});
    expect(r.reaped).toHaveLength(0);
    expect(killProc.calls).toHaveLength(0);
  });
});

describe("ProcReaper.sweep — async psLister / lsofCwd seams", () => {
  it("awaits an async psLister snapshot (shadow mode would-reap path)", async () => {
    const liveAgents = { ok: true, agents: [] };
    const psLines = [
      "1001 1 900000 20:00 node /Users/ryanrozich/catalyst/wt/CTL-999/x.mjs",
    ];
    const reaper = new ProcReaper({
      mode: "shadow",
      worktreeRoot: "/Users/ryanrozich/catalyst/wt",
      minEtimeSec: 0,
      agentsResult: () => liveAgents,
      psLister: async () => psLines,
      lsofCwd: async () => "/Users/ryanrozich/catalyst/wt/CTL-999",
      emit: async () => true,
      log: silentLog(),
    });
    await reaper.sweep();
    const report = await reaper.sweep();
    expect(report.wouldReap.map((r) => r.pid)).toContain(1001);
  });

  it("spares when async lsofCwd rejects (cwd-unknown → degrade safe)", async () => {
    const reaper = new ProcReaper({
      mode: "enforce",
      worktreeRoot: "/Users/ryanrozich/catalyst/wt",
      minEtimeSec: 0,
      agentsResult: () => ({ ok: true, agents: [] }),
      psLister: async () => ["1001 1 900000 20:00 node /x/y.mjs"],
      lsofCwd: async () => { throw new Error("lsof failed"); },
      killProc: () => { throw new Error("must not kill"); },
      emit: async () => true,
      log: silentLog(),
    });
    await reaper.sweep();
    const report = await reaper.sweep();
    expect(report.reaped).toEqual([]);
  });
});

describe("ProcReaper.sweep — targeted teardown sweep", () => {
  it("sweep({worktreePath}) scopes to one worktree (CTL-X ≠ CTL-X9), sibling untouched", async () => {
    const psLines = [
      psLine({ pid: 700, ppid: 1, etime: "99:00", command: "node a.mjs" }), // under CTL-X
      psLine({ pid: 800, ppid: 1, etime: "99:00", command: "node b.mjs" }), // under CTL-X9
    ];
    const cwdMap = { 700: `${WT_ROOT}/CTL-X`, 800: `${WT_ROOT}/CTL-X9` };
    const emit = recordingEmit();
    const killProc = recordingKill({ alive: new Set([700, 800]) });
    const reaper = new ProcReaper({
      mode: "enforce",
      worktreeRoot: WT_ROOT,
      psLister: () => psLines,
      lsofCwd: (pid) => cwdMap[pid] ?? null,
      liveAgents: () => [],
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc,
      sleep: async () => {},
      now: () => 0,
      selfPid: 1,
      emit,
      log: silentLog(),
    });
    await reaper.sweep({ worktreePath: `${WT_ROOT}/CTL-X` });
    const r2 = await reaper.sweep({ worktreePath: `${WT_ROOT}/CTL-X` });
    expect(r2.reaped.map((x) => x.pid)).toContain(700);
    expect(r2.reaped.map((x) => x.pid)).not.toContain(800); // sibling untouched
    expect(killProc.calls.some(([pid]) => pid === 800 && killProc.calls)).toBe(false);
    expect(killProc.calls.filter(([pid, s]) => pid === 800 && s !== 0)).toHaveLength(0);
  });
});

// ─── CTL-1531: the WIDENED any-command orphan class ──────────────────────────
//
// The motivating incident (2026-07-25→26): four `sh -c "while :; do :; done"`
// processes pegged ~4 cores for 16.5h. cwd = ~/catalyst/wt/evergreen/evr-23, a
// DELETED worktree; PPID 1. `killableCommands = {node,bun}` made them invisible.
//
// The widening gates on OWNERSHIP EVIDENCE instead of the command name:
//   cwd under the worktree root  AND  cwd path no longer exists  AND  ppid === 1
// It is admitted as an OR *inside* the command gate, so EVERY downstream gate
// (orphan / cwd-known / live-agent / under-wt / target-worktree / etime) plus
// the allowlist and LIVE_TREE gates ahead of it still run on the widened row.

const SH_ARGS = "sh -c while :; do :; done";

function shRow(overrides = {}) {
  return { pid: 4444, ppid: 1, command: "sh", etimeSec: 59400, args: SH_ARGS, ...overrides };
}

describe("CTL-1531 classifyProc — widened any-command orphan class", () => {
  test("non-node/bun orphan with DELETED cwd under the worktree root → kill", async () => {
    const v = await classifyProc(
      shRow(),
      ctx({ cwdForPid: () => `${WT_ROOT}/evergreen/evr-23`, cwdExists: () => false })
    );
    expect(v.action).toBe("kill");
    expect(v.reason).toBe("orphan-any-command-deleted-cwd");
    expect(v.widened).toBe(true);
  });

  test("same process but cwd is a LIVE worktree → spare(reason cwd-still-exists)", async () => {
    const v = await classifyProc(
      shRow(),
      ctx({ cwdForPid: () => `${WT_ROOT}/CTL-999`, cwdExists: () => true })
    );
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("cwd-still-exists");
  });

  test("same process but cwd OUTSIDE the worktree root → spare(not-under-worktree-root) even with a deleted cwd", async () => {
    const v = await classifyProc(
      shRow(),
      ctx({ cwdForPid: () => "/Users/test/scratch/deleted-dir", cwdExists: () => false })
    );
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("not-under-worktree-root");
  });

  test("PPID !== 1 (live parent) → NOT widened, spare(command-not-killable)", async () => {
    const v = await classifyProc(
      shRow({ ppid: 5000 }),
      ctx({ byPid: new Map([[5000, { pid: 5000, ppid: 1 }]]), cwdExists: () => false })
    );
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("command-not-killable");
  });

  test("STRICT ppid===1: a vanished-parent orphan (isOrphaned true, ppid!==1) is NOT widened", async () => {
    // isOrphaned() also returns true when the parent is absent from the ps
    // snapshot. That branch is a snapshot RACE and must never admit an
    // arbitrary command — the widened class requires literal ppid === 1.
    expect(isOrphaned({ pid: 4444, ppid: 9999 }, new Map())).toBe(true);
    const v = await classifyProc(shRow({ ppid: 9999 }), ctx({ cwdExists: () => false }));
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("command-not-killable");
  });

  test("cwd probe unavailable (null) → spare(cwd-unknown) — FAIL CLOSED", async () => {
    const v = await classifyProc(shRow(), ctx({ cwdForPid: () => null }));
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("cwd-unknown");
  });

  test("cwd-exists probe unavailable (null) → spare(cwd-exists-unknown) — FAIL CLOSED", async () => {
    const v = await classifyProc(shRow(), ctx({ cwdExists: () => null }));
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("cwd-exists-unknown");
  });

  test("allowlisted argv still wins over the widened class", async () => {
    const row = shRow({ args: "sh -c bun run /x/broker/index.mjs" });
    const v = await classifyProc(row, ctx({ cwdExists: () => false }));
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("allowlisted");
  });

  test("allowlisted pid (self / daemon / LIVE_TREE) still wins over the widened class", async () => {
    const v = await classifyProc(
      shRow({ pid: 77 }),
      ctx({ allowlist: buildAllowlist({ selfPid: 77 }), cwdExists: () => false })
    );
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("allowlisted");
  });

  test("a live agent's cwd prefix still spares the widened class", async () => {
    const v = await classifyProc(
      shRow(),
      ctx({
        liveAgentCwds: new Set([`${WT_ROOT}/CTL-X`]),
        cwdForPid: () => `${WT_ROOT}/CTL-X/sub`,
        cwdExists: () => false,
      })
    );
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("live-agent-owned");
  });

  test("etime floor still applies to the widened class", async () => {
    const v = await classifyProc(shRow({ etimeSec: 10 }), ctx({ cwdExists: () => false }));
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("too-young");
  });

  test("targeted worktreePath scope still applies to the widened class", async () => {
    const v = await classifyProc(
      shRow(),
      ctx({
        worktreePath: `${WT_ROOT}/CTL-X`,
        cwdForPid: () => `${WT_ROOT}/CTL-X9`,
        cwdExists: () => false,
      })
    );
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("outside-target-worktree");
  });

  test("REGRESSION: node/bun keep the legacy predicate — a LIVE cwd is still killable", async () => {
    // The widened deleted-cwd conjunct must apply to the widened class ONLY.
    // Narrowing node/bun to "deleted cwd" would silently drop existing coverage.
    const row = { pid: 10, ppid: 1, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const v = await classifyProc(row, ctx({ cwdExists: () => true }));
    expect(v.action).toBe("kill");
    expect(v.reason).toBe("orphan-node-under-worktree");
    expect(v.widened).toBe(false);
  });

  test("REGRESSION: node/bun with a VANISHED parent (ppid!==1) are still killable", async () => {
    const row = { pid: 10, ppid: 9999, command: "bun", etimeSec: 1000, args: "bun x.mjs" };
    const v = await classifyProc(row, ctx({ cwdExists: () => true }));
    expect(v.action).toBe("kill");
  });
});

// A `sh -c` runaway fixture: PPID 1, cwd = a DELETED worktree under the root.
function shOrphanFixture({
  mode = "shadow",
  // CTL-1531 P1-a: the widened class answers to its OWN mode. Every fixture that
  // expects an actual reap must open BOTH gates explicitly — which is the point
  // of the knob, and is asserted directly by the "widenMode staging" describe.
  widenMode = "enforce",
  agentsOk = true,
  extra = {},
} = {}) {
  const SH_PID = 4444;
  const GONE_WT = `${WT_ROOT}/evergreen/evr-23`;
  const psLines = [`${SH_PID} 1 1200 16:30:00 ${SH_ARGS}`];
  const emit = recordingEmit();
  const killProc = recordingKill({ alive: new Set([SH_PID]) });
  const reaper = new ProcReaper({
    mode,
    widenMode,
    worktreeRoot: WT_ROOT,
    graceMs: 5000,
    minEtimeSec: 900,
    psLister: () => psLines,
    lsofCwd: () => GONE_WT,
    cwdExists: () => false, // the worktree was deleted out from under it
    // CTL-1531 round 2: the worktree ROOT is present. It gets its own seam because it answers a different question from a candidate's cwd, and the widened class is DISABLED for the whole sweep unless the root is definitely there (a missing root makes EVERY cwd under it look gone at once).
    worktreeRootExists: () => true,
    agentsResult: () => ({ ok: agentsOk, agents: [] }),
    killProc,
    sleep: async () => {},
    selfPid: 1,
    parentPid: 2,
    daemonPids: [],
    emit,
    log: silentLog(),
    ...extra,
  });
  return { reaper, emit, killProc, SH_PID, GONE_WT };
}

describe("CTL-1531 ProcReaper.sweep — widened class end-to-end", () => {
  it("SHADOW (the default): the `sh` runaway is REPORTED as would-reap and killed NOTHING", async () => {
    const { reaper, emit, killProc, SH_PID } = shOrphanFixture({ mode: "shadow" });
    await reaper.sweep({}); // sweep 1 — two-sweep persistence
    const r2 = await reaper.sweep({});
    expect(killProc.calls.filter(([, s]) => s !== 0)).toHaveLength(0);
    expect(r2.reaped).toHaveLength(0);
    expect(r2.wouldReap.map((x) => x.pid)).toContain(SH_PID);
    const entry = r2.wouldReap.find((x) => x.pid === SH_PID);
    expect(entry.command).toBe("sh");
    expect(entry.widened).toBe(true);
    expect(entry.reason).toBe("orphan-any-command-deleted-cwd");
  });

  it("SHADOW: the would-reap event carries the widened reason so the new class is separable in Loki", async () => {
    const { emit, reaper } = shOrphanFixture({ mode: "shadow" });
    await reaper.sweep({});
    await reaper.sweep({});
    const ev = emit.calls.find((c) => c.type === "procOrphans.would-reap");
    expect(ev).toBeDefined();
    expect(ev.fields.command).toBe("sh");
    expect(ev.fields.reason).toBe("orphan-any-command-deleted-cwd");
  });

  it("SHADOW: the newly-visible candidate is LOGGED clearly (widened flagged)", async () => {
    const lines = [];
    const log = {
      info: (f, m) => lines.push({ f, m }),
      warn: () => {},
      error: () => {},
    };
    const { reaper } = shOrphanFixture({ mode: "shadow", extra: { log } });
    await reaper.sweep({});
    await reaper.sweep({});
    const hit = lines.find((l) => l.f?.widened === true && l.f?.pid === 4444);
    expect(hit).toBeDefined();
    expect(hit.m.toLowerCase()).toContain("widened");
    // CTL-1531 P1-d: the command BASENAME identifies the candidate; the full
    // argv must NOT be here (see the credential-disclosure describe below).
    expect(hit.f.command).toBe("sh");
    expect(hit.f.reason).toBe("orphan-any-command-deleted-cwd");
  });

  it("ENFORCE (explicit opt-in only): the `sh` runaway is reaped after two sweeps", async () => {
    const { reaper, killProc, SH_PID } = shOrphanFixture({
      mode: "enforce",
      widenMode: "enforce",
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped.map((x) => x.pid)).toContain(SH_PID);
    const signals = killProc.calls.map(([, s]) => s);
    expect(signals.indexOf("SIGTERM")).toBeLessThan(signals.indexOf("SIGKILL"));
  });

  it("a LIVE worktree cwd → the `sh` process is spared, never killed (enforce)", async () => {
    const { reaper, killProc } = shOrphanFixture({
      mode: "enforce",
      extra: { cwdExists: () => true, killProc: () => { throw new Error("must not kill"); } },
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "cwd-still-exists")).toBe(true);
  });

  it("cwd OUTSIDE the worktree root is NEVER a candidate regardless of ppid/command (enforce)", async () => {
    const { reaper } = shOrphanFixture({
      mode: "enforce",
      extra: {
        lsofCwd: () => "/Users/test/tmp/deleted-scratch",
        cwdExists: () => false,
        killProc: () => { throw new Error("must not kill"); },
      },
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "not-under-worktree-root")).toBe(true);
  });

  it("a throwing cwd-exists probe degrades safe (enforce kills nothing)", async () => {
    const { reaper } = shOrphanFixture({
      mode: "enforce",
      extra: {
        cwdExists: () => { throw new Error("stat boom"); },
        killProc: () => { throw new Error("must not kill"); },
      },
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "cwd-exists-unknown")).toBe(true);
  });

  it("CATASTROPHE GUARD still aborts the widened class too", async () => {
    const { reaper, killProc, emit } = shOrphanFixture({ mode: "enforce", agentsOk: false });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(killProc.calls.filter(([, s]) => s !== 0)).toHaveLength(0);
    expect(r2.reaped).toHaveLength(0);
    expect(emit.calls.some((c) => c.fields?.reason === "agents-unreadable")).toBe(true);
  });

  it("SELF-PROTECTION: the reaper never selects its own pid or its parent pid", async () => {
    const psLines = [
      `901 1 1200 16:30:00 ${SH_ARGS}`, // == selfPid
      `902 1 1200 16:30:00 ${SH_ARGS}`, // == parentPid
      `903 1 1200 16:30:00 ${SH_ARGS}`, // an unrelated widened orphan
    ];
    const killProc = recordingKill({ alive: new Set([901, 902, 903]) });
    const reaper = new ProcReaper({
      mode: "enforce",
      widenMode: "enforce",
      worktreeRoot: WT_ROOT,
      minEtimeSec: 900,
      psLister: () => psLines,
      lsofCwd: () => `${WT_ROOT}/evergreen/evr-23`,
      cwdExists: () => false,
      // CTL-1531 round 2: the worktree ROOT is present. It gets its own seam because it answers a different question from a candidate's cwd, and the widened class is DISABLED for the whole sweep unless the root is definitely there (a missing root makes EVERY cwd under it look gone at once).
      worktreeRootExists: () => true,
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc,
      sleep: async () => {},
      selfPid: 901,
      parentPid: 902,
      emit: recordingEmit(),
      log: silentLog(),
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    const reapedPids = r2.reaped.map((x) => x.pid);
    expect(reapedPids).not.toContain(901);
    expect(reapedPids).not.toContain(902);
    expect(reapedPids).toContain(903);
    expect(killProc.calls.filter(([p, s]) => p === 901 && s !== 0)).toHaveLength(0);
    expect(killProc.calls.filter(([p, s]) => p === 902 && s !== 0)).toHaveLength(0);
  });

  it("two-sweep argv persistence still guards pid reuse for the widened class", async () => {
    // `sh` pids recycle far faster than node/bun pids, so the full-argv match is
    // strictly MORE load-bearing here.
    const first = `4444 1 1200 16:30:00 ${SH_ARGS}`;
    const reused = `4444 1 1200 00:20:00 sh -c echo hello`;
    let n = 0;
    const killProc = recordingKill({ alive: new Set([4444]) });
    const reaper = new ProcReaper({
      mode: "enforce",
      worktreeRoot: WT_ROOT,
      minEtimeSec: 900,
      psLister: () => (++n === 1 ? [first] : [reused]),
      lsofCwd: () => `${WT_ROOT}/evergreen/evr-23`,
      cwdExists: () => false,
      // CTL-1531 round 2: the worktree ROOT is present. It gets its own seam because it answers a different question from a candidate's cwd, and the widened class is DISABLED for the whole sweep unless the root is definitely there (a missing root makes EVERY cwd under it look gone at once).
      worktreeRootExists: () => true,
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc,
      sleep: async () => {},
      selfPid: 1,
      parentPid: 2,
      emit: recordingEmit(),
      log: silentLog(),
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped).toHaveLength(0);
    expect(killProc.calls.filter(([, s]) => s !== 0)).toHaveLength(0);
  });

  it("defaults are unchanged: shadow mode, killableCommands = {node,bun}, a real cwdExists seam", () => {
    const reaper = new ProcReaper({ psLister: () => [], log: silentLog() });
    expect(reaper.mode).toBe("shadow");
    expect([...reaper.killableCommands].sort()).toEqual(["bun", "node"]);
    expect(typeof reaper.cwdExists).toBe("function");
    // The default probe answers a real boolean for a path that certainly exists.
    expect(reaper.cwdExists(process.cwd())).toBe(true);
  });
});

describe("CTL-1531 buildAllowlist — parentPid self-protection", () => {
  test("parentPid joins selfPid/daemonPids/LIVE_TREE in the never-kill pid set", () => {
    const allow = buildAllowlist({ selfPid: 42, parentPid: 43, daemonPids: [7] });
    expect(allow.pids.has(42)).toBe(true);
    expect(allow.pids.has(43)).toBe(true);
    expect(allow.pids.has(7)).toBe(true);
  });
});

// ─── CTL-1531 review #3/#4 — the widened-class command DENYLIST ──────────────
//
// A tmux/screen server is ppid-1 BY CONSTRUCTION and inherits its cwd from the
// shell that started it, so under the widened (any-command) admission it is a
// syntactically perfect candidate and ONE kill closes every pane the operator
// has open. The shell sibling has guarded this since the first draft; the mjs
// side shipped with only DEFAULT_ALLOWLIST_PATTERNS.

describe("CTL-1531 isCommandDenylisted", () => {
  // The exact strings the shell-side review measured. A bare `^tmux$` anchor
  // matches NONE of the first two — the trailing `:` of setproctitle's
  // `progname: ` form is what defeated the original regex.
  test("matches the `progname: ` setproctitle form (the form these procs ACTUALLY advertise)", () => {
    expect(isCommandDenylisted("tmux: server (/private/tmp/tmux-501/default)", "tmux:")).toBe(true);
    expect(isCommandDenylisted("sshd: ryan [priv]", "sshd:")).toBe(true);
  });

  test("matches the plain absolute-path form too", () => {
    expect(isCommandDenylisted("/opt/homebrew/bin/tmux new-session", "tmux")).toBe(true);
  });

  test("matches a denied program hidden PAST argv[0] (full-argv scan)", () => {
    expect(isCommandDenylisted("nohup /usr/local/bin/thing", "nohup")).toBe(true);
    expect(isCommandDenylisted("/usr/bin/env screen -S build", "env")).toBe(true);
  });

  test("case-insensitive (GNU screen's server advertises itself as SCREEN)", () => {
    expect(isCommandDenylisted("SCREEN -S foo", "screen")).toBe(true);
  });

  test("does NOT deny the motivating incident argv — the widening must still work", () => {
    expect(isCommandDenylisted("sh -c while :; do :; done", "sh")).toBe(false);
    expect(isCommandDenylisted("bun run /x/foo.ts", "bun")).toBe(false);
  });

  test("substring-only lookalikes are NOT denied (anchored, not a substring match)", () => {
    expect(isCommandDenylisted("/x/sshd_helper.py run", "sshd_helper.py")).toBe(false);
    expect(isCommandDenylisted("/x/tmuxinator start", "tmuxinator")).toBe(false);
  });

  test("non-string / empty input → false (never throws)", () => {
    expect(isCommandDenylisted(null, null)).toBe(false);
    expect(isCommandDenylisted("", "")).toBe(false);
  });
});

describe("CTL-1531 classifyProc — denylist applies to the WIDENED class only", () => {
  test("a ppid-1 `tmux: server` with a deleted cwd under the wt root is SPARED", async () => {
    const row = {
      pid: 900,
      ppid: 1,
      command: "tmux:",
      etimeSec: 100000,
      args: "tmux: server (/private/tmp/tmux-501/default)",
    };
    const v = await classifyProc(row, ctx());
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("command-denylisted");
  });

  test("the same shape with a non-denied command is still KILLED (denylist is not a blanket bail)", async () => {
    const row = { pid: 901, ppid: 1, command: "sh", etimeSec: 100000, args: "sh -c while :; do :; done" };
    const v = await classifyProc(row, ctx());
    expect(v.action).toBe("kill");
    expect(v.widened).toBe(true);
  });

  test("node/bun are NEVER denied — the legacy class keeps its exact pre-CTL-1531 reach", async () => {
    // `node` is not on the denylist, but prove the gate is widened-only by
    // routing a would-be-denied argv through the killable-command path.
    const row = { pid: 902, ppid: 1, command: "node", etimeSec: 100000, args: "node /x/tmux/build.mjs" };
    const v = await classifyProc(row, ctx({ cwdExists: () => true }));
    expect(v.action).toBe("kill");
    expect(v.widened).toBe(false);
  });
});

// ─── CTL-1531 review #1 — batched cwd resolution (the 93x regression) ────────
//
// The widened admission stopped gate (3) from being the cheap bail: on a real
// host it cut the rows spared before the cwd probe from ~1344 to ~286, pushing
// ~1061 extra rows into a SEQUENTIAL per-pid execFile. At ~55ms of node spawn
// overhead each that is a 585ms → 54,525ms sweep — on the execution-core
// daemon's event loop, off the 600s reaper timer.

describe("CTL-1531 parseLsofCwdBatch", () => {
  test("parses the `lsof -Fpn` record stream into pid → cwd", () => {
    const out = parseLsofCwdBatch("p407\nfcwd\nn/Users/ryan\np630\nfcwd\nn/\np9\nfcwd\nn/tmp/x\n");
    expect(out.get(407)).toBe("/Users/ryan");
    expect(out.get(630)).toBe("/");
    expect(out.get(9)).toBe("/tmp/x");
    expect(out.size).toBe(3);
  });

  test("a pid with no `n` record is ABSENT (unknown → the caller spares)", () => {
    const out = parseLsofCwdBatch("p1\nfcwd\np2\nfcwd\nn/a\n");
    expect(out.has(1)).toBe(false);
    expect(out.get(2)).toBe("/a");
  });

  test("takes only the FIRST n record per pid and ignores junk/empty lines", () => {
    const out = parseLsofCwdBatch("p5\nfcwd\nn/first\nn/second\n\nzzz\np0\nn/bad-pid\n");
    expect(out.get(5)).toBe("/first");
    expect(out.has(0)).toBe(false);
  });

  test("empty / non-string input → empty map (never throws)", () => {
    expect(parseLsofCwdBatch("").size).toBe(0);
    expect(parseLsofCwdBatch(null).size).toBe(0);
    expect(parseLsofCwdBatch(undefined).size).toBe(0);
  });

  // A timed-out lsof still yields its partial stdout (execFileTolerant keeps it),
  // and that stream can stop mid-line. A truncated path would be a REAL,
  // currently-nonexistent path under the worktree root — it would manufacture a
  // perfect widened kill candidate for a process whose cwd is somewhere else.
  test("an UNTERMINATED trailing record is discarded, not read as a real cwd", () => {
    const truncated = "p10\nfcwd\nn/Users/ryan/wt/CTL-1\np11\nfcwd\nn/Users/ryan/wt/CTL-2";
    const out = parseLsofCwdBatch(truncated);
    expect(out.get(10)).toBe("/Users/ryan/wt/CTL-1"); // complete record, kept
    expect(out.has(11)).toBe(false); // truncated record, dropped → unknown → spare
  });

  test("a truncated `p` header alone cannot mis-key a later path", () => {
    const out = parseLsofCwdBatch("p10\nfcwd\nn/a\np1");
    expect(out.get(10)).toBe("/a");
    expect(out.size).toBe(1);
  });
});

describe("CTL-1531 ProcReaper.sweep — ONE batched cwd probe, not one per pid", () => {
  // 300 rows that all clear the cheap gates and therefore all need a cwd. The
  // pre-fix loop issued 300 execFiles; the fix issues exactly one batch call.
  function bigFixture(extra = {}) {
    const rows = [];
    for (let i = 0; i < 300; i++) {
      rows.push(psLine({ pid: 5000 + i, ppid: 1, etime: "30:00", command: "sh -c while :; do :; done" }));
    }
    const batchCalls = [];
    const singleCalls = [];
    return {
      batchCalls,
      singleCalls,
      reaper: new ProcReaper({
        mode: "shadow",
        worktreeRoot: WT_ROOT,
        psLister: () => rows,
        lsofCwd: (pid) => {
          singleCalls.push(pid);
          return `${WT_ROOT}/CTL-X`;
        },
        lsofCwdBatch: (pids) => {
          batchCalls.push([...pids]);
          return new Map(pids.map((p) => [p, `${WT_ROOT}/CTL-X`]));
        },
        cwdExists: () => false,
        // CTL-1531 round 2: the worktree ROOT is present. It gets its own seam because it answers a different question from a candidate's cwd, and the widened class is DISABLED for the whole sweep unless the root is definitely there (a missing root makes EVERY cwd under it look gone at once).
        worktreeRootExists: () => true,
        agentsResult: () => ({ ok: true, agents: [] }),
        killProc: recordingKill(),
        sleep: async () => {},
        selfPid: 1,
        parentPid: 2,
        emit: recordingEmit(),
        log: silentLog(),
        ...extra,
      }),
    };
  }

  it("resolves 300 candidate cwds in ONE batch call and ZERO per-pid calls", async () => {
    const { reaper, batchCalls, singleCalls } = bigFixture();
    await reaper.sweep({});
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toHaveLength(300);
    expect(singleCalls).toHaveLength(0);
  });

  it("the batch is asked ONLY for pids that actually reach the cwd probe", async () => {
    // 3 rows: one probe-eligible, one allowlisted, one with a live ancestor.
    const rows = [
      psLine({ pid: 10, ppid: 1, etime: "30:00", command: "sh -c while :; do :; done" }),
      psLine({ pid: 11, ppid: 1, etime: "30:00", command: "node /x/broker/index.mjs" }),
      psLine({ pid: 12, ppid: 99, etime: "30:00", command: "node /x/a.mjs" }),
      psLine({ pid: 99, ppid: 500, etime: "30:00", command: "bash" }),
    ];
    const batchCalls = [];
    const reaper = new ProcReaper({
      mode: "shadow",
      worktreeRoot: WT_ROOT,
      psLister: () => rows,
      lsofCwd: () => `${WT_ROOT}/CTL-X`,
      lsofCwdBatch: (pids) => {
        batchCalls.push([...pids]);
        return new Map(pids.map((p) => [p, `${WT_ROOT}/CTL-X`]));
      },
      cwdExists: () => false,
      // CTL-1531 round 2: the worktree ROOT is present. It gets its own seam because it answers a different question from a candidate's cwd, and the widened class is DISABLED for the whole sweep unless the root is definitely there (a missing root makes EVERY cwd under it look gone at once).
      worktreeRootExists: () => true,
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc: recordingKill(),
      sleep: async () => {},
      selfPid: 1,
      parentPid: 2,
      emit: recordingEmit(),
      log: silentLog(),
    });
    await reaper.sweep({});
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].sort((a, b) => a - b)).toEqual([10]);
  });

  it("a pid the batch cannot answer for is UNKNOWN → spared, and never retried per-pid", async () => {
    const rows = [
      psLine({ pid: 10, ppid: 1, etime: "30:00", command: "sh -c while :; do :; done" }),
      psLine({ pid: 11, ppid: 1, etime: "30:00", command: "sh -c while :; do :; done" }),
    ];
    const singleCalls = [];
    const reaper = new ProcReaper({
      mode: "shadow",
      worktreeRoot: WT_ROOT,
      psLister: () => rows,
      lsofCwd: (pid) => {
        singleCalls.push(pid);
        return `${WT_ROOT}/CTL-X`;
      },
      // pid 11 is simply absent from the answer — exactly what real lsof does
      // for a process it lacks permission to read.
      lsofCwdBatch: () => new Map([[10, `${WT_ROOT}/CTL-X`]]),
      cwdExists: () => false,
      // CTL-1531 round 2: the worktree ROOT is present. It gets its own seam because it answers a different question from a candidate's cwd, and the widened class is DISABLED for the whole sweep unless the root is definitely there (a missing root makes EVERY cwd under it look gone at once).
      worktreeRootExists: () => true,
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc: recordingKill(),
      sleep: async () => {},
      selfPid: 1,
      parentPid: 2,
      emit: recordingEmit(),
      log: silentLog(),
    });
    await reaper.sweep({});
    const r = await reaper.sweep({});
    expect(r.wouldReap.map((x) => x.pid)).toEqual([10]);
    expect(r.spared.find((x) => x.pid === 11).reason).toBe("cwd-unknown");
    expect(singleCalls).toHaveLength(0); // no per-pid fallback storm
  });

  it("a THROWING batch probe degrades to 'every cwd unknown' — the sweep kills nothing", async () => {
    const rows = [psLine({ pid: 10, ppid: 1, etime: "30:00", command: "node /x/a.mjs" })];
    const killProc = recordingKill();
    const reaper = new ProcReaper({
      mode: "enforce",
      worktreeRoot: WT_ROOT,
      psLister: () => rows,
      lsofCwd: () => `${WT_ROOT}/CTL-X`,
      lsofCwdBatch: () => {
        throw new Error("lsof timed out");
      },
      cwdExists: () => false,
      // CTL-1531 round 2: the worktree ROOT is present. It gets its own seam because it answers a different question from a candidate's cwd, and the widened class is DISABLED for the whole sweep unless the root is definitely there (a missing root makes EVERY cwd under it look gone at once).
      worktreeRootExists: () => true,
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc,
      sleep: async () => {},
      selfPid: 1,
      parentPid: 2,
      emit: recordingEmit(),
      log: silentLog(),
    });
    await reaper.sweep({});
    const r = await reaper.sweep({});
    expect(r.reaped).toHaveLength(0);
    expect(killProc.calls).toHaveLength(0);
    expect(r.spared[0].reason).toBe("cwd-unknown");
  });

  it("the shadow would-reap event reuses the cached cwd (no extra probe per candidate)", async () => {
    const rows = [psLine({ pid: 10, ppid: 1, etime: "30:00", command: "node /x/a.mjs" })];
    const singleCalls = [];
    const emit = recordingEmit();
    const reaper = new ProcReaper({
      mode: "shadow",
      worktreeRoot: WT_ROOT,
      psLister: () => rows,
      lsofCwd: (pid) => {
        singleCalls.push(pid);
        return `${WT_ROOT}/CTL-X`;
      },
      lsofCwdBatch: (pids) => new Map(pids.map((p) => [p, `${WT_ROOT}/CTL-X`])),
      cwdExists: () => false,
      // CTL-1531 round 2: the worktree ROOT is present. It gets its own seam because it answers a different question from a candidate's cwd, and the widened class is DISABLED for the whole sweep unless the root is definitely there (a missing root makes EVERY cwd under it look gone at once).
      worktreeRootExists: () => true,
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc: recordingKill(),
      sleep: async () => {},
      selfPid: 1,
      parentPid: 2,
      emit,
      log: silentLog(),
    });
    await reaper.sweep({});
    await reaper.sweep({});
    expect(emit.calls.find((c) => c.type === "procOrphans.would-reap").fields.worktreePath).toBe(
      `${WT_ROOT}/CTL-X`
    );
    expect(singleCalls).toHaveLength(0);
  });

  it("injecting only the single-pid seam keeps a fully hermetic per-pid path (no real lsof)", async () => {
    // Guards the constructor rule: the native batch is adopted ONLY when lsofCwd
    // is also the native default, so every pre-existing test stays hermetic.
    const rows = [psLine({ pid: 10, ppid: 1, etime: "30:00", command: "node /x/a.mjs" })];
    const singleCalls = [];
    const reaper = new ProcReaper({
      mode: "shadow",
      worktreeRoot: WT_ROOT,
      psLister: () => rows,
      lsofCwd: (pid) => {
        singleCalls.push(pid);
        return `${WT_ROOT}/CTL-X`;
      },
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc: recordingKill(),
      sleep: async () => {},
      selfPid: 1,
      parentPid: 2,
      emit: recordingEmit(),
      log: silentLog(),
    });
    expect(reaper.lsofCwdBatch).toBeNull();
    await reaper.sweep({});
    expect(singleCalls).toEqual([10]);
  });

  it("the production default DOES adopt the native batch seam", () => {
    const reaper = new ProcReaper({ psLister: () => [], log: silentLog() });
    expect(typeof reaper.lsofCwdBatch).toBe("function");
  });
});

describe("CTL-1531 classifyPreCwd — the IO-free prefetch gate matches classifyProc", () => {
  test("every terminal spare reason is reached WITHOUT touching a cwd seam", async () => {
    const cases = [
      [{ pid: 1, ppid: 1, command: "node", etimeSec: 9e5, args: "node /x/broker/index.mjs" }, "allowlisted"],
      [{ pid: 2, ppid: 5, command: "sh", etimeSec: 9e5, args: "sh -c :" }, "command-not-killable"],
      [{ pid: 3, ppid: 1, command: "tmux:", etimeSec: 9e5, args: "tmux: server" }, "command-denylisted"],
    ];
    for (const [row, reason] of cases) {
      const c = ctx({
        byPid: new Map([[5, { pid: 5 }]]),
        cwdForPid: () => {
          throw new Error("cwd probe must NOT run for a row the cheap gates already spared");
        },
      });
      expect(classifyPreCwd(row, c).reason).toBe(reason);
      expect((await classifyProc(row, c)).reason).toBe(reason); // same verdict, same path
    }
  });

  test("a row that needs a cwd is reported as 'probe' and carries the widened flag", () => {
    const widenedRow = { pid: 10, ppid: 1, command: "sh", etimeSec: 9e5, args: "sh -c :" };
    const legacyRow = { pid: 11, ppid: 1, command: "node", etimeSec: 9e5, args: "node a.mjs" };
    expect(classifyPreCwd(widenedRow, ctx())).toEqual({ action: "probe", widened: true });
    expect(classifyPreCwd(legacyRow, ctx())).toEqual({ action: "probe", widened: false });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CTL-1531 Codex round 1 — P1-a / P1-b / P1-d / P2-f regressions
// ═══════════════════════════════════════════════════════════════════════════

// A widened `sh` orphan, fully kill-eligible, with every seam injectable so a
// single knob at a time can be varied. `psSeq` lets a test mutate what the
// SIGNAL-TIME re-read sees vs. what classification saw (P2-f).
function widenReaper({
  mode = "enforce",
  widenMode,
  psSeq = null,
  psLines = [`4444 1 1200 16:30:00 ${SH_ARGS}`],
  cwdSeq = null,
  cwd = `${WT_ROOT}/evergreen/evr-23`,
  existsSeq = null,
  agents = [{ ok: true, agents: [] }],
  log = silentLog(),
  extra = {},
} = {}) {
  const killProc = recordingKill({ alive: new Set([4444, 903]) });
  const emit = recordingEmit();
  let nPs = 0;
  let nCwd = 0;
  let nExists = 0;
  let nAgents = 0;
  const pick = (seq, i, fallback) =>
    Array.isArray(seq) ? (i < seq.length ? seq[i] : seq[seq.length - 1]) : fallback;
  const reaper = new ProcReaper({
    mode,
    ...(widenMode === undefined ? {} : { widenMode }),
    worktreeRoot: WT_ROOT,
    minEtimeSec: 900,
    psLister: () => pick(psSeq, nPs++, psLines),
    lsofCwd: () => pick(cwdSeq, nCwd++, cwd),
    cwdExists: () => pick(existsSeq, nExists++, false),
    // CTL-1531 round 2: the worktree ROOT is present. It gets its own seam because it answers a different question from a candidate's cwd, and the widened class is DISABLED for the whole sweep unless the root is definitely there (a missing root makes EVERY cwd under it look gone at once).
    worktreeRootExists: () => true,
    agentsResult: () => pick(agents, nAgents++, { ok: true, agents: [] }),
    killProc,
    sleep: async () => {},
    selfPid: 1,
    parentPid: 2,
    emit,
    log,
    ...extra,
  });
  // Two sweeps: the two-sweep persistence guard means nothing is ever acted on
  // during the first pass.
  const twoSweeps = async () => {
    await reaper.sweep({});
    return reaper.sweep({});
  };
  const hardSignals = () => killProc.calls.filter(([, s]) => s !== 0);
  return { reaper, killProc, emit, twoSweeps, hardSignals };
}

// ─── P1-a: the widened class is staged behind its OWN rollout mode ──────────
//
// Codex P1-a: a host that already carries `orphanReaper.procReaper.mode:
// "enforce"` — an operator flip granted for the NARROW node/bun class after
// that class's own shadow bake — must NOT, on deploy, inherit authority to
// SIGTERM any PPID-1 command. ADR-023 (docs/adrs.md) requires a shadow
// observation window and an operator-owned flip per actuator.
describe("CTL-1531 P1-a — widenMode stages the widened class independently of mode", () => {
  it("mode:'enforce' + DEFAULT widenMode → the widened orphan is only OBSERVED, never signalled", async () => {
    // The regression: with the widened class riding `mode`, this fixture reaps
    // 4444 on deploy with no shadow window at all.
    const { reaper, killProc, twoSweeps, hardSignals } = widenReaper({
      mode: "enforce",
      widenMode: undefined, // constructor default — exactly what a deploy sees
    });
    expect(reaper.widenMode).toBe("shadow");
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(killProc.calls).toHaveLength(0);
    expect(r2.reaped).toHaveLength(0);
    expect(r2.wouldReap.map((x) => x.pid)).toContain(4444);
    expect(r2.wouldReap.find((x) => x.pid === 4444).widened).toBe(true);
  });

  it("mode:'enforce' + DEFAULT widenMode still emits the shadow would-reap observation", async () => {
    const { emit, twoSweeps } = widenReaper({ mode: "enforce", widenMode: undefined });
    await twoSweeps();
    const ev = emit.calls.find((c) => c.type === "procOrphans.would-reap");
    expect(ev).toBeDefined();
    expect(ev.fields.pid).toBe(4444);
    expect(ev.fields.reason).toBe("orphan-any-command-deleted-cwd");
    expect(emit.calls.some((c) => c.type === "procOrphans.reaped")).toBe(false);
  });

  it("mode:'enforce' + widenMode:'enforce' (BOTH gates open) → the widened orphan IS reaped", async () => {
    const { twoSweeps, hardSignals } = widenReaper({ mode: "enforce", widenMode: "enforce" });
    const r2 = await twoSweeps();
    expect(r2.reaped.map((x) => x.pid)).toContain(4444);
    expect(hardSignals().length).toBeGreaterThan(0);
  });

  it("mode:'shadow' + widenMode:'enforce' → still shadow (widenMode cannot ARM a shadow reaper)", async () => {
    const { twoSweeps, hardSignals } = widenReaper({ mode: "shadow", widenMode: "enforce" });
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(r2.reaped).toHaveLength(0);
    expect(r2.wouldReap.map((x) => x.pid)).toContain(4444);
  });

  it("widenMode:'off' fully reverts the feature — the row spares on the pre-CTL-1531 reason", async () => {
    const { twoSweeps, hardSignals } = widenReaper({ mode: "enforce", widenMode: "off" });
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(r2.reaped).toHaveLength(0);
    expect(r2.wouldReap).toHaveLength(0);
    expect(r2.spared.find((s) => s.pid === 4444).reason).toBe("command-not-killable");
  });

  it("the LEGACY node/bun class is UNTOUCHED by widenMode (mode:'enforce' + widenMode default → reaped)", async () => {
    // Guards the other direction: staging the widened class must not narrow the
    // pre-CTL-1531 reach of the node/bun reaper.
    const { twoSweeps, hardSignals } = widenReaper({
      mode: "enforce",
      widenMode: undefined,
      psLines: [`4444 1 1200 16:30:00 node /Users/test/catalyst/wt/CTL-1/x.mjs`],
      // Legacy deliberately skips the deleted-cwd conjunct — prove it by
      // answering "the cwd still exists" and reaping anyway.
      existsSeq: [true],
    });
    const r2 = await twoSweeps();
    expect(r2.reaped.map((x) => x.pid)).toContain(4444);
    expect(r2.reaped.find((x) => x.pid === 4444).widened).toBe(false);
    expect(hardSignals().length).toBeGreaterThan(0);
  });

  it("normalizeWidenMode: only off|shadow|enforce survive; anything else degrades to shadow", () => {
    expect(WIDEN_MODES).toEqual(["off", "shadow", "enforce"]);
    for (const v of ["off", "shadow", "enforce"]) expect(normalizeWidenMode(v)).toBe(v);
    for (const v of ["ENFORCE", "enforce ", "on", "true", "", null, undefined, 1, {}]) {
      expect(normalizeWidenMode(v)).toBe("shadow");
    }
    // A config typo must never ARM the killer.
    expect(new ProcReaper({ widenMode: "enfrce", log: silentLog() }).widenMode).toBe("shadow");
    expect(new ProcReaper({ log: silentLog() }).widenMode).toBe("shadow");
  });

  it("classifyPreCwd honours widenMode:'off' without any IO", () => {
    const row = shRow();
    const c = ctx({
      widenMode: "off",
      cwdForPid: () => {
        throw new Error("no probe may run once the widened admission is off");
      },
    });
    expect(classifyPreCwd(row, c)).toEqual({ action: "spare", reason: "command-not-killable" });
  });
});

// ─── P1-b: the cwd probe must FAIL CLOSED when it cannot answer ─────────────
//
// Codex P1-b: existsSync() returns plain `false` for EVERY stat failure, so an
// UNANSWERABLE probe (EACCES / EIO / ESTALE / unavailable mount) was read as
// positive evidence the worktree had been deleted — the exact inversion of the
// fail-closed rule, on the one conjunct that authorizes killing an arbitrary
// command. These tests drive the REAL default seam against the REAL filesystem;
// they are the only tests in this file that touch disk, and they only ever read.
describe("CTL-1531 P1-b — defaultCwdExists is tri-state (true | false | null)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ctl1531-cwd-"));
  const probe = new ProcReaper({ log: silentLog() }).cwdExists;

  it("a directory that EXISTS → true", () => {
    expect(probe(tmp)).toBe(true);
  });

  it("a path that definitely does NOT exist (ENOENT) → false", () => {
    expect(probe(join(tmp, "definitely-not-here"))).toBe(false);
  });

  it("a path that cannot be stat'd (EACCES) → null, NOT false", () => {
    // THE REGRESSION. With existsSync this returns `false` = "the worktree was
    // deleted" = kill an arbitrary process on evidence that was never gathered.
    //
    // Driven through the INJECTED stat seam, not a mode-000 directory on disk:
    // as uid 0 a mode-000 parent does not prevent traversal, so the real-FS
    // fixture yields no EACCES at all and the assertion silently tests nothing.
    // That is not hypothetical — this test failed in a root container for
    // exactly that reason. A permission fixture cannot express "unreadable" to a
    // user who is exempt from permissions.
    const eacces = () => {
      const e = new Error("EACCES: permission denied");
      e.code = "EACCES";
      throw e;
    };
    expect(defaultCwdExists("/walled/wt", { stat: eacces })).toBeNull();
  });

  it("a non-string / empty path → null (unknown), never a boolean", () => {
    expect(probe("")).toBe(null);
    expect(probe(null)).toBe(null);
    expect(probe(undefined)).toBe(null);
    expect(probe(42)).toBe(null);
  });

  it("an UNANSWERABLE probe spares the widened candidate end-to-end", async () => {
    const { twoSweeps, hardSignals } = widenReaper({
      mode: "enforce",
      widenMode: "enforce",
      existsSeq: [null], // "cannot tell"
    });
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(r2.reaped).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "cwd-exists-unknown")).toBe(true);
  });
});

// ─── P1-d: no full argv in ANY log line or event payload ────────────────────
//
// Codex P1-d: the widened class admits arbitrary commands, and arbitrary argv
// routinely carries an API token, a password, an Authorization header or a
// signed URL. These log lines go to the structured execution-core log, which is
// shipped to Loki — so merely OBSERVING the widened class in the DEFAULT shadow
// mode leaked secrets to disk and off-host with no enforce flip anywhere.
describe("CTL-1531 P1-d — the full argv NEVER reaches a log line or an event payload", () => {
  const SECRET = "sk-live-51H4xQzTOPSECRETvalue";
  const SECRET_ARGS = `sh -c curl -H Authorization: Bearer ${SECRET} https://api.example.com/v1/x?sig=${SECRET}`;

  function capturingLog() {
    const calls = [];
    const rec = (level) => (fields, msg) => calls.push({ level, fields, msg });
    return { info: rec("info"), warn: rec("warn"), error: rec("error"), calls };
  }

  // Everything the reaper hands to its log/emit seams, flattened to one string.
  const sink = (log, emit) =>
    JSON.stringify({
      log: log.calls.map((c) => ({ f: c.fields, m: c.msg })),
      emit: emit.calls,
    });

  it("SHADOW (the shipped default): the secret argv is absent from every log + event", async () => {
    const log = capturingLog();
    const { emit, twoSweeps } = widenReaper({
      mode: "shadow",
      widenMode: "shadow",
      psLines: [`4444 1 1200 16:30:00 ${SECRET_ARGS}`],
      log,
    });
    const r2 = await twoSweeps();
    expect(r2.wouldReap.map((x) => x.pid)).toContain(4444); // the path really ran
    const emitted = sink(log, emit);
    expect(emitted).not.toContain(SECRET);
    expect(emitted).not.toContain("Authorization");
    expect(emitted).not.toContain(SECRET_ARGS);
    // …and the candidate is still identifiable: pid + command BASENAME + reason.
    const hit = log.calls.find((c) => c.fields?.pid === 4444);
    expect(hit).toBeDefined();
    expect(hit.fields.command).toBe("sh");
    expect(hit.fields.reason).toBe("orphan-any-command-deleted-cwd");
    expect(hit.fields.args).toBeUndefined();
  });

  it("ENFORCE: the secret argv is absent from every log + event on the reap path too", async () => {
    const log = capturingLog();
    const { emit, twoSweeps } = widenReaper({
      mode: "enforce",
      widenMode: "enforce",
      psLines: [`4444 1 1200 16:30:00 ${SECRET_ARGS}`],
      log,
    });
    const r2 = await twoSweeps();
    expect(r2.reaped.map((x) => x.pid)).toContain(4444); // the path really ran
    const emitted = sink(log, emit);
    expect(emitted).not.toContain(SECRET);
    expect(emitted).not.toContain(SECRET_ARGS);
    const hit = log.calls.find((c) => c.fields?.pid === 4444 && c.level === "info");
    expect(hit.fields.command).toBe("sh");
    expect(hit.fields.args).toBeUndefined();
  });

  it("the LEGACY node/bun log line drops argv as well (the audit covers both classes)", async () => {
    const log = capturingLog();
    const legacyArgs = `node /Users/test/catalyst/wt/CTL-1/x.mjs --token=${SECRET}`;
    const { emit, twoSweeps } = widenReaper({
      mode: "shadow",
      widenMode: "off",
      psLines: [`4444 1 1200 16:30:00 ${legacyArgs}`],
      log,
    });
    const r2 = await twoSweeps();
    expect(r2.wouldReap.map((x) => x.pid)).toContain(4444);
    expect(sink(log, emit)).not.toContain(SECRET);
  });

  it("the argv is still retained IN MEMORY for pid-reuse matching (persistence still works)", async () => {
    // Proves the fix removed argv from the OUTPUT only, not from the guard: a
    // pid recycled under a different argv must still be spared.
    const first = `4444 1 1200 16:30:00 ${SECRET_ARGS}`;
    const reused = `4444 1 1200 16:30:00 sh -c a-completely-different-process`;
    const { twoSweeps, hardSignals } = widenReaper({
      mode: "enforce",
      widenMode: "enforce",
      psSeq: [[first], [reused]],
    });
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "awaiting-second-sweep")).toBe(true);
  });
});

// ─── P2-f: revalidate widened ownership immediately before SIGTERM ──────────
//
// Codex P2-f: candidates are classified from ONE snapshot and then processed
// SERIALLY, each enforcing candidate sleeping graceMs before the next is
// reached, so a late candidate is signalled tens of seconds after the evidence
// was gathered. _terminateWithGrace's argv re-match runs only AFTER the SIGTERM
// is delivered, so it protects the SIGKILL and nothing else.
describe("CTL-1531 P2-f — widened ownership is re-proved from a FRESH read before signalling", () => {
  const GOOD = [`4444 1 1200 16:30:00 ${SH_ARGS}`];

  // Sweep 1 = ps call 0; sweep 2 = ps call 1 (classification) then call 2
  // (revalidation). Index 2 is therefore what the signal-time read sees.
  const seqWithSignalTime = (signalTimeRows) => [GOOD, GOOD, signalTimeRows];

  it("PPID is no longer 1 at signal time (re-adopted by a live supervisor) → spared", async () => {
    const { twoSweeps, hardSignals } = widenReaper({
      psSeq: seqWithSignalTime([`4444 500 1200 16:30:00 ${SH_ARGS}`]),
      widenMode: "enforce",
    });
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(r2.reaped).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "widened-revalidation-failed")).toBe(true);
  });

  it("the pid vanished between classification and signal → spared (no signal to a recycled pid)", async () => {
    const { twoSweeps, hardSignals } = widenReaper({
      psSeq: seqWithSignalTime([]),
      widenMode: "enforce",
    });
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "widened-revalidation-failed")).toBe(true);
  });

  it("the pid was RECYCLED under a different argv at signal time → spared", async () => {
    const { twoSweeps, hardSignals } = widenReaper({
      psSeq: seqWithSignalTime([`4444 1 1200 16:30:00 sh -c something-else-entirely`]),
      widenMode: "enforce",
    });
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "widened-revalidation-failed")).toBe(true);
  });

  it("the worktree was RE-CREATED under the same path at signal time → spared", async () => {
    // classification (sweeps 1+2) sees "deleted"; the signal-time re-probe sees
    // the tree back on disk, e.g. create-worktree.sh ran concurrently.
    const { twoSweeps, hardSignals } = widenReaper({
      existsSeq: [false, false, true],
      widenMode: "enforce",
    });
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "widened-revalidation-failed")).toBe(true);
  });

  it("the signal-time cwd re-probe cannot answer → spared (fail closed)", async () => {
    const { twoSweeps, hardSignals } = widenReaper({
      existsSeq: [false, false, null],
      widenMode: "enforce",
    });
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "widened-revalidation-failed")).toBe(true);
  });

  it("the cwd MOVED out from under the worktree root at signal time → spared", async () => {
    const { twoSweeps, hardSignals } = widenReaper({
      cwdSeq: [
        `${WT_ROOT}/evergreen/evr-23`,
        `${WT_ROOT}/evergreen/evr-23`,
        "/Users/test/somewhere-else/gone",
      ],
      widenMode: "enforce",
    });
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "widened-revalidation-failed")).toBe(true);
  });

  it("the signal-time cwd probe returns nothing → spared", async () => {
    const { twoSweeps, hardSignals } = widenReaper({
      cwdSeq: [`${WT_ROOT}/evergreen/evr-23`, `${WT_ROOT}/evergreen/evr-23`, null],
      widenMode: "enforce",
    });
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "widened-revalidation-failed")).toBe(true);
  });

  it("a LIVE AGENT claimed the process tree between classification and signal → spared", async () => {
    const { twoSweeps, hardSignals } = widenReaper({
      agents: [
        { ok: true, agents: [] },
        { ok: true, agents: [] },
        { ok: true, agents: [{ pid: 4444, cwd: `${WT_ROOT}/evergreen/evr-23` }] },
      ],
      widenMode: "enforce",
    });
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "widened-revalidation-failed")).toBe(true);
  });

  it("a live agent's cwd now PREFIXES the candidate's cwd at signal time → spared", async () => {
    const { twoSweeps, hardSignals } = widenReaper({
      agents: [
        { ok: true, agents: [] },
        { ok: true, agents: [] },
        { ok: true, agents: [{ pid: 7777, cwd: `${WT_ROOT}/evergreen` }] },
      ],
      widenMode: "enforce",
    });
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "widened-revalidation-failed")).toBe(true);
  });

  it("the agents read FAILS at signal time → spared (catastrophe guard, applied late)", async () => {
    const { twoSweeps, hardSignals } = widenReaper({
      agents: [
        { ok: true, agents: [] },
        { ok: true, agents: [] },
        { ok: false, agents: [] },
      ],
      widenMode: "enforce",
    });
    const r2 = await twoSweeps();
    expect(hardSignals()).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "widened-revalidation-failed")).toBe(true);
  });

  it("a targeted worktreePath is re-applied at signal time", async () => {
    const { reaper, killProc } = widenReaper({
      cwdSeq: [`${WT_ROOT}/CTL-1`, `${WT_ROOT}/CTL-1`, `${WT_ROOT}/CTL-2`],
      widenMode: "enforce",
    });
    await reaper.sweep({ worktreePath: `${WT_ROOT}/CTL-1` });
    const r2 = await reaper.sweep({ worktreePath: `${WT_ROOT}/CTL-1` });
    expect(killProc.calls.filter(([, s]) => s !== 0)).toHaveLength(0);
    expect(r2.spared.some((s) => s.reason === "widened-revalidation-failed")).toBe(true);
  });

  it("everything still holds at signal time → the candidate IS reaped (the gate is not vacuous)", async () => {
    const { twoSweeps, hardSignals } = widenReaper({ widenMode: "enforce" });
    const r2 = await twoSweeps();
    expect(r2.reaped.map((x) => x.pid)).toContain(4444);
    expect(hardSignals().length).toBeGreaterThan(0);
  });

  it("the LEGACY node/bun class is NOT subject to the widened revalidation", async () => {
    // Same signal-time mutation (ppid no longer 1) that spares a widened row:
    // the legacy row must keep its exact pre-CTL-1531 path and still be reaped.
    const legacy = `4444 1 1200 16:30:00 node /Users/test/catalyst/wt/CTL-1/x.mjs`;
    const legacyMoved = `4444 500 1200 16:30:00 node /Users/test/catalyst/wt/CTL-1/x.mjs`;
    const { twoSweeps, hardSignals } = widenReaper({
      psSeq: [[legacy], [legacy], [legacyMoved]],
      widenMode: "enforce",
    });
    const r2 = await twoSweeps();
    expect(r2.reaped.map((x) => x.pid)).toContain(4444);
    expect(hardSignals().length).toBeGreaterThan(0);
  });

  it("the revalidation runs AFTER the accumulated grace delay of earlier candidates", async () => {
    // The bug's mechanism: candidate N is signalled after (N-1) × graceMs of
    // sleep. Assert the ordering — every widened SIGTERM is preceded by a fresh
    // ps read, so the re-read cannot be hoisted back to classification time.
    const order = [];
    const rows = [
      `4444 1 1200 16:30:00 ${SH_ARGS}`,
      `4445 1 1200 16:30:00 ${SH_ARGS}`,
    ];
    const killProc = (pid, signal) => {
      order.push(`kill:${pid}:${signal}`);
      return signal === 0 ? false : true;
    };
    const reaper = new ProcReaper({
      mode: "enforce",
      widenMode: "enforce",
      worktreeRoot: WT_ROOT,
      minEtimeSec: 900,
      psLister: () => {
        order.push("ps");
        return rows;
      },
      lsofCwd: () => `${WT_ROOT}/evergreen/evr-23`,
      cwdExists: () => false,
      // CTL-1531 round 2: the worktree ROOT is present. It gets its own seam because it answers a different question from a candidate's cwd, and the widened class is DISABLED for the whole sweep unless the root is definitely there (a missing root makes EVERY cwd under it look gone at once).
      worktreeRootExists: () => true,
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc,
      sleep: async () => order.push("sleep"),
      selfPid: 1,
      parentPid: 2,
      emit: recordingEmit(),
      log: silentLog(),
    });
    await reaper.sweep({});
    order.length = 0;
    await reaper.sweep({});
    const firstTerm = order.indexOf("kill:4444:SIGTERM");
    const secondTerm = order.indexOf("kill:4445:SIGTERM");
    expect(firstTerm).toBeGreaterThan(-1);
    expect(secondTerm).toBeGreaterThan(firstTerm);
    // A fresh ps read sits between the FIRST candidate's grace sleep and the
    // SECOND candidate's SIGTERM — i.e. the second candidate is re-proved on
    // evidence gathered after the delay, not on the original snapshot.
    const psAfterFirstTerm = order.findIndex((e, i) => i > firstTerm && e === "ps");
    expect(psAfterFirstTerm).toBeGreaterThan(-1);
    expect(psAfterFirstTerm).toBeLessThan(secondTerm);
  });
});

// ─── CTL-1531 P1-b: errno discrimination in the default cwd probe ────────────
// The whole widened class rests on "the cwd is DEFINITELY gone". Only ENOENT and
// ENOTDIR prove that. Every other errno means the probe could not answer, and
// treating any of them as proof turns a flaky mount or a permissions blip into
// positive kill evidence for arbitrary PPID-1 processes. EACCES is covered by the
// real-filesystem tests above; EIO/ESTALE cannot be provoked on a real FS, hence
// the injected stat seam.
describe("defaultCwdExists — only ENOENT/ENOTDIR prove deletion (CTL-1531 P1-b)", () => {
  const throwing = (code) => () => {
    const e = new Error(code);
    e.code = code;
    throw e;
  };

  it("ENOENT ⇒ false (definitely gone)", () => {
    expect(defaultCwdExists("/x", { stat: throwing("ENOENT") })).toBe(false);
  });
  // ENOTDIR is deliberately NOT kill evidence: the shell probe only recognises
  // "No such file or directory", so treating ENOTDIR as proof of deletion made JS
  // the killing side of an undeclared asymmetry (CTL-1531 round 3, M10).
  it("ENOTDIR ⇒ null (spare) — matches the shell probe, which cannot see it", () => {
    expect(defaultCwdExists("/x", { stat: throwing("ENOTDIR") })).toBeNull();
  });

  // These are the unpinned ones: each must be UNKNOWN (null ⇒ spare), never false.
  for (const code of ["EIO", "ESTALE", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG", "EBUSY"]) {
    it(`${code} ⇒ null (cannot tell ⇒ spare, never treated as deleted)`, () => {
      expect(defaultCwdExists("/x", { stat: throwing(code) })).toBeNull();
    });
  }

  it("an errno-less throw ⇒ null (spare)", () => {
    expect(
      defaultCwdExists("/x", {
        stat: () => {
          throw new Error("no code");
        },
      })
    ).toBeNull();
  });

  it("a successful stat ⇒ true (still exists ⇒ spare)", () => {
    expect(defaultCwdExists("/x", { stat: () => ({}) })).toBe(true);
  });

  it("a non-string / empty path ⇒ null (spare), with no stat call", () => {
    let calls = 0;
    const stat = () => {
      calls++;
      return {};
    };
    expect(defaultCwdExists("", { stat })).toBeNull();
    expect(defaultCwdExists(null, { stat })).toBeNull();
    expect(calls).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CTL-1531 Codex round 2 — the four JS-side findings, plus the DRIFT GUARD.
//
// The theme of round 2 is that this file and `orphan-sweep.sh` are two
// implementations of ONE policy and each round found a hardening on one side
// missing from the other, in BOTH directions. Round 1 gave the JS side an lsof
// deadline the shell lacked; the shell had a root-absent bail and a per-run kill
// cap the JS lacked. The last describe in this file is the mechanization that
// makes the next such divergence fail CI instead of a review round.
// ═══════════════════════════════════════════════════════════════════════════

// ─── P1-a (round 2): a missing worktree ROOT disables the widened class ─────
//
// "The cwd no longer exists" is the ONLY ownership evidence authorizing a kill
// on an arbitrary command, and it is CORRELATED: rename / delete / unmount
// `worktreeRoot` and EVERY PPID-1 process beneath it satisfies it in the same
// pass. Two-sweep persistence is no defense — the same correlated fault answers
// both sweeps — so one root-level failure becomes a mass kill.
describe("CTL-1531 round 2 P1-a — root-absent bail (ported from orphan-sweep.sh BOUND 1)", () => {
  it("root DEFINITELY GONE → the widened candidate is never signalled and never reported", async () => {
    const { reaper, hardSignals, emit } = widenReaper({
      widenMode: "enforce",
      extra: { worktreeRootExists: () => false },
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(hardSignals()).toHaveLength(0);
    expect(r2.reaped).toHaveLength(0);
    expect(r2.wouldReap).toHaveLength(0);
    // The row falls back to the EXACT pre-CTL-1531 spare reason (widenMode off).
    expect(r2.spared.some((s) => s.reason === "command-not-killable")).toBe(true);
    expect(emit.calls.some((c) => c.fields?.reason === "widen-root-absent")).toBe(true);
  });

  it("root UNREADABLE (probe cannot answer) also bails — fail closed, not fail open", async () => {
    const { reaper, hardSignals } = widenReaper({
      widenMode: "enforce",
      // EACCES on the mount point / ESTALE on a dropped share ⇒ null ⇒ cannot tell.
      extra: { worktreeRootExists: () => null },
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(hardSignals()).toHaveLength(0);
    expect(r2.reaped).toHaveLength(0);
  });

  it("a THROWING root probe bails (never treated as 'present')", async () => {
    const { reaper, hardSignals } = widenReaper({
      widenMode: "enforce",
      extra: {
        worktreeRootExists: () => {
          throw new Error("stat: ESTALE");
        },
      },
    });
    await reaper.sweep({});
    expect((await reaper.sweep({})).reaped).toHaveLength(0);
    expect(hardSignals()).toHaveLength(0);
  });

  it("the bail is LOGGED with the root and why (an operator must be able to see it)", async () => {
    const warns = [];
    const log = { info: () => {}, warn: (f, m) => warns.push({ f, m }), error: () => {} };
    const { reaper } = widenReaper({
      widenMode: "enforce",
      log,
      extra: { worktreeRootExists: () => false },
    });
    await reaper.sweep({});
    const hit = warns.find((w) => /worktree root is absent/i.test(w.m));
    expect(hit).toBeDefined();
    expect(hit.f.worktreeRoot).toBe(WT_ROOT);
    expect(hit.f.probe).toBe("absent");
  });

  it("NON-VACUITY: with the root PRESENT the very same fixture IS reaped", async () => {
    const { twoSweeps } = widenReaper({ widenMode: "enforce" });
    expect((await twoSweeps()).reaped.map((x) => x.pid)).toContain(4444);
  });

  it("the LEGACY node/bun class is untouched by a missing root (the .sh bail skips only the widened branch)", async () => {
    // A node orphan under the root: the legacy class never depended on the
    // deleted-cwd conjunct, so a missing root must not silently disable it.
    const killProc = recordingKill({ alive: new Set([4242]) });
    const reaper = new ProcReaper({
      mode: "enforce",
      widenMode: "enforce",
      worktreeRoot: WT_ROOT,
      minEtimeSec: 900,
      psLister: () => [psLine({ pid: 4242, ppid: 1, etime: "20:00", command: "node /x/foo.mjs" })],
      lsofCwd: () => `${WT_ROOT}/CTL-X`,
      cwdExists: () => false,
      worktreeRootExists: () => false, // root gone
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc,
      sleep: async () => {},
      selfPid: 1,
      parentPid: 2,
      emit: recordingEmit(),
      log: silentLog(),
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped.map((x) => x.pid)).toContain(4242);
  });

  it("the root probe DERIVES from cwdExists when not injected (it can never silently fail open)", () => {
    const seen = [];
    const reaper = new ProcReaper({
      worktreeRoot: WT_ROOT,
      cwdExists: (p) => {
        seen.push(p);
        return true;
      },
      log: silentLog(),
    });
    expect(reaper.worktreeRootExists(WT_ROOT)).toBe(true);
    expect(seen).toEqual([WT_ROOT]);
  });
});

// ─── P1-b (round 2): the per-run cap on WIDENED kills ───────────────────────

// N identical widened `sh` orphans, all fully kill-eligible.
function widenFleet({ pids, widenMaxKills, survivors = new Set(), extra = {} } = {}) {
  const rows = pids.map((p) => `${p} 1 1200 16:30:00 ${SH_ARGS}`);
  const alive = new Set(pids);
  const calls = [];
  const killProc = (pid, signal) => {
    calls.push([pid, signal]);
    if (signal === 0) return alive.has(pid);
    if (signal === "SIGKILL" && !survivors.has(pid)) alive.delete(pid);
    return true;
  };
  killProc.calls = calls;
  const warns = [];
  const reaper = new ProcReaper({
    mode: "enforce",
    widenMode: "enforce",
    ...(widenMaxKills === undefined ? {} : { widenMaxKills }),
    worktreeRoot: WT_ROOT,
    minEtimeSec: 900,
    psLister: () => rows,
    lsofCwd: () => `${WT_ROOT}/evergreen/evr-23`,
    cwdExists: () => false,
    worktreeRootExists: () => true,
    agentsResult: () => ({ ok: true, agents: [] }),
    killProc,
    sleep: async () => {},
    selfPid: 1,
    parentPid: 2,
    emit: recordingEmit(),
    log: { info: () => {}, warn: (f, m) => warns.push({ f, m }), error: () => {} },
  });
  const hard = () => calls.filter(([, s]) => s !== 0);
  return { reaper, killProc, warns, hard };
}

describe("CTL-1531 round 2 P1-b — per-run cap on widened kills (mirrors SWEEP_PROC_WIDEN_MAX_KILLS)", () => {
  it("the default cap is 5, matching the .sh default", () => {
    expect(WIDEN_DEFAULT_MAX_KILLS).toBe(5);
    expect(new ProcReaper({ log: silentLog() }).widenMaxKills).toBe(5);
  });

  it("10 eligible widened orphans + cap 3 → exactly 3 reaped, 7 deferred", async () => {
    const pids = [4401, 4402, 4403, 4404, 4405, 4406, 4407, 4408, 4409, 4410];
    const { reaper, hard } = widenFleet({ pids, widenMaxKills: 3 });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped).toHaveLength(3);
    expect(r2.spared.filter((s) => s.reason === "widen-cap-reached")).toHaveLength(7);
    // …and the ones over the cap were never SIGNALLED at all.
    expect(new Set(hard().map(([p]) => p)).size).toBe(3);
  });

  it("the deferral is REPORTED in the .sh's own words ('cap reached (N), M deferred')", async () => {
    const { reaper, warns } = widenFleet({ pids: [4401, 4402, 4403], widenMaxKills: 1 });
    await reaper.sweep({});
    await reaper.sweep({});
    expect(warns.some((w) => /widened cap reached \(1\), 2 deferred to the next run/.test(w.m))).toBe(
      true
    );
  });

  it("a signal-IGNORING process does not consume a cap slot (it crowds out no real orphan)", async () => {
    // 4401 survives everything and is enumerated FIRST. The cap counts CONFIRMED
    // terminations for exactly this reason — otherwise a stubborn process eats a
    // slot on every run, forever, and the real orphan behind it is never reached.
    // (It does spend SIGNAL budget — 2 of the 4 a cap of 2 allows — which is the
    // separate blast-radius ceiling asserted below.)
    const { reaper } = widenFleet({
      pids: [4401, 4402],
      widenMaxKills: 2,
      survivors: new Set([4401]),
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped.map((x) => x.pid)).toEqual([4402]);
  });

  it("SIGNALS are bounded at cap x 2 when nothing responds — and SIGKILL COUNTS", async () => {
    // The .sh bug Codex flagged: the ceiling incremented once per CANDIDATE
    // although each candidate receives SIGTERM *and* SIGKILL, so "cap 2"
    // permitted 4 candidates and 8 delivered signals. Counting signals, cap 2
    // ⇒ ceiling 4 ⇒ 2 candidates x 2 signals, then stop.
    const pids = [4401, 4402, 4403, 4404, 4405, 4406, 4407, 4408];
    const { reaper, hard, warns } = widenFleet({
      pids,
      widenMaxKills: 2,
      survivors: new Set(pids),
    });
    await reaper.sweep({});
    await reaper.sweep({});
    expect(hard()).toHaveLength(4); // NOT 8
    expect(new Set(hard().map(([p]) => p)).size).toBe(2);
    expect(
      warns.some((w) =>
        /widened signal bound reached \(4\) with only 0 confirmed termination\(s\)/.test(w.m)
      )
    ).toBe(true);
  });

  it("cap 0 means UNCAPPED (an operator decision, documented as such)", async () => {
    const pids = [4401, 4402, 4403, 4404, 4405, 4406, 4407];
    const { reaper } = widenFleet({ pids, widenMaxKills: 0 });
    await reaper.sweep({});
    expect((await reaper.sweep({})).reaped).toHaveLength(7);
  });

  it("a garbage cap degrades to the DEFAULT, never to uncapped", () => {
    // REGRESSION (Codex P1): the FRACTIONAL cases are the dangerous ones. The old
    // guard admitted any finite non-negative number and then floored it, so 0.5
    // became 0 — the documented "uncapped" value. A config typo silently removed
    // the widened-process kill ceiling, which is the exact inversion of a cap.
    for (const bad of ["nope", NaN, -1, undefined, null, {}, 0.5, 0.99, 2.5, Infinity]) {
      expect(new ProcReaper({ widenMaxKills: bad, log: silentLog() }).widenMaxKills).toBe(
        WIDEN_DEFAULT_MAX_KILLS
      );
    }
  });

  it("an EXACT integer 0 still means uncapped — an operator decision, not a typo", () => {
    expect(new ProcReaper({ widenMaxKills: 0, log: silentLog() }).widenMaxKills).toBe(0);
  });

  it("the cap does NOT bound the LEGACY node/bun class", async () => {
    const pids = [5001, 5002, 5003, 5004, 5005, 5006, 5007];
    const alive = new Set(pids);
    const killProc = (pid, signal) => {
      if (signal === 0) return alive.has(pid);
      if (signal === "SIGKILL") alive.delete(pid);
      return true;
    };
    const reaper = new ProcReaper({
      mode: "enforce",
      widenMode: "enforce",
      widenMaxKills: 1,
      worktreeRoot: WT_ROOT,
      minEtimeSec: 900,
      psLister: () => pids.map((p) => `${p} 1 1200 16:30:00 node /x/a.mjs`),
      lsofCwd: () => `${WT_ROOT}/CTL-X`,
      cwdExists: () => true,
      worktreeRootExists: () => true,
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc,
      sleep: async () => {},
      selfPid: 1,
      parentPid: 2,
      emit: recordingEmit(),
      log: silentLog(),
    });
    await reaper.sweep({});
    expect((await reaper.sweep({})).reaped).toHaveLength(7);
  });

  it("SHADOW still reports the FULL candidate set (the cap is enforcing-path only)", async () => {
    // That report is exactly the signal an operator needs to size the cap
    // BEFORE flipping to enforce, so shadow must not be truncated by it.
    const pids = [4401, 4402, 4403, 4404, 4405, 4406];
    const { reaper } = widenFleet({ pids, widenMaxKills: 2 });
    reaper.mode = "shadow";
    await reaper.sweep({});
    expect((await reaper.sweep({})).wouldReap).toHaveLength(6);
  });
});

// ─── P2 (round 2): the liveness probe is TRI-STATE ──────────────────────────
//
// The .sh finding was `_proc_alive`'s "empty ps output ⇒ exited". The JS half is
// `killProc(pid, 0)`, whose boolean collapses ESRCH (gone) and EPERM (found,
// foreign-uid ⇒ ALIVE) into one `false` — so a FAILED probe was read as "gone".
describe("CTL-1531 round 2 — defaultProbeAlive is tri-state (alive | gone | cannot tell)", () => {
  const throwing = (code) => () => {
    const e = new Error(code);
    e.code = code;
    throw e;
  };
  it("signal 0 accepted ⇒ true (alive)", () => {
    expect(defaultProbeAlive(123, { kill: () => {} })).toBe(true);
  });
  it("ESRCH ⇒ false — the ONLY outcome that proves an exit", () => {
    expect(defaultProbeAlive(123, { kill: throwing("ESRCH") })).toBe(false);
  });
  it("EPERM ⇒ true: the kernel FOUND it and refused us; it is alive, not gone", () => {
    expect(defaultProbeAlive(123, { kill: throwing("EPERM") })).toBe(true);
  });
  for (const code of ["EINVAL", "EIO", undefined]) {
    it(`${code} ⇒ null (cannot tell — never an exit)`, () => {
      expect(defaultProbeAlive(123, { kill: throwing(code) })).toBeNull();
    });
  }
  it("a nonsense pid ⇒ null, with no signal attempted", () => {
    let calls = 0;
    const kill = () => {
      calls++;
    };
    expect(defaultProbeAlive(0, { kill })).toBeNull();
    expect(defaultProbeAlive(-1, { kill })).toBeNull();
    expect(defaultProbeAlive("x", { kill })).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("CTL-1531 round 2 — a FAILED liveness probe never claims an exit", () => {
  // Build a widened fixture whose post-SIGTERM probe answers `answer`.
  function probeFixture(answer) {
    const emit = recordingEmit();
    const hard = [];
    const reaper = new ProcReaper({
      mode: "enforce",
      widenMode: "enforce",
      worktreeRoot: WT_ROOT,
      minEtimeSec: 900,
      psLister: () => [`4444 1 1200 16:30:00 ${SH_ARGS}`],
      lsofCwd: () => `${WT_ROOT}/evergreen/evr-23`,
      cwdExists: () => false,
      worktreeRootExists: () => true,
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc: (pid, signal) => {
        hard.push([pid, signal]);
        return true;
      },
      probeAlive: () => answer,
      sleep: async () => {},
      selfPid: 1,
      parentPid: 2,
      emit,
      log: silentLog(),
    });
    return { reaper, emit, hard };
  }

  it("probe returns null (could not tell) → NOT reaped, no reclamation emitted", async () => {
    const { reaper, emit } = probeFixture(null);
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(r2.reaped).toHaveLength(0);
    expect(emit.calls.filter((c) => c.type === "procOrphans.reaped")).toHaveLength(0);
  });

  it("probe returns null → the SIGTERM is NOT self-certified as an exit (SIGKILL still tried)", async () => {
    const { reaper, hard } = probeFixture(null);
    await reaper.sweep({});
    await reaper.sweep({});
    expect(hard.map(([, s]) => s)).toContain("SIGKILL");
  });

  it("a THROWING probe is likewise 'cannot tell', never 'gone'", async () => {
    const { reaper, emit } = probeFixture(undefined);
    reaper.probeAlive = () => {
      throw new Error("procfs read failed");
    };
    await reaper.sweep({});
    expect((await reaper.sweep({})).reaped).toHaveLength(0);
    expect(emit.calls.filter((c) => c.type === "procOrphans.reaped")).toHaveLength(0);
  });

  it("NON-VACUITY: a probe that CONFIRMS absence does record the reclamation", async () => {
    const { reaper, emit } = probeFixture(false);
    await reaper.sweep({});
    expect((await reaper.sweep({})).reaped.map((x) => x.pid)).toContain(4444);
    expect(emit.calls.some((c) => c.type === "procOrphans.reaped")).toBe(true);
  });

  it("an EPERM target is not reported reaped (the old boolean seam read EPERM as 'exited')", async () => {
    // defaultKillProc returns false for EPERM. Routed through the tri-state
    // probe, EPERM means ALIVE, so the sweep under-reports instead of emitting
    // a reclamation for a process that is still running.
    const emit = recordingEmit();
    const reaper = new ProcReaper({
      mode: "enforce",
      widenMode: "enforce",
      worktreeRoot: WT_ROOT,
      minEtimeSec: 900,
      psLister: () => [`4444 1 1200 16:30:00 ${SH_ARGS}`],
      lsofCwd: () => `${WT_ROOT}/evergreen/evr-23`,
      cwdExists: () => false,
      worktreeRootExists: () => true,
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc: () => false, // every signal "fails" (EPERM) — the boolean seam
      probeAlive: (pid) => defaultProbeAlive(pid, {
        kill: () => {
          const e = new Error("EPERM");
          e.code = "EPERM";
          throw e;
        },
      }),
      sleep: async () => {},
      selfPid: 1,
      parentPid: 2,
      emit,
      log: silentLog(),
    });
    await reaper.sweep({});
    expect((await reaper.sweep({})).reaped).toHaveLength(0);
    expect(emit.calls.filter((c) => c.type === "procOrphans.reaped")).toHaveLength(0);
  });

  it("an injected killProc keeps the probe hermetic even when swapped AFTER construction", async () => {
    // The seam is resolved at CALL time, so a test that reassigns `killProc`
    // cannot be left probing a REAL pid through the native default.
    const reaper = new ProcReaper({ psLister: () => [], log: silentLog() });
    const seen = [];
    reaper.killProc = (pid, signal) => {
      seen.push([pid, signal]);
      return false;
    };
    expect(await reaper._safeProbeAlive(999999)).toBe(false);
    expect(seen).toEqual([[999999, 0]]);
  });
});

// ─── P2 (round 2): the SIGKILL gets the SAME ownership re-proof as the SIGTERM
//
// `graceMs` is a SECOND stale-evidence window after the pre-SIGTERM
// revalidation. `_terminateWithGrace` used to re-match only argv before the
// SIGKILL, so a widened candidate that moved into a live cwd, had its worktree
// recreated, was claimed by a live agent, or was re-parented during the wait was
// still SIGKILLed.
describe("CTL-1531 round 2 P2 — the widened SIGKILL re-proves the FULL conjunction", () => {
  // psSeq/cwdSeq/existsSeq/agents are consumed in order, so index 2+ is what the
  // PRE-SIGKILL revalidation sees (0 = classification, 1 = pre-SIGTERM re-proof).
  const SURVIVES = { alive: true };
  function graceFixture({ psSeq, cwdSeq, existsSeq, agents } = {}) {
    const calls = [];
    let nPs = 0;
    let nCwd = 0;
    let nExists = 0;
    let nAgents = 0;
    const pick = (seq, i, fb) => (Array.isArray(seq) ? (i < seq.length ? seq[i] : seq.at(-1)) : fb);
    const rows = [`4444 1 1200 16:30:00 ${SH_ARGS}`];
    const reaper = new ProcReaper({
      mode: "enforce",
      widenMode: "enforce",
      worktreeRoot: WT_ROOT,
      minEtimeSec: 900,
      psLister: () => pick(psSeq, nPs++, rows),
      lsofCwd: () => pick(cwdSeq, nCwd++, `${WT_ROOT}/evergreen/evr-23`),
      cwdExists: () => pick(existsSeq, nExists++, false),
      worktreeRootExists: () => true,
      agentsResult: () => pick(agents, nAgents++, { ok: true, agents: [] }),
      killProc: (pid, signal) => {
        calls.push([pid, signal]);
        return signal === 0 ? SURVIVES.alive : true; // survives SIGTERM
      },
      sleep: async () => {},
      selfPid: 1,
      parentPid: 2,
      emit: recordingEmit(),
      log: silentLog(),
    });
    const sigkills = () => calls.filter(([, s]) => s === "SIGKILL");
    return { reaper, calls, sigkills };
  }

  // Sweep 1 consumes: ps(1). Sweep 2 consumes: ps(1) + revalidate ps(1) then, if
  // it survives SIGTERM, the SIGKILL revalidation's ps(1). Index the LAST entry
  // of each seq to drive "what the pre-SIGKILL re-proof sees".
  const LATE = (early, late) => [early, early, early, late];

  it("PPID changed during the grace (re-adopted by a live supervisor) → NO SIGKILL", async () => {
    const good = [`4444 1 1200 16:30:00 ${SH_ARGS}`];
    const readopted = [`4444 500 1200 16:30:00 ${SH_ARGS}`];
    const { reaper, sigkills } = graceFixture({ psSeq: LATE(good, readopted) });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(sigkills()).toHaveLength(0);
    expect(r2.reaped).toHaveLength(0);
  });

  it("the pid was RECYCLED under a different argv during the grace → NO SIGKILL", async () => {
    const good = [`4444 1 1200 16:30:00 ${SH_ARGS}`];
    const recycled = [`4444 1 1200 16:30:00 sh -c a-totally-different-process`];
    const { reaper, sigkills } = graceFixture({ psSeq: LATE(good, recycled) });
    await reaper.sweep({});
    await reaper.sweep({});
    expect(sigkills()).toHaveLength(0);
  });

  it("the worktree was RE-CREATED during the grace (cwd exists again) → NO SIGKILL", async () => {
    const { reaper, sigkills } = graceFixture({ existsSeq: LATE(false, true) });
    await reaper.sweep({});
    await reaper.sweep({});
    expect(sigkills()).toHaveLength(0);
  });

  it("the cwd MOVED out from under the worktree root during the grace → NO SIGKILL", async () => {
    const { reaper, sigkills } = graceFixture({
      cwdSeq: LATE(`${WT_ROOT}/evergreen/evr-23`, "/Users/test/elsewhere/gone"),
    });
    await reaper.sweep({});
    await reaper.sweep({});
    expect(sigkills()).toHaveLength(0);
  });

  it("a LIVE AGENT claimed the tree during the grace → NO SIGKILL", async () => {
    const { reaper, sigkills } = graceFixture({
      agents: LATE(
        { ok: true, agents: [] },
        { ok: true, agents: [{ pid: 4444, cwd: `${WT_ROOT}/CTL-9` }] }
      ),
    });
    await reaper.sweep({});
    await reaper.sweep({});
    expect(sigkills()).toHaveLength(0);
  });

  it("the agents read FAILS during the grace → NO SIGKILL (catastrophe guard, applied late)", async () => {
    const { reaper, sigkills } = graceFixture({
      agents: LATE({ ok: true, agents: [] }, { ok: false, agents: [] }),
    });
    await reaper.sweep({});
    await reaper.sweep({});
    expect(sigkills()).toHaveLength(0);
  });

  it("the signal-time cwd probe cannot answer during the grace → NO SIGKILL", async () => {
    const { reaper, sigkills } = graceFixture({
      cwdSeq: LATE(`${WT_ROOT}/evergreen/evr-23`, null),
    });
    await reaper.sweep({});
    await reaper.sweep({});
    expect(sigkills()).toHaveLength(0);
  });

  it("NON-VACUITY: everything still holds at SIGKILL time → the SIGKILL IS sent", async () => {
    const { reaper, sigkills } = graceFixture({});
    await reaper.sweep({});
    await reaper.sweep({});
    expect(sigkills()).toHaveLength(1);
  });

  it("REGRESSION: the LEGACY node/bun class keeps its argv-only pre-SIGKILL re-match", async () => {
    // The full widened conjunction must NOT be imposed on node/bun — a live cwd
    // is normal there and narrowing it would be a silent coverage regression.
    const rows = [psLine({ pid: 4242, ppid: 1, etime: "20:00", command: "node /x/foo.mjs" })];
    const killProc = recordingKill({ alive: new Set([4242]) });
    const reaper = new ProcReaper({
      mode: "enforce",
      worktreeRoot: WT_ROOT,
      minEtimeSec: 900,
      psLister: () => rows,
      lsofCwd: () => `${WT_ROOT}/CTL-X`,
      cwdExists: () => true, // cwd STILL EXISTS — fatal for a widened row, fine here
      worktreeRootExists: () => true,
      agentsResult: () => ({ ok: true, agents: [] }),
      killProc,
      sleep: async () => {},
      selfPid: 1,
      parentPid: 2,
      emit: recordingEmit(),
      log: silentLog(),
    });
    await reaper.sweep({});
    const r2 = await reaper.sweep({});
    expect(killProc.calls.filter(([, s]) => s === "SIGKILL")).toHaveLength(1);
    expect(r2.reaped.map((x) => x.pid)).toContain(4242);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE DRIFT GUARD — the actual root cause of three review rounds.
//
// `proc-reaper.mjs` (daemon) and `orphan-sweep.sh` (LaunchAgent) are TWO
// IMPLEMENTATIONS OF ONE POLICY, and every review round so far has found a
// hardening present on one side and missing on the other — in BOTH directions:
//
//   round 1  → JS gained an `lsof` deadline the shell did not have
//   round 1  → the shell gained a root-absent bail + a per-run kill cap the JS
//              did not have
//   round 2  → the shell's liveness probe read a FAILED probe as an exit; so did
//              the JS one. The shell revalidated identity before SIGTERM but not
//              before SIGKILL; so did the JS one.
//
// Reviews are not a control for this. The mechanization: every SHARED safety
// property carries a `PARITY: <slug>` marker at its site in BOTH files, and this
// test asserts the two marker SETS are IDENTICAL and equal the table below. Add
// a gate to one side without tagging the sibling and this FAILS.
//
// It is deliberately dumb. It cannot check that the two implementations are
// semantically equivalent — only that neither side quietly grows (or loses) a
// property the other lacks, which is exactly the failure mode observed.
// ═══════════════════════════════════════════════════════════════════════════

// The contract. Each entry is a safety property BOTH implementations must carry.
// Adding a row means tagging both files; removing one means deleting both markers.
// The prose is the reviewable part — the slug is the assertion.
//
// MODULE SCOPE on purpose: the BEHAVIOURAL suite at the bottom of this file asserts
// that every slug here also has a runnable scenario, and a second hand-maintained
// copy of this list would be exactly the drift this whole mechanism exists to stop.
const SHARED_SAFETY_PROPERTIES = Object.freeze({
  "root-absent-bail":
    "If the worktree ROOT itself is absent/unreadable, abandon the WIDENED class for this run. 'cwd is gone' is correlated: one missing root makes every process beneath it qualify at once.",
  "per-run-cap":
    "Bound the widened class per run: a cap on CONFIRMED terminations (default 5) plus a cap x 2 ceiling on DELIVERED signals, with 'cap reached (N), M deferred' reporting.",
  "tri-state-cwd-probe":
    "'Does this cwd still exist?' is present | gone | UNKNOWN. Only a definite ENOENT is kill evidence; EACCES/EIO/ESTALE/EPERM/ENOTDIR spare. Never a bare existsSync / [[ -d ]].",
  "pre-signal-revalidation":
    "Re-prove the full ownership conjunction from a FRESH read immediately before EACH signal — before the SIGTERM and again before the SIGKILL (the grace wait is a second stale-evidence window, and a pid can be reused inside it).",
  "confirmed-exit":
    "kill(2) returns on DELIVERY, not exit. Only a probe that CONFIRMS absence records a reclamation; a probe that could not answer is UNKNOWN and never claims the exit.",
  "probe-deadline":
    "The LSOF cwd-RESOLUTION probe is bounded (CATALYST_LSOF_TIMEOUT_MS / SWEEP_PROC_CWD_TIMEOUT_SECS), so one hung/stale mount cannot wedge the sweep. A timed-out probe yields UNKNOWN, never a truncated path. SCOPE: lsof ONLY — the cwd-EXISTENCE probe is unbounded on both sides, see DOCUMENTED_ASYMMETRIES. NOT symmetric at the edge: SWEEP_PROC_CWD_TIMEOUT_SECS=0 DISABLES the .sh bound (documented as unbounded at orphan-sweep.sh:51), whereas lsofTimeoutMs() refuses 0 and falls back to the default — so an operator can turn the bound off on the .sh side only.",
  allowlist:
    "A hard never-kill argv-substring allowlist covering the fleet's own control plane — daemon / broker / orch-monitor / tailscale AND the two PPID-1-by-construction entries orphan-sweep.sh and catalyst-stack, which the parent-pid gate cannot spare.",
  denylist:
    "A WIDENED-class command denylist for session multiplexers and login/init plumbing (tmux/screen/sshd/ssh/mosh/login/launchd/init/systemd/nohup), matched over the FULL argv with setproctitle's `progname:` form anchored.",
  "age-floor":
    "A minimum process age (minEtimeSec / SWEEP_PROC_WIDEN_MIN_AGE_SECS, default 900s) before a widened candidate may be signalled, so a just-spawned process whose worktree is mid-teardown is never reaped out from under the teardown.",
  "argv-redaction":
    "Never write a candidate's FULL argv to a log line or event payload — an arbitrary command's argv routinely carries tokens, passwords and signed URLs, and both logs are persisted. pid + command basename + reason only.",
  "shadow-default":
    "The widened class ships DARK: its own three-state knob (widenMode / SWEEP_PROC_WIDEN) defaults to shadow independently of the narrow class's mode, and an unrecognized value degrades to shadow, never to enforce.",
});

// Properties that are INTENTIONALLY one-sided. Listing them here is the escape
// hatch: if a behavior belongs on only one side, say so out loud instead of
// tagging it and forcing a bogus mirror.
const DOCUMENTED_ASYMMETRIES = Object.freeze({
  "two-sweep persistence": "JS only — the .sh sweep is stateless between runs and acts on first observation.",
  "live-agent LIVE_TREE correlation": "JS only — `claude agents --json` + the ps children-map are not available to the .sh sweep.",
  "catastrophe guard on the agents read": "JS only — same reason.",
  "batched lsof prefetch": "JS only — a perf fix for the daemon's event loop; the .sh sweep is not on it.",
  "legacy pgrep 'bun run|turbo|node' branch": ".sh only — path-unrestricted, reclaims debris outside the worktree root.",
  "bounded base-10 config parsing": ".sh only — bash arithmetic's octal/overflow traps have no JS analogue.",
  "self/ancestor pid walk": ".sh only — the JS side gets self+parent+daemon pids injected.",
  // CTL-1531 round 3 (M7). The `probe-deadline` property covers LSOF and
  // nothing else. defaultCwdExists is a SYNCHRONOUS, UNBOUNDED statSync: on a
  // hung NFS/SMB mount it blocks the execution-core daemon's whole event loop,
  // while the .sh sibling's `stat` wedges only its own LaunchAgent run. The
  // asymmetry is the BLAST RADIUS, and it is declared here rather than papered
  // over by widening `probe-deadline` to claim a bound the code does not have.
  "unbounded statSync cwd-existence probe (event-loop blocking)":
    "JS only — bounding it needs a subprocess PER CANDIDATE, i.e. exactly the spawn storm CTL-1531's batched lsof exists to remove; the .sh `stat` blocks only its own LaunchAgent run.",
});

describe("CTL-1531 — parity between proc-reaper.mjs and orphan-sweep.sh", () => {
  const readSource = (rel) => readFileSync(join(import.meta.dir, rel), "utf8");
  const markersIn = (text) => {
    const out = new Set();
    for (const m of text.matchAll(/PARITY:\s*([a-z][a-z0-9-]*)/g)) out.add(m[1]);
    return out;
  };

  const JS_SRC = readSource("proc-reaper.mjs");
  const SH_SRC = readSource("../orphan-sweep.sh");
  const jsMarkers = markersIn(JS_SRC);
  const shMarkers = markersIn(SH_SRC);
  const expected = new Set(Object.keys(SHARED_SAFETY_PROPERTIES));
  const sorted = (s) => [...s].sort();

  it("proc-reaper.mjs tags EVERY shared safety property (and nothing extra)", () => {
    expect(sorted(jsMarkers)).toEqual(sorted(expected));
  });

  it("orphan-sweep.sh tags EVERY shared safety property (and nothing extra)", () => {
    expect(sorted(shMarkers)).toEqual(sorted(expected));
  });

  it("the two marker sets are IDENTICAL — this is the assertion that catches drift", () => {
    // Fails the moment one side gains (or loses) a hardening the other lacks.
    // The diff names the slug, so the fix is obvious: tag the sibling, or add
    // the missing gate there.
    expect(sorted(jsMarkers)).toEqual(sorted(shMarkers));
  });

  it("every shared property has a human-readable statement of WHAT must hold", () => {
    for (const [slug, why] of Object.entries(SHARED_SAFETY_PROPERTIES)) {
      expect(typeof why).toBe("string");
      expect(why.length).toBeGreaterThan(40); // a slug alone is not a contract
      expect(slug).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("both files point a reader at this contract before they edit a gate", () => {
    // A marker nobody knows the rule for is just a comment. Each source must
    // name the sibling, so the parity requirement is discoverable from either.
    expect(JS_SRC).toContain("orphan-sweep.sh");
    expect(SH_SRC).toContain("proc-reaper.mjs");
    expect(JS_SRC).toMatch(/PARITY/);
    expect(SH_SRC).toMatch(/PARITY/);
  });

  it("the intentional asymmetries are declared, not silently untagged", () => {
    // Documenting them is what keeps the strict set-equality above honest: an
    // author with a genuinely one-sided change has a place to put it that is
    // not "quietly skip the marker".
    expect(Object.keys(DOCUMENTED_ASYMMETRIES).length).toBeGreaterThan(0);
    for (const [name, why] of Object.entries(DOCUMENTED_ASYMMETRIES)) {
      expect(name.length).toBeGreaterThan(0);
      expect(why).toMatch(/^(JS only|\.sh only)/);
    }
    // A slug must never appear in both lists — that would mean a property is
    // claimed as shared AND as one-sided.
    for (const name of Object.keys(DOCUMENTED_ASYMMETRIES)) {
      expect(expected.has(name)).toBe(false);
    }
  });

  it("SANITY: the extractor really does find markers (a typo'd regex must not pass vacuously)", () => {
    expect(jsMarkers.size).toBe(Object.keys(SHARED_SAFETY_PROPERTIES).length);
    expect(shMarkers.size).toBe(Object.keys(SHARED_SAFETY_PROPERTIES).length);
    expect(markersIn("nothing here").size).toBe(0);
    expect(markersIn("// PARITY: made-up-slug").has("made-up-slug")).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // THE MARKER TESTS ABOVE ARE A TAGGING INVARIANT, NOT A SAFETY ONE.
  //
  // Measured on this very PR: deleting a `# PARITY: argv-redaction` COMMENT
  // failed 3 tests, while deleting the shell's actual root-absent BAIL (marker
  // left in place) failed 0. Everything above can be satisfied by a file of
  // comments. Keep it — a missing tag is a cheap early warning — but do not
  // mistake it for the invariant. The invariant is below.
  // ═════════════════════════════════════════════════════════════════════════
  it("DISCLAIMER: the marker set is a tagging invariant; the behavioural suite below is the real check", () => {
    // Encoded as an assertion so the disclaimer cannot rot away from the code:
    // every shared property MUST also appear in the behavioural scenario table.
    for (const slug of Object.keys(SHARED_SAFETY_PROPERTIES)) {
      expect(Object.keys(BEHAVIOURAL_SCENARIOS)).toContain(slug);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE BEHAVIOURAL DRIFT GUARD (CTL-1531 round 3) — the real invariant.
//
// The marker suite above asserts that the two files carry the same COMMENTS.
// This one asserts that they BEHAVE the same. For each shared safety property it
// runs ONE scenario through BOTH implementations:
//
//   .sh  → __tests__/parity-scenario.sh drives the REAL orphan-sweep.sh against
//          a hermetic MOCKBIN fixture (ps/lsof/pgrep/kill/claude all mocked, $HOME
//          redirected, `env kill` resolving to a log-appending mock) and prints a
//          machine-readable outcome. NO real process is enumerated or signalled.
//   JS   → the same scenario expressed through ProcReaper's injected seams.
//
// and asserts BOTH produce the SAME outcome — the same pids signalled, the same
// NUMBER of signals delivered, the same pids recorded as reclaimed. Remove the
// gate from EITHER side and the named test goes RED.
//
// Every scenario starts from the SAME maximally-kill-eligible shape and varies
// exactly ONE thing. `control/baseline` proves that shape really does get killed,
// so a "nothing was signalled" assertion can never pass because the harness is
// simply inert.
//
// WHERE A TRUE CROSS-CHECK IS NOT PRACTICAL, IT IS SAID SO — see
// PARTIAL_BEHAVIOURAL_COVERAGE below. Downgrading a claim is the point; the
// failure this suite exists to stop is a check that quietly claims more than it
// verifies.
// ═══════════════════════════════════════════════════════════════════════════

const P_WT = "/parity/wt";
const P_GONE = `${P_WT}/deleted-tree`;
// Must match parity-scenario.sh's PARITY_SECRET exactly.
const P_SECRET = "PARITY-SECRET-sk-live-DEADBEEF";
const P_SH = join(import.meta.dir, "..", "__tests__", "parity-scenario.sh");

/** capturingLog — records every log line (message + serialized fields). */
function capturingLog() {
  const lines = [];
  const at = (level) => (fields, msg) => {
    let f = "";
    try {
      f = JSON.stringify(fields ?? {});
    } catch {
      f = "<unserializable>";
    }
    lines.push(`${level} ${typeof msg === "string" ? msg : ""} ${f}`);
  };
  return { info: at("info"), warn: at("warn"), error: at("error"), lines };
}

/** runShellScenario — execute the .sh half and normalize its JSON outcome. */
function runShellScenario(name) {
  const stdout = execFileSync("bash", [P_SH, name], { encoding: "utf8", timeout: 120000 });
  const line = stdout.trim().split("\n").filter(Boolean).pop();
  const j = JSON.parse(line);
  return {
    signalled: j.signalled,
    signals: j.signals,
    reclaimed: j.reclaimed,
    exit: j.exit,
    log: Buffer.from(j.logB64, "base64").toString("utf8"),
  };
}

/**
 * runJsScenario — the SAME scenario through ProcReaper's seams.
 *
 * The JS reaper has two-sweep persistence (a DOCUMENTED_ASYMMETRY: the .sh sweep
 * acts on first observation), so it is driven twice and the SECOND sweep is the
 * acting one. That is the only intentional difference in how the two halves are
 * driven; every gate under test is evaluated identically on both sweeps.
 */
async function runJsScenario(name) {
  const log = capturingLog();
  const killCalls = [];
  const killProc = (pid, signal) => {
    killCalls.push([pid, signal]);
    return true;
  };
  const emits = [];
  const emit = async (type, fields) => {
    emits.push({ type, fields });
    return true;
  };

  let rows = [];
  let rowsAtCall = null; // (n) => rows — for the TOCTOU / revalidation scenario
  const cwds = {}; // pid → cwd
  const alive = new Set(); // pids that ignore BOTH signals
  let cwdExistsFn = () => false; // "definitely gone"
  let rootExistsFn = () => true;
  let useRealLsof = false;
  const cfg = {};

  const row = (pid, { cmd = "sh -c while :; do :; done", etime = "16:40:00", ppid = 1 } = {}) =>
    psLine({ pid, ppid, etime, command: cmd });

  switch (name) {
    case "control/baseline":
      rows = [row(2001)];
      cwds[2001] = P_GONE;
      break;
    case "allowlist":
      rows = [
        row(2001, { cmd: "/bin/bash /Users/x/plugin-source/plugins/dev/scripts/orphan-sweep.sh" }),
        row(2002, {
          cmd: "/bin/bash /Users/x/plugin-source/plugins/dev/scripts/catalyst-stack start",
        }),
      ];
      cwds[2001] = P_GONE;
      cwds[2002] = P_GONE;
      break;
    case "denylist":
      rows = [row(2001, { cmd: "tmux: server (/private/tmp/tmux-501/default)" })];
      cwds[2001] = P_GONE;
      break;
    case "age-floor":
      rows = [row(2001, { etime: "00:30" })];
      cwds[2001] = P_GONE;
      break;
    case "root-absent-bail":
      rows = [row(2001), row(2002), row(2003), row(2004), row(2005)];
      for (const p of [2001, 2002, 2003, 2004, 2005]) cwds[p] = P_GONE;
      rootExistsFn = () => false; // the ROOT itself is gone
      break;
    case "per-run-cap":
      rows = [row(2001), row(2002), row(2003), row(2004), row(2005)];
      for (const p of [2001, 2002, 2003, 2004, 2005]) cwds[p] = P_GONE;
      cfg.widenMaxKills = 2;
      break;
    case "signal-bound-odd":
      rows = [row(2001), row(2002), row(2003), row(2004)];
      for (const p of [2001, 2002, 2003, 2004]) cwds[p] = P_GONE;
      cfg.widenMaxKills = 2;
      alive.add(2002).add(2003).add(2004); // 2001 exits under SIGTERM → ODD parity
      break;
    case "tri-state-cwd-probe":
      rows = [row(2001)];
      cwds[2001] = `${P_WT}/unreadable-tree`;
      cwdExistsFn = () => null; // EIO/ESTALE — the probe cannot ANSWER
      break;
    case "pre-signal-revalidation": {
      rows = [row(2001)];
      cwds[2001] = P_GONE;
      const recycled = [row(2001, { cmd: "sh -c a-completely-different-process" })];
      // ps read #1 = sweep 1's snapshot, #2 = sweep 2's snapshot, #3 = the
      // pre-signal revalidation. The scenario asserts the spare REASON below, so
      // if that call sequence ever changes the test fails loudly rather than
      // passing for the wrong reason.
      rowsAtCall = (n) => (n >= 3 ? recycled : rows);
      break;
    }
    case "confirmed-exit":
      rows = [row(2001)];
      cwds[2001] = P_GONE;
      alive.add(2001); // ignores SIGTERM *and* SIGKILL
      break;
    case "probe-deadline":
      rows = [row(2001)];
      cwds[2001] = P_GONE;
      useRealLsof = true; // a genuinely HUNG `lsof` on $PATH, bounded by the deadline
      break;
    case "argv-redaction":
      rows = [row(2001, { cmd: `sh -c curl -H Authorization: Bearer ${P_SECRET} https://x/y` })];
      cwds[2001] = P_GONE;
      break;
    case "shadow-default":
      rows = [row(2001)];
      cwds[2001] = P_GONE;
      break;
    default:
      throw new Error(`unknown JS parity scenario: ${name}`);
  }

  let psCalls = 0;
  const psLister = async () => {
    psCalls += 1;
    return rowsAtCall ? rowsAtCall(psCalls) : rows;
  };

  const base = {
    mode: "enforce",
    widenMode: "enforce",
    worktreeRoot: P_WT,
    graceMs: 0,
    psLister,
    cwdExists: cwdExistsFn,
    worktreeRootExists: rootExistsFn,
    agentsResult: () => ({ ok: true, agents: [] }),
    killProc,
    probeAlive: (pid) => alive.has(pid),
    sleep: async () => {},
    selfPid: 111111,
    parentPid: 111112,
    log,
    emit,
    ...cfg,
  };
  // Only the probe-deadline scenario exercises the REAL lsof seam (it is the
  // thing under test); every other scenario keeps a hermetic injected probe.
  if (!useRealLsof) base.lsofCwd = async (pid) => (pid in cwds ? cwds[pid] : null);
  // shadow-default: the knob must be ABSENT, not set to "shadow" — the property
  // is that the DEFAULT is dark even while the narrow class is "enforce".
  if (name === "shadow-default") delete base.widenMode;

  let restorePath = null;
  let restoreTimeout = null;
  let mockDir = null;
  if (useRealLsof) {
    mockDir = mkdtempSync(join(tmpdir(), "parity-lsof-"));
    const bin = join(mockDir, "lsof");
    Bun.write(bin, "#!/usr/bin/env bash\nsleep 3\n");
    chmodSync(bin, 0o755);
    restorePath = process.env.PATH;
    restoreTimeout = process.env.CATALYST_LSOF_TIMEOUT_MS;
    process.env.PATH = `${mockDir}:${process.env.PATH}`;
    process.env.CATALYST_LSOF_TIMEOUT_MS = "300";
  }

  let report;
  try {
    const reaper = new ProcReaper(base);
    await reaper.sweep({}); // sweep 1 — satisfies two-sweep persistence
    report = await reaper.sweep({}); // sweep 2 — the ACTING sweep
  } finally {
    if (useRealLsof) {
      if (restorePath === undefined) delete process.env.PATH;
      else process.env.PATH = restorePath;
      if (restoreTimeout === undefined) delete process.env.CATALYST_LSOF_TIMEOUT_MS;
      else process.env.CATALYST_LSOF_TIMEOUT_MS = restoreTimeout;
      if (mockDir) rmSync(mockDir, { recursive: true, force: true });
    }
  }

  const signalCalls = killCalls.filter(([, s]) => s !== 0);
  const asc = (a, b) => a - b;
  return {
    signalled: [...new Set(signalCalls.map(([p]) => p))].sort(asc),
    signals: signalCalls.length,
    reclaimed: report.reaped.map((r) => r.pid).sort(asc),
    reasons: report.spared.map((s) => s.reason),
    log: log.lines.join("\n"),
    emitted: JSON.stringify(emits),
  };
}

/**
 * The scenario table. `outcome` is what BOTH implementations must produce.
 * `jsProof` / `shProof` are the ANTI-VACUITY assertions: a substring the
 * implementation must have logged (or, for JS, a spare reason it must have
 * recorded) proving the row was dropped by the gate under test and not by some
 * unrelated earlier gate.
 */
const BEHAVIOURAL_SCENARIOS = Object.freeze({
  "control/baseline": {
    outcome: { signalled: [2001], signals: 1, reclaimed: [2001] },
    jsProof: { log: "reaped WIDENED orphan" },
    shProof: { log: "killed 2001" },
  },
  allowlist: {
    outcome: { signalled: [], signals: 0, reclaimed: [] },
    jsProof: { reason: "allowlisted" },
    // .sh: an allowlisted candidate is dropped by a bare `continue` with no log
    // line. control/baseline is the anti-vacuity proof — same fixture, argv the
    // only difference, and it kills.
    shProof: null,
  },
  denylist: {
    outcome: { signalled: [], signals: 0, reclaimed: [] },
    jsProof: { reason: "command-denylisted" },
    shProof: null, // same as allowlist: silent `continue`; baseline is the control
  },
  "age-floor": {
    outcome: { signalled: [], signals: 0, reclaimed: [] },
    jsProof: { reason: "too-young" },
    shProof: null, // silent `continue`; baseline is the control
  },
  "root-absent-bail": {
    outcome: { signalled: [], signals: 0, reclaimed: [] },
    jsProof: { log: "DISABLING the widened class" },
    shProof: { log: "is absent — skipping" },
  },
  "per-run-cap": {
    outcome: { signalled: [2001, 2002], signals: 2, reclaimed: [2001, 2002] },
    jsProof: { log: "widened cap reached (2)" },
    shProof: { log: "cap reached (2), 3 deferred" },
  },
  "signal-bound-odd": {
    // cap 2 ⇒ ceiling 4 DELIVERED signals. 1 (2001 exits under SIGTERM) + 2
    // (2002 ignores both) = 3; admitting 2003 would deliver 5 = cap*2 + 1.
    outcome: { signalled: [2001, 2002], signals: 3, reclaimed: [2001] },
    jsProof: { log: "widened signal bound reached (4)" },
    shProof: { log: "signal bound reached (4)" },
  },
  "tri-state-cwd-probe": {
    outcome: { signalled: [], signals: 0, reclaimed: [] },
    jsProof: { reason: "cwd-exists-unknown" },
    shProof: null, // silent `continue`; baseline is the control
  },
  "pre-signal-revalidation": {
    outcome: { signalled: [], signals: 0, reclaimed: [] },
    jsProof: { reason: "widened-revalidation-failed" },
    shProof: { log: "no longer matches the candidate at signal time" },
  },
  "confirmed-exit": {
    // Two signals DELIVERED, ZERO reclamations: `kill` returning success is not
    // an exit, and an unconfirmed exit must never be reported as one.
    outcome: { signalled: [2001], signals: 2, reclaimed: [] },
    jsProof: { log: "exit NOT confirmed after SIGKILL" },
    shProof: { log: "STILL alive after SIGKILL" },
  },
  "probe-deadline": {
    outcome: { signalled: [], signals: 0, reclaimed: [] },
    jsProof: { reason: "cwd-unknown" },
    shProof: null, // the timed-out probe spares silently; baseline is the control
  },
  "argv-redaction": {
    outcome: { signalled: [2001], signals: 1, reclaimed: [2001] },
    jsProof: { log: "reaped WIDENED orphan" },
    shProof: { log: "killed 2001" },
  },
  "shadow-default": {
    outcome: { signalled: [], signals: 0, reclaimed: [] },
    jsProof: { log: "WOULD reap WIDENED orphan" },
    shProof: { log: "[shadow] would kill 2001" },
  },
});

/**
 * Properties whose cross-implementation check is WEAKER than "both sides drove
 * the same fixture to the same outcome, and each proved WHY". Declared, not
 * hidden: the whole failure mode this suite exists to stop is a check that
 * claims more coverage than it has.
 */
const PARTIAL_BEHAVIOURAL_COVERAGE = Object.freeze({
  "two-sweep persistence":
    "NOT cross-checked — JS-only by design (see DOCUMENTED_ASYMMETRIES). The JS half is driven for two sweeps so every OTHER property can be compared at all.",
  "allowlist / denylist / age-floor / tri-state-cwd-probe / probe-deadline (.sh side)":
    "The .sh sweep drops these candidates with a silent `continue`, so there is no log line to assert on. Coverage rests on the control/baseline scenario: the SAME fixture with only the tested field changed IS signalled, so a sparing outcome is attributable to that field. Weaker than the JS side, which records an explicit spare reason.",
  "probe-deadline (JS half not cross-checked)":
    "The BEHAVIOURAL scenario for this property is .sh-ONLY: deleting both `timeout:` options in the JS implementation leaves the parity scenario GREEN. It cannot cross-check JS even in principle — a hung mock lsof yields empty output, so the JS cwd resolves to null and the candidate is spared either way, with or without the deadline. JS coverage for this property therefore rests ENTIRELY on the two dedicated CATALYST_LSOF_TIMEOUT_MS latency tests, not on the parity harness.",
  "probe-deadline (wall clock)":
    "Both halves assert that a hung probe SPARES and that the run still completes, not that it completed within a specific latency budget — a timing assertion would be flaky under CI load. The JS half additionally has a dedicated latency test (CATALYST_LSOF_TIMEOUT_MS) that DOES assert elapsed time, against a deliberately sub-second deadline.",
  "shadow-default (.sh side)":
    "The .sh sweep has no separate narrow-class mode, so 'the widened knob defaults to shadow INDEPENDENTLY of the narrow mode' is only fully expressible on the JS side. The .sh half asserts the weaker 'unset ⇒ shadow'.",
});

describe("CTL-1531 — BEHAVIOURAL parity (both implementations, same scenario)", () => {
  it("the scenario table covers every shared safety property", () => {
    const covered = new Set(Object.keys(BEHAVIOURAL_SCENARIOS));
    for (const slug of Object.keys(SHARED_SAFETY_PROPERTIES)) {
      expect(covered.has(slug)).toBe(true);
    }
    // …and the control is present, without which every "spared" row is vacuous.
    expect(covered.has("control/baseline")).toBe(true);
  });

  it("the .sh driver exposes exactly the scenarios this table drives", () => {
    const listed = execFileSync("bash", [P_SH, "--list"], { encoding: "utf8" })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .sort();
    const wanted = Object.keys(BEHAVIOURAL_SCENARIOS)
      .map((k) => (k === "control/baseline" ? "baseline" : k))
      .sort();
    expect(listed).toEqual(wanted);
  });

  it("the weaker cross-checks are DECLARED, not silently claimed as full coverage", () => {
    expect(Object.keys(PARTIAL_BEHAVIOURAL_COVERAGE).length).toBeGreaterThan(0);
    for (const [what, why] of Object.entries(PARTIAL_BEHAVIOURAL_COVERAGE)) {
      expect(what.length).toBeGreaterThan(0);
      expect(why.length).toBeGreaterThan(60);
    }
  });

  for (const [scenario, spec] of Object.entries(BEHAVIOURAL_SCENARIOS)) {
    it(
      `behaviour parity — ${scenario}`,
      async () => {
        const shName = scenario === "control/baseline" ? "baseline" : scenario;
        const sh = runShellScenario(shName);
        const js = await runJsScenario(scenario);

        // 1. the .sh implementation produced the required outcome
        expect({ signalled: sh.signalled, signals: sh.signals, reclaimed: sh.reclaimed }).toEqual(
          spec.outcome
        );
        // 2. the JS implementation produced the required outcome
        expect({ signalled: js.signalled, signals: js.signals, reclaimed: js.reclaimed }).toEqual(
          spec.outcome
        );
        // 3. …and they agree with EACH OTHER (the drift assertion proper)
        expect({ signalled: sh.signalled, signals: sh.signals, reclaimed: sh.reclaimed }).toEqual({
          signalled: js.signalled,
          signals: js.signals,
          reclaimed: js.reclaimed,
        });
        // 4. ANTI-VACUITY: each side proved the row was handled by the gate under
        //    test, not dropped earlier by something unrelated.
        if (spec.jsProof?.log) expect(js.log).toContain(spec.jsProof.log);
        if (spec.jsProof?.reason) expect(js.reasons).toContain(spec.jsProof.reason);
        if (spec.shProof?.log) expect(sh.log).toContain(spec.shProof.log);
        // 5. the .sh run never crashed (a non-zero exit would make (1) vacuous)
        expect(sh.exit).toBe(0);
      },
      120000
    );
  }

  it(
    "argv-redaction — NEITHER implementation writes the candidate's full argv anywhere",
    async () => {
      const sh = runShellScenario("argv-redaction");
      const js = await runJsScenario("argv-redaction");
      // Both DID act on the candidate (otherwise there is nothing to redact).
      expect(sh.reclaimed).toEqual([2001]);
      expect(js.reclaimed).toEqual([2001]);
      // …and neither the persisted sweep log nor the daemon log/event payloads
      // carry the secret that was sitting in argv.
      expect(sh.log).not.toContain(P_SECRET);
      expect(js.log).not.toContain(P_SECRET);
      expect(js.emitted).not.toContain(P_SECRET);
    },
    120000
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// CTL-1531 round 3 (M3) — the JS lsof deadline had NO test at all: deleting both
// `timeout:` options left the suite 314/0 green, and `grep -c timeout` over both
// JS test files returned 0. These drive the REAL default probes against a
// deliberately HUNG `lsof` on $PATH, with a sub-second CATALYST_LSOF_TIMEOUT_MS
// so the assertion is about the DEADLINE and not about wall-clock patience.
// ═══════════════════════════════════════════════════════════════════════════

describe("CTL-1531 — the lsof cwd probe is BOUNDED (PARITY: probe-deadline)", () => {
  /** withHungLsof — a mock `lsof` that blocks for `sleepSecs`, first on $PATH. */
  async function withHungLsof(sleepSecs, timeoutMs, fn) {
    const dir = mkdtempSync(join(tmpdir(), "lsof-deadline-"));
    const bin = join(dir, "lsof");
    // `trap '' TERM` is LOAD-BEARING, not decoration. A plain `sleep` dies on the
    // SIGTERM that node's execFile `timeout` option delivers, so the child exits,
    // the callback fires, and the promise settles — which made these tests pass
    // against a deadline that did not actually bound anything. The case the
    // deadline exists for is a probe wedged in uninterruptible I/O on a stale
    // mount, which ignores SIGTERM; modelled here by trapping it. Measured with a
    // 700ms deadline: 30,213ms before the watchdog fix, 703ms after.
    await Bun.write(bin, `#!/usr/bin/env bash\ntrap '' TERM\nsleep ${sleepSecs}\n`);
    chmodSync(bin, 0o755);
    const prevPath = process.env.PATH;
    const prevTimeout = process.env.CATALYST_LSOF_TIMEOUT_MS;
    process.env.PATH = `${dir}:${prevPath}`;
    if (timeoutMs === null) delete process.env.CATALYST_LSOF_TIMEOUT_MS;
    else process.env.CATALYST_LSOF_TIMEOUT_MS = String(timeoutMs);
    try {
      return await fn();
    } finally {
      process.env.PATH = prevPath;
      if (prevTimeout === undefined) delete process.env.CATALYST_LSOF_TIMEOUT_MS;
      else process.env.CATALYST_LSOF_TIMEOUT_MS = prevTimeout;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it(
    "_safeCwd gives up on a hung lsof and returns UNKNOWN (not a hang)",
    async () => {
      const reaper = new ProcReaper({ log: silentLog() }); // DEFAULT lsofCwd seam
      const t0 = Date.now();
      const got = await withHungLsof(3, 300, () => reaper._safeCwd(424242));
      const elapsed = Date.now() - t0;
      expect(got).toBeNull(); // unknown → spares
      // The mock blocks for 3s. Without the deadline this is ~3000ms.
      expect(elapsed).toBeLessThan(1500);
    },
    30000
  );

  it(
    "_safeCwdBatch gives up on a hung lsof and reports EVERY pid unknown",
    async () => {
      const reaper = new ProcReaper({ log: silentLog() }); // DEFAULT batch seam
      const t0 = Date.now();
      const got = await withHungLsof(3, 300, () => reaper._safeCwdBatch([101, 102, 103]));
      const elapsed = Date.now() - t0;
      expect([...got.keys()].sort((a, b) => a - b)).toEqual([101, 102, 103]);
      expect([...got.values()]).toEqual([null, null, null]); // unknown ⇒ spare all
      expect(elapsed).toBeLessThan(1500);
    },
    30000
  );

  it("lsofTimeoutMs: default, override, and every degrade-to-default case", () => {
    const prev = process.env.CATALYST_LSOF_TIMEOUT_MS;
    try {
      delete process.env.CATALYST_LSOF_TIMEOUT_MS;
      expect(lsofTimeoutMs()).toBe(5000);
      process.env.CATALYST_LSOF_TIMEOUT_MS = "250";
      expect(lsofTimeoutMs()).toBe(250);
      // A garbage / out-of-range / disabling value must fall back to the DEFAULT,
      // never to "unbounded" — 0, NaN and negatives all disable execFile's timeout.
      for (const bad of ["0", "-1", "abc", "", "600001", "NaN"]) {
        process.env.CATALYST_LSOF_TIMEOUT_MS = bad;
        expect(lsofTimeoutMs()).toBe(5000);
      }
    } finally {
      if (prev === undefined) delete process.env.CATALYST_LSOF_TIMEOUT_MS;
      else process.env.CATALYST_LSOF_TIMEOUT_MS = prev;
    }
  });
});
