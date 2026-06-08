// config.mjs — execution-core Todo-state monitor configuration: logger, env
// constants, path resolvers, poll/debounce intervals. Zero internal deps
// (leaf module), mirroring broker/config.mjs (CTL-529).
//
// CTL-535: the M4 scheduler's eligible-set monitor. Path resolvers re-read
// CATALYST_DIR per call so tests redirect by setting the env var; production
// daemons pin a stable value at launch.

import { homedir, hostname } from "node:os";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// --- Logger (CTL-578) ---
// Pino is the daemon's runtime logger. A worktree checkout that hasn't run
// `bun install` cannot resolve it — and any module graph that includes
// config.mjs (registry.mjs, monitor.mjs, …) used to crash at module-load
// before any code ran. Wrap the import in try/catch and substitute a
// console-shim with the same pino-compatible surface so callers degrade
// gracefully instead of aborting.
let log;
try {
  const { default: pino } = await import("pino");
  log = pino({
    name: "execution-core",
    level: process.env.LOG_LEVEL ?? "info",
  });
} catch (err) {
  const emit = (level) => (...args) => {
    // pino-style: log.info(obj, msg) OR log.info(msg). Console-shim flattens.
    const stream =
      level === "error" || level === "fatal" ? process.stderr : process.stdout;
    stream.write(
      `[execution-core:${level}] ${args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ")}\n`,
    );
  };
  log = {
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    debug: emit("debug"),
    fatal: emit("fatal"),
    trace: emit("trace"),
    child: () => log,
  };
  process.stderr.write(
    `[execution-core] WARN: pino unavailable (${err?.message ?? err}); using console shim\n`,
  );
}
export { log };

// --- Paths ---
// Re-resolved per call so tests can redirect by setting CATALYST_DIR;
// production launches pin a stable value.
function catalystDir() {
  return process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
}

export function getExecutionCoreDir() {
  return resolve(catalystDir(), "execution-core");
}

export function getEligibleDir() {
  return resolve(getExecutionCoreDir(), "eligible");
}

// The durable event-log tailer cursor — monitor.mjs persists its byte offset
// here so a daemon restart resumes the fast path instead of re-seeding at EOF.
export function getCursorPath() {
  return resolve(getExecutionCoreDir(), "cursor.json");
}

// CTL-564: the central execution-core registry — the single source for
// team → repoRoot → eligibleQuery. The D4 successor to the per-repo
// enrollment records; all access flows through registry.mjs (the D9 cloud
// seam — file today, a Supabase table later).
export function getRegistryPath() {
  return resolve(getExecutionCoreDir(), "registry.json");
}

// Root for orchestrator run dirs — ~/catalyst/runs/<orchId>/. Each holds a
// workers/<TICKET>/phase-<P>.json signal tree. The audit CLI (CTL-649 Phase 5)
// walks this to join live `claude agents` sessions onto their worker signals.
// Re-resolved per call so tests redirect via CATALYST_DIR.
export function getRunsRoot() {
  return resolve(catalystDir(), "runs");
}

// Root for `claude --bg` job state dirs — ~/.claude/jobs/<bg_job_id>/state.json.
// Env name matches orchestrate-healthcheck's CATALYST_HEALTHCHECK_JOBS_ROOT so
// tests override one variable for both.
export function getJobsRoot() {
  return (
    process.env.CATALYST_HEALTHCHECK_JOBS_ROOT ??
    resolve(homedir(), ".claude", "jobs")
  );
}

// The unified monthly event log. UTC month to match the writer —
// orch-monitor/lib/event-writer.ts uses getUTCFullYear/getUTCMonth, so the
// tailer must resolve the same path or it would follow the wrong file.
export function getEventLogPath() {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return resolve(catalystDir(), "events", `${ym}.jsonl`);
}

// --- Host identity + cluster roster (CTL-859) ---
// PR1 of the distributed-coordination epic. ADDITIVE foundation: a configurable
// host name + a committed cluster roster, read here so later PRs (HRW ownership,
// Linear-CAS claim, takeover/healing) have one source of truth. Nothing in the
// dispatch/claim/eligible-query path consults these yet.

