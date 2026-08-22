// stall-class.test.mjs — CTL-2158. Unit tests for the PURE stall classifier.
// The sweep + producer wiring is stall-class-wiring.test.mjs.
//
// Run: bun test plugins/dev/scripts/execution-core/stall-class.test.mjs
import { describe, test, expect } from "bun:test";
import {
  STALL_CLASS,
  STALL_CLASSES,
  STALL_CLASS_ACTION,
  STALL_REASON_CLASS,
  STALL_REASON_PREFIX_CLASS,
  STALL_FAMILY_PATTERNS,
  TERMINAL_ESCALATION_REASONS,
  ESCALATION_PUBLISHED_FIELD,
  canonicalizeReason,
  classifyStall,
  isHeldForReview,
  stallClassSignalFields,
  stallSweepDisposition,
} from "./stall-class.mjs";

const klassOf = (reason, extra = {}) => classifyStall({ reason, ...extra }).klass;

describe("the taxonomy is total (CTL-2158)", () => {
  test("every class has exactly one action", () => {
    expect(Object.keys(STALL_CLASS_ACTION).sort()).toEqual([...STALL_CLASSES].sort());
    // The actions must be distinct — two classes sharing an action would mean the
    // split is decorative.
    expect(new Set(Object.values(STALL_CLASS_ACTION)).size).toBe(STALL_CLASSES.length);
  });

  test("every table row maps to a real class", () => {
    for (const [reason, klass] of Object.entries(STALL_REASON_CLASS)) {
      expect(STALL_CLASSES).toContain(klass);
      // ⛔ the table is keyed CANONICALLY — a snake_case key would silently never match
      expect(reason).toBe(canonicalizeReason(reason));
    }
    for (const [prefix, klass] of Object.entries(STALL_REASON_PREFIX_CLASS)) {
      expect(STALL_CLASSES).toContain(klass);
      expect(prefix).toBe(canonicalizeReason(prefix));
    }
  });

  test("family patterns exist for S/A/M and NOT for held", () => {
    expect(Object.keys(STALL_FAMILY_PATTERNS).sort()).toEqual(
      [STALL_CLASS.ASK, STALL_CLASS.MOOT, STALL_CLASS.SYSTEM].sort(),
    );
    // HELD is the absence of a verdict, so a pattern that "matches held" would be
    // a contradiction in terms.
    expect(STALL_FAMILY_PATTERNS[STALL_CLASS.HELD]).toBeUndefined();
  });

  test("canonicalizeReason collapses the two live spellings onto one key", () => {
    expect(canonicalizeReason("needs_human")).toBe("needs-human");
    expect(canonicalizeReason("needs-human")).toBe("needs-human");
    expect(canonicalizeReason("  Empty_Branch  ")).toBe("empty-branch");
    expect(canonicalizeReason(null)).toBe("");
  });
});

describe("S — SYSTEM: retry with backoff, zero per-ticket artifacts", () => {
  test.each([
    "orphan-sweep-stale",
    "prior-artifact-retry-exhausted",
    "remediate-cycle-cap-exhausted",
    "rebase_refused_dirty_tree",
    "source_conflict_ctl708_unavailable",
    "watchdog-kill",
    "worker-oom",
    "ended-without-declaration",
    "cluster_fence_stale",
    "triage-redispatch-cap",
    "attempts-exhausted",
    "claude-resource-shed",
  ])("%s is SYSTEM", (reason) => {
    const v = classifyStall({ reason });
    expect(v.klass).toBe(STALL_CLASS.SYSTEM);
    expect(v.action).toBe("retry-with-backoff");
  });

  test("prefix rules cover the payload-carrying reasons", () => {
    expect(klassOf("dispatch-circuit-breaker:7")).toBe(STALL_CLASS.SYSTEM);
    expect(klassOf("budget:day-exhausted")).toBe(STALL_CLASS.SYSTEM);
    expect(klassOf("cloud:session-part-failed")).toBe(STALL_CLASS.SYSTEM);
  });

  test("the provider-overload family — the 41 that became 41 asks — is SYSTEM", () => {
    // None of these is in the exact table; they land via the family pattern. This
    // is the case the whole epic exists for: one outage, one alert, no per-ticket
    // human artifacts.
    for (const reason of [
      "anthropic-529-overloaded",
      "provider_rate_limit_hit",
      "account-quota-exhausted",
      "upstream-timeout",
      "econnreset-during-stream",
      "usage-limit-reached",
    ]) {
      expect(classifyStall({ reason }).klass).toBe(STALL_CLASS.SYSTEM);
    }
  });
});

