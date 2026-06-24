// rule-card.test.ts — CTL-1103 Phase 3: verifies the tab data model that
// RuleCard surfaces. Pure logic; no DOM rendering required.
// Run: cd ui && bun test src/components/rulebook/rule-card.test.ts
import { describe, it, expect } from "bun:test";
import { ruleCardTabs, type RuleCardTab } from "./rule-card-model";
import type { RuleManifestRule } from "../../lib/rulebook-model";

const BASE_RULE: RuleManifestRule = {
  rule_id: "R1",
  name: "session_registered",
  stratum: 1,
  extern: false,
  description: "The session is registered.",
  narrative: "",
  feeds: [],
  reads: [],
  negates: [],
  cfg_keys: [],
  head: { subject: "ticket/phase", value_keys: ["session_id", "short_id"] },
  severity: "info",
  arms: [
    {
      arm_id: "R1",
      datalog: "session_registered :- obs_signal(S), obs_agent(A).",
      sql: "INSERT OR IGNORE INTO belief SELECT ...",
    },
  ],
};

const EXTERN_RULE: RuleManifestRule = {
  ...BASE_RULE,
  rule_id: "R8",
  name: "free_slots",
  extern: true,
  arms: [
    {
      arm_id: "R8",
      datalog: null,
      sql: "INSERT INTO belief WITH RECURSIVE free_slots AS (...) SELECT ...",
    },
  ],
};

describe("ruleCardTabs", () => {
  it("returns exactly three tabs: Plain English, Datalog, SQL", () => {
    const tabs = ruleCardTabs(BASE_RULE);
    const labels = tabs.map((t: RuleCardTab) => t.label);
    expect(labels).toEqual(["Plain English", "Datalog", "SQL"]);
  });

  it("Plain English tab content equals the rule description", () => {
    const tabs = ruleCardTabs(BASE_RULE);
    const english = tabs.find((t: RuleCardTab) => t.label === "Plain English");
    expect(english?.content).toBe(BASE_RULE.description);
    expect(english?.isCode).toBe(false);
  });

  it("SQL tab content equals arms[0].sql", () => {
    const tabs = ruleCardTabs(BASE_RULE);
    const sql = tabs.find((t: RuleCardTab) => t.label === "SQL");
    expect(sql?.content).toBe(BASE_RULE.arms[0].sql);
    expect(sql?.isCode).toBe(true);
  });

  it("Datalog tab content equals arms[0].datalog when present", () => {
    const tabs = ruleCardTabs(BASE_RULE);
    const datalog = tabs.find((t: RuleCardTab) => t.label === "Datalog");
    expect(datalog?.content).toBe(BASE_RULE.arms[0].datalog);
    expect(datalog?.isCode).toBe(true);
  });

  it("Datalog tab is marked extern when datalog is null", () => {
    const tabs = ruleCardTabs(EXTERN_RULE);
    const datalog = tabs.find((t: RuleCardTab) => t.label === "Datalog");
    expect(datalog?.isExtern).toBe(true);
    expect(datalog?.content).toBeNull();
  });

  it("SQL tab is always present even for extern rules", () => {
    const tabs = ruleCardTabs(EXTERN_RULE);
    const sql = tabs.find((t: RuleCardTab) => t.label === "SQL");
    expect(sql?.content).toBe(EXTERN_RULE.arms[0].sql);
  });

  // CTL-1103 remediate: multi-arm rules (e.g. R10 = R10a + R10b) must render
  // EVERY arm, not just arms[0] — previously later arms were silently dropped,
  // presenting partial governance logic as complete.
  const MULTI_ARM_RULE: RuleManifestRule = {
    ...BASE_RULE,
    rule_id: "R10",
    name: "wedged_or_stalled",
    arms: [
      {
        arm_id: "R10a",
        datalog: "wedged :- never_started(T).",
        sql: "INSERT INTO belief SELECT 'wedged' ...",
      },
      {
        arm_id: "R10b",
        datalog: "stalled :- stalled_alive(T).",
        sql: "INSERT INTO belief SELECT 'stalled' ...",
      },
    ],
  };

  it("SQL tab includes every arm for a multi-arm rule", () => {
    const tabs = ruleCardTabs(MULTI_ARM_RULE);
    const sql = tabs.find((t: RuleCardTab) => t.label === "SQL");
    expect(sql?.content).toContain("R10a");
    expect(sql?.content).toContain("R10b");
    expect(sql?.content).toContain(MULTI_ARM_RULE.arms[0].sql as string);
    expect(sql?.content).toContain(MULTI_ARM_RULE.arms[1].sql as string);
  });

  it("Datalog tab includes every arm for a multi-arm rule", () => {
    const tabs = ruleCardTabs(MULTI_ARM_RULE);
    const datalog = tabs.find((t: RuleCardTab) => t.label === "Datalog");
    expect(datalog?.content).toContain("R10a");
    expect(datalog?.content).toContain("R10b");
    expect(datalog?.content).toContain(MULTI_ARM_RULE.arms[0].datalog as string);
    expect(datalog?.content).toContain(MULTI_ARM_RULE.arms[1].datalog as string);
    expect(datalog?.isExtern).toBe(false);
  });

  it("single-arm rules render the arm source verbatim (no heading)", () => {
    const tabs = ruleCardTabs(BASE_RULE);
    const sql = tabs.find((t: RuleCardTab) => t.label === "SQL");
    const datalog = tabs.find((t: RuleCardTab) => t.label === "Datalog");
    // Exactly the arm's content — no `-- arm_id` heading injected.
    expect(sql?.content).toBe(BASE_RULE.arms[0].sql);
    expect(datalog?.content).toBe(BASE_RULE.arms[0].datalog);
  });
});