// Layer-2 (machine-local) config path. Mirrors daemon.mjs main()'s resolution:
// CATALYST_LAYER2_CONFIG_FILE || ~/.config/catalyst/config.json. Each host's
// Layer-2 file differs, so this is the right home for a per-host name.
function getLayer2ConfigPath() {
  return (
    process.env.CATALYST_LAYER2_CONFIG_FILE ||
    resolve(homedir(), ".config", "catalyst", "config.json")
  );
}

// The repo root that owns the committed cluster roster (.catalyst/hosts.json).
// CATALYST_CONFIG_FILE points at <repoRoot>/.catalyst/config.json (mirrors the
// reaper-config resolution in daemon.mjs main()); otherwise fall back to the
// daemon's cwd. Re-resolved per call so tests can redirect via the env var.
function getCatalystRepoDir() {
  const cfgFile = process.env.CATALYST_CONFIG_FILE;
  if (cfgFile) {
    // <repoRoot>/.catalyst/config.json → <repoRoot>/.catalyst
    return resolve(cfgFile, "..");
  }
  return resolve(process.cwd(), ".catalyst");
}

// getHostName — resolve this host's coordination name. Precedence:
//   1. CATALYST_HOST_NAME env (test/alias override; matches lib/host-identity.mjs)
//   2. catalyst.host.name in the Layer-2 (machine-local) config file
//   3. os.hostname() with a trailing ".local" stripped (the bare mDNS suffix)
// Never throws — an unreadable/malformed Layer-2 file falls through to the
// hostname default. The result is the membership key HRW hashing will use.
export function getHostName() {
  const envOverride = process.env.CATALYST_HOST_NAME;
  if (typeof envOverride === "string" && envOverride.length > 0) return envOverride;
  try {
    const parsed = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"));
    const name = parsed?.catalyst?.host?.name;
    if (typeof name === "string" && name.length > 0) return name;
  } catch {
    /* missing/malformed Layer-2 file → hostname default */
  }
  return hostname().replace(/\.local$/, "");
}

