// fence-guard.test.mjs — tests for the shared fenceGuard decision helper
// (CTL-863 durable fence → event-log migration; supersedes the #2552 cache).
// Run: cd plugins/dev/scripts/execution-core && bun test fence-guard.test.mjs
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fenceGuard, readClusterGeneration, readSignalGeneration } from "./fence-guard.mjs";

// A helper to build a `readFence` seam that returns a fixed projection row.
const fenceRow = (over = {}) => ({
  ownerHost: "mini",
  generation: 5,
  phase: "implement",
  claimedAt: new Date().toISOString(),
  ...over,
});

describe("fenceGuard — N=1 single-host gate (spec §C1)", () => {
  test("roster==1 (multiHost:false) trusts local unconditionally, no read at all", () => {
    let escalated = false;
    let fenceRead = false;
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: false, gateway: {}, self: "mini" },
      {
        escalate: () => { escalated = true; return { current: true }; },
        readFence: () => { fenceRead = true; return null; },
      },
    );
    expect(result).toBe(true);
    expect(escalated).toBe(false); // zero Linear traffic on single-host
    expect(fenceRead).toBe(false); // and no projection read either — pure floor
  });
});

describe("fenceGuard — multi-host default (Stage 0, readSource=linear → escalate)", () => {
  test("current generation via authoritative read → passes", () => {
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => 5, escalate: () => ({ current: true }), readSource: "linear" },
    );
    expect(result).toBe(true);
  });

  test("stale generation via authoritative read → blocks", () => {
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => 5, escalate: () => ({ current: false }), readSource: "linear" },
    );
    expect(result).toBe(false);
  });

  test("missing generation (null) → fail-closed", () => {
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => null, escalate: () => ({ current: true }), readSource: "linear" },
    );
    expect(result).toBe(false);
  });

  test("NaN generation → fail-closed", () => {
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => NaN, escalate: () => ({ current: true }), readSource: "linear" },
    );
    expect(result).toBe(false);
  });

  test("escalate throws → fail-closed", () => {
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => 3, escalate: () => { throw new Error("spawn failed"); }, readSource: "linear" },
    );
    expect(result).toBe(false);
  });

  test("readGen throws → fail-closed", () => {
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => { throw new Error("ENOENT"); }, escalate: () => ({ current: true }), readSource: "linear" },
    );
    expect(result).toBe(false);
  });

  test("passes the correct ticket+generation to the authoritative read", () => {
    let captured = null;
    fenceGuard(
      { ticket: "CTL-999", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => 42, escalate: (args) => { captured = args; return { current: true }; }, readSource: "linear" },
    );
    expect(captured).toEqual({ ticket: "CTL-999", generation: 42 });
  });

  test("Stage-0 default NEVER trusts the local projection — a fresh self-owned row still escalates", () => {
    // The whole safety property: without the cross-host reconcile store, a
    // per-host projection cannot carry a foreign takeover bump. Default (linear)
    // must ignore it and consult the authoritative read (spec finding 1).
    let escalated = false;
    let fenceRead = false;
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true, gateway: {}, self: "mini" },
      {
        readGen: () => 5,
        readFence: () => { fenceRead = true; return fenceRow(); },
        escalate: () => { escalated = true; return { current: false }; },
        readSource: "linear", // Stage 0 default
      },
    );
    expect(result).toBe(false);   // escalate said not-current → suppress
    expect(escalated).toBe(true); // authoritative read WAS consulted
    expect(fenceRead).toBe(false); // projection NOT read on the default path
  });
});

