/**
 * Tests for the global event log activity stream multiplexed onto the existing
 * /events SSE endpoint. Server boots with a fresh CATALYST_DIR pointing at a
 * tmp directory so we can append fixture events and observe the reaction on
 * the wire.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;
let eventsFile: string;
let savedEnvCatalystDir: string | undefined;

function nowMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function makeLine(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...extra,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((res) => setTimeout(res, ms));
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "orch-monitor-activity-"));
  const wtDir = join(tmpDir, "wt");
  const catalystDir = join(tmpDir, "catalyst");
  const eventsDir = join(catalystDir, "events");
  mkdirSync(wtDir, { recursive: true });
  mkdirSync(eventsDir, { recursive: true });
  eventsFile = join(eventsDir, `${nowMonth()}.jsonl`);

  // Seed a small backlog
  const backlog = [
    makeLine("github.pr.opened", { scope: { pr: 1 } }),
    makeLine("linear.issue.created", { scope: { ticket: "X-1" } }),
    makeLine("github.pr.merged", { scope: { pr: 2 } }),
  ];
  writeFileSync(eventsFile, backlog.join("\n") + "\n");

  savedEnvCatalystDir = process.env.CATALYST_DIR;
  process.env.CATALYST_DIR = catalystDir;

  server = createServer({
    port: 0,
    wtDir,
    startWatcher: false,
    annotationsDbPath: join(tmpDir, "annotations.db"),
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  if (savedEnvCatalystDir === undefined) {
    delete process.env.CATALYST_DIR;
  } else {
    process.env.CATALYST_DIR = savedEnvCatalystDir;
  }
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

interface MinimalReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

async function readUntil(
  reader: MinimalReader,
  match: (chunk: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race<{ done: boolean; value?: Uint8Array }>([
      reader.read(),
      new Promise((res) => setTimeout(() => res({ done: false }), remaining)),
    ]);
    if (result.value) buf += decoder.decode(result.value);
    if (match(buf)) return buf;
    if (result.done) break;
  }
  throw new Error(`timed out waiting for match; got: ${buf.slice(0, 500)}`);
}

describe("activity stream", () => {
  it("returns 400 on invalid jq predicate", async () => {
    const res = await fetch(
      `${baseUrl}/events?activity=${encodeURIComponent(".event ===")}`,
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body.toLowerCase()).toContain("activity filter");
    await res.body?.cancel().catch(() => {});
  });

  it("accepts valid jq predicate and opens stream", async () => {
    const ctrl = new AbortController();
    const res = await fetch(
      `${baseUrl}/events?activity=${encodeURIComponent('.event == "github.pr.merged"')}`,
      { signal: ctrl.signal },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await res.body?.getReader().cancel().catch(() => {});
    ctrl.abort();
  });

  it("delivers initial snapshot followed by global-event-backlog frame", async () => {
    const ctrl = new AbortController();
    const res = await fetch(
      `${baseUrl}/events?activity=${encodeURIComponent('.event | startswith("github.")')}`,
      { signal: ctrl.signal },
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();

    const chunk = await readUntil(reader, (b) =>
      b.includes("event: global-event-backlog"),
    );

    expect(chunk).toContain("event: snapshot");
    expect(chunk).toContain("event: global-event-backlog");

    // Extract the backlog frame's data field
    const idx = chunk.indexOf("event: global-event-backlog");
    const tail = chunk.slice(idx);
    const m = tail.match(/data: (\{.*\})\n/);
    expect(m).toBeTruthy();
    const env = JSON.parse(m![1]) as { type: string; data: { events: Array<{ event: string }> } };
    expect(env.type).toBe("global-event-backlog");
    // Backlog should contain only github.* events from our seed
    expect(env.data.events.length).toBe(2);
    for (const e of env.data.events) {
      expect(e.event.startsWith("github.")).toBe(true);
    }

    await reader.cancel().catch(() => {});
    ctrl.abort();
  });

  it("delivers live global-event frames as the file is appended", async () => {
    const ctrl = new AbortController();
    const res = await fetch(
      `${baseUrl}/events?activity=${encodeURIComponent('.event == "github.push"')}`,
      { signal: ctrl.signal },
    );
    const reader = res.body!.getReader();

    // Wait through snapshot + backlog
    await readUntil(reader, (b) => b.includes("event: global-event-backlog"));

    // Append a matching event
    appendFileSync(eventsFile, makeLine("github.push", { scope: { repo: "x/y" } }) + "\n");

    const chunk = await readUntil(
      reader,
      (b) => b.includes("event: global-event\n"),
      3000,
    );
    expect(chunk).toContain("event: global-event\n");

    await reader.cancel().catch(() => {});
    ctrl.abort();
  });

  it("does NOT deliver global-event frames when activity param is absent", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${baseUrl}/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();

    // Read initial chunk (should contain only snapshot)
    const { value } = await reader.read();
    const initial = new TextDecoder().decode(value);
    expect(initial).toContain("event: snapshot");
    expect(initial).not.toContain("event: global-event");

    // Append a line; wait briefly; assert nothing new arrives
    appendFileSync(
      eventsFile,
      makeLine("github.pr.merged", { scope: { pr: 999 } }) + "\n",
    );
    await sleep(400);

    // Drain available chunks; nothing should be a global-event
    const drained = await Promise.race<string>([
      (async () => {
        let buf = "";
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          buf += new TextDecoder().decode(r.value);
          if (buf.length > 0) break;
        }
        return buf;
      })(),
      new Promise<string>((res) => setTimeout(() => res(""), 200)),
    ]);
    expect(drained).not.toContain("event: global-event");

    await reader.cancel().catch(() => {});
    ctrl.abort();
  });

  it("empty predicate (?activity=) opens stream and forwards everything", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${baseUrl}/events?activity=`, {
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();

    const chunk = await readUntil(reader, (b) =>
      b.includes("event: global-event-backlog"),
    );
    const idx = chunk.indexOf("event: global-event-backlog");
    const tail = chunk.slice(idx);
    const m = tail.match(/data: (\{.*\})\n/);
    expect(m).toBeTruthy();
    const env = JSON.parse(m![1]) as { data: { events: unknown[] } };
    // All 3 backlog seeds + the 1 event added by the previous test = 4
    // (file persists across tests within the same beforeAll)
    expect(env.data.events.length).toBeGreaterThanOrEqual(3);

    await reader.cancel().catch(() => {});
    ctrl.abort();
  });
});
