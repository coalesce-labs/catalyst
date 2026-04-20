import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCommsReader,
  isValidChannelName,
  parseOrchIdFromChannelName,
  parseJsonlLine,
  participantStaleness,
} from "../lib/comms-reader";
import type { CommsMessage, CommsParticipant } from "../lib/comms-types";

function participant(name: string, overrides: Partial<CommsParticipant> = {}): CommsParticipant {
  return {
    name,
    joined: "2026-04-20T00:00:00Z",
    ttl: 600,
    lastSeen: "2026-04-20T00:05:00Z",
    capabilities: "",
    parent: null,
    orch: null,
    status: "active",
    ...overrides,
  };
}

function message(overrides: Partial<CommsMessage> = {}): CommsMessage {
  return {
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
  };
}

describe("isValidChannelName", () => {
  const cases: [string, boolean][] = [
    ["orch-ctl-ux-apr20", true],
    ["demo_channel-1", true],
    ["a", true],
    ["../etc/passwd", false],
    ["channels/foo", false],
    ["", false],
    ["with space", false],
    ["name.with.dot", false],
    ["slash\\back", false],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(isValidChannelName(input)).toBe(expected);
    });
  }
});

describe("parseOrchIdFromChannelName", () => {
  it("strips orch- prefix", () => {
    expect(parseOrchIdFromChannelName("orch-ctl-ux-apr20")).toBe("ctl-ux-apr20");
  });
  it("returns null when not an orch channel", () => {
    expect(parseOrchIdFromChannelName("demo")).toBeNull();
  });
  it("returns null when prefix only", () => {
    expect(parseOrchIdFromChannelName("orch-")).toBeNull();
  });
});

describe("parseJsonlLine", () => {
  it("returns null on blank or whitespace", () => {
    expect(parseJsonlLine("")).toBeNull();
    expect(parseJsonlLine("   ")).toBeNull();
    expect(parseJsonlLine("\n")).toBeNull();
  });
  it("returns null on invalid JSON", () => {
    expect(parseJsonlLine("not json")).toBeNull();
    expect(parseJsonlLine("{oops")).toBeNull();
  });
  it("returns null on shape violations", () => {
    expect(parseJsonlLine(JSON.stringify({ foo: 1 }))).toBeNull();
    expect(parseJsonlLine(JSON.stringify({ id: 1, ts: "x" }))).toBeNull();
  });
  it("parses valid messages", () => {
    const m = message({ id: "msg-1", body: "hi" });
    const parsed = parseJsonlLine(JSON.stringify(m));
    expect(parsed?.id).toBe("msg-1");
    expect(parsed?.body).toBe("hi");
  });
});

describe("participantStaleness", () => {
  it("marks stale when lastSeen + ttl < now", () => {
    const p = participant("x", { ttl: 60, lastSeen: "2026-04-20T00:00:00Z" });
    const { stale } = participantStaleness(p, Date.parse("2026-04-20T00:02:00Z"));
    expect(stale).toBe(true);
  });
  it("keeps fresh within ttl", () => {
    const p = participant("x", { ttl: 600, lastSeen: "2026-04-20T00:00:00Z" });
    const { stale } = participantStaleness(p, Date.parse("2026-04-20T00:05:00Z"));
    expect(stale).toBe(false);
  });
  it("treats unparseable lastSeen as stale", () => {
    const p = participant("x", { lastSeen: "garbage" });
    const { stale } = participantStaleness(p, Date.now());
    expect(stale).toBe(true);
  });
});

