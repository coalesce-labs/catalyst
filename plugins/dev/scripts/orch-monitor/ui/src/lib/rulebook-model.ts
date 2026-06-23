// rulebook-model.ts — CTL-1103 Phase 3: types and pure helpers for the
// Rulebook surface. Mirror the /api/beliefs/rules manifest shape.

export interface Preface {
  problem: string;
  datalog_primer: string;
}

export interface RuleArm {
  arm_id: string;
  datalog: string | null;
  sql: string | null;
}

export interface RuleManifestStratum {
  id: number;
  label: string;
  prose: string;
  /** CTL-1320: plain-language layer that LEADS in the UI (the technical `label`/
   *  `prose` are demoted to subtext). Sourced from STRATA_META, so the ladder and
   *  the section headings read one source and the "S{id}" prefix is never doubled. */
  plain_headline: string;
  plain_body: string;
}

export interface RuleManifestRule {
  rule_id: string;
  name: string;
  stratum: number;
  extern: boolean;
  description: string;
  feeds: string[];
  reads: string[];
  negates: string[];
  cfg_keys: string[];
  severity: string;
  arms: RuleArm[];
}

export interface RuleManifest {
  preface: Preface;
  strata: RuleManifestStratum[];
  rules: RuleManifestRule[];
}

export interface StratumGroup {
  stratum: RuleManifestStratum;
  rules: RuleManifestRule[];
}

// ── Type guard ────────────────────────────────────────────────────────────────

export function isRuleManifest(v: unknown): v is RuleManifest {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    Array.isArray(m["strata"]) &&
    Array.isArray(m["rules"]) &&
    m["preface"] != null
  );
}

// ── Grouping ──────────────────────────────────────────────────────────────────

export function groupRulesByStratum(manifest: RuleManifest): StratumGroup[] {
  const byId = new Map<number, RuleManifestRule[]>();
  for (const stratum of manifest.strata) {
    byId.set(stratum.id, []);
  }
  for (const rule of manifest.rules) {
    const bucket = byId.get(rule.stratum);
    if (bucket) bucket.push(rule);
  }
  return manifest.strata
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((stratum) => ({ stratum, rules: byId.get(stratum.id) ?? [] }));
}

// ── Severity tone ─────────────────────────────────────────────────────────────

const SEVERITY_TOKENS: Record<string, string> = {
  error: "text-destructive",
  // CTL-1103 remediate: `text-warning` had no backing --warning/--color-warning
  // token in app.css or the Tailwind theme, so warn-severity labels rendered
  // colorless. Use the amber utility pair (mirrors the info token's blue pair) —
  // a real, resolvable color distinct from error (destructive) and info (blue).
  warn: "text-amber-600 dark:text-amber-400",
  info: "text-blue-600 dark:text-blue-400",
  "": "text-muted-foreground",
};

export function severityTone(severity: string): string {
  return SEVERITY_TOKENS[severity] ?? "text-muted-foreground";
}

// ── Preface guard ─────────────────────────────────────────────────────────────

export function prefaceIsComplete(preface: Preface): boolean {
  if (!preface || typeof preface !== "object") return false;
  return (
    typeof preface.problem === "string" &&
    preface.problem.length > 0 &&
    typeof preface.datalog_primer === "string" &&
    preface.datalog_primer.length > 0
  );
}

// ── Manifest fetch ────────────────────────────────────────────────────────────

export async function fetchRuleManifest(): Promise<RuleManifest> {
  const res = await fetch("/api/beliefs/rules");
  if (!res.ok) throw new Error(`/api/beliefs/rules: ${res.status}`);
  const data: unknown = await res.json();
  if (!isRuleManifest(data)) throw new Error("Unexpected manifest shape");
  return data;
}
