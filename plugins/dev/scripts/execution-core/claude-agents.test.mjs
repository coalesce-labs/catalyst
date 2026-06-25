// claude-agents.test.mjs — CTL-657. `claude agents --json` is the single source
// of truth for bg-worker liveness, termination, and concurrency. These tests
// exercise the pure logic against injected payloads (the `exec`/`agents`/`spawn`
// seams) so nothing shells out to the real `claude`.

import { describe, test, expect, beforeEach } from "bun:test";
import { execFile } from "node:child_process";
import {
  listClaudeAgents,
  listClaudeAgentsResult,
  cachedListClaudeAgents,
  resetLivenessCache,
  refreshAgents,
  getAgentsCached,
  agentForShortId,
  isBgJobAlive,
  livenessForBgJob,
  countBackgroundAgents,
  claudeStop,
  isBgJobDead,
  defaultStatJobState,
  setLivenessLogger,
} from "./claude-agents.mjs";

const agents = [
  { sessionId: "11111111-aaaa-bbbb-cccc-000000000001", status: "busy", kind: "background" },
  { sessionId: "22222222-aaaa-bbbb-cccc-000000000002", status: "idle", kind: "background" },
  { sessionId: "33333333-aaaa-bbbb-cccc-000000000003", status: "busy", kind: "interactive" },
];

describe("listClaudeAgents", () => {
  test("parses the JSON array from exec", () => {
    expect(listClaudeAgents({ exec: () => JSON.stringify(agents) })).toHaveLength(3);
  });

  test("returns [] on a throwing exec (binary missing)", () => {
    const exec = () => {
      throw new Error("claude: command not found");
    };
    expect(listClaudeAgents({ exec })).toEqual([]);
  });

  test("returns [] on non-JSON output", () => {
    expect(listClaudeAgents({ exec: () => "not json" })).toEqual([]);
  });

  test("returns [] when the parsed value is not an array", () => {
    expect(listClaudeAgents({ exec: () => JSON.stringify({ not: "an array" }) })).toEqual([]);
  });
});

describe("listClaudeAgentsResult", () => {
  test("ok:true with the parsed array on success", () => {
    expect(listClaudeAgentsResult({ exec: () => JSON.stringify(agents) })).toEqual({
      ok: true,
      agents,
    });
  });
  test("ok:false on a throwing exec (binary missing)", () => {
    const exec = () => {
      throw new Error("claude: command not found");
    };
    expect(listClaudeAgentsResult({ exec })).toEqual({ ok: false, agents: [] });
  });
  test("ok:false on non-JSON output", () => {
    expect(listClaudeAgentsResult({ exec: () => "not json" })).toEqual({ ok: false, agents: [] });
  });
  test("ok:false when the parsed value is not an array", () => {
    expect(listClaudeAgentsResult({ exec: () => JSON.stringify({ not: "array" }) })).toEqual({
      ok: false,
      agents: [],
    });
  });

  // CTL-1364: bound the SYNCHRONOUS `claude agents --json` spawn so a slow read
  // (we observed 66–78s liveness refreshes) can't stall a synchronous scheduler
  // tick through the phantom-bg-liveness probe (isBgJobAlive → listClaudeAgents)
  // or the reaper / *-gc / worktree-safety callers.
  describe("CTL-1364 bounded spawn", () => {
    test("passes a default Node timeout + killSignal to the spawn opts", () => {
      let seenOpts = null;
      const exec = (_bin, _args, opts) => {
        seenOpts = opts;
        return JSON.stringify([]);
      };
      listClaudeAgentsResult({ exec });
      expect(seenOpts).toMatchObject({
        encoding: "utf8",
        timeout: 5000,
        killSignal: "SIGKILL",
      });
    });

    test("a timed-out spawn (execFileSync throws ETIMEDOUT) → ok:false fail-safe", () => {
      // execFileSync throws on a `timeout` kill; the reader must degrade exactly
      // like a missing binary so the liveness decision falls through safely.
      const exec = () => {
        const err = new Error("spawnSync /bin/claude ETIMEDOUT");
        err.code = "ETIMEDOUT";
        throw err;
      };
      expect(listClaudeAgentsResult({ exec })).toEqual({ ok: false, agents: [] });
    });

    test("isBgJobAlive degrades to false when the bounded spawn times out", () => {
      // The phantom-bg-liveness fall-through caller: a timed-out probe must not
      // throw out of the tick; it returns false (caller falls through to revive).
      const exec = () => {
        const err = new Error("ETIMEDOUT");
        err.code = "ETIMEDOUT";
        throw err;
      };
      expect(isBgJobAlive("22222222", { exec })).toBe(false);
    });
  });
});

