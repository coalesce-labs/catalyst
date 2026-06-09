// CTL-887 (BFF5): HTTP route-plumbing tests for the live transcript-tail SSE
// endpoint. Validates the server.ts wiring — sessionId validation (400), the
// 404 for a session with no transcript, and the SSE happy path (a real
// ~/.claude/projects/<dir>/<sessionId>.jsonl that grows while a client is
// subscribed emits typed `stream-event` frames). The conversion LOGIC itself
// (resting-transcript → StreamEvent[], the incremental tail) is covered by the
// injectable unit tests in ec-worker-stream.test.ts; these prove the route is
// mounted, matched, guarded, and streams.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

// A real, uniquely-named project dir under ~/.claude/projects so the endpoint's
// transcript resolver finds our fixture, then we clean it up.
const PROJECTS = join(homedir(), ".claude", "projects");
const projectDir = join(PROJECTS, `ec-worker-stream-test-${randomUUID()}`);
const sessionId = randomUUID();
const transcriptFile = join(projectDir, `${sessionId}.jsonl`);

function assistantLine(content: unknown[]): string {
  return (
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      sessionId,
      message: { role: "assistant", model: "claude-opus-4-8", content },
    }) + "\n"
  );
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ec-worker-stream-endpoints-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  // Seed the transcript with one record so the resolver's scan finds the file.
  writeFileSync(transcriptFile, assistantLine([{ type: "text", text: "boot" }]));
  server = createServer({ port: 0, wtDir, startWatcher: false });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  for (const d of [projectDir, tmpDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("GET /api/ec-worker-stream/:sessionId (CTL-887)", () => {
  it("rejects a malformed sessionId with 400 (no path traversal / arbitrary read)", async () => {
    expect((await fetch(`${baseUrl}/api/ec-worker-stream/not a uuid!`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/ec-worker-stream/..%2F..%2Fetc`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/ec-worker-stream/short`)).status).toBe(400);
  });

  it("returns 404 when no transcript exists for that session id", async () => {
    const res = await fetch(`${baseUrl}/api/ec-worker-stream/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it("streams typed StreamEvents over SSE as the transcript grows", async () => {
    const res = await fetch(`${baseUrl}/api/ec-worker-stream/${sessionId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Read until we have seen the `open` frame plus at least one stream-event.
    const deadline = Date.now() + 8000;
    let sawOpen = false;
    let sawToolStart = false;

    // Append a tool_use record AFTER subscribing so we prove live growth, not
    // just the initial tail.
    appendFileSync(
      transcriptFile,
      assistantLine([{ type: "tool_use", name: "Bash", input: { command: "bun test" } }]),
    );

    while (Date.now() < deadline && !(sawOpen && sawToolStart)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const frame of buffer.split("\n\n")) {
        if (frame.includes("event: open")) sawOpen = true;
        if (frame.includes("event: stream-event")) {
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine) {
            const ev = JSON.parse(dataLine.slice("data: ".length)) as {
              type: string;
              tool?: string;
            };
            if (ev.type === "tool_start" && ev.tool === "Bash") sawToolStart = true;
          }
        }
      }
    }
    await reader.cancel();

    expect(sawOpen).toBe(true);
    expect(sawToolStart).toBe(true);
  });
});
