// detail-deep-link-fallback.test.ts — CTL-942 + CTL-989 acceptance guards.
//
// CTL-989 unifies the two SPA bundles into ONE TanStack Router mounted from
// index.html. EVERY app route — the flat surface paths (/board, /workers,
// /queue, the OBSERVE surfaces, /settings) AND the detail/dep-graph deep links
// (/ticket/$id, /worker/$id, /dep-graph) — is now served by that single entry.
// A hard navigation / refresh / shared link to any of them must serve
// index.html (the router boots, reads the URL, lands on the right screen).
// These tests pin BOTH predicates (isDetailDeepLinkPath, the tight detail-only
// matcher kept for back-compat; isAppRoute, the full SPA-fallback matcher) and
// the served fallback (index.html for every app path; API/events/assets stay
// excluded).
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, isDetailDeepLinkPath, isAppRoute } from "../server";

// ── Pure predicate: isDetailDeepLinkPath (the tight detail-only matcher) ──────
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

  it("does not match the flat surface paths (those are isAppRoute's job)", () => {
    // isDetailDeepLinkPath stays the TIGHT detail-only matcher; the surface
    // paths are matched by isAppRoute, not this predicate.
    expect(isDetailDeepLinkPath("/")).toBe(false);
    expect(isDetailDeepLinkPath("/board")).toBe(false);
    expect(isDetailDeepLinkPath("/telemetry")).toBe(false);
    expect(isDetailDeepLinkPath("/api/ticket/CTL-845")).toBe(false);
    expect(isDetailDeepLinkPath("/events")).toBe(false);
    expect(isDetailDeepLinkPath("/tickets/CTL-845")).toBe(false);
  });

  // CTL-959: /dep-graph is a deep-linkable SPA route.
  it("matches /dep-graph for hard-nav SPA fallback (CTL-959)", () => {
    expect(isDetailDeepLinkPath("/dep-graph")).toBe(true);
  });

  it("does not match /dep-graph/ with trailing slash or sub-paths", () => {
    expect(isDetailDeepLinkPath("/dep-graph/")).toBe(false);
    expect(isDetailDeepLinkPath("/dep-graph/sub")).toBe(false);
  });
});

// ── Pure predicate: isAppRoute (the unified SPA-fallback matcher, CTL-989) ─────
describe("isAppRoute (CTL-989)", () => {
  it("matches the root + every flat surface path", () => {
    for (const p of [
      "/",
      "/index.html",
      "/board",
      "/workers",
      // CTL-1054: /dispatch is the canonical Dispatch route; /queue is a redirect alias.
      "/dispatch",
      "/queue",
      "/telemetry",
      "/utilization",
      "/finops",
      "/fleetops",
      "/devops",
      "/settings",
      "/process",
      "/rules",
    ]) {
      expect(isAppRoute(p)).toBe(true);
    }
  });

  it("matches the detail + dep-graph deep links", () => {
    expect(isAppRoute("/ticket/CTL-845")).toBe(true);
    expect(isAppRoute("/worker/CTL-845:2")).toBe(true);
    expect(isAppRoute("/dep-graph")).toBe(true);
  });

  it("never matches API, event, or asset paths", () => {
    for (const p of [
      "/api/board",
      "/api/ticket/CTL-845",
      "/events",
      "/public/favicon.svg",
      "/assets/main-abc.js",
      "/mockups/x.png",
      "/ticket/foo.js",
      "/board/sub",
      "/dep-graph/",
    ]) {
      expect(isAppRoute(p)).toBe(false);
    }
  });
});

// ── Served fallback (integration through createServer) ──────────────────────
let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

const INDEX_HTML = "<!doctype html><title>app entry</title>";
const HISTORY_HTML = "<!doctype html><title>history entry</title>";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "detail-deep-link-test-"));
  const wtDir = join(tmpDir, "wt");
  const publicDir = join(tmpDir, "public");
  mkdirSync(wtDir, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  // CTL-989: board.html is retired — the unified router lives in index.html, so
  // the SPA fallback serves index.html for every app route.
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

describe("GET app-route SPA fallback serves index.html (CTL-989)", () => {
  it("serves index.html for a ticket deep link", async () => {
    const res = await fetch(`${baseUrl}/ticket/CTL-845`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("serves index.html for a worker deep link (colon-bearing run id)", async () => {
    for (const path of ["/worker/CTL-845:2", "/worker/CTL-845%3A2"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe(INDEX_HTML);
    }
  });

  it("serves index.html for every flat surface path", async () => {
    for (const path of [
      "/board",
      "/workers",
      // CTL-1054: /dispatch is canonical; /queue is the redirect alias (both serve index.html).
      "/dispatch",
      "/queue",
      "/telemetry",
      "/utilization",
      "/finops",
      "/fleetops",
      "/devops",
      "/settings",
      "/process",
      "/rules",
    ]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe(INDEX_HTML);
    }
  });

  it("does NOT fall back for nested or asset-looking paths", async () => {
    for (const path of ["/ticket/CTL-845/extra", "/ticket/foo.js"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(404);
    }
  });

  it("only answers GET — a POST to an app path is not the SPA entry", async () => {
    const res = await fetch(`${baseUrl}/ticket/CTL-845`, { method: "POST" });
    expect(await res.text()).not.toBe(INDEX_HTML);
  });

  it("does not regress / and /legacy (index.html) or /history", async () => {
    const cases: Array<[string, string]> = [
      ["/", INDEX_HTML],
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

// CTL-959 + CTL-989: /dep-graph SPA fallback — hard navigation serves index.html
describe("GET /dep-graph SPA fallback (CTL-959 / CTL-989)", () => {
  it("serves index.html for a hard navigation to /dep-graph", async () => {
    const res = await fetch(`${baseUrl}/dep-graph`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("does not serve html for /dep-graph/ or /dep-graph/sub", async () => {
    const trailing = await fetch(`${baseUrl}/dep-graph/`);
    expect(trailing.status).toBe(404);
    const nested = await fetch(`${baseUrl}/dep-graph/sub`);
    expect(nested.status).toBe(404);
  });
});
