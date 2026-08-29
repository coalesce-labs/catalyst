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
// CTL-1516: horizon past which a stale session's lastHeartbeat + workerToOrchestrator
// rows are evicted even when it matched no interest (so it never entered the
// notified-cleanup path). Bounds both maps across the daemon's whole lifetime —
// phase-agent session ids are per-job-unique, so without a backstop the maps grow
// forever. Generous default (30 min ≈ 10× HEARTBEAT_STALE_MS) so only
// unambiguously-done sessions are dropped.
export const HEARTBEAT_EVICT_MS = parseInt(
  process.env.FILTER_HEARTBEAT_EVICT_MS ?? String(30 * 60 * 1000),
  10
);
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
// CTL-1423 Phase 5: channel-watcher dead-man's switch. After 3 missed intervals
// (default 3 × 60s = 3 min) the broker promotes the silence to system_down.
// Override with FILTER_WATCHER_RECENCY_STALE_MS.
export const WATCHER_RECENCY_STALE_MS = parseInt(
  process.env.FILTER_WATCHER_RECENCY_STALE_MS ?? "180000", 10);
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

// CTL-1123: broker alert-emit. The broker promotes detector signals into a stable
// catalyst.alert.{raised,cleared} topic in the event log (otel-forward ships it to
// the collector → Loki/dash0, where a separate "brain" routes to channels). Emit
// is default-on with a call-time kill-switch (parity with isIngestionRecencyEnabled
// — flip without a broker restart). system_down rides the CTL-1122 recency edges;
// The CTL-2156 system-trouble kinds are LEVEL counts debounced by threshold +
// persistence + cooldown (see SYSTEM_TROUBLE_POLICY below).
export function isAlertEmitEnabled() {
  return process.env.FILTER_ALERT_ENABLED !== "0";
}
// Parse an int env knob with a default + lower bound, warning (not silently
// degrading) on a malformed value. Without this a fat-fingered
// FILTER_PROVIDER_DEGRADED_THRESHOLD=abc → NaN → `count >= NaN` is always false → the
// detector silently never fires; =0 → always true → a spurious alert on an idle
// fleet. A bad value falls back to the default and is logged loudly.
//
// WHOLE-STRING VALIDATION (Codex round 3). `parseInt` is PREFIX-lenient: "1.5" and
// "1garbage" both parse as 1, so a partially-parsed value slipped through as a
// plausible-looking number and the warn path never ran. For
// FILTER_BROKER_DEGRADED_SUSTAINED_TICKS that silently ELIMINATED the debounce —
// the detector fired after ONE anomalous tick instead of the documented 5, while
// the operator read the env file and believed otherwise. Every knob routed through
// this helper is a whole integer (a millisecond count or a tick count); none has a
// unit suffix or a fractional form, so requiring the WHOLE (trimmed) string to be
// an integer changes nothing for any realistic existing value and routes typos to
// the warn + default path that already exists for NaN.
export function parseIntKnob(envVal, dflt, { min = 0 } = {}) {
  if (envVal === undefined) return dflt;
  const raw = typeof envVal === "string" ? envVal.trim() : envVal;
  // Reject "" / "   " / "1.5" / "1garbage" / "abc" / "1e5" — anything that is not
  // exactly an optionally-signed run of digits.
  const n = /^[+-]?\d+$/.test(String(raw)) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < min) {
    log.warn({ envVal, dflt, min }, "alert config: invalid knob value — using default");
    return dflt;
  }
  return n;
}
// CTL-2156 — the SYSTEM-trouble alert policy, one row per alert kind.
//
// Replaces the retired FILTER_PILEUP_* knobs (which tuned `needs_human_pileup`,
// a count of Linear needs-human LABELS — the per-ticket escalation artifact, not
// the condition). Each kind is now tuned independently because they have
// genuinely different shapes:
//
//   threshold      how many DISTINCT affected things (tickets / accounts / nodes)
//                  must be in trouble at once. >1 for provider_degraded so a
//                  single unlucky ticket is not an outage; 1 for the others,
//                  where one exhausted account or one slotless node IS the fact.
//   windowMs       how long one observation keeps its key "in trouble" with no
//                  further news. Also the auto-clear BACKSTOP for producers that
//                  only ever report trouble (sdk.overloaded never says "I'm fine").
//   persistenceMs  how long the level must hold before raising. 0 where the
//                  window itself is already the debounce; non-zero for capacity,
//                  which dips through 0 transiently during autotune.
//   cooldownMs     minimum gap after a clear before a re-raise (flap guard).
//
// A bad value falls back to the default and is logged loudly (parseIntKnob).
export const SYSTEM_TROUBLE_POLICY = Object.freeze({
  provider_degraded: Object.freeze({
    threshold: parseIntKnob(process.env.FILTER_PROVIDER_DEGRADED_THRESHOLD, 2, { min: 1 }),
    windowMs: parseIntKnob(process.env.FILTER_PROVIDER_DEGRADED_WINDOW_MS, 600000, { min: 1000 }),
    persistenceMs: parseIntKnob(process.env.FILTER_PROVIDER_DEGRADED_PERSISTENCE_MS, 0, { min: 0 }),
    cooldownMs: parseIntKnob(process.env.FILTER_PROVIDER_DEGRADED_COOLDOWN_MS, 1800000, { min: 0 }),
  }),
  rate_limit_exhausted: Object.freeze({
    threshold: parseIntKnob(process.env.FILTER_RATE_LIMIT_THRESHOLD, 1, { min: 1 }),
    windowMs: parseIntKnob(process.env.FILTER_RATE_LIMIT_WINDOW_MS, 1800000, { min: 1000 }),
    persistenceMs: parseIntKnob(process.env.FILTER_RATE_LIMIT_PERSISTENCE_MS, 0, { min: 0 }),
    cooldownMs: parseIntKnob(process.env.FILTER_RATE_LIMIT_COOLDOWN_MS, 1800000, { min: 0 }),
  }),
  capacity_unavailable: Object.freeze({
    threshold: parseIntKnob(process.env.FILTER_CAPACITY_THRESHOLD, 1, { min: 1 }),
    windowMs: parseIntKnob(process.env.FILTER_CAPACITY_WINDOW_MS, 3600000, { min: 1000 }),
    persistenceMs: parseIntKnob(process.env.FILTER_CAPACITY_PERSISTENCE_MS, 120000, { min: 0 }),
    cooldownMs: parseIntKnob(process.env.FILTER_CAPACITY_COOLDOWN_MS, 1800000, { min: 0 }),
  }),
  // CTL-2159 — tickets stalled on a SYSTEM condition with no telemetry producer
  // of their own (spent retry budgets, watchdog kills, wedged workers). Threshold
  // 2 for the same reason provider_degraded uses 2: one unlucky ticket is not a
  // fleet condition, and this kind's whole job is the fan-in. The window is long
  // (1h) because these stalls are sparse — one every few minutes across the fleet
  // — and a 10-minute window would let a real, sustained condition drop below
  // threshold between arrivals and flap.
  system_stall: Object.freeze({
    threshold: parseIntKnob(process.env.FILTER_SYSTEM_STALL_THRESHOLD, 2, { min: 1 }),
    windowMs: parseIntKnob(process.env.FILTER_SYSTEM_STALL_WINDOW_MS, 3600000, { min: 1000 }),
    persistenceMs: parseIntKnob(process.env.FILTER_SYSTEM_STALL_PERSISTENCE_MS, 0, { min: 0 }),
    cooldownMs: parseIntKnob(process.env.FILTER_SYSTEM_STALL_COOLDOWN_MS, 1800000, { min: 0 }),
  }),
});

