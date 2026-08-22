// state-vocabulary.test.mjs — CTL-1871 COORD-41 Phase 5 tests.
import { describe, test, expect } from "bun:test";
import { glossFor, VOCABULARY_TERMS } from "./state-vocabulary.mjs";

describe("VOCABULARY_TERMS", () => {
  test("is a non-empty frozen array of strings", () => {
    expect(Array.isArray(VOCABULARY_TERMS)).toBe(true);
    expect(VOCABULARY_TERMS.length).toBeGreaterThan(0);
    for (const t of VOCABULARY_TERMS) expect(typeof t).toBe("string");
  });

  test("includes the key COORD-41 terms", () => {
    for (const t of ["needs-human", "needs-input", "stalled", "awaiting-work", "reclaim", "revive"]) {
      expect(VOCABULARY_TERMS).toContain(t);
    }
  });

  test("includes all 10 pipeline phases", () => {
    for (const p of ["triage", "research", "plan", "implement", "verify", "review", "pr", "monitor-merge", "monitor-deploy", "teardown"]) {
      expect(VOCABULARY_TERMS).toContain(p);
    }
  });
});

describe("glossFor — known terms", () => {
  test("every VOCABULARY_TERM returns a gloss with all four non-empty required fields", () => {
    for (const term of VOCABULARY_TERMS) {
      const g = glossFor(term);
      expect(typeof g.plainLabel, `${term}.plainLabel`).toBe("string");
      expect(g.plainLabel.trim(), `${term}.plainLabel non-empty`).not.toBe("");
      expect(typeof g.whatsNext, `${term}.whatsNext`).toBe("string");
      expect(g.whatsNext.trim(), `${term}.whatsNext non-empty`).not.toBe("");
      expect(typeof g.who, `${term}.who`).toBe("string");
      expect(g.who.trim(), `${term}.who non-empty`).not.toBe("");
      // COORD-41 load-bearing: every term must have a non-empty ifNobody
      expect(typeof g.ifNobody, `${term}.ifNobody`).toBe("string");
      expect(g.ifNobody.trim(), `${term}.ifNobody non-empty`).not.toBe("");
    }
  });

  test("needs-human and needs-input differ on `who` (the load-bearing distinction)", () => {
    const nh = glossFor("needs-human");
    const ni = glossFor("needs-input");
    expect(nh.who).not.toBe(ni.who);
  });

  test("needs-human.who mentions operator", () => {
    expect(glossFor("needs-human").who.toLowerCase()).toContain("operator");
  });

  test("needs-input.who does NOT mention operator", () => {
    expect(glossFor("needs-input").who.toLowerCase()).not.toContain("operator");
  });

  test("awaiting-work is disambiguated from the CTL-615/702 tombstone yield (plainLabel must mention bounded)", () => {
    const g = glossFor("awaiting-work");
    // The gloss must make clear this is CTL-1854's bounded wait, not a duplicate-worker bow-out.
    expect(g.plainLabel.toLowerCase()).toContain("bounded");
  });

  test("awaiting-work.ifNobody describes deadline expiry, not a redispatch", () => {
    const g = glossFor("awaiting-work");
    expect(g.ifNobody.toLowerCase()).toMatch(/deadline|expires|expired|abandon/);
  });

  test("stalled.ifNobody makes clear no automated retry will occur", () => {
    const g = glossFor("stalled");
    expect(g.ifNobody.toLowerCase()).toMatch(/no.*retry|indefinitely|stays stalled/);
  });
});

describe("glossFor — unknown terms", () => {
  test("returns a safe degraded gloss for an unknown term rather than throwing", () => {
    const g = glossFor("totally-unknown-term-xyz");
    expect(g.plainLabel).toBe("totally-unknown-term-xyz");
    expect(typeof g.whatsNext).toBe("string");
    expect(typeof g.who).toBe("string");
    expect(typeof g.ifNobody).toBe("string");
  });

  test("degraded gloss still has non-empty whatsNext", () => {
    expect(glossFor("__no_such_term__").whatsNext.trim()).not.toBe("");
  });
});

describe("glossFor — term identity round-trip", () => {
  test("returned gloss.term matches the queried term for known terms", () => {
    for (const term of VOCABULARY_TERMS) {
      expect(glossFor(term).term).toBe(term);
    }
  });
});
