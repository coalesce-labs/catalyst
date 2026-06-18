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
import { dirname, resolve, sep } from "node:path";
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

// CTL-1122: out-of-process ingestion-silence detector (PR1 = monitor recency).
// The broker is the surviving process that judges the orch-monitor's liveness
// from its catalyst.monitor heartbeat recency (the monitor's own kind:"self"
// probe can't observe its own death — the 11h-outage SPOF). Default-on,
// emit-only (the broker emits catalyst.ingestion.{stale,recovered} but takes no
// corrective action). Kill-switch: CATALYST_INGESTION_RECENCY=0. Read at call
// time (not a load-time const) so an operator can flip the switch without a
// broker restart — parity with getEventLogPath's per-call env read.
export function isIngestionRecencyEnabled() {
  return process.env.CATALYST_INGESTION_RECENCY !== "0";
}
// Thresholds tuned to the monitor's fixed ~30 s heartbeat cadence: 3 min ≈ 6
// missed beats (degraded), 10 min ≈ 20 missed beats (down → alarm). Tight and
// defensible — github/linear recency (which idles organically) is PR2.
export const MONITOR_RECENCY_DEGRADED_MS = parseInt(
  process.env.FILTER_MONITOR_RECENCY_DEGRADED_MS ?? "180000", 10);
export const MONITOR_RECENCY_DOWN_MS = parseInt(
  process.env.FILTER_MONITOR_RECENCY_DOWN_MS ?? "600000", 10);
// CTL-1122 PR2: github webhook recency. Unlike the monitor's fixed cadence,
// github traffic idles organically, so these are activity-gated (only judged
// while a worker is in-flight — see hasActiveWorkers) AND wide: a worker can be
// mid-implement for many minutes with zero github traffic (work is local before
// a push), so the gate removes idle-fleet false alarms while the threshold
// absorbs active-but-pre-push quiet. 15m degraded / 30m down.
export const GITHUB_RECENCY_DEGRADED_MS = parseInt(
  process.env.FILTER_GITHUB_RECENCY_DEGRADED_MS ?? "900000", 10);
export const GITHUB_RECENCY_DOWN_MS = parseInt(
  process.env.FILTER_GITHUB_RECENCY_DOWN_MS ?? "1800000", 10);
// linear (catalyst.linear) recency is DEFERRED in PR2 (fork a): the
// linear-webhook bot-skip guard suppresses bot-authored events pre-log, so the
// source goes quiet even during active work. Its knobs
// (FILTER_LINEAR_RECENCY_{DEGRADED,DOWN}_MS) are intentionally not defined until
// a non-flaky threshold is found and linear is wired into RECENCY_SOURCES.
// Flap guard: minimum gap between a recovery and the next stale alarm. A death
// that begins within this window is DEFERRED (re-checked each tick), never
// dropped — see nextRecencyAlarmState.
export const INGESTION_RECENCY_HOLDDOWN_MS = parseInt(
  process.env.FILTER_INGESTION_RECENCY_HOLDDOWN_MS ?? "600000", 10);
// Bytes of the log tail re-read once at broker start to warm the per-service
// last-seen map, so a broker that (re)starts while the monitor is ALREADY dead
// can still detect the stale ingestion (an empty map fails open to "unknown"
// forever). 16 MiB ≈ hours of history even on a busy fleet, and far cheaper than
// the full-file read loadExistingRegistrations already does at boot.
export const INGESTION_SEED_BYTES = parseInt(
  process.env.FILTER_INGESTION_SEED_BYTES ?? String(16 * 1024 * 1024), 10);

// --- Event log ---
export function getEventLogPath() {
  const now = new Date();
  // CTL-1086: use UTC month (parity with execution-core/config.mjs) so
  // fleet hosts never disagree at the midnight-UTC month boundary.
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  // Re-read CATALYST_DIR per call so tests can redirect by setting the env
  // var. Production deployments still pin a stable value via daemon launch.
  const home = process.env.HOME ?? homedir();
  const catalystDir = process.env.CATALYST_DIR ?? `${home}/catalyst`;
  return resolve(catalystDir, "events", `${ym}.jsonl`);
}

// CTL-1122: the immediately-prior UTC-month event-log path (same UTC math as
// getEventLogPath, year rolled at January). The ingestion-recency seed falls
// back to this when the current-month file holds no monitor heartbeat — so a
// broker that (re)starts just after a month rollover, while the monitor is
// already dead, still finds the last beat (which lives in the prior file).
export function getPrevMonthEventLogPath() {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const ym = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
  const home = process.env.HOME ?? homedir();
  const catalystDir = process.env.CATALYST_DIR ?? `${home}/catalyst`;
  return resolve(catalystDir, "events", `${ym}.jsonl`);
}

// CTL-1086: sentinel guard — drop synthetic test events aimed at the default
// production log. Parity with shell layer in canonical-event.sh.
export const SENTINEL_ORCHIDS = new Set(["orch-test"]);

export function defaultProductionEventsDir() {
  // Prefer process.env.HOME so tests can override the "default production"
  // path without depending on the platform homedir() syscall (macOS ignores HOME).
  const home = process.env.HOME ?? homedir();
  return resolve(`${home}/catalyst`, "events");
}

// A leak = sentinel-stamped event whose resolved write path is the default
// production events dir. Tests writing to their own CATALYST_DIR are unaffected.
export function isSentinelLeak(event, logPath) {
  const orch = event?.resource?.["catalyst.orchestration"] ?? event?.orchestrator;
  if (!SENTINEL_ORCHIDS.has(orch)) return false;
  const prodDir = defaultProductionEventsDir();
  const resolvedLog = resolve(logPath);
  return resolvedLog.startsWith(prodDir + sep) || dirname(resolvedLog) === prodDir;
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
