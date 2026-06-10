// worker-now-data.ts — PURE logic for the worker-detail v2 "Now" view and the
// cost+tokens-over-time chart (CTL-925 / WORKER-DETAIL v2 Pass A). React-/DOM-free
// on purpose (the same discipline as worker-burn-data.ts / live-tail-data.ts), so
// the Now-headline formatting and the burn chart's series shaping unit-test
// directly under `bun test` without an SSE connection or a chart render.
//
// The Now view replaces the garbled /api/ec-worker-screen raw terminal (its ANSI
// is stripped, so spatially-placed text collapses to 1-char lines). It is built
// ENTIRELY from the typed live transcript stream (StreamEvent) the existing
// useLiveTail hook already parses — the latest tool/turn/reasoning/result event is
// summarized as a readable headline, never a corrupted screen. Every derived value
// is a field off a RECEIVED row or an honest null — NEVER fabricated.

import type { StreamEvent } from "@/lib/types";
import type { SparklinePoint, WorkerBurnSeries } from "./worker-burn-data";

// ── the "Now" headline (the current/most-recent action) ──────────────────────
// design §3A: the latest StreamEvent rendered large and readable. tool_start →
// "▶ <tool> · <short arg>"; reasoning → "◌ thinking…"; turn → "↻ new turn ·
// <tools>"; result → "✓ complete". An empty buffer yields a `kind:"none"` headline
// so the skin renders an honest connecting/unavailable line (never a fake action).

export type NowHeadlineKind =
  | "tool"
  | "thinking"
  | "turn"
  | "result"
  | "retry"
  | "rate_limit"
  | "text"
  | "none";

export interface NowHeadline {
  kind: NowHeadlineKind;
  /** The glyph the skin leads with (▶ / ◌ / ↻ / ✓ / ⚠). */
  glyph: string;
  /** The primary label (e.g. the tool name, "thinking…", "new turn"). */
  label: string;
  /** A short secondary detail (the truncated tool arg, the joined turn tools), or
   *  null when the event carries none. */
  detail: string | null;
  /** The epoch-ms timestamp of the source event, or null for the empty headline. */
  ts: number | null;
}

/** Max characters of a tool argument shown in the Now headline (design §3A ~80). */
export const NOW_ARG_MAX = 80;

/** Collapse a tool argument to a single readable line, trimmed to `max` chars with
 *  an ellipsis. Newlines/tabs collapse to single spaces so a multi-line Bash
 *  heredoc reads as one line (never the garbled terminal we are replacing). */