describe("fenceGuard — multi-host projection-first (Stage 1 opt-in, marker-gated)", () => {
  const base = { ticket: "CTL-1", orchDir: "/o", multiHost: true, gateway: {}, self: "mini" };
  // The N>1 guardrail hard-refuses projection-first on a multi-host roster unless
  // the Stage-1 capability marker is present; these tests exercise the Stage-1
  // projection LOGIC, so they arm the marker.
  const STAGE1 = { CATALYST_FENCE_STAGE1_STORE: "1" };

  test("fresh self-owned + generation match → true (fast path, no escalate)", () => {
    let escalated = false;
    const result = fenceGuard(base, {
      readGen: () => 5,
      readFence: () => fenceRow({ ownerHost: "mini", generation: 5 }),
      isFresh: () => true,
      escalate: () => { escalated = true; return { current: false }; },
      readSource: "projection-first",
      env: STAGE1,
    });
    expect(result).toBe(true);
    expect(escalated).toBe(false); // burn-eliminated: no authoritative read
  });

  test("fresh row showing a FOREIGN owner → suppress (the partitioned-zombie catch)", () => {
    const result = fenceGuard(base, {
      readGen: () => 5,
      readFence: () => fenceRow({ ownerHost: "laptop", generation: 6 }), // peer took over
      isFresh: () => true,
      escalate: () => ({ current: true }), // even if Linear lied, we must not reach it
      readSource: "projection-first",
      env: STAGE1,
    });
    expect(result).toBe(false);
  });

  test("fresh self-owned row at a HIGHER generation → suppress", () => {
    const result = fenceGuard(base, {
      readGen: () => 5,
      readFence: () => fenceRow({ ownerHost: "mini", generation: 6 }),
      isFresh: () => true,
      escalate: () => ({ current: true }),
      readSource: "projection-first",
      env: STAGE1,
    });
    expect(result).toBe(false);
  });

  test("STALE self-owned row → escalates (does NOT trust local; regression guard for findings 1/2/7)", () => {
    let escalated = false;
    const result = fenceGuard(base, {
      readGen: () => 5,
      readFence: () => fenceRow({ ownerHost: "mini", generation: 5 }),
      isFresh: () => false, // missed a re-emit → not fresh
      escalate: () => { escalated = true; return { current: true }; },
      readSource: "projection-first",
      env: STAGE1,
    });
    expect(escalated).toBe(true);
    expect(result).toBe(true); // authoritative said current → allow
  });

  test("ABSENT projection row (f===null) → escalate, never suppress-legit nor allow-zombie (finding 11/OQ-E)", () => {
    let escalated = false;
    const result = fenceGuard(base, {
      readGen: () => 5,
      readFence: () => null,
      isFresh: () => true,
      escalate: () => { escalated = true; return { current: true }; },
      readSource: "projection-first",
      env: STAGE1,
    });
    expect(escalated).toBe(true);
    expect(result).toBe(true);
  });

  test("released fence (owner cleared → gatewayFence returns null) → escalate/suppress, never allow (OQ-F)", () => {
    // gatewayFence maps a released row (owner_host null) to null. Here readFence
    // returns null and the authoritative read confirms not-current → suppress.
    const result = fenceGuard(base, {
      readGen: () => 5,
      readFence: () => null,
      isFresh: () => true,
      escalate: () => ({ current: false }),
      readSource: "projection-first",
      env: STAGE1,
    });
    expect(result).toBe(false);
  });

  test("default freshness window (240s) trusts a self-owned row claimed 150s ago (would be stale under the old 90s)", () => {
    // Uses the REAL isFresh (default). A 150s-old claim is within the 240s window
    // → trusted without escalating. Under the pre-fix 90s default it would have
    // been stale and needlessly escalated to Linear every cycle (Codex P2:35).
    let escalated = false;
    const claimedAt = new Date(Date.now() - 150_000).toISOString();
    const result = fenceGuard(base, {
      readGen: () => 5,
      readFence: () => fenceRow({ ownerHost: "mini", generation: 5, claimedAt }),
      escalate: () => { escalated = true; return { current: false }; },
      readSource: "projection-first",
      env: STAGE1, // no CATALYST_FENCE_FRESH_MS override → default 240_000
    });
    expect(result).toBe(true);
    expect(escalated).toBe(false);
  });
});

