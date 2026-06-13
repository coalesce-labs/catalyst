// why-model.ts — CTL-1100 Phase 6: /api/beliefs/why trace model.
// Pure; no DOM dependency.

export interface TraceSource {
  kind: "belief" | "fact";
  table: string;
  id: number;
  summary: string;
  ts_ms: number | null;
}

export interface TraceBelief {
  belief_id: number;
  name: string;
  subject: string;
  value: string | null;
  rule_id: string;
  stratum: number;
  sources: TraceSource[];
}

export interface TraceResult {
  ticket: string;
  tickId: number | null;
  nowMs?: number | null;
  host?: string | null;
  beliefs: TraceBelief[];
}

export function isTraceResult(v: unknown): v is TraceResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.ticket === "string" &&
    Array.isArray(r.beliefs) &&
    ("tickId" in r)
  );
}

export function emptyTrace(ticket = ""): TraceResult {
  return { ticket, tickId: null, beliefs: [] };
}
