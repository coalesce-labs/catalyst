// cluster-claim-sync.test.mjs — the synchronous spawnSync bridge over the
// cluster-claim CLI (CTL-850). Every test injects a fake `spawn` so nothing
// actually forks a process; the focus is argv construction + stdout parsing +
// the FAIL-CLOSED contract (won:false on any failure).
import { describe, it, expect, beforeEach } from "bun:test";

import {
  claimDispatchSync,
  fenceCheckSync,
  fenceCheckSyncCached,
  clearFenceReadCache,
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
    });
  });

  it("won:false from stdout is preserved (a lost soft-CAS, not an error)", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ won: false, generation: 2 }) + "\n" });
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: false,
      generation: 2,
    });
  });
});

describe("claimDispatchSync — FAIL-CLOSED on every failure mode", () => {
  it("non-zero exit → won:false", () => {
    const spawn = () => ({ status: 1, stdout: "" });
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: false,
      generation: null,
    });
  });

  it("unparseable stdout → won:false", () => {
    const spawn = () => ({ status: 0, stdout: "not json at all" });
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: false,
      generation: null,
    });
  });

  it("timeout / spawn error (status null) → won:false", () => {
    const spawn = () => ({ status: null, error: new Error("ETIMEDOUT"), stdout: null });
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: false,
      generation: null,
    });
  });

  it("spawn throws → won:false (never propagates)", () => {
    const spawn = () => {
      throw new Error("EACCES");
    };
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: false,
      generation: null,
    });
  });

  it("missing/garbage generation in stdout → generation null but won honoured", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ won: true }) + "\n" });
    expect(claimDispatchSync({ ticket: "CTL-1", hostName: "mini", phase: "research" }, { spawn })).toEqual({
      won: true,
      generation: null,
    });
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
