// escalation-router.test.mjs — CTL-2000. The ladder policy is tested
// deterministically here rather than discovered during an outage: every
// function under test is pure and injectable (no clock, no I/O).
import { test, expect } from "bun:test";
import { resolveSteward, nextEscalationTarget, TARGET } from "../escalation-router.mjs";

test("resolveSteward returns null when no roles are configured (today's reality)", () => {
  expect(resolveSteward("catalyst/execution-core", { listRoles: () => [], readManifest: () => null })).toBeNull();
});

test("resolveSteward returns null for a free-text scope with no registry match", () => {
  const deps = { listRoles: () => ["steward-a"], readManifest: () => ({ role: "steward-a", scope: "some prose about a project" }) };
  expect(resolveSteward("execution-core", deps)).toBeNull();
});

test("resolveSteward returns the role when a registry entry matches (CTL-1974 forward-compat)", () => {
  const deps = { listRoles: () => ["steward-x"], readManifest: () => ({ role: "steward-x", scope: "execution-core", scopeKeys: ["execution-core"] }) };
  expect(resolveSteward("execution-core", deps)).toEqual({ role: "steward-x", scope: "execution-core" });
});

test("ladder: with no steward, the FIRST page targets the concierge, never the human", () => {
  const t = nextEscalationTarget({ scope: "execution-core", priorPages: 0, resolveSteward: () => null });
  expect(t.target).toBe(TARGET.CONCIERGE);
  expect(t.target).not.toBe(TARGET.HUMAN_DIRECT); // this enum value must not exist
});

test("ladder: with a steward, first page targets the steward; concierge only after 2 silences", () => {
  const withSteward = { resolveSteward: () => ({ role: "steward-x", scope: "execution-core" }) };
  expect(nextEscalationTarget({ scope: "execution-core", priorPages: 0, ...withSteward }).target).toBe(TARGET.STEWARD);
  expect(nextEscalationTarget({ scope: "execution-core", priorPages: 2, ...withSteward }).target).toBe(TARGET.CONCIERGE);
});

test("the human is reachable only as an ask — the router never returns a direct-human target", () => {
  const targets = [0, 1, 2, 3, 99].map((p) => nextEscalationTarget({ scope: "s", priorPages: p, resolveSteward: () => null }).target);
  expect(targets.every((t) => t === TARGET.CONCIERGE || t === TARGET.ASK)).toBe(true);
});

test("every returned target carries the instrument tag shape `instrument/<name>`", () => {
  const t = nextEscalationTarget({ scope: "s", priorPages: 0, instrument: "quiet-fleet", resolveSteward: () => null });
  expect(t.tag).toBe("instrument/quiet-fleet");
});

// ── Additional edge coverage (fail-closed direction) ─────────────────────────

test("TARGET has no direct-human member — the absence is the structural invariant", () => {
  expect(TARGET.HUMAN_DIRECT).toBeUndefined();
  expect(Object.values(TARGET)).not.toContain("human");
});

test("resolveSteward is null-safe when deps are missing (pure, never throws)", () => {
  expect(resolveSteward("execution-core")).toBeNull();
  expect(resolveSteward("", { listRoles: () => ["s"], readManifest: () => ({ scopeKeys: [""] }) })).toBeNull();
});

test("nextEscalationTarget tolerates a missing resolveSteward and falls through to concierge", () => {
  const t = nextEscalationTarget({ scope: "s", priorPages: 0 });
  expect(t.target).toBe(TARGET.CONCIERGE);
  expect(t.steward).toBeNull();
});
