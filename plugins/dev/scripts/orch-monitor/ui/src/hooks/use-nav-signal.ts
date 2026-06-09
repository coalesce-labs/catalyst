// use-nav-signal.ts — subscribe the rail to the read-model's nav-signal
// projection (CTL-896 / SHELL6). The live badges/dots ride the SAME read-model
// SSE push model the board uses: ONE EventSource over `/api/nav/stream` that
// receives a `nav` frame on connect and on every reactive board recompute — the
// badges update as workers start/finish and as the queue/anomaly/daemon change,
// WITHOUT a page reload and WITHOUT per-tab polling of the source files (Gherkin
// "Live without thrash").
//
// It mirrors board-client.ts's direct-SSE fallback: under standalone `bun run
// dev` the SSE 404s, so a capped-backoff reconcile poll against `/api/nav` is the
// data source instead — the badges still go live. The nav signal is tiny (four
// fields), so a per-tab EventSource is fine; no SharedWorker is needed.
import { useEffect, useState } from "react";
import { decodeNavSignalFrame, isNavSignal, type NavSignal } from "../lib/nav-signal";

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

/**
 * Subscribe to the nav-signal projection for the lifetime of the calling
 * component. Returns the latest signal (null until the first frame lands).
 */
export function useNavSignal(): NavSignal | null {
  const [signal, setSignal] = useState<NavSignal | null>(null);

  useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const apply = (next: NavSignal) => {
      if (alive) setSignal(next);
    };

    // Returns true when a fresh signal was applied (drives connected/reconnecting).
    const reconcile = async (): Promise<boolean> => {
      if (!alive) return false;
      controller?.abort();
      controller = new AbortController();
      try {
        const r = await fetch("/api/nav", { signal: controller.signal });
        if (r.ok) {
          const body: unknown = await r.json();
          if (isNavSignal(body)) {
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
        es = new EventSource("/api/nav/stream");
      } catch {
        scheduleReconnect();
        return;
      }
      es.addEventListener("nav", (ev) => {
        backoff = INITIAL_BACKOFF_MS; // reset on a real frame
        const next = decodeNavSignalFrame((ev as MessageEvent).data as string);
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
    // Re-pull a fresh signal when the tab regains focus (matches the board hook).
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
