// governance-janitor-exclusion.contract.test.ts — CTL-1100 Phase 7
//
// Contract: isGovernanceEvent(name) must EXCLUDE every reap/janitor event type
// that could pollute a governance feed, and INCLUDE only the legitimate per-step
// phase lifecycle events.
//
// Key regression guard: a naive `startsWith('phase.')` allowlist would wrongly
// admit `phase.predecessor.reap-requested` and `phase.terminal.reap-complete`
// (both start with "phase."). The two-step gate (blocklist + per-step prefix
// allowlist) in governance-reader.mjs prevents this. This test suite FAILS if
// the predicate is simplified to a prefix-only check.

import { describe, it, expect } from "bun:test";
import {
  isGovernanceEvent,
  GOVERNANCE_EVENT_PREFIXES,
} from "../lib/governance-reader.mjs";
// @ts-ignore — execution-core mjs modules have no .d.mts; runtime types are correct
import { JANITOR_EVENT_TYPES } from "../../execution-core/janitor-event-types.mjs";
// @ts-ignore
import { REAP_INTENT_TYPES } from "../../execution-core/reap-intent.mjs";

// ─── Build the full reap vocabulary ──────────────────────────────────────────
//
// REAP_TYPES = the complete set of event names that must NEVER pass
// isGovernanceEvent(). This includes:
//   - All entries from REAP_INTENT_TYPES (the closed vocabulary the reaper/janitor
//     emit): phase.*.reap-requested, worktree.*, orphans.*, janitor.*, etc.
//   - The reaper re-emit suffixes: *.reap-complete, *.reap-failed (from reaper.mjs
//     rethrow path that re-emits after handling).
//   - The JANITOR_EVENT_TYPES (leaf module, already spread into REAP_INTENT_TYPES,
//     but imported directly for explicit documentation of the J1/J2/J3 types).

// Build derived complete + *.reap-complete siblings.
const REAP_TYPES: ReadonlyArray<string> = [
  ...REAP_INTENT_TYPES,
  // reaper.mjs re-emits these after handling (reap-requested → reap-complete/failed)
  "phase.yield.reap-complete",
  "phase.predecessor.reap-complete",
  "phase.supersede.reap-complete",
  "phase.revive.reap-complete",
  "phase.abort.reap-complete",
  "phase.reclaim.reap-complete",
  "phase.reconcile.reap-complete",
  "phase.terminal.reap-complete",
  "worktree.presweep.reap-complete",
  "phase.yield.reap-failed",
  "phase.predecessor.reap-failed",
  "phase.terminal.reap-failed",
  "orphans.reap-complete",
  "orphans.reap-failed",
];

// ─── 1. Every JANITOR_EVENT_TYPE → false ─────────────────────────────────────

describe("isGovernanceEvent — janitor types are excluded", () => {
  for (const name of JANITOR_EVENT_TYPES) {
    it(`isGovernanceEvent("${name}") === false`, () => {
      expect(isGovernanceEvent(name)).toBe(false);
    });
  }
});

// ─── 2. Every REAP_INTENT_TYPE → false ──────────────────────────────────────

describe("isGovernanceEvent — reap-intent types are excluded", () => {
  for (const name of REAP_INTENT_TYPES) {
    it(`isGovernanceEvent("${name}") === false`, () => {
      expect(isGovernanceEvent(name)).toBe(false);
    });
  }
});

// ─── 3. All *.reap-complete / *.reap-failed siblings → false ────────────────

describe("isGovernanceEvent — reap-complete/reap-failed siblings are excluded", () => {
  for (const name of REAP_TYPES) {
    if (name.endsWith("-complete") || name.endsWith("-failed")) {
      it(`isGovernanceEvent("${name}") === false`, () => {
        expect(isGovernanceEvent(name)).toBe(false);
      });
    }
  }
});

// ─── 4. Explicit regression assertions ───────────────────────────────────────
//
// These two names start with "phase." — a naive `startsWith('phase.')` allowlist
// would wrongly admit them into a governance feed. Document them explicitly so any
// future simplification of isGovernanceEvent immediately fails this test.

