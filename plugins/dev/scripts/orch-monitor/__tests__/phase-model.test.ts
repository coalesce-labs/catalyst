// phase-model.test.ts — units for the StatusIcon/PhaseStrip phase model (CTL-900
// / HOME2): the canonical phase list, the index lookup that drives the glyph fill
// fraction, the done-status detection that flips the glyph to the disc+check, and
// the per-phase color (which must NEVER be the reserved live cyan). This is the
// React-free spine the hand-rolled glyph reads, so it unit-tests directly under
// `bun test` (same precedent as home-inbox.test.ts).
//
// The Gherkin these lock in (CTL-900):
//   • "a single StatusIcon shows a partial ring + pie fill proportional to
//      (phaseIndex+1)/total" → phaseFraction((phaseIndex)) === (phaseIndex+1)/total.
//   • "the glyph is colored by the current phase on the early->late spectrum"
//      → phaseColor(phase) resolves a non-cyan color for every canonical phase.
//   • "a finished item … shows a filled disc with a check mark" → isDoneStatus.
//   • "the current phase as a ringed/larger dot … pending as faint hollow dots"
//      → phaseIndexOf gives the strip its done/current/pending split.
import { describe, it, expect } from "bun:test";
import {
  PHASE_LIST,
  PHASE_COUNT,
  PHASE_LABEL,
  PHASE_SHORT,
  TERMINAL_STATUSES,
  phaseIndexOf,
  phaseFraction,
  isPhase,
  isDoneStatus,
  phaseColor,
} from "@/board/phase-model";

// The reserved live-loop color — must never be used for a phase glyph (it stays
// reserved for the "in-loop" liveness signal, Board.tsx LIVE).
const LIVE_CYAN = "#5be0ff";

describe("PHASE_LIST — the canonical pipeline (no synthetic 'done' step)", () => {
  it("is the 10 canonical pipeline phases, in order", () => {
    expect([...PHASE_LIST]).toEqual([
      "triage",
      "research",
      "plan",
      "implement",
      "verify",
      "review",
      "pr",
      "monitor-merge",
      "monitor-deploy",
      "teardown",
    ]);
  });
  it("does NOT carry a synthetic 'done' pseudo-phase ('done' is a status)", () => {
    expect((PHASE_LIST as readonly string[]).includes("done")).toBe(false);
  });
  it("PHASE_COUNT equals the list length", () => {
    expect(PHASE_COUNT).toBe(PHASE_LIST.length);
  });
  it("every phase has a full + short human label", () => {
    for (const p of PHASE_LIST) {
      expect(PHASE_LABEL[p]).toBeTruthy();
      expect(PHASE_SHORT[p]).toBeTruthy();
    }
  });
});

describe("phaseIndexOf — the strip's done/current/pending split source", () => {
  it("maps each canonical phase to its 0-based index", () => {
    expect(phaseIndexOf("triage")).toBe(0);
    expect(phaseIndexOf("implement")).toBe(3);
    expect(phaseIndexOf("teardown")).toBe(PHASE_COUNT - 1);
  });
  it("returns -1 for an unknown / pre-pipeline / ancillary phase", () => {
    expect(phaseIndexOf("remediate")).toBe(-1);
    expect(phaseIndexOf("")).toBe(-1);
    expect(phaseIndexOf(null)).toBe(-1);
    expect(phaseIndexOf(undefined)).toBe(-1);
  });
});

describe("phaseFraction — the ring/pie fill = (phaseIndex+1)/total (Scenario 1)", () => {
  it("counts the current phase as in-flight: phase 0 already shows a sliver", () => {
    expect(phaseFraction(0)).toBeCloseTo(1 / PHASE_COUNT, 10);
  });
  it("is proportional to (phaseIndex+1)/total at the implement phase", () => {
    const idx = phaseIndexOf("implement"); // 3
    expect(phaseFraction(idx)).toBeCloseTo((idx + 1) / PHASE_COUNT, 10);
  });
  it("the terminal pipeline phase reads as a full ring", () => {
    expect(phaseFraction(PHASE_COUNT - 1)).toBeCloseTo(1, 10);
  });
  it("an unknown phase (index -1) reads as no progress (empty ring)", () => {
    expect(phaseFraction(-1)).toBe(0);
  });
  it("never exceeds 1 even for an out-of-range index", () => {
    expect(phaseFraction(PHASE_COUNT + 5)).toBe(1);
  });
});

describe("isDoneStatus — the disc+check terminal (Scenario 2)", () => {
  it("is true only for the success terminal 'done'", () => {
    expect(isDoneStatus("done")).toBe(true);
  });
  it("is false for in-flight statuses", () => {
    expect(isDoneStatus("active")).toBe(false);
    expect(isDoneStatus("running")).toBe(false);
    expect(isDoneStatus("unknown")).toBe(false);
  });
  it("is false for NON-success terminal statuses (no reassuring check on a failure)", () => {
    expect(isDoneStatus("failed")).toBe(false);
    expect(isDoneStatus("stalled")).toBe(false);
    expect(isDoneStatus("canceled")).toBe(false);
  });
});

describe("isPhase — phase-id narrowing for the label lookups", () => {
  it("accepts canonical phases", () => {
    expect(isPhase("review")).toBe(true);
  });
  it("rejects unknown / nullish phases", () => {
    expect(isPhase("done")).toBe(false);
    expect(isPhase("remediate")).toBe(false);
    expect(isPhase(null)).toBe(false);
    expect(isPhase(undefined)).toBe(false);
  });
});

describe("phaseColor — early->late spectrum, NEVER the reserved live cyan", () => {
  it("resolves a concrete hex color for every canonical phase", () => {
    for (const p of PHASE_LIST) {
      const c = phaseColor(p);
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
  it("never colors a phase with the reserved live cyan (#5be0ff)", () => {
    for (const p of PHASE_LIST) {
      expect(phaseColor(p).toLowerCase()).not.toBe(LIVE_CYAN);
    }
  });
});

describe("TERMINAL_STATUSES — the no-longer-running set", () => {
  it("includes the canonical terminal statuses", () => {
    for (const s of ["done", "failed", "stalled", "skipped", "signal_corrupt", "superseded", "canceled"]) {
      expect(TERMINAL_STATUSES.has(s)).toBe(true);
    }
  });
  it("does NOT include in-flight statuses", () => {
    expect(TERMINAL_STATUSES.has("active")).toBe(false);
    expect(TERMINAL_STATUSES.has("running")).toBe(false);
  });
});
