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

/** A single index resolving a relation target to its full rule, keyed by BOTH
 *  the rule's id AND its belief name. `feeds[]` carries rule ids (e.g. "R10")
 *  while `reads[]`/`negates[]` carry belief names (e.g. "lease_valid") — the two
 *  key spaces never collide (ids are `R\d+`, names are snake_case), so one map
 *  resolves every relation kind. Lets the drawer turn a flat relation into a
 *  clickable, hover-previewable link to the target rule. A target that doesn't
 *  resolve (an unknown id, or a raw fact) is simply absent from the map and the
 *  UI renders it as a calm static token. */
export function buildRuleIndex(
  rules: RuleManifestRule[],
): Map<string, RuleManifestRule> {
  const m = new Map<string, RuleManifestRule>();
  for (const r of rules) {
    m.set(r.rule_id, r);
    m.set(r.name, r);
  }
  return m;
}

/** Whether a rule has compiled Datalog source (vs a hand-authored extern SQL
 *  block) — true when any arm carries a non-null `datalog` field. Drives the
 *  "has Datalog" affordance in the Browse list (only the compiled rules show
 *  the real `:-` clause; externs only have SQL). */
export function ruleHasDatalog(rule: RuleManifestRule): boolean {
  return rule.arms.some((arm) => arm.datalog != null);
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

/** A display lane on the board / Browse — a (possibly synthetic) stratum group
 *  plus a stable React key. Structurally a StratumGroup, so the lane/card
 *  components consume it unchanged; the `key` exists because the synthetic split
 *  below means `stratum.id` is no longer unique across lanes. */
export interface DisplayLane extends StratumGroup {
  key: string;
}

/** Reorder the strata into OPERATOR-IMPORTANCE display order (CTL-1328 — Ryan):
 *  a synthetic top "Escalate to a human" lane (the escalate_human belief, lifted
 *  out of S4), then "When it's time to escalate" (the rest of S4), then the
 *  remaining strata in their usual decisions→facts order. Falls back to plain
 *  top-down when S4 / escalate_human is absent. */
export function toDisplayLanes(groups: StratumGroup[]): DisplayLane[] {
  const topDown = strataTopDown(groups);
  const s4 = topDown.find((g) => g.stratum.id === 4);
  const escalate = s4?.rules.find((r) => r.name === "escalate_human");
  const lanes: DisplayLane[] = [];

  if (s4 && escalate) {
    lanes.push({
      key: "escalate-human",
      stratum: {
        ...s4.stratum,
        plain_headline: "Escalate to a human",
        plain_body:
          "The top of the ladder — the automated fixes have been tried and failed, so the engine raises a hand for a person.",
      },
      rules: [escalate],
    });
    lanes.push({
      key: "s4",
      stratum: {
        ...s4.stratum,
        plain_headline: "When it's time to escalate",
        plain_body:
          "The cheaper automated moves first — wake a diagnostician, then judge whether that worked.",
      },
      rules: s4.rules.filter((r) => r.name !== "escalate_human"),
    });
  }

  for (const g of topDown) {
    if (s4 && escalate && g.stratum.id === 4) continue; // split out above
    lanes.push({ key: `s${g.stratum.id}`, stratum: g.stratum, rules: g.rules });
  }
  return lanes;
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
