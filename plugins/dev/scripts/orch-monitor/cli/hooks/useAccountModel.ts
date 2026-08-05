// useAccountModel.ts — CTL-1653. Subscribe the HUD to THIS node's Claude-account
// posture over the LOCAL monitor's `/api/accounts/stream` SSE. Unlike the read
// model (which may point at a remote replica), account posture is inherently
// per-node/local, so this always targets the local monitor
// (CATALYST_MONITOR_URL, else http://127.0.0.1:<MONITOR_PORT|7400>).
//
// Uses the HUD's dependency-free createNodeEventSource (no browser EventSource in
// bun). createNodeEventSource is a ONE-SHOT reader (reconnect policy is the hook's
// job), so this hook owns capped-backoff reconnect + a snapshot reconcile — without
// it the strip would freeze on its last value forever the first time the local
// monitor restarts or the stream drops. Never throws.

import { useEffect, useState } from "react";
import { createNodeEventSource, type NodeEventSource } from "../lib/node-event-source";
import { DEFAULT_MONITOR_PORT } from "../lib/read-model-url";
import type { AccountStripSignal } from "../components/account-strip";

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

/** Resolve the LOCAL monitor base URL (no path). */
function localMonitorBase(env: Record<string, string | undefined>): string {
  const explicit = env.CATALYST_MONITOR_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const parsed = parseInt(env.MONITOR_PORT ?? "", 10);
  const port = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MONITOR_PORT;
  return `http://127.0.0.1:${port}`;
}

/** Decode an `account` SSE frame; null on garbage or a non-posture (available:false) frame. */
function decodeAccountFrame(data: string): AccountStripSignal | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.status !== "string") return null; // e.g. {available:false} → no posture
    return p as unknown as AccountStripSignal;
  } catch {
    return null;
  }
}

/**
 * Subscribe to the local account-posture stream for the calling component's
 * lifetime. Returns the latest posture (null until the first frame lands / when
 * the endpoint is unavailable).
 */
export function useAccountModel(): AccountStripSignal | null {
  const [signal, setSignal] = useState<AccountStripSignal | null>(null);

  useEffect(() => {
    let alive = true;
    const base = localMonitorBase(process.env);
    let es: NodeEventSource | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    // Snapshot from /api/accounts so the strip populates immediately (and re-seeds
    // after a drop), not only on the next stream frame. Best-effort.
    const reconcile = async () => {
      try {
        const r = await fetch(`${base}/api/accounts`);
        if (r.ok && alive) {
          const body: unknown = await r.json();
          const s = decodeAccountFrame(JSON.stringify(body));
          if (s && alive) setSignal(s);
        }
      } catch {
        /* offline — the stream (or a later snapshot) will populate it */
      }
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
      let src: NodeEventSource;
      try {
        src = createNodeEventSource(`${base}/api/accounts/stream`);
      } catch {
        scheduleReconnect();
        return;
      }
      es = src;
      src.addEventListener("account", (ev) => {
        backoff = INITIAL_BACKOFF_MS; // reset on a real frame
        const next = decodeAccountFrame(ev.data);
        if (next && alive) setSignal(next);
      });
      src.onerror = () => {
        // One-shot reader errored (monitor restart / stream drop) — close and
        // reconnect with capped backoff so the strip resumes updating.
        try {
          src.close();
        } catch {
          /* noop */
        }
        if (es === src) es = null;
        scheduleReconnect();
      };
    }

    void reconcile();
    connect();

    return () => {
      alive = false;
      clearTimeout(reconnectTimer);
      try {
        es?.close();
      } catch {
        /* noop */
      }
      es = null;
    };
  }, []);

  return signal;
}