describe("CommsReader — listChannels", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comms-"));
    mkdirSync(join(dir, "channels"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns [] when registry missing", async () => {
    const reader = createCommsReader({ commsDir: dir });
    expect(await reader.listChannels()).toEqual([]);
  });

  it("returns [] when registry is empty object", async () => {
    writeFileSync(join(dir, "channels.json"), "{}");
    const reader = createCommsReader({ commsDir: dir });
    expect(await reader.listChannels()).toEqual([]);
  });

  it("returns [] when registry is malformed", async () => {
    writeFileSync(join(dir, "channels.json"), "not json");
    const reader = createCommsReader({ commsDir: dir });
    expect(await reader.listChannels()).toEqual([]);
  });

  it("summarizes channels with counts, authors, and last activity", async () => {
    writeFileSync(
      join(dir, "channels.json"),
      JSON.stringify({
        "orch-demo": {
          name: "orch-demo",
          topic: "wave 2",
          created: "2026-04-20T00:00:00Z",
          participants: [
            participant("orchestrator"),
            participant("CTL-112", { lastSeen: "2026-04-20T00:06:00Z" }),
          ],
        },
      }),
    );
    writeFileSync(
      join(dir, "channels", "orch-demo.jsonl"),
      [
        JSON.stringify(message({ id: "msg-1", from: "orchestrator", ts: "2026-04-20T00:01:00Z" })),
        JSON.stringify(message({ id: "msg-2", from: "CTL-112", ts: "2026-04-20T00:06:00Z", type: "attention" })),
      ].join("\n") + "\n",
    );

    const reader = createCommsReader({ commsDir: dir });
    const channels = await reader.listChannels();
    expect(channels).toHaveLength(1);
    const c = channels[0];
    expect(c.name).toBe("orch-demo");
    expect(c.participantCount).toBe(2);
    expect(c.messageCount).toBe(2);
    expect(c.orchId).toBe("demo");
    expect(c.archived).toBe(false);
    expect(c.lastActivity).toBe("2026-04-20T00:06:00Z");
    expect(c.authors.sort()).toEqual(["CTL-112", "orchestrator"]);
    expect(c.topic).toBe("wave 2");
  });

  it("returns zero counts when channel JSONL is missing", async () => {
    writeFileSync(
      join(dir, "channels.json"),
      JSON.stringify({
        "orch-empty": { name: "orch-empty", participants: [participant("o")] },
      }),
    );
    const reader = createCommsReader({ commsDir: dir });
    const channels = await reader.listChannels();
    expect(channels[0].messageCount).toBe(0);
    expect(channels[0].authors).toEqual([]);
    expect(channels[0].lastActivity).toBe("2026-04-20T00:05:00Z"); // from participant lastSeen
  });
});

describe("CommsReader — getChannel", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comms-"));
    mkdirSync(join(dir, "channels"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null for invalid channel name", async () => {
    writeFileSync(join(dir, "channels.json"), "{}");
    const reader = createCommsReader({ commsDir: dir });
    expect(await reader.getChannel("../etc/passwd")).toBeNull();
    expect(await reader.getChannel("slash/no")).toBeNull();
  });

  it("returns null for unknown channel", async () => {
    writeFileSync(join(dir, "channels.json"), "{}");
    const reader = createCommsReader({ commsDir: dir });
    expect(await reader.getChannel("nonexistent")).toBeNull();
  });

  it("returns detail with participants, messages, and tailOffset", async () => {
    writeFileSync(
      join(dir, "channels.json"),
      JSON.stringify({
        demo: { name: "demo", participants: [participant("a"), participant("b")] },
      }),
    );
    const line1 = JSON.stringify(message({ id: "msg-1", ch: "demo" })) + "\n";
    const line2 = JSON.stringify(message({ id: "msg-2", ch: "demo", ts: "2026-04-20T00:02:00Z" })) + "\n";
    writeFileSync(join(dir, "channels", "demo.jsonl"), line1 + line2);

    const reader = createCommsReader({ commsDir: dir });
    const detail = await reader.getChannel("demo");
    expect(detail).not.toBeNull();
    expect(detail!.participants).toHaveLength(2);
    expect(detail!.messages).toHaveLength(2);
    expect(detail!.messages[0].id).toBe("msg-1"); // chronological ascending
    expect(detail!.messages[1].id).toBe("msg-2");
    expect(detail!.total).toBe(2);
    expect(detail!.tailOffset).toBe(Buffer.byteLength(line1 + line2));
  });

  it("respects limit by returning the last N messages", async () => {
    writeFileSync(
      join(dir, "channels.json"),
      JSON.stringify({ demo: { name: "demo", participants: [] } }),
    );
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify(message({ id: `msg-${i}`, ch: "demo", ts: `2026-04-20T00:0${i}:00Z` })),
    );
    writeFileSync(join(dir, "channels", "demo.jsonl"), lines.join("\n") + "\n");

    const reader = createCommsReader({ commsDir: dir });
    const detail = await reader.getChannel("demo", { limit: 2 });
    expect(detail!.messages).toHaveLength(2);
    expect(detail!.messages[0].id).toBe("msg-3");
    expect(detail!.messages[1].id).toBe("msg-4");
    expect(detail!.total).toBe(5);
  });

  it("skips corrupt JSONL lines", async () => {
    writeFileSync(
      join(dir, "channels.json"),
      JSON.stringify({ demo: { name: "demo", participants: [] } }),
    );
    writeFileSync(
      join(dir, "channels", "demo.jsonl"),
      [
        JSON.stringify(message({ id: "msg-1", ch: "demo" })),
        "not json",
        "",
        JSON.stringify(message({ id: "msg-2", ch: "demo", ts: "2026-04-20T00:02:00Z" })),
      ].join("\n"),
    );
    const reader = createCommsReader({ commsDir: dir });
    const detail = await reader.getChannel("demo");
    expect(detail!.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
    expect(detail!.total).toBe(2);
  });
});

