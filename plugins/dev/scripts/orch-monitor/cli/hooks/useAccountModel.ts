// useAccountModel.ts — CTL-1653. Subscribe the HUD to THIS node's Claude-account
// posture over the LOCAL monitor's `/api/accounts/stream` SSE. Unlike the read
// model (which may point at a remote replica), account posture is inherently
// per-node/local, so this always targets the local monitor
// (CATALYST_MONITOR_URL, else http://127.0.0.1:<MONITOR_PORT|7400>).
//
// Uses the HUD's dependency-free createNodeEventSource (no browser EventSource in
// bun). Never throws: any connection error just leaves the last posture (or null).

import { useEffect, useState } from "react";
import { createNodeEventSource } from "../lib/node-event-source";
import { DEFAULT_MONITOR_PORT } from "../lib/read-model-url";
import type { AccountStripSignal } from "../components/account-strip";

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

    // Snapshot on mount so the strip populates immediately, not only on the next
    // stream frame. Best-effort — a failure just waits for the stream.
    void (async () => {
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
    })();

    const es = createNodeEventSource(`${base}/api/accounts/stream`);
    es.addEventListener("account", (ev) => {
      const next = decodeAccountFrame(ev.data);
      if (next && alive) setSignal(next);
    });
    es.onerror = () => {
      /* read-model/monitor unavailable — keep the last posture, no crash */
    };

    return () => {
      alive = false;
      es.close();
    };
  }, []);

  return signal;
}