describe("cachedListClaudeAgents (CTL-672 TTL liveness cache)", () => {
  // Module-level cache → reset before each case so order doesn't leak state.
  beforeEach(() => resetLivenessCache());

  // A counting exec returning a fixed payload, plus a mutable clock.
  function harness(payload = agents) {
    let calls = 0;
    const exec = () => {
      calls += 1;
      return JSON.stringify(payload);
    };
    return { exec, calls: () => calls };
  }

  test("first call reads through and returns the parsed agents", () => {
    const h = harness();
    const got = cachedListClaudeAgents({ exec: h.exec, now: () => 1000 });
    expect(got).toHaveLength(3);
    expect(h.calls()).toBe(1);
  });

  test("second call within the TTL serves the cached snapshot WITHOUT re-exec", () => {
    const h = harness();
    cachedListClaudeAgents({ exec: h.exec, now: () => 1000, ttlMs: 5000 });
    const second = cachedListClaudeAgents({ exec: h.exec, now: () => 4000, ttlMs: 5000 });
    expect(second).toHaveLength(3);
    expect(h.calls()).toBe(1); // no second shell-out
  });

  test("refreshes once the TTL has elapsed", () => {
    const h = harness();
    cachedListClaudeAgents({ exec: h.exec, now: () => 1000, ttlMs: 5000 });
    cachedListClaudeAgents({ exec: h.exec, now: () => 6001, ttlMs: 5000 }); // > ttl later
    expect(h.calls()).toBe(2);
  });

  test("force:true bypasses a still-fresh cache", () => {
    const h = harness();
    cachedListClaudeAgents({ exec: h.exec, now: () => 1000 });
    cachedListClaudeAgents({ exec: h.exec, now: () => 1001, force: true });
    expect(h.calls()).toBe(2);
  });

  test("serves last-good on a failed refresh instead of flapping to [] (no false-absent storm)", () => {
    // Populate the cache, then let the TTL lapse and the refresh fail.
    let mode = "ok";
    const exec = () => {
      if (mode === "throw") throw new Error("transient claude agents failure");
      return JSON.stringify(agents);
    };
    cachedListClaudeAgents({ exec, now: () => 1000, ttlMs: 5000 });
    mode = "throw";
    const got = cachedListClaudeAgents({ exec, now: () => 7000, ttlMs: 5000 });
    expect(got).toHaveLength(3); // last-good, NOT []
  });

  test("a failed refresh does not advance the TTL — the next call retries the read", () => {
    let mode = "throw";
    let calls = 0;
    const exec = () => {
      calls += 1;
      if (mode === "throw") throw new Error("down");
      return JSON.stringify(agents);
    };
    // Cold start, refresh fails → []
    expect(cachedListClaudeAgents({ exec, now: () => 1000, ttlMs: 5000 })).toEqual([]);
    expect(calls).toBe(1);
    // Next call (still within what would be the TTL window) retries rather than
    // locking the failure in, and now succeeds.
    mode = "ok";
    expect(cachedListClaudeAgents({ exec, now: () => 1001, ttlMs: 5000 })).toHaveLength(3);
    expect(calls).toBe(2);
  });

  test("cold-start failure with no prior snapshot → []", () => {
    const exec = () => {
      throw new Error("boom");
    };
    expect(cachedListClaudeAgents({ exec, now: () => 1000 })).toEqual([]);
  });

  test("resetLivenessCache forces the next call to read through", () => {
    const h = harness();
    cachedListClaudeAgents({ exec: h.exec, now: () => 1000 });
    resetLivenessCache();
    cachedListClaudeAgents({ exec: h.exec, now: () => 1001 });
    expect(h.calls()).toBe(2);
  });
});

describe("agentForShortId", () => {
  test("finds the matching session by 8-char prefix", () => {
    expect(agentForShortId("22222222", agents)?.status).toBe("idle");
  });

  test("null when no session matches or inputs are malformed", () => {
    expect(agentForShortId("deadbeef", agents)).toBeNull();
    expect(agentForShortId("", agents)).toBeNull();
    expect(agentForShortId("11111111", null)).toBeNull();
  });
});

