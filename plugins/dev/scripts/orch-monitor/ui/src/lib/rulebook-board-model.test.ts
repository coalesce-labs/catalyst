// rulebook-board-model.test.ts — CTL-1328: pins the pure shaping helpers behind
// the swim-lane board. Run: cd ui && bun test src/lib/rulebook-board-model.test.ts
import { describe, it, expect } from "bun:test";
import {
  buildNameById,
  feedNames,
  splitReads,
  strataTopDown,
  techLabel,
  techHint,
  laneSubtext,
} from "./rulebook-board-model";
import type {
  RuleManifestRule,
  RuleManifestStratum,
  StratumGroup,
} from "./rulebook-model";

function rule(p: Partial<RuleManifestRule>): RuleManifestRule {
  return {
    rule_id: "R1",
    name: "session_registered",
    stratum: 1,
    extern: false,
    description: "desc",
    feeds: [],
    reads: [],
    negates: [],
    cfg_keys: [],
    severity: "info",
    arms: [],
    ...p,
  };
}

function stratum(p: Partial<RuleManifestStratum>): RuleManifestStratum {
  return {
    id: 1,
    label: "S1 ground correlations",
    prose: "Read obs_* EDB only; establish correlations.",
    plain_headline: "What we directly observe to be true",
    plain_body: "The ground floor.",
    ...p,
  };
}

describe("buildNameById", () => {
  it("maps each rule_id to its name", () => {
    const m = buildNameById([
      rule({ rule_id: "R1", name: "session_registered" }),
      rule({ rule_id: "R10", name: "wake_diagnostician" }),
    ]);
    expect(m.get("R1")).toBe("session_registered");
    expect(m.get("R10")).toBe("wake_diagnostician");
  });
});

describe("feedNames", () => {
  const nameById = buildNameById([
    rule({ rule_id: "R10", name: "wake_diagnostician" }),
  ]);

  it("resolves feed ids to names", () => {
    expect(feedNames(rule({ feeds: ["R10"] }), nameById)).toEqual([
      "wake_diagnostician",
    ]);
  });

  it("falls back to the raw id when the target is unknown", () => {
    expect(feedNames(rule({ feeds: ["R99"] }), nameById)).toEqual(["R99"]);
  });
});

describe("splitReads", () => {
  it("separates pure reads from negated reads (no duplication)", () => {
    // R6 lease_expired: reads lease_valid + worker_dead, negates both.
    const r = rule({
      reads: ["lease_valid", "worker_dead"],
      negates: ["lease_valid", "worker_dead"],
    });
    const { reads, negates } = splitReads(r);
    expect(reads).toEqual([]);
    expect(negates).toEqual(["lease_valid", "worker_dead"]);
  });

  it("keeps a read that is not negated in the reads bucket", () => {
    // R4 reads session_registered/turn_started/worker_dead, negates only the
    // latter two — session_registered stays a pure read.
    const r = rule({
      reads: ["session_registered", "turn_started", "worker_dead"],
      negates: ["turn_started", "worker_dead"],
    });
    const { reads, negates } = splitReads(r);
    expect(reads).toEqual(["session_registered"]);
    expect(negates).toEqual(["turn_started", "worker_dead"]);
  });
});

describe("strataTopDown", () => {
  it("orders lanes S6→S1 (decisions on top, raw facts at the bottom)", () => {
    const groups: StratumGroup[] = [1, 2, 3, 4, 5, 6].map((id) => ({
      stratum: stratum({ id }),
      rules: [],
    }));
    expect(strataTopDown(groups).map((g) => g.stratum.id)).toEqual([
      6, 5, 4, 3, 2, 1,
    ]);
  });

  it("does not mutate the input array", () => {
    const groups: StratumGroup[] = [1, 2].map((id) => ({
      stratum: stratum({ id }),
      rules: [],
    }));
    strataTopDown(groups);
    expect(groups.map((g) => g.stratum.id)).toEqual([1, 2]);
  });
});

describe("techLabel", () => {
  it("strips the redundant S-number prefix and capitalizes", () => {
    expect(techLabel("S1 ground correlations")).toBe("Ground correlations");
    expect(techLabel("S2 liveness verdicts")).toBe("Liveness verdicts");
  });
});

describe("techHint", () => {
  it("returns the first clause of the technical prose", () => {
    expect(
      techHint("Read obs_* EDB only; establish correlations."),
    ).toBe("Read obs_* EDB only");
  });
});

describe("laneSubtext", () => {
  it("joins label · hint · rule count", () => {
    expect(laneSubtext(stratum({}), 4)).toBe(
      "Ground correlations · Read obs_* EDB only · 4 rules",
    );
  });

  it("singularizes a one-rule lane", () => {
    expect(laneSubtext(stratum({ id: 3 }), 1)).toContain("· 1 rule");
    expect(laneSubtext(stratum({ id: 3 }), 1)).not.toContain("1 rules");
  });
});
