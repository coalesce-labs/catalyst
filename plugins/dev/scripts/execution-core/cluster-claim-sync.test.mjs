// cluster-claim-sync.test.mjs — the synchronous spawnSync bridge over the
// cluster-claim CLI (CTL-850). Every test injects a fake `spawn` so nothing
// actually forks a process; the focus is argv construction + stdout parsing +
// the FAIL-CLOSED contract (won:false on any failure).
import { describe, it, expect, beforeEach } from "bun:test";

import {
  claimDispatchSync,
  CLAIM_REASON,
  isClaimFailure,
  fenceCheckSync,
  fenceCheckSyncCached,
  clearFenceReadCache,
  resolveIssueIdSync,
  resolveIssueIdSyncCached,
  clearIssueIdCache,
  readTriageAttemptCountSync,
  bumpTriageAttemptCountSync,
  resetTriageAttemptCountSync,
  clearTriageAttemptCacheSync,
} from "./cluster-claim-sync.mjs";

describe("claimDispatchSync — argv + parsing", () => {
  it("builds the right argv: node <cli> claim <ticket> <host> <phase>", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = { bin, args };
      return { status: 0, stdout: JSON.stringify({ won: true, generation: 1 }) + "\n" };
    };
    claimDispatchSync(
      { ticket: "CTL-7", hostName: "mac-studio", phase: "triage" },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-claim.mjs" },
    );
    expect(captured.bin).toBe("/usr/bin/node");
    expect(captured.args).toEqual([
      "/x/cluster-claim.mjs",
      "claim",
      "CTL-7",
      "mac-studio",
      "triage",
    ]);
  });

  it("parses {won, generation} from the CLI stdout on exit 0", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ won: true, generation: 3 }) + "\n" });
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: true,
      generation: 3,
      reason: CLAIM_REASON.WON,
      detail: null,
    });
  });

  it("won:false from stdout is preserved (a lost soft-CAS, not an error)", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ won: false, generation: 2 }) + "\n" });
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: false,
      generation: 2,
      reason: CLAIM_REASON.PEER_WON,
      detail: null,
    });
  });
});

describe("claimDispatchSync — FAIL-CLOSED on every failure mode", () => {
  it("non-zero exit → won:false", () => {
    const spawn = () => ({ status: 1, stdout: "" });
    const r = claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn });
    expect(r.won).toBe(false);
    expect(r.generation).toBeNull();
  });

  it("unparseable stdout → won:false", () => {
    const spawn = () => ({ status: 0, stdout: "not json at all" });
    const r = claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn });
    expect(r.won).toBe(false);
    expect(r.generation).toBeNull();
  });

  it("timeout / spawn error (status null) → won:false", () => {
    const spawn = () => ({ status: null, error: new Error("ETIMEDOUT"), stdout: null });
    const r = claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn });
    expect(r.won).toBe(false);
    expect(r.generation).toBeNull();
  });

  it("spawn throws → won:false (never propagates)", () => {
    const spawn = () => {
      throw new Error("EACCES");
    };
    const r = claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn });
    expect(r.won).toBe(false);
    expect(r.generation).toBeNull();
  });

  it("missing/garbage generation in stdout → generation null but won honoured", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ won: true }) + "\n" });
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: true,
      generation: null,
      reason: CLAIM_REASON.WON,
      detail: null,
    });
  });
});

