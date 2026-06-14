// rulebook-live.ts — CTL-1103 Phase 4: pure selectors for live rule firing
// data derived from BeliefsState. No DOM, no fetches.
import type { BeliefStore } from "./beliefs-model";

// Multi-arm rule logical id mapping: R10a/R10b → R10.
function toLogicalId(rule_id: string): string {
  return rule_id.replace(/^(R\d+)[a-z]$/, "$1");
}

/** Count distinct firing subjects per logical rule_id. */
export function countFiringByRule(store: BeliefStore): Map<string, number> {
  // Multi-arm rules (R10a/R10b) collapse to one logical id and can both fire on
  // the same subject; count distinct subjects per logical rule, not raw frames.
  const subjectsById = new Map<string, Set<string>>();
  for (const frame of store.values()) {
    const id = toLogicalId(frame.rule_id);
    let subjects = subjectsById.get(id);
    if (subjects === undefined) {
      subjects = new Set<string>();
      subjectsById.set(id, subjects);
    }
    subjects.add(frame.subject);
  }
  const counts = new Map<string, number>();
  for (const [id, subjects] of subjectsById) {
    counts.set(id, subjects.size);
  }
  return counts;
}

/** List unique subjects currently satisfying a logical rule. */
export function subjectsForRule(store: BeliefStore, ruleId: string): string[] {
  // Dedup: multi-arm rules (R10a/R10b → R10) can fire on the same subject across
  // arms, which would otherwise yield duplicate React keys in the derivations rail.
  const subjects = new Set<string>();
  for (const frame of store.values()) {
    if (toLogicalId(frame.rule_id) === ruleId) {
      subjects.add(frame.subject);
    }
  }
  return [...subjects];
}
