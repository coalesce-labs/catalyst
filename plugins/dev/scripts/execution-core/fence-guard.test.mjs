// fence-guard.test.mjs — tests for the shared fenceGuard decision helper
// (CTL-863 durable fence → event-log migration; supersedes the #2552 cache).
// Run: cd plugins/dev/scripts/execution-core && bun test fence-guard.test.mjs
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fenceGuard } from "./fence-guard.mjs";

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

describe("fenceGuard — multi-host projection-first (Stage 1 opt-in)", () => {
  const base = { ticket: "CTL-1", orchDir: "/o", multiHost: true, gateway: {}, self: "mini" };

  test("fresh self-owned + generation match → true (fast path, no escalate)", () => {
    let escalated = false;
    const result = fenceGuard(base, {
      readGen: () => 5,
      readFence: () => fenceRow({ ownerHost: "mini", generation: 5 }),
      isFresh: () => true,
      escalate: () => { escalated = true; return { current: false }; },
      readSource: "projection-first",
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
    });
    expect(result).toBe(false);
  });
});

describe("fenceGuard — hardening invariants", () => {
  test("no `soleWriter` reference remains anywhere in the source (deleted per OQ-B)", () => {
    const src = readFileSync(fileURLToPath(new URL("./fence-guard.mjs", import.meta.url)), "utf8");
    expect(src.includes("soleWriter")).toBe(false);
  });
});
