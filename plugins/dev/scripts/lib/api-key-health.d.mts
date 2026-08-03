// Type declarations for api-key-health.mjs (CTL-343) — kept in sync manually with the
// runtime module, mirroring the dsl-compile.d.mts / secret-contract.d.mts convention (no
// build step; orch-monitor's tsconfig has no `allowJs`, so any `.mjs` a `.ts`/`.tsx` file
// imports directly needs a companion `.d.mts` or strict mode's noImplicitAny fails it).
//
// CTL-1616 PR5: added because orch-monitor/cli/hud.tsx now imports resolveApiKey directly
// (folding its GROQ_API_KEY resolution onto the same shared resolver broker/config.mjs
// already uses — see hud.tsx's PR5 comment for the fold rationale).

export type ApiKeySource = "env" | "project-config" | "config" | null;

export interface ResolveApiKeyOptions {
  envName?: string;
  configKeyPath: string;
  /** Global config file path. Defaults to ~/.config/catalyst/config.json */
  configPath?: string;
  /** Optional per-project config file path, checked before the global config. */
  projectConfigPath?: string;
}

export interface ResolvedApiKey {
  value: string;
  source: ApiKeySource;
  prefix: string | null;
}

export function resolveApiKey(opts: ResolveApiKeyOptions): ResolvedApiKey;

export function formatMissingKeyWarning(opts: {
  name: string;
  envName: string;
  configPath: string;
  configKeyPath: string;
  getUrl: string;
}): string;

export function formatLoadedKeyInfo(opts: {
  name: string;
  source: ApiKeySource;
  prefix: string | null;
}): string;

export interface GroqGatewayConfig {
  enabled?: boolean;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface DerivedGroqEndpoint {
  url: string;
  extraHeaders: Record<string, string>;
  gatewayEnabled: boolean;
}

export function deriveGroqEndpoint(opts: { gateway?: GroqGatewayConfig | null }): DerivedGroqEndpoint;

export type ProbeGroqStatus = "ok" | "missing" | "unauthorized" | "error";

export interface ProbeGroqResult {
  status: ProbeGroqStatus;
  modelCount?: number;
  error?: string;
}

export function probeGroq(opts: {
  apiKey: string | null | undefined;
  endpoint: string;
  extraHeaders?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<ProbeGroqResult>;
