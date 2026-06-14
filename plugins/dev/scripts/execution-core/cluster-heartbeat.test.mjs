// cluster-heartbeat.test.mjs — cross-host liveness channel (CTL-1090).
// Every test injects a fake GraphQL `post` so nothing touches the network.
// Mirrors cluster-claim.test.mjs in structure and pattern.
import { describe, test, expect } from "bun:test";
import {
  heartbeatUrl,
  parseHeartbeatMetadata,
  publishHeartbeat,
  readPeerHeartbeats,
  runCli,
} from "./cluster-heartbeat.mjs";

async function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => {
    chunks.push(typeof s === "string" ? s : s.toString());
    return true;
  };
  try {
    const code = await fn();
    return { code, out: chunks.join("") };
  } finally {
    process.stdout.write = orig;
  }
}

describe("heartbeatUrl", () => {
  test("namespaces per host", () => {
    expect(heartbeatUrl("mini")).toBe("catalyst://heartbeat/mini");
    expect(heartbeatUrl("laptop")).toBe("catalyst://heartbeat/laptop");
  });
});

describe("parseHeartbeatMetadata", () => {
  test("normalises in_flight_tickets to an array", () => {
    expect(parseHeartbeatMetadata({ host: "mini", last_seen: "2026-06-13T01:00:00Z" }))
      .toEqual({ host: "mini", last_seen: "2026-06-13T01:00:00Z", in_flight_tickets: [] });
    expect(parseHeartbeatMetadata({ in_flight_tickets: ["CTL-1"] }).in_flight_tickets)
      .toEqual(["CTL-1"]);
  });

  test("filters non-string entries from in_flight_tickets", () => {
    expect(
      parseHeartbeatMetadata({ in_flight_tickets: ["CTL-1", 42, null, "CTL-2"] }).in_flight_tickets,
    ).toEqual(["CTL-1", "CTL-2"]);
  });

  test("missing/null metadata returns all-null record with empty tickets", () => {
    expect(parseHeartbeatMetadata(undefined)).toEqual({
      host: null,
      last_seen: null,
      in_flight_tickets: [],
    });
    expect(parseHeartbeatMetadata(null)).toEqual({
      host: null,
      last_seen: null,
      in_flight_tickets: [],
    });
  });
});

