// cluster-heartbeat.test.mjs — cross-host liveness channel (CTL-1090).
// Every test injects a fake GraphQL `post` so nothing touches the network.
// Mirrors cluster-claim.test.mjs in structure and pattern.
import { describe, test, expect } from "bun:test";
import {
  heartbeatUrl,
  isRateClassLinearError,
  parseHeartbeatMetadata,
  publishHeartbeat,
  readPeerHeartbeats,
  resolveIssueId,
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
      .toMatchObject({ host: "mini", last_seen: "2026-06-13T01:00:00Z", in_flight_tickets: [] });
    expect(parseHeartbeatMetadata({ in_flight_tickets: ["CTL-1"] }).in_flight_tickets)
      .toEqual(["CTL-1"]);
  });

  test("filters non-string entries from in_flight_tickets", () => {
    expect(
      parseHeartbeatMetadata({ in_flight_tickets: ["CTL-1", 42, null, "CTL-2"] }).in_flight_tickets,
    ).toEqual(["CTL-1", "CTL-2"]);
  });

  test("missing/null metadata returns all-null record with empty tickets", () => {
    expect(parseHeartbeatMetadata(undefined)).toMatchObject({
      host: null,
      last_seen: null,
      in_flight_tickets: [],
      max_parallel: null,
      in_flight_count: 0,
    });
    expect(parseHeartbeatMetadata(null)).toMatchObject({
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
      if (q.includes("ResolveIssue")) return { issue: { id: "uuid-anchor" } };
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
    const post = async () => ({ issue: null });
    await expect(
      publishHeartbeat({ anchorIssue: "CTL-9999", host: "mini" }, { post }),
    ).rejects.toThrow(/no issue found/);
  });

  // CTL-1255 regression guard: the resolve query MUST use issue(id:) — the human
  // identifier accessor Linear accepts — not issues(filter:{identifier}), which is
  // a hard 400 (IssueFilter has no identifier field). The old fakes returned the
  // wrong {issues:{nodes}} shape and so masked the live failure for the whole
  // CTL-1090 → CTL-1251 window.
  test("resolve query targets issue(id:) and reads issue.id (not issues.nodes)", async () => {
    let resolveQ = "";
    const post = async (q) => {
      if (q.includes("issue(id:") && !q.includes("attachmentCreate")) {
        resolveQ = q;
        return { issue: { id: "uuid-anchor" } };
      }
      // a fake that ONLY answers the issue(id:) shape — if the code still used
      // issues(filter:), issueId would be null and this would throw "no issue found"
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    await publishHeartbeat({ anchorIssue: "CTL-9999", host: "mini" }, { post });
    expect(resolveQ).toContain("issue(id: $id)");
    expect(resolveQ).not.toContain("identifier");
  });

  test("throws when attachmentCreate returns success:false", async () => {
    const post = async (q) => {
      if (q.includes("ResolveIssue")) return { issue: { id: "uuid-x" } };
      return { attachmentCreate: { success: false } };
    };
    await expect(
      publishHeartbeat({ anchorIssue: "CTL-9999", host: "mini" }, { post }),
    ).rejects.toThrow(/success=false/);
  });

  test("defaults inFlightTickets to [] when omitted", async () => {
    const post = async (q) => {
      if (q.includes("ResolveIssue")) return { issue: { id: "uuid-x" } };
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    const rec = await publishHeartbeat(
      { anchorIssue: "CTL-9999", host: "mini" },
      { post, now: () => "2026-06-13T01:00:00Z" },
    );
    expect(rec.in_flight_tickets).toEqual([]);
  });

  // CTL-863 fleet-unfreeze (entourage follow-up to #2552): a pre-resolved issueId
  // override skips the ResolveIssueId round-trip entirely.
  test("an issueId override SKIPS resolveIssueId — only attachmentCreate is called", async () => {
    const calls = [];
    const post = async (q, v) => {
      calls.push(q);
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    const rec = await publishHeartbeat(
      { anchorIssue: "CTL-9999", host: "mini" },
      { post, now: () => "2026-06-13T01:00:00Z", issueId: "uuid-anchor" },
    );
    expect(rec.host).toBe("mini");
    expect(calls.length).toBe(1); // ONLY attachmentCreate — no ResolveIssueId call
    expect(calls[0]).toContain("attachmentCreate");
  });

  test("no issueId override → falls through to resolveIssueId unchanged", async () => {
    const calls = [];
    const post = async (q) => {
      calls.push(q);
      if (q.includes("ResolveIssue")) return { issue: { id: "uuid-x" } };
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    await publishHeartbeat({ anchorIssue: "CTL-9999", host: "mini" }, { post, issueId: null });
    expect(calls.some((q) => q.includes("ResolveIssue"))).toBe(true);
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
      if (q.includes("ResolveIssue")) return { issue: { id: "uuid-x" } };
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
      if (q.includes("ResolveIssue")) return { issue: { id: "uuid-x" } };
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    const { code, out } = await captureStdout(() =>
      runCli(["publish", "CTL-9999", "mini", ""], { post, now: () => "2026-06-13T01:00:00Z" }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out).in_flight_tickets).toEqual([]);
  });

  test("CTL-1092 publish: 4th arg sets max_parallel (positive int)", async () => {
    const post = async (q) => {
      if (q.includes("ResolveIssue")) return { issue: { id: "uuid-x" } };
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    const { code, out } = await captureStdout(() =>
      runCli(["publish", "CTL-9999", "mini", "CTL-1", "3"], { post, now: () => "2026-06-13T01:00:00Z" }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out).max_parallel).toBe(3);
  });

  test("CTL-1092 publish: absent/blank/non-positive 4th arg → max_parallel null (back-compat)", async () => {
    const post = async (q) => {
      if (q.includes("ResolveIssue")) return { issue: { id: "uuid-x" } };
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    const run = async (argv) => {
      const { out } = await captureStdout(() => runCli(argv, { post, now: () => "t" }));
      return JSON.parse(out).max_parallel;
    };
    expect(await run(["publish", "CTL-9999", "mini", "CTL-1"])).toBe(null); // 3-arg form
    expect(await run(["publish", "CTL-9999", "mini", "CTL-1", ""])).toBe(null);
    expect(await run(["publish", "CTL-9999", "mini", "CTL-1", "0"])).toBe(null);
    expect(await run(["publish", "CTL-9999", "mini", "CTL-1", "-2"])).toBe(null);
    expect(await run(["publish", "CTL-9999", "mini", "CTL-1", "abc"])).toBe(null);
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

  // CTL-863 fleet-unfreeze (entourage follow-up to #2552).
  test("resolve-anchor: prints {issueId} and exits 0", async () => {
    const post = async (q) => {
      if (q.includes("ResolveIssue")) return { issue: { id: "uuid-anchor" } };
      throw new Error("unexpected query");
    };
    const { code, out } = await captureStdout(() => runCli(["resolve-anchor", "CTL-9999"], { post }));
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ issueId: "uuid-anchor" });
  });

  test("resolve-anchor: {issueId:null} when the anchor cannot be resolved", async () => {
    const post = async () => ({ issue: null });
    const { code, out } = await captureStdout(() => runCli(["resolve-anchor", "CTL-9999"], { post }));
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ issueId: null });
  });

  test("publish: an optional 5th issueId arg skips ResolveIssueId (only attachmentCreate)", async () => {
    const calls = [];
    const post = async (q) => {
      calls.push(q);
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    const { code, out } = await captureStdout(() =>
      runCli(["publish", "CTL-9999", "mini", "CTL-1", "", "uuid-anchor"], {
        post,
        now: () => "2026-06-13T01:00:00Z",
      }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out).host).toBe("mini");
    expect(calls.some((q) => q.includes("ResolveIssue"))).toBe(false);
  });
});

// CTL-1420 follow-up: rate-class discriminator + defaultPost body-reading.
describe("isRateClassLinearError (CTL-1420)", () => {
  test("recognizes Linear's RATELIMITED complexity code (served as HTTP 400)", () => {
    expect(isRateClassLinearError('{"errors":[{"extensions":{"code":"RATELIMITED"}}]}')).toBe(true);
  });
  test("recognizes the classic 429 rate-limit message", () => {
    expect(isRateClassLinearError("Rate limit exceeded. Only 5000 requests are allowed per hour")).toBe(true);
    expect(isRateClassLinearError("linear graphql http 429")).toBe(true);
  });
  test("does NOT flag a genuine bad-request 400 (query/schema error)", () => {
    expect(isRateClassLinearError('{"errors":[{"message":"Field foo is not defined by type IssueFilter","extensions":{"code":"INVALID_INPUT"}}]}')).toBe(false);
  });
  test("empty / nullish input is not rate-class", () => {
    expect(isRateClassLinearError("")).toBe(false);
    expect(isRateClassLinearError(null)).toBe(false);
    expect(isRateClassLinearError(undefined)).toBe(false);
  });
});

describe("defaultPost — !res.ok body handling (CTL-1420)", () => {
  const realFetch = globalThis.fetch;
  function mockFetch({ ok, status, body }) {
    globalThis.fetch = async () => ({
      ok,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    });
  }
  function restore() {
    globalThis.fetch = realFetch;
  }

  test("a rate-class 400 (RATELIMITED) is READ and TAGGED [RATELIMITED] in the thrown error", async () => {
    mockFetch({ ok: false, status: 400, body: '{"errors":[{"extensions":{"code":"RATELIMITED"},"message":"complexity limit"}]}' });
    try {
      await expect(resolveIssueId("CTL-9")).rejects.toThrow(/\[RATELIMITED\]/);
    } finally {
      restore();
    }
  });

  test("a genuine bad-request 400 SURFACES the body but is NOT tagged rate-class", async () => {
    mockFetch({ ok: false, status: 400, body: '{"errors":[{"message":"Field foo is not defined by type IssueFilter"}]}' });
    try {
      let msg = "";
      await resolveIssueId("CTL-9").catch((e) => { msg = e.message; });
      expect(msg).toContain("http 400");
      expect(msg).toContain("IssueFilter"); // body surfaced (was previously discarded)
      expect(msg).not.toContain("[RATELIMITED]"); // not masked as rate-limited
    } finally {
      restore();
    }
  });

  test("a 429 is tagged rate-class even if the body is unreadable", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => { throw new Error("no body"); } });
    try {
      await expect(resolveIssueId("CTL-9")).rejects.toThrow(/\[RATELIMITED\]/);
    } finally {
      restore();
    }
  });
});
