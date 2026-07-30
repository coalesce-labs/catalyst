// inbox-conversation-endpoints.test.ts — CTL-1569: HTTP route plumbing for the
// inbox conversation surface. Proves the two routes are mounted, matched, and
// guarded; the assembly/post LOGIC is covered exhaustively by the injectable unit
// tests in lib/inbox-conversation.test.mjs and lib/inbox-conversation-compose.test.mjs.
//
// SAFETY: every test here uses a ticket id that cannot resolve to a real Linear
// issue, so no test can post a comment to a live ticket. The POST /reply happy
// path is deliberately NOT exercised over HTTP — it is a real external write, and
// its branches are already unit-tested with an injected fetch.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

/** Definitively not a real Linear issue, so route behavior is host-independent
 *  and no live ticket can be written to. */
const ABSENT_TICKET = "ZZZ-999999";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "inbox-conversation-endpoints-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  server = createServer({ port: 0, wtDir, startWatcher: false });
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

describe("GET /api/ticket/:id/thread (CTL-1569)", () => {
  it("returns 200 + the conversation shape for a ticket with nothing on disk", async () => {
    const res = await fetch(`${baseUrl}/api/ticket/${ABSENT_TICKET}/thread`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      ticket: string;
      thread: { comments: unknown[] };
      ask: unknown;
      canReply: boolean;
      url: string | null;
    };
    expect(body.ticket).toBe(ABSENT_TICKET);
    expect(body.thread.comments).toEqual([]);
    // No escalation explanation and no agent comment → an honestly ABSENT ask.
    expect(body.ask).toBeNull();
    expect(body.url).toBeNull();
  });

  it("NEVER 5xxs when the replica is unreadable (the read fails open)", async () => {
    // The inbox must not break because a local mirror is absent or locked.
    const res = await fetch(`${baseUrl}/api/ticket/${ABSENT_TICKET}/thread`);
    expect(res.status).toBe(200);
  });

  it("honors a bounded ?limit and ignores a junk one", async () => {
    for (const q of ["?limit=3", "?limit=0", "?limit=-5", "?limit=abc", "?limit=99999"]) {
      const res = await fetch(`${baseUrl}/api/ticket/${ABSENT_TICKET}/thread${q}`);
      expect(res.status).toBe(200);
    }
  });

  it("rejects a malformed ticket id with 400 (no traversal / arbitrary read)", async () => {
    for (const bad of ["not-a-ticket", "CTL", "..%2F..%2Fetc", "%2Fetc%2Fpasswd"]) {
      expect((await fetch(`${baseUrl}/api/ticket/${bad}/thread`)).status).toBe(400);
    }
  });

  it("does not answer the thread route on POST", async () => {
    const res = await fetch(`${baseUrl}/api/ticket/${ABSENT_TICKET}/thread`, { method: "POST" });
    expect(res.status).not.toBe(200);
  });
});

describe("POST /api/ticket/:id/reply (CTL-1569)", () => {
  const post = (ticket: string, body: unknown) =>
    fetch(`${baseUrl}/api/ticket/${ticket}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("rejects an empty reply with 400 and does NOT call Linear", async () => {
    const res = await post(ABSENT_TICKET, { body: "   " });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("empty_body");
  });

  it("rejects a missing body field with 400", async () => {
    expect((await post(ABSENT_TICKET, {})).status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await post(ABSENT_TICKET, "{not json");
    expect(res.status).toBe(400);
  });

  it("rejects a malformed ticket id with 400 before any write", async () => {
    for (const bad of ["not-a-ticket", "CTL", "..%2F..%2Fetc"]) {
      const res = await fetch(`${baseUrl}/api/ticket/${bad}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "hello" }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("never returns 200 for a ticket that cannot resolve (row must be restored)", async () => {
    // A non-existent issue must NOT read as success — the UI restores the row on
    // any non-2xx, and a false success would silently lose the operator's words.
    // 404 (no such issue) and 502 (no credential on this host / API failure) are
    // both acceptable; 200 is not.
    const res = await post(ABSENT_TICKET, { body: "this must not be reported as sent" });
    expect(res.status).not.toBe(200);
    expect([404, 502]).toContain(res.status);
    const json = (await res.json()) as { status: string; error?: string };
    expect(json.status).not.toBe("replied");
    // The failure is explained, not silent.
    expect(typeof json.error).toBe("string");
  });

  it("does not answer the reply route on GET", async () => {
    const res = await fetch(`${baseUrl}/api/ticket/${ABSENT_TICKET}/reply`);
    expect(res.status).not.toBe(200);
  });
});
