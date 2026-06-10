// finops-breakdowns.ts — PURE data-shaping for the OBS-11 FINOPS breakdown panels.
// DOM-/React-free so every numeric decision (the mandatory zero-filter, the ranked
// rows, the 4-bucket token split, the concentration share, the worst-drift pick)
// unit-tests directly under the ui package's `bun test` — the same discipline
// finops-panels.ts / telemetry-panels.ts follow. The panel components are skin only.
//
// FinOps's soul is HONESTY (design §2):
//   - ZERO-SERIES FILTER is mandatory on every cost map. /api/otel/cost returns many
//     increase()==0 series in-window; a ranked/least-expensive view without a > 0
//     filter renders all-zeros garbage. We re-filter here belt-and-braces even though
//     the server already filters at the query layer.
//   - NEVER collapse cache tokens into "input". input / output / cacheRead /
//     cacheCreation are ALWAYS four separate buckets (collapsing over-reports 35-50%).
//   - DEGRADE honestly: an empty map is an empty array (the ChartCard renders the
//     honest empty state), never a fabricated row.

import type { CostValidationRow } from "@/lib/types";

// ── ranked cost rows (P-C expensive tickets, P-B by-stage, P-D by-model/agent) ──

/** One ranked breakdown row: the label (ticket / stage / model / agent) and its
 *  USD spend. Rows are always zero-filtered + descending. */
export interface CostRow {
  /** The category label: linear_key, task_type, model, or agent_name. */
  label: string;
  /** The category's spend over the window, USD (> 0 — zero rows are dropped). */
  usd: number;
}

/** Rank a label→USD cost map into descending rows with the MANDATORY zero-series
 *  filter applied (drop value <= 0, and any non-finite). PURE — a null/empty map is
 *  an empty array (the ChartCard renders the honest empty state, never a fabricated
 *  row). This is the single choke point every cost breakdown flows through, so the
 *  zero-filter can never be forgotten by a panel. */
export function rankCostMap(map: Record<string, number> | null): CostRow[] {
  if (!map) return [];
  return Object.entries(map)
    .filter(([, usd]) => Number.isFinite(usd) && usd > 0)
    .map(([label, usd]) => ({ label, usd }))
    .sort((a, b) => b.usd - a.usd);
}

/** The largest USD in a ranked row set (for the bar scale). 0 for an empty set —
 *  barPercent then renders empty bars, never a divide-by-zero. PURE. */
export function maxUsd(rows: CostRow[]): number {
  return rows.reduce((m, r) => (r.usd > m ? r.usd : m), 0);
}

/** Sum the USD across ranked rows (the breakdown total). PURE. */
export function totalUsd(rows: CostRow[]): number {
  return rows.reduce((s, r) => s + r.usd, 0);
}

// ── P-D by-model / by-agent toggle ──────────────────────────────────────────────

/** The P-D grouping axis: native Prometheus cost labels. `model` is the model mix
 *  (which model costs most); `agent` is `agent_name` (workflow-subagent vs
 *  general-purpose vs … — the closest real "what machinery costs most" signal,
 *  design §3.3 #9b). Both are RANKED BARS, never pies (Principle 9: model/agent
 *  counts are unbounded + rankable → bar-horizontal, not a part-of-whole pie). */
export type CostDimension = "model" | "agent";

// ── P-E token-type split (the 4-bucket donut) ───────────────────────────────────

/** The four FIXED token buckets, in display order. They are NEVER collapsed — the
 *  donut always shows all four (input/output/cacheRead/cacheCreation), each its own
 *  --chart-N category. Collapsing cache into input over-reports cost 35-50%. */
export const TOKEN_BUCKETS = [
  "input",
  "output",
  "cacheRead",
  "cacheCreation",
] as const;

export type TokenBucket = (typeof TOKEN_BUCKETS)[number];

/** One token-bucket slice for the P-E donut: the bucket name, its token count, and
 *  its share of the 4-bucket total (0..1). share is 0 when the total is 0 (no
 *  divide-by-zero); a bucket absent from the source map is shown as 0 (never
 *  dropped — the donut always has four slices so the part-of-whole is honest). */
