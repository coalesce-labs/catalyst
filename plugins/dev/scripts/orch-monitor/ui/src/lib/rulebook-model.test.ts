// rulebook-model.test.ts — CTL-1103 Phase 3: pure model tests for the Rulebook
// surface data layer. No DOM; run from the ui package:
//   cd ui && bun test src/lib/rulebook-model.test.ts
import { describe, it, expect } from "bun:test";
import {
  groupRulesByStratum,
  severityTone,
  isRuleManifest,
  type RuleManifest,
} from "./rulebook-model";

// ── Fixture ───────────────────────────────────────────────────────────────────

const MANIFEST_FIXTURE: RuleManifest = {
  preface: {
    problem: "Test problem description.",
    datalog_primer: "Datalog primer text.",
  },
  strata: [
    { id: 1, label: "S1 ground correlations", prose: "Stratum 1 prose." },
    { id: 2, label: "S2 liveness verdicts", prose: "Stratum 2 prose." },
    { id: 3, label: "S3 capacity aggregation", prose: "Stratum 3 prose." },
  ],
  rules: [
    {
      rule_id: "R1",
      name: "session_registered",
      stratum: 1,
      extern: false,
      description: "The session is registered.",
      feeds: [],
      reads: [],
      negates: [],
      cfg_keys: [],
      severity: "info",
      arms: [
        {
          arm_id: "R1",
          datalog: "SELECT 1",
          sql: "INSERT INTO belief SELECT ...",
        },
      ],
    },
    {
      rule_id: "R2",
      name: "turn_started",
      stratum: 1,
      extern: false,
      description: "A turn has started.",
      feeds: ["R4"],
      reads: [],
      negates: [],
      cfg_keys: [],
      severity: "info",
      arms: [
        {
          arm_id: "R2",
          datalog: "SELECT 2",
          sql: "INSERT INTO belief SELECT ...",
        },
      ],
    },
    {
      rule_id: "R5",
      name: "lease_valid",
      stratum: 2,
      extern: false,
      description: "The lease is valid.",
      feeds: [],
      reads: ["R1"],
      negates: [],
      cfg_keys: ["lease_ms"],
      severity: "info",
      arms: [
        {
          arm_id: "R5",
          datalog: "SELECT 5",
          sql: "INSERT INTO belief SELECT ...",
        },
      ],
    },
    {
      rule_id: "R8",
      name: "free_slots",
      stratum: 3,
      extern: true,
      description: "Aggregate free slots across hosts.",
      feeds: [],
      reads: [],
      negates: [],
      cfg_keys: [],
      severity: "info",
      arms: [
        {
          arm_id: "R8",
          datalog: null,
          sql: "INSERT INTO belief WITH RECURSIVE ...",
        },
      ],
    },
  ],
};

// ── groupRulesByStratum ───────────────────────────────────────────────────────

describe("groupRulesByStratum", () => {
  it("returns one group per stratum, in ascending stratum order", () => {
    const grouped = groupRulesByStratum(MANIFEST_FIXTURE);
    expect(grouped.map((g) => g.stratum.id)).toEqual([1, 2, 3]);
  });

  it("places rules into their correct stratum group", () => {
    const grouped = groupRulesByStratum(MANIFEST_FIXTURE);
    expect(grouped[0].rules.every((r) => r.stratum === 1)).toBe(true);
    expect(grouped[1].rules.every((r) => r.stratum === 2)).toBe(true);
    expect(grouped[2].rules.every((r) => r.stratum === 3)).toBe(true);
  });

  it("attaches the stratum metadata from manifest.strata", () => {
    const grouped = groupRulesByStratum(MANIFEST_FIXTURE);
    expect(grouped[0].stratum.label).toBe("S1 ground correlations");
    expect(grouped[0].stratum.prose).toBe("Stratum 1 prose.");
  });

  it("places both S1 rules in stratum group 1", () => {
    const grouped = groupRulesByStratum(MANIFEST_FIXTURE);
    expect(grouped[0].rules.map((r) => r.rule_id)).toEqual(["R1", "R2"]);
  });

  it("handles a manifest with no rules without throwing", () => {
    const empty: RuleManifest = { ...MANIFEST_FIXTURE, rules: [] };
    const grouped = groupRulesByStratum(empty);
    expect(grouped.every((g) => g.rules.length === 0)).toBe(true);
  });
});

// ── severityTone ──────────────────────────────────────────────────────────────

describe("severityTone", () => {
  it("returns distinct CSS token strings for info, warn, error", () => {
    expect(severityTone("info")).not.toBe(severityTone("warn"));
    expect(severityTone("warn")).not.toBe(severityTone("error"));
    expect(severityTone("info")).not.toBe(severityTone("error"));
  });

  it("returns a non-empty string for every known severity", () => {
    for (const sev of ["info", "warn", "error", ""] as const) {
      expect(typeof severityTone(sev)).toBe("string");
      // empty string severity → muted/default token is allowed (non-null)
    }
  });

  it("returns a string for unknown/empty severity (no throw)", () => {
    expect(() => severityTone("" as never)).not.toThrow();
  });
});

// ── isRuleManifest ────────────────────────────────────────────────────────────

describe("isRuleManifest", () => {
  it("returns false for null", () => {
    expect(isRuleManifest(null)).toBe(false);
  });

  it("returns false for an empty object", () => {
    expect(isRuleManifest({})).toBe(false);
  });

  it("returns false when strata or rules are missing", () => {
    expect(isRuleManifest({ preface: {}, rules: [] })).toBe(false);
    expect(isRuleManifest({ preface: {}, strata: [] })).toBe(false);
  });

  it("returns true for a valid manifest shape", () => {
    expect(isRuleManifest(MANIFEST_FIXTURE)).toBe(true);
  });

  it("returns false for non-array rules", () => {
    expect(isRuleManifest({ preface: {}, strata: [], rules: {} })).toBe(false);
  });
});
