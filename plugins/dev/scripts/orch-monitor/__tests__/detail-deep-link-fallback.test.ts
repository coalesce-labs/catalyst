// detail-deep-link-fallback.test.ts — CTL-942 acceptance guards.
//
// The /ticket/$id + /worker/$id detail routes live in the TanStack router
// mounted by the BOARD entry (board.html → src/board/main.tsx → AppRouter);
// index.html's shell App mounts no router. Before CTL-942, server.ts served
// html ONLY at exactly "/", "/board", "/legacy" and "/history" — a hard
// navigation to /ticket/CTL-845 404'd, making the merged DETAIL1-7 pages
// unreachable. These tests pin the SPA fallback: deep-link GETs serve
// board.html (the entry that carries the router) and nothing else regresses.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, isDetailDeepLinkPath } from "../server";

// ── Pure predicate ───────────────────────────────────────────────────────────
describe("isDetailDeepLinkPath (CTL-942)", () => {
  it("matches exactly one non-empty segment under /ticket and /worker", () => {
    expect(isDetailDeepLinkPath("/ticket/CTL-845")).toBe(true);
    expect(isDetailDeepLinkPath("/worker/CTL-845:2")).toBe(true);
    // percent-encoded colon (what encodeURIComponent produces for run ids)
    expect(isDetailDeepLinkPath("/worker/CTL-845%3A2")).toBe(true);
  });

  it("rejects bare, nested, and trailing-slash forms", () => {
    expect(isDetailDeepLinkPath("/ticket")).toBe(false);
    expect(isDetailDeepLinkPath("/ticket/")).toBe(false);
    expect(isDetailDeepLinkPath("/ticket/CTL-845/")).toBe(false);
    expect(isDetailDeepLinkPath("/ticket/CTL-845/extra")).toBe(false);
    expect(isDetailDeepLinkPath("/worker")).toBe(false);
  });

  it("rejects asset-looking segments (extensions keep 404ing, never get html)", () => {
    expect(isDetailDeepLinkPath("/ticket/foo.js")).toBe(false);
    expect(isDetailDeepLinkPath("/worker/source.map")).toBe(false);
  });

  it("never matches API, event, or other html-entry paths", () => {
    expect(isDetailDeepLinkPath("/")).toBe(false);
    expect(isDetailDeepLinkPath("/board")).toBe(false);
    expect(isDetailDeepLinkPath("/legacy")).toBe(false);
    expect(isDetailDeepLinkPath("/history")).toBe(false);
    expect(isDetailDeepLinkPath("/api/ticket/CTL-845")).toBe(false);
    expect(isDetailDeepLinkPath("/events")).toBe(false);
    expect(isDetailDeepLinkPath("/tickets/CTL-845")).toBe(false);
  });
});

// ── Served fallback (integration through createServer) ──────────────────────
let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

const BOARD_HTML = "<!doctype html><title>board entry</title>";
const INDEX_HTML = "<!doctype html><title>shell entry</title>";
const HISTORY_HTML = "<!doctype html><title>history entry</title>";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "detail-deep-link-test-"));
  const wtDir = join(tmpDir, "wt");
  const publicDir = join(tmpDir, "public");
  mkdirSync(wtDir, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, "board.html"), BOARD_HTML);
  writeFileSync(join(publicDir, "index.html"), INDEX_HTML);
  writeFileSync(join(publicDir, "history.html"), HISTORY_HTML);

  server = createServer({
    port: 0,
    wtDir,
    publicDir,
    startWatcher: false,
    annotationsDbPath: join(tmpDir, "annotations.db"),
  });
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

describe("GET /ticket/$id and /worker/$id SPA fallback (CTL-942)", () => {
  it("serves board.html (the router-carrying entry) for a ticket deep link", async () => {
    const res = await fetch(`${baseUrl}/ticket/CTL-845`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(BOARD_HTML);
  });

  it("serves board.html for a worker deep link (colon-bearing run id)", async () => {
    for (const path of ["/worker/CTL-845:2", "/worker/CTL-845%3A2"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe(BOARD_HTML);
    }
  });

  it("does NOT fall back for nested or asset-looking paths", async () => {
    for (const path of ["/ticket/CTL-845/extra", "/ticket/foo.js"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(404);
    }
  });

  it("only answers GET — a POST to a deep-link path is not the SPA entry", async () => {
    const res = await fetch(`${baseUrl}/ticket/CTL-845`, { method: "POST" });
    expect(await res.text()).not.toBe(BOARD_HTML);
  });

  it("does not regress the existing html entries (/, /board, /legacy, /history)", async () => {
    const cases: Array<[string, string]> = [
      ["/", INDEX_HTML],
      ["/board", BOARD_HTML],
      ["/legacy", INDEX_HTML],
      ["/history", HISTORY_HTML],
    ];
    for (const [path, body] of cases) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe(body);
    }
  });
});
