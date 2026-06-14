// use-beliefs.ts — CTL-1100 Phase 6: belief stream subscription hook.
// One EventSource('/api/beliefs/stream'); AppShell calls useBeliefs() ONCE and
// distributes via BeliefsContext (CTL-945 pattern). Consumers use
// useBeliefsContext() — never a direct useBeliefs() call in leaf components.
import { createContext, useContext, useEffect, useState } from "react";
import {
  applyBeliefFrame,
  decodeBeliefFrame,
  EMPTY_BELIEFS_STATE,
  type BeliefsState,
} from "../lib/beliefs-model";

// ── Shared context (CTL-945 pattern) ─────────────────────────────────────────

export const BeliefsContext = createContext<BeliefsState>(EMPTY_BELIEFS_STATE);

export function useBeliefsContext(): BeliefsState {
  return useContext(BeliefsContext);
}

// ── SSE subscription hook ─────────────────────────────────────────────────────

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

export function useBeliefs(): BeliefsState {
  const [state, setState] = useState<BeliefsState>(EMPTY_BELIEFS_STATE);

  useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const apply = (frame: BeliefsState) => {
      if (alive) setState(frame);
    };

    const scheduleReconnect = () => {
      if (!alive) return;
      const delay = backoff;
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
      reconnectTimer = setTimeout(connect, delay);
    };

    function connect() {
      if (!alive) return;
      try {
        es = new EventSource("/api/beliefs/stream");
      } catch {
        scheduleReconnect();
        return;
      }
      es.addEventListener("open", () => {
        backoff = INITIAL_BACKOFF_MS;
      });
      es.addEventListener("belief", (ev) => {
        const frame = decodeBeliefFrame((ev as MessageEvent).data as string);
        if (!frame) return;
        setState((prev) => applyBeliefFrame(prev, frame));
      });
      es.onerror = () => {
        try { es?.close(); } catch { /* noop */ }
        es = null;
        scheduleReconnect();
      };
    }

    connect();

    return () => {
      alive = false;
      try { es?.close(); } catch { /* noop */ }
      clearTimeout(reconnectTimer);
    };
  }, []);

  return state;
}
