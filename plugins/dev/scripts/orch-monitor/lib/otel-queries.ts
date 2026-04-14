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

export interface LogEntry {
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

export interface CostValidationEntry {
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