describe("isBgJobAlive", () => {
  test("true for a busy matching session", () => {
    expect(isBgJobAlive("11111111", { agents })).toBe(true);
  });

  test("true for an idle-between-turns session (still listed = alive)", () => {
    expect(isBgJobAlive("22222222", { agents })).toBe(true);
  });

  test("false when no session matches (crashed → dropped off the list)", () => {
    expect(isBgJobAlive("deadbeef", { agents })).toBe(false);
  });

  test("false for a falsy or malformed id, without consulting agents", () => {
    expect(isBgJobAlive(null, { agents })).toBe(false);
    expect(isBgJobAlive("bg-9", { agents })).toBe(false);
  });

  test("accepts the full UUID form (truncates to the short id)", () => {
    expect(isBgJobAlive("11111111-aaaa-bbbb-cccc-000000000001", { agents })).toBe(true);
  });

  test("falls back to listing agents when no list is injected", () => {
    expect(isBgJobAlive("22222222", { exec: () => JSON.stringify(agents) })).toBe(true);
  });
});

describe("livenessForBgJob", () => {
  // CTL-662 — the THREE-valued status reader reclaim keys on. Reuses the
  // canonical status fixture shape `{ sessionId, status, kind }`. Covers the
  // three-valued contract and the conservative present-but-not-idle ⇒ busy
  // normalization (never reclaim a present worker we cannot PROVE is idle).
  const statusAgents = [
    { sessionId: "11111111-aaaa-bbbb-cccc-000000000001", status: "busy", kind: "background" },
    { sessionId: "22222222-aaaa-bbbb-cccc-000000000002", status: "idle", kind: "background" },
    { sessionId: "33333333-aaaa-bbbb-cccc-000000000003", status: "active", kind: "background" }, // synonym for busy
    { sessionId: "44444444-aaaa-bbbb-cccc-000000000004", status: null, kind: "background" }, // present, status unknown
  ];

  test("present + status idle → 'idle'", () =>
    expect(livenessForBgJob("22222222", { agents: statusAgents })).toBe("idle"));
  test("present + status busy → 'busy'", () =>
    expect(livenessForBgJob("11111111", { agents: statusAgents })).toBe("busy"));
  test("present + status 'active' (busy synonym) → 'busy'", () =>
    expect(livenessForBgJob("33333333", { agents: statusAgents })).toBe("busy"));
  test("present + null status (unknown) → 'busy' (conservative: never reclaim a present worker we can't prove idle)", () =>
    expect(livenessForBgJob("44444444", { agents: statusAgents })).toBe("busy"));
  test("not listed → 'absent'", () =>
    expect(livenessForBgJob("99999999", { agents: statusAgents })).toBe("absent"));
  test("empty/falsy bgJobId → 'absent'", () =>
    expect(livenessForBgJob("", { agents: statusAgents })).toBe("absent"));
  test("malformed id (throws in shortIdFromSessionId, e.g. 'bg-9') → 'absent' WITHOUT shelling out", () =>
    expect(livenessForBgJob("bg-9", { agents: statusAgents })).toBe("absent"));
  test("failed `claude agents` read (exec throws) → 'absent'", () =>
    expect(
      livenessForBgJob("11111111", {
        exec: () => {
          throw new Error("boom");
        },
      }),
    ).toBe("absent"));
  test("accepts the full UUID form (truncates to the short id)", () =>
    expect(
      livenessForBgJob("22222222-aaaa-bbbb-cccc-000000000002", { agents: statusAgents }),
    ).toBe("idle"));
});

// --- CTL-1055: dead-session liveness classifier (Phase 1) -------------------

describe("isBgJobDead (dead-session liveness classifier)", () => {
  test("null job state (dir gone) → dead", () => {
    expect(isBgJobDead(null)).toBe(true);
  });
  test("terminal state values → dead", () => {
    for (const state of ["stopped", "failed", "done", "blocked"]) {
      expect(isBgJobDead({ state, firstTerminalAt: null })).toBe(true);
    }
  });
  test("firstTerminalAt set → dead even if state reads non-terminal", () => {
    expect(isBgJobDead({ state: "working", firstTerminalAt: "2026-06-11T17:00:00Z" })).toBe(true);
  });
  test("working / non-terminal, no firstTerminalAt → alive", () => {
    expect(isBgJobDead({ state: "working", firstTerminalAt: null })).toBe(false);
  });
  test("unreadable-but-present state.json (null state, dir exists) → alive (fail-alive)", () => {
    expect(isBgJobDead({ state: null, firstTerminalAt: null })).toBe(false);
  });
});

// defaultStatJobState is tested indirectly via the injected-statJob seam in
// Phase 2 — its filesystem I/O is kept out of unit tests by design.

