// needs-human-migration-sweep.test.mjs — CTL-2160.
//
// Every "nothing happened" assertion here is paired with a POSITIVE CONTROL that
// fires under the same instrument. A guard whose negative case never fires is not
// a guard that is passing — it is a guard that is wrong, and that is exactly the
// class of defect the plan audit found in the version of this rule it replaced.
import { describe, it, expect } from "bun:test";
import {
  decideTicket,
  sweep,
  hasBlocksRelation,
  isTerminalState,
  isActiveState,
  parseArgs,
  VERDICT,
} from "./needs-human-migration-sweep.mjs";

const REL_OK = { available: true, relations: {} };

describe("RULE 1 — an unavailable relation source is a HARD STOP, never a pass", () => {
  it("sweep THROWS when the relation source could not answer", () => {
    expect(() =>
      sweep([{ ticket: "CTL-1", state: "Done" }], {
        relationSource: { available: false, reason: "replica has no `relations` table" },
      }),
    ).toThrow(/relation source unavailable/);
  });

  it("the message names the reason (so the operator can fix it, not just retry)", () => {
    expect(() =>
      sweep([{ ticket: "CTL-1" }], { relationSource: { available: false, reason: "replica absent" } }),
    ).toThrow(/replica absent/);
  });

  it("POSITIVE CONTROL: the SAME ticket sweeps cleanly when the source answers", () => {
    const out = sweep([{ ticket: "CTL-1", state: "Done" }], { relationSource: REL_OK });
    expect(out.clear.map((d) => d.ticket)).toEqual(["CTL-1"]);
    expect(out.hold).toHaveLength(0);
  });

  it("sweep with NO relationSource at all throws — a missing arg is not a pass", () => {
    expect(() => sweep([{ ticket: "CTL-1", state: "Done" }], {})).toThrow(/relation source unavailable/);
  });

  it("--allow-missing-relations degrades every ticket to HOLD, never to CLEAR", () => {
    const out = sweep([{ ticket: "CTL-1", state: "Done" }], {
      relationSource: { available: false, reason: "test" },
      allowMissingRelations: true,
    });
    expect(out.clear).toHaveLength(0);
    expect(out.ask).toHaveLength(0);
    expect(out.hold[0].rule).toBe("relations-unavailable");
  });

  it("a blocks-family relation HOLDS a ticket that would otherwise clear", () => {
    const held = sweep([{ ticket: "CTL-1", state: "Done" }], {
      relationSource: { available: true, relations: { "CTL-1": { blocks: ["CTL-2"] } } },
    });
    expect(held.hold[0].rule).toBe("blocks-relation");
    // POSITIVE CONTROL: same ticket, same state, no relation → CLEAR. So the HOLD
    // above is the relation and not a broken terminal-state rule.
    const cleared = sweep([{ ticket: "CTL-1", state: "Done" }], { relationSource: REL_OK });
    expect(cleared.clear).toHaveLength(1);
  });

  it("the INVERSE edge (blocked_by) holds too — being gated is what matters", () => {
    const out = sweep([{ ticket: "CTL-1", state: "Done" }], {
      relationSource: { available: true, relations: { "CTL-1": { blocked_by: ["CTL-9"] } } },
    });
    expect(out.hold[0].rule).toBe("blocks-relation");
  });

  it("a NON-blocks relation (`related`, `duplicate`) does NOT hold", () => {
    const out = sweep([{ ticket: "CTL-1", state: "Done" }], {
      relationSource: {
        available: true,
        relations: { "CTL-1": { related: ["CTL-2"], duplicate: ["CTL-3"] } },
      },
    });
    expect(out.clear).toHaveLength(1);
  });

  it("hasBlocksRelation: empty arrays and nulls are not relations", () => {
    expect(hasBlocksRelation({ blocks: [] })).toBe(false);
    expect(hasBlocksRelation({ blocks: null })).toBe(false);
    expect(hasBlocksRelation(null)).toBe(false);
    expect(hasBlocksRelation({ blocks: ["X-1"] })).toBe(true); // positive control
  });
});