// ─── CTL-2033 ────────────────────────────────────────────────────────────────
// The whole point of this suite is that NO TWO of these outcomes may share a
// value. Every case below asserts the exact `reason`, so collapsing any pair
// (the pre-CTL-2033 behaviour — one `{won:false, generation:null}` for all of
// them) fails HERE rather than three hours into an operator's evening.
//
// ⚠️ Mutation-verified: reverting `claimDispatchSync`'s body to the single
// `return { won:false, generation:null }` fails 6 of these; making
// `classifyCliReason` return CLI_FAILED unconditionally fails the budget case;
// making `isClaimFailure` return `false` on an unknown reason fails the
// fail-loud case.
describe("claimDispatchSync — CTL-2033: the four outcomes are DISTINGUISHABLE", () => {
  const claim = (spawn) => claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "triage" }, { spawn });

  it("a peer legitimately winning the fence is `peer-won` — and is NOT a failure", () => {
    const r = claim(() => ({ status: 0, stdout: JSON.stringify({ won: false, generation: 7 }) + "\n" }));
    expect(r.reason).toBe(CLAIM_REASON.PEER_WON);
    expect(isClaimFailure(r.reason)).toBe(false);
    expect(r.detail).toBeNull();
  });

  it("a HOST-BUDGET refusal is `budget-refused`, distinct from every other failure", () => {
    const r = claim(() => ({
      status: 11,
      stdout:
        JSON.stringify({
          won: false,
          generation: null,
          error: { reason: "budget:day-exhausted", message: "cluster-attachment: budget:day-exhausted (route=attachment ticket=CTL-1)" },
        }) + "\n",
    }));
    expect(r.reason).toBe(CLAIM_REASON.BUDGET_REFUSED);
    expect(r.reason).not.toBe(CLAIM_REASON.PEER_WON);
    expect(r.reason).not.toBe(CLAIM_REASON.CLI_FAILED);
    expect(isClaimFailure(r.reason)).toBe(true);
    expect(r.detail).toContain("budget:day-exhausted");
  });

  it("a NON-budget CLI failure is `cli-failed`, and carries the CLI's own reason word", () => {
    const r = claim(() => ({
      status: 11,
      stdout: JSON.stringify({ won: false, generation: null, error: { reason: "no-cloud-token", message: "cluster-attachment: no-cloud-token" } }) + "\n",
    }));
    expect(r.reason).toBe(CLAIM_REASON.CLI_FAILED);
    expect(r.reason).not.toBe(CLAIM_REASON.BUDGET_REFUSED);
    expect(r.detail).toContain("no-cloud-token");
    expect(isClaimFailure(r.reason)).toBe(true);
  });

  it("a non-zero exit with NO structured error is `cli-failed` and keeps exit + stderr as evidence", () => {
    const r = claim(() => ({ status: 1, stdout: "", stderr: "cluster-claim.mjs: linear graphql http 401\n" }));
    expect(r.reason).toBe(CLAIM_REASON.CLI_FAILED);
    expect(r.detail).toContain("exit=1");
    expect(r.detail).toContain("401");
  });

  it("stdout that does not parse is its OWN outcome — never folded into cli-failed or peer-won", () => {
    const r = claim(() => ({ status: 0, stdout: "not json at all" }));
    expect(r.reason).toBe(CLAIM_REASON.UNPARSEABLE);
    expect(r.reason).not.toBe(CLAIM_REASON.CLI_FAILED);
    expect(r.reason).not.toBe(CLAIM_REASON.PEER_WON);
    expect(r.detail).toContain("not json at all");
  });

  it("a spawn that throws is `spawn-threw`, not a lost race", () => {
    const r = claim(() => {
      throw new Error("EAGAIN");
    });
    expect(r.reason).toBe(CLAIM_REASON.SPAWN_THREW);
    expect(isClaimFailure(r.reason)).toBe(true);
    expect(r.detail).toContain("EAGAIN");
  });

  it("a timeout (status null, no stdout) is a failure, never `peer-won`", () => {
    const r = claim(() => ({ status: null, error: new Error("ETIMEDOUT"), stdout: null }));
    expect(isClaimFailure(r.reason)).toBe(true);
    expect(r.reason).not.toBe(CLAIM_REASON.PEER_WON);
  });

  it("EVERY outcome carries a non-null reason — the field can never be null again", () => {
    const spawns = [
      () => ({ status: 0, stdout: JSON.stringify({ won: true, generation: 1 }) + "\n" }),
      () => ({ status: 0, stdout: JSON.stringify({ won: false, generation: 1 }) + "\n" }),
      () => ({ status: 11, stdout: JSON.stringify({ won: false, error: { reason: "budget:day-exhausted" } }) + "\n" }),
      () => ({ status: 11, stdout: JSON.stringify({ won: false, error: { reason: "write-not-succeeded" } }) + "\n" }),
      () => ({ status: 1, stdout: "" }),
      () => ({ status: 0, stdout: "garbage" }),
      () => {
        throw new Error("boom");
      },
    ];
    const reasons = spawns.map((sp) => claim(sp).reason);
    expect(reasons.every((r) => typeof r === "string" && r.length > 0)).toBe(true);
    // ...and they are not all the same value, which a `reason: "unknown"` constant
    // would satisfy while telling an operator nothing.
    expect(new Set(reasons).size).toBeGreaterThanOrEqual(5);
  });

  it("a structured error is authoritative even at exit 0 — an exit-code change cannot reclassify a failure as a race", () => {
    const r = claim(() => ({ status: 0, stdout: JSON.stringify({ won: false, error: { reason: "budget:day-exhausted" } }) + "\n" }));
    expect(r.reason).toBe(CLAIM_REASON.BUDGET_REFUSED);
  });

  it("detail is bounded and token-shaped text is masked before it reaches a log line", () => {
    const long = "x".repeat(4000);
    const r = claim(() => ({ status: 1, stdout: "", stderr: `token lin_api_abc123DEF456 ${long}` }));
    expect(r.detail.length).toBeLessThanOrEqual(241);
    expect(r.detail).toContain("[redacted]");
    expect(r.detail).not.toContain("lin_api_abc123DEF456");
  });
});