describe("fenceGuard — N>1 projection-first guardrail (Codex: unsafe without Stage-1 store)", () => {
  const base = { ticket: "CTL-GUARD-1", orchDir: "/o", multiHost: true, gateway: {}, self: "mini" };

  test("projection-first on a >1 roster WITHOUT the Stage-1 marker → REFUSED, falls back to the authoritative read + warns", () => {
    let escalated = false;
    let fenceRead = false;
    const warns = [];
    const result = fenceGuard(base, {
      readGen: () => 5,
      readFence: () => { fenceRead = true; return fenceRow({ ownerHost: "mini", generation: 5 }); },
      isFresh: () => true, // even a fresh self-owned row must NOT be trusted
      escalate: () => { escalated = true; return { current: false }; },
      readSource: "projection-first",
      env: {}, // no marker
      logger: { warn: (...a) => warns.push(a) },
    });
    expect(result).toBe(false);   // fell back to escalate, which said not-current
    expect(escalated).toBe(true); // authoritative read WAS consulted (linear)
    expect(fenceRead).toBe(false); // projection NOT trusted
    expect(warns.length).toBe(1); // loud refusal warning fired
  });

  test("projection-first WITH the Stage-1 marker → the fast path is armed (marker gates the guardrail)", () => {
    let escalated = false;
    const result = fenceGuard(base, {
      readGen: () => 5,
      readFence: () => fenceRow({ ownerHost: "mini", generation: 5 }),
      isFresh: () => true,
      escalate: () => { escalated = true; return { current: false }; },
      readSource: "projection-first",
      env: { CATALYST_FENCE_STAGE1_STORE: "1" },
    });
    expect(result).toBe(true);    // fresh self-owned row trusted
    expect(escalated).toBe(false); // no authoritative read
  });
});

describe("fenceGuard — escalation-site fail-open on missing generation (watch item)", () => {
  test("proceedOnMissingGeneration:true + null generation → PROCEED (write) + loud warn, never a silent drop", () => {
    const warns = [];
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true, self: "mini" },
      {
        readGen: () => null,
        escalate: () => ({ current: false }),
        readSource: "linear",
        proceedOnMissingGeneration: true,
        logger: { warn: (...a) => warns.push(a) },
      },
    );
    expect(result).toBe(true);     // fail-OPEN: the escalation is written
    expect(warns.length).toBe(1);  // and loudly logged
  });

  test("default (proceedOnMissingGeneration:false) + null generation → fail-closed (mutating write sites unchanged)", () => {
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => null, escalate: () => ({ current: true }), readSource: "linear" },
    );
    expect(result).toBe(false);
  });

  test("proceedOnMissingGeneration does NOT loosen a readable-but-superseded generation (still suppresses)", () => {
    const result = fenceGuard(
      { ticket: "CTL-1", orchDir: "/o", multiHost: true, self: "mini" },
      {
        readGen: () => 5, // generation IS readable
        escalate: () => ({ current: false }), // authoritative says superseded
        readSource: "linear",
        proceedOnMissingGeneration: true,
      },
    );
    expect(result).toBe(false); // readable generation → the real check still runs
  });
});

describe("fenceGuard — hardening invariants", () => {
  test("no `soleWriter` reference remains anywhere in the source (deleted per OQ-B)", () => {
    const src = readFileSync(fileURLToPath(new URL("./fence-guard.mjs", import.meta.url)), "utf8");
    expect(src.includes("soleWriter")).toBe(false);
  });
});