describe("countBackgroundAgents", () => {
  // A statJob stub that reports every probed session as alive, so the pre-existing
  // kind-filter assertions stay meaningful without touching the real jobs root.
  const allAlive = () => ({ state: "working", firstTerminalAt: null });

  test("counts only kind==='background' (interactive sessions are excluded)", () => {
    expect(countBackgroundAgents({ agents, statJob: allAlive })).toBe(2);
  });

  test("does NOT count an absent/unknown kind (fail-low so it can't starve dispatch)", () => {
    const mixed = [
      { sessionId: "aaaaaaaa-0000-0000-0000-000000000000", kind: "background" },
      { sessionId: "bbbbbbbb-0000-0000-0000-000000000000" }, // no kind
      { sessionId: "cccccccc-0000-0000-0000-000000000000", kind: "interactive" },
    ];
    expect(countBackgroundAgents({ agents: mixed, statJob: allAlive })).toBe(1);
  });

  test("0 for an empty fleet", () => {
    expect(countBackgroundAgents({ agents: [], statJob: allAlive })).toBe(0);
  });

  // --- CTL-1055: dead-session exclusion ---
  // shortIdFromSessionId requires a hex-prefixed UUID (/^[0-9a-f]{8}-/).
  const bg = (id) => ({ sessionId: `${id}-0000-0000-0000-000000000000`, kind: "background" });

  test("excludes a terminal (done) background session", () => {
    const statJob = (shortId) =>
      shortId === "aaaaaaaa"
        ? { state: "done", firstTerminalAt: null }
        : { state: "working", firstTerminalAt: null };
    expect(countBackgroundAgents({ agents: [bg("aaaaaaaa"), bg("bbbbbbbb")], statJob })).toBe(1);
  });

  test("excludes a blocked/parked session (CTL-768: out of capacity, not killed)", () => {
    const statJob = () => ({ state: "blocked", firstTerminalAt: null });
    expect(countBackgroundAgents({ agents: [bg("aaaaaaaa")], statJob })).toBe(0);
  });

  test("counts a live (working, no firstTerminalAt) session", () => {
    const statJob = () => ({ state: "working", firstTerminalAt: null });
    expect(countBackgroundAgents({ agents: [bg("aaaaaaaa")], statJob })).toBe(1);
  });

  test("excludes a session whose job dir is gone (statJob → null)", () => {
    const statJob = () => null;
    expect(countBackgroundAgents({ agents: [bg("aaaaaaaa")], statJob })).toBe(0);
  });

  test("excludes a background agent with a malformed sessionId (fail-low, never probed)", () => {
    const statJob = () => ({ state: "working", firstTerminalAt: null });
    const malformed = [{ sessionId: "", kind: "background" }];
    expect(countBackgroundAgents({ agents: malformed, statJob })).toBe(0);
  });

  test("3 live + 5 terminal ghosts → 3 (the live repro)", () => {
    // Use hex-only IDs (shortIdFromSessionId requires /^[0-9a-f]{8}-/).
    const live = ["a1111111", "a2222222", "a3333333"].map(bg);
    const ghosts = ["b1111111", "b2222222", "b3333333", "b4444444", "b5555555"].map(bg);
    const liveSet = new Set(["a1111111", "a2222222", "a3333333"]);
    const statJob = (shortId) =>
      liveSet.has(shortId)
        ? { state: "working", firstTerminalAt: null }
        : { state: "done", firstTerminalAt: null };
    expect(countBackgroundAgents({ agents: [...live, ...ghosts], statJob })).toBe(3);
  });
});

