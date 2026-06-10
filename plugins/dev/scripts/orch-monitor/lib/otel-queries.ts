import type { PrometheusFetcher, PrometheusMetricValue } from "./prometheus";
import type { LokiFetcher, LokiStreamValue } from "./loki";

const DURATION_RE = /^\d+(ms|s|m|h|d)$/;

export function safeDuration(s: string, fallback: string): string {
  return DURATION_RE.test(s) ? s : fallback;
}

function extractVectorMap(
  result: { data: { result: PrometheusMetricValue[] } },
  labelKey: string,
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const entry of result.data.result) {
    const key = entry.metric[labelKey];
    if (!key) continue;
    const val = entry.value ? parseFloat(entry.value[1]) : 0;
    if (Number.isFinite(val)) map[key] = val;
  }
  return map;
}

export async function costByTicket(
  prom: PrometheusFetcher,
  range: string,
): Promise<Record<string, number> | null> {
  const r = safeDuration(range, "1h");
  const result = await prom.query(
    `sum by (linear_key) (increase(claude_code_cost_usage_USD_total{linear_key=~".+"}[${r}]))`,
  );
  if (!result) return null;
  return extractVectorMap(result, "linear_key");
}

export async function tokensByType(
  prom: PrometheusFetcher,
  range: string,
): Promise<Record<string, number> | null> {
  const r = safeDuration(range, "1h");
  const result = await prom.query(
    `sum by (type) (increase(claude_code_token_usage_tokens_total[${r}]))`,
  );
  if (!result) return null;
  return extractVectorMap(result, "type");
}

export async function cacheHitRate(
  prom: PrometheusFetcher,
  range: string,
): Promise<number | null> {
  const tokens = await tokensByType(prom, range);
  if (tokens === null) return null;
  const cacheRead = tokens["cacheRead"] ?? 0;
  const input = tokens["input"] ?? 0;
  const total = cacheRead + input;
  if (total === 0) return 0;
  return cacheRead / total;
}

export async function costRateByModel(
  prom: PrometheusFetcher,
  interval: string,
): Promise<Record<string, number> | null> {
  const iv = safeDuration(interval, "5m");
  const result = await prom.query(
    `sum by (model) (rate(claude_code_cost_usage_USD_total[${iv}]))`,
  );
  if (!result) return null;
  return extractVectorMap(result, "model");
}

// CTL-495: cost slice by `task.type` resource attribute (Prom label `task_type`
// — the OTEL SDK converts `.` to `_` on ingest). The selector excludes legacy
// series produced before any launcher set `task.type`, matching the shape of
// costByTicket's linear_key=~".+" guard.
export async function costByTaskType(
  prom: PrometheusFetcher,
  range: string,
): Promise<Record<string, number> | null> {
  const r = safeDuration(range, "1h");
  const result = await prom.query(
    `sum by (task_type) (increase(claude_code_cost_usage_USD_total{task_type=~".+"}[${r}]))`,
  );
  if (!result) return null;
  return extractVectorMap(result, "task_type");
}

export async function toolUsageByName(
  loki: LokiFetcher,
  range: string,
): Promise<Record<string, number> | null> {
  const r = safeDuration(range, "1h");
  const now = new Date();
  const start = new Date(now.getTime() - parseDuration(r));
  const result = await loki.queryRange(
    `sum by (tool_name) (count_over_time({service_name=~"claude-code.*"} |= "claude_code.tool_result" [${r}]))`,
    start.toISOString(),
    now.toISOString(),
  );
  if (!result) return null;
  const map: Record<string, number> = {};
  for (const entry of result.data.result) {
    const metric = entry as { metric?: Record<string, string>; values?: Array<[number, string]> };
    const name = metric.metric?.["tool_name"];
    if (!name || !metric.values?.length) continue;
    const lastVal = metric.values[metric.values.length - 1];
    if (lastVal) map[name] = parseInt(lastVal[1], 10) || 0;
  }
  return map;
}

interface LogEntry {
  timestamp: string;
  line: string;
  labels: Record<string, string>;
}

export async function apiErrors(
  loki: LokiFetcher,
  range: string,
  limit = 50,
): Promise<LogEntry[] | null> {
  const r = safeDuration(range, "1h");
  const now = new Date();
  const start = new Date(now.getTime() - parseDuration(r));
  const result = await loki.queryRange(
    '{service_name=~"claude-code.*"} |= "claude_code.api_error"',
    start.toISOString(),
    now.toISOString(),
    limit,
  );
  if (!result) return null;
  const entries: LogEntry[] = [];
  for (const stream of result.data.result) {
    const s = stream as LokiStreamValue;
    if (!s.values) continue;
    for (const [ts, line] of s.values) {
      entries.push({
        timestamp: ts,
        line,
        labels: s.stream ?? {},
      });
    }
  }
  return entries;
}

