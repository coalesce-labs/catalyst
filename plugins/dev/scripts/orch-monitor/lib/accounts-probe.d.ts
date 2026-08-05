// Type declarations for accounts-probe.mjs (CTL-1653).
// The module is authored as .mjs (JS, no tsc gate — runs under bun/node) but
// server.ts and its tests import it under the TS program; these declarations
// give those consumers full type safety (mirrors belief-reader.d.ts).

/** One rate-limit window's utilization/reset/status (token-free). */
export interface AccountWindow {
  pct: number;
  resetsAt: string | null;
  status: string | null;
}

/** A token-free per-account view (whitelist-mapped from the raw probe record). */
export interface AccountView {
  label: string | null;
  isActive: boolean;
  email: string | null;
  overallStatus: string | null;
  representativeClaim: string | null;
  fiveHour: AccountWindow | null;
  sevenDay: AccountWindow | null;
  error: string | null;
  /** Only present on the ACTIVE account view: its binding window + status. */
  bindingWindow?: string | null;
  bindingStatus?: string | null;
}

/** The node-scoped node status derived from the active account's binding window. */
export type AccountsNodeStatus = "ok" | "degraded" | "rejected" | "error" | "unknown";

/** The node-scoped summary the API/dashboards consume. Token-free by construction. */
export interface AccountsSummary {
  node: string | null;
  generatedAt: string | null;
  status: AccountsNodeStatus;
  active: AccountView | null;
  accounts: AccountView[];
  siblingWithHeadroom: { label: string | null; email: string | null } | null;
}

/** A summary returned from the cache, stamped with probe time + cache-hit flag. */
export type CachedAccountsSummary = AccountsSummary & { probedAt: number; cached: boolean };

export declare function defaultAccountsProbeExec(opts?: {
  envFile?: string;
  timeoutMs?: number;
}): Promise<unknown>;

export declare function deriveAccountsSummary(
  raw: unknown,
  opts?: { node?: string },
): AccountsSummary;

export interface AccountsProbe {
  get(opts?: { refresh?: boolean }): Promise<CachedAccountsSummary>;
  latest(): AccountsSummary | null;
}

export declare function createAccountsProbe(opts: {
  exec: () => Promise<unknown>;
  ttlMs?: number;
  now?: () => number;
  node?: string;
}): AccountsProbe;