// account.ratelimit.sampled is a GAUGE: at or above this 5h-usage percentage the
// account counts as an exhausted budget, and below it the observation RETRACTS
// (an edge-accurate auto-clear rather than waiting out the window).
export const ACCOUNT_EXHAUSTED_PCT = parseIntKnob(process.env.FILTER_ACCOUNT_EXHAUSTED_PCT, 100, {
  min: 1,
});

// CTL-1523: broker-degraded detector (the CTL-352 empty-interests signal, fixed —
// and then deliberately parked). OPT-IN: unset (the default) means the detector
// evaluates nothing and emits nothing.
//
// WHY DORMANT BY DEFAULT. Under EXECUTION-CORE DISPATCH the trip condition carries
// no information, because one of its two conjuncts is PERMANENTLY true:
// `interests.size === 0` can never be false. The execution-core daemon runs no
// `filter.register` producer at all, and neither in-router auto-register path can
// break the tie: `_autoRegisterPrLifecycle` only fires when an agent reports a
// claimed_pr, and `_autoPrLifecycleFromTicket` only fires when an EXISTING interest
// already watches the ticket, so an empty table stays empty. With that conjunct
// pinned true the gate degenerates to "the fleet has been active for N contiguous
// ticks", which would emit roughly one degraded/recovered pair per busy/idle cycle —
// trading the CTL-352 restart-driven false positive for a busy-window-driven one.
// Not a trade worth making, and execution-core is what every current host runs.
//
// WHY IT IS KEPT — and where it used to be worth enabling. The empty-table
// property belongs to execution-core dispatch, NOT to every configuration named
// `phase-agents`. A LEGACY-WAVE host (one driving `/catalyst-legacy:orchestrate`,
// which invoked plugins/dev/scripts/orchestrate-register-interests.sh) USED TO
// register interests: that script emitted pr_lifecycle + ticket_lifecycle +
// comms_lifecycle UNCONDITIONALLY, plus a per-ticket phase_lifecycle interest when
// `dispatchMode` was `phase-agents`. On such a host an empty interest table WAS
// anomalous and the conjunct genuinely discriminated — but that deployment no
// longer exists: the wave orchestrator was removed along with the
// `catalyst-legacy` plugin (CTL-2241), so there is currently no host on which
// FILTER_BROKER_DEGRADED_ENABLED=1 is appropriate.
//
// THIS IS NOT A DEAD-BROKER DETECTOR — and neither is CTL-1122's `checkSourceRecency`
// over RECENCY_SOURCES (router.mjs), despite both living in this process. That is the
// point: BOTH run INSIDE the broker, so once the broker dies neither can emit
// anything. checkSourceRecency detects an ingestion STALL (an upstream source —
// monitor/GitHub — gone silent) while the broker is ALIVE, emitting
// `catalyst.ingestion.stale` + `catalyst.alert.raised(system_down)`; that is the
// signal to trust for "has ingestion stopped". Detecting a FULLY DEAD broker requires
// an EXTERNAL absence check on the broker's own heartbeat/log series — a Loki
// `absent_over_time` alert on `broker.daemon.heartbeat` or the broker `.log` stream
// (absence, because a dead daemon is a MISSING series that `count_over_time == 0`
// cannot assert).
//
// The check is call-time (parity with isAlertEmitEnabled), so it takes effect without
// a code reload — but changing it STILL REQUIRES A BROKER RESTART (Codex P2, #2740).
// A running daemon's process.env is fixed at launch and nothing in this repo mutates
// the flag at runtime, so editing the env file or exporting in a shell does not reach
// a live broker; without the restart an operator can believe the detector is armed
// while it is still dormant. Flipping it OFF discards any in-progress debounce run,
// so a re-enable always re-earns the full sustained-tick threshold; an already-open
// episode survives the switch and still emits its paired `recovered`.
export function isBrokerDegradedDetectorEnabled() {
  return process.env.FILTER_BROKER_DEGRADED_ENABLED === "1";
}
// Startup grace before an empty interest table can be judged at all (unchanged
// 5-minute default — it was the CTL-352 DEGRADED_THRESHOLD_MS).
export const BROKER_DEGRADED_GRACE_MS = parseIntKnob(
  process.env.FILTER_BROKER_DEGRADED_GRACE_MS, 300000, { min: 0 });
// Consecutive anomalous watchdog ticks (~60s each) required before the degraded
// edge fires — a single-tick blip (e.g. a worker row that just went fresh while
// interests are mid-reload) must not page.
export const BROKER_DEGRADED_SUSTAINED_TICKS = parseIntKnob(
  process.env.FILTER_BROKER_DEGRADED_SUSTAINED_TICKS, 5, { min: 1 });

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
