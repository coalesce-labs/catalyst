// proc-reaper.test.mjs — CTL-1165 D2. The orphan child-process reaper (HIGHEST
// RISK). DEFAULT mode:"shadow" (emits would-reap, kills NOTHING). All IO is
// injected — no test spawns a subprocess, runs ps/lsof, touches ~/.claude, or
// signals a real pid. The CATASTROPHE GUARD (agents read {ok:false} → abort the
// sweep, kill nothing) is a first-class test.
//
// Run: cd plugins/dev/scripts/execution-core && bun test proc-reaper.test.mjs

import { describe, it, test, expect, mock } from "bun:test";
import {
  ProcReaper,
  classifyProc,
  isOrphaned,
  cwdUnderWorktreeRoot,
  buildAllowlist,
  collectLiveAgentSubtree,
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
function recordingKill({ alive = new Set() } = {}) {
  const calls = [];
  const fn = (pid, signal) => {
    calls.push([pid, signal]);
    if (signal === 0) return alive.has(pid);
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
    worktreePath: null,
    ...overrides,
  };
}

describe("classifyProc kill-gate (ALL must hold else SPARE)", () => {
  test("orphan node under a worktree, not in LIVE_TREE, old enough → kill", () => {
    const row = { pid: 10, ppid: 1, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const c = ctx();
    const v = classifyProc(row, c);
    expect(v.action).toBe("kill");
  });
  test("allowlisted argv (daemon) → spare(reason allowlisted)", () => {
    const row = {
      pid: 10,
      ppid: 1,
      command: "node",
      etimeSec: 1000,
      args: "node /x/execution-core/daemon.mjs --pid-file /y",
    };
    const v = classifyProc(row, ctx());
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("allowlisted");
  });
  test("pid in allowlist.pids (self/daemon/LIVE_TREE) → spare(reason allowlisted)", () => {
    const row = { pid: 100, ppid: 1, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const v = classifyProc(row, ctx({ allowlist: buildAllowlist({ selfPid: 100 }) }));
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("allowlisted");
  });
  test("pid in LIVE_TREE subtree → spare(reason live-agent-owned)", () => {
    const row = { pid: 222, ppid: 100, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const c = ctx({
      liveAgentSubtreePids: new Set([222]),
      byPid: new Map([[100, { pid: 100, ppid: 1 }]]),
    });
    const v = classifyProc(row, c);
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("live-agent-owned");
  });
  test("cwd matches a live-agent cwd → spare(reason live-agent-owned)", () => {
    const row = { pid: 10, ppid: 1, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const c = ctx({
      liveAgentCwds: new Set([`${WT_ROOT}/CTL-X`]),
      cwdForPid: () => `${WT_ROOT}/CTL-X`,
    });
    const v = classifyProc(row, c);
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("live-agent-owned");
  });
  test("command not in killableCommands → spare(reason command-not-killable)", () => {
    const row = { pid: 10, ppid: 1, command: "python", etimeSec: 1000, args: "python x.py" };
    const v = classifyProc(row, ctx());
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("command-not-killable");
  });
  test("not orphaned (has live ancestor) → spare(reason has-live-ancestor)", () => {
    const row = { pid: 10, ppid: 5, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const c = ctx({ byPid: new Map([[5, { pid: 5, ppid: 100 }]]), cwdForPid: () => null });
    const v = classifyProc(row, c);
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("has-live-ancestor");
  });
  test("lsof cwd unknown (null) → spare(reason cwd-unknown)", () => {
    const row = { pid: 10, ppid: 1, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const v = classifyProc(row, ctx({ cwdForPid: () => null }));
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("cwd-unknown");
  });
  test("cwd NOT under worktree root (interactive claude region) → spare(reason not-under-worktree-root)", () => {
    const row = { pid: 10, ppid: 1, command: "node", etimeSec: 1000, args: "node x.mjs" };
    const v = classifyProc(row, ctx({ cwdForPid: () => "/Users/test/somewhere-else" }));
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("not-under-worktree-root");
  });
  test("etime below minEtimeSec → spare(reason too-young)", () => {
    const row = { pid: 10, ppid: 1, command: "node", etimeSec: 100, args: "node x.mjs" };
    const v = classifyProc(row, ctx({ minEtimeSec: 900 }));
    expect(v.action).toBe("spare");
    expect(v.reason).toBe("too-young");
  });
  test("targeted worktreePath scopes the kill (boundary-safe: CTL-X ≠ CTL-X9)", () => {
    const row = { pid: 10, ppid: 1, command: "node", etimeSec: 1000, args: "node x.mjs" };
    // candidate cwd under CTL-X9, sweep targets CTL-X → spared (out of scope)
    const c = ctx({
      worktreePath: `${WT_ROOT}/CTL-X`,
      cwdForPid: () => `${WT_ROOT}/CTL-X9`,
    });
    const v = classifyProc(row, c);
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