// ── CTL-914 (DETAIL3): worker-page [history] tail ───────────────────────────
// A single phase-agent run's transcript is readable HOURS after the worker died
// by querying the `claude-code` Loki stream filtered to its CC session UUID. The
// filter MUST be a `| session_id=\`UUID\`` pipe on STRUCTURED METADATA — a
// `{session_id="UUID"}` label matcher returns 0 (session_id is not a stream
// label, it is per-line structured metadata; verified design §5.2). This is the
// reason the worker page is never empty even with no live worker.

/** One parsed claude-code OTEL log line for the worker history tail. The raw log
 *  body is a JSON object carrying these fields; absent fields stay `null`/`undefined`
 *  (never fabricated) so the row renderer can dim them. */
export interface WorkerHistoryRow {
  /** Log timestamp (epoch ms, from Loki's nanosecond ts). */
  ts: number;
  /** The OTEL event name (e.g. `claude_code.tool_result`, `claude_code.api_request`). */
  eventName: string | null;
  toolName: string | null;
  toolInput: string | null;
  durationMs: number | null;
  costUsd: number | null;
  tokens: number | null;
  model: string | null;
  /** Tool/result success flag when the line carries one. */
  success: boolean | null;
}

/** A CC session id is a UUID. Reject anything else so an attacker-controlled id
 *  can never inject LogQL through the `| session_id=\`…\`` pipe. */
const CC_SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

export function isValidCcSessionId(id: string): boolean {
  return CC_SESSION_ID_RE.test(id) && !id.includes("`") && !id.includes("\\");
}

/** Build the exact LogQL for a worker's history tail. Exported so a test can pin
 *  the `| session_id` STRUCTURED-METADATA pipe (not a `{session_id=}` matcher). */
export function workerHistoryLogQL(sessionId: string): string {
  return `{service_name=~"claude-code.*"} | session_id=\`${sessionId}\``;
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asStr(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v;
  return null;
}

function asBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

/** Parse one Loki log line (a JSON body) into a WorkerHistoryRow. Tolerant: a
 *  non-JSON or partial line still yields a row with the fields it could read and
 *  `null` for the rest — the tail must never crash on a malformed record. */
export function parseHistoryLine(ts: number, line: string): WorkerHistoryRow {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(line) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    /* leave body empty; the raw line is unreadable JSON */
  }
  return {
    ts,
    eventName: asStr(body["event_name"]) ?? asStr(body["event.name"]),
    toolName: asStr(body["tool_name"]),
    toolInput: asStr(body["tool_input"]),
    durationMs: asNum(body["duration_ms"]),
    costUsd: asNum(body["cost_usd"]),
    tokens: asNum(body["tokens"]),
    model: asStr(body["model"]),
    success: asBool(body["success"]),
  };
}

/** Query the `claude-code` Loki stream for one worker run's history, newest-first.
 *  Returns `null` when Loki is unavailable (caller surfaces a 503), `[]` when the
 *  stream is empty (a real "no logs" answer, not an error). */
export async function workerHistoryBySession(
  loki: LokiFetcher,
  sessionId: string,
  range: string,
  limit = 500,
): Promise<WorkerHistoryRow[] | null> {
  if (!isValidCcSessionId(sessionId)) return null;
  const r = safeDuration(range, "24h");
  const now = new Date();
  const start = new Date(now.getTime() - parseDuration(r));
  const result = await loki.queryRange(
    workerHistoryLogQL(sessionId),
    start.toISOString(),
    now.toISOString(),
    limit,
  );
  if (!result) return null;
  const rows: WorkerHistoryRow[] = [];
  for (const stream of result.data.result) {
    const s = stream as LokiStreamValue;
    if (!s.values) continue;
    for (const [tsNanos, line] of s.values) {
      // Loki stream timestamps are nanosecond strings — floor to epoch ms.
      const tsMs = Math.floor(Number(tsNanos) / 1_000_000);
      rows.push(parseHistoryLine(Number.isFinite(tsMs) ? tsMs : Date.now(), line));
    }
  }
  // Newest-first so the tail reads like a terminal (most-recent activity on top).
  rows.sort((a, b) => b.ts - a.ts);
  return rows;
}

