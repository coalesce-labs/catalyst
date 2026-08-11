import { test, expect } from "bun:test";
import { DEFAULTS, isOrphanBlocked, decideOrphanNotify } from "./orphan-pr-sweep.mjs";

// isOrphanBlocked: mirrors board PR_BLOCKER_STATES {DIRTY,BLOCKED,UNSTABLE}; CI-red included.
test("isOrphanBlocked: DIRTY/BLOCKED/UNSTABLE are blockers; CLEAN/HAS_HOOKS/UNKNOWN are not", () => {
  for (const s of ["DIRTY", "BLOCKED", "UNSTABLE"]) expect(isOrphanBlocked(s)).toBe(true);
  for (const s of ["CLEAN", "HAS_HOOKS", "BEHIND", "UNKNOWN", "", null, undefined])
    expect(isOrphanBlocked(s)).toBe(false);
});

// decideOrphanNotify state machine: skip (not blocker) | stamp (first blocker sighting)
//   | wait (within window) | notify (window elapsed, not yet notified) | skip (already notified).
test("non-blocker state → skip:not_blocked, never stamps", () => {
  const d = decideOrphanNotify({ mergeStateStatus: "CLEAN", isDraft: false, entry: null, nowMs: 1000, stableSeconds: 300 });
  expect(d.action).toBe("skip");
  expect(d.reason).toBe("not_blocked");
});

test("CAT-15: draft PR in a blocker state → stamp", () => {
  const d = decideOrphanNotify({ mergeStateStatus: "UNSTABLE", isDraft: true, entry: null, nowMs: 1000, stableSeconds: 300 });
  expect(d.action).toBe("stamp");
  expect(d.reason).toBe("first_sighting");
});

test("CAT-15: draft PR with CLEAN merge state → stamp", () => {
  const d = decideOrphanNotify({ mergeStateStatus: "CLEAN", isDraft: true, entry: null, nowMs: 1000, stableSeconds: 300 });
  expect(d).toEqual({ action: "stamp", reason: "first_sighting" });
});

test("draft PR with CLEAN merge state past stable window → notify:draft_stable", () => {
  const entry = { firstSeenAt: new Date(0).toISOString() };
  const d = decideOrphanNotify({ mergeStateStatus: "CLEAN", isDraft: true, entry, nowMs: 300_000, stableSeconds: 300 });
  expect(d).toEqual({ action: "notify", reason: "draft_stable" });
});

test("draft blocker past stable window → notify:draft_stable", () => {
  const entry = { firstSeenAt: new Date(0).toISOString() };
  const d = decideOrphanNotify({ mergeStateStatus: "BLOCKED", isDraft: true, entry, nowMs: 300_000, stableSeconds: 300 });
  expect(d).toEqual({ action: "notify", reason: "draft_stable" });
});

test("first blocker sighting → stamp firstSeenAt", () => {
  const d = decideOrphanNotify({ mergeStateStatus: "BLOCKED", isDraft: false, entry: null, nowMs: 1000, stableSeconds: 300 });
  expect(d.action).toBe("stamp");
});

test("blocker within stable window → wait", () => {
  const entry = { firstSeenAt: new Date(0).toISOString() };
  const d = decideOrphanNotify({ mergeStateStatus: "BLOCKED", isDraft: false, entry, nowMs: 299_000, stableSeconds: 300 });
  expect(d.action).toBe("wait");
});

test("blocker past stable window, not yet notified → notify", () => {
  const entry = { firstSeenAt: new Date(0).toISOString() };
  const d = decideOrphanNotify({ mergeStateStatus: "BLOCKED", isDraft: false, entry, nowMs: 300_000, stableSeconds: 300 });
  expect(d.action).toBe("notify");
});

test("already notified → skip:already_notified (no duplicate event)", () => {
  const entry = { firstSeenAt: new Date(0).toISOString(), notifiedAt: new Date(300_000).toISOString() };
  const d = decideOrphanNotify({ mergeStateStatus: "BLOCKED", isDraft: false, entry, nowMs: 600_000, stableSeconds: 300 });
  expect(d.action).toBe("skip");
  expect(d.reason).toBe("already_notified");
});

test("state recovered to CLEAN after being notified → skip:not_blocked (caller prunes the entry)", () => {
  const entry = { firstSeenAt: new Date(0).toISOString(), notifiedAt: new Date(300_000).toISOString() };
  const d = decideOrphanNotify({ mergeStateStatus: "CLEAN", isDraft: false, entry, nowMs: 600_000, stableSeconds: 300 });
  expect(d.action).toBe("skip");
  expect(d.reason).toBe("not_blocked");
});

test("DEFAULTS.stableSeconds is 300, matching the board PR_STUCK_DEBOUNCE", () => {
  expect(DEFAULTS.stableSeconds).toBe(300);
});
