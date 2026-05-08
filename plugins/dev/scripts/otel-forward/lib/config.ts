import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OtlpConfig { enabled: boolean; endpoint: string; batchSize: number; flushIntervalMs: number }
export interface PosthogConfig { enabled: boolean; apiKey: string; host: string; batchSize: number; flushIntervalMs: number }
export interface CloudflareAEConfig { enabled: boolean; accountId: string; apiToken: string; dataset: string; batchSize: number; flushIntervalMs: number }
export interface ForwarderConfig { otlp: OtlpConfig; posthog: PosthogConfig; cloudflareAE: CloudflareAEConfig }

const DEFAULTS = {
  otlp: { enabled: false, endpoint: "", batchSize: 100, flushIntervalMs: 5000 },
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
    : (fw.otlp?.endpoint ?? "");
  return {
    otlp: { ...DEFAULTS.otlp, ...(fw.otlp ?? {}), endpoint: otlpEndpoint },
    posthog: { ...DEFAULTS.posthog, ...(fw.posthog ?? {}) },
    cloudflareAE: { ...DEFAULTS.cloudflareAE, ...(fw.cloudflareAE ?? {}) },
  };
}
