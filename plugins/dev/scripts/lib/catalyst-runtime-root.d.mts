// Types for catalyst-runtime-root.mjs (CTL-1628 Phase A2) — the runtime
// stays .mjs so bare-Node callers (doctor.mjs) and lazy `await import()`
// consumers (score-tickets.ts) import it unchanged; this gives TS
// consumers (orch-monitor) proper types. Mirrors the deployment-mode.d.mts /
// secret-contract.d.mts convention (hand-written companion, no build step).

export type DevScriptsSource = "env" | "sibling" | "cwd" | "marketplace" | "cache" | null;

export interface ResolvedDevScripts {
  path: string | null;
  source: DevScriptsSource;
}

export interface CatalystDevScriptsOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export function catalystDevScripts(
  requestingPlugin?: string,
  opts?: CatalystDevScriptsOptions,
): ResolvedDevScripts;

export function catalystPluginRoot(startDir?: string): string | null;

export type RuntimeLayout = "source-checkout" | "marketplace" | "cache" | "unknown";

export interface CatalystRuntimeLayoutOptions {
  env?: Record<string, string | undefined>;
}

export function catalystRuntimeLayout(dir?: string, opts?: CatalystRuntimeLayoutOptions): RuntimeLayout;
