// CTL-1100 Phase 5: GET /api/journey/:ticket — HTTP integration tests.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "journey-endpoint-test-"));
  const dbPath = join(tmpDir, "catalyst.db");
  server = createServer({ port: 0, startWatcher: false, dbPath, wtDir: tmpDir });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("GET /api/journey/:ticket", () => {
  it("well-formed ticket with no data → 200 empty-but-well-formed", async () => {
    const res = await fetch(`${baseUrl}/api/journey/CTL-0000`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ticket: string; hops: unknown[]; gates: { checklist: unknown[]; nextPhase: unknown };
      verifyVerdict: unknown; remediateCycles: number; unblockHints: unknown[]; hosts: unknown[];
    };
    expect(body.ticket).toBe("CTL-0000");
    expect(Array.isArray(body.hops)).toBe(true);
    expect(Array.isArray(body.gates.checklist)).toBe(true);
    expect(Array.isArray(body.unblockHints)).toBe(true);
    expect(Array.isArray(body.hosts)).toBe(true);
    expect("remediateCycles" in body).toBe(true);
  });

  it("not-a-ticket → 400", async () => {
    const res = await fetch(`${baseUrl}/api/journey/notaticket`);
    expect(res.status).toBe(400);
  });

  it("encoded traversal ..%2F.. → 400", async () => {
    const res = await fetch(`${baseUrl}/api/journey/..%2F..`);
    expect(res.status).toBe(400);
  });

  it("response has all expected top-level keys", async () => {
    const res = await fetch(`${baseUrl}/api/journey/CTL-0000`);
    const body = await res.json() as Record<string, unknown>;
    for (const key of ["ticket", "hops", "gates", "verifyVerdict", "remediateCycles", "unblockHints", "hosts"]) {
      expect(key in body).toBe(true);
    }
  });
});
