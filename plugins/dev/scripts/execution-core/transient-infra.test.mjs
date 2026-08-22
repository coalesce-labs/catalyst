// transient-infra.test.mjs — CTL-1563. The transient-infra failure classifier.
//
// Run: cd plugins/dev/scripts/execution-core && bun test transient-infra.test.mjs

import { describe, test, expect } from "bun:test";
import {
  TRANSIENT_INFRA_REASONS,
  isTransientInfraReason,
  resolveTransientInfraReasons,
} from "./transient-infra.mjs";

describe("TRANSIENT_INFRA_REASONS (the canonical set)", () => {
  test("contains the SDK + codex overload-exhaustion reasons the backstops actually write", () => {
    // These two strings are the LIVE contract, not illustrations:
    //   sdk-run-phase-agent.mjs   → emitBackstop(reason: "sdk-overloaded-exhausted")
    //   codex-run-phase-agent.mjs → emitBackstop(reason: "codex-rate-park-exhausted")
    // Both land on the signal's `attentionReason` via defaultWriteSignalStalled.
    expect(TRANSIENT_INFRA_REASONS.has("sdk-overloaded-exhausted")).toBe(true);
    expect(TRANSIENT_INFRA_REASONS.has("codex-rate-park-exhausted")).toBe(true);
  });

  test("is frozen — a consumer cannot mutate the canonical set at a distance", () => {
    expect(Object.isFrozen(TRANSIENT_INFRA_REASONS)).toBe(true);
  });
});

describe("isTransientInfraReason", () => {
  test("recognizes a canonical transient reason", () => {
    expect(isTransientInfraReason("sdk-overloaded-exhausted")).toBe(true);
    expect(isTransientInfraReason("codex-rate-park-exhausted")).toBe(true);
  });

  test("is fail-closed on null / absent / non-string / empty", () => {
    // The predicate gates a REFUND of a self-heal attempt. Every unknown input
    // must read as "not transient" so an unreadable signal escalates exactly as
    // it does today rather than silently buying an unbounded retry budget.
    expect(isTransientInfraReason(null)).toBe(false);
    expect(isTransientInfraReason(undefined)).toBe(false);
    expect(isTransientInfraReason(42)).toBe(false);
    expect(isTransientInfraReason("")).toBe(false);
    expect(isTransientInfraReason("   ")).toBe(false);
    expect(isTransientInfraReason({})).toBe(false);
    expect(isTransientInfraReason(["sdk-overloaded-exhausted"])).toBe(false);
  });

  test("trims surrounding whitespace before matching", () => {
    expect(isTransientInfraReason("  sdk-overloaded-exhausted  ")).toBe(true);
  });

  test("structural launch failures are deliberately NOT transient", () => {
    // A structural defect does not clear on its own — escalating it is correct.
    // If these ever read as transient the exemption becomes a blanket suppression
    // of the escalation sweep, which is the failure mode this scoping prevents.
    for (const r of [
      "empty_branch",
      "dispatch_nonzero_exit",
      "cluster_fence_stale",
      "ended-without-declaration",
      "sdk-prelaunch-failed",
      "yield-expired",
    ]) {
      expect(isTransientInfraReason(r)).toBe(false);
    }
  });

  test("honors an explicitly supplied reason set (the env-extended path)", () => {
    const extended = resolveTransientInfraReasons({
      CATALYST_TRANSIENT_INFRA_EXTRA_REASONS: "foo-park",
    });
    expect(isTransientInfraReason("foo-park", extended)).toBe(true);
    expect(isTransientInfraReason("foo-park")).toBe(false); // canonical set unchanged
  });
});

describe("resolveTransientInfraReasons", () => {
  test("unions the canonical set with comma-separated env extras", () => {
    const set = resolveTransientInfraReasons({
      CATALYST_TRANSIENT_INFRA_EXTRA_REASONS: "foo-park, bar-throttle",
    });
    expect(set.has("sdk-overloaded-exhausted")).toBe(true);
    expect(set.has("codex-rate-park-exhausted")).toBe(true);
    expect(set.has("foo-park")).toBe(true);
    expect(set.has("bar-throttle")).toBe(true);
  });

  test("returns the canonical members when the env var is absent/blank/non-string", () => {
    for (const env of [
      {},
      { CATALYST_TRANSIENT_INFRA_EXTRA_REASONS: "" },
      { CATALYST_TRANSIENT_INFRA_EXTRA_REASONS: "  , ,, " },
      { CATALYST_TRANSIENT_INFRA_EXTRA_REASONS: 7 },
      null,
      undefined,
    ]) {
      const set = resolveTransientInfraReasons(env);
      expect(set.size).toBe(TRANSIENT_INFRA_REASONS.size);
      expect(set.has("sdk-overloaded-exhausted")).toBe(true);
    }
  });

  test("never mutates the frozen canonical set (returns a fresh copy)", () => {
    const set = resolveTransientInfraReasons({
      CATALYST_TRANSIENT_INFRA_EXTRA_REASONS: "foo-park",
    });
    expect(set).not.toBe(TRANSIENT_INFRA_REASONS);
    expect(TRANSIENT_INFRA_REASONS.has("foo-park")).toBe(false);
    // …and a second resolve does not observe the first one's extras.
    expect(resolveTransientInfraReasons({}).has("foo-park")).toBe(false);
  });

  test("never throws on a hostile env object", () => {
    const hostile = {
      get CATALYST_TRANSIENT_INFRA_EXTRA_REASONS() {
        throw new Error("env read exploded");
      },
    };
    expect(() => resolveTransientInfraReasons(hostile)).not.toThrow();
    expect(resolveTransientInfraReasons(hostile).has("sdk-overloaded-exhausted")).toBe(true);
  });
});