describe("RULE 2 — key on `state`, not `state_type`", () => {
  it("classifies a row whose state_type is NULL but whose state is populated", () => {
    // 16 of the 69 labelled rows are exactly this shape (ADV-1377/Implement,
    // CTL-2123/Triage, CTC-842/Research). A state_type-keyed sweep sees nothing.
    const out = sweep([{ ticket: "ADV-1377", state: "Implement", state_type: null }], {
      relationSource: REL_OK,
    });
    expect(out.clear[0].rule).toBe("active-state");
  });

  it("is case- and whitespace-insensitive on the state NAME", () => {
    expect(isTerminalState("  DONE ")).toBe(true);
    expect(isActiveState("In Progress")).toBe(true);
    expect(isTerminalState("Triage")).toBe(false); // positive control for the negative
  });

  it("an UNRECOGNISED state falls through to the classifier, not to CLEAR", () => {
    const out = sweep([{ ticket: "CTL-1", state: "Some New Column", reason: null }], {
      relationSource: REL_OK,
    });
    expect(out.hold[0].rule).toBe("unclassifiable");
  });
});

describe("RULE 3/4 — the CTL-2158 classifier decides; HELD is never collapsed", () => {
  it("a SYSTEM reason clears", () => {
    const out = sweep(
      [{ ticket: "CTL-1", state: "Triage", reason: "sdk-overloaded-exhausted" }],
      { relationSource: REL_OK },
    );
    expect(out.clear[0].detail).toBe("system");
  });

  it("an ASK reason becomes an ask, not a clear", () => {
    const out = sweep([{ ticket: "CTL-1", state: "Triage", reason: "design_signoff_gate" }], {
      relationSource: REL_OK,
    });
    expect(out.ask).toHaveLength(1);
    expect(out.clear).toHaveLength(0);
  });

  it("a reason nothing recognises is HELD — the deliberately unclassifiable fixture", () => {
    const out = sweep(
      [{ ticket: "CTL-1", state: "Triage", reason: "wat_is_this_even_2026" }],
      { relationSource: REL_OK },
    );
    expect(out.hold).toHaveLength(1);
    expect(out.clear).toHaveLength(0);
    expect(out.ask).toHaveLength(0);
  });

  it("NO reason at all is HELD — 'I could not look' is not 'nothing is wrong'", () => {
    const out = sweep([{ ticket: "CTL-1", state: "Triage" }], { relationSource: REL_OK });
    expect(out.hold[0].rule).toBe("unclassifiable");
  });
});

describe("the human-engagement and dependency-cycle holds", () => {
  it("a human comment since the label landed HOLDS, even on a terminal ticket", () => {
    const out = sweep([{ ticket: "CTL-1", state: "Done", humanCommentedSince: true }], {
      relationSource: REL_OK,
    });
    expect(out.hold[0].rule).toBe("human-engaged");
    // POSITIVE CONTROL: identical ticket without the comment clears.
    expect(
      sweep([{ ticket: "CTL-1", state: "Done" }], { relationSource: REL_OK }).clear,
    ).toHaveLength(1);
  });

  it("a dependency cycle is ASK by construction", () => {
    const out = sweep([{ ticket: "CTL-1", state: "Triage", inDependencyCycle: true }], {
      relationSource: REL_OK,
    });
    expect(out.ask[0].rule).toBe("dependency-cycle");
  });
});

describe("the CLI contract", () => {
  it("dry-run is the DEFAULT — apply is false with no flags", () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(["--json"]).apply).toBe(false);
    expect(parseArgs(["--apply"]).apply).toBe(true); // positive control
  });
});

describe("decideTicket is total — every ticket lands in exactly one bucket", () => {
  it("no decision is ever undefined, and the buckets partition the input", () => {
    const tickets = [
      { ticket: "A-1", state: "Done" },
      { ticket: "A-2", state: "Implement" },
      { ticket: "A-3", state: "Triage", reason: "design_signoff_gate" },
      { ticket: "A-4", state: "Triage", reason: "nonsense_token" },
      { ticket: "A-5", state: null },
    ];
    const out = sweep(tickets, { relationSource: REL_OK });
    expect(out.decisions).toHaveLength(5);
    expect(out.clear.length + out.ask.length + out.hold.length).toBe(5);
    for (const d of out.decisions) {
      expect(Object.values(VERDICT)).toContain(d.verdict);
      expect(typeof d.rule).toBe("string");
    }
  });

  it("decideTicket alone refuses without relationsAvailable", () => {
    expect(decideTicket({ ticket: "A-1", state: "Done" }).rule).toBe("relations-unavailable");
  });
});
