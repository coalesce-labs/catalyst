// CTL-886 (BFF4): HTTP route-plumbing tests for the run→worker identity
// endpoints. Validates the server.ts wiring — param validation (400), the JSON
// content type, the empty-history shape for a ticket with no worker dir, and the
// 404 for a phase with no signal. The assembly LOGIC itself (run-entity mapping,
// PR derivation, cost join, verbatim read) is covered exhaustively by the
// injectable unit tests in ticket-runs.test.ts; these tests prove the routes are
// mounted, matched, and guarded.
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

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ticket-runs-endpoints-"));
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

describe("GET /api/ticket-runs/:id (CTL-886)", () => {
  it("returns 200 + JSON with the empty-history shape for a ticket with no worker dir", async () => {
    const res = await fetch(`${baseUrl}/api/ticket-runs/${ABSENT_TICKET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { ticket: string; runs: unknown[] };
    expect(body.ticket).toBe(ABSENT_TICKET);
    expect(body.runs).toEqual([]);
  });

  it("rejects a malformed ticket id with 400 (no path traversal / arbitrary read)", async () => {
    expect((await fetch(`${baseUrl}/api/ticket-runs/not-a-ticket`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/ticket-runs/CTL`)).status).toBe(400);
    // an encoded traversal attempt never reaches the filesystem
    expect((await fetch(`${baseUrl}/api/ticket-runs/..%2F..%2Fetc`)).status).toBe(400);
  });
});

describe("GET /api/ec-worker/:ticket/:phase (CTL-886)", () => {
  it("returns 404 when the phase has no signal on disk for that ticket", async () => {
    const res = await fetch(`${baseUrl}/api/ec-worker/${ABSENT_TICKET}/implement`);
    expect(res.status).toBe(404);
  });

  it("rejects a malformed ticket id with 400", async () => {
    expect((await fetch(`${baseUrl}/api/ec-worker/nope/implement`)).status).toBe(400);
  });

  it("rejects a malformed phase name with 400 (no traversal via the phase segment)", async () => {
    // uppercase / digits / dots are not valid phase segments
    expect((await fetch(`${baseUrl}/api/ec-worker/${ABSENT_TICKET}/Implement`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/ec-worker/${ABSENT_TICKET}/..%2Ftriage`)).status).toBe(400);
  });
});