describe("isClaimFailure — CTL-2033: fail-loud on the unknown", () => {
  it("only `won` and `peer-won` are non-failures", () => {
    expect(isClaimFailure(CLAIM_REASON.WON)).toBe(false);
    expect(isClaimFailure(CLAIM_REASON.PEER_WON)).toBe(false);
    for (const r of [CLAIM_REASON.BUDGET_REFUSED, CLAIM_REASON.CLI_FAILED, CLAIM_REASON.UNPARSEABLE, CLAIM_REASON.SPAWN_THREW]) {
      expect(isClaimFailure(r)).toBe(true);
    }
  });

  it("a null reason (a pre-CTL-2033 shape, or an old injected double) reads as a FAILURE, not as normal", () => {
    expect(isClaimFailure(null)).toBe(true);
    expect(isClaimFailure(undefined)).toBe(true);
    expect(isClaimFailure("something-nobody-has-written-yet")).toBe(true);
  });
});

describe("fenceCheckSync — argv + exit-code interpretation (CTL-890)", () => {
  it("builds the right argv: node <cli> fence-check <ticket> <gen>", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = { bin, args };
      return { status: 0 };
    };
    fenceCheckSync(
      { ticket: "CTL-7", generation: 4 },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-claim.mjs" },
    );
    expect(captured.bin).toBe("/usr/bin/node");
    expect(captured.args).toEqual([
      "/x/cluster-claim.mjs",
      "fence-check",
      "CTL-7",
      "4",
    ]);
  });

  it("exit 0 → { current:true } (the generation is current — proceed)", () => {
    const spawn = () => ({ status: 0, stdout: '{"current":true}\n' });
    expect(fenceCheckSync({ ticket: "CTL-1", generation: 2 }, { spawn })).toEqual({
      current: true,
      stale: false,
    });
  });

  it("exit 10 (FENCE_STALE_EXIT) → { current:false, stale:true } (a partitioned generation)", () => {
    const spawn = () => ({ status: 10, stdout: '{"current":false}\n' });
    expect(fenceCheckSync({ ticket: "CTL-1", generation: 2 }, { spawn })).toEqual({
      current: false,
      stale: true,
    });
  });
});

describe("claimDispatchSync — env passthrough (CTL-1297)", () => {
  it("forwards EXECUTION_CORE_CLAIM_STALE_MS (and full env) to the claim subprocess", () => {
    let capturedOpts;
    const spawn = (bin, args, opts) => {
      capturedOpts = opts;
      return { status: 0, stdout: JSON.stringify({ won: true, generation: 1 }) + "\n" };
    };
    const env = { ...process.env, EXECUTION_CORE_CLAIM_STALE_MS: "60000" };
    claimDispatchSync(
      { ticket: "CTL-7", hostName: "mini", phase: "triage" },
      { spawn, env },
    );
    expect(capturedOpts.env).toBe(env);
    expect(capturedOpts.env.EXECUTION_CORE_CLAIM_STALE_MS).toBe("60000");
  });
});