describe("isGovernanceEvent — regression: phase.*.reap names start with 'phase.' but must be excluded", () => {
  it("phase.predecessor.reap-requested → false (starts with 'phase.' but is a reap intent)", () => {
    // REGRESSION: `startsWith('phase.')` alone would return true here.
    // The blocklist gate (name.includes('reap')) must catch it first.
    expect(isGovernanceEvent("phase.predecessor.reap-requested")).toBe(false);
  });

  it("phase.terminal.reap-complete → false (starts with 'phase.' but is a reap re-emit)", () => {
    // REGRESSION: `startsWith('phase.')` alone would return true here.
    expect(isGovernanceEvent("phase.terminal.reap-complete")).toBe(false);
  });

  it("janitor.would.reap-request → false (would. prefix AND reap both block it)", () => {
    expect(isGovernanceEvent("janitor.would.reap-request")).toBe(false);
  });

  it("phase.predecessor.reap-requested does NOT start with any GOVERNANCE_EVENT_PREFIX", () => {
    // Document: none of the governance prefixes matches the predecessor/terminal sub-steps.
    const admitted = GOVERNANCE_EVENT_PREFIXES.some((p) =>
      "phase.predecessor.reap-requested".startsWith(p)
    );
    expect(admitted).toBe(false);
  });
});

// ─── 5. Positive controls: real governance events → true ─────────────────────

describe("isGovernanceEvent — positive controls (governance events are admitted)", () => {
  const POSITIVE_CONTROLS = [
    "phase.implement.complete.CTL-1234",
    "phase.implement.started.CTL-1234",
    "phase.verify.complete.CTL-9999",
    "phase.plan.started.CTL-0001",
    "phase.monitor-deploy.complete.CTL-7777",
    "phase.remediate.started.CTL-8888",
    "phase.teardown.complete.CTL-0002",
    "phase.triage.started.CTL-3333",
    "phase.review.complete.CTL-4444",
    "phase.pr.started.CTL-5555",
    "phase.monitor-merge.complete.CTL-6666",
    "phase.research.started.CTL-1111",
  ];

  for (const name of POSITIVE_CONTROLS) {
    it(`isGovernanceEvent("${name}") === true`, () => {
      expect(isGovernanceEvent(name)).toBe(true);
    });
  }
});

// ─── 6. advance.held → false (not in allowlist) ─────────────────────────────

describe("isGovernanceEvent — advance.held is NOT a governance event", () => {
  it("advance.held.CTL-1234 → false (not in GOVERNANCE_EVENT_PREFIXES)", () => {
    // advance.held is emitted by the scheduler but is NOT a per-step phase event.
    expect(isGovernanceEvent("advance.held.CTL-1234")).toBe(false);
  });
});

// ─── 7. Filter mixed synthetic stream — zero survivors match /reap|would\.reap/ ──

describe("isGovernanceEvent — mixed stream filter", () => {
  it("filtering a mixed stream yields zero events matching /reap|would\\.reap/", () => {
    const mixedStream = [
      "phase.implement.complete.CTL-9001",
      "phase.predecessor.reap-requested", // reap — must be filtered out
      "phase.terminal.reap-complete",     // reap re-emit — must be filtered out
      "janitor.would.reap-request",       // janitor shadow — must be filtered out
      "janitor.stall.cleared",            // janitor enforce — must be filtered out
      "worktree.presweep.reap-requested", // worktree reap — must be filtered out
      "orphans.reap-requested",           // orphan reap — must be filtered out
      "phase.verify.complete.CTL-9001",   // governance — admitted
      "advance.held.CTL-9001",            // not governance — filtered out
      "phase.review.started.CTL-9001",    // governance — admitted
    ];

    const survivors = mixedStream.filter((name) => isGovernanceEvent(name));

    // Zero survivors must match the reap/would.reap pattern.
    const reapSurvivors = survivors.filter((name) => /reap|would\.reap/.test(name));
    expect(reapSurvivors).toEqual([]);

    // Only the legitimate governance events survive.
    expect(survivors).toEqual([
      "phase.implement.complete.CTL-9001",
      "phase.verify.complete.CTL-9001",
      "phase.review.started.CTL-9001",
    ]);
  });
});
