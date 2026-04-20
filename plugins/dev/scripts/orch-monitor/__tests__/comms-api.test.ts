import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";
import { createCommsReader } from "../lib/comms-reader";
import type { CommsChannelDetail, CommsChannelSummary, CommsParticipantDetail } from "../lib/comms-types";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;
let commsDir: string;

const participantJson = (name: string, lastSeen = "2026-04-20T00:05:00Z", capabilities = "") =>
  JSON.stringify({
    name,
    joined: "2026-04-20T00:00:00Z",
    ttl: 600,
    lastSeen,
    capabilities,
    parent: null,
    orch: null,
    status: "active",
  });

const messageLine = (overrides: Record<string, unknown>) =>
  JSON.stringify({
    id: "msg-" + Math.random().toString(36).slice(2),
    from: "orchestrator",
    to: "all",
    ch: "orch-demo",
    parent: null,
    orch: "demo",
    ts: "2026-04-20T00:01:00Z",
    type: "info",
    re: null,
    body: "hello",
    ...overrides,
  });

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "orch-monitor-comms-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  commsDir = join(tmpDir, "comms");
  mkdirSync(join(commsDir, "channels"), { recursive: true });

  writeFileSync(
    join(commsDir, "channels.json"),
    JSON.stringify({
      "orch-demo": {
        name: "orch-demo",
        topic: "wave 2",
        created: "2026-04-20T00:00:00Z",
        participants: [
          JSON.parse(participantJson("orchestrator")),
          JSON.parse(participantJson("CTL-112", "2026-04-20T00:06:00Z", "implements ui")),
        ],
      },
      "empty-channel": {
        name: "empty-channel",
        participants: [JSON.parse(participantJson("lonely"))],
      },
    }),
  );

  const jsonl = [
    messageLine({ id: "msg-1", from: "orchestrator", ts: "2026-04-20T00:01:00Z", body: "kick off" }),
    messageLine({ id: "msg-2", from: "CTL-112", ts: "2026-04-20T00:06:00Z", type: "attention", body: "stuck" }),
  ].join("\n") + "\n";
  writeFileSync(join(commsDir, "channels", "orch-demo.jsonl"), jsonl);

  const annotationsDbPath = join(tmpDir, "annotations.db");
  server = createServer({
    port: 0,
    wtDir,
    startWatcher: false,
    annotationsDbPath,
    commsReader: createCommsReader({ commsDir }),
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("GET /api/comms/channels", () => {
  it("returns summaries including counts, authors, orchId", async () => {
    const r = await fetch(`${baseUrl}/api/comms/channels`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { channels: CommsChannelSummary[] };
    expect(body.channels).toHaveLength(2);
    const demo = body.channels.find((c) => c.name === "orch-demo");
    expect(demo).toBeDefined();
    expect(demo!.participantCount).toBe(2);
    expect(demo!.messageCount).toBe(2);
    expect(demo!.orchId).toBe("demo");
    expect(demo!.authors.sort()).toEqual(["CTL-112", "orchestrator"]);
    expect(demo!.lastActivity).toBe("2026-04-20T00:06:00Z");
  });

  it("returns empty-channel with zero messages", async () => {
    const r = await fetch(`${baseUrl}/api/comms/channels`);
    const body = (await r.json()) as { channels: CommsChannelSummary[] };
    const empty = body.channels.find((c) => c.name === "empty-channel");
    expect(empty).toBeDefined();
    expect(empty!.messageCount).toBe(0);
  });
});

describe("GET /api/comms/channels/:name", () => {
  it("returns detail with participants and messages", async () => {
    const r = await fetch(`${baseUrl}/api/comms/channels/orch-demo?limit=10`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as CommsChannelDetail;
    expect(body.name).toBe("orch-demo");
    expect(body.participants).toHaveLength(2);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].id).toBe("msg-1");
    expect(body.total).toBe(2);
    expect(typeof body.tailOffset).toBe("number");
  });

  it("rejects traversal attempts with 400", async () => {
    const r = await fetch(`${baseUrl}/api/comms/channels/..%2Fetc%2Fpasswd`);
    expect(r.status).toBe(400);
  });

  it("rejects names with path separators", async () => {
    const r = await fetch(`${baseUrl}/api/comms/channels/foo%2Fbar`);
    expect(r.status).toBe(400);
  });

  it("returns 404 for unknown channel", async () => {
    const r = await fetch(`${baseUrl}/api/comms/channels/doesnotexist`);
    expect(r.status).toBe(404);
  });

  it("caps limit at 1000", async () => {
    const r = await fetch(`${baseUrl}/api/comms/channels/orch-demo?limit=999999`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as CommsChannelDetail;
    expect(body.messages.length).toBeLessThanOrEqual(1000);
  });
});

describe("GET /api/comms/participants/:name", () => {
  it("returns aggregated participant info", async () => {
    const r = await fetch(`${baseUrl}/api/comms/participants/CTL-112`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as CommsParticipantDetail;
    expect(body.name).toBe("CTL-112");
    expect(body.channels).toContain("orch-demo");
    expect(body.aggregateCapabilities.sort()).toEqual(["implements", "ui"]);
  });

  it("returns 404 for unknown participant", async () => {
    const r = await fetch(`${baseUrl}/api/comms/participants/ghost`);
    expect(r.status).toBe(404);
  });

  it("rejects names containing slash with 400", async () => {
    const r = await fetch(`${baseUrl}/api/comms/participants/foo%2Fbar`);
    expect(r.status).toBe(400);
  });
});

describe("GET /api/comms/channels/:name/stream", () => {
  it("rejects invalid channel name with 400", async () => {
    const r = await fetch(`${baseUrl}/api/comms/channels/..%2Fetc/stream`);
    expect(r.status).toBe(400);
    await r.body?.cancel();
  });

  it("opens SSE with initial snapshot containing messages", async () => {
    const r = await fetch(`${baseUrl}/api/comms/channels/orch-demo/stream`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const reader = r.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: snapshot");
    expect(text).toContain("orch-demo");
    expect(text).toContain("msg-1");
    await reader.cancel();
  });

  it("emits a message event when a new line is appended", async () => {
    const r = await fetch(`${baseUrl}/api/comms/channels/orch-demo/stream`);
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    // Consume the snapshot frame.
    await reader.read();

    const newLine = messageLine({ id: "msg-live", ts: "2026-04-20T00:10:00Z", body: "live!" }) + "\n";
    appendFileSync(join(commsDir, "channels", "orch-demo.jsonl"), newLine);

    let sawMessage = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !sawMessage) {
      const { value } = await reader.read();
      if (!value) break;
      const chunk = new TextDecoder().decode(value);
      if (chunk.includes("event: message") && chunk.includes("msg-live")) {
        sawMessage = true;
      }
    }
    await reader.cancel();
    expect(sawMessage).toBe(true);
  }, 10_000);
});