describe("fenceCheckSync — FAIL-CLOSED on every indeterminate failure", () => {
  it("any other non-zero exit → { current:false, stale:false }", () => {
    const spawn = () => ({ status: 1, stdout: "" });
    expect(fenceCheckSync({ ticket: "CTL-1", generation: 2 }, { spawn })).toEqual({
      current: false,
      stale: false,
    });
  });

  it("timeout / spawn error (status null) → { current:false, stale:false }", () => {
    const spawn = () => ({ status: null, error: new Error("ETIMEDOUT") });
    expect(fenceCheckSync({ ticket: "CTL-1", generation: 2 }, { spawn })).toEqual({
      current: false,
      stale: false,
    });
  });

  it("spawn throws → { current:false, stale:false } (never propagates)", () => {
    const spawn = () => {
      throw new Error("EACCES");
    };
    expect(fenceCheckSync({ ticket: "CTL-1", generation: 2 }, { spawn })).toEqual({
      current: false,
      stale: false,
    });
  });
});

describe("fenceCheckSyncCached — in-process TTL cache around the fence read (CTL-863 fleet-unfreeze)", () => {
  beforeEach(() => {
    // The cache is module-scope (persists for the daemon process's lifetime by
    // design) — reset it between cases so tests don't pollute each other via a
    // shared ticket::generation key.
    clearFenceReadCache();
  });

  it("(a) two reads within TTL for the same ticket+generation → ONE underlying spawn call", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 0, stdout: '{"current":true}\n' };
    };
    let now = 1_000_000;
    const first = fenceCheckSyncCached({ ticket: "CTL-1", generation: 5 }, { spawn, now: () => now });
    now += 1_000; // 1s later — well within the 45s default TTL
    const second = fenceCheckSyncCached({ ticket: "CTL-1", generation: 5 }, { spawn, now: () => now });
    expect(first).toEqual({ current: true, stale: false });
    expect(second).toEqual({ current: true, stale: false });
    expect(calls).toBe(1); // second call served from cache, no spawn
  });

  it("(b) after TTL expiry → a fresh read (spawn called again)", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 0, stdout: '{"current":true}\n' };
    };
    let now = 1_000_000;
    fenceCheckSyncCached({ ticket: "CTL-2", generation: 3 }, { spawn, now: () => now, env: { CATALYST_FENCE_READ_CACHE_MS: "45000" } });
    now += 45_001; // just past the 45s TTL
    fenceCheckSyncCached({ ticket: "CTL-2", generation: 3 }, { spawn, now: () => now, env: { CATALYST_FENCE_READ_CACHE_MS: "45000" } });
    expect(calls).toBe(2); // TTL expired → the second call re-spawned
  });

  it("(c) CATALYST_FENCE_READ_CACHE_MS=0 disables the cache — every read hits through", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 0, stdout: '{"current":true}\n' };
    };
    const env = { CATALYST_FENCE_READ_CACHE_MS: "0" };
    const now = () => 1_000_000; // frozen clock — proves it's the env flag, not elapsed time
    fenceCheckSyncCached({ ticket: "CTL-3", generation: 1 }, { spawn, env, now });
    fenceCheckSyncCached({ ticket: "CTL-3", generation: 1 }, { spawn, env, now });
    fenceCheckSyncCached({ ticket: "CTL-3", generation: 1 }, { spawn, env, now });
    expect(calls).toBe(3); // cache fully disabled — no memoization at all
  });

  it("(d) an indeterminate/error result is NEVER cached — the next call retries the real read", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 1, stdout: "" }; // non-zero, non-FENCE_STALE_EXIT → indeterminate/error
    };
    const now = () => 1_000_000; // frozen clock — within TTL, so only caching (not expiry) explains a re-spawn
    const first = fenceCheckSyncCached({ ticket: "CTL-4", generation: 2 }, { spawn, now });
    const second = fenceCheckSyncCached({ ticket: "CTL-4", generation: 2 }, { spawn, now });
    expect(first).toEqual({ current: false, stale: false });
    expect(second).toEqual({ current: false, stale: false });
    expect(calls).toBe(2); // NOT cached — both calls spawned
  });

  it("a confirmed-stale determinate result (current:false, stale:true) IS cached", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 10, stdout: '{"current":false}\n' }; // FENCE_STALE_EXIT
    };
    const now = () => 1_000_000;
    fenceCheckSyncCached({ ticket: "CTL-5", generation: 1 }, { spawn, now });
    fenceCheckSyncCached({ ticket: "CTL-5", generation: 1 }, { spawn, now });
    expect(calls).toBe(1); // confirmed-stale is a determinate answer — cached
  });

  it("different generations for the SAME ticket are NOT interchangeable — each gets its own read", () => {
    const seen = [];
    const spawn = (bin, args) => {
      seen.push(args[3]); // the generation argv
      return { status: 0, stdout: '{"current":true}\n' };
    };
    const now = () => 1_000_000;
    fenceCheckSyncCached({ ticket: "CTL-6", generation: 1 }, { spawn, now });
    fenceCheckSyncCached({ ticket: "CTL-6", generation: 2 }, { spawn, now });
    expect(seen).toEqual(["1", "2"]); // both spawned — distinct cache keys
  });

  it("falls through to a real fenceCheckSync on a cache miss (argv unchanged)", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = { bin, args };
      return { status: 0, stdout: '{"current":true}\n' };
    };
    const now = () => 1_000_000;
    fenceCheckSyncCached(
      { ticket: "CTL-7", generation: 4 },
      { spawn, now, nodeBin: "/usr/bin/node", cli: "/x/cluster-claim.mjs" },
    );
    expect(captured.bin).toBe("/usr/bin/node");
    expect(captured.args).toEqual(["/x/cluster-claim.mjs", "fence-check", "CTL-7", "4"]);
  });
});

