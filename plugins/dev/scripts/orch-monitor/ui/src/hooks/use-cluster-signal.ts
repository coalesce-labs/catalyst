// use-cluster-signal.ts — subscribe the footer to the read-model's per-node
// cluster-health projection (CTL-898 / SHELL8). The per-node dots + the node
// filter ride the SAME read-model SSE push model the nav signal uses (CTL-896 /
// SHELL6): ONE EventSource over `/api/cluster/stream` that receives a `cluster`
// frame on connect and on every reactive board recompute — a node going dark
// past its grace window flips its dot to offline WITHOUT a page reload and
// WITHOUT per-tab polling of the source files (Gherkin: "A node going dark is
// reflected").
//
// It mirrors use-nav-signal.ts's direct-SSE fallback: under standalone `bun run
// dev` the SSE 404s, so a capped-backoff reconcile poll against `/api/cluster` is
// the data source instead — the footer still goes live. The signal is tiny (one
// {host,status} per node), so a per-tab EventSource is fine; no SharedWorker.
//
// SINGLE-HOST IDENTITY NO-OP: on a single-node deployment the signal carries one
// node with `singleHost: true`; the footer collapses to today's single dot and
// the filter is absent (lib/cluster-signal.ts::shouldShowNodeFilter).
import { useEffect, useState } from "react";
import {
  decodeClusterSignalFrame,
  isClusterSignal,
  type ClusterSignal,
} from "../lib/cluster-signal";

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

/**
 * Subscribe to the cluster-signal projection for the lifetime of the calling
 * component. Returns the latest signal (null until the first frame lands).
 */
export function useClusterSignal(): ClusterSignal | null {
  const [signal, setSignal] = useState<ClusterSignal | null>(null);

  useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const apply = (next: ClusterSignal) => {
      if (alive) setSignal(next);
    };

    const reconcile = async (): Promise<boolean> => {
      if (!alive) return false;
      controller?.abort();
      controller = new AbortController();
      try {
        const r = await fetch("/api/cluster", { signal: controller.signal });
        if (r.ok) {
          const body: unknown = await r.json();
          if (isClusterSignal(body)) {
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
        es = new EventSource("/api/cluster/stream");
      } catch {
        scheduleReconnect();
        return;
      }
      es.addEventListener("cluster", (ev) => {
        backoff = INITIAL_BACKOFF_MS; // reset on a real frame
        const next = decodeClusterSignalFrame((ev as MessageEvent).data as string);
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
