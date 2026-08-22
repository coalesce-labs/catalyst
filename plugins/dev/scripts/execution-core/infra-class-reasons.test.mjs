// infra-class-reasons.test.mjs — CTL-2061 AC1 + AC5.
//
// AC5: "Mutation control required, and one fixture per axis: an infra-class reason AND a
// genuine product-class reason. A suite with only one cannot tell routing from a
// constant." Both axes are exercised below, and the classifier is checked in BOTH
// directions on every assertion that matters.

import { describe, expect, test } from "bun:test";

import {
  INFRA_CLASS_REASONS,
  PRODUCT_CLASS_REASONS,
  REASON_CLASS,
  classifyFailureReason,
  isInfraClassReason,
} from "./infra-class-reasons.mjs";

describe("classifyFailureReason", () => {
  // ── Axis 1: infra ──────────────────────────────────────────────────────────────
  test("the dominant live reason classifies as infra", () => {
    const c = classifyFailureReason("sdk-overloaded-exhausted");
    expect(c.class).toBe(REASON_CLASS.INFRA);
    expect(c.family).toBe("provider-capacity");
    expect(c.matched).toBe("sdk-overloaded-exhausted");
  });

  test("every registered infra reason classifies as infra and carries a family", () => {
    const keys = Object.keys(INFRA_CLASS_REASONS);
    // ⛔ A non-empty denominator, asserted. `[].every(p)` is `true`, so a loop over an
    // empty registry would print an all-clear on the strength of zero iterations.
    expect(keys.length).toBeGreaterThan(0);
    for (const r of keys) {
      expect(classifyFailureReason(r).class).toBe(REASON_CLASS.INFRA);
      expect(typeof classifyFailureReason(r).family).toBe("string");
    }
  });

  // ── Axis 2: product. Without this axis the suite cannot tell routing from a constant.
  test("a genuine product-class reason does NOT classify as infra", () => {
    const c = classifyFailureReason("merge-conflict");
    expect(c.class).toBe(REASON_CLASS.PRODUCT);
    expect(isInfraClassReason("merge-conflict")).toBe(false);
  });

  test("every registered product reason classifies as product", () => {
    const keys = Object.keys(PRODUCT_CLASS_REASONS);
    expect(keys.length).toBeGreaterThan(0);
    for (const r of keys) {
      expect(classifyFailureReason(r).class).toBe(REASON_CLASS.PRODUCT);
    }
  });

  test("the two registries are DISJOINT — a reason cannot be both", () => {
    const overlap = Object.keys(INFRA_CLASS_REASONS).filter((k) =>
      Object.hasOwn(PRODUCT_CLASS_REASONS, k)
    );
    expect(overlap).toEqual([]);
  });

  // ── Axis 3: the default, and it must be the SAFE direction ─────────────────────
  test("an UNREGISTERED reason is unknown, never infra — the human still gets told", () => {
    for (const r of ["who-knows", "a-brand-new-failure-mode", "SDK-OVERLOADED-EXHAUSTED"]) {
      expect(classifyFailureReason(r).class).toBe(REASON_CLASS.UNKNOWN);
      expect(isInfraClassReason(r)).toBe(false);
    }
  });

  test("absent / non-string input is unknown and never throws (this sits on the write path)", () => {
    for (const r of [null, undefined, "", 0, 42, {}, [], true, Symbol("x")]) {
      expect(() => classifyFailureReason(r)).not.toThrow();
      expect(classifyFailureReason(r).class).toBe(REASON_CLASS.UNKNOWN);
    }
  });

  // ⛔ A frozen object literal still inherits Object.prototype, so a bare truthiness
  // lookup would classify these as infra — and an infra classification means "retry
  // forever, never tell anyone".
  test("inherited Object.prototype keys are NOT infra", () => {
    for (const r of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(classifyFailureReason(r).class).toBe(REASON_CLASS.UNKNOWN);
      expect(isInfraClassReason(r)).toBe(false);
    }
  });

  // ⚠️ Exact match only. A prefix/substring match would collapse two distinct reasons
  // from one producer, and would let a novel reason inherit an infra verdict it never
  // earned — which routes it to "retry forever, tell nobody".
  test("matching is EXACT — not prefix, not substring", () => {
    expect(isInfraClassReason("sdk-overloaded")).toBe(true); // registered in its own right
    expect(isInfraClassReason("sdk-overloaded-but-your-code-is-wrong")).toBe(false);
    expect(isInfraClassReason("not-sdk-overloaded-exhausted")).toBe(false);
    expect(isInfraClassReason(" sdk-overloaded-exhausted")).toBe(false);
    expect(isInfraClassReason("sdk-overloaded-exhausted ")).toBe(false);
  });

  test("both registries are frozen — a caller cannot widen the infra class at runtime", () => {
    expect(Object.isFrozen(INFRA_CLASS_REASONS)).toBe(true);
    expect(Object.isFrozen(PRODUCT_CLASS_REASONS)).toBe(true);
    expect(() => {
      "use strict";
      INFRA_CLASS_REASONS["merge-conflict"] = "provider-capacity";
    }).toThrow();
    expect(isInfraClassReason("merge-conflict")).toBe(false);
  });
});

describe("the registry matches its producers", () => {
  // ⚠️ These strings are the CONTRACT with producers that live in other files — and one
  // of them is a SKILL (markdown), not JS. Pinning the literals here means a rename on
  // the producer side fails this suite instead of silently reclassifying a live reason
  // as `unknown` and re-parking humans.
  test("every reason measured live on the fleet on 2026-08-19 is registered", () => {
    for (const r of [
      "sdk-overloaded-exhausted", // 82% of triage failures, 2.82/h
      "cluster_fence_stale",
      "cluster_fence_unverified",
      "artifact_not_gate_visible", // produced by plugins/dev/skills/phase-pr/SKILL.md
      "codex-rate-park-exhausted",
    ]) {
      expect(isInfraClassReason(r)).toBe(true);
    }
  });
});