describe("resolveIssueIdSync — argv + parsing (CTL-863 entourage follow-up)", () => {
  it("builds the right argv: node <cli> resolve-issue-id <ticket>", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = { bin, args };
      return { status: 0, stdout: '{"issueId":"uuid-CTL-9"}\n' };
    };
    resolveIssueIdSync(
      { ticket: "CTL-9" },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-claim.mjs" },
    );
    expect(captured.bin).toBe("/usr/bin/node");
    expect(captured.args).toEqual(["/x/cluster-claim.mjs", "resolve-issue-id", "CTL-9"]);
  });

  it("parses the resolved UUID from stdout", () => {
    const spawn = () => ({ status: 0, stdout: '{"issueId":"uuid-CTL-9"}\n' });
    expect(resolveIssueIdSync({ ticket: "CTL-9" }, { spawn })).toBe("uuid-CTL-9");
  });

  it("a null issueId (missing ticket) → null", () => {
    const spawn = () => ({ status: 0, stdout: '{"issueId":null}\n' });
    expect(resolveIssueIdSync({ ticket: "CTL-9" }, { spawn })).toBeNull();
  });

  it("non-zero exit / spawn error / unparseable stdout / throw → null (fail-open)", () => {
    expect(resolveIssueIdSync({ ticket: "CTL-9" }, { spawn: () => ({ status: 1, stdout: "" }) })).toBeNull();
    expect(
      resolveIssueIdSync({ ticket: "CTL-9" }, { spawn: () => ({ status: null, error: new Error("ETIMEDOUT") }) }),
    ).toBeNull();
    expect(resolveIssueIdSync({ ticket: "CTL-9" }, { spawn: () => ({ status: 0, stdout: "not json" }) })).toBeNull();
    expect(
      resolveIssueIdSync({ ticket: "CTL-9" }, { spawn: () => { throw new Error("EACCES"); } }),
    ).toBeNull();
  });
});

