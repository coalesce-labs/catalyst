// stall-class-wiring.test.mjs — CTL-2158. The classifier's WIRING: the unstuck
// sweep's quiet-gate, and the escalation producers' output re-target.
//
// The pure classifier is stall-class.test.mjs. This file proves the two things a
// pure test cannot: that the sweep actually consults the classifier, and that the
// producers actually stamp what the gate reads.
//
// Run: bun test plugins/dev/scripts/execution-core/stall-class-wiring.test.mjs
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyStalledTicket, STALL_CATEGORY_MAP } from "./unstuck-sweep.mjs";
import { defaultWriteEscalationSignal } from "./recovery-reasoning.mjs";
import { ESCALATION_PUBLISHED_FIELD, STALL_CLASS } from "./stall-class.mjs";

const SKIP = { category: "skip", action: "skip", reason: "already-escalated" };

// ─────────────────────────────────────────────────────────────────────────────
// ⛔ THE GATE. unstuck-sweep used to carry four hand-typed reason rows saying the
// same thing: a COMPLETE escalation already exists, so stay quiet. Without that,
// the ticket routes to unknown/escalate — a path that BYPASSES the intent gate,
// so every sweep interval posts another authored Linear comment on a ticket a
// human is already holding (the CTL-638 write-budget failure class).
// ─────────────────────────────────────────────────────────────────────────────
describe("⛔ the sweep's quiet-gate is DERIVED, not duplicated (audit Gap 2)", () => {
  test("the four legacy tokens are still quiet", () => {
    for (const reason of [
      "needs_human",
      "needs-human",
      "escalation-ask-cap",
      "boot-resume-gate-expired",
      "no-probe-for-phase",
    ]) {
      expect(classifyStalledTicket({ reason })).toEqual(SKIP);
    }
  });

  test("⛔ MUTATION PROOF — STALL_CATEGORY_MAP no longer carries ANY of them", () => {
    // If the skip rows were merely COPIED into the classifier, this passes for the
    // wrong reason: the map would still answer and the classifier would be inert.
    // Asserting the map is empty of them, while the assertions above still hold,
    // is what proves the classifier is the one answering.
    for (const key of [
      "needs_human",
      "needs-human",
      "escalation-ask-cap",
      "boot-resume-gate-expired",
      "no-probe-for-phase",
    ]) {
      expect(Object.hasOwn(STALL_CATEGORY_MAP, key)).toBe(false);
    }
    // POSITIVE CONTROL: the map is real and still routes the rows it does own —
    // so `hasOwn === false` above is an absence, not an empty/renamed object.
    expect(STALL_CATEGORY_MAP["orphan-sweep-stale"]).toEqual({
      category: "orphan-stale",
      action: "emit-phase-complete-if-merged",
    });
    expect(Object.keys(STALL_CATEGORY_MAP).length).toBeGreaterThan(0);
  });

  test("the FORWARD half: the stamp is quiet even with a reason the map would ACT on", () => {
    // This is the property that survives CTL-2159 deleting `stalledReason:"needs_human"`.
    expect(
      classifyStalledTicket({
        reason: "orphan-sweep-stale",
        signal: { stalledReason: "orphan-sweep-stale", [ESCALATION_PUBLISHED_FIELD]: true },
      }),
    ).toEqual(SKIP);
  });

  test("⛔ NO OTHER sweep verdict changed — every surviving map row still routes", () => {
    expect(classifyStalledTicket({ reason: "rebase_refused_dirty_tree" })).toEqual({
      category: "dirty-tree",
      action: "clear-noise-and-retry",
    });
    expect(classifyStalledTicket({ reason: "source_conflict_ctl708_unavailable" })).toEqual({
      category: "source-conflict",
      action: "force-push-if-clean",
    });
    expect(classifyStalledTicket({ reason: "orphan-sweep-stale" })).toEqual({
      category: "orphan-stale",
      action: "emit-phase-complete-if-merged",
    });
    expect(classifyStalledTicket({ reason: "remediate-cycle-cap-exhausted" })).toEqual({
      category: "remediate-cap",
      action: "escalate",
    });
    // and the two pre-existing skips are untouched
    expect(classifyStalledTicket({ liveSessionInWorktree: true })).toEqual({
      category: "skip",
      action: "skip",
      reason: "live-session",
    });
    expect(classifyStalledTicket({ linearTerminal: true })).toEqual({
      category: "skip",
      action: "skip",
      reason: "linear-terminal",
    });
  });

  test("⛔ an UNCLASSIFIABLE stall still ESCALATES — the sweep is how it stays visible", () => {
    // The classifier says HELD, but HELD means "a person must look", which is the
    // opposite of "say nothing". Silencing it here would ship the plan's named
    // worst outcome: no label, no ask, no alert, no retry — and so unnoticed.
    expect(classifyStalledTicket({ reason: "wibble_frobnicator_misaligned" })).toEqual({
      category: "unknown",
      action: "escalate",
    });
    // scheduler.mjs's generic stall writer attaches a coerced explanation and a
    // needsHumanSince to EVERY stall it records. Neither may buy silence.
    expect(
      classifyStalledTicket({
        reason: "wibble_frobnicator_misaligned",
        signal: {
          explanation: { escalation_type: "decision", degraded: true },
          needsHumanSince: "2026-08-21T00:00:00Z",
        },
      }),
    ).toEqual({ category: "unknown", action: "escalate" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The producer output re-target. recovery-reasoning.mjs (3,676 lines) is NOT
// rewritten — only what it writes.
// ─────────────────────────────────────────────────────────────────────────────
describe("escalation producers stamp the class and the publication", () => {
  const withOrchDir = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), "ctl2158-"));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const readSignal = (dir, ticket) =>
    JSON.parse(readFileSync(join(dir, "workers", ticket, "phase-recovery-pass.json"), "utf8"));

  test("recovery-reasoning's escalation signal carries stallClass + the publication stamp", () => {
    withOrchDir((dir) => {
      const ok = defaultWriteEscalationSignal(
        "CTL-1",
        {
          escalation_type: "decision",
          problem: "the implement phase died with no artifact",
          call_to_action: "decide whether to retry",
          observed: { reason: "orphan-sweep-stale" },
        },
        { orchDir: dir },
      );
      expect(ok).toBe(true);
      const sig = readSignal(dir, "CTL-1");
      // CTL-1552's representation is UNCHANGED — the re-target is additive.
      expect(sig.status).toBe("stalled");
      expect(sig.stalledReason).toBe("needs_human");
      // …and the class is now durable on disk.
      expect(sig.stallClass).toBe(STALL_CLASS.SYSTEM);
      expect(sig.stallClassRule).toBe("exact:orphan-sweep-stale");
      expect(sig[ESCALATION_PUBLISHED_FIELD]).toBe(true);
    });
  });

  test("an escalation with nothing to classify is HELD on disk, not guessed", () => {
    withOrchDir((dir) => {
      defaultWriteEscalationSignal(
        "CTL-2",
        { escalation_type: "decision", problem: "unexplained failure", degraded: true },
        { orchDir: dir },
      );
      const sig = readSignal(dir, "CTL-2");
      expect(sig.stallClass).toBe(STALL_CLASS.HELD);
      // named as manufactured, so the board can say "this ask was generated"
      expect(sig.stallClassManufactured).toBe(true);
      expect(sig[ESCALATION_PUBLISHED_FIELD]).toBe(true);
    });
  });

  test("END TO END — the signal a producer wrote makes the sweep quiet", () => {
    withOrchDir((dir) => {
      defaultWriteEscalationSignal(
        "CTL-3",
        { escalation_type: "decision", problem: "unexplained failure", degraded: true },
        { orchDir: dir },
      );
      const sig = readSignal(dir, "CTL-3");
      expect(classifyStalledTicket({ reason: sig.stalledReason, signal: sig })).toEqual(SKIP);

      // ⛔ THE POINT OF THE WHOLE EXERCISE: strip the `needs_human` token exactly
      // as CTL-2159 will, and the gate STILL holds — because it never depended on it.
      const detokenized = { ...sig, stalledReason: "some-future-token" };
      expect(classifyStalledTicket({ reason: detokenized.stalledReason, signal: detokenized })).toEqual(
        SKIP,
      );

      // NEGATIVE CONTROL: strip the STAMP too and the gate correctly reopens —
      // so the two assertions above are measuring the stamp, not a gate that
      // returns skip for everything.
      const unstamped = { ...detokenized };
      delete unstamped[ESCALATION_PUBLISHED_FIELD];
      expect(classifyStalledTicket({ reason: unstamped.stalledReason, signal: unstamped })).toEqual({
        category: "unknown",
        action: "escalate",
      });
    });
  });
});
