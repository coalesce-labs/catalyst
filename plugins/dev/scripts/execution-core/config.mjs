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

// CTL-533: a worker whose signal has not been updated within this window is
// "stale" — a precondition for the Step G stalled scan to consult git/PR
// state. A stale signal alone is never stall evidence (CTL-32). Default 15 min,
// matching the legacy `date -u -v-15M` cutoff in orchestrate/SKILL.md.
export const STALE_WORKER_CUTOFF_MS =
  Number(process.env.EXECUTION_CORE_STALE_WORKER_CUTOFF_MS) || 15 * 60_000;
