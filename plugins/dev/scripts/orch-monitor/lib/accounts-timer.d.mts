// Type declarations for accounts-timer.mjs (CTL-1653).
// Authored as .mjs (no tsc gate) but imported under the TS program by server.ts;
// these types give that consumer full type safety (mirrors accounts-probe.d.ts).

import type { AccountsProbe, CachedAccountsSummary } from "./accounts-probe";

export interface AccountsTimer {
  start(): void;
  stop(): void;
}

export declare function createAccountsTimer(opts: {
  probe: Pick<AccountsProbe, "get">;
  clock?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  intervalMs?: number;
  onTick?: (summary: CachedAccountsSummary) => void;
  onError?: (err: unknown) => void;
}): AccountsTimer;
