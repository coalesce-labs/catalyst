// nav-signal-endpoints.test.ts — HTTP route-plumbing tests for the nav-signal
// projection routes (CTL-896, SHELL6): GET /api/nav (one-shot) and GET
// /api/nav/stream (SSE `nav` frames). Validates the server.ts wiring — the routes
// are mounted, return the projected NavSignal shape, layer the injected daemon
// health, and the stream emits a `nav` event on connect. The projection LOGIC
// itself (worker count / queue depth / anomaly / daemon mapping) is covered
// exhaustively by the pure injectable unit tests in nav-signal.test.ts; these
// prove the route is mounted, shaped, and rides the read-model push transport.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";
import type { NavSignal } from "../lib/nav-signal.mjs";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nav-signal-endpoint-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  // Inject a deterministic daemon health so the route doesn't read the live event
  // log; the board snapshot assembles from this empty temp dir (no workers/queue).
  server = createServer({
    port: 0,
    wtDir,
    catalystDir: tmpDir,
    startWatcher: false,
    daemonHealthReader: () => "healthy",
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function isNavSignal(v: unknown): v is NavSignal {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.workerCount === "number" &&
    typeof s.queueDepth === "number" &&
    typeof s.anomaly === "boolean" &&
    (s.daemon === "healthy" || s.daemon === "degraded" || s.daemon === "offline") &&
    typeof s.generatedAt === "string"
  );
}

describe("GET /api/nav (CTL-896 one-shot)", () => {
  it("returns the projected NavSignal shape", async () => {
    const res = await fetch(`${baseUrl}/api/nav`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(isNavSignal(body)).toBe(true);
  });

  it("layers the injected daemon health into the projection", async () => {
    const res = await fetch(`${baseUrl}/api/nav`);
    const body = (await res.json()) as NavSignal;
    expect(body.daemon).toBe("healthy");
  });

  it("an empty fleet projects zero badges and no anomaly", async () => {
    const res = await fetch(`${baseUrl}/api/nav`);
    const body = (await res.json()) as NavSignal;
    expect(body.workerCount).toBe(0);
    expect(body.queueDepth).toBe(0);
    expect(body.anomaly).toBe(false);
  });
});

describe("GET /api/nav/stream (CTL-896 SSE)", () => {
  it("is a text/event-stream that emits a `nav` frame on connect", async () => {
    const res = await fetch(`${baseUrl}/api/nav/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Read just the first frame off the stream, then bail (don't hang on the
    // keep-alive). The connect frame is `event: nav\ndata: {…}\n\n`.
    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let buf = "";
    if (reader) {
      for (let i = 0; i < 5 && !buf.includes("\n\n"); i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      await reader.cancel();
    }
    expect(buf).toContain("event: nav");
    const dataLine = buf.split("\n").find((l) => l.startsWith("data: "));
    expect(dataLine).toBeTruthy();
    const payload: unknown = JSON.parse((dataLine as string).slice("data: ".length));
    expect(isNavSignal(payload)).toBe(true);
    expect((payload as NavSignal).daemon).toBe("healthy");
  });
});
