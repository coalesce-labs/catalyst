// rulebook-live.ts — CTL-1103 Phase 4: pure selectors for live rule firing
// data derived from BeliefsState. No DOM, no fetches.
import type { BeliefStore } from "./beliefs-model";

// Multi-arm rule logical id mapping: R10a/R10b → R10.
function toLogicalId(rule_id: string): string {
  return rule_id.replace(/^(R\d+)[a-z]$/, "$1");
}

/** Count distinct firing subjects per logical rule_id. */
export function countFiringByRule(store: BeliefStore): Map<string, number> {
  const counts = new Map<string, number>();
  for (const frame of store.values()) {
    const id = toLogicalId(frame.rule_id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** List unique subjects currently satisfying a logical rule. */
export function subjectsForRule(store: BeliefStore, ruleId: string): string[] {
  const subjects: string[] = [];
  for (const frame of store.values()) {
    if (toLogicalId(frame.rule_id) === ruleId) {
      subjects.push(frame.subject);
    }
  }
  return subjects;
}
