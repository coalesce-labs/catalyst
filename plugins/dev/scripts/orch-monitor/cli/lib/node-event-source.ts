// node-event-source.ts — a tiny fetch-based Server-Sent-Events client for the
// terminal HUD (CTL-920 / HUD2).
//
// WHY THIS EXISTS
// ---------------
// The shared read-model contract (lib/read-model-client.ts) ships a
// transport-agnostic `subscribeReadModel()` that defaults to the browser's
// global `EventSource`. The Node/bun runtime the HUD runs in has NO global
// `EventSource`, so the contract lets a non-browser host INJECT an
// `eventSourceFactory`. This file is that factory: a minimal `EventSource`-shaped
// client built on `fetch` (which bun/Node DO have), so the HUD subscribes to the
// SAME `/api/board/stream` SSE the web/iPad consume — one assembly, many readers.
//
// It implements only the surface the contract depends on
// (`ReadModelEventSource`: addEventListener / close / onerror) plus a
// test-only `whenIdle()` so suites can await the streamed body deterministically.
// It is dependency-free (no `eventsource` npm package), honouring the repo's
// "markdown + bash + bun stdlib" constraint.
//
// SCOPE: this is a one-shot reader of the current stream connection. Reconnect /
// backoff policy is owned by the HUD hook (useReadModel) so this stays a thin,
// well-tested transport — exactly as the contract's `subscribeReadModel()` is
// transport-only.

import type { ReadModelEventSource } from "../../lib/read-model-client";

type SseListener = (ev: { data: string }) => void;

export interface NodeEventSourceOptions {
  /** Injectable `fetch` for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** The HUD-facing handle: the contract's `ReadModelEventSource` plus a
 *  test-only `whenIdle()` that resolves once the streamed body is fully drained
 *  (or the connection errored / was closed). */
export interface NodeEventSource extends ReadModelEventSource {
  /** Resolves when the underlying stream has finished draining. Test-only — the
   *  HUD never awaits it (it reacts to events), but suites need a deterministic
   *  settle point. */
  whenIdle(): Promise<void>;
}

/**
 * Open an SSE connection to `url` and dispatch each `event: <name>` frame to the
 * listeners registered for `<name>`. Conforms to the contract's
 * `ReadModelEventSource` so it slots straight into `subscribeReadModel()`.
 *
 * Failure modes are funnelled to `onerror` (never thrown into the consumer's
 * loop): a rejected `fetch` (server down — the graceful-degrade path), a non-2xx
 * response (endpoint absent), or a mid-stream read error. The HUD hook treats any
 * `onerror` as "read-model unavailable" and falls back to its raw-file scan.
 */
export function createNodeEventSource(
  url: string,
  options: NodeEventSourceOptions = {},
): NodeEventSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const listeners = new Map<string, Set<SseListener>>();
  const controller = new AbortController();
  let closed = false;

  const self: NodeEventSource = {
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      controller.abort();
    },
    onerror: null,
    whenIdle: () => idle,
  };

  const fail = (err: unknown) => {
    if (closed) return;
    self.onerror?.(err);
  };

  const dispatch = (eventName: string, data: string) => {
    const set = listeners.get(eventName);
    if (!set) return;
    for (const l of set) l({ data });
  };

  // Drive the connection. The returned promise (`idle`) settles when the body is
  // drained or the connection ends — consumers ignore it; tests await it.
  const idle = (async () => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      });
    } catch (err) {
      fail(err);
      return;
    }
    if (!res.ok || !res.body) {
      fail(new Error(`read-model stream HTTP ${res.status}`));
      return;
    }
    try {
      await pump(res.body, dispatch, () => closed);
    } catch (err) {
      // An abort (close()) is expected — surface only genuine read errors.
      if (!closed) fail(err);
    }
  })();

  return self;
}

/**
 * Read the SSE byte stream, buffering partial frames across network chunks, and
 * dispatch each complete `event:`/`data:` block. SSE frames are separated by a
 * blank line (`\n\n`); a frame may carry multiple `data:` lines (joined by `\n`
 * per the spec). We track the most recent `event:` name (defaulting to
 * `"message"`) so the contract's `READ_MODEL_SSE_EVENT === "board"` matches the
 * server's `event: board` framing (server.ts:2001).
 */
async function pump(
  body: ReadableStream<Uint8Array>,
  dispatch: (eventName: string, data: string) => void,
  isClosed: () => boolean,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Normalise CRLF and split off every complete frame currently in `buffer`.
  const flushFrames = () => {
    buffer = buffer.replace(/\r\n/g, "\n");
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      emitBlock(block, dispatch);
      sep = buffer.indexOf("\n\n");
    }
  };

  for (;;) {
    if (isClosed()) return;
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flushFrames();
  }
  // Flush a trailing frame the server emitted without a final blank line.
  buffer += decoder.decode();
  if (buffer.trim()) emitBlock(buffer, dispatch);
}

function emitBlock(block: string, dispatch: (eventName: string, data: string) => void): void {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // SSE comment / heartbeat keep-alive
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (dataLines.length > 0) dispatch(eventName, dataLines.join("\n"));
}
