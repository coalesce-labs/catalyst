import { readFileSync } from "fs";
import { join } from "path";

interface OtelConfig {
  enabled: boolean;
  prometheusUrl: string | null;
  lokiUrl: string | null;
  /** CTL-1050: Grafana base URL (probed at `/api/health` by the service-health
   *  registry). Absent ⇒ null → the grafana entry renders "unknown" (grey),
   *  never red. New key `otel.grafanaUrl` (env GRAFANA_URL). */
  grafanaUrl: string | null;
  /** CTL-1050: OTel collector health_check extension endpoint (probed directly
   *  by the registry). Absent ⇒ null → the registry falls back to event-recency
   *  (telemetry-ingest freshness). New key `otel.collectorHealthUrl`
   *  (env OTEL_COLLECTOR_HEALTH_URL). */
  collectorHealthUrl: string | null;
}

interface FileRead {
  enabled: boolean;
  prometheusUrl: string | null;
  lokiUrl: string | null;
  grafanaUrl: string | null;
  collectorHealthUrl: string | null;
  deprecatedKeys: string[];
}

let warnedDeprecatedKeys = false;

// Exposed for tests only.
export function _resetDeprecationWarning(): void {
  warnedDeprecatedKeys = false;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function readOtelFromFile(filePath: string): FileRead | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.otel)) return null;

  const otel = parsed.otel;
  const out: FileRead = {
    enabled: false,
    prometheusUrl: null,
    lokiUrl: null,
    grafanaUrl: null,
    collectorHealthUrl: null,
    deprecatedKeys: [],
  };

  if (typeof otel.enabled === "boolean") out.enabled = otel.enabled;

  // CTL-1050: new keys — no deprecated alias, optional. Absent ⇒ null.
  if (typeof otel.grafanaUrl === "string" && otel.grafanaUrl) {
    out.grafanaUrl = otel.grafanaUrl;
  }
  if (typeof otel.collectorHealthUrl === "string" && otel.collectorHealthUrl) {
    out.collectorHealthUrl = otel.collectorHealthUrl;
  }

  if (typeof otel.prometheusUrl === "string" && otel.prometheusUrl) {
    out.prometheusUrl = otel.prometheusUrl;
  } else if (typeof otel.prometheus === "string" && otel.prometheus) {
    out.prometheusUrl = otel.prometheus;
    out.deprecatedKeys.push("otel.prometheus");
  }

  if (typeof otel.lokiUrl === "string" && otel.lokiUrl) {
    out.lokiUrl = otel.lokiUrl;
  } else if (typeof otel.loki === "string" && otel.loki) {
    out.lokiUrl = otel.loki;
    out.deprecatedKeys.push("otel.loki");
  }

  return out;
}

export function loadOtelConfig(
  configDir: string,
  projectKey?: string | null,
): OtelConfig {
  const paths: string[] = [];
  if (projectKey) paths.push(join(configDir, `config-${projectKey}.json`));
  paths.push(join(configDir, "config.json"));

  let fileEnabled = false;
  let filePrometheus: string | null = null;
  let fileLoki: string | null = null;
  let fileGrafana: string | null = null;
  let fileCollectorHealth: string | null = null;
  const deprecatedKeys = new Set<string>();

  for (const p of paths) {
    const result = readOtelFromFile(p);
    if (result === null) continue;
    fileEnabled = result.enabled;
    filePrometheus = result.prometheusUrl;
    fileLoki = result.lokiUrl;
    fileGrafana = result.grafanaUrl;
    fileCollectorHealth = result.collectorHealthUrl;
    for (const k of result.deprecatedKeys) deprecatedKeys.add(k);
    break;
  }

  if (deprecatedKeys.size > 0 && !warnedDeprecatedKeys) {
    warnedDeprecatedKeys = true;
    const mapping: Record<string, string> = {
      "otel.prometheus": "otel.prometheusUrl",
      "otel.loki": "otel.lokiUrl",
    };
    const hints = Array.from(deprecatedKeys)
      .map((k) => `${k} → ${mapping[k] ?? k}`)
      .join(", ");
    console.warn(
      `[otel-config] Deprecated keys in use: ${hints}. These will be removed in a future release.`,
    );
  }

  const envEnabled = process.env.OTEL_ENABLED;
  const envPrometheus = process.env.PROMETHEUS_URL;
  const envLoki = process.env.LOKI_URL;

  const enabled =
    envEnabled !== undefined
      ? envEnabled === "true" || envEnabled === "1"
      : fileEnabled;

  const prometheusUrl = envPrometheus
    ? stripTrailingSlashes(envPrometheus)
    : filePrometheus
      ? stripTrailingSlashes(filePrometheus)
      : null;

  const lokiUrl = envLoki
    ? stripTrailingSlashes(envLoki)
    : fileLoki
      ? stripTrailingSlashes(fileLoki)
      : null;

  const envGrafana = process.env.GRAFANA_URL;
  const grafanaUrl = envGrafana
    ? stripTrailingSlashes(envGrafana)
    : fileGrafana
      ? stripTrailingSlashes(fileGrafana)
      : null;

  const envCollectorHealth = process.env.OTEL_COLLECTOR_HEALTH_URL;
  const collectorHealthUrl = envCollectorHealth
    ? stripTrailingSlashes(envCollectorHealth)
    : fileCollectorHealth
      ? stripTrailingSlashes(fileCollectorHealth)
      : null;

  return { enabled, prometheusUrl, lokiUrl, grafanaUrl, collectorHealthUrl };
}
