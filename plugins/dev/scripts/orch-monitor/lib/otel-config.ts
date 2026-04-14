import { readFileSync } from "fs";
import { join } from "path";

export interface OtelConfig {
  enabled: boolean;
  prometheusUrl: string | null;
  lokiUrl: string | null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export function loadOtelConfig(catalystDir: string): OtelConfig {
  let fileEnabled = false;
  let filePrometheus: string | null = null;
  let fileLoki: string | null = null;

  try {
    const raw = readFileSync(join(catalystDir, "config.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && isRecord(parsed.otel)) {
      const otel = parsed.otel;
      if (typeof otel.enabled === "boolean") fileEnabled = otel.enabled;
      if (typeof otel.prometheus === "string" && otel.prometheus)
        filePrometheus = otel.prometheus;
      if (typeof otel.loki === "string" && otel.loki) fileLoki = otel.loki;
    }
  } catch {
    // config file missing or malformed — use defaults
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

  return { enabled, prometheusUrl, lokiUrl };
}
