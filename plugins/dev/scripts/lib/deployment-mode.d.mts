// Types for deployment-mode.mjs (CTL-1617) — the runtime stays .mjs so the
// broker/execution-core .mjs daemons import it unchanged (execution-core/
// config.mjs re-exports it); this gives TS consumers (orch-monitor) proper
// types. Mirrors the daemon-heartbeat.d.mts / process-memory-metric.d.mts
// convention (hand-written companion, no build step).

export type DeploymentMode = "single-host" | "cluster" | "cloud";
export type DeploymentModeSource = "env" | "layer2" | "layer1" | "default";

export const DEPLOYMENT_MODES: readonly DeploymentMode[];

export interface DeploymentModeResolution {
  mode: DeploymentMode;
  source: DeploymentModeSource;
  /** true only for the constant default — no explicit value anywhere */
  inferred: boolean;
  /** false when an explicit value was present but did not name a real deployment mode */
  recognized: boolean;
  /** the explicit value exactly as written, or null for the inferred default */
  raw: unknown;
}

export interface ResolveDeploymentModeOptions {
  /** resolution env (default process.env) */
  env?: Record<string, string | undefined>;
  /** explicit Layer-1 (.catalyst/config.json) path override */
  layer1ConfigPath?: string;
  /** explicit Layer-2 (~/.config/catalyst/config.json) path override */
  layer2ConfigPath?: string;
}

export function resolveDeploymentMode(
  opts?: ResolveDeploymentModeOptions,
): DeploymentModeResolution;

export function getDeploymentMode(opts?: ResolveDeploymentModeOptions): DeploymentMode;