export interface TokenSlice {
  bucket: TokenBucket;
  tokens: number;
  /** Fraction of the 4-bucket total (0..1). */
  share: number;
}

/** Shape a `type → tokens` map (from /api/otel/tokens) into the four fixed donut
 *  slices, in TOKEN_BUCKETS order, with each slice's share of the total. PURE.
 *  A null/empty map yields four zero slices (the ChartCard's hasData gate then
 *  renders the empty state — we still never collapse or drop a bucket). The
 *  cacheRead bucket is enormous live (~99% of tokens) — that is the whole point of
 *  the cache-ROI story and must NOT be folded into input. */
export function toTokenSlices(map: Record<string, number> | null): TokenSlice[] {
  const tokensOf = (b: TokenBucket): number => {
    const v = map?.[b];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  };
  const counts = TOKEN_BUCKETS.map(tokensOf);
  const total = counts.reduce((s, n) => s + n, 0);
  return TOKEN_BUCKETS.map((bucket, i) => ({
    bucket,
    tokens: counts[i]!,
    share: total > 0 ? counts[i]! / total : 0,
  }));
}

/** Whether a token map carries ANY positive bucket (the P-E hasData gate). A null
 *  map or an all-zero map is "no data" → the ChartCard empty state. PURE. */
export function hasTokenData(map: Record<string, number> | null): boolean {
  return toTokenSlices(map).some((s) => s.tokens > 0);
}

/** Compact a token count: 1_326_434_860 → "1.3B", 50_556_358 → "50.6M",
 *  6_698_817 → "6.7M", 9_259 → "9.3k". A non-finite input → "0". PURE. */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** A human bucket label for the donut legend / center copy. PURE. */
export function tokenBucketLabel(bucket: TokenBucket): string {
  switch (bucket) {
    case "input":
      return "input";
    case "output":
      return "output";
    case "cacheRead":
      return "cache read";
    case "cacheCreation":
      return "cache write";
  }
}

/** Format a cache hit rate (0..1) as a one-decimal percent for the donut center,
 *  e.g. "99.5%". null → "—" (no rate to show — honest, never a fabricated 0%).
 *  PURE. */
export function formatHitRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

// ── footer A4: concentration ("top 3 tickets = N% of spend") ────────────────────

/** The concentration read-out: the top-N share of total spend + the N actually
 *  counted (so the copy is honest when fewer than N tickets exist). */
export interface Concentration {
  /** How many top tickets the share covers (≤ topN, ≤ the live ticket count). */
  count: number;
  /** The topN tickets' share of total spend, 0..1. 0 when there is no spend. */
  share: number;
  /** Total spend across all ranked tickets, USD. */
  totalUsd: number;
}

/** Compute the top-N concentration share over ranked cost rows. PURE. The rows MUST
 *  already be zero-filtered + descending (rankCostMap). An empty set → 0 share over
 *  0 count (the footer shows "—", never a fabricated number). Defaults to the top 3
 *  (design §3.3 footer A4: "top 3 tickets = 61% of spend"). */
export function concentration(rows: CostRow[], topN = 3): Concentration {
  const total = totalUsd(rows);
  if (total <= 0 || rows.length === 0) {
    return { count: 0, share: 0, totalUsd: 0 };
  }
  const top = rows.slice(0, topN);
  const topSum = totalUsd(top);
  return { count: top.length, share: topSum / total, totalUsd: total };
}

// ── footer A8: cost-validation drift ────────────────────────────────────────────

/** The worst (largest-absolute) signal-vs-OTEL discrepancy, the A8 data-trust
 *  footer number. The rows are /api/otel/cost-validation entries; we pick the max
 *  |discrepancy| so the footer surfaces the single worst measurement disagreement.
 *  PURE. null when there are no rows (the footer shows "—", never a fabricated $0
 *  that would falsely claim perfect agreement). */
export function worstDrift(
  rows: CostValidationRow[] | null,
): CostValidationRow | null {
  if (!rows || rows.length === 0) return null;
  let worst: CostValidationRow | null = null;
  for (const row of rows) {
    if (!Number.isFinite(row.discrepancy)) continue;
    if (worst === null || row.discrepancy > worst.discrepancy) worst = row;
  }
  return worst;
}