describe("A — ASK: one ask ticket carrying `blocks`", () => {
  test.each([
    "design_signoff_gate",
    "human_scope_decision_required",
    "boot-resume-gate-expired",
    "needs-human:prd-required-before-scoping",
    "needs-human:operational-provisioning",
    "cold-start-expensive-phase-awaiting-approval",
  ])("%s is ASK", (reason) => {
    const v = classifyStall({ reason });
    expect(v.klass).toBe(STALL_CLASS.ASK);
    expect(v.action).toBe("raise-ask");
  });

  test("an unlisted `needs-human:<gate>` reason still routes to ASK via the prefix", () => {
    const v = classifyStall({ reason: "needs-human:legal-review-required" });
    expect(v.klass).toBe(STALL_CLASS.ASK);
    expect(v.rule).toBe("prefix:needs-human:");
  });
});

describe("M — MOOT: close it", () => {
  test.each([
    "empty_branch",
    "empty_branch_gate",
    "empty_branch_backstop",
    "no_actionable_plan",
    "terminal-or-merged-no-live-session",
    "ctl-606-superseded",
  ])("%s is MOOT", (reason) => {
    const v = classifyStall({ reason });
    expect(v.klass).toBe(STALL_CLASS.MOOT);
    expect(v.action).toBe("close");
  });

  test("already_fixed_by_<TICKET> is MOOT through the prefix, ticket id and all", () => {
    const v = classifyStall({ reason: "already_fixed_by_CTL-1234" });
    expect(v.klass).toBe(STALL_CLASS.MOOT);
    expect(v.rule).toBe("prefix:already-fixed-by-");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⛔ THE HEADLINE CONTRACT. An unclassifiable stall is HELD FOR REVIEW. It is
// never dropped, never guessed at, never auto-retried forever, never auto-cleared.
// ─────────────────────────────────────────────────────────────────────────────
describe("⛔ an UNCLASSIFIABLE reason is HELD, never silently dropped", () => {
  test("a reason no rule anticipated is HELD with an explicit rule", () => {
    const v = classifyStall({ reason: "wibble_frobnicator_misaligned" });
    expect(v).toBeTruthy();
    expect(v.klass).toBe(STALL_CLASS.HELD);
    expect(v.held).toBe(true);
    expect(v.rule).toBe("unclassified");
    expect(v.action).toBe("hold-for-review");
    expect(isHeldForReview(v)).toBe(true);
    // the original token survives on the verdict — a held stall a person cannot
    // read the reason of is not reviewable
    expect(v.reason).toBe("wibble_frobnicator_misaligned");
    expect(v.canonicalReason).toBe("wibble-frobnicator-misaligned");
  });

  test("NO reason at all is HELD — 'I could not look' is not 'nothing is wrong'", () => {
    for (const evidence of [{}, { reason: null }, { reason: "" }, { reason: "   " }, { signal: {} }]) {
      const v = classifyStall(evidence);
      expect(v.klass).toBe(STALL_CLASS.HELD);
      expect(v.rule).toBe("no-reason");
    }
  });

  test("classifyStall ALWAYS returns a verdict object — there is no drop path", () => {
    for (const evidence of [undefined, null, {}, { reason: 42 }, { reason: {} }, { signal: null }]) {
      const v = classifyStall(evidence);
      expect(typeof v).toBe("object");
      expect(v).not.toBeNull();
      expect(STALL_CLASSES).toContain(v.klass);
      expect(typeof v.rule).toBe("string");
      expect(v.rule.length).toBeGreaterThan(0);
    }
  });

  test("AMBIGUOUS evidence is HELD, not a coin flip on rule order", () => {
    // matches the SYSTEM family (capacity) AND the ASK family (approval)
    const v = classifyStall({ reason: "capacity-increase-approval-pending" });
    expect(v.klass).toBe(STALL_CLASS.HELD);
    expect(v.rule).toMatch(/^ambiguous:/);
    expect(v.rule).toContain(STALL_CLASS.SYSTEM);
    expect(v.rule).toContain(STALL_CLASS.ASK);
  });

  test("`needs_human` itself is HELD — it records THAT, never WHY", () => {
    for (const spelling of ["needs_human", "needs-human", "NEEDS_HUMAN"]) {
      const v = classifyStall({ reason: spelling });
      expect(v.klass).toBe(STALL_CLASS.HELD);
      expect(v.rule).toBe("exact:needs-human");
      // and it must NOT be read as an ask — that is how the bin re-forms
      expect(v.klass).not.toBe(STALL_CLASS.ASK);
    }
  });

  test("every verdict is frozen — a consumer cannot rewrite a HELD into an ASK", () => {
    const v = classifyStall({ reason: "wibble" });
    expect(Object.isFrozen(v)).toBe(true);
    expect(() => {
      "use strict";
      v.klass = STALL_CLASS.ASK;
    }).toThrow();
    expect(v.klass).toBe(STALL_CLASS.HELD);
  });
});

describe("a MANUFACTURED explanation never creates an ask", () => {
  // coerceExplanation's degrade branch stamps `degraded:true` and writes
  // "priority call the agent cannot make unilaterally" for ANY unexplained
  // worker death. That sentence is a template, not evidence.
  const degraded = {
    escalation_type: "decision",
    problem: "unexplained failure in CTL-1 implement phase",
    why_you: "priority call the agent cannot make unilaterally for CTL-1",
    degraded: true,
  };

  test("unclassifiable + degraded explanation is HELD, named as manufactured", () => {
    const v = classifyStall({ reason: "wibble_frobnicator_misaligned", explanation: degraded });
    expect(v.klass).toBe(STALL_CLASS.HELD);
    expect(v.rule).toBe("manufactured-escalation");
    expect(v.manufactured).toBe(true);
  });

  test("POSITIVE CONTROL — a real reason still classifies through a degraded explanation", () => {
    // The prose being generated does not make the REASON untrustworthy.
    expect(classifyStall({ reason: "design_signoff_gate", explanation: degraded }).klass).toBe(
      STALL_CLASS.ASK,
    );
    expect(classifyStall({ reason: "orphan-sweep-stale", explanation: degraded }).klass).toBe(
      STALL_CLASS.SYSTEM,
    );
  });

  test("NEGATIVE CONTROL — the same reason WITHOUT degraded is still HELD but not 'manufactured'", () => {
    const v = classifyStall({
      reason: "wibble_frobnicator_misaligned",
      explanation: { ...degraded, degraded: false },
    });
    expect(v.klass).toBe(STALL_CLASS.HELD);
    expect(v.rule).toBe("unclassified");
    expect(v.manufactured).toBe(false);
  });
});

describe("a producer's own verdict wins — but only a VALID one", () => {
  test("signal.stallClass is trusted", () => {
    const v = classifyStall({ reason: "wibble", signal: { stallClass: STALL_CLASS.SYSTEM } });
    expect(v.klass).toBe(STALL_CLASS.SYSTEM);
    expect(v.rule).toBe("signal:stallClass");
  });

  test("a GARBAGE stallClass is ignored, not laundered into a verdict", () => {
    for (const junk of ["", "SYSTEM", "s", 1, true, null, {}]) {
      const v = classifyStall({ reason: "wibble", signal: { stallClass: junk } });
      expect(v.klass).toBe(STALL_CLASS.HELD);
      expect(v.rule).toBe("unclassified");
    }
  });

  test("reason falls back to the signal's own stalledReason / failureReason", () => {
    expect(classifyStall({ signal: { stalledReason: "orphan-sweep-stale" } }).klass).toBe(
      STALL_CLASS.SYSTEM,
    );
    expect(classifyStall({ signal: { failureReason: "orphan-sweep-stale" } }).klass).toBe(
      STALL_CLASS.SYSTEM,
    );
  });
});

describe("stallClassSignalFields — the durable, on-disk record", () => {
  test("carries the class and the rule, and nothing that clobbers status", () => {
    const f = stallClassSignalFields(classifyStall({ reason: "orphan-sweep-stale" }));
    expect(f).toEqual({ stallClass: "system", stallClassRule: "exact:orphan-sweep-stale" });
    expect(f.status).toBeUndefined();
    expect(f.stalledReason).toBeUndefined();
  });

  test("flags a manufactured escalation so the board can say so", () => {
    const f = stallClassSignalFields(
      classifyStall({ reason: "novel", explanation: { degraded: true } }),
    );
    expect(f.stallClass).toBe(STALL_CLASS.HELD);
    expect(f.stallClassManufactured).toBe(true);
  });

  test("a junk verdict yields NO fields rather than a corrupt one", () => {
    expect(stallClassSignalFields(null)).toEqual({});
    expect(stallClassSignalFields({ klass: "nonsense" })).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⛔ THE SKIP-GATE (audit Gap 2). Deleting this without re-keying the
// classification is a comment-spam loop into the Linear write budget — the
// CTL-638 failure class.
// ─────────────────────────────────────────────────────────────────────────────
describe("⛔ stallSweepDisposition — the already-escalated quiet gate", () => {
  test("every legacy terminal token is quiet (the four hand-typed rows it replaces)", () => {
    expect([...TERMINAL_ESCALATION_REASONS].sort()).toEqual([
      "boot-resume-gate-expired",
      "escalation-ask-cap",
      "needs-human",
      "no-probe-for-phase",
    ]);
    for (const reason of ["needs_human", "needs-human", "escalation-ask-cap", "boot-resume-gate-expired", "no-probe-for-phase"]) {
      expect(stallSweepDisposition({ reason })).toEqual({
        category: "skip",
        action: "skip",
        reason: "already-escalated",
      });
    }
  });

  test("the FORWARD half: the stamp alone is quiet, with no reason token at all", () => {
    // This is what survives the deletion of `stalledReason:"needs_human"`.
    expect(
      stallSweepDisposition({
        reason: "whatever-replaces-needs-human",
        signal: { [ESCALATION_PUBLISHED_FIELD]: true },
      }),
    ).toEqual({ category: "skip", action: "skip", reason: "already-escalated" });
  });

  test("⛔ REGRESSION GUARD — an `explanation` block does NOT make a stall quiet", () => {
    // scheduler.mjs's generic stall writer attaches a coerced explanation and a
    // needsHumanSince to EVERY stall it records, including the ones the sweep is
    // supposed to keep repairing. Keying the gate on `explanation != null` would
    // silence the sweep wholesale and look like a tidy refactor.
    const noisy = {
      explanation: { escalation_type: "decision", problem: "x", degraded: true },
      needsHumanSince: "2026-08-21T00:00:00Z",
    };
    for (const reason of [
      "rebase_refused_dirty_tree",
      "source_conflict_ctl708_unavailable",
      "orphan-sweep-stale",
      "remediate-cycle-cap-exhausted",
      "prior-artifact-retry-exhausted",
    ]) {
      expect(stallSweepDisposition({ reason, signal: { ...noisy, stalledReason: reason } })).toBeNull();
    }
    // POSITIVE CONTROL: identical evidence plus the explicit stamp IS quiet, so
    // the assertion above is measuring the stamp and not a broken instrument.
    expect(
      stallSweepDisposition({
        reason: "rebase_refused_dirty_tree",
        signal: { ...noisy, [ESCALATION_PUBLISHED_FIELD]: true },
      }),
    ).not.toBeNull();
  });

  test("⛔ HELD is NOT quiet — a stall nobody can classify must stay visible", () => {
    // Silencing HELD here would ship the plan's named worst outcome: no label, no
    // ask, no alert, no retry — and therefore no way to notice.
    expect(stallSweepDisposition({ reason: "wibble_frobnicator_misaligned" })).toBeNull();
    expect(stallSweepDisposition({})).toBeNull();
  });

  test("ASK and MOOT are not quiet either, until a producer publishes for them", () => {
    expect(stallSweepDisposition({ reason: "design_signoff_gate" })).toBeNull();
    expect(stallSweepDisposition({ reason: "empty_branch" })).toBeNull();
  });
});