describe("CommsReader — tailChannel", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comms-"));
    mkdirSync(join(dir, "channels"), { recursive: true });
    writeFileSync(join(dir, "channels.json"), JSON.stringify({ demo: { name: "demo", participants: [] } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects invalid channel name", async () => {
    const reader = createCommsReader({ commsDir: dir });
    const out = await reader.tailChannel("..", 0);
    expect(out.messages).toEqual([]);
    expect(out.newOffset).toBe(0);
  });

  it("returns only new lines appended after the given offset", async () => {
    const p = join(dir, "channels", "demo.jsonl");
    const line1 = JSON.stringify(message({ id: "msg-1", ch: "demo" })) + "\n";
    writeFileSync(p, line1);

    const reader = createCommsReader({ commsDir: dir });
    const first = await reader.tailChannel("demo", 0);
    expect(first.messages).toHaveLength(1);
    expect(first.newOffset).toBe(Buffer.byteLength(line1));

    const line2 = JSON.stringify(message({ id: "msg-2", ch: "demo", ts: "2026-04-20T00:02:00Z" })) + "\n";
    appendFileSync(p, line2);
    const second = await reader.tailChannel("demo", first.newOffset);
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].id).toBe("msg-2");
    expect(second.newOffset).toBe(Buffer.byteLength(line1 + line2));
  });

  it("handles missing file gracefully", async () => {
    const reader = createCommsReader({ commsDir: dir });
    const out = await reader.tailChannel("demo", 0);
    expect(out.messages).toEqual([]);
    expect(out.newOffset).toBe(0);
  });

  it("resets offset when file has shrunk (truncation)", async () => {
    const p = join(dir, "channels", "demo.jsonl");
    writeFileSync(p, JSON.stringify(message({ id: "msg-1" })) + "\n");
    const reader = createCommsReader({ commsDir: dir });
    // Pretend we're at a far larger offset than the file size.
    const out = await reader.tailChannel("demo", 99999);
    expect(out.messages).toHaveLength(1);
    expect(out.newOffset).toBeLessThan(99999);
  });
});

describe("CommsReader — getParticipant", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "comms-"));
    mkdirSync(join(dir, "channels"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null when not found", async () => {
    writeFileSync(join(dir, "channels.json"), "{}");
    const reader = createCommsReader({ commsDir: dir });
    expect(await reader.getParticipant("ghost")).toBeNull();
  });

  it("aggregates capabilities, channels, and lastSeen across channels", async () => {
    writeFileSync(
      join(dir, "channels.json"),
      JSON.stringify({
        a: {
          name: "a",
          participants: [participant("bob", { capabilities: "foo bar", lastSeen: "2026-04-20T00:01:00Z" })],
        },
        b: {
          name: "b",
          participants: [participant("bob", { capabilities: "bar baz", lastSeen: "2026-04-20T00:05:00Z" })],
        },
        c: {
          name: "c",
          participants: [participant("alice")],
        },
      }),
    );
    const reader = createCommsReader({ commsDir: dir });
    const detail = await reader.getParticipant("bob");
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe("bob");
    expect(detail!.channels.sort()).toEqual(["a", "b"]);
    expect(detail!.aggregateCapabilities.sort()).toEqual(["bar", "baz", "foo"]);
    expect(detail!.lastSeen).toBe("2026-04-20T00:05:00Z");
  });
});
