// source-target.ts — CTL-1100 Phase 6: resolve rule/edge source info for SourceSheet.
// Pure; no DOM dependency.

export interface RuleEntry {
  rule_id: string;
  name?: string;
  guardText?: string | null;
  datalog?: string | null;
  sql?: string | null;
}

export interface RuleManifest {
  rules: RuleEntry[];
  strata?: unknown[];
}

export interface EdgeEntry {
  from: string;
  to: string;
  kind?: string;
  guardText?: string | null;
  datalog?: string | null;
  sourceRef?: string | null;
  classification?: string;
}

export interface FsmDescriptorLike {
  transitions: EdgeEntry[];
}

export type SourceTarget =
  | { kind: "rule"; rule_id: string }
  | { kind: "edge"; from: string; to: string };

export interface SourceInfo {
  guardText: string | null;
  datalog: string | null;
  sql: string | null;
  sourceRef: string | null;
}

/** Resolve source info for a rule by rule_id. Returns null when not found. */
export function resolveRuleSource(manifest: RuleManifest, target: SourceTarget & { kind: "rule" }): SourceInfo | null {
  const rule = manifest.rules.find((r) => r.rule_id === target.rule_id);
  if (!rule) return null;
  return {
    guardText: rule.guardText ?? null,
    datalog: rule.datalog ?? null,
    sql: rule.sql ?? null,
    sourceRef: null, // rules have no sourceRef
  };
}

/** Resolve source info for an FSM edge by from→to. Returns empty info when not found (never throws). */
export function resolveEdgeSource(descriptor: FsmDescriptorLike, target: SourceTarget & { kind: "edge" }): SourceInfo {
  const edge = descriptor.transitions.find(
    (t) => t.from === target.from && t.to === target.to,
  );
  return {
    guardText: edge?.guardText ?? null,
    datalog: edge?.datalog ?? null,
    sql: null, // edges have no SQL
    sourceRef: edge?.sourceRef ?? null,
  };
}