export function shortenArg(arg: string | null | undefined, max: number = NOW_ARG_MAX): string | null {
  if (arg == null) return null;
  const oneLine = arg.replace(/\s+/g, " ").trim();
  if (oneLine === "") return null;
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** The newest event in a live buffer, or null when empty. The buffer is appended
 *  oldest→newest (appendLiveRows), so the last element is the most recent. */
export function latestEvent(buffer: StreamEvent[]): StreamEvent | null {
  return buffer.length > 0 ? buffer[buffer.length - 1] : null;
}

/**
 * Derive the "Now" headline from the live buffer's most-recent event. An empty
 * buffer yields the `none` headline (the skin shows connecting/unavailable, never
 * a fabricated action). Each event type maps to its readable glyph + label so the
 * operator sees WHAT the worker is doing, not a corrupted screen.
 */
export function deriveNowHeadline(buffer: StreamEvent[]): NowHeadline {
  const ev = latestEvent(buffer);
  if (!ev) {
    return { kind: "none", glyph: "", label: "", detail: null, ts: null };
  }
  switch (ev.type) {
    case "tool_start":
      return {
        kind: "tool",
        glyph: "▶",
        label: ev.tool ?? "tool",
        detail: shortenArg(ev.toolInput),
        ts: ev.ts,
      };
    case "reasoning":
      return {
        kind: "thinking",
        glyph: "◌",
        label: "thinking…",
        detail: shortenArg(ev.text),
        ts: ev.ts,
      };
    case "turn":
      return {
        kind: "turn",
        glyph: "↻",
        label: "new turn",
        detail:
          ev.turnTools && ev.turnTools.length > 0
            ? ev.turnTools.join(", ")
            : shortenArg(ev.text),
        ts: ev.ts,
      };
    case "result":
      return { kind: "result", glyph: "✓", label: "complete", detail: null, ts: ev.ts };
    case "retry":
      return {
        kind: "retry",
        glyph: "⚠",
        label: `retry ${ev.retryInfo?.attempt ?? "?"}/${ev.retryInfo?.maxRetries ?? "?"}`,
        detail: shortenArg(ev.retryInfo?.error),
        ts: ev.ts,
      };
    case "rate_limit":
      return { kind: "rate_limit", glyph: "⚠", label: "rate limited", detail: null, ts: ev.ts };
    case "text":
      return {
        kind: "text",
        glyph: "·",
        label: shortenArg(ev.text) ?? "…",
        detail: null,
        ts: ev.ts,
      };
    default:
      // tool_end / init carry no operator-meaningful headline; fall back to the
      // most-recent tool the buffer holds rather than a bare type name.
      return { kind: "none", glyph: "", label: "", detail: null, ts: ev.ts };
  }
}

// ── cost + tokens over-time chart shaping ────────────────────────────────────
// design §5A: a real time-series chart from the burn series' cost + tokens
// SparklinePoint[] (NOT the scalar tiles). Each point is [epochSeconds, value];
// we zip the two series on their shared bucket timestamps into one chart row so a
// dual-axis recharts LineChart can plot cost ($) and tokens on aligned X buckets.

export interface BurnChartPoint {
  /** Epoch SECONDS (the bucket key — the burn series' native unit). */
  t: number;
  /** HH:MM label for the X axis (local time). */
  label: string;
  /** Cost in USD at this bucket, or null when the cost series has no point here. */
  cost: number | null;
  /** Tokens at this bucket, or null when the tokens series has no point here. */
  tokens: number | null;
}

/** Format an epoch-SECOND bucket as a local HH:MM label for the chart X axis. */
export function fmtBucketLabel(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

/**
 * Zip the cost + tokens SparklinePoint series into aligned chart rows keyed on
 * their shared bucket timestamps. The burn endpoint returns both series on the
 * SAME query_range grid, so the timestamps line up; we union the timestamps
 * defensively (a bucket present in only one series gets null for the other) so a
 * ragged series never drops a point or fabricates a value. Rows are sorted by t.
 */
export function buildBurnChartData(
  series: WorkerBurnSeries | null,
): BurnChartPoint[] {
  if (!series) return [];
  const costByT = new Map<number, number>();
  const tokensByT = new Map<number, number>();
  for (const [t, v] of series.cost ?? []) {
    if (Number.isFinite(t) && Number.isFinite(v)) costByT.set(t, v);
  }
  for (const [t, v] of series.tokens ?? []) {
    if (Number.isFinite(t) && Number.isFinite(v)) tokensByT.set(t, v);
  }
  const ts = new Set<number>([...costByT.keys(), ...tokensByT.keys()]);
  const rows: BurnChartPoint[] = [];
  for (const t of [...ts].sort((a, b) => a - b)) {
    rows.push({
      t,
      label: fmtBucketLabel(t),
      cost: costByT.has(t) ? (costByT.get(t) as number) : null,
      tokens: tokensByT.has(t) ? (tokensByT.get(t) as number) : null,
    });
  }
  return rows;
}

/** Whether a burn series carries any positive cost OR tokens point — drives the
 *  ChartCard `hasData` flag so a flat/empty series degrades to the honest "no data
 *  in range" state rather than an empty chart. */
export function burnSeriesHasData(series: WorkerBurnSeries | null): boolean {
  if (!series) return false;
  const positive = (pts: SparklinePoint[] | undefined): boolean =>
    (pts ?? []).some(([, v]) => Number.isFinite(v) && v > 0);
  return positive(series.cost) || positive(series.tokens);
}
