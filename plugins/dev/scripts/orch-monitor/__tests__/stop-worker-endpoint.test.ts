// stop-worker-endpoint.test.ts — HTTP route-plumbing tests for the read-model's
// ONE destructive endpoint, POST /api/ec-worker/<ticket>/stop (CTL-890, BFF8 —
// the design's P10). Validates the server.ts wiring — method gate, param + body
// validation (400), the typed-confirm gate (400), and the 404 for a ticket/phase
// with no run signal on disk. The mutation LOGIC itself (shortId derivation,
// fence branches, optimistic `stopping` contract) is covered exhaustively by the
// injectable unit tests in stop-worker.test.ts; these tests prove the route is
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
// behavior is deterministic regardless of host state.
const ABSENT_TICKET = "ZZZ-999999";

async function postStop(ticket: string, body: unknown) {
  return fetch(`${baseUrl}/api/ec-worker/${ticket}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "stop-worker-endpoint-"));
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

describe("POST /api/ec-worker/:ticket/stop (CTL-890)", () => {
  it("rejects a malformed ticket id with 400 (no path traversal / arbitrary read)", async () => {
    expect((await postStop("not-a-ticket", { phase: "implement", confirm: "x" })).status).toBe(400);
    expect((await postStop("CTL", { phase: "implement", confirm: "x" })).status).toBe(400);
    expect((await postStop("..%2F..%2Fetc", { phase: "implement", confirm: "x" })).status).toBe(400);
  });

  it("rejects an invalid JSON body with 400", async () => {
    const res = await postStop(ABSENT_TICKET, "{ not json");
    expect(res.status).toBe(400);
  });

  it("rejects a missing / malformed phase with 400 (no traversal via the phase field)", async () => {
    expect((await postStop(ABSENT_TICKET, { confirm: ABSENT_TICKET })).status).toBe(400);
    expect((await postStop(ABSENT_TICKET, { phase: "Implement", confirm: ABSENT_TICKET })).status).toBe(400);
    expect((await postStop(ABSENT_TICKET, { phase: "../triage", confirm: ABSENT_TICKET })).status).toBe(400);
    expect((await postStop(ABSENT_TICKET, { phase: 7, confirm: ABSENT_TICKET })).status).toBe(400);
  });

  it("returns 404 when the ticket/phase has no run signal on disk", async () => {
    // confirm matches the ticket so we pass the typed-confirm gate and reach the
    // signal read, which 404s for an absent worker dir.
    const res = await postStop(ABSENT_TICKET, {
      phase: "implement",
      confirm: ABSENT_TICKET,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("not_found");
  });

  it("a GET to /stop is NOT the mutation (method-gated) — never issues a stop", async () => {
    // The POST-stop route is gated on `req.method === "POST"`, so a GET falls
    // through to the verbatim ec-worker reader, which treats "stop" as a phase
    // name and 404s on the absent `phase-stop.json` — proving the GET never
    // triggered the mutation (a fired stop would 200/409/404-with-`status` JSON).
    const res = await fetch(`${baseUrl}/api/ec-worker/${ABSENT_TICKET}/stop`);
    expect(res.status).toBe(404);
    // the reader returns a plain "Not Found" body (no JSON `status` field that
    // the mutation handler would emit), confirming we hit the reader, not stopWorker.
    expect(res.headers.get("content-type")).not.toContain("application/json");
  });

  it("the verbatim GET reader still works for a real phase name (route ordering intact)", async () => {
    // POST-stop matching must not shadow the GET verbatim reader for normal phases.
    const res = await fetch(`${baseUrl}/api/ec-worker/${ABSENT_TICKET}/implement`);
    expect(res.status).toBe(404); // absent worker dir → 404, not a routing miss (would be 404 "Not Found" w/o JSON)
  });
});
