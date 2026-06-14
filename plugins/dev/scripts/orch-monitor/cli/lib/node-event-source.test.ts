// CTL-920 / HUD2: bun/Node has no global `EventSource`, so the HUD injects this
// fetch-based one into the SHARED `subscribeReadModel()` helper. These tests
// prove it parses the SSE wire framing the server emits
// (`event: board\ndata: <json>\n\n`, server.ts:2001) and conforms to the
// contract's minimal `ReadModelEventSource` shape — addEventListener / close /
// onerror — so the SAME subscribe logic drives the HUD and the browser.
import { describe, it, expect } from "bun:test";
import { createNodeEventSource } from "./node-event-source";
import {
  subscribeReadModel,
  type ReadModelPayload,
} from "../../lib/read-model-client";

function payload(overrides: Partial<ReadModelPayload> = {}): ReadModelPayload {
  return {
    generatedAt: "2026-06-09T00:00:00.000Z",
    config: { maxParallel: 6, inFlight: 0, freeSlots: 6, active: 0, working: 0, stuck: 0 },
    repos: [],
    workers: [],
    tickets: [],
    queue: [],
    ...overrides,
  };
}

function sseFrame(p: ReadModelPayload): string {
  return `event: board\ndata: ${JSON.stringify(p)}\n\n`;
}

/** A fetch stub that streams the given chunks then ends the body. */
function fetchStreaming(chunks: string[]): typeof fetch {
  return (() => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  }) as unknown as typeof fetch;
}

describe("createNodeEventSource (CTL-920)", () => {
  it("decodes a single SSE board frame and delivers it to the matching listener", async () => {
    const p = payload({ generatedAt: "2026-06-09T01:02:03.000Z" });
    const es = createNodeEventSource("http://x/api/board/stream", {
      fetchImpl: fetchStreaming([sseFrame(p)]),
    });
    const got: string[] = [];
    es.addEventListener("board", (ev) => got.push(ev.data));
    await es.whenIdle();
    expect(got.length).toBe(1);
    expect((JSON.parse(got[0]) as { generatedAt: string }).generatedAt).toBe("2026-06-09T01:02:03.000Z");
    es.close();
  });

  it("reassembles a frame split across multiple network chunks", async () => {
    const p = payload();
    const whole = sseFrame(p);
    const mid = Math.floor(whole.length / 2);
    const es = createNodeEventSource("http://x/api/board/stream", {
      fetchImpl: fetchStreaming([whole.slice(0, mid), whole.slice(mid)]),
    });
    const got: string[] = [];
    es.addEventListener("board", (ev) => got.push(ev.data));
    await es.whenIdle();
    expect(got.length).toBe(1);
    es.close();
  });

  it("drives the SHARED subscribeReadModel() helper end-to-end", async () => {
    const p = payload({ workers: [] });
    const factory = (url: string) =>
      createNodeEventSource(url, { fetchImpl: fetchStreaming([sseFrame(p)]) });
    const snaps: ReadModelPayload[] = [];
    subscribeReadModel(
      { onSnapshot: (s) => snaps.push(s) },
      { url: "http://x/api/board/stream", eventSourceFactory: factory },
    );
    // Give the injected stream a microtask turn to flush.
    await new Promise((r) => setTimeout(r, 20));
    expect(snaps.length).toBe(1);
    expect(Array.isArray(snaps[0].workers)).toBe(true);
  });

  it("invokes onerror when the connection fails, never throwing into the loop", async () => {
    const failing = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const es = createNodeEventSource("http://x/api/board/stream", { fetchImpl: failing });
    let errored = false;
    es.onerror = () => {
      errored = true;
    };
    await es.whenIdle();
    expect(errored).toBe(true);
    es.close();
  });

  it("a non-200 response triggers onerror (server up but endpoint missing)", async () => {
    const notFound = (() => Promise.resolve(new Response("nope", { status: 404 }))) as unknown as typeof fetch;
    const es = createNodeEventSource("http://x/api/board/stream", { fetchImpl: notFound });
    let errored = false;
    es.onerror = () => {
      errored = true;
    };
    await es.whenIdle();
    expect(errored).toBe(true);
    es.close();
  });

  it("close() before the body resolves aborts and delivers no events", async () => {
    let aborted = false;
    const slow = ((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    }) as unknown as typeof fetch;
    const es = createNodeEventSource("http://x/api/board/stream", { fetchImpl: slow });
    const got: string[] = [];
    es.addEventListener("board", (ev) => got.push(ev.data));
    es.close();
    await es.whenIdle();
    expect(aborted).toBe(true);
    expect(got.length).toBe(0);
  });
});
