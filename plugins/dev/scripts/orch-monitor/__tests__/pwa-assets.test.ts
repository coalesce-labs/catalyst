// pwa-assets.test.ts — CTL-1133 PWA installability guards.
//
// Two layers: (1) the real committed artifacts (manifest.webmanifest +
// service-worker.js in ../public) are well-formed and carry the fields the
// install criteria need; (2) the server serves them from the ROOT with the
// right content types + the Service-Worker-Allowed header so the SW gets "/"
// scope and controls the whole app.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

const PUBLIC = join(import.meta.dir, "..", "public");

interface WebManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface WebManifest {
  name: string;
  short_name: string;
  display: string;
  start_url: string;
  scope: string;
  icons: WebManifestIcon[];
}

// ── The committed artifacts ───────────────────────────────────────────────────
describe("manifest.webmanifest (committed artifact)", () => {
  const manifest = JSON.parse(
    readFileSync(join(PUBLIC, "manifest.webmanifest"), "utf8"),
  ) as WebManifest;

  it("is installable: standalone display, root start_url + scope", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
  });

  it("declares the 192 and 512 PNG icons the install prompt requires", () => {
    const sizes = (manifest.icons ?? []).map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(icon.src.startsWith("/")).toBe(true);
    }
  });

  it("the referenced icon files exist in public/", () => {
    for (const icon of manifest.icons) {
      const rel = icon.src.replace(/^\/public\//, "").replace(/^\//, "");
      expect(() => readFileSync(join(PUBLIC, rel))).not.toThrow();
    }
  });
});

describe("service-worker.js (committed artifact)", () => {
  const sw = readFileSync(join(PUBLIC, "service-worker.js"), "utf8");

  it("registers the lifecycle + fetch handlers install criteria need", () => {
    expect(sw).toContain('addEventListener("install"');
    expect(sw).toContain('addEventListener("activate"');
    expect(sw).toContain('addEventListener("fetch"');
  });

  it("never caches live data (/api, /events, SSE bypass)", () => {
    expect(sw).toContain("/api/");
    expect(sw).toContain("/events");
    expect(sw).toContain("text/event-stream");
  });

  it("registers the push + notificationclick handlers (CTL-1167)", () => {
    expect(sw).toContain('addEventListener("push"');
    expect(sw).toContain('addEventListener("notificationclick"');
  });
});

// ── Served from the root (integration through createServer) ───────────────────
let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pwa-assets-test-"));
  const wtDir = join(tmpDir, "wt");
  const publicDir = join(tmpDir, "public");
  mkdirSync(wtDir, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>app</title>");
  // Real committed artifacts, so the route serves exactly what ships.
  writeFileSync(
    join(publicDir, "manifest.webmanifest"),
    readFileSync(join(PUBLIC, "manifest.webmanifest")),
  );
  writeFileSync(
    join(publicDir, "service-worker.js"),
    readFileSync(join(PUBLIC, "service-worker.js")),
  );
  writeFileSync(join(publicDir, "icon-192.png"), "\x89PNG\r\n\x1a\nfake");

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

describe("GET /manifest.webmanifest (CTL-1133)", () => {
  it("serves the manifest with the correct content type", async () => {
    const res = await fetch(`${baseUrl}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    const body = (await res.json()) as { start_url: string; display: string };
    expect(body.start_url).toBe("/");
    expect(body.display).toBe("standalone");
  });
});

describe("GET /service-worker.js (CTL-1133)", () => {
  it("serves from root with JS content type + root-scope header", async () => {
    const res = await fetch(`${baseUrl}/service-worker.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    // root scope so the SW controls the whole app, not just /public/
    expect(res.headers.get("service-worker-allowed")).toBe("/");
    // a stale SW must never pin an old shell
    expect(res.headers.get("cache-control")).toContain("no-cache");
  });
});

describe("PWA icons over the existing /public route (CTL-1133)", () => {
  it("serves icon-192.png as image/png", async () => {
    const res = await fetch(`${baseUrl}/public/icon-192.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
  });
});
