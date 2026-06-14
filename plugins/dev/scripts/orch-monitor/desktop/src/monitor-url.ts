// monitor-url.ts — resolve the URL the orch-monitor desktop window opens
// (CTL-1112). Single source of truth for the window target; the build/dev
// pre-step (write-window-url.ts) evaluates this against process.env and writes
// the result for the Rust window builder to read. Pure + env-injectable so the
// pre-step passes process.env while tests pass a literal — mirrors
// cli/lib/read-model-url.ts:30.

/** Default target: the remote mini orch-monitor (server.ts:458 binds :7400). */
export const DEFAULT_MONITOR_URL = "http://mini.rozich.com:7400/";

/** A plain string→string|undefined record so callers can pass process.env. */
export type MonitorUrlEnv = Record<string, string | undefined>;

/**
 * Resolve the desktop window's target URL.
 *
 * Precedence:
 *   1. CATALYST_MONITOR_URL (trimmed; trailing slashes normalized to one).
 *   2. DEFAULT_MONITOR_URL ("http://mini.rozich.com:7400/").
 *
 * The returned value always ends in exactly one "/".
 */
export function resolveMonitorUrl(env: MonitorUrlEnv): string {
  const explicit = (env.CATALYST_MONITOR_URL ?? "").trim();
  if (!explicit) return DEFAULT_MONITOR_URL;
  return `${explicit.replace(/\/+$/, "")}/`;
}
