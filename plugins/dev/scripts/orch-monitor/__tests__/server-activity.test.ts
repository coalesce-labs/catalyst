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

/**
 * Open a body reader narrowed to the zero-arg default-reader shape `readUntil`
 * needs. The DOM `getReader()` overload set widens to a Default|BYOB union; the
 * BYOB branch's `read(view)` is incompatible with `MinimalReader`. We always
 * use the default reader, so narrow on the absence of the BYOB-only `read`
 * arity rather than asserting a cast.
 */
function bodyReader(
  res: Response,
): MinimalReader & { cancel(): Promise<void> } {
  const reader = res.body!.getReader();
  // The default reader's read() takes no required argument; the BYOB reader's
  // does. `readUntil` only ever calls read() with none, so the default reader
  // is the correct (and only) shape we open here.
  return reader as MinimalReader & { cancel(): Promise<void> };
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

  // CTL-1224: a non-matching live append must NOT reach a predicated client —
  // proves the per-client jq still gates the SHARED ring fan-out.
  it("does NOT deliver a live global-event for a non-matching line (per-client jq gates the shared tail)", async () => {
    const ctrl = new AbortController();
    const res = await fetch(
      `${baseUrl}/events?activity=${encodeURIComponent('.event == "github.unique.match.evt"')}`,
      { signal: ctrl.signal },
    );
    const reader = res.body!.getReader();
    await readUntil(reader, (b) => b.includes("event: global-event-backlog"));

    // Append a NON-matching line, then a matching one. The non-matching line
    // must be filtered out; the matching one must arrive.
    appendFileSync(eventsFile, makeLine("linear.no.match.evt") + "\n");
    appendFileSync(eventsFile, makeLine("github.unique.match.evt") + "\n");

    const chunk = await readUntil(
      reader,
      (b) => b.includes("event: global-event\n"),
      3000,
    );
    // Only the matching event appears in any global-event frame.
    expect(chunk).toContain("github.unique.match.evt");
    const globalIdx = chunk.indexOf("event: global-event\n");
    const liveTail = chunk.slice(globalIdx);
    expect(liveTail).not.toContain("linear.no.match.evt");

    await reader.cancel().catch(() => {});
    ctrl.abort();
  });
});

// CTL-1224: shared-ring fan-out + leak audit. These use the `__`-prefixed debug
// seams (ringListenerCount / sseClientCount) the server exposes for tests; the
// UI never reads them.
interface DebugServer {
  __ringListenerCount?: () => number;
  __sseClientCount?: () => number;
}

describe("activity stream — shared ring fan-out (CTL-1224)", () => {
  it("T7 — disconnect removes the client AND its ring subscription (no leak)", async () => {
    const dbg = server as unknown as DebugServer;
    expect(typeof dbg.__ringListenerCount).toBe("function");
    expect(typeof dbg.__sseClientCount).toBe("function");

    // Let any async cleanup from earlier tests settle so the baseline is stable.
    await sleep(200);
    const baseListeners = dbg.__ringListenerCount!();
    const baseClients = dbg.__sseClientCount!();

    const ctrl = new AbortController();
    const res = await fetch(
      `${baseUrl}/events?activity=${encodeURIComponent('.event == "github.pr.merged"')}`,
      { signal: ctrl.signal },
    );
    const reader = res.body!.getReader();
    await readUntil(reader, (b) => b.includes("event: global-event-backlog"));

    // While connected: one extra ring listener + one extra sse client. The
    // onAppend registration runs in the stream start() right after the backlog
    // frame; give it a beat to settle before asserting.
    for (let i = 0; i < 50; i++) {
      if (dbg.__ringListenerCount!() === baseListeners + 1) break;
      await sleep(20);
    }
    expect(dbg.__ringListenerCount!()).toBe(baseListeners + 1);
    expect(dbg.__sseClientCount!()).toBe(baseClients + 1);

    // Disconnect.
    await reader.cancel().catch(() => {});
    ctrl.abort();

    // Cleanup must run: both counters return to baseline (no listener/client leak).
    for (let i = 0; i < 50; i++) {
      if (
        dbg.__ringListenerCount!() === baseListeners &&
        dbg.__sseClientCount!() === baseClients
      )
        break;
      await sleep(20);
    }
    expect(dbg.__ringListenerCount!()).toBe(baseListeners);
    expect(dbg.__sseClientCount!()).toBe(baseClients);
  });

  it("T8 — N clients share ONE backend tail; one append fans out to all", async () => {
    const dbg = server as unknown as DebugServer;
    const baseListeners = dbg.__ringListenerCount!();

    const M = 3;
    const pred = '.event == "github.fanout.evt"';
    const ctrls: AbortController[] = [];
    const readers: Array<MinimalReader & { cancel(): Promise<void> }> = [];
    for (let i = 0; i < M; i++) {
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      const res = await fetch(
        `${baseUrl}/events?activity=${encodeURIComponent(pred)}`,
        { signal: ctrl.signal },
      );
      const reader = bodyReader(res);
      readers.push(reader);
      await readUntil(reader, (b) => b.includes("event: global-event-backlog"));
    }

    // M extra listeners on the ONE shared ring (no per-client tail loop).
    expect(dbg.__ringListenerCount!()).toBe(baseListeners + M);

    // ONE append must reach ALL M readers exactly once each.
    appendFileSync(eventsFile, makeLine("github.fanout.evt", { uniq: "fan1" }) + "\n");

    for (const reader of readers) {
      const chunk = await readUntil(
        reader,
        (b) => b.includes("event: global-event\n") && b.includes("fan1"),
        3000,
      );
      expect(chunk).toContain("github.fanout.evt");
      expect(chunk).toContain("fan1");
    }

    for (const reader of readers) await reader.cancel().catch(() => {});
    for (const ctrl of ctrls) ctrl.abort();

    // All M listeners deregistered on disconnect.
    for (let i = 0; i < 50; i++) {
      if (dbg.__ringListenerCount!() === baseListeners) break;
      await sleep(20);
    }
    expect(dbg.__ringListenerCount!()).toBe(baseListeners);
  });
});
