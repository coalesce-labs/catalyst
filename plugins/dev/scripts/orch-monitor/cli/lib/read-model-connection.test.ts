// CTL-920 / HUD2: the HUD's read-model connection controller. Drives the SHARED
// subscribeReadModel() contract, tracks connection status, and reconnects when
// the server comes back — the pure core behind useReadModel(), tested without
// React. Encodes the ticket's Gherkin: primary state from the SSE when up;
// graceful "down" status (→ raw-file fallback) when the server is absent.
import { describe, it, expect } from "bun:test";
import { createReadModelConnection } from "./read-model-connection";
import type {
  ReadModelPayload,
  ReadModelEventSource,
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

/** A controllable fake EventSource: the test pushes snapshots / errors at will. */
function fakeSource() {
  const listeners = new Map<string, (ev: { data: string }) => void>();
  let onerror: ((ev: unknown) => void) | null = null;
  let closed = false;
  const es: ReadModelEventSource = {
    addEventListener(type, l) {
      listeners.set(type, l);
    },
    close() {
      closed = true;
    },
    get onerror() {
      return onerror;
    },
    set onerror(fn) {
      onerror = fn;
    },
  };
  return {
    es,
    pushSnapshot: (p: ReadModelPayload) => listeners.get("board")?.({ data: JSON.stringify(p) }),
    pushRaw: (data: string) => listeners.get("board")?.({ data }),
    pushError: () => onerror?.(new Error("stream error")),
    isClosed: () => closed,
  };
}

describe("createReadModelConnection (CTL-920)", () => {
  it("starts in 'connecting' and flips to 'connected' on the first snapshot", () => {
    const fake = fakeSource();
    const states: string[] = [];
    const conn = createReadModelConnection({
      url: "http://x/api/board/stream",
      eventSourceFactory: () => fake.es,
      onChange: (s) => states.push(s.status),
    });
    conn.start();
    expect(conn.snapshot().status).toBe("connecting");
    fake.pushSnapshot(payload({ generatedAt: "2026-06-09T09:09:09.000Z" }));
    expect(conn.snapshot().status).toBe("connected");
    expect(conn.snapshot().payload?.generatedAt).toBe("2026-06-09T09:09:09.000Z");
    expect(states).toContain("connected");
    conn.stop();
  });

  it("flips to 'down' on a stream error (graceful-degrade → raw-file fallback)", () => {
    const fake = fakeSource();
    const conn = createReadModelConnection({
      url: "http://x/api/board/stream",
      eventSourceFactory: () => fake.es,
    });
    conn.start();
    fake.pushError();
    expect(conn.snapshot().status).toBe("down");
    conn.stop();
  });

  it("schedules a reconnect after an error so a restarted server is re-consumed", () => {
    let built = 0;
    const fakes: ReturnType<typeof fakeSource>[] = [];
    const scheduled: Array<() => void> = [];
    const conn = createReadModelConnection({
      url: "http://x/api/board/stream",
      eventSourceFactory: () => {
        built++;
        const f = fakeSource();
        fakes.push(f);
        return f.es;
      },
      reconnectDelayMs: 1000,
      setTimer: (fn) => {
        scheduled.push(fn);
        return 0;
      },
      clearTimer: () => {},
    });
    conn.start();
    expect(built).toBe(1);
    fakes[0].pushError();
    expect(conn.snapshot().status).toBe("down");
    // Fire the scheduled reconnect.
    expect(scheduled.length).toBe(1);
    scheduled[0]();
    expect(built).toBe(2);
    expect(conn.snapshot().status).toBe("connecting");
    // The new connection delivers a snapshot → connected again.
    fakes[1].pushSnapshot(payload());
    expect(conn.snapshot().status).toBe("connected");
    conn.stop();
  });

  it("stop() closes the underlying source and cancels a pending reconnect", () => {
    const fake = fakeSource();
    let cleared = false;
    const conn = createReadModelConnection({
      url: "http://x/api/board/stream",
      eventSourceFactory: () => fake.es,
      setTimer: () => 7,
      clearTimer: () => {
        cleared = true;
      },
    });
    conn.start();
    fake.pushError(); // schedules a reconnect timer
    conn.stop();
    expect(fake.isClosed()).toBe(true);
    expect(cleared).toBe(true);
  });

  it("a malformed frame is skipped via the shared decoder (no crash, stays connecting)", () => {
    const fake = fakeSource();
    const conn = createReadModelConnection({
      url: "http://x/api/board/stream",
      eventSourceFactory: () => fake.es,
    });
    conn.start();
    // The connection routes every frame through decodeReadModelFrame(); a garbage
    // frame returns null and is dropped, so status never advances to "connected".
    fake.pushRaw("this is not json");
    expect(conn.snapshot().status).toBe("connecting");
    expect(conn.snapshot().payload).toBeNull();
    // A valid frame after the garbage one still lands.
    fake.pushSnapshot(payload());
    expect(conn.snapshot().status).toBe("connected");
    conn.stop();
  });
});