describe("publishHeartbeat", () => {
  test("upserts the per-host attachment with last_seen + tickets", async () => {
    const calls = [];
    const post = async (q, v) => {
      calls.push({ q, v });
      if (q.includes("ResolveIssue")) return { issues: { nodes: [{ id: "uuid-anchor" }] } };
      return { attachmentCreate: { success: true, attachment: { id: "a1" } } };
    };
    const rec = await publishHeartbeat(
      { anchorIssue: "CTL-9999", host: "mini", inFlightTickets: ["CTL-1", "CTL-2"] },
      { post, now: () => "2026-06-13T01:00:00Z" },
    );
    expect(rec.host).toBe("mini");
    expect(rec.in_flight_tickets).toEqual(["CTL-1", "CTL-2"]);
    const write = calls.find((c) => c.q.includes("attachmentCreate"));
    expect(write.v.input.url).toBe("catalyst://heartbeat/mini");
    expect(write.v.input.metadata.last_seen).toBe("2026-06-13T01:00:00Z");
    expect(write.v.input.metadata.in_flight_tickets).toEqual(["CTL-1", "CTL-2"]);
  });

  test("throws when the anchor issue cannot be resolved", async () => {
    const post = async () => ({ issues: { nodes: [] } });
    await expect(
      publishHeartbeat({ anchorIssue: "CTL-9999", host: "mini" }, { post }),
    ).rejects.toThrow(/no issue found/);
  });

  test("throws when attachmentCreate returns success:false", async () => {
    const post = async (q) => {
      if (q.includes("ResolveIssue")) return { issues: { nodes: [{ id: "uuid-x" }] } };
      return { attachmentCreate: { success: false } };
    };
    await expect(
      publishHeartbeat({ anchorIssue: "CTL-9999", host: "mini" }, { post }),
    ).rejects.toThrow(/success=false/);
  });

  test("defaults inFlightTickets to [] when omitted", async () => {
    const post = async (q) => {
      if (q.includes("ResolveIssue")) return { issues: { nodes: [{ id: "uuid-x" }] } };
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    const rec = await publishHeartbeat(
      { anchorIssue: "CTL-9999", host: "mini" },
      { post, now: () => "2026-06-13T01:00:00Z" },
    );
    expect(rec.in_flight_tickets).toEqual([]);
  });
});

describe("readPeerHeartbeats", () => {
  test("returns one entry per heartbeat attachment, keyed by host", async () => {
    const post = async () => ({
      issue: {
        attachments: {
          nodes: [
            {
              url: "catalyst://heartbeat/mini",
              metadata: { host: "mini", last_seen: "2026-06-13T01:00:00Z", in_flight_tickets: [] },
            },
            {
              url: "catalyst://heartbeat/laptop",
              metadata: {
                host: "laptop",
                last_seen: "2026-06-13T00:50:00Z",
                in_flight_tickets: ["CTL-7"],
              },
            },
            { url: "https://github.com/x/y/pull/1", metadata: {} }, // unrelated — ignored
          ],
        },
      },
    });
    const map = await readPeerHeartbeats({ anchorIssue: "CTL-9999" }, { post });
    expect(Object.keys(map).sort()).toEqual(["laptop", "mini"]);
    expect(map.laptop.in_flight_tickets).toEqual(["CTL-7"]);
    expect(map.mini.last_seen).toBe("2026-06-13T01:00:00Z");
  });

  test("returns {} on a missing anchor / empty attachments", async () => {
    expect(
      await readPeerHeartbeats({ anchorIssue: "CTL-9999" }, { post: async () => ({}) }),
    ).toEqual({});
    expect(
      await readPeerHeartbeats(
        { anchorIssue: "CTL-9999" },
        { post: async () => ({ issue: { attachments: { nodes: [] } } }) },
      ),
    ).toEqual({});
  });

  test("post failure → returns {}", async () => {
    const post = async () => { throw new Error("network error"); };
    expect(await readPeerHeartbeats({ anchorIssue: "CTL-9999" }, { post })).toEqual({});
  });
});

describe("runCli", () => {
  test("publish: prints one JSON line and exits 0", async () => {
    const post = async (q) => {
      if (q.includes("ResolveIssue")) return { issues: { nodes: [{ id: "uuid-x" }] } };
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    const { code, out } = await captureStdout(() =>
      runCli(["publish", "CTL-9999", "mini", "CTL-1,CTL-2"], {
        post,
        now: () => "2026-06-13T01:00:00Z",
      }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.host).toBe("mini");
    expect(parsed.in_flight_tickets).toEqual(["CTL-1", "CTL-2"]);
    expect(parsed.last_seen).toBe("2026-06-13T01:00:00Z");
  });

  test("publish: empty ticketsCsv passes empty in_flight_tickets", async () => {
    const post = async (q) => {
      if (q.includes("ResolveIssue")) return { issues: { nodes: [{ id: "uuid-x" }] } };
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    const { code, out } = await captureStdout(() =>
      runCli(["publish", "CTL-9999", "mini", ""], { post, now: () => "2026-06-13T01:00:00Z" }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out).in_flight_tickets).toEqual([]);
  });

  test("read: prints JSON map and exits 0", async () => {
    const post = async () => ({
      issue: {
        attachments: {
          nodes: [
            {
              url: "catalyst://heartbeat/mini",
              metadata: { host: "mini", last_seen: "2026-06-13T01:00:00Z", in_flight_tickets: [] },
            },
          ],
        },
      },
    });
    const { code, out } = await captureStdout(() => runCli(["read", "CTL-9999"], { post }));
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.mini.host).toBe("mini");
  });

  test("unknown subcommand exits 1", async () => {
    const { code } = await captureStdout(() => runCli(["bogus"], {}));
    expect(code).toBe(1);
  });
});
