// fence-guard.test.mjs — tests for the shared fenceGuard decision helper
// (CTL-863 durable fence → event-log migration; supersedes the #2552 cache).
// Run: cd plugins/dev/scripts/execution-core && bun test fence-guard.test.mjs
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fenceGuard,
  FENCE_SUPPRESS_REASONS,
  readClusterGeneration,
  readSignalGeneration,
} from "./fence-guard.mjs";

// A helper to build a `readFence` seam that returns a fixed projection row.
const fenceRow = (over = {}) => ({
  ownerHost: "mini",
  generation: 5,
  phase: "implement",
  claimedAt: new Date().toISOString(),
  ...over,
});

describe("fenceGuard — discriminated suppression verdict (CAT-173)", () => {
  const base = { ticket: "PROJ-1", orchDir: "/tmp/x", multiHost: true, self: "hostA" };
  const silent = { warn() {}, debug() {} };

  test("confirmed-stale authoritative read reports SUPERSEDED", () => {
    const seen = [];
    const ok = fenceGuard(base, {
      readGen: () => 7,
      escalate: () => ({ current: false, stale: true }),
      onSuppress: (v) => seen.push(v),
      logger: silent,
    });
    expect(ok).toBe(false);
    expect(seen).toEqual([
      { ticket: "PROJ-1", reason: FENCE_SUPPRESS_REASONS.SUPERSEDED, generation: 7 },
    ]);
  });

  test("indeterminate authoritative read reports UNVERIFIABLE — distinct from SUPERSEDED", () => {
    const seen = [];
    fenceGuard(base, {
      readGen: () => 7,
      escalate: () => ({ current: false, stale: false }),
      onSuppress: (v) => seen.push(v),
      logger: silent,
    });
    expect(seen[0].reason).toBe(FENCE_SUPPRESS_REASONS.UNVERIFIABLE);
    expect(FENCE_SUPPRESS_REASONS.UNVERIFIABLE).not.toBe(FENCE_SUPPRESS_REASONS.SUPERSEDED);
  });

  test("known-foreign owner reports FOREIGN_OWNER", () => {
    const seen = [];
    fenceGuard({ ...base, gateway: {} }, {
      readGen: () => null,
      readFence: () => ({ ownerHost: "hostB", generation: 3 }),
      proceedOnMissingGeneration: true,
      onSuppress: (v) => seen.push(v),
      logger: silent,
    });
    expect(seen[0].reason).toBe(FENCE_SUPPRESS_REASONS.FOREIGN_OWNER);
  });

  test("missing generation at a MUTATING site reports MISSING_GENERATION", () => {
    const seen = [];
    fenceGuard(base, { readGen: () => null, onSuppress: (v) => seen.push(v), logger: silent });
    expect(seen[0].reason).toBe(FENCE_SUPPRESS_REASONS.MISSING_GENERATION);
  });

  test("a throwing escalate reports THREW", () => {
    const seen = [];
    fenceGuard(base, {
      readGen: () => 7,
      escalate: () => { throw new Error("boom"); },
      onSuppress: (v) => seen.push(v),
      logger: silent,
    });
    expect(seen[0].reason).toBe(FENCE_SUPPRESS_REASONS.THREW);
  });

  test("onSuppress NEVER fires on a PASS, and a throwing hook cannot flip the verdict", () => {
    const seen = [];
    expect(fenceGuard(base, {
      readGen: () => 7,
      escalate: () => ({ current: true, stale: false }),
      onSuppress: (v) => seen.push(v),
      logger: silent,
    })).toBe(true);
    expect(seen).toEqual([]);

    expect(fenceGuard(base, {
      readGen: () => null,
      proceedOnMissingGeneration: true,
      onSuppress: () => { throw new Error("hook exploded"); },
      logger: silent,
    })).toBe(true);
  });

  test("single-host (multiHost:false) never fires the hook", () => {
    const seen = [];
    expect(fenceGuard({ ...base, multiHost: false }, {
      readGen: () => 1,
      onSuppress: (v) => seen.push(v),
      logger: silent,
    })).toBe(true);
    expect(seen).toEqual([]);
  });

  test("omitting onSuppress leaves every path byte-identical (default no-op)", () => {
    expect(fenceGuard(base, { readGen: () => 7, escalate: () => ({ current: false, stale: true }), logger: silent })).toBe(false);
    expect(fenceGuard(base, { readGen: () => 7, escalate: () => ({ current: true }), logger: silent })).toBe(true);
  });
});