describe("resolveIssueIdSyncCached — permanent identifier→UUID cache (CTL-863 entourage follow-up)", () => {
  beforeEach(() => {
    clearIssueIdCache();
  });

  it("(a) two resolves of the same ticket → ONE underlying spawn call", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 0, stdout: '{"issueId":"uuid-CTL-1"}\n' };
    };
    const first = resolveIssueIdSyncCached({ ticket: "CTL-1" }, { spawn });
    const second = resolveIssueIdSyncCached({ ticket: "CTL-1" }, { spawn });
    expect(first).toBe("uuid-CTL-1");
    expect(second).toBe("uuid-CTL-1");
    expect(calls).toBe(1); // second call served from the permanent cache, no spawn
  });

  it("persists beyond any TTL window — no expiry, ever (permanent cache)", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 0, stdout: '{"issueId":"uuid-CTL-2"}\n' };
    };
    let now = 1_000_000;
    resolveIssueIdSyncCached({ ticket: "CTL-2" }, { spawn, now: () => now });
    now += 10 * 24 * 60 * 60 * 1000; // 10 days later — far past any TTL a read cache would use
    resolveIssueIdSyncCached({ ticket: "CTL-2" }, { spawn, now: () => now });
    expect(calls).toBe(1); // still cached — this cache has no TTL at all
  });

  it("CATALYST_ANCHOR_UUID_CACHE=0 disables the cache — every resolve hits through", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 0, stdout: '{"issueId":"uuid-CTL-3"}\n' };
    };
    const env = { CATALYST_ANCHOR_UUID_CACHE: "0" };
    resolveIssueIdSyncCached({ ticket: "CTL-3" }, { spawn, env });
    resolveIssueIdSyncCached({ ticket: "CTL-3" }, { spawn, env });
    expect(calls).toBe(2); // cache fully disabled — no memoization at all
  });

  it("a failed/null resolution is NEVER cached — the next call retries for real", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 1, stdout: "" }; // non-zero exit → resolution failure
    };
    const first = resolveIssueIdSyncCached({ ticket: "CTL-4" }, { spawn });
    const second = resolveIssueIdSyncCached({ ticket: "CTL-4" }, { spawn });
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(calls).toBe(2); // NOT cached — both calls spawned
  });

  it("different tickets are NOT interchangeable — each gets its own resolve + cache slot", () => {
    const seen = [];
    const spawn = (bin, args) => {
      seen.push(args[2]); // the ticket argv
      return { status: 0, stdout: JSON.stringify({ issueId: `uuid-${args[2]}` }) + "\n" };
    };
    expect(resolveIssueIdSyncCached({ ticket: "CTL-5" }, { spawn })).toBe("uuid-CTL-5");
    expect(resolveIssueIdSyncCached({ ticket: "CTL-6" }, { spawn })).toBe("uuid-CTL-6");
    expect(seen).toEqual(["CTL-5", "CTL-6"]); // both spawned — distinct cache keys
  });
});

describe("claimDispatchSync — pre-resolved issueId is threaded into the claim argv (CTL-863 entourage follow-up)", () => {
  beforeEach(() => {
    clearIssueIdCache();
  });

  it("a successful pre-resolve appends the UUID as the claim CLI's 4th arg", () => {
    let claimArgs;
    const spawn = (bin, args) => {
      if (args[1] === "resolve-issue-id") {
        return { status: 0, stdout: '{"issueId":"uuid-CTL-9"}\n' };
      }
      claimArgs = args;
      return { status: 0, stdout: JSON.stringify({ won: true, generation: 1 }) + "\n" };
    };
    claimDispatchSync({ ticket: "CTL-9", hostName: "mini", phase: "triage" }, { spawn });
    expect(claimArgs[claimArgs.length - 1]).toBe("uuid-CTL-9");
  });

  it("a failed pre-resolve falls back to the plain 3-arg claim form (unchanged behavior)", () => {
    let claimArgs;
    const spawn = (bin, args) => {
      if (args[1] === "resolve-issue-id") {
        return { status: 1, stdout: "" }; // resolution fails
      }
      claimArgs = args;
      return { status: 0, stdout: JSON.stringify({ won: true, generation: 1 }) + "\n" };
    };
    claimDispatchSync(
      { ticket: "CTL-9", hostName: "mini", phase: "triage" },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-claim.mjs" },
    );
    expect(claimArgs).toEqual(["/x/cluster-claim.mjs", "claim", "CTL-9", "mini", "triage"]);
  });
});

// ─── CTL-1649: readTriageAttemptCountSync ────────────────────────────────────

