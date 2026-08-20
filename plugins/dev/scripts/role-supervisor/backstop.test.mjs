// backstop.test.mjs — CTL-2000. The two out-of-fleet backstops are pure
// classifiers: the holding-reply sentinel fires at the 15-minute silence mark
// (once), and the dead-man alarm fires ONLY when the concierge is both
// heartbeat-dead AND channel-silent for 30 minutes. Both decisions are tested
// deterministically here — never discovered during the outage they exist for.
//
// Top-level (not __tests__/) to match run-tests.sh's `../role-supervisor/*.test.mjs`.
import { test, expect } from "bun:test";
import { shouldPostHoldingReply, deadManShouldFire } from "./backstop.mjs";

const M = 60_000;

test("holding reply fires at the 15-minute silence mark, once", () => {
  expect(shouldPostHoldingReply({ silenceMs: 14 * M, alreadyPosted: false })).toBe(false);
  expect(shouldPostHoldingReply({ silenceMs: 15 * M, alreadyPosted: false })).toBe(true);
  expect(shouldPostHoldingReply({ silenceMs: 20 * M, alreadyPosted: true })).toBe(false); // idempotent
});

test("dead-man fires ONLY when both concierge heartbeat AND channel turn are >30m", () => {
  expect(deadManShouldFire({ conciergeHbAgeMs: 31 * M, lastChannelTurnAgeMs: 31 * M, alreadyPushed: false })).toBe(true);
  expect(deadManShouldFire({ conciergeHbAgeMs: 31 * M, lastChannelTurnAgeMs: 5 * M, alreadyPushed: false })).toBe(false); // a recent turn means alive
  expect(deadManShouldFire({ conciergeHbAgeMs: 5 * M, lastChannelTurnAgeMs: 31 * M, alreadyPushed: false })).toBe(false); // heartbeat fresh
});

test("dead-man pushes the human at most once per episode", () => {
  expect(deadManShouldFire({ conciergeHbAgeMs: 40 * M, lastChannelTurnAgeMs: 40 * M, alreadyPushed: true })).toBe(false);
});

test("a missing concierge heartbeat (null age) counts as dead, not as healthy", () => {
  expect(deadManShouldFire({ conciergeHbAgeMs: null, lastChannelTurnAgeMs: 31 * M, alreadyPushed: false })).toBe(true);
});

// ── Additional coverage (fail-closed direction + boundaries) ─────────────────

test("a missing channel turn (null age) counts as silent, not as healthy", () => {
  expect(deadManShouldFire({ conciergeHbAgeMs: 31 * M, lastChannelTurnAgeMs: null, alreadyPushed: false })).toBe(true);
});

test("both ages missing → fire (nothing proves the concierge is alive)", () => {
  expect(deadManShouldFire({ conciergeHbAgeMs: null, lastChannelTurnAgeMs: null, alreadyPushed: false })).toBe(true);
});

test("dead-man boundary is inclusive at exactly 30m", () => {
  expect(deadManShouldFire({ conciergeHbAgeMs: 30 * M, lastChannelTurnAgeMs: 30 * M, alreadyPushed: false })).toBe(true);
  expect(deadManShouldFire({ conciergeHbAgeMs: 30 * M - 1, lastChannelTurnAgeMs: 30 * M, alreadyPushed: false })).toBe(false);
});

test("holding-reply boundary is inclusive at exactly 15m", () => {
  expect(shouldPostHoldingReply({ silenceMs: 15 * M - 1, alreadyPosted: false })).toBe(false);
  expect(shouldPostHoldingReply({ silenceMs: 15 * M, alreadyPosted: false })).toBe(true);
});

test("holding reply never fires on a null/undefined silence age (nothing to act on)", () => {
  expect(shouldPostHoldingReply({ silenceMs: null, alreadyPosted: false })).toBe(false);
  expect(shouldPostHoldingReply({ alreadyPosted: false })).toBe(false);
});