// ── CTL-917 (DETAIL6): burn metrics off the OTEL pipeline ───────────────────
// The worker Burn Strip and the ticket telemetry strip both ride the SAME
// already-emitting Prometheus pipeline — no new plumbing, just query wiring on
// the `/api/otel/*` precedent (server.ts costByTicket/tokensByType routes). The
// worker strip keys on the CC session UUID (`session_id=$UUID`); the ticket
// strip keys on the Linear key (`linear_key=$T`). Every series is a `query_range`
// so the UI gets a sparkline-ready point list (step=60, design §4.2/§5.2). The
// UI falls back to the resident BoardWorker/BoardTicket scalars when a series is
// empty (just-spawned / instant paint) so a cell is never blank.

/** A single sparkline series: time-ordered [epochSeconds, value] points. The UI
 *  renders these as a sparkline; `[]` is an honest "no series yet" (the caller
 *  falls back to the resident scalar) — NEVER a fabricated point. */
export type SparklinePoint = [number, number];

/** A `linear_key` is a Linear identifier like `CTL-917`. Reject anything else so
 *  an attacker-controlled value can never inject PromQL through the
 *  `{linear_key="…"}` matcher. */
const LINEAR_KEY_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export function isValidLinearKey(key: string): boolean {
  return LINEAR_KEY_RE.test(key);
}

/** Extract ONE matrix series' points from a query_range result. Picks the series
 *  whose metric label `labelKey` === `labelVal` (or the first series when no key
 *  is given — used for `sum(...)` queries that collapse to a single series). */
function extractSeriesPoints(
  result: { data: { result: PrometheusMetricValue[] } },
): SparklinePoint[] {
  // sum(...) collapses to a single series; take the first (and usually only) one.
  const series = result.data.result[0];
  if (!series?.values) return [];
  const out: SparklinePoint[] = [];
  for (const [t, v] of series.values) {
    const val = parseFloat(v);
    if (Number.isFinite(val)) out.push([t, val]);
  }
  return out;
}

/** Extract a map of label → points from a query_range matrix with multiple
 *  series (e.g. `sum by(type)(...)`), one series per label value. */
function extractSeriesByLabel(
  result: { data: { result: PrometheusMetricValue[] } },
  labelKey: string,
): Record<string, SparklinePoint[]> {
  const map: Record<string, SparklinePoint[]> = {};
  for (const entry of result.data.result) {
    const key = entry.metric[labelKey];
    if (!key || !entry.values) continue;
    const pts: SparklinePoint[] = [];
    for (const [t, v] of entry.values) {
      const val = parseFloat(v);
      if (Number.isFinite(val)) pts.push([t, val]);
    }
    map[key] = pts;
  }
  return map;
}

/** Window [start,end] in ISO and the step, derived from a range string. step is
 *  fixed at 60s (the design's sparkline-ready cadence). */
function rangeWindow(range: string, fallback: string): { start: string; end: string; step: string } {
  const r = safeDuration(range, fallback);
  const now = new Date();
  const start = new Date(now.getTime() - parseDuration(r));
  return { start: start.toISOString(), end: now.toISOString(), step: "60s" };
}

// ── worker Burn Strip (keyed on the CC session UUID) ────────────────────────

/** The worker Burn Strip's four sparkline series + the by-type token split,
 *  keyed on the CC session UUID. `null` when Prometheus is unavailable (caller
 *  surfaces a 503); empty arrays when the series simply has no points yet (the
 *  UI falls back to the resident BoardWorker scalar). */
export interface WorkerBurnSeries {
  /** `sum(claude_code_cost_usage_USD_total{session_id="$UUID"})` cumulative cost. */
  cost: SparklinePoint[];
  /** `sum(claude_code_token_usage_tokens_total{session_id="$UUID"})` total tokens. */
  tokens: SparklinePoint[];
  /** token split by `type` (input/output/cacheRead/cacheCreation). */
  tokensByType: Record<string, SparklinePoint[]>;
  /** `sum(claude_code_active_time_seconds_total{session_id="$UUID"})` active seconds. */
  activeSeconds: SparklinePoint[];
}

export async function workerBurnSeries(
  prom: PrometheusFetcher,
  sessionId: string,
  range: string,
): Promise<WorkerBurnSeries | null> {
  if (!isValidCcSessionId(sessionId)) return null;
  const { start, end, step } = rangeWindow(range, "1h");
  const sel = `{session_id="${sessionId}"}`;
  const [cost, tokens, tokensByTypeRes, active] = await Promise.all([
    prom.queryRange(`sum(claude_code_cost_usage_USD_total${sel})`, start, end, step),
    prom.queryRange(`sum(claude_code_token_usage_tokens_total${sel})`, start, end, step),
    prom.queryRange(`sum by (type) (claude_code_token_usage_tokens_total${sel})`, start, end, step),
    prom.queryRange(`sum(claude_code_active_time_seconds_total${sel})`, start, end, step),
  ]);
  // If the very first probe failed (all null), Prometheus is unavailable.
  if (cost === null && tokens === null && tokensByTypeRes === null && active === null) {
    return null;
  }
  return {
    cost: cost ? extractSeriesPoints(cost) : [],
    tokens: tokens ? extractSeriesPoints(tokens) : [],
    tokensByType: tokensByTypeRes ? extractSeriesByLabel(tokensByTypeRes, "type") : {},
    activeSeconds: active ? extractSeriesPoints(active) : [],
  };
}

