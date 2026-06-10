import type { PrometheusFetcher, PrometheusMetricValue } from "./prometheus";
import type { LokiFetcher, LokiStreamValue, LokiQueryResult } from "./loki";

const DURATION_RE = /^\d+(ms|s|m|h|d)$/;

export function safeDuration(s: string, fallback: string): string {
  return DURATION_RE.test(s) ? s : fallback;
}

// OBS-9: `increase()` over a fixed window returns a series for EVERY label value
// that has EVER carried the metric, most with value 0 in any given window (the
// `/api/otel/cost` route returns ~24 exact-0 tickets out of ~36 live). A topk /
// bottomk / table built on that renders all-zeros garbage. The ZERO-SERIES FILTER
// is therefore MANDATORY at the QUERY layer on every cost map (design §1/§2): pass
// `filterZero: true` to drop value===0 series. Default is false so the
// cost-VALIDATION path (which legitimately compares signal-vs-otel for tickets that
// may be 0 on one side) keeps every ticket.
function extractVectorMap(
  result: { data: { result: PrometheusMetricValue[] } },
  labelKey: string,
  filterZero = false,
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const entry of result.data.result) {
    const key = entry.metric[labelKey];
    if (!key) continue;
    const val = entry.value ? parseFloat(entry.value[1]) : 0;
    if (!Number.isFinite(val)) continue;
    // Drop exact-0 series so a topk/bottomk/table never renders all-zeros garbage.
    if (filterZero && val === 0) continue;
    map[key] = val;
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
  // OBS-9: zero-series filter — exclude tickets with $0 spend in the window so the
  // expensive-tickets table (and any bottomk) only ever shows real cost.
  return extractVectorMap(result, "linear_key", true);
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
  // OBS-9: zero-series filter — drop phases with $0 spend in the window so the
  // by-stage bar (P-B) doesn't render a forest of empty phases (live: 5 of 12
  // task_types are exact-0 over 24h).
  return extractVectorMap(result, "task_type", true);
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

// ── OBS-7 (TELEMETRY P4): per-model request latency + error% ─────────────────
// Model latency is read off the SAME claude-code Loki stream the tail/errors use,
// not Prometheus — `api_request` records carry a `duration_ms` value we unwrap and
// aggregate with LogQL's `quantile_over_time`. p50/p95 by `model` answer "is this
// model slow right now?"; the error% by model (api_error / api_request) is a
// second, complementary axis the P4 bar labels (a model can be fast but erroring).
//
// STRUCTURED-METADATA TRUTH (verified live 2026-06-10): catalyst-otel puts
// `event_name`, `model`, `duration_ms`, … as STRUCTURED-METADATA labels on the
// `service_name="claude-code"` streams; the log line BODY is just the event-name
// string (e.g. "claude_code.api_request"). So:
//   - the event filter MUST be a `| event_name="api_request"` PIPE label-filter,
//     NOT a `{event_name=…}` stream selector (that returns 0 — the shipped bug),
//     and NOT a body match `|= "claude_code.api_request"` followed by `| json`
//     (the body is not JSON → `| json` raises JSONParserErr and Loki 400s, which
//     surfaces as a false "Loki unavailable").
//   - `unwrap duration_ms` reads the structured-metadata label directly — no `|
//     json` stage is needed (or possible).
//
// The LogQL is a metric query (queryRange returns a matrix, one series per model):
//   quantile_over_time(0.95, {service_name=~"claude-code.*"}
//     | event_name="api_request" | unwrap duration_ms [r]) by (model)
// We take the LAST point of each series (the cumulative-window aggregate over the
// scan), the same "last value" idiom toolUsageByName uses for count_over_time.

/** One model's latency + error profile for the P4 panel. p50/p95 are in ms (null
 *  when the model produced no unwrappable api_request samples in the window);
 *  requests/errors are the raw counts the error-rate is derived from so the UI can
 *  show "n=…" honestly. errorRate is errors/requests, or null when requests===0
 *  (no requests to divide by — the UI shows "—", never a fabricated 0%). */
export interface ModelLatencyRow {
  model: string;
  p50Ms: number | null;
  p95Ms: number | null;
  requests: number;
  errors: number;
  /** errors / requests over the window, or null when requests === 0. */
  errorRate: number | null;
}

/** Build the exact LogQL for one latency quantile over unwrapped `duration_ms` on
 *  the `api_request` records, grouped by model. The event filter is a
 *  `| event_name="api_request"` PIPE label-filter on structured metadata (NOT a
 *  `{event_name=…}` selector, which returns 0), and `unwrap duration_ms` reads the
 *  structured-metadata label directly (NO `| json` stage — the body is the
 *  event-name string, not JSON, so `| json` would 400). Exported so a test can pin
 *  this shape (a refactor that re-adds `| json` or moves the filter into `{}`
 *  silently returns zero series). */
export function modelLatencyLogQL(quantile: number, range: string): string {
  const r = safeDuration(range, "1h");
  return (
    `quantile_over_time(${quantile}, {service_name=~"claude-code.*"} ` +
    `| event_name="api_request" | unwrap duration_ms [${r}]) by (model)`
  );
}

/** Build the LogQL for an event count by model, used to derive the per-model error
 *  rate. `eventName` is the bare structured-metadata value (e.g. `api_request` /
 *  `api_error`), filtered via a `| event_name="…"` PIPE label-filter (NOT a body
 *  match + `| json`). Exported for the same pin-the-shape reason. */
export function modelEventCountLogQL(eventName: string, range: string): string {
  const r = safeDuration(range, "1h");
  return (
    `sum by (model) (count_over_time({service_name=~"claude-code.*"} ` +
    `| event_name="${eventName}" [${r}]))`
  );
}

/** Pull the LAST numeric point of each `by (model)` series into a model→value map.
 *  A series with no usable points is skipped (the model simply has no value on that
 *  axis — never fabricated). Shared by the latency + count extractions. Each entry
 *  is cast to the matrix shape (LogQL metric queries return matrix series), the
 *  same defensive cast toolUsageByName uses on Loki results. */
function lastValueByModel(result: LokiQueryResult): Record<string, number> {
  const map: Record<string, number> = {};
  for (const entry of result.data.result) {
    const metric = entry as {
      metric?: Record<string, string>;
      values?: Array<[number, string]>;
    };
    const model = metric.metric?.["model"];
    if (!model || !metric.values?.length) continue;
    const last = metric.values[metric.values.length - 1];
    if (!last) continue;
    const v = parseFloat(last[1]);
    if (Number.isFinite(v)) map[model] = v;
  }
  return map;
}

/**
 * Per-model api_request latency (p50/p95) + error% over the window, off the
 * claude-code Loki stream. Returns `null` ONLY when Loki is unavailable (the first
 * probe failed — caller surfaces a 503); an empty stream is `[]` (an honest "no
 * api_request samples in range", which the ChartCard renders as the empty state,
 * NOT an error). Rows are sorted slowest-p95-first so the bottleneck model leads.
 */
export async function modelLatency(
  loki: LokiFetcher,
  range: string,
): Promise<ModelLatencyRow[] | null> {
  const r = safeDuration(range, "1h");
  const now = new Date();
  const start = new Date(now.getTime() - parseDuration(r));
  const startIso = start.toISOString();
  const endIso = now.toISOString();

  const [p50Res, p95Res, reqRes, errRes] = await Promise.all([
    loki.queryRange(modelLatencyLogQL(0.5, r), startIso, endIso),
    loki.queryRange(modelLatencyLogQL(0.95, r), startIso, endIso),
    loki.queryRange(modelEventCountLogQL("api_request", r), startIso, endIso),
    loki.queryRange(modelEventCountLogQL("api_error", r), startIso, endIso),
  ]);

  // Loki unavailable → the very first (and every) probe is null. Distinguish that
  // from "reachable but empty" (a result with an empty `.data.result`).
  if (p50Res === null && p95Res === null && reqRes === null && errRes === null) {
    return null;
  }

  const p50 = p50Res ? lastValueByModel(p50Res) : {};
  const p95 = p95Res ? lastValueByModel(p95Res) : {};
  const requests = reqRes ? lastValueByModel(reqRes) : {};
  const errors = errRes ? lastValueByModel(errRes) : {};

  // Union the models seen on any axis so a model that only errored (or only had a
  // latency sample) still appears — never dropped.
  const models = new Set<string>([
    ...Object.keys(p50),
    ...Object.keys(p95),
    ...Object.keys(requests),
    ...Object.keys(errors),
  ]);

  const rows: ModelLatencyRow[] = [];
  for (const model of models) {
    const req = Math.round(requests[model] ?? 0);
    const err = Math.round(errors[model] ?? 0);
    rows.push({
      model,
      p50Ms: p50[model] ?? null,
      p95Ms: p95[model] ?? null,
      requests: req,
      errors: err,
      errorRate: req > 0 ? err / req : null,
    });
  }

  // Slowest p95 first (the bottleneck model leads); rows with no p95 sink last.
  rows.sort((a, b) => (b.p95Ms ?? -1) - (a.p95Ms ?? -1));
  return rows;
}

// ── OBS-7 (TELEMETRY P3): per-tool latency (p50/p95) ─────────────────────────
// The P3 tool-mix panel sorts by TOTAL TIME (count × p95), not call count — a slow
// tool used 10× beats a fast tool used 1000× (design §3.1). The counts come from
// toolUsageByName; this adds the p50/p95 half by unwrapping `duration_ms` on
// `tool_result`, the SAME LogQL idiom as modelLatency but grouped by `tool_name`.
// The grouping label is `tool_name` (verified live: `by (tool_name)` → 17 series,
// `by (tool)` → 1 empty series — `tool` is not a label that exists), and the event
// filter is a `| event_name="tool_result"` PIPE label-filter on structured
// metadata (NOT a body match + `| json`, which 400s on the non-JSON body).

/** One tool's p50/p95 latency (ms), null when no unwrappable tool_result samples
 *  fell in the window. Keyed by tool name in the returned map. */
export interface ToolLatency {
  p50Ms: number | null;
  p95Ms: number | null;
}

/** Build the LogQL for one latency quantile over unwrapped `duration_ms` on the
 *  `tool_result` records, grouped by tool_name. The event filter is a
 *  `| event_name="tool_result"` PIPE label-filter on structured metadata and
 *  `unwrap duration_ms` reads the structured-metadata label directly (NO `| json`
 *  stage — the body is the event-name string, not JSON). Grouped by `tool_name`
 *  (NOT `tool` — that label does not exist). Exported so a test can pin the shape
 *  (mirrors modelLatencyLogQL). */
export function toolLatencyLogQL(quantile: number, range: string): string {
  const r = safeDuration(range, "1h");
  return (
    `quantile_over_time(${quantile}, {service_name=~"claude-code.*"} ` +
    `| event_name="tool_result" | unwrap duration_ms [${r}]) by (tool_name)`
  );
}

/** Pull the LAST numeric point of each `by (tool_name)` series into a tool→value
 *  map (mirrors lastValueByModel, keyed on tool_name). */
function lastValueByTool(result: LokiQueryResult): Record<string, number> {
  const map: Record<string, number> = {};
  for (const entry of result.data.result) {
    const metric = entry as {
      metric?: Record<string, string>;
      values?: Array<[number, string]>;
    };
    const tool = metric.metric?.["tool_name"];
    if (!tool || !metric.values?.length) continue;
    const last = metric.values[metric.values.length - 1];
    if (!last) continue;
    const v = parseFloat(last[1]);
    if (Number.isFinite(v)) map[tool] = v;
  }
  return map;
}

/**
 * Per-tool p50/p95 latency over the window, off the claude-code Loki stream.
 * Returns `null` ONLY when Loki is unavailable (both probes failed → caller
 * surfaces a 503); an empty stream is `{}` (an honest "no tool_result samples" —
 * the UI shows counts only, never a fabricated latency).
 */
export async function toolLatency(
  loki: LokiFetcher,
  range: string,
): Promise<Record<string, ToolLatency> | null> {
  const r = safeDuration(range, "1h");
  const now = new Date();
  const start = new Date(now.getTime() - parseDuration(r));
  const startIso = start.toISOString();
  const endIso = now.toISOString();

  const [p50Res, p95Res] = await Promise.all([
    loki.queryRange(toolLatencyLogQL(0.5, r), startIso, endIso),
    loki.queryRange(toolLatencyLogQL(0.95, r), startIso, endIso),
  ]);

  if (p50Res === null && p95Res === null) return null;

  const p50 = p50Res ? lastValueByTool(p50Res) : {};
  const p95 = p95Res ? lastValueByTool(p95Res) : {};
  const tools = new Set<string>([...Object.keys(p50), ...Object.keys(p95)]);

  const map: Record<string, ToolLatency> = {};
  for (const tool of tools) {
    map[tool] = {
      p50Ms: p50[tool] ?? null,
      p95Ms: p95[tool] ?? null,
    };
  }
  return map;
}

interface LogEntry {
  timestamp: string;
  line: string;
  labels: Record<string, string>;
}

/** Build the LogQL for the api_error LOG tail. Uses a `| event_name="api_error"`
 *  PIPE label-filter on structured metadata. (A body match `|= "claude_code.
 *  api_error"` ALSO works for a LOG query — the body is exactly that string — but
 *  the pipe-filter is the canonical structured-metadata pattern and stays correct
 *  if the body ingest shape ever changes. The error string + model the P2 panel
 *  clusters on live in the STREAM LABELS, surfaced via LogEntry.labels.) Exported
 *  so a test can pin the pipe-filter shape. */
export function apiErrorsLogQL(): string {
  return `{service_name=~"claude-code.*"} | event_name="api_error"`;
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
    apiErrorsLogQL(),
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

// ── OBS-6 (TELEMETRY): the grouped live tail + Loki freshness ────────────────
// The Telemetry surface's P1 panel is a live tail of the WHOLE fleet's
// claude-code activity, grouped by worker — not one session at a time (that's
// the CTL-914 worker page below). It rides the SAME Loki pipe as
// workerHistoryLogQL, but UN-filtered by session: a single newest-first scan of
// `{service_name=~"claude-code.*"}` over a short window. Each line is parsed by
// the SAME parseHistoryLine (absent fields render dimmed, NEVER fabricated), and
// we additionally lift the per-line `session_id` / `linear_key` structured
// metadata so the UI can group rows under `▾<ticket>·<phase>` worker headers by
// joining client-side against the board's worker list.
//
// The hero's freshness signal (age of the newest claude-code line) falls out of
// the same scan for free — `freshnessMs` is `now − newest row ts`, or null when
// the stream is empty (an honest "no recent events", which the hero reads as
// QUIET, never as an error).

/** One parsed tail row for the grouped live tail. Extends the WorkerHistoryRow
 *  shape with the grouping keys lifted from the line body so a row can be bucketed
 *  under its worker without a second query. Both keys are null when the line did
 *  not carry them (a row is still shown — under an "unattributed" bucket — never
 *  dropped or fabricated). */
export interface TailRow extends WorkerHistoryRow {
  /** CC session UUID (from the line's `session_id`), the join key to a BoardWorker. */
  sessionId: string | null;
  /** Linear key (from the line's `linear_key`), the human-facing group label. */
  linearKey: string | null;
}

/** The grouped-tail payload: newest-first parsed rows + the fleet-wide freshness
 *  (age in ms of the newest claude-code line). `null` rows ⇒ Loki unavailable
 *  (caller surfaces a 503). `freshnessMs === null` ⇒ no lines in the window (the
 *  hero reads this as QUIET — honest "no recent events", not an error). */
export interface TailResult {
  rows: TailRow[];
  freshnessMs: number | null;
}

/** Build the exact LogQL for the fleet-wide tail. Exported so a test can pin the
 *  un-filtered `{service_name=~"claude-code.*"}` selector (the same stream the
 *  per-session history reads, minus the session pipe). */
export function recentTailLogQL(): string {
  return `{service_name=~"claude-code.*"}`;
}

/** Query the claude-code Loki stream for the fleet's recent activity, newest
 *  first, and derive the fleet-wide freshness. Returns `{rows:[], freshnessMs:null}`
 *  vs `null`: `null` ONLY when Loki is unavailable (probe failed). An empty stream
 *  is `{rows:[], freshnessMs:null}` — a real "no recent events" answer the hero
 *  renders as QUIET, never an error. */
export async function recentTail(
  loki: LokiFetcher,
  range: string,
  limit = 300,
): Promise<TailResult | null> {
  const r = safeDuration(range, "15m");
  const now = new Date();
  const start = new Date(now.getTime() - parseDuration(r));
  const result = await loki.queryRange(
    recentTailLogQL(),
    start.toISOString(),
    now.toISOString(),
    limit,
  );
  if (!result) return null;
  const rows: TailRow[] = [];
  for (const stream of result.data.result) {
    const s = stream as LokiStreamValue;
    if (!s.values) continue;
    // Every field lives in the STREAM LABELS (structured metadata) — the line body
    // is just the event-name string. parseHistoryLine reads from the labels; the
    // grouping keys (session_id / linear_key) come from the SAME labels (with a
    // body fallback for an older JSON-body ingest shape).
    const labels = s.stream ?? {};
    const streamSession = asStr(labels["session_id"]);
    const streamLinear = asStr(labels["linear_key"]);
    for (const [tsNanos, line] of s.values) {
      const tsMs = Math.floor(Number(tsNanos) / 1_000_000);
      const base = parseHistoryLine(Number.isFinite(tsMs) ? tsMs : Date.now(), line, labels);
      const body = safeJsonObject(line);
      rows.push({
        ...base,
        sessionId: streamSession ?? asStr(body["session_id"]),
        linearKey: streamLinear ?? asStr(body["linear_key"]),
      });
    }
  }
  rows.sort((a, b) => b.ts - a.ts);
  const freshnessMs = rows.length > 0 ? Math.max(0, now.getTime() - rows[0]!.ts) : null;
  return { rows, freshnessMs };
}

/** Parse a Loki line body to a plain object, tolerating non-JSON (returns {}).
 *  Shared with parseHistoryLine's internal try/catch so the tail's extra
 *  structured-metadata lift uses the SAME defensive parse. */
function safeJsonObject(line: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(line) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    /* unreadable JSON → empty object */
  }
  return {};
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
  /** The CC prompt id (`prompt_id` structured-metadata label), or null. */
  promptId: string | null;
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

/** Parse one Loki log record into a WorkerHistoryRow. catalyst-otel carries every
 *  field as a STRUCTURED-METADATA STREAM LABEL (verified live 2026-06-10) — the log
 *  line BODY is just the event-name string (e.g. "claude_code.tool_result"), so the
 *  body is NOT JSON and reading fields from it yields all-null ("event — —", the
 *  shipped bug). We therefore read every field from the passed `labels` map, and
 *  keep a best-effort JSON-body fallback ONLY for the rare record that does ship a
 *  JSON body (so this never regresses an older ingest shape). Tolerant: a record
 *  missing a field yields `null` for it — the tail must never crash. */
export function parseHistoryLine(
  ts: number,
  line: string,
  labels: Record<string, string> = {},
): WorkerHistoryRow {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(line) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    /* body is the event-name string, not JSON — fields come from `labels` */
  }
  // Labels win (the real source); body is a fallback for an older JSON-body ingest.
  const pick = (key: string): unknown => labels[key] ?? body[key];
  return {
    ts,
    eventName:
      asStr(labels["event_name"]) ??
      asStr(body["event_name"]) ??
      asStr(body["event.name"]),
    toolName: asStr(pick("tool_name")),
    toolInput: asStr(pick("tool_input")),
    durationMs: asNum(pick("duration_ms")),
    // The structured-metadata label is `cost_usd` (verified live); keep `cost` as a
    // body fallback for an older ingest shape.
    costUsd: asNum(labels["cost_usd"]) ?? asNum(body["cost_usd"]) ?? asNum(body["cost"]),
    tokens: asNum(pick("tokens")),
    model: asStr(pick("model")),
    success: asBool(pick("success")),
    promptId: asStr(pick("prompt_id")),
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
    // Fields live in the STREAM LABELS (structured metadata); the line body is the
    // event-name string. Pass the labels so parseHistoryLine reads the real values.
    const labels = s.stream ?? {};
    for (const [tsNanos, line] of s.values) {
      // Loki stream timestamps are nanosecond strings — floor to epoch ms.
      const tsMs = Math.floor(Number(tsNanos) / 1_000_000);
      rows.push(parseHistoryLine(Number.isFinite(tsMs) ? tsMs : Date.now(), line, labels));
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

// ── OBS-8 (TELEMETRY P5): events/min heatmap, workers × time ──────────────────
// "Is each running worker still emitting, or has one gone silent?" The P5 panel is
// a workers × time-bucket grid: rows = board worker sessions, columns = 15-minute
// windows, each cell = the count of claude-code log lines that session emitted in
// that window. A `running` worker whose recent cells are dark is an early-STALL
// signal (design §3.1 / build-plan §3 P5 → cross-links FleetOps stuck list).
//
// The data is one metric query over the SAME claude-code Loki stream the tail uses:
//   sum by (session_id) (count_over_time({service_name=~"claude-code.*"} [15m]))
// run as a query_range with an explicit 15m (900s) step so each matrix series
// carries one [epochSec, count] point per 15m bucket. session_id is a STREAM LABEL
// (no `| json` stage — verified live: `| json` errors on malformed lines and is
// unnecessary, the label is matchable directly), so the grouping is cheap and never
// drops a line to a parser error.
//
// Row headers (which sessions to SHOW, including silent ones) come from the board,
// joined in the route — so a `running` worker with ZERO Loki lines in the window
// still gets a row of all-silence cells (the whole point of the silence signal).

/** The 15-minute bucket width, in seconds — the Loki `step` and the bucket spacing. */
export const HEATMAP_BUCKET_SECONDS = 900;

/** One worker × time-bucket cell for the P5 heatmap. `x` is the bucket's start
 *  (epoch SECONDS, the Loki matrix point ts); `sessionId` is the row key; `value`
 *  is the count of claude-code lines that session emitted in that 15m window. */
export interface HeatmapCell {
  /** Bucket start, epoch seconds (the Loki matrix point timestamp). */
  x: number;
  /** CC session UUID — the row key (joined to a board worker name in the UI). */
  sessionId: string;
  /** Count of claude-code log lines in this session × bucket. */
  value: number;
}

/** The P5 events/min heatmap payload: the cells with positive activity + the
 *  ordered bucket axis (so the UI renders EVERY 15m column even where a session
 *  was silent — silence is the signal, never an absent column). */
export interface EventsHeatmap {
  /** Bucket starts (epoch seconds), ascending — the full column axis for the window. */
  buckets: number[];
  /** Activity cells (value > 0). Sessions/buckets absent here are honest silence. */
  cells: HeatmapCell[];
}

/** Build the exact LogQL for the events/min heatmap: a count of claude-code lines
 *  per session over a 15m sliding window, grouped by the `session_id` STREAM LABEL.
 *  Exported so a test can pin the shape — note there is deliberately NO `| json`
 *  stage (session_id is a stream label, and `| json` errors on malformed lines and
 *  would silently zero the matrix). */
export function eventsHeatmapLogQL(): string {
  return `sum by (session_id) (count_over_time({service_name=~"claude-code.*"} [${HEATMAP_BUCKET_SECONDS}s]))`;
}

/** PURE extraction of a Loki matrix result into heatmap cells + the bucket axis.
 *  Each matrix series is one session (the `session_id` metric label); each of its
 *  `values` points is one 15m bucket `[epochSec, countStr]`. We keep only cells
 *  with a positive, finite count (silence is represented by ABSENCE, which the UI
 *  fills from the bucket axis), and union every point's timestamp into the sorted
 *  bucket axis so the column grid is complete even when no session was active in a
 *  given window. A series with no `session_id` label is skipped (never bucketed
 *  under a fabricated key). Exported for direct unit testing. */
export function extractHeatmap(result: LokiQueryResult): EventsHeatmap {
  const cells: HeatmapCell[] = [];
  const bucketSet = new Set<number>();
  for (const entry of result.data.result) {
    const series = entry as {
      metric?: Record<string, string>;
      values?: Array<[number, string]>;
    };
    const sessionId = series.metric?.["session_id"];
    if (!sessionId || !series.values?.length) continue;
    for (const point of series.values) {
      const ts = Math.floor(Number(point[0]));
      if (!Number.isFinite(ts)) continue;
      bucketSet.add(ts);
      const value = parseInt(point[1], 10);
      if (Number.isFinite(value) && value > 0) {
        cells.push({ x: ts, sessionId, value });
      }
    }
  }
  const buckets = [...bucketSet].sort((a, b) => a - b);
  return { buckets, cells };
}

/**
 * Per-session events-per-15m-bucket heatmap over the window, off the claude-code
 * Loki stream. Returns `null` ONLY when Loki is unavailable (the probe failed →
 * caller surfaces a 503); a reachable-but-quiet stream is an honest empty
 * `{buckets:[], cells:[]}` (the ChartCard renders silence, NOT an error). The
 * caller joins `cells[].sessionId` to board worker names and renders a row for
 * every running worker — including silent ones — so an early stall is visible.
 */
export async function eventsHeatmap(
  loki: LokiFetcher,
  range: string,
): Promise<EventsHeatmap | null> {
  const r = safeDuration(range, "6h");
  const now = new Date();
  const start = new Date(now.getTime() - parseDuration(r));
  const result = await loki.queryRange(
    eventsHeatmapLogQL(),
    start.toISOString(),
    now.toISOString(),
    undefined,
    HEATMAP_BUCKET_SECONDS,
  );
  if (!result) return null;
  return extractHeatmap(result);
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

// ── OBS-9 (FINOPS): the hero today-vs-7d + EOD projection ────────────────────
// The FinOps surface question is "how much did I spend today, and is that normal?"
// The hero needs THREE numbers off Prometheus: today's spend (since local
// midnight), the avg of the prior 7 FULL days (the "normal" baseline the delta is
// vs), and an end-of-day projection (today extrapolated to a full 24h). All three
// are `increase()` over the SAME cost counter — no new plumbing.
//
// "Today" is anchored to the SERVER's local midnight (the operator's wall clock),
// elapsed as whole seconds, so the window is exactly the part of today that has
// happened. The 7d baseline is a `query_range` with a 1-DAY window + 1-DAY step
// over the prior 8 days, taking the 7 fully-elapsed daily buckets and averaging
// them (the current partial day is excluded — comparing a partial day to full days
// would always read "under budget", a lie). The projection linearly extrapolates
// today's run-rate to 24h (the simplest honest "if the rest of today looks like so
// far" estimate — design §1 Hero-B marks it neutral/informational, never colored).

/** The hero's dollar band: today's spend, the prior-7-full-day average (the delta
 *  baseline), the delta fraction (today vs avg, or null when avg===0 so the UI
 *  shows "—" not a divide-by-zero), and the linear EOD projection. `null` ONLY when
 *  Prometheus is unavailable (caller surfaces a 503); a live-but-quiet stack
 *  returns zeros honestly. */
export interface CostTodaySummary {
  /** `sum(increase(cost[<elapsed-today>]))` — spend since local midnight, USD. */
  todayUsd: number;
  /** Mean of the prior 7 FULL days' daily spend (the "normal" baseline), USD. */
  avg7dUsd: number;
  /** (today − avg7d) / avg7d, or null when avg7d===0 (no baseline → no delta). */
  deltaFraction: number | null;
  /** today extrapolated to a full 24h via the elapsed-fraction run-rate, USD. */
  projectionEodUsd: number;
  /** Whole seconds elapsed since local midnight (the today window width). */
  elapsedTodaySeconds: number;
}

/** Whole seconds elapsed since LOCAL midnight for a given instant. Exported so a
 *  test can pin the wall-clock anchoring (the today window is exactly this wide).
 *  Clamped to a 1s floor so a query fired in the first second of the day never
 *  produces a 0-width range (`increase(...[0s])` is undefined). */
export function secondsSinceLocalMidnight(now: Date = new Date()): number {
  const secs =
    now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  return Math.max(1, secs);
}

/** Pull the single scalar from a `sum(...)`-shaped instant vector (one series, no
 *  grouping label). Returns 0 for an empty/unparseable result — an honest "no spend
 *  in window", never null-as-zero confusion (the caller already handles the
 *  Prometheus-unavailable case separately). */
function extractScalar(result: {
  data: { result: PrometheusMetricValue[] };
}): number {
  const series = result.data.result[0];
  if (!series?.value) return 0;
  const v = parseFloat(series.value[1]);
  return Number.isFinite(v) ? v : 0;
}

/** Average of the FULLY-elapsed daily buckets in a 1d-window/1d-step matrix. The
 *  caller queries the prior 8 days; the LAST point is the current partial day and
 *  is EXCLUDED (comparing a partial day to full days under-reports "today is
 *  normal"). Exported for direct unit testing of the partial-day exclusion. */
export function avgPrior7FullDays(points: SparklinePoint[]): number {
  if (points.length === 0) return 0;
  // Drop the final (current, partial) bucket; keep up to the prior 7 full days.
  const full = points.slice(0, -1).slice(-7);
  if (full.length === 0) return 0;
  const sum = full.reduce((acc, [, v]) => acc + v, 0);
  return sum / full.length;
}

export async function costToday(
  prom: PrometheusFetcher,
  now: Date = new Date(),
): Promise<CostTodaySummary | null> {
  const elapsed = secondsSinceLocalMidnight(now);
  // today: instant query over the elapsed-today window.
  const todayRes = await prom.query(
    `sum(increase(claude_code_cost_usage_USD_total[${elapsed}s]))`,
  );
  // 7d baseline: 1d window, 1d step, over the prior 8 days (7 full + today partial).
  const start = new Date(now.getTime() - 8 * 86400_000).toISOString();
  const end = now.toISOString();
  const baselineRes = await prom.queryRange(
    `sum(increase(claude_code_cost_usage_USD_total[1d]))`,
    start,
    end,
    "86400s",
  );
  // Prometheus unavailable → both probes null.
  if (todayRes === null && baselineRes === null) return null;

  const todayUsd = todayRes ? extractScalar(todayRes) : 0;
  const dailyPoints = baselineRes ? extractSeriesPoints(baselineRes) : [];
  const avg7dUsd = avgPrior7FullDays(dailyPoints);
  const deltaFraction = avg7dUsd > 0 ? (todayUsd - avg7dUsd) / avg7dUsd : null;
  // EOD projection: linear run-rate extrapolation to a full day. elapsed is clamped
  // ≥1s so this never divides by zero; capped at the day so it never under-projects.
  const dayFraction = Math.min(1, elapsed / 86400);
  const projectionEodUsd = dayFraction > 0 ? todayUsd / dayFraction : todayUsd;
  return {
    todayUsd,
    avg7dUsd,
    deltaFraction,
    projectionEodUsd,
    elapsedTodaySeconds: elapsed,
  };
}

// ── OBS-9 (FINOPS): spend-over-time series + spike scoring ───────────────────
// The P-A panel is hourly spend bars with the spiking hours flagged. The series is
// a `query_range` of `sum(increase(cost[1h]))` stepped at 1h (24h/7d window). Spike
// scoring is a PURE function over the returned points so it is unit-testable
// without Prometheus: an hour is a spike when its spend exceeds
// max(2× the trailing-window median, μ+2σ) of the series (design §2 P-A). Both
// guards matter — the median guard catches a 2× jump over a calm baseline; the
// μ+2σ guard catches a genuine statistical outlier on a noisy series — and a spike
// must clear BOTH (the stricter bar) so a merely-busy hour isn't flagged.

/** One hourly spend point with its spike verdict. `t` is epoch SECONDS (the Loki/
 *  Prom matrix point ts); `usd` is the hour's spend; `isSpike` drives the
 *  `--chart-4` dot ON that bar (the one status-color use in P-A). */
export interface CostSeriesPoint {
  t: number;
  usd: number;
  isSpike: boolean;
}

/** Median of a numeric array (0 for empty). Pure helper for the spike threshold. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Score hourly spend points for spikes. PURE + exported so a test pins the rule:
 *  an hour is a spike iff its spend > max(2× median(series), μ+2σ) AND > 0. With
 *  fewer than 3 points there is no meaningful distribution → nothing is flagged
 *  (a 2-hour window can't have a statistical outlier). The `> 0` floor keeps a
 *  quiet all-zero series from flagging anything. */
export function scoreSpikes(points: SparklinePoint[]): CostSeriesPoint[] {
  const values = points.map(([, v]) => v);
  let threshold = Infinity;
  if (values.length >= 3) {
    const med = median(values);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);
    threshold = Math.max(2 * med, mean + 2 * std);
  }
  return points.map(([t, usd]) => ({
    t,
    usd,
    isSpike: usd > 0 && usd > threshold,
  }));
}

/** Hourly spend series with spike flags over the window. `null` ONLY when
 *  Prometheus is unavailable (caller surfaces a 503); a live-but-quiet stack is an
 *  honest `[]` (no hours in range → the ChartCard empty state). The window is the
 *  passed range (24h/7d); the step is fixed at 1h so each bar is one hour. */
export async function costSeries(
  prom: PrometheusFetcher,
  range: string,
): Promise<CostSeriesPoint[] | null> {
  const r = safeDuration(range, "24h");
  const now = new Date();
  const start = new Date(now.getTime() - parseDuration(r)).toISOString();
  const end = now.toISOString();
  const result = await prom.queryRange(
    `sum(increase(claude_code_cost_usage_USD_total[1h]))`,
    start,
    end,
    "3600s",
  );
  if (result === null) return null;
  const points = extractSeriesPoints(result);
  return scoreSpikes(points);
}

// ── OBS-9 (FINOPS): cache-ROI $ (THE HEADLINE) ───────────────────────────────
// The single most motivating FinOps number (99.8% hit rate live): how many real
// dollars the prompt cache saved by NOT charging cacheRead tokens at the full input
// rate. savings = Σ_model cacheRead_tokens(model) × (input_price − cache_read_price)
// for that model. The catalyst-otel dashboard's "Cache Savings ($)" panel proves a
// flat `cacheRead × 0.000003` ($3/1M, a sonnet-ish input rate); we improve on it
// with a PER-MODEL price book so the savings is accurate across the opus/sonnet/
// haiku/fable mix (each model has a different input price, so a flat rate over- or
// under-states the win depending on the live model split).
//
// Price book (USD per TOKEN) sourced from the /catalyst-dev:claude-api skill price
// table (per-1M ÷ 1e6). Anthropic prompt-cache pricing: a cache READ costs 0.1× the
// input price (the standard cache-read discount), so the per-token saving is
// input_price − cache_read_price = input_price × 0.9.

/** Per-1M-token INPUT price by model family (USD). From the claude-api skill price
 *  table. We match on a substring of the Prometheus `model` label (which carries
 *  values like `claude-opus-4-8`, `claude-opus-4-8[1m]`, `claude-sonnet-4-6`,
 *  `claude-haiku-4-5`, `claude-fable-5`). Fable exceeds opus-tier; we price it at
 *  the opus rate as a conservative floor rather than fabricate a number the skill
 *  table doesn't publish. */
const INPUT_PRICE_PER_1M: Record<string, number> = {
  opus: 5.0,
  sonnet: 3.0,
  haiku: 1.0,
  fable: 5.0,
  mythos: 5.0,
};

/** The cache-read discount: an Anthropic prompt-cache READ is billed at 0.1× the
 *  input price, so the per-token SAVING (vs paying full input) is input × 0.9. */
const CACHE_READ_PRICE_MULTIPLIER = 0.1;

/** Default input price (USD/1M) for a model whose family we don't recognise —
 *  the sonnet rate, matching the dashboard's flat $3/1M assumption so an unknown
 *  model never zeroes out (it would silently drop savings) nor over-states it. */
const DEFAULT_INPUT_PRICE_PER_1M = 3.0;

/** Resolve a model label to its per-TOKEN input price (USD). Exported so a test can
 *  pin the family matching (opus/sonnet/haiku/fable, with the `[1m]` long-context
 *  suffix and date suffixes tolerated). */
export function inputPricePerToken(model: string): number {
  const lower = model.toLowerCase();
  for (const family of Object.keys(INPUT_PRICE_PER_1M)) {
    if (lower.includes(family)) return INPUT_PRICE_PER_1M[family] / 1_000_000;
  }
  return DEFAULT_INPUT_PRICE_PER_1M / 1_000_000;
}

/** The cache-ROI payload: the headline savings $ + the multiplier (savings / actual
 *  spend, i.e. "spend would have been Nx higher without the cache"), the cacheRead
 *  token total the savings is computed from, and the per-model breakdown for a
 *  drill. `null` ONLY when Prometheus is unavailable. */
export interface CacheSavings {
  /** Σ_model cacheRead_tokens × (input − cache_read) price — USD saved by the cache. */
  savedUsd: number;
  /** Actual spend in the SAME window (for the "(Nx)" multiplier), USD. */
  actualSpendUsd: number;
  /** savedUsd / actualSpendUsd, or null when actual spend is 0 (no base to multiply). */
  multiplier: number | null;
  /** Total cacheRead tokens in the window (the savings driver). */
  cacheReadTokens: number;
  /** Per-model saving, USD, descending — the drill behind the headline. */
  byModel: Array<{ model: string; savedUsd: number; cacheReadTokens: number }>;
}

export async function cacheSavings(
  prom: PrometheusFetcher,
  range: string,
): Promise<CacheSavings | null> {
  const r = safeDuration(range, "24h");
  // cacheRead tokens BY MODEL so we can apply the per-model price; + total spend in
  // the same window for the multiplier.
  const [cacheReadRes, spendRes] = await Promise.all([
    prom.query(
      `sum by (model) (increase(claude_code_token_usage_tokens_total{type="cacheRead"}[${r}]))`,
    ),
    prom.query(`sum(increase(claude_code_cost_usage_USD_total[${r}]))`),
  ]);
  if (cacheReadRes === null && spendRes === null) return null;

  const byModelTokens = cacheReadRes
    ? extractVectorMap(cacheReadRes, "model", true)
    : {};
  const byModel: CacheSavings["byModel"] = [];
  let savedUsd = 0;
  let cacheReadTokens = 0;
  for (const [model, tokens] of Object.entries(byModelTokens)) {
    const perToken =
      inputPricePerToken(model) * (1 - CACHE_READ_PRICE_MULTIPLIER);
    const modelSaved = tokens * perToken;
    savedUsd += modelSaved;
    cacheReadTokens += tokens;
    byModel.push({ model, savedUsd: modelSaved, cacheReadTokens: tokens });
  }
  byModel.sort((a, b) => b.savedUsd - a.savedUsd);

  const actualSpendUsd = spendRes ? extractScalar(spendRes) : 0;
  const multiplier = actualSpendUsd > 0 ? savedUsd / actualSpendUsd : null;
  return { savedUsd, actualSpendUsd, multiplier, cacheReadTokens, byModel };
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
