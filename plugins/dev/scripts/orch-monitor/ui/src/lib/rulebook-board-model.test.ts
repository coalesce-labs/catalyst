// rulebook-board-model.test.ts — CTL-1328: pins the pure shaping helpers behind
// the swim-lane board. Run: cd ui && bun test src/lib/rulebook-board-model.test.ts
import { describe, it, expect } from "bun:test";
import {
  buildNameById,
  buildRuleIndex,
  ruleHasDatalog,
  feedNames,
  splitReads,
  strataTopDown,
  toDisplayLanes,
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
    narrative: "",
    feeds: [],
    reads: [],
    negates: [],
    cfg_keys: [],
    head: { subject: "ticket/phase", value_keys: [] },
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

describe("buildRuleIndex", () => {
  const rules = [
    rule({ rule_id: "R5", name: "lease_valid", stratum: 2 }),
    rule({ rule_id: "R6", name: "lease_expired", stratum: 2 }),
    rule({ rule_id: "R10", name: "wake_diagnostician", stratum: 4 }),
  ];
  const index = buildRuleIndex(rules);

  it("resolves a feeds[] rule id to its full rule", () => {
    // feeds carry rule ids
    expect(index.get("R10")?.name).toBe("wake_diagnostician");
  });

  it("resolves a reads[]/negates[] belief name to its full rule", () => {
    // reads/negates carry belief names
    expect(index.get("lease_valid")?.rule_id).toBe("R5");
    expect(index.get("lease_valid")?.stratum).toBe(2);
  });

  it("returns undefined for an unresolved target (raw fact / unknown id)", () => {
    expect(index.get("obs_session_registered")).toBeUndefined();
    expect(index.get("R99")).toBeUndefined();
  });
});

describe("ruleHasDatalog", () => {
  it("is true when an arm has datalog (a compiled rule)", () => {
    const r = rule({ arms: [{ arm_id: "R5", datalog: "lease_valid(t) :- ...", sql: "INSERT ..." }] });
    expect(ruleHasDatalog(r)).toBe(true);
  });

  it("is false when every arm is datalog-less (a hand-authored extern)", () => {
    const r = rule({ arms: [{ arm_id: "R13", datalog: null, sql: "WITH RECURSIVE ..." }] });
    expect(ruleHasDatalog(r)).toBe(false);
  });

  it("is false when there are no arms", () => {
    expect(ruleHasDatalog(rule({ arms: [] }))).toBe(false);
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

describe("toDisplayLanes", () => {
  const groups: StratumGroup[] = [
    {
      stratum: stratum({ id: 6 }),
      rules: [rule({ rule_id: "R16", name: "advance_to", stratum: 6 })],
    },
    {
      stratum: stratum({ id: 4 }),
      rules: [
        rule({ rule_id: "R10", name: "wake_diagnostician", stratum: 4 }),
        rule({ rule_id: "R12", name: "escalate_human", stratum: 4 }),
      ],
    },
    {
      stratum: stratum({ id: 1 }),
      rules: [rule({ rule_id: "R1", name: "session_registered", stratum: 1 })],
    },
  ];
  const lanes = toDisplayLanes(groups);

  it("lifts escalate_human into a synthetic top lane, then the rest of S4", () => {
    expect(lanes[0]?.key).toBe("escalate-human");
    expect(lanes[0]?.stratum.plain_headline).toBe("Escalate to a human");
    expect(lanes[0]?.rules.map((r) => r.name)).toEqual(["escalate_human"]);
    expect(lanes[1]?.key).toBe("s4");
    expect(lanes[1]?.stratum.plain_headline).toBe("When it's time to escalate");
    expect(lanes[1]?.rules.map((r) => r.name)).toEqual(["wake_diagnostician"]);
  });

  it("renders the remaining strata after, in decisions→facts order", () => {
    expect(lanes.slice(2).map((l) => l.key)).toEqual(["s6", "s1"]);
  });

  it("gives every lane a unique key", () => {
    const keys = lanes.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("falls back to plain top-down when S4 has no escalate_human", () => {
    const noEsc: StratumGroup[] = [
      { stratum: stratum({ id: 2 }), rules: [rule({ stratum: 2 })] },
      { stratum: stratum({ id: 1 }), rules: [rule({ stratum: 1 })] },
    ];
    expect(toDisplayLanes(noEsc).map((l) => l.key)).toEqual(["s2", "s1"]);
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
