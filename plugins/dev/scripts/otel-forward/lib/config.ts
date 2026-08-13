import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OtlpConfig {
  enabled: boolean;
  endpoint: string;
  batchSize: number;
  flushIntervalMs: number;
  /** CTL-1506: age window for Loki. Records older than this are dropped before send. Default 1h. */
  lokiAcceptWindowMs: number;
  /** CTL-1506: max elapsed time for HTTP retry window. Default 60s. */
  maxRetryElapsedMs: number;
  /** CTL-1818: thresholds for the host-local drop surface. Declared structurally rather than
   *  importing lib/drop-surface.ts's type, so the config leaf stays dependency-free; the
   *  resolver there owns validation and the env-override ladder. */
  dropSurface: { windowMs?: number; thresholdRecords?: number; sustainMs?: number };
}
export interface PosthogConfig { enabled: boolean; apiKey: string; host: string; batchSize: number; flushIntervalMs: number }
export interface CloudflareAEConfig { enabled: boolean; accountId: string; apiToken: string; dataset: string; batchSize: number; flushIntervalMs: number }
export interface ForwarderConfig { otlp: OtlpConfig; posthog: PosthogConfig; cloudflareAE: CloudflareAEConfig }

// CTL-1506 (Codex P2): endpoint defaults to the documented localhost collector so an
// operator who enables OTLP without an explicit endpoint hits a real URL instead of the
// relative "/v1/logs" (which fails every fetch and silently fills the DLQ).
const DEFAULTS = {
  otlp: { enabled: false, endpoint: "http://localhost:4318", batchSize: 100, flushIntervalMs: 5000, lokiAcceptWindowMs: 3_600_000, maxRetryElapsedMs: 60_000, dropSurface: {} },
  posthog: { enabled: false, apiKey: "", host: "https://us.i.posthog.com", batchSize: 50, flushIntervalMs: 10000 },
  cloudflareAE: { enabled: false, accountId: "", apiToken: "", dataset: "catalyst_events", batchSize: 100, flushIntervalMs: 5000 },
};

export function loadForwarderConfig(configPath: string, projectKey: string): ForwarderConfig {
  let file: Record<string, unknown> = {};
  const paths = [configPath, join(homedir(), ".config/catalyst/config.json")];
  for (const p of paths) {
    if (existsSync(p)) {
      try { file = JSON.parse(readFileSync(p, "utf8")); break; } catch { /**/ }
    }
  }
  const fw = (file as any)?.catalyst?.observability?.forwarders ?? {};
  const otlpEndpointEnv = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "";
  const otlpEndpoint = otlpEndpointEnv
    ? otlpEndpointEnv.replace(/:4317/, ":4318")
    : (fw.otlp?.endpoint || DEFAULTS.otlp.endpoint); // || so an empty configured value falls back
  return {
    otlp: { ...DEFAULTS.otlp, ...(fw.otlp ?? {}), endpoint: otlpEndpoint },
    posthog: { ...DEFAULTS.posthog, ...(fw.posthog ?? {}) },
    cloudflareAE: { ...DEFAULTS.cloudflareAE, ...(fw.cloudflareAE ?? {}) },
  };
}
