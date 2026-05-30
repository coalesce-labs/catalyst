// board-client.ts — the transport the board view talks to (CTL-733 PR-2b).
// `connectBoard()` is the ONLY thing Board.tsx imports. It:
//   1. paints instantly from the IndexedDB cache (warm reload, gated so a live
//      frame that lands first still wins),
//   2. picks a transport: SharedWorker (ONE EventSource + cache shared across all
//      tabs) → direct per-tab EventSource fallback (Firefox/Safari module-worker
//      gaps, private windows),
//   3. exposes requestReconcile()/close().
// Server endpoints are unchanged: it consumes /api/board/stream (SSE `board`
// frames) + /api/board (one-shot reconcile).
import type { BoardPayload, BoardOutbound, BoardInbound, ConnectionStatus } from "./types";
import { getCached, putCached } from "./board-store";
import { INITIAL_BACKOFF_MS, nextBackoff, createSnapshotGate } from "./board-logic";

export interface BoardHandlers {
  onSnapshot: (payload: BoardPayload) => void;
  onStatus: (status: ConnectionStatus) => void;
}

export interface BoardConnection {
  /** Ask the transport for a fresh snapshot now (e.g. on tab re-focus). */
  requestReconcile: () => void;
  /** Tear down this tab's subscription. */
  close: () => void;
}

export function connectBoard(handlers: BoardHandlers): BoardConnection {
  // Gate the consumer so an out-of-order cache/live race can't show stale data.
  const onSnapshot = createSnapshotGate(handlers.onSnapshot);

  // Warm paint from last session's cache — best effort, never blocks the live path.
  void getCached().then((cached) => {
    if (cached) onSnapshot(cached);
  });

  if (typeof SharedWorker !== "undefined") {
    try {
      return connectViaSharedWorker(onSnapshot, handlers.onStatus);
    } catch (e) {
      console.warn("[board] SharedWorker unavailable; falling back to direct SSE", e);
    }
  }
  return connectViaDirectSSE(onSnapshot, handlers.onStatus);
}

// One shared worker → one upstream EventSource for every tab in this origin.
function connectViaSharedWorker(
  onSnapshot: (p: BoardPayload) => void,
  onStatus: (s: ConnectionStatus) => void,
): BoardConnection {
  const worker = new SharedWorker(new URL("./board-worker.ts", import.meta.url), {
    type: "module",
  });
  const port = worker.port;
  port.onmessage = (ev: MessageEvent<BoardOutbound>) => {
    const msg = ev.data;
    if (msg.kind === "snapshot") onSnapshot(msg.payload);
    else if (msg.kind === "status") onStatus(msg.status);
  };
  port.start();
  const send = (m: BoardInbound) => {
    try {
      port.postMessage(m);
    } catch {
      /* port already closed */
    }
  };
  return {
    requestReconcile: () => send({ kind: "reconcile" }),
    close: () => {
      send({ kind: "bye" }); // let the worker prune this port deterministically
      try {
        port.close();
      } catch {
        /* already closed */
      }
    },
  };
}

// Per-tab EventSource fallback — behaviourally the original Board.tsx effect,
// plus cache writes, status reporting, and a capped backoff/reconcile loop
// (mirrors use-monitor.ts). Under standalone `bun run dev` the SSE 404s, so the
// reconcile poll against /api/board is the data source.
function connectViaDirectSSE(
  onSnapshot: (p: BoardPayload) => void,
  onStatus: (s: ConnectionStatus) => void,
): BoardConnection {
  let alive = true;
  let es: EventSource | null = null;
  let backoff = INITIAL_BACKOFF_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  const apply = (p: BoardPayload) => {
    if (!alive) return;
    onSnapshot(p);
    void putCached(p);
  };

  // Returns true if a fresh snapshot was applied. Status is driven by the
  // OUTCOME (below) rather than the raw SSE socket, so the pill reads LIVE
  // whenever data is flowing — including standalone `bun run dev`, where
  // /api/board/stream 404s and this poll is the only source.
  const reconcile = async (): Promise<boolean> => {
    if (!alive) return false;
    controller?.abort();
    controller = new AbortController();
    try {
      const r = await fetch("/api/board", { signal: controller.signal });
      if (r.ok) {
        apply((await r.json()) as BoardPayload);
        return true;
      }
    } catch {
      /* offline — the backoff loop will retry */
    }
    return false;
  };

  const scheduleReconnect = () => {
    if (!alive) return;
    const delay = backoff;
    backoff = nextBackoff(backoff);
    reconnectTimer = setTimeout(connect, delay);
    // Report LIVE/OFFLINE from whether the poll actually succeeded — a working
    // poll must not read as OFFLINE, and we don't flap "connecting" each cycle.
    void reconcile().then((ok) => {
      if (alive) onStatus(ok ? "connected" : "reconnecting");
    });
  };

  function connect() {
    if (!alive) return;
    try {
      es = new EventSource("/api/board/stream");
    } catch {
      scheduleReconnect();
      return;
    }
    es.addEventListener("board", (ev) => {
      backoff = INITIAL_BACKOFF_MS; // reset on a real frame
      onStatus("connected");
      try {
        apply(JSON.parse((ev as MessageEvent).data) as BoardPayload);
      } catch {
        /* ignore malformed frame */
      }
    });
    es.onerror = () => {
      try {
        es?.close();
      } catch {
        /* noop */
      }
      es = null;
      scheduleReconnect(); // reconcile() inside decides connected vs reconnecting
    };
  }

  onStatus("connecting");
  connect();

  return {
    requestReconcile: () => void reconcile(),
    close: () => {
      alive = false;
      try {
        es?.close();
      } catch {
        /* noop */
      }
      clearTimeout(reconnectTimer);
      controller?.abort();
    },
  };
}
