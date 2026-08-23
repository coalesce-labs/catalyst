// stall-class-wiring.test.mjs — CTL-2158. The classifier's WIRING: the unstuck
// sweep's quiet-gate, and the escalation producers' output re-target.
//
// The pure classifier is stall-class.test.mjs. This file proves the two things a
// pure test cannot: that the sweep actually consults the classifier, and that the
// producers actually stamp what the gate reads.
//
// Run: bun test plugins/dev/scripts/execution-core/stall-class-wiring.test.mjs
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyStalledTicket, STALL_CATEGORY_MAP } from "./unstuck-sweep.mjs";
import { publishEscalation } from "./escalation-publish.mjs";
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
// The producer output re-target. CTL-2141 deleted the recovery-reasoning producer
// this half was first written against; the SURVIVING producer is the shared
// chokepoint, and the property is the same one — a producer stamps on disk
// exactly what the sweep's gate reads back.
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

  const signalPath = (dir, ticket) =>
    join(dir, "workers", ticket, "phase-recovery-pass.json");
  const readSignal = (dir, ticket) => JSON.parse(readFileSync(signalPath(dir, ticket), "utf8"));

  // Drives the SURVIVING producer core with the ask transport stubbed, and lets it
  // write the real on-disk signal — the same file the sweep's gate reads back.
  const publish = (dir, ticket, opts = {}) => {
    mkdirSync(join(dir, "workers", ticket), { recursive: true });
    return publishEscalation(dir, ticket, {
      env: {},
      site: "terminal-sweep",
      markerBase: join(dir, "workers", ticket, ".escalation"),
      fileAsk: () => ({ ok: true, ticket: "CTL-ASK-1" }),
      writeSignal: ({ fields }) =>
        writeFileSync(signalPath(dir, ticket), JSON.stringify({ ticket, ...fields })),
      ...opts,
    });
  };

  const ASKABLE = {
    problem: "the implement phase died with no artifact",
    call_to_action: "decide whether to retry",
    why_asking: "only a person can decide whether this work is still wanted",
    recommendation: "retry once, then close if it dies the same way",
    options: [
      { label: "retry", tradeoff: "burns another attempt" },
      { label: "close", tradeoff: "drops the work" },
    ],
  };

  test("an ASK publish stamps the class AND the publication", () => {
    withOrchDir((dir) => {
      expect(publish(dir, "CTL-1", { reason: "design-signoff-gate", explanation: ASKABLE })).toBe(
        true,
      );
      const sig = readSignal(dir, "CTL-1");
      expect(sig.stallClass).toBe(STALL_CLASS.ASK);
      expect(sig[ESCALATION_PUBLISHED_FIELD]).toBe(true);
    });
  });

  test("an escalation with nothing to classify is HELD on disk, not guessed", () => {
    withOrchDir((dir) => {
      publish(dir, "CTL-2", { explanation: { problem: "unexplained failure", degraded: true } });
      const sig = readSignal(dir, "CTL-2");
      expect(sig.stallClass).toBe(STALL_CLASS.HELD);
      // named as manufactured, so the board can say "this ask was generated"
      expect(sig.stallClassManufactured).toBe(true);
      // ⛔ and it is NOT stamped published: HELD is "nobody looked yet", so the
      // sweep must keep watching it. Only a filed ask latches the quiet-gate.
      expect(sig[ESCALATION_PUBLISHED_FIELD]).toBeUndefined();
    });
  });

  test("END TO END — the signal a producer wrote makes the sweep quiet", () => {
    withOrchDir((dir) => {
      publish(dir, "CTL-3", { reason: "design-signoff-gate", explanation: ASKABLE });
      const sig = { ...readSignal(dir, "CTL-3"), stalledReason: "needs_human" };
      expect(classifyStalledTicket({ reason: sig.stalledReason, signal: sig })).toEqual(SKIP);

      // ⛔ THE POINT OF THE WHOLE EXERCISE: strip the `needs_human` token exactly
      // as CTL-2159 did, and the gate STILL holds — because it never depended on it.
      const detokenized = { ...sig, stalledReason: "some-future-token" };
      expect(
        classifyStalledTicket({ reason: detokenized.stalledReason, signal: detokenized }),
      ).toEqual(SKIP);

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
