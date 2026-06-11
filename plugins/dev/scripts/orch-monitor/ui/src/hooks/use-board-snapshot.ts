// use-board-snapshot.ts — subscribe a React surface to the cache-backed
// read-model snapshot (CTL-899 / HOME1). The board already proved the push
// model: `connectBoard()` (board/board-client.ts) opens ONE shared EventSource
// over `/api/board/stream`, warm-paints from IndexedDB, and re-requests a fresh
// snapshot on tab re-focus — all with NO synchronous Linear/linearis call per
// page load. The Inbox home consumes that SAME transport so its data plane is
// identical to the board's (the CTL-899 "Inbox data comes from the read-model,
// never a live Linear call" Gherkin).
//
// This is the thin React adapter around the transport: it owns the subscription
// lifecycle (connect on mount, reconcile on visibility regain, close on unmount)
// and exposes the latest `BoardPayload` + connection status. It is deliberately
// tiny and side-effect-free beyond that — the inbox DERIVATION lives in the pure
// `board/home-inbox.ts`, which this feeds.
import { useEffect, useState } from "react";
import { connectBoard } from "../board/board-client";
import type { BoardPayload } from "../board/types";
import type { ConnectionStatus } from "../lib/types";

export interface BoardSnapshot {
  /** The latest read-model payload, or null until the first frame lands. */
  payload: BoardPayload | null;
  /** Transport status — "connected" once data is flowing (LIVE). */
  status: ConnectionStatus;
}

/**
 * Subscribe to the read-model board snapshot for the lifetime of the calling
 * component. Returns the latest payload + status; both update as SSE frames land.
 *
 * Mirrors the exact subscription lifecycle Board.tsx uses (connectBoard +
 * visibilitychange reconcile + close), so the Home surface and the Board share
 * ONE EventSource via the SharedWorker — no second upstream stream.
 */
export function useBoardSnapshot(): BoardSnapshot {
  const [payload, setPayload] = useState<BoardPayload | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  useEffect(() => {
    let alive = true;
    const conn = connectBoard({
      onSnapshot: (p) => {
        if (alive) setPayload(p);
      },
      onStatus: (s) => {
        if (alive) setStatus(s);
      },
    });
    const onVis = () => {
      if (!document.hidden) conn.requestReconcile();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      conn.close();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return { payload, status };
}