// --- CTL-1165 D1: concurrency self-exclusion + live-count invariant fence ----
//
// The scheduler's in-flight count is the LIVE `claude agents` background count
// (scheduler.mjs:4247 inFlightCount = liveCount). countBackgroundAgents must
// therefore (a) NOT count the daemon's own controlling background session
// against maxParallel (a self-count is a starve-by-1, safe direction but wrong),
// and (b) keep counting a leaked-but-running / status:null zombie as occupying a
// slot — the safe "never over-dispatch on top of a live worker" invariant that a
// future "skip unknown status" optimization must never silently break. D1 adds
// the self-exclusion + fences both invariants; it makes NO dispatch-arithmetic
// change (that lives in the scheduler, unchanged).
describe("countBackgroundAgents — D1 self-exclusion + live-count invariant (CTL-1165)", () => {
  const allAlive = () => ({ state: "working", firstTerminalAt: null });
  // hex-prefixed UUID so shortIdFromSessionId(/^[0-9a-f]{8}-/) parses it.
  const bg = (id, extra = {}) => ({
    sessionId: `${id}-0000-0000-0000-000000000000`,
    kind: "background",
    ...extra,
  });

  test("excludes the self/controlling session even when background + alive (short-id env)", () => {
    const env = { CLAUDE_CODE_SESSION_ID: "aaaaaaaa" };
    expect(
      countBackgroundAgents({
        agents: [bg("aaaaaaaa"), bg("bbbbbbbb")],
        statJob: allAlive,
        env,
      }),
    ).toBe(1);
  });

  test("env unset → counts all background sessions (back-compat, fails closed/over-count-safe)", () => {
    // No CLAUDE_CODE_SESSION_ID → isSelfSession is false for everything → count all.
    expect(
      countBackgroundAgents({
        agents: [bg("aaaaaaaa"), bg("bbbbbbbb")],
        statJob: allAlive,
        env: {},
      }),
    ).toBe(2);
  });

  test("full-UUID env self id still drops the matching short-id session", () => {
    const env = { CLAUDE_CODE_SESSION_ID: "aaaaaaaa-0000-0000-0000-000000000000" };
    expect(
      countBackgroundAgents({
        agents: [bg("aaaaaaaa"), bg("bbbbbbbb")],
        statJob: allAlive,
        env,
      }),
    ).toBe(1);
  });

  test("counts a leaked-but-running worker so the scheduler cannot over-dispatch on top of it", () => {
    // 1 alive bg session whose signal would read terminal — the live-count design
    // (scheduler.mjs:4242) counts the PROCESS, not the signal scan. Pins it.
    expect(countBackgroundAgents({ agents: [bg("a1111111")], statJob: allAlive })).toBe(1);
  });

  test("interactive never counted; unknown/absent kind fails low; interactive self still excluded", () => {
    const env = { CLAUDE_CODE_SESSION_ID: "cccccccc" };
    const mixed = [
      bg("a1111111"), // background, counts
      { sessionId: "bbbbbbbb-0000-0000-0000-000000000000", kind: "interactive" }, // not counted
      { sessionId: "dddddddd-0000-0000-0000-000000000000" }, // no kind → fail-low
      { sessionId: "cccccccc-0000-0000-0000-000000000000", kind: "interactive" }, // self + interactive
    ];
    expect(countBackgroundAgents({ agents: mixed, statJob: allAlive, env })).toBe(1);
  });

  test("self-exclusion is the FIRST gate: a self session is dropped even if its job dir is gone (never throws, never counts)", () => {
    const env = { CLAUDE_CODE_SESSION_ID: "aaaaaaaa" };
    // statJob would classify it dead anyway, but the point is self is dropped up-front.
    expect(
      countBackgroundAgents({ agents: [bg("aaaaaaaa")], statJob: () => null, env }),
    ).toBe(0);
  });

  test("per-ticket duplicate workers each counted (two bg sessions, same ticket)", () => {
    expect(
      countBackgroundAgents({ agents: [bg("a1111111"), bg("a2222222")], statJob: allAlive }),
    ).toBe(2);
  });

  test("reboot-survivor status:null background zombie is counted-as-occupying (working job dir)", () => {
    // A status:null background session whose job dir is still present + working
    // holds a real slot — it MUST count (the invariant a 'skip unknown status'
    // optimization could silently break into over-dispatch).
    const statJob = () => ({ state: "working", firstTerminalAt: null });
    expect(
      countBackgroundAgents({ agents: [bg("a1111111", { status: null })], statJob }),
    ).toBe(1);
  });

  test("status:null zombie whose job dir is GONE → 0 (CTL-1055 ghost exclusion, regression fence)", () => {
    expect(
      countBackgroundAgents({ agents: [bg("a1111111", { status: null })], statJob: () => null }),
    ).toBe(0);
  });
});

describe("claudeStop", () => {
  test("issues `claude stop <shortId>` and reports ok on rc 0", () => {
    const calls = [];
    const spawn = (bin, args) => {
      calls.push({ bin, args });
      return { status: 0 };
    };
    expect(claudeStop("12345678", { spawn })).toEqual({ ok: true });
    expect(calls[0].args).toEqual(["stop", "12345678"]);
  });

  test("reports {ok:false} with stderr on a non-zero rc", () => {
    const spawn = () => ({ status: 1, stderr: "no such session\n" });
    expect(claudeStop("12345678", { spawn })).toEqual({ ok: false, error: "no such session" });
  });

  test("never throws — a throwing spawn becomes {ok:false}", () => {
    const spawn = () => {
      throw new Error("spawn EACCES");
    };
    expect(claudeStop("12345678", { spawn }).ok).toBe(false);
  });
});

