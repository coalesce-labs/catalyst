/// <reference lib="webworker" />
// board-worker.ts — the SharedWorker behind the board (CTL-733 PR-2b). ONE
// instance per origin holds a single EventSource('/api/board/stream') + the
// latest snapshot in memory, and fans every frame out to all connected tabs.
// New tabs paint instantly from the in-memory cache; the worker also persists
// each snapshot to IndexedDB so the very first tab after a browser restart can
// paint from board-store too. Mirrors board-client.ts's direct-SSE loop, but
// shared. Not typechecked/linted by CI (ui/ is excluded); kept simple + the
// webworker lib is referenced file-locally above to avoid polluting DOM globals.
import type { BoardPayload, BoardOutbound, BoardInbound, ConnectionStatus } from "./types";
import { putCached } from "./board-store";
import { INITIAL_BACKOFF_MS, nextBackoff } from "./board-logic";

const ctx = self as unknown as SharedWorkerGlobalScope;

const ports = new Set<MessagePort>();
let latest: BoardPayload | null = null;
let status: ConnectionStatus = "connecting";
let es: EventSource | null = null;
let backoff = INITIAL_BACKOFF_MS;
let started = false;

function post(port: MessagePort, msg: BoardOutbound): void {
  try {
    port.postMessage(msg);
  } catch {
    ports.delete(port); // port's tab is gone
  }
}

function broadcast(msg: BoardOutbound): void {
  for (const p of ports) post(p, msg);
}

function setStatus(s: ConnectionStatus): void {
  status = s;
  broadcast({ kind: "status", status: s });
}

function apply(payload: BoardPayload): void {
  latest = payload;
  void putCached(payload);
  broadcast({ kind: "snapshot", payload });
}

async function reconcile(): Promise<boolean> {
  try {
    const r = await fetch("/api/board");
    if (r.ok) {
      apply((await r.json()) as BoardPayload);
      return true;
    }
  } catch {
    /* offline — backoff loop will retry */
  }
  return false;
}

function scheduleReconnect(): void {
  const delay = backoff;
  backoff = nextBackoff(backoff);
  setTimeout(connect, delay);
  // Status follows the poll OUTCOME (not the raw SSE socket) so a working poll
  // under `bun run dev` reads LIVE, and we don't flap "connecting" each cycle.
  void reconcile().then((ok) => setStatus(ok ? "connected" : "reconnecting"));
}

function connect(): void {
  try {
    es = new EventSource("/api/board/stream");
  } catch {
    scheduleReconnect();
    return;
  }
  es.addEventListener("board", (ev) => {
    backoff = INITIAL_BACKOFF_MS; // reset on a real frame
    setStatus("connected");
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

ctx.onconnect = (e: MessageEvent) => {
  const port = e.ports[0];
  if (!port) return;
  ports.add(port);
  port.onmessage = (ev: MessageEvent<BoardInbound>) => {
    const kind = ev.data?.kind;
    if (kind === "bye") {
      // Deterministic prune on tab/effect teardown (a closed port emits no event
      // and never fails a send, so this is the only reliable signal).
      ports.delete(port);
      try {
        port.close();
      } catch {
        /* noop */
      }
    } else if (kind === "reconcile") {
      void reconcile();
    }
  };
  port.start();
  // Instant paint for the newly-connected tab from the worker's in-memory cache.
  if (latest) post(port, { kind: "snapshot", payload: latest });
  post(port, { kind: "status", status });
  // Open the single shared upstream connection on the first tab only.
  if (!started) {
    started = true;
    connect();
  }
};
