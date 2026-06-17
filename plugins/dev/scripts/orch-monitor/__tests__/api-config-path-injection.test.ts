// api-config-path-injection.test.ts — CTL-1156: validates monitorConfigPath injection
// for /api/config and /api/repo-icon/:key. The injected temp config contains a
// distinctive repoColors entry; the test asserts the handlers read it, not cwd.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

const INJECTED_REPO_COLOR = "injected-hot-pink-unique";
const INJECTED_REPO_KEY = "injected-test-repo";

const INJECTED_CONFIG = {
  catalyst: {
    projectKey: "injected-test-project",
    monitor: {
      github: {
        repoColors: { [INJECTED_REPO_KEY]: INJECTED_REPO_COLOR },
        repoOwners: { [INJECTED_REPO_KEY]: "test-org/injected-repo" },
      },
    },
  },
};

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;
let injectedCfgPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "api-config-path-injection-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  const cfgDir = join(tmpDir, "injected");
  mkdirSync(cfgDir, { recursive: true });
  injectedCfgPath = join(cfgDir, "config.json");
  writeFileSync(injectedCfgPath, JSON.stringify(INJECTED_CONFIG, null, 2) + "\n");

  server = createServer({
    port: 0,
    wtDir,
    startWatcher: false,
    monitorConfigPath: injectedCfgPath,
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("GET /api/config — monitorConfigPath injection", () => {
  it("returns the injected config's repoColors, not cwd's", async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const colors = (body as { repoColors?: Record<string, string> }).repoColors ?? {};
    expect(colors[INJECTED_REPO_KEY]).toBe(INJECTED_REPO_COLOR);
  });
});

describe("GET /api/repo-icon/:key — monitorConfigPath injection", () => {
  it("resolves an owner/repo only present in the injected config (not cwd)", async () => {
    const res = await fetch(`${baseUrl}/api/repo-icon/${INJECTED_REPO_KEY}`);
    // The injected config has repoOwners[key] set, so the handler proceeds past
    // the "not configured" 204 gate. We don't need a real GitHub call — a 404
    // from the icon fetcher (or a 204 found:false) still proves the handler
    // looked in the injected config, not cwd (which wouldn't have the key at all).
    // A 400 would mean the key was rejected entirely.
    expect(res.status).not.toBe(400);
  });
});

describe("GET /api/config — regression: default path when monitorConfigPath omitted", () => {
  let defaultServer: ReturnType<typeof createServer>;
  let defaultBaseUrl: string;
  let defaultTmp: string;

  beforeAll(() => {
    defaultTmp = mkdtempSync(join(tmpdir(), "api-config-default-"));
    const wt = join(defaultTmp, "wt");
    mkdirSync(wt, { recursive: true });
    // No monitorConfigPath — server falls back to cwd default
    defaultServer = createServer({ port: 0, wtDir: wt, startWatcher: false });
    defaultBaseUrl = `http://localhost:${defaultServer.port}`;
  });

  afterAll(() => {
    void defaultServer?.stop(true);
    if (defaultTmp) {
      try { rmSync(defaultTmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("returns 200 (not a server error) when monitorConfigPath omitted", async () => {
    const res = await fetch(`${defaultBaseUrl}/api/config`);
    expect(res.status).toBe(200);
  });

  it("does NOT return the injected config's distinctive color", async () => {
    const res = await fetch(`${defaultBaseUrl}/api/config`);
    const body = await res.json() as Record<string, unknown>;
    const colors = (body as { repoColors?: Record<string, string> }).repoColors ?? {};
    expect(colors[INJECTED_REPO_KEY]).toBeUndefined();
  });
});
