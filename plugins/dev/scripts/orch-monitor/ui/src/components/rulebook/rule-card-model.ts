// rule-card-model.ts — CTL-1103 Phase 3: pure tab-data helper for RuleCard.
// Exported for tests; imported by rule-card.tsx.
import type { RuleArm, RuleManifestRule } from "../../lib/rulebook-model";

export interface RuleCardTab {
  label: "Plain English" | "Datalog" | "SQL";
  content: string | null;
  isCode: boolean;
  isExtern: boolean;
}

// CTL-1103 remediate: a rule can have multiple arms (e.g. R10 = R10a + R10b),
// each with distinct Datalog/SQL. Reading only arms[0] silently dropped every
// later arm, presenting partial governance logic as complete. Concatenate all
// arms for the field, prefixing each with an `arm_id` comment heading when there
// is more than one arm. A single-arm rule renders exactly that arm's source (no
// heading) so the common case is unchanged. Returns null only when EVERY arm's
// field is null (the extern case for Datalog).
function joinArms(arms: RuleArm[], field: "datalog" | "sql"): string | null {
  const present = arms.filter((a) => a[field] != null);
  if (present.length === 0) return null;
  if (present.length === 1 && arms.length === 1) {
    return present[0][field] as string;
  }
  // Datalog comments start with `//` (Soufflé); SQL comments with `--`.
  const marker = field === "datalog" ? "//" : "--";
  return present
    .map((a) => `${marker} ${a.arm_id}\n${a[field] as string}`)
    .join("\n\n");
}

export function ruleCardTabs(rule: RuleManifestRule): RuleCardTab[] {
  const datalog = joinArms(rule.arms, "datalog");
  const sql = joinArms(rule.arms, "sql");
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
