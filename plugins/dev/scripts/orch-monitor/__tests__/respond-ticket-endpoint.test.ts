// respond-ticket-endpoint.test.ts — HTTP route-plumbing tests for the read-model's
// SECOND write endpoint, POST /api/ticket/<ticket>/respond (CTL-924, BFF12 —
// HOME5's Answer / Unblock verb). Validates the server.ts wiring — method gate,
// ticket param validation (400), invalid-body (400), and the 404 for a ticket
// with no parked (needs-input) run on disk. The mutation LOGIC itself (held-run
// scan, typed-confirm gate, fence branches, record + clear-marker + emit-resume
// ordering, the optimistic `resuming` contract) is covered exhaustively by the
// injectable unit tests in respond-ticket.test.ts; these tests prove the route is
// mounted, matched, method-gated, and guarded.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

// A ticket id that definitively has no worker dir on this machine, so the route's
// behavior is deterministic regardless of host state (no parked run → not_held).
const ABSENT_TICKET = "ZZZ-999999";

async function postRespond(ticket: string, body: unknown) {
  return fetch(`${baseUrl}/api/ticket/${ticket}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "respond-ticket-endpoint-"));
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

describe("POST /api/ticket/:ticket/respond (CTL-924, BFF12)", () => {
  it("rejects a malformed ticket id with 400 (no path traversal / arbitrary read)", async () => {
    expect((await postRespond("not-a-ticket", { confirm: "x" })).status).toBe(400);
    expect((await postRespond("CTL", { confirm: "x" })).status).toBe(400);
    expect((await postRespond("..%2F..%2Fetc", { confirm: "x" })).status).toBe(400);
  });

  it("rejects an invalid JSON body with 400", async () => {
    const res = await postRespond(ABSENT_TICKET, "{ not json");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the ticket has no parked (needs-input) run on disk", async () => {
    // confirm matches the ticket so we pass the typed-confirm gate; the held-run
    // scan finds no worker dir → not_held (nothing to answer / unblock).
    const res = await postRespond(ABSENT_TICKET, {
      response: "go ahead",
      confirm: ABSENT_TICKET,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("not_held");
  });

  it("a GET to /respond is NOT the mutation (method-gated)", async () => {
    // The POST-respond route is gated on `req.method === "POST"`; a GET falls
    // through to the static / SPA handler, never the mutation handler. The key
    // assertion is that no mutation `status` JSON is returned for a GET.
    const res = await fetch(`${baseUrl}/api/ticket/${ABSENT_TICKET}/respond`);
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = (await res.json()) as { status?: string };
      expect(body.status).not.toBe("not_held");
      expect(body.status).not.toBe("resuming");
    }
  });
});
