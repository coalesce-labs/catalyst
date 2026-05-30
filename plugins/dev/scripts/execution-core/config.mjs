// config.mjs — execution-core Todo-state monitor configuration: logger, env
// constants, path resolvers, poll/debounce intervals. Zero internal deps
// (leaf module), mirroring broker/config.mjs (CTL-529).
//
// CTL-535: the M4 scheduler's eligible-set monitor. Path resolvers re-read
// CATALYST_DIR per call so tests redirect by setting the env var; production
// daemons pin a stable value at launch.

import { homedir } from "node:os";
import { resolve } from "node:path";

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

// CTL-662 — idle-confirmation streak length. A phase worker observed `idle` by
// `claude agents` is reclaim-eligible only after this many CONSECUTIVE idle
// observations (a counter persisted on the signal, NOT an mtime window). A
// couple of ticks confirms the worker is genuinely between-turns done, not
// momentarily idle between sub-agent fan-out rounds. Env-overridable so tuning
// from real failures needs no code change (the operator decision on the ticket).
export const IDLE_CONFIRM_TICKS =
  Number(process.env.EXECUTION_CORE_IDLE_CONFIRM_TICKS) || 2;

// CTL-662 — busy-forever backstop ceiling. With STALE_MS / HUNG_CUTOFF_MS gone,
// this is the SOLE long backstop: a worker that stays `busy` past this elapsed
// time with no committed work flags for human (escalateOnce) — NEVER a silent
// reclaim-and-advance. Deliberately high (6h) so a legitimate multi-hour
// sub-agent fan-out or a future Linear-webhook waiter never trips it; only a
// genuinely wedged worker does. Env-overridable for tuning.
export const BUSY_CEILING_MS =
  Number(process.env.EXECUTION_CORE_BUSY_CEILING_MS) || 6 * 60 * 60_000;

// CTL-735 — post-(re)dispatch grace window for the `absent` liveness class. A
// worker whose bg_job_id is `absent` from the eventually-consistent `claude
// agents` snapshot but whose signal was (re)dispatched within this window has
// almost certainly just not registered yet (a fresh `claude --bg` takes seconds
// to appear, slower under load) — NOT crashed. The reclaim sweep defers reviving
// it until the window elapses: the missing analog of IDLE_CONFIRM_TICKS for
// `absent`. Without it, the de-starved fast tick (CTL-731, ~2-4s) re-classifies
// each just-revived worker as dead and revives it again → the revive storm.
// Deliberately generous (90s) so a fresh worker registers even under high load,
// while a genuinely-crashed fresh worker waits at most this long before revive.
// Env-overridable for tuning from real failures.
export const REVIVE_GRACE_MS =
  Number(process.env.EXECUTION_CORE_REVIVE_GRACE_MS) || 90_000;

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