describe("readTriageAttemptCountSync — argv + parsing (CTL-1649)", () => {
  beforeEach(() => {
    clearTriageAttemptCacheSync();
  });

  it("builds the right argv: node <cli> read-triage-attempt <ticket>", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = { bin, args };
      return { status: 0, stdout: JSON.stringify({ count: 2 }) + "\n" };
    };
    readTriageAttemptCountSync(
      { ticket: "CTL-1649" },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-claim.mjs", env: { CATALYST_TRIAGE_ATTEMPT_CACHE_MS: "0" } },
    );
    expect(captured.bin).toBe("/usr/bin/node");
    expect(captured.args).toEqual(["/x/cluster-claim.mjs", "read-triage-attempt", "CTL-1649"]);
  });

  it("parses { count } from exit-0 stdout", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ count: 3 }) + "\n" });
    const result = readTriageAttemptCountSync(
      { ticket: "CTL-1649" },
      { spawn, env: { CATALYST_TRIAGE_ATTEMPT_CACHE_MS: "0" } },
    );
    expect(result).toEqual({ count: 3 });
  });

  it("count:0 is a valid determinate result (fence exists, no bumps yet)", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ count: 0 }) + "\n" });
    expect(readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env: { CATALYST_TRIAGE_ATTEMPT_CACHE_MS: "0" } }))
      .toEqual({ count: 0 });
  });

  it("count:null is passed through (fence-absent — fail-open)", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ count: null }) + "\n" });
    expect(readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env: { CATALYST_TRIAGE_ATTEMPT_CACHE_MS: "0" } }))
      .toEqual({ count: null });
  });

  it("non-zero exit → { count: null } (fail-open)", () => {
    const spawn = () => ({ status: 1, stdout: "" });
    expect(readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env: { CATALYST_TRIAGE_ATTEMPT_CACHE_MS: "0" } }))
      .toEqual({ count: null });
  });

  it("spawn error → { count: null } (never propagates)", () => {
    const spawn = () => { throw new Error("EACCES"); };
    expect(readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env: { CATALYST_TRIAGE_ATTEMPT_CACHE_MS: "0" } }))
      .toEqual({ count: null });
  });

  it("two reads within TTL → ONE spawn call (cache hit)", () => {
    let calls = 0;
    const spawn = () => { calls++; return { status: 0, stdout: JSON.stringify({ count: 2 }) + "\n" }; };
    let now = 1_000_000;
    const env = { CATALYST_TRIAGE_ATTEMPT_CACHE_MS: "30000" };
    readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env, now: () => now });
    now += 5_000; // within TTL
    readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env, now: () => now });
    expect(calls).toBe(1);
  });

  it("two reads beyond TTL → TWO spawn calls (cache expired)", () => {
    let calls = 0;
    const spawn = () => { calls++; return { status: 0, stdout: JSON.stringify({ count: 2 }) + "\n" }; };
    let now = 1_000_000;
    const env = { CATALYST_TRIAGE_ATTEMPT_CACHE_MS: "30000" };
    readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env, now: () => now });
    now += 31_000; // beyond TTL
    readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env, now: () => now });
    expect(calls).toBe(2);
  });

  it("TTL=0 disables the cache (every call spawns)", () => {
    let calls = 0;
    const spawn = () => { calls++; return { status: 0, stdout: JSON.stringify({ count: 1 }) + "\n" }; };
    const env = { CATALYST_TRIAGE_ATTEMPT_CACHE_MS: "0" };
    readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env });
    readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env });
    expect(calls).toBe(2);
  });

  it("null result (fence-absent) is NOT cached (retries on the next call)", () => {
    let calls = 0;
    const spawn = () => { calls++; return { status: 0, stdout: JSON.stringify({ count: null }) + "\n" }; };
    const env = { CATALYST_TRIAGE_ATTEMPT_CACHE_MS: "30000" };
    let now = 1_000_000;
    readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env, now: () => now });
    now += 1_000;
    readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env, now: () => now });
    expect(calls).toBe(2);
  });
});

