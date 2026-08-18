// Types for github-feed-mode.mjs (CTL-1929) — the runtime stays .mjs so the
// broker/execution-core .mjs daemons and doctor's bare-Node runtime import it
// unchanged; this gives the TS consumer (orch-monitor/server.ts, the smee-tunnel
// gate) proper types. Mirrors the deployment-mode.d.mts convention it sits beside:
// hand-written companion, no build step.

export type GithubFeedMode = "off" | "shadow" | "enforce";
/** `env-invalid` is a SET but unrecognised env value — it overrides Layer-2 (CAT-57). */
export type GithubFeedModeSource = "env" | "env-invalid" | "layer2" | "default";

export const GITHUB_FEED_MODES: readonly GithubFeedMode[];
export const DEFAULT_GITHUB_FEED_MODE: GithubFeedMode;
export const MIN_INTERVAL_SEC: number;
export const DEFAULT_INTERVAL_SEC: number;

export interface GithubFeedModeResolution {
  mode: GithubFeedMode;
  /** producer tick interval; never below MIN_INTERVAL_SEC */
  intervalSec: number;
  source: GithubFeedModeSource;
}

export interface ResolveGithubFeedModeOptions {
  /** resolution env (default process.env) */
  env?: Record<string, string | undefined>;
  /** explicit Layer-2 (~/.config/catalyst/config.json) path override */
  layer2ConfigPath?: string;
}

export function resolveGithubFeedMode(
  opts?: ResolveGithubFeedModeOptions,
): GithubFeedModeResolution;

/**
 * True only for `enforce`. ⛔ Named for the RULE, not the comparison: a caller that
 * widens this to `!== "off"` closes the smee tunnel in `shadow`, where the producer
 * emits nothing authoritative — taking GitHub ingestion to zero.
 */
export function githubFeedIsAuthoritative(opts?: ResolveGithubFeedModeOptions): boolean;
