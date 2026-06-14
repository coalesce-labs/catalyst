// unstuck-stale-label.test.mjs — CTL-1064 Category D classifier tests.

import { describe, test, expect } from "bun:test";
import {
  classifyTerminalStaleLabel,
  collectTerminalStaleLabelCandidates,
  ATTENTION_LABELS,
  TERMINAL_LINEAR_STATES,
} from "./unstuck-stale-label.mjs";

// ---------------------------------------------------------------------------
// classifyTerminalStaleLabel — pure classifier
// ---------------------------------------------------------------------------
describe("classifyTerminalStaleLabel (CTL-1064 catD)", () => {
  test("Canceled + needs-human → clear-label", () => {
    const r = classifyTerminalStaleLabel({ linearState: "Canceled", attentionLabels: ["needs-human"], ticket: "CTL-X" });
    expect(r.action).toBe("clear-label");
    expect(r.label).toBe("needs-human");
  });

  test("Duplicate + needs-human → clear-label", () => {
    const r = classifyTerminalStaleLabel({ linearState: "Duplicate", attentionLabels: ["needs-human"] });
    expect(r.action).toBe("clear-label");
    expect(r.label).toBe("needs-human");
  });

  test("Done + blocked → clear-label", () => {
    const r = classifyTerminalStaleLabel({ linearState: "Done", attentionLabels: ["blocked"] });
    expect(r.action).toBe("clear-label");
    expect(r.label).toBe("blocked");
  });

  test("Done + waiting → clear-label", () => {
    const r = classifyTerminalStaleLabel({ linearState: "Done", attentionLabels: ["waiting"] });
    expect(r.action).toBe("clear-label");
    expect(r.label).toBe("waiting");
  });

  test("In Progress + needs-human → skip (not terminal)", () => {
    const r = classifyTerminalStaleLabel({ linearState: "In Progress", attentionLabels: ["needs-human"] });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("not-terminal");
  });

  test("Todo + needs-human → skip (not terminal)", () => {
    const r = classifyTerminalStaleLabel({ linearState: "Todo", attentionLabels: ["needs-human"] });
    expect(r.action).toBe("skip");
  });

  test("terminal + no attention label → skip/no-attention-label", () => {
    const r = classifyTerminalStaleLabel({ linearState: "Canceled", attentionLabels: [] });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("no-attention-label");
  });

  test("terminal + empty array → skip/no-attention-label", () => {
    const r = classifyTerminalStaleLabel({ linearState: "Done", attentionLabels: [] });
    expect(r.action).toBe("skip");
  });

  test("terminal + non-array → skip/no-attention-label", () => {
    const r = classifyTerminalStaleLabel({ linearState: "Canceled", attentionLabels: null });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("no-attention-label");
  });

  test("unknown linearState + attention label → skip (fail-closed)", () => {
    const r = classifyTerminalStaleLabel({ linearState: "Some Unknown State", attentionLabels: ["needs-human"] });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("not-terminal");
  });

  test("null linearState → skip (fail-closed)", () => {
    const r = classifyTerminalStaleLabel({ linearState: null, attentionLabels: ["needs-human"] });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("not-terminal");
  });

  test("terminal with multiple labels → first matching attention label returned", () => {
    const r = classifyTerminalStaleLabel({ linearState: "Done", attentionLabels: ["unrelated", "needs-human", "blocked"] });
    expect(r.action).toBe("clear-label");
    expect(r.label).toBe("needs-human");
  });
});

// ---------------------------------------------------------------------------
// collectTerminalStaleLabelCandidates — census
// ---------------------------------------------------------------------------
describe("collectTerminalStaleLabelCandidates (CTL-1064 catD census)", () => {
  test("empty listLabeledTickets → no writes (steady-state-zero)", () => {
    const out = collectTerminalStaleLabelCandidates({ listLabeledTickets: () => [] });
    expect(out).toHaveLength(0);
  });

  test("Canceled ticket with needs-human → one candidate", () => {
    const out = collectTerminalStaleLabelCandidates({
      listLabeledTickets: () => [
        { ticket: "CTL-CANCEL", labels: ["needs-human"], linearState: "Canceled" },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].ticket).toBe("CTL-CANCEL");
    expect(out[0].evidence.attentionLabels).toEqual(["needs-human"]);
    expect(out[0].isStaleLabel).toBe(true);
  });

  test("multi-label ticket → one candidate per attention label", () => {
    const out = collectTerminalStaleLabelCandidates({
      listLabeledTickets: () => [
        { ticket: "CTL-MULTI", labels: ["needs-human", "blocked"], linearState: "Canceled" },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out.map(c => c.evidence.attentionLabels[0]).sort()).toEqual(["blocked", "needs-human"]);
  });

  test("non-attention label ignored", () => {
    const out = collectTerminalStaleLabelCandidates({
      listLabeledTickets: () => [
        { ticket: "CTL-NOLABEL", labels: ["some-other-label"], linearState: "Canceled" },
      ],
    });
    expect(out).toHaveLength(0);
  });

  test("a seam throw on one ticket does not abort the rest", () => {
    let callCount = 0;
    const out = collectTerminalStaleLabelCandidates({
      listLabeledTickets: () => [
        null,  // will throw when accessing .ticket
        { ticket: "CTL-OK", labels: ["needs-human"], linearState: "Canceled" },
      ],
    });
    expect(out.some(c => c.ticket === "CTL-OK")).toBe(true);
  });

  test("listLabeledTickets throws → returns empty (never throws)", () => {
    const out = collectTerminalStaleLabelCandidates({
      listLabeledTickets: () => { throw new Error("Linear API failed"); },
    });
    expect(out).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe("ATTENTION_LABELS / TERMINAL_LINEAR_STATES (CTL-1064 catD)", () => {
  test("ATTENTION_LABELS contains needs-human, blocked, waiting", () => {
    expect(ATTENTION_LABELS).toContain("needs-human");
    expect(ATTENTION_LABELS).toContain("blocked");
    expect(ATTENTION_LABELS).toContain("waiting");
  });
  test("TERMINAL_LINEAR_STATES contains Canceled, Duplicate, Done", () => {
    expect(TERMINAL_LINEAR_STATES).toContain("Canceled");
    expect(TERMINAL_LINEAR_STATES).toContain("Duplicate");
    expect(TERMINAL_LINEAR_STATES).toContain("Done");
  });
  test("both are frozen", () => {
    expect(Object.isFrozen(ATTENTION_LABELS)).toBe(true);
    expect(Object.isFrozen(TERMINAL_LINEAR_STATES)).toBe(true);
  });
});
