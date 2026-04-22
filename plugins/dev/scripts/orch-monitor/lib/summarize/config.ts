import { readFileSync } from "fs";

export type ProviderName = "anthropic" | "openai" | "grok";

export const KNOWN_PROVIDERS: readonly ProviderName[] = [
  "anthropic",
  "openai",
  "grok",
];

export function isKnownProvider(x: unknown): x is ProviderName {
  return (
    typeof x === "string" &&
    (KNOWN_PROVIDERS as readonly string[]).includes(x)
  );
}

const DEFAULT_PROVIDER: ProviderName = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-4-6";

export interface ProviderConfig {
  apiKeyEnv: string;
  apiKey?: string;
}

export interface SummarizeConfig {
  enabled: boolean;
  defaultProvider: ProviderName;
  defaultModel: string;
  providers: Partial<Record<ProviderName, ProviderConfig>>;
}

const DISABLED: SummarizeConfig = {
  enabled: false,
  defaultProvider: DEFAULT_PROVIDER,
  defaultModel: DEFAULT_MODEL,
  providers: {},
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function readJsonSafe(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    console.warn(
      `[summarize] failed to parse ${path}:`,
      err instanceof Error ? err.message : "unknown error",
    );
    return null;
  }
}

export function loadSummarizeConfig(
  projectConfigPath: string,
  env: NodeJS.ProcessEnv = process.env,
): SummarizeConfig {
  const parsed = readJsonSafe(projectConfigPath);
  if (!isRecord(parsed)) return DISABLED;

  const catalyst = isRecord(parsed.catalyst) ? parsed.catalyst : null;
  if (!catalyst) return DISABLED;

  const ai = isRecord(catalyst.ai) ? catalyst.ai : null;
  if (!ai) return DISABLED;

  if (ai.enabled === false) return DISABLED;

  const providersRaw = isRecord(ai.providers) ? ai.providers : null;
  if (!providersRaw) return DISABLED;

  const providers: Partial<Record<ProviderName, ProviderConfig>> = {};
  for (const [name, cfg] of Object.entries(providersRaw)) {
    if (!isKnownProvider(name)) continue;
    if (!isRecord(cfg)) continue;
    const apiKeyEnv = typeof cfg.apiKeyEnv === "string" ? cfg.apiKeyEnv : "";
    if (!apiKeyEnv) continue;
    const apiKey = typeof env[apiKeyEnv] === "string" ? env[apiKeyEnv] : "";
    providers[name] = { apiKeyEnv, apiKey: apiKey || undefined };
  }

  const hasAnyKey = Object.values(providers).some(
    (p) => p?.apiKey && p.apiKey.length > 0,
  );
  if (!hasAnyKey) return DISABLED;

  const defaultProvider = isKnownProvider(ai.defaultProvider)
    ? ai.defaultProvider
    : DEFAULT_PROVIDER;
  const defaultModel =
    typeof ai.defaultModel === "string" && ai.defaultModel
      ? ai.defaultModel
      : DEFAULT_MODEL;

  return {
    enabled: true,
    defaultProvider,
    defaultModel,
    providers,
  };
}
