// read-model-connection.ts — the terminal HUD's read-model connection controller
// (CTL-920 / HUD2). The pure, React-free core behind the useReadModel() hook.
//
// WHY A CONTROLLER (not just a hook)
// ----------------------------------
// All the load-bearing behavior — subscribe via the SHARED contract, track
// connection status, reconnect when a stopped server comes back, fall to "down"
// (so the HUD drops to its raw-file scan) on error — is plain state-machine
// logic. Putting it in a controller lets it be unit-tested deterministically
// (inject the EventSource factory + timers) without rendering React; the hook is
// then a thin React adapter over `subscribe()`.
//
// ONE ASSEMBLY, MANY READERS
// --------------------------
// The HUD consumes the EXACT same `/api/board/stream` SSE the web/iPad consume,
// decoded through the SAME `decodeReadModelFrame()` / `subscribeReadModel()`
// contract (lib/read-model-client.ts). So a fix to how the BFF assembles worker
// state reaches the HUD, the web board, and the iPad identically — no
// HUD-specific data-path.

import {
  subscribeReadModel,
  type ReadModelPayload,
  type ReadModelEventSource,
  type ReadModelSubscription,
} from "../../lib/read-model-client";

/** Connection lifecycle as the HUD sees it. `down` is the signal to fall back to
 *  the raw-file scan; `connected` means the read-model is driving primary state. */
export type ReadModelStatus = "connecting" | "connected" | "down";

export interface ReadModelConnectionState {
  status: ReadModelStatus;
  /** The most recent decoded snapshot, or null before the first one lands. */
  payload: ReadModelPayload | null;
}

export interface ReadModelConnectionOptions {
  /** Absolute SSE URL (see resolveReadModelUrl). */
  url: string;
  /** Node EventSource factory (createNodeEventSource); tests inject a fake. */
  eventSourceFactory: (url: string) => ReadModelEventSource;
  /** Notified on every state transition so the hook can re-render. */
  onChange?: (state: ReadModelConnectionState) => void;
  /** Delay before retrying a dropped/failed connection. Default 3s. */
  reconnectDelayMs?: number;
  /** Injectable timer fns (default global setTimeout/clearTimeout) for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ReadModelConnection {
  /** Open the connection (idempotent). */
  start(): void;
  /** Close the connection and cancel any pending reconnect (idempotent). */
  stop(): void;
  /** Read the current state synchronously. */
  snapshot(): ReadModelConnectionState;
}

export function createReadModelConnection(
  options: ReadModelConnectionOptions,
): ReadModelConnection {
  const reconnectMs = options.reconnectDelayMs ?? 3000;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let state: ReadModelConnectionState = { status: "connecting", payload: null };
  let subscription: ReadModelSubscription | null = null;
  let reconnectHandle: unknown = null;
  let started = false;
  let stopped = false;

  const set = (next: Partial<ReadModelConnectionState>) => {
    state = { ...state, ...next };
    options.onChange?.(state);
  };

  const clearReconnect = () => {
    if (reconnectHandle !== null) {
      clearTimer(reconnectHandle);
      reconnectHandle = null;
    }
  };

  const connect = () => {
    if (stopped) return;
    // A reconnect attempt is a fresh "connecting" cycle; preserve the last
    // payload so the HUD keeps showing the most-recent picture while it retries.
    set({ status: "connecting" });
    subscription = subscribeReadModel(
      {
        onSnapshot: (payload) => {
          if (stopped) return;
          set({ status: "connected", payload });
        },
        onError: () => {
          if (stopped) return;
          // The stream dropped (server down / restarted). Mark down so the HUD
          // falls back to its raw-file scan, then schedule a reconnect so a
          // server that comes back up is re-consumed without a HUD restart.
          set({ status: "down" });
          teardownSubscription();
          scheduleReconnect();
        },
      },
      { url: options.url, eventSourceFactory: options.eventSourceFactory },
    );
  };

  const scheduleReconnect = () => {
    clearReconnect();
    reconnectHandle = setTimer(() => {
      reconnectHandle = null;
      connect();
    }, reconnectMs);
  };

  const teardownSubscription = () => {
    if (subscription) {
      subscription.close();
      subscription = null;
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      clearReconnect();
      teardownSubscription();
    },
    snapshot() {
      return state;
    },
  };
}
