// config.mjs — broker daemon configuration: logger, env constants, log-path,
// Groq config readers. Zero broker-internal dependencies (leaf module).
//
// CTL-529: first extraction of the execution-core module split. getEventLogPath()
// lives here — not in tailer — because router, tailer, and main all consume it;
// a leaf home keeps the module dependency graph acyclic. DETERMINISTIC_INTEREST_TYPES
// lives here for the same reason: both router (maybeEmitProseDisabled / buildGroqPrompt)
// and projection (buildBrokerState) read it, so it must sit below both in the DAG.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import pino from "pino";
import { resolveApiKey, deriveGroqEndpoint } from "../lib/api-key-health.mjs";

// --- Logger ---
export const log = pino({
  name: "broker",
  level: process.env.LOG_LEVEL ?? "info",
});

// --- Config ---
export const CATALYST_DIR = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
export const GLOBAL_CONFIG_PATH = resolve(homedir(), ".config/catalyst/config.json");

// CTL-343: key resolution moved to lib/api-key-health.mjs. Read groq gateway
// alongside the key so the chat-completions endpoint can route through a
// configured proxy (e.g. Adva AI Gateway, Litellm, Helicone).
export function readGroqConfig(configPath) {
  const path = configPath ?? GLOBAL_CONFIG_PATH;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    return cfg?.groq ?? null;
  } catch {
    return null;
  }
}

// Retained as a named export for any external callers; new code should use
// resolveApiKey() from lib/api-key-health.mjs directly.
export function readGroqApiKeyFromConfig(configPath) {
  return readGroqConfig(configPath)?.apiKey ?? "";
}

const groqKeyResolution = resolveApiKey({
  envName: "GROQ_API_KEY",
  configKeyPath: "groq.apiKey",
  configPath: GLOBAL_CONFIG_PATH,
});
const groqConfig = readGroqConfig();
const groqEndpoint = deriveGroqEndpoint({ gateway: groqConfig?.gateway });

export const GROQ_API_KEY = groqKeyResolution.value;
export const GROQ_KEY_SOURCE = groqKeyResolution.source;
export const GROQ_KEY_PREFIX = groqKeyResolution.prefix;
export const GROQ_ENDPOINT = groqEndpoint.url;
export const GROQ_EXTRA_HEADERS = groqEndpoint.extraHeaders;
export const GROQ_GATEWAY_ENABLED = groqEndpoint.gatewayEnabled;
export const GROQ_GATEWAY_BASE_URL = GROQ_GATEWAY_ENABLED ? groqConfig?.gateway?.baseUrl : null;
export const GROQ_MODEL = process.env.FILTER_GROQ_MODEL ?? "llama-3.1-8b-instant";
export const DEBOUNCE_MS = parseInt(process.env.FILTER_DEBOUNCE_MS ?? "100", 10);
export const HARD_CAP_MS = parseInt(process.env.FILTER_HARD_CAP_MS ?? "500", 10);
export const MAX_BATCH_SIZE = parseInt(process.env.FILTER_BATCH_SIZE ?? "20", 10);
export const LOOKBACK_LINES = 1000;
export const WATCHDOG_INTERVAL_MS = parseInt(process.env.FILTER_WATCHDOG_INTERVAL_MS ?? "60000", 10);
export const HEARTBEAT_STALE_MS = parseInt(process.env.FILTER_HEARTBEAT_STALE_MS ?? "180000", 10);
// CTL-507: replayed orchestrator.status events older than this are skipped on
// startup so a crashed-without-terminate orchestrator is not resurrected into
// activeOrchestrators. Generous default (6h) — far longer than the gap between
// an orchestrator's phase-transition status emissions, so a live orchestrator is
// never dropped; only prunes ancient entries on quiet systems where the
// 1000-line replay window spans days.
export const ORCH_STATUS_REPLAY_STALE_MS = parseInt(
  process.env.FILTER_ORCH_STATUS_REPLAY_STALE_MS ?? "21600000", 10);

// --- Event log ---
export function getEventLogPath() {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  // Re-read CATALYST_DIR per call so tests can redirect by setting the env
  // var. Production deployments still pin a stable value via daemon launch.
  const catalystDir = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
  return resolve(catalystDir, "events", `${ym}.jsonl`);
}

// CTL-357: the interest types that route deterministically (no Groq prose
// round-trip). Read by the router (maybeEmitProseDisabled, buildGroqPrompt) and
// the projection (buildBrokerState advertises them via supportedInterestTypes),
// so it lives in this leaf module to keep both above it in the dependency DAG.
export const DETERMINISTIC_INTEREST_TYPES = new Set([
  "pr_lifecycle",
  "ticket_lifecycle",
  "comms_lifecycle",
  "phase_lifecycle",
  "workflow_substep_lifecycle",
]);
