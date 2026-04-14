import { readFileSync } from "fs";

export interface AiConfig {
  enabled: boolean;
  gateway?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
}

const DISABLED: AiConfig = { enabled: false };
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function readJsonSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function loadAiConfig(
  projectConfigPath: string,
  secretsConfigPath: string,
): AiConfig {
  const project = readJsonSafe(projectConfigPath);
  if (!isRecord(project)) return DISABLED;

  const catalyst = isRecord(project.catalyst) ? project.catalyst : null;
  if (!catalyst) return DISABLED;

  const aiProject = isRecord(catalyst.ai) ? catalyst.ai : null;
  if (!aiProject || aiProject.enabled !== true) return DISABLED;

  const secrets = readJsonSafe(secretsConfigPath);
  if (!isRecord(secrets)) return DISABLED;

  const aiSecrets = isRecord(secrets.ai) ? secrets.ai : null;
  if (!aiSecrets) return DISABLED;

  const gateway =
    typeof aiSecrets.gateway === "string" ? aiSecrets.gateway : "";
  const apiKey = typeof aiSecrets.apiKey === "string" ? aiSecrets.apiKey : "";

  if (!gateway || !apiKey) return DISABLED;

  const provider =
    typeof aiSecrets.provider === "string" && aiSecrets.provider
      ? aiSecrets.provider
      : DEFAULT_PROVIDER;
  const model =
    typeof aiSecrets.model === "string" && aiSecrets.model
      ? aiSecrets.model
      : DEFAULT_MODEL;

  return { enabled: true, gateway, provider, model, apiKey };
}