// getClusterHosts — read the committed cluster roster from
// <repoRoot>/.catalyst/hosts.json (a JSON array of host names). When the file
// is absent, unreadable, malformed, or not a non-empty array of strings, fall
// back to the single-host default ([getHostName()]) — the safe behavior for the
// current single-primary deployment. Never throws.
export function getClusterHosts() {
  try {
    const raw = readFileSync(resolve(getCatalystRepoDir(), "hosts.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const hosts = parsed.filter((h) => typeof h === "string" && h.length > 0);
      if (hosts.length > 0) return hosts;
    }
  } catch {
    /* absent/malformed roster → single-host default */
  }
  return [getHostName()];
}

// CTL-859 — node-heartbeat cadence. The daemon appends one node.heartbeat event
// to the unified event log every interval so a future liveness reader can decide
// "dead" = no heartbeat for a generous grace window (see the design doc: 5–10 min
// to bias hard against false eviction). Env-overridable for tests/tuning.
export const HEARTBEAT_INTERVAL_MS =
  Number(process.env.EXECUTION_CORE_HEARTBEAT_INTERVAL_MS) || 30_000;

// --- Intervals ---
// The periodic reconcile poll — the missed-webhook correctness backstop.
export const RECONCILE_INTERVAL_MS =
  Number(process.env.EXECUTION_CORE_RECONCILE_INTERVAL_MS) || 10 * 60_000;

// Debounce window: state_changed events that enter the eligible state coalesce
// into one reconcile poll per affected project per burst.
export const EVENT_DEBOUNCE_MS =
  Number(process.env.EXECUTION_CORE_DEBOUNCE_MS) || 5_000;

// CTL triage-entry fix (Phase 0): poll interval for draining the unified event
// log. The fs.watch tailer (startTailing) is unreliable for cross-process
// appends on macOS — it often never fires, leaving live webhook events
// undrained until the 10-min reconcile or a restart. This short poll calls
// readNewEvents() deterministically so new-work discovery is near-instant.
// readNewEvents is cheap (fstat + read of only the bytes appended since the
// durable cursor) and idempotent, so a tight interval is safe.
export const TAILER_POLL_INTERVAL_MS =
  Number(process.env.EXECUTION_CORE_TAILER_POLL_MS) || 2_000;

// CTL-533: a worker whose signal has not been updated within this window is
// "stale" — a precondition for the Step G stalled scan to consult git/PR
// state. A stale signal alone is never stall evidence (CTL-32). Default 15 min,
// matching the legacy `date -u -v-15M` cutoff in orchestrate/SKILL.md.
export const STALE_WORKER_CUTOFF_MS =
  Number(process.env.EXECUTION_CORE_STALE_WORKER_CUTOFF_MS) || 15 * 60_000;

// CTL-662 — busy-forever backstop ceiling. With STALE_MS / HUNG_CUTOFF_MS gone,
// this is the SOLE long backstop: a worker that stays `busy` past this elapsed
// time with no committed work flags for human (escalateOnce) — NEVER a silent
// reclaim-and-advance. Deliberately high (6h) so a legitimate multi-hour
// sub-agent fan-out or a future Linear-webhook waiter never trips it; only a
// genuinely wedged worker does. Env-overridable for tuning.
export const BUSY_CEILING_MS =
  Number(process.env.EXECUTION_CORE_BUSY_CEILING_MS) || 6 * 60 * 60_000;

// CTL-809 — ghost-breaker just-dispatched grace. The reclaim alive-branch
// cross-checks the FRESH `claude agents` snapshot to catch a jobLifecycle-alive
// worker whose process is actually gone (CC 2.x never flips a crashed/wedged
// --bg worker's local state.json terminal, so jobLifecycle reports it alive
// forever). A worker younger than this may simply not have registered in
// `claude agents` yet, so its absence is NOT proof of death — only reclaim on
// absence once past this window. Comfortably exceeds observed `claude --bg`
// registration latency + one warmer interval. Env-overridable.
export const GHOST_GRACE_MS =
  Number(process.env.EXECUTION_CORE_GHOST_GRACE_MS) || 90_000;

// CTL-735 — revival age ceiling (KEPT in CTL-736). `isTicketInFlight` treats any
// ticket with a non-terminal signal as in-flight, so a worker that crashed at
// `running` and never flipped terminal stays swept forever. A reclaim-eligible
// worker whose signal has not been touched in this long is an abandoned historical
// dir (a long-since Done or dead ticket), NOT a fresh crash — it is treated as
// inert (no revive, no escalate) BEFORE the Phase-3 progress gate, so the ~85
// day-stale debris dirs do not each get a one-shot no-progress needs-human flag.
// Deliberately well above any real phase duration (24h) — a genuine multi-hour
// crash is still revived; only a day-stale signal is inert. A signal with no
// parseable timestamp falls through (cannot judge age). Env-overridable.
export const REVIVE_MAX_AGE_MS =
  Number(process.env.EXECUTION_CORE_REVIVE_MAX_AGE_MS) || 24 * 60 * 60_000;

// CTL-650 — the push-based session wait-state watcher. Default ON; the daemon
// continuously classifies live sessions and emits agent.waiting_on_user /
// agent.resumed transition events. CATALYST_WAIT_WATCHER=0 disables it (the
// test/opt-out knob, mirroring EXECUTION_CORE_DISABLE_REAPER). The tick cadence
// reuses EVENT_DEBOUNCE_MS (env-tunable via EXECUTION_CORE_DEBOUNCE_MS) so the
// watcher's enumeration sweep runs at the same order as the reaper sweep.
export function readWaitWatcherConfig() {
  return {
    enabled: process.env.CATALYST_WAIT_WATCHER !== "0",
    intervalMs: EVENT_DEBOUNCE_MS,
  };
}

// CTL-685 — per-worker memory sampler constants. Exported as named constants
// for callers that want a single snapshot; readMemorySamplerConfig() re-reads
// from process.env on every call so tests can manipulate env vars freely.
export const MEMORY_SAMPLE_INTERVAL_MS =
  Number(process.env.EXECUTION_CORE_MEMORY_SAMPLE_INTERVAL_MS) || 30_000;

export const WORKER_RSS_WARN_MB =
  Number(process.env.EXECUTION_CORE_WORKER_RSS_WARN_MB) || 1500;

export const WORKER_RSS_KILL_MB =
  Number(process.env.EXECUTION_CORE_WORKER_RSS_KILL_MB) || 4000;

export const WORKER_OOM_KILLER =
  process.env.EXECUTION_CORE_WORKER_OOM_KILLER !== "0";

export const KILL_SUSTAINED_SAMPLES =
  Number(process.env.EXECUTION_CORE_KILL_SUSTAINED_SAMPLES) || 3;

export function readMemorySamplerConfig() {
  return {
    enabled: process.env.CATALYST_MEMORY_SAMPLER !== "0",
    intervalMs: Number(process.env.EXECUTION_CORE_MEMORY_SAMPLE_INTERVAL_MS) || 30_000,
    warnThresholdMb: Number(process.env.EXECUTION_CORE_WORKER_RSS_WARN_MB) || 1500,
    killThresholdMb: Number(process.env.EXECUTION_CORE_WORKER_RSS_KILL_MB) || 4000,
    killEnabled: process.env.EXECUTION_CORE_WORKER_OOM_KILLER !== "0",
    killSustainedSamples: Number(process.env.EXECUTION_CORE_KILL_SUSTAINED_SAMPLES) || 3,
  };
}

// CTL-787 — account-level Claude rate-limit usage poller. Re-reads from
// process.env on every call so tests can manipulate env vars freely (mirrors
// readMemorySamplerConfig). The poller floors intervalMs at 180s internally;
// the default cadence here is ~5 min.
export function readRatelimitPollerConfig() {
  return {
    enabled: process.env.CATALYST_RATELIMIT_POLLER !== "0",
    intervalMs: Number(process.env.EXECUTION_CORE_RATELIMIT_POLL_INTERVAL_MS) || 300000,
    usageEndpoint:
      process.env.EXECUTION_CORE_RATELIMIT_USAGE_ENDPOINT ||
      "https://api.anthropic.com/api/oauth/usage",
  };
}

// --- Auto-tuner (CTL-684) ---
// Sample cadence — how often the auto-tuner polls load + memory.
export const AUTOTUNE_SAMPLE_INTERVAL_MS =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_SAMPLE_INTERVAL_MS) || 30_000;

