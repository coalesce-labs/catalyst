// rule-card.ts — CTL-1103 Phase 3: pure tab-data helper for RuleCard.
// Exported for tests; imported by rule-card.tsx.
import type { RuleManifestRule } from "../../lib/rulebook-model";

export interface RuleCardTab {
  label: "Plain English" | "Datalog" | "SQL";
  content: string | null;
  isCode: boolean;
  isExtern: boolean;
}

export function ruleCardTabs(rule: RuleManifestRule): RuleCardTab[] {
  const datalog = rule.arms[0]?.datalog ?? null;
  const sql = rule.arms[0]?.sql ?? null;
  return [
    {
      label: "Plain English",
      content: rule.description,
      isCode: false,
      isExtern: false,
    },
    {
      label: "Datalog",
      content: datalog,
      isCode: true,
      isExtern: datalog === null,
    },
    {
      label: "SQL",
      content: sql,
      isCode: true,
      isExtern: false,
    },
  ];
}
