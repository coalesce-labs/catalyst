// rulebook-board-model.ts — CTL-1328: pure helpers for the swim-lane Rulebook
// board. No DOM, no fetches — exported for unit tests and imported by the lane,
// card, and drawer components so the data shaping has a single tested source.
import type {
  RuleManifestRule,
  RuleManifestStratum,
  StratumGroup,
} from "./rulebook-model";

/** Map rule_id → human rule name. `feeds[]` carries rule ids (e.g. "R10") while
 *  `reads[]`/`negates[]` already carry names — this resolves the former. */
export function buildNameById(rules: RuleManifestRule[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rules) m.set(r.rule_id, r.name);
  return m;
}

/** Resolve a rule's `feeds[]` (rule ids) to display names, falling back to the
 *  raw id when a target is unknown (never drops a relation silently). */
export function feedNames(
  rule: RuleManifestRule,
  nameById: Map<string, string>,
): string[] {
  return rule.feeds.map((id) => nameById.get(id) ?? id);
}

/** Split a rule's upstream dependencies into the ones it merely reads and the
 *  ones it negates. `negates[]` is (per the manifest) a subset of the names a
 *  rule depends on; keeping them in their own bucket lets the UI be honest about
 *  within-layer negation (e.g. S2 `lease_expired` negates S2 `lease_valid`)
 *  without printing the same name twice. */
export function splitReads(rule: RuleManifestRule): {
  reads: string[];
  negates: string[];
} {
  const negatesSet = new Set(rule.negates);
  return {
    reads: rule.reads.filter((n) => !negatesSet.has(n)),
    negates: rule.negates.slice(),
  };
}

/** The board renders S6 (decisions) at the top down to S1 (raw facts) at the
 *  bottom — the layer-cake orientation — so a fresh copy sorted by descending
 *  stratum id. `groupRulesByStratum` already preserves each lane's evaluation
 *  order internally; this only flips the lane stacking. */
export function strataTopDown(groups: StratumGroup[]): StratumGroup[] {
  return [...groups].sort((a, b) => b.stratum.id - a.stratum.id);
}

/** "S1 ground correlations" → "Ground correlations": strip the redundant
 *  number prefix (the lane already renders the number once, on its dot) and
 *  capitalize so the technical label reads as a subtitle. */
export function techLabel(label: string): string {
  const stripped = label.replace(/^S\d+\s+/, "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** First clause of the technical prose — a short implementation hint. */
export function techHint(prose: string): string {
  return prose.split(/[;.]/)[0]?.trim() ?? "";
}

/** The lane's muted technical subtext, e.g.
 *  "Ground correlations · Read obs_* EDB only · 4 rules". */
export function laneSubtext(
  stratum: RuleManifestStratum,
  ruleCount: number,
): string {
  return [
    techLabel(stratum.label),
    techHint(stratum.prose),
    `${ruleCount} rule${ruleCount === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
