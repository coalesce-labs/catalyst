// Type declarations for account-status-latch.mjs (CTL-1653).
// Authored as .mjs (no tsc gate) but imported under the TS program by server.ts.

import type { AccountsSummary } from "./accounts-probe";

export declare const ACCOUNT_STATUS_CHANGED_EVENT: "account.status.changed";

export declare function nextAccountStatusLatch(
  prev: boolean,
  verdict: { trip: boolean; clear: boolean },
): { latched: boolean; emit: "rejected" | "recovered" | null };

export declare function getAccountStatusLatchPath(): string;

export declare function __resetAccountStatusLatchForTest(): void;

export declare function checkAccountStatusTransition(
  summary: Partial<AccountsSummary> & { status?: string },
  opts?: {
    emit?: (env: unknown) => boolean;
    state?: { prev: boolean } | null;
    persist?: (arg: { latched: boolean }) => boolean;
  },
): Promise<"rejected" | "recovered" | null>;
