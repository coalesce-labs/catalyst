// use-account-signal.ts — subscribe the dashboard to the read-model's per-node
// Claude-account posture (CTL-1653). One EventSource over `/api/accounts/stream`
// that receives an `account` frame on connect and on every periodic probe — the
// active account flipping to `rejected` (or its window resetting back to `ok`)
// is reflected WITHOUT a page reload and WITHOUT per-tab polling.
//
// Mirrors use-cluster-signal.ts's direct-SSE + capped-backoff reconcile fallback:
// under standalone `bun run dev` the SSE 404s, so a reconcile poll against
// `/api/accounts` is the data source instead. The signal is tiny (one node's
// posture), so a per-tab EventSource is fine.
//
// AppShell calls useAccountSignal() ONCE and distributes the result via
// AccountSignalContext so the footer + banner share the same value without opening
// a second EventSource. Consumers inside AppShell use useAccountSignalContext().
import { createContext, useContext, useEffect, useState } from "react";
import {
  decodeAccountSignalFrame,
  isAccountSignal,
  type AccountSignal,
} from "./account-signal-lib";

// ── Shared context ────────────────────────────────────────────────────────────

/** Context value: the latest AccountSignal from the single AppShell subscription. */
export const AccountSignalContext = createContext<AccountSignal | null>(null);

/**
 * Consume the shared AccountSignal from AppShell's context.
 * Only usable inside components rendered inside AppShell.
 */
export function useAccountSignalContext(): AccountSignal | null {
  return useContext(AccountSignalContext);
}

// ── SSE subscription hook ─────────────────────────────────────────────────────

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

/**
 * Subscribe to the account-posture projection for the lifetime of the calling
 * component. Returns the latest signal (null until the first frame lands).
 */
export function useAccountSignal(): AccountSignal | null {
  const [signal, setSignal] = useState<AccountSignal | null>(null);

  useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const apply = (next: AccountSignal) => {
      if (alive) setSignal(next);
    };

    const reconcile = async (): Promise<boolean> => {
      if (!alive) return false;
      controller?.abort();
      controller = new AbortController();
      try {
        const r = await fetch("/api/accounts", { signal: controller.signal });
        if (r.ok) {
          const body: unknown = await r.json();
          if (isAccountSignal(body)) {
            apply(body);
            return true;
          }
        }
      } catch {
        /* offline — the backoff loop retries */
      }
      return false;
    };

    const scheduleReconnect = () => {
      if (!alive) return;
      const delay = backoff;
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
      reconnectTimer = setTimeout(connect, delay);
      void reconcile();
    };

    function connect() {
      if (!alive) return;
      try {
        es = new EventSource("/api/accounts/stream");
      } catch {
        scheduleReconnect();
        return;
      }
      es.addEventListener("account", (ev) => {
        backoff = INITIAL_BACKOFF_MS; // reset on a real frame
        const next = decodeAccountSignalFrame((ev as MessageEvent).data as string);
        if (next) apply(next);
      });
      es.onerror = () => {
        try {
          es?.close();
        } catch {
          /* noop */
        }
        es = null;
        scheduleReconnect();
      };
    }

    connect();
    const onVis = () => {
      if (!document.hidden) void reconcile();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      alive = false;
      try {
        es?.close();
      } catch {
        /* noop */
      }
      clearTimeout(reconnectTimer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return signal;
}