// --- Phase 00 (CTL-731): hardened async liveness read ---------------------
//
// The daemon event loop was starved because `countBackgroundAgents` shelled out
// SYNCHRONOUSLY (execFileSync) every scheduler tick + autotune + per-worker
// reclaim. The hardened read replaces that hot path with ONE warm, shared,
// never-blocking snapshot. These tests pin the five safeguards from the plan:
// (a) async read, (b) timeout + child-kill, (c) single-flight, (d) backoff,
// (e) non-blocking getter that serves last-good and exposes freshness.
describe("refreshAgents + getAgentsCached (Phase 00 hardened liveness read)", () => {
  beforeEach(() => resetLivenessCache());

  test("(a/e) getAgentsCached returns last-good SYNCHRONOUSLY without awaiting the refresher", async () => {
    // Populate a good snapshot.
    await refreshAgents({ execFileAsync: async () => JSON.stringify(agents), now: () => 1000 });
    // Now read while stale, with a refresher that NEVER resolves — the getter
    // must still return the last-good snapshot immediately (no await).
    let refreshFired = false;
    const got = getAgentsCached({
      now: () => 999_999, // far past staleMs
      staleMs: 5000,
      refresh: () => {
        refreshFired = true;
        return new Promise(() => {}); // hangs forever
      },
    });
    expect(got.agents).toEqual(agents); // last-good, returned synchronously
    expect(got.isFresh).toBe(false);
    expect(got.populated).toBe(true);
    expect(refreshFired).toBe(true); // fired a background refresh (fire-and-forget)
  });

  test("(e) cold start: never-populated snapshot → populated:false, isFresh:false, agents:[]", () => {
    const got = getAgentsCached({ now: () => 1000, refresh: async () => [] });
    expect(got.populated).toBe(false);
    expect(got.isFresh).toBe(false);
    expect(got.agents).toEqual([]);
  });

  test("(c) single-flight: three concurrent refresh() calls spawn the read exactly once", async () => {
    let calls = 0;
    let resolveExec;
    const execFileAsync = () => {
      calls += 1;
      return new Promise((res) => {
        resolveExec = () => res(JSON.stringify(agents));
      });
    };
    const p1 = refreshAgents({ execFileAsync, now: () => 1000 });
    const p2 = refreshAgents({ execFileAsync, now: () => 1000 });
    const p3 = refreshAgents({ execFileAsync, now: () => 1000 });
    expect(calls).toBe(1); // only the first caller spawned the read
    resolveExec();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual(agents);
    expect(r2).toEqual(agents);
    expect(r3).toEqual(agents);
  });

  test("(b) timeout: a hung refresher aborts the child at the deadline and serves last-good", async () => {
    // Pre-populate so there IS a last-good to fall back to.
    await refreshAgents({ execFileAsync: async () => JSON.stringify(agents), now: () => 1000 });
    let capturedSignal = null;
    const hanging = (_bin, _args, opts) => {
      capturedSignal = opts.signal; // the AbortSignal the read is bound to
      return new Promise(() => {}); // never resolves
    };
    let timeoutCb = null;
    const setTimer = (cb) => {
      timeoutCb = cb;
      return 1; // fake handle
    };
    const clearTimer = () => {};
    const p = refreshAgents({
      execFileAsync: hanging,
      now: () => 5000,
      timeoutMs: 3000,
      setTimer,
      clearTimer,
    });
    timeoutCb(); // fire the deadline
    const result = await p;
    expect(result).toEqual(agents); // fell back to last-good, did NOT throw
    expect(capturedSignal?.aborted).toBe(true); // child was killed, not leaked
  });

  test("(b) timeout with NO prior snapshot falls back to [] (never throws)", async () => {
    const hanging = () => new Promise(() => {});
    let timeoutCb = null;
    const p = refreshAgents({
      execFileAsync: hanging,
      now: () => 5000,
      timeoutMs: 3000,
      setTimer: (cb) => {
        timeoutCb = cb;
        return 1;
      },
      clearTimer: () => {},
    });
    timeoutCb();
    expect(await p).toEqual([]);
  });

  test("(b/CTL-790) a read that COMPLETES before the deferred deadline verdict is HONORED, not discarded", async () => {
    // The production stall in miniature: the deadline fires, but the read already
    // settled (child exited). The deferred verdict must keep the good snapshot
    // rather than discard it as a timeout (the bug that wedged dispatch forever).
    let resolveRead = null;
    const child = { exitCode: null, signalCode: null };
    const reader = () => {
      const pr = new Promise((res) => {
        resolveRead = res;
      });
      pr.child = child;
      return pr;
    };
    let timeoutCb = null;
    let deferredCb = null;
    const p = refreshAgents({
      execFileAsync: reader,
      now: () => 1000,
      timeoutMs: 3000,
      setTimer: (cb) => {
        timeoutCb = cb;
        return 1;
      },
      clearTimer: () => {},
      deferDecision: (cb) => {
        deferredCb = cb;
      },
    });
    // Read completes (child exits) BEFORE the deferred verdict runs.
    child.exitCode = 0;
    resolveRead(JSON.stringify(agents));
    await Promise.resolve(); // let the read's .then mark `settled`
    timeoutCb(); // deadline fires → schedules the deferred verdict
    deferredCb(); // verdict runs AFTER the read settled → must no-op
    expect(await p).toEqual(agents); // NOT discarded
    const snap = getAgentsCached({ now: () => 1000 });
    expect(snap.populated).toBe(true);
    expect(snap.isFresh).toBe(true);
  });

  test("(b/CTL-790) a GENUINELY-running read (child not exited) IS aborted at the deadline", async () => {
    await refreshAgents({ execFileAsync: async () => JSON.stringify(agents), now: () => 1000 });
    const child = { exitCode: null, signalCode: null }; // still running
    let capturedSignal = null;
    const hanging = (_bin, _args, opts) => {
      capturedSignal = opts.signal;
      const pr = new Promise(() => {}); // never resolves
      pr.child = child;
      return pr;
    };
    let timeoutCb = null;
    const p = refreshAgents({
      execFileAsync: hanging,
      now: () => 5000,
      timeoutMs: 3000,
      setTimer: (cb) => {
        timeoutCb = cb;
        return 1;
      },
      clearTimer: () => {},
      deferDecision: (cb) => cb(), // run the verdict synchronously
    });
    timeoutCb();
    const result = await p;
    expect(capturedSignal?.aborted).toBe(true); // still running → aborted, not leaked
    expect(result).toEqual(agents); // served last-good
  });

  test("(b/CTL-790) INTEGRATION: a real read completing during a synchronous loop-block survives (libuv timers-before-poll)", async () => {
    // The exact production trap: a real subprocess finishes in ms, but a
    // synchronous scheduler tick busy-blocks the event loop > timeoutMs. The old
    // `Promise.race` discarded the completed read as a timeout; the deferred
    // verdict keeps it.
    const sample = [
      { sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000001", status: "idle", kind: "background" },
    ];
    const realReader = (_bin, _args, opts) => {
      let child;
      const pr = new Promise((res, rej) => {
        child = execFile(
          "sh",
          ["-c", `printf '%s' '${JSON.stringify(sample)}'`],
          opts,
          (err, stdout) => (err ? rej(err) : res(stdout)),
        );
      });
      pr.child = child;
      return pr;
    };
    const p = refreshAgents({ execFileAsync: realReader, timeoutMs: 100, now: () => 1000 });
    const end = Date.now() + 300; // block the loop > timeoutMs while the child finishes
    while (Date.now() < end) {
      /* busy-wait: starve the event loop, exactly like the synchronous tick */
    }
    await p;
    const snap = getAgentsCached({ now: () => 1000 });
    expect(snap.populated).toBe(true);
    expect(snap.isFresh).toBe(true);
    expect(snap.agents.length).toBe(1);
    // statJob: allAlive so the warm-snapshot path test is not tied to real job dirs.
    expect(countBackgroundAgents({ now: () => 1000, statJob: () => ({ state: "working", firstTerminalAt: null }) })).toBe(1);
  });

  test("(d) backoff: after the failure threshold, getAgentsCached does NOT fire a new refresh until the window elapses", async () => {
    // Drive 3 consecutive failures at a fixed clock so the backoff window is
    // deterministic. Each await lets the single-flight latch clear.
    const failing = async () => {
      throw new Error("claude agents down");
    };
    await refreshAgents({ execFileAsync: failing, now: () => 1000 });
    await refreshAgents({ execFileAsync: failing, now: () => 1000 });
    await refreshAgents({ execFileAsync: failing, now: () => 1000 }); // 3rd → backoff armed

    // Within the backoff window → no refresh fired.
    let fired = 0;
    getAgentsCached({
      now: () => 1500, // 1000 + base backoff (1000) = 2000 window; 1500 < 2000
      staleMs: 5000,
      refresh: async () => {
        fired += 1;
        return [];
      },
    });
    expect(fired).toBe(0); // suppressed by backoff

    // Past the backoff window → refresh fires again.
    getAgentsCached({
      now: () => 3000, // > 2000
      staleMs: 5000,
      refresh: async () => {
        fired += 1;
        return [];
      },
    });
    expect(fired).toBe(1);
  });

  test("(d) backoff: below the threshold every stale read still retries (no premature suppression)", async () => {
    const failing = async () => {
      throw new Error("down");
    };
    await refreshAgents({ execFileAsync: failing, now: () => 1000 }); // 1st failure only
    let fired = 0;
    getAgentsCached({
      now: () => 1001,
      staleMs: 5000,
      refresh: async () => {
        fired += 1;
        return [];
      },
    });
    expect(fired).toBe(1); // still retries (1 failure < threshold)
  });

  test("a successful refresh resets the failure counter / backoff", async () => {
    const failing = async () => {
      throw new Error("down");
    };
    await refreshAgents({ execFileAsync: failing, now: () => 1000 });
    await refreshAgents({ execFileAsync: failing, now: () => 1000 });
    await refreshAgents({ execFileAsync: failing, now: () => 1000 }); // backoff armed
    // A success clears it.
    await refreshAgents({ execFileAsync: async () => JSON.stringify(agents), now: () => 1100 });
    const snap = getAgentsCached({ now: () => 1100, staleMs: 5000 });
    expect(snap.isFresh).toBe(true);
    expect(snap.agents).toEqual(agents);
  });

  test("countBackgroundAgents sources from the warm snapshot (no exec) when agents not injected", async () => {
    await refreshAgents({ execFileAsync: async () => JSON.stringify(agents), now: () => 1000 });
    // now === snapshot ts → fresh → getAgentsCached does not fire a refresher.
    // statJob: allAlive so this test exercises the warm-snapshot path without
    // depending on real ~/.claude/jobs/ state (CTL-1055: default statJob does fs I/O).
    expect(countBackgroundAgents({ now: () => 1000, statJob: () => ({ state: "working", firstTerminalAt: null }) })).toBe(2);
  });
});

describe("setLivenessLogger + refreshAgents observability (CTL-1330 Tier 1)", () => {
  beforeEach(() => {
    resetLivenessCache();
    setLivenessLogger(null); // clear any sink between cases
  });

  test("resolved read records {outcome:'resolved', populated, deadline_ms, duration_ms}", async () => {
    const records = [];
    setLivenessLogger((r) => records.push(r));
    let t = 1000;
    await refreshAgents({
      execFileAsync: async () => JSON.stringify(agents),
      now: () => t,
      timeoutMs: 3000,
    });
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("resolved");
    expect(records[0].deadline_ms).toBe(3000);
    expect(records[0].populated).toBe(true);
    expect(typeof records[0].duration_ms).toBe("number");
  });

  test("read error records {outcome:'error'} and still serves last-good (never throws)", async () => {
    const records = [];
    setLivenessLogger((r) => records.push(r));
    const result = await refreshAgents({
      execFileAsync: async () => {
        throw new Error("boom");
      },
      now: () => 1000,
      timeoutMs: 3000,
    });
    expect(result).toEqual([]); // cold fallback
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("error");
  });

  test("deadline timeout records {outcome:'timeout'} with duration≈deadline", async () => {
    const records = [];
    setLivenessLogger((r) => records.push(r));
    const hanging = () => new Promise(() => {}); // never settles, no .child
    let timeoutCb = null;
    const p = refreshAgents({
      execFileAsync: hanging,
      now: () => 5000,
      timeoutMs: 3000,
      setTimer: (cb) => {
        timeoutCb = cb;
        return 1;
      },
      clearTimer: () => {},
      deferDecision: (cb) => cb(), // run the verdict synchronously
    });
    timeoutCb(); // fire the deadline
    await p;
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("timeout");
    expect(records[0].deadline_ms).toBe(3000);
  });

  test("a null sink (default) never throws out of refreshAgents", async () => {
    setLivenessLogger(null);
    const result = await refreshAgents({
      execFileAsync: async () => JSON.stringify(agents),
      now: () => 1000,
    });
    expect(result).toEqual(agents);
  });

  test("a THROWING sink never breaks the refresh (best-effort observability)", async () => {
    setLivenessLogger(() => {
      throw new Error("sink blew up");
    });
    const result = await refreshAgents({
      execFileAsync: async () => JSON.stringify(agents),
      now: () => 1000,
    });
    expect(result).toEqual(agents);
  });
});
