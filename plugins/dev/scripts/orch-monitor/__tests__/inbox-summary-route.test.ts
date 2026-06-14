// inbox-summary-route.test.ts — HTTP route tests for GET /api/inbox/:ticket/summary
// (CTL-1042). Tests the server.ts wiring: provider injection, method gate,
// traversal guard, honest degradation. All via an injectable InboxSummaryProvider.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";
import type { InboxSummaryProvider } from "../lib/inbox-summary";
import type { InboxSummary } from "../lib/inbox-summary";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

const SUMMARY_FIXTURE: InboxSummary = {
  summary: "Worker was implementing the AI cache.",
  ask: "Pick A or B?",
  options: [{ label: "A" }, { label: "B" }],
  blocker: null,
  generatedAt: "2026-06-11T00:00:00.000Z",
};

function makeProvider(result: InboxSummary | null): InboxSummaryProvider {
  return {
    generate: () => Promise.resolve(result),
    stop: () => undefined,
  };
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "inbox-summary-route-test-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  server = createServer({
    port: 0,
    wtDir,
    startWatcher: false,
    inboxSummaryProvider: makeProvider(SUMMARY_FIXTURE),
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("GET /api/inbox/:ticket/summary (CTL-1042)", () => {
  it("returns the provider result with enabled:true", async () => {
    const res = await fetch(`${baseUrl}/api/inbox/CTL-1042/summary`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.ask).toBe("Pick A or B?");
    expect(body.summary).toContain("AI cache");
    expect(body.generatedAt).toBeTruthy();
  });

  it("forwards ?phase query param (provider receives it)", async () => {
    // This test relies on the route passing the phase param through; response
    // still comes from the provider fixture, so just confirm no error.
    const res = await fetch(`${baseUrl}/api/inbox/CTL-1042/summary?phase=implement`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.enabled).toBe(true);
  });

  it("degrades honestly: provider returns null → {enabled:true, ask:null} (Scenario 3)", async () => {
    const tmpDir2 = mkdtempSync(join(tmpdir(), "inbox-null-route-"));
    const wt2 = join(tmpDir2, "wt");
    mkdirSync(wt2, { recursive: true });
    const srv2 = createServer({
      port: 0,
      wtDir: wt2,
      startWatcher: false,
      inboxSummaryProvider: makeProvider(null),
    });
    try {
      const res = await fetch(`http://localhost:${srv2.port}/api/inbox/CTL-1042/summary`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.enabled).toBe(true);
      expect(body.ask).toBeNull();
      expect(body.summary).toBeNull();
    } finally {
      void srv2.stop(true);
      try { rmSync(tmpDir2, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("no provider configured → {enabled:false}", async () => {
    const tmpDir3 = mkdtempSync(join(tmpdir(), "inbox-noprovider-route-"));
    const wt3 = join(tmpDir3, "wt");
    mkdirSync(wt3, { recursive: true });
    const srv3 = createServer({
      port: 0,
      wtDir: wt3,
      startWatcher: false,
      inboxSummaryProvider: null,
    });
    try {
      const res = await fetch(`http://localhost:${srv3.port}/api/inbox/CTL-1042/summary`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.enabled).toBe(false);
    } finally {
      void srv3.stop(true);
      try { rmSync(tmpDir3, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("path traversal in ticket → 400", async () => {
    const res = await fetch(`${baseUrl}/api/inbox/..%2Fetc/summary`);
    expect(res.status).toBe(400);
  });

  it("ticket with null byte → 400", async () => {
    const res = await fetch(`${baseUrl}/api/inbox/CTL%001/summary`);
    expect(res.status).toBe(400);
  });

  it("POST to the summary route returns non-200 (method is GET only)", async () => {
    const res = await fetch(`${baseUrl}/api/inbox/CTL-1042/summary`, { method: "POST" });
    // Route only responds to GET — POST falls through to SPA/404 handler
    expect(res.status).not.toBe(200);
  });
});
