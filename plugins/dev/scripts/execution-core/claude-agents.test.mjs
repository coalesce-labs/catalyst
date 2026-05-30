// claude-agents.test.mjs — CTL-657. `claude agents --json` is the single source
// of truth for bg-worker liveness, termination, and concurrency. These tests
// exercise the pure logic against injected payloads (the `exec`/`agents`/`spawn`
// seams) so nothing shells out to the real `claude`.

import { describe, test, expect, beforeEach } from "bun:test";
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

describe("countBackgroundAgents", () => {
  test("counts only kind==='background' (interactive sessions are excluded)", () => {
    expect(countBackgroundAgents({ agents })).toBe(2);
  });

  test("does NOT count an absent/unknown kind (fail-low so it can't starve dispatch)", () => {
    const mixed = [
      { sessionId: "aaaaaaaa-0000-0000-0000-000000000000", kind: "background" },
      { sessionId: "bbbbbbbb-0000-0000-0000-000000000000" }, // no kind
      { sessionId: "cccccccc-0000-0000-0000-000000000000", kind: "interactive" },
    ];
    expect(countBackgroundAgents({ agents: mixed })).toBe(1);
  });

  test("0 for an empty fleet", () => {
    expect(countBackgroundAgents({ agents: [] })).toBe(0);
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
    expect(countBackgroundAgents({ now: () => 1000 })).toBe(2);
  });
});