describe("fenceGuard — N=1 single-host gate (spec §C1)", () => {
  test("roster==1 (multiHost:false) trusts local unconditionally, no read at all", () => {
    let escalated = false;
    let fenceRead = false;
    const result = fenceGuard(
      { ticket: "PROJ-1", orchDir: "/o", multiHost: false, gateway: {}, self: "mini" },
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
      { ticket: "PROJ-1", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => 5, escalate: () => ({ current: true }), readSource: "linear" },
    );
    expect(result).toBe(true);
  });

  test("stale generation via authoritative read → blocks", () => {
    const result = fenceGuard(
      { ticket: "PROJ-1", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => 5, escalate: () => ({ current: false }), readSource: "linear" },
    );
    expect(result).toBe(false);
  });

  test("missing generation (null) → fail-closed", () => {
    const result = fenceGuard(
      { ticket: "PROJ-1", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => null, escalate: () => ({ current: true }), readSource: "linear" },
    );
    expect(result).toBe(false);
  });

  test("NaN generation → fail-closed", () => {
    const result = fenceGuard(
      { ticket: "PROJ-1", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => NaN, escalate: () => ({ current: true }), readSource: "linear" },
    );
    expect(result).toBe(false);
  });

  test("escalate throws → fail-closed", () => {
    const result = fenceGuard(
      { ticket: "PROJ-1", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => 3, escalate: () => { throw new Error("spawn failed"); }, readSource: "linear" },
    );
    expect(result).toBe(false);
  });

  test("readGen throws → fail-closed", () => {
    const result = fenceGuard(
      { ticket: "PROJ-1", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => { throw new Error("ENOENT"); }, escalate: () => ({ current: true }), readSource: "linear" },
    );
    expect(result).toBe(false);
  });

  test("passes the correct ticket+generation to the authoritative read", () => {
    let captured = null;
    fenceGuard(
      { ticket: "PROJ-999", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => 42, escalate: (args) => { captured = args; return { current: true }; }, readSource: "linear" },
    );
    expect(captured).toEqual({ ticket: "PROJ-999", generation: 42 });
  });

  test("Stage-0 default NEVER trusts the local projection — a fresh self-owned row still escalates", () => {
    // The whole safety property: without the cross-host reconcile store, a
    // per-host projection cannot carry a foreign takeover bump. Default (linear)
    // must ignore it and consult the authoritative read (spec finding 1).
    let escalated = false;
    let fenceRead = false;
    const result = fenceGuard(
      { ticket: "PROJ-1", orchDir: "/o", multiHost: true, gateway: {}, self: "mini" },
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
  const base = { ticket: "PROJ-1", orchDir: "/o", multiHost: true, gateway: {}, self: "mini" };
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
    const seen = [];
    const result = fenceGuard(base, {
      readGen: () => 5,
      readFence: () => fenceRow({ ownerHost: "laptop", generation: 6 }), // peer took over
      isFresh: () => true,
      escalate: () => ({ current: true }), // even if Linear lied, we must not reach it
      readSource: "projection-first",
      env: STAGE1,
      onSuppress: (verdict) => seen.push(verdict),
    });
    expect(result).toBe(false);
    expect(seen[0].reason).toBe(FENCE_SUPPRESS_REASONS.FOREIGN_OWNER);
  });

  test("fresh self-owned row at a HIGHER generation → suppress", () => {
    const seen = [];
    const result = fenceGuard(base, {
      readGen: () => 5,
      readFence: () => fenceRow({ ownerHost: "mini", generation: 6 }),
      isFresh: () => true,
      escalate: () => ({ current: true }),
      readSource: "projection-first",
      env: STAGE1,
      onSuppress: (verdict) => seen.push(verdict),
    });
    expect(result).toBe(false);
    expect(seen[0].reason).toBe(FENCE_SUPPRESS_REASONS.SUPERSEDED);
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
      { ticket: "PROJ-1", orchDir: "/o", multiHost: true, self: "mini" },
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
      { ticket: "PROJ-1", orchDir: "/o", multiHost: true, self: "mini" },
      { readGen: () => null, escalate: () => ({ current: true }), readSource: "linear" },
    );
    expect(result).toBe(false);
  });

  test("proceedOnMissingGeneration does NOT loosen a readable-but-superseded generation (still suppresses)", () => {
    const result = fenceGuard(
      { ticket: "PROJ-1", orchDir: "/o", multiHost: true, self: "mini" },
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

describe("fenceGuard — escalation sites stay fail-CLOSED on a KNOWN-foreign owner", () => {
  // Regression: proceedOnMissingGeneration was written for "we cannot tell who owns
  // this" and was reached for "we CAN tell, and it is another host" too — fenceGuard
  // declined to borrow the foreign generation, then treated that as merely-missing and
  // permitted the write. A stale host could then apply the STICKY needs-human label to
  // the new owner's ACTIVE ticket, with no local once-marker on the new owner to clear it.
  test("proceedOnMissingGeneration:true + FOREIGN-owned projection → SUPPRESS (never labels the new owner's ticket)", () => {
    let escalated = false;
    const warns = [];
    const result = fenceGuard(
      { ticket: "PROJ-1", orchDir: "/o", multiHost: true, gateway: {}, self: "mini" },
      {
        readGen: () => null, // this host's cluster-generation.json is gone
        readFence: () => fenceRow({ ownerHost: "mini-2", generation: 9 }), // a peer owns it NOW
        escalate: () => { escalated = true; return { current: true }; },
        readSource: "linear",
        proceedOnMissingGeneration: true,
        logger: { warn: (...a) => warns.push(a) },
      },
    );
    expect(result).toBe(false);
    expect(escalated).toBe(false); // never borrowed the foreign gen into the authoritative read
    expect(warns.length).toBe(1);  // suppression is loud, not silent
  });

  test("a foreign owner suppresses BEFORE onMissingGeneration fires (the call site's own fail-closed path arms its cooldown)", () => {
    let hookFired = false;
    const result = fenceGuard(
      { ticket: "PROJ-1", orchDir: "/o", multiHost: true, gateway: {}, self: "mini" },
      {
        readGen: () => null,
        readFence: () => fenceRow({ ownerHost: "mini-2", generation: 9 }),
        escalate: () => ({ current: true }),
        readSource: "linear",
        proceedOnMissingGeneration: true,
        onMissingGeneration: () => { hookFired = true; },
      },
    );
    expect(result).toBe(false);
    expect(hookFired).toBe(false);
  });

  test("ownership genuinely UNKNOWN still fails OPEN — a null/absent owner is not 'foreign'", () => {
    // The PR's whole point: never silently drop an escalation when we cannot tell.
    for (const row of [null, fenceRow({ ownerHost: null }), fenceRow({ ownerHost: "" })]) {
      let hookFired = false;
      const result = fenceGuard(
        { ticket: "PROJ-1", orchDir: "/o", multiHost: true, gateway: {}, self: "mini" },
        {
          readGen: () => null,
          readFence: () => row,
          escalate: () => ({ current: false }),
          readSource: "linear",
          proceedOnMissingGeneration: true,
          onMissingGeneration: () => { hookFired = true; },
        },
      );
      expect(result).toBe(true);
      expect(hookFired).toBe(true);
    }
  });

  test("a throwing projection read is UNKNOWN, not foreign → still fails open at an escalation site", () => {
    const result = fenceGuard(
      { ticket: "PROJ-1", orchDir: "/o", multiHost: true, gateway: {}, self: "mini" },
      {
        readGen: () => null,
        readFence: () => { throw new Error("sqlite is down"); },
        escalate: () => ({ current: false }),
        readSource: "linear",
        proceedOnMissingGeneration: true,
      },
    );
    expect(result).toBe(true);
  });

  test("SELF-owned projection is unaffected — still borrows the generation and escalates", () => {
    let captured = null;
    const result = fenceGuard(
      { ticket: "PROJ-1", orchDir: "/o", multiHost: true, gateway: {}, self: "mini" },
      {
        readGen: () => null,
        readFence: () => fenceRow({ ownerHost: "mini", generation: 9 }),
        escalate: (args) => { captured = args; return { current: true }; },
        readSource: "linear",
        proceedOnMissingGeneration: true,
      },
    );
    expect(captured).toEqual({ ticket: "PROJ-1", generation: 9 });
    expect(result).toBe(true);
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
    ticket = "PROJ-1423";
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