describe("bumpTriageAttemptCountSync — argv + parsing (CTL-1649)", () => {
  beforeEach(() => {
    clearTriageAttemptCacheSync();
  });

  it("builds the right argv: node <cli> bump-triage-attempt <ticket>", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = { bin, args };
      return { status: 0, stdout: JSON.stringify({ count: 1 }) + "\n" };
    };
    bumpTriageAttemptCountSync(
      { ticket: "CTL-1649" },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-claim.mjs" },
    );
    expect(captured.bin).toBe("/usr/bin/node");
    expect(captured.args).toEqual(["/x/cluster-claim.mjs", "bump-triage-attempt", "CTL-1649"]);
  });

  it("returns parsed { count } on success", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ count: 3 }) + "\n" });
    expect(bumpTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn })).toEqual({ count: 3 });
  });

  it("non-zero exit → { count: null } (best-effort, never throws)", () => {
    const spawn = () => ({ status: 1, stdout: "" });
    expect(bumpTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn })).toEqual({ count: null });
  });

  it("spawn throws → { count: null } (never propagates)", () => {
    const spawn = () => { throw new Error("ETIMEDOUT"); };
    expect(bumpTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn })).toEqual({ count: null });
  });

  it("invalidates the cache for that ticket after a bump (next read goes live)", () => {
    let spawnCalls = 0;
    const spawn = () => {
      spawnCalls++;
      return { status: 0, stdout: JSON.stringify({ count: spawnCalls }) + "\n" };
    };
    const env = { CATALYST_TRIAGE_ATTEMPT_CACHE_MS: "30000" };
    let now = 1_000_000;
    // Populate cache with count=1
    readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env, now: () => now });
    expect(spawnCalls).toBe(1);
    // Bump invalidates cache
    bumpTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env });
    expect(spawnCalls).toBe(2); // bump spawned
    // Next read goes live (cache was invalidated)
    now += 1_000;
    readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env, now: () => now });
    expect(spawnCalls).toBe(3); // fresh spawn after invalidation
  });

  it("clearTriageAttemptCacheSync resets the module-scope cache", () => {
    let calls = 0;
    const spawn = () => { calls++; return { status: 0, stdout: JSON.stringify({ count: 1 }) + "\n" }; };
    const env = { CATALYST_TRIAGE_ATTEMPT_CACHE_MS: "30000" };
    let now = 1_000_000;
    readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env, now: () => now });
    clearTriageAttemptCacheSync();
    now += 1_000;
    readTriageAttemptCountSync({ ticket: "CTL-1649" }, { spawn, env, now: () => now });
    expect(calls).toBe(2);
  });
});

describe("resetTriageAttemptCountSync — argv + parsing (CTL-2111)", () => {
  beforeEach(() => {
    clearTriageAttemptCacheSync();
  });

  it("builds the right argv: node <cli> reset-triage-attempt <ticket>", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = { bin, args };
      return { status: 0, stdout: JSON.stringify({ count: 0 }) + "\n" };
    };
    resetTriageAttemptCountSync(
      { ticket: "CTL-2111" },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-claim.mjs" },
    );
    expect(captured.bin).toBe("/usr/bin/node");
    expect(captured.args).toEqual(["/x/cluster-claim.mjs", "reset-triage-attempt", "CTL-2111"]);
  });

  it("returns { count: 0 } on success", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ count: 0 }) + "\n" });
    expect(resetTriageAttemptCountSync({ ticket: "CTL-2111" }, { spawn })).toEqual({ count: 0 });
  });

  it("non-zero exit → { count: null } (best-effort, never throws)", () => {
    const spawn = () => ({ status: 1, stdout: "" });
    expect(resetTriageAttemptCountSync({ ticket: "CTL-2111" }, { spawn })).toEqual({ count: null });
  });

  it("non-string stdout → { count: null }", () => {
    const spawn = () => ({ status: 0, stdout: null });
    expect(resetTriageAttemptCountSync({ ticket: "CTL-2111" }, { spawn })).toEqual({ count: null });
  });

  it("spawn throws → { count: null } (never propagates)", () => {
    const spawn = () => { throw new Error("ETIMEDOUT"); };
    expect(resetTriageAttemptCountSync({ ticket: "CTL-2111" }, { spawn })).toEqual({ count: null });
  });

  it("invalidates the cache for that ticket before the spawn (next read goes live)", () => {
    let spawnCalls = 0;
    const spawn = () => {
      spawnCalls++;
      return { status: 0, stdout: JSON.stringify({ count: 0 }) + "\n" };
    };
    const env = { CATALYST_TRIAGE_ATTEMPT_CACHE_MS: "30000" };
    let now = 1_000_000;
    // Populate cache
    readTriageAttemptCountSync({ ticket: "CTL-2111" }, { spawn, env, now: () => now });
    expect(spawnCalls).toBe(1);
    // Reset invalidates cache
    resetTriageAttemptCountSync({ ticket: "CTL-2111" }, { spawn, env });
    expect(spawnCalls).toBe(2); // reset spawned
    // Next read goes live (cache was invalidated)
    now += 1_000;
    readTriageAttemptCountSync({ ticket: "CTL-2111" }, { spawn, env, now: () => now });
    expect(spawnCalls).toBe(3); // fresh spawn after invalidation
  });
});
