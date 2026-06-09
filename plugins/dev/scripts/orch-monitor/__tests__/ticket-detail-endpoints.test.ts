// CTL-889: integration tests for the cache-backed Linear detail / artifacts /
// search HTTP routes (P8/P9/P12) wired into the orch-monitor server. Seeds a
// REAL filter-state.db via the broker helpers (pointed at a temp path) so the
// routes exercise the actual SQLite read path — proving the data comes from the
// durable cache, never a live `linearis` call. Encodes the ticket's Gherkin
// scenarios end-to-end through the HTTP surface.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  upsertTicketDescriptor,
} from "../../broker/broker-state.mjs";
import type { TicketDetail } from "../lib/ticket-detail-reader.d.mts";
import type { TicketArtifacts } from "../lib/ticket-artifacts-reader.d.mts";
import type { TicketSearchResponse } from "../lib/ticket-search-reader.d.mts";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;
let dbPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "orch-monitor-ticket-detail-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  dbPath = join(tmpDir, "filter-state.db");

  // Seed the durable ticket_state cache (the broker's webhook write-through).
  // The handle is memoized at the module level, so seeding here and constructing
  // the server with the SAME filterStateDbPath share the one temp DB.
  closeBrokerStateDb();
  openBrokerStateDb(dbPath);
  upsertTicketDescriptor({
    ticket: "CTL-845",
    state: "Implement",
    priority: 2,
    assignee: "user-uuid-1",
    labels: ["monitor", "feature", "blocked"],
    relations: [{ type: "blocks", id: "CTL-901" }],
    uuid: "uuid-845",
  });
  // A sibling that BLOCKS CTL-845 → reverse blocked_by edge on CTL-845.
  upsertTicketDescriptor({
    ticket: "CTL-900",
    state: "Backlog",
    labels: ["rate-limit", "broker"],
    relations: [{ type: "blocks", id: "CTL-845" }],
    uuid: "uuid-900",
  });
  upsertTicketDescriptor({
    ticket: "CTL-901",
    state: "Done",
    labels: ["feature"],
    uuid: "uuid-901",
  });

  // NOTE: the artifacts route reads from the real repo thoughts tree (cwd). We
  // do not write into the repo here; the artifacts route's file-resolution logic
  // is covered by the lib-level ticket-artifacts-reader.test.ts with injected
  // fs. This integration test only asserts the route returns its envelope shape
  // (caveat + artifacts array). The DB-backed detail + search routes are the
  // focus here.

  server = createServer({
    port: 0,
    wtDir,
    catalystDir: tmpDir,
    filterStateDbPath: dbPath,
    startWatcher: false,
    // Disable every external fetcher so the server is hermetic.
    prStatusFetcher: null,
    linearFetcher: null,
    previewFetcher: null,
    commsReader: null,
    briefingProvider: null,
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/ticket-detail/:id (P8)", () => {
  it("returns labels, relations (forward + reverse), assignee, held — from the cache", async () => {
    const res = await fetch(`${baseUrl}/api/ticket-detail/CTL-845`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TicketDetail;
    expect(body.ticket).toBe("CTL-845");
    expect(body.linearState).toBe("Implement");
    expect(body.assignee).toBe("user-uuid-1");
    expect(body.labels).toEqual(["monitor", "feature", "blocked"]);
    expect(body.held).toBe("blocked");
    expect(body.relations.forward).toContainEqual({ type: "blocks", id: "CTL-901" });
    // Reverse edge: CTL-900 blocks CTL-845 → blocked_by on CTL-845.
    expect(body.relations.reverse).toContainEqual({
      type: "blocked_by",
      id: "CTL-900",
    });
    // honest nulls: no cached narrative, no held-since timestamp.
    expect(body.description).toBeNull();
    expect(body.heldSince).toBeNull();
    // provenance — the data is from filter-state.db, not a live Linear hit.
    expect(body.source).toBe("filter-state.db");
  });

  it("404s a ticket with no descriptor row", async () => {
    const res = await fetch(`${baseUrl}/api/ticket-detail/CTL-99999`);
    expect(res.status).toBe(404);
  });

  it("rejects a path-traversal id", async () => {
    const res = await fetch(`${baseUrl}/api/ticket-detail/..%2Fetc`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/search?q= (P12)", () => {
  it("fuzzy-matches the durable cache (no live Linear call)", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=rate-limit`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TicketSearchResponse;
    expect(body.results[0].ticket).toBe("CTL-900");
    expect(body.source).toBe("filter-state.db");
  });

  it("matches a ticket id fragment", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=845`);
    const body = (await res.json()) as TicketSearchResponse;
    expect(body.results.map((r) => r.ticket)).toContain("CTL-845");
  });

  it("returns an empty result set for an empty query (palette idle)", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TicketSearchResponse;
    expect(body.results).toEqual([]);
  });
});

describe("GET /api/ticket-artifacts/:id (P9)", () => {
  it("returns the eventual-consistency caveat and an artifacts array", async () => {
    const res = await fetch(`${baseUrl}/api/ticket-artifacts/CTL-845`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TicketArtifacts;
    expect(body.ticket).toBe("CTL-845");
    expect(Array.isArray(body.artifacts)).toBe(true);
    expect(body.crossNodeCaveat).toMatch(/thoughts-sync push/);
  });

  it("rejects a path-traversal id", async () => {
    const res = await fetch(`${baseUrl}/api/ticket-artifacts/..%2Fsecrets`);
    expect(res.status).toBe(400);
  });
});