// ── ticket telemetry strip (keyed on the Linear key) ────────────────────────

/** The ticket telemetry strip's series, keyed on the Linear key. total cost /
 *  tokens-by-type sparklines + cost-by-phase (`sum by(task_type)`) and
 *  cost-by-model (`sum by(model)`) breakdown bars. commits/LoC are git-sourced
 *  (NEEDS-PLUMBING) so they are NOT queried here. `null` on Prometheus
 *  unavailability; empty when the series has no points (UI falls back to the
 *  resident BoardTicket scalar + phaseCosts). */
export interface TicketTelemetrySeries {
  /** `sum(claude_code_cost_usage_USD_total{linear_key="$T"})` cumulative cost. */
  cost: SparklinePoint[];
  /** `sum(claude_code_token_usage_tokens_total{linear_key="$T"})` total tokens. */
  tokens: SparklinePoint[];
  /** token split by `type`. */
  tokensByType: Record<string, SparklinePoint[]>;
  /** cost split by `task_type` (the phase) — the cost-by-phase bars. */
  costByPhase: Record<string, SparklinePoint[]>;
  /** cost split by `model` — the cost-by-model bars. */
  costByModel: Record<string, SparklinePoint[]>;
}

export async function ticketTelemetrySeries(
  prom: PrometheusFetcher,
  linearKey: string,
  range: string,
): Promise<TicketTelemetrySeries | null> {
  if (!isValidLinearKey(linearKey)) return null;
  const { start, end, step } = rangeWindow(range, "1h");
  const sel = `{linear_key="${linearKey}"}`;
  const [cost, tokens, tokensByTypeRes, byPhase, byModel] = await Promise.all([
    prom.queryRange(`sum(claude_code_cost_usage_USD_total${sel})`, start, end, step),
    prom.queryRange(`sum(claude_code_token_usage_tokens_total${sel})`, start, end, step),
    prom.queryRange(`sum by (type) (claude_code_token_usage_tokens_total${sel})`, start, end, step),
    prom.queryRange(`sum by (task_type) (claude_code_cost_usage_USD_total${sel})`, start, end, step),
    prom.queryRange(`sum by (model) (claude_code_cost_usage_USD_total${sel})`, start, end, step),
  ]);
  if (
    cost === null && tokens === null && tokensByTypeRes === null &&
    byPhase === null && byModel === null
  ) {
    return null;
  }
  return {
    cost: cost ? extractSeriesPoints(cost) : [],
    tokens: tokens ? extractSeriesPoints(tokens) : [],
    tokensByType: tokensByTypeRes ? extractSeriesByLabel(tokensByTypeRes, "type") : {},
    costByPhase: byPhase ? extractSeriesByLabel(byPhase, "task_type") : {},
    costByModel: byModel ? extractSeriesByLabel(byModel, "model") : {},
  };
}

interface CostValidationEntry {
  ticket: string;
  signalCost: number;
  otelCost: number;
  discrepancy: number;
}

export async function costValidation(
  prom: PrometheusFetcher,
  signalCosts: Record<string, number>,
  range: string,
): Promise<CostValidationEntry[] | null> {
  const r = safeDuration(range, "6h");
  const otelCosts = await costByTicket(prom, r);
  if (otelCosts === null) return null;
  const allTickets = new Set([
    ...Object.keys(signalCosts),
    ...Object.keys(otelCosts),
  ]);
  const entries: CostValidationEntry[] = [];
  for (const ticket of allTickets) {
    const signalCost = signalCosts[ticket] ?? 0;
    const otelCost = otelCosts[ticket] ?? 0;
    entries.push({
      ticket,
      signalCost,
      otelCost,
      discrepancy: Math.abs(signalCost - otelCost),
    });
  }
  return entries;
}

function parseDuration(s: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(s);
  if (!match) return 3600_000;
  const n = parseInt(match[1] ?? "1", 10);
  switch (match[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3600_000;
    case "d":
      return n * 86400_000;
    default:
      return 3600_000;
  }
}