// Rolling window depth (number of samples ≈ window_seconds/cadence).
export const AUTOTUNE_WINDOW_SAMPLES =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_WINDOW_SAMPLES) || 10;

// Consecutive samples required before a trend is declared.
export const AUTOTUNE_TREND_MIN_SAMPLES =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_TREND_MIN_SAMPLES) || 3;

// Load average "safe" multiplier — load1 must be below cores × factor for a
// down-trend decision to proceed.
export const AUTOTUNE_LOAD_SAFE_FACTOR =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_LOAD_SAFE_FACTOR) || 4;

// Memory-free threshold for critical guard (below this → drop to minParallel).
export const AUTOTUNE_MEM_CRITICAL_PCT =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_MEM_CRITICAL_PCT) || 5;

// Memory-free threshold for warn guard (below this → suppress growth).
export const AUTOTUNE_MEM_WARN_PCT =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_MEM_WARN_PCT) || 20;

// Kill-switch: EXECUTION_CORE_AUTOTUNE=0 disables all sampling and Layer-2 writes.
export const AUTOTUNE_ENABLED = process.env.EXECUTION_CORE_AUTOTUNE !== "0";

// --- Claude-attributable resource control law (CTL-775) ---
// High-water mark for Claude-attributable cpu/mem (% of whole host). Above this
// → shed; below it (minus deadband) → we have headroom to scale up.
export const AUTOTUNE_CLAUDE_RESOURCE_HIGH_WATER_PCT =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_CLAUDE_HIGH_WATER_PCT) || 75;

// Hysteresis around the high-water so a sample straddling the line doesn't flap
// between scale-up and shed.
export const AUTOTUNE_ATTRIBUTION_DEADBAND_PCT =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_ATTRIBUTION_DEADBAND_PCT) || 5;

// Step sizes for the saturation-gated scale-up and the over-provisioned
// drift-down toward the setpoint.
export const AUTOTUNE_SCALE_UP_STEP =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_SCALE_UP_STEP) || 1;
export const AUTOTUNE_DRIFT_DOWN_STEP =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_DRIFT_DOWN_STEP) || 1;

// Multiplicative shed factor applied when Claude-attributable resources hit the
// high-water (reuses the legacy ×0.75 trend-up shed factor).
export const AUTOTUNE_CLAUDE_SHED_FACTOR =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_CLAUDE_SHED_FACTOR) || 0.75;
