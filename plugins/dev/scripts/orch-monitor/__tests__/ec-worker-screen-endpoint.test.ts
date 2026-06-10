// CTL-938: HTTP route-plumbing tests for the live SCREEN SSE endpoint
// (/api/ec-worker-screen/<shortId>). The screen source is `claude logs
// <shortId>` — here faked via the injected `screenLogsExec` server option so no
// real claude CLI is ever spawned. The poll+diff LOGIC itself is covered by the
// injectable unit tests in ec-worker-screen.test.ts; these prove the route is
// mounted, matched, guarded (400/404/503), change-driven (no frame for an
// unchanged screen), and terminates the stream when the session goes away.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";
import type { ScreenLogsResult } from "../lib/ec-worker-screen.mjs";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

// The fake `claude logs` — a per-shortId scripted queue of results. The last
// entry repeats once the queue drains (a stable screen keeps polling).
const scripts = new Map<string, ScreenLogsResult[]>();
const counters = new Map<string, number>();
function fakeExec(shortId: string): Promise<ScreenLogsResult> {
  const queue = scripts.get(shortId);
  if (!queue || queue.length === 0) {
    return Promise.resolve({ status: "gone", detail: `No such job: ${shortId}` });
  }
  const i = counters.get(shortId) ?? 0;
  counters.set(shortId, i + 1);
  return Promise.resolve(queue[Math.min(i, queue.length - 1)]);
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ec-worker-screen-endpoint-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  server = createServer({
    port: 0,
    wtDir,
    startWatcher: false,
    screenLogsExec: fakeExec,
    screenPollMs: 40, // fast cadence so the SSE assertions don't wait 2s/poll
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

interface Frame {
  event: string;
  data: string;
}

/** Read SSE frames from a live body until `done(frames)` or the deadline. */
async function readFrames(
  res: Response,
  done: (frames: Frame[]) => boolean,
  timeoutMs = 5000,
): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !done(frames)) {
    const racer = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
    ]);
    if (racer === null || racer.done) break;
    buffer += decoder.decode(racer.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = part.match(/^event: (.+)$/m)?.[1] ?? "message";
      const data = part.match(/^data: (.+)$/m)?.[1] ?? "";
      frames.push({ event, data });
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}

describe("GET /api/ec-worker-screen/:shortId (CTL-938)", () => {
  it("rejects a malformed shortId with 400 (nothing ever reaches the exec fn)", async () => {
    expect((await fetch(`${baseUrl}/api/ec-worker-screen/not%20an%20id!`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/ec-worker-screen/..%2F..%2Fetc`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/ec-worker-screen/UPPERCASE1`)).status).toBe(400);
  });

  it("returns 404 when the session is already gone on the first poll", async () => {
    scripts.set("dead0000", [{ status: "gone", detail: "No such job: dead0000" }]);
    const res = await fetch(`${baseUrl}/api/ec-worker-screen/dead0000`);
    expect(res.status).toBe(404);
  });

  it("returns 503 when the claude CLI is absent", async () => {
    // NB: the fixture id must be VALID 8-hex (real shortIds are UUID prefixes;
    // a non-hex id is rejected 400 by the route guard before the exec runs).
    scripts.set("0c110000", [{ status: "unavailable", detail: "claude: ENOENT" }]);
    const res = await fetch(`${baseUrl}/api/ec-worker-screen/0c110000`);
    expect(res.status).toBe(503);
  });

  it("accepts a full UUID and truncates to the 8-char short form for the exec fn", async () => {
    scripts.set("feed0001", [{ status: "ok", stdout: "screen via uuid" }]);
    const res = await fetch(
      `${baseUrl}/api/ec-worker-screen/feed0001-9d9c-4ef2-aaaa-bbbbccccdddd`,
    );
    expect(res.status).toBe(200);
    const frames = await readFrames(res, (f) => f.some((x) => x.event === "screen"));
    const screen = frames.find((f) => f.event === "screen");
    expect(screen).toBeDefined();
    expect((JSON.parse(screen!.data) as { screen: string }).screen).toBe("screen via uuid");
  });

  it("streams the first frame immediately, emits ONLY on change, then ends with a gone event", async () => {
    scripts.set("abcd0001", [
      { status: "ok", stdout: "\x1b[1mscreen ONE\x1b[0m" },
      { status: "ok", stdout: "\x1b[2mscreen ONE\x1b[0m" }, // ANSI-only diff → no frame
      { status: "ok", stdout: "screen ONE" }, // still unchanged → no frame
      { status: "ok", stdout: "screen TWO" }, // real change → frame
      { status: "gone", detail: "No such job: abcd0001" },
    ]);
    const res = await fetch(`${baseUrl}/api/ec-worker-screen/abcd0001`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = await readFrames(res, (f) => f.some((x) => x.event === "gone"));
    expect(frames[0]?.event).toBe("open");

    const screens = frames
      .filter((f) => f.event === "screen")
      .map((f) => (JSON.parse(f.data) as { screen: string }).screen);
    // Change-driven: exactly TWO screen frames despite five polls.
    expect(screens).toEqual(["screen ONE", "screen TWO"]);

    const gone = frames.find((f) => f.event === "gone");
    expect(gone).toBeDefined();
    expect((JSON.parse(gone!.data) as { reason: string }).reason).toContain("No such job");
  });
});