describe("fenceGuard — generation SOURCE wiring (CTL-1157 A1 regression)", () => {
  // THE BUG: the default readGen read the per-phase single-flight counter
  // (phase-*.json .generation, reset to 1 on a fresh dispatch) instead of the
  // cross-host claim generation (cluster-generation.json) the fence attachment
  // actually stores. On the multi-host fleet the two never matched → every fenced
  // write, incl. the terminal Done, was suppressed forever → the board froze
  // (~1,090/hr `stale fence` WARN on CTL-1423, 0 `.terminal-done.applied` markers
  // fleet-wide). The pre-fix suite injected readGen in EVERY case, so it never
  // exercised the real default — exactly how the bug slipped through. These tests
  // pin the REAL default readGen.
  let dir, orchDir, ticket, wdir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fence-src-"));
    orchDir = dir;
    ticket = "CTL-1423";
    wdir = join(orchDir, "workers", ticket);
    mkdirSync(wdir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("default readGen reads cluster-generation.json, NOT the phase counter (the exact CTL-1423 shape)", () => {
    // phase counter = 1 (fresh dispatch), cluster gen = 7 — the empirically-observed mismatch.
    writeFileSync(
      join(wdir, "phase-teardown.json"),
      JSON.stringify({ generation: 1, status: "done", updatedAt: new Date().toISOString() }),
    );
    writeFileSync(join(wdir, "cluster-generation.json"), JSON.stringify({ generation: 7 }));
    let captured = null;
    const result = fenceGuard(
      { ticket, orchDir, multiHost: true, self: "mini" },
      { escalate: (args) => { captured = args; return { current: true }; }, readSource: "linear" },
    );
    expect(captured).toEqual({ ticket, generation: 7 }); // 7 (cluster) — never 1 (the phase counter)
    expect(result).toBe(true); // the fence now PASSES for the legitimate owner → the Done write lands
  });

  test("readClusterGeneration: file generation, null on missing/malformed", () => {
    expect(readClusterGeneration(orchDir, ticket)).toBe(null); // absent
    writeFileSync(join(wdir, "cluster-generation.json"), "not-json");
    expect(readClusterGeneration(orchDir, ticket)).toBe(null); // malformed → never throws
    writeFileSync(join(wdir, "cluster-generation.json"), JSON.stringify({ generation: 7 }));
    expect(readClusterGeneration(orchDir, ticket)).toBe(7);
  });

  test("the two sources genuinely differ: readSignalGeneration=phase counter, readClusterGeneration=claim gen", () => {
    writeFileSync(
      join(wdir, "phase-teardown.json"),
      JSON.stringify({ generation: 1, status: "done", updatedAt: new Date().toISOString() }),
    );
    writeFileSync(join(wdir, "cluster-generation.json"), JSON.stringify({ generation: 7 }));
    expect(readSignalGeneration(orchDir, ticket)).toBe(1); // the WRONG value the fence used to receive
    expect(readClusterGeneration(orchDir, ticket)).toBe(7); // the RIGHT value it receives now
  });

  test("missing cluster-generation.json + gateway, SELF-OWNED projection → borrows generation, still escalates", () => {
    let captured = null;
    const result = fenceGuard(
      { ticket, orchDir, multiHost: true, gateway: {}, self: "mini" },
      {
        readFence: () => ({ ownerHost: "mini", generation: 9 }), // projection agrees WE own it
        escalate: (args) => { captured = args; return { current: true }; },
        readSource: "linear",
      },
    );
    expect(captured).toEqual({ ticket, generation: 9 }); // recovered from the projection, still escalated
    expect(result).toBe(true);
  });

  test("missing cluster-generation.json + gateway, FOREIGN-owned projection → does NOT borrow, fail-closed (zombie guard)", () => {
    // THE fail-open the ownership guard prevents: a partitioned zombie (self=mini)
    // whose local cluster-generation.json is gone must NOT borrow the CURRENT
    // projection generation of the NEW owner (mini-2). escalate() checks only
    // "is this generation current?" (not ownership), so borrowing mini-2's current
    // generation would be a tautological match → false ALLOW → corruption.
    let escalated = false;
    const result = fenceGuard(
      { ticket, orchDir, multiHost: true, gateway: {}, self: "mini" },
      {
        readFence: () => ({ ownerHost: "mini-2", generation: 9 }), // a peer took over
        escalate: () => { escalated = true; return { current: true }; }, // even if Linear said "current"
        readSource: "linear",
      },
    );
    expect(result).toBe(false); // no candidate seeded (foreign owner) → fail-closed
    expect(escalated).toBe(false); // never reached the authoritative read with a borrowed foreign gen
  });

  test("missing cluster-generation.json + NO gateway → fail-closed (mutating site suppresses)", () => {
    const result = fenceGuard(
      { ticket, orchDir, multiHost: true, self: "mini" },
      { escalate: () => ({ current: true }), readSource: "linear" },
    );
    expect(result).toBe(false); // no generation recoverable → suppress (the safe side)
  });
});
