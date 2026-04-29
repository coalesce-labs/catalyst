import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;
let configPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "projects-api-test-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });

  // Point the server at a tmp config path via the env override the config
  // resolver honors.
  configPath = join(tmpDir, "projects.json");
  process.env.CATALYST_PROJECTS_CONFIG = configPath;

  const annotationsDbPath = join(tmpDir, "annotations.db");
  server = createServer({
    port: 0,
    wtDir,
    startWatcher: false,
    annotationsDbPath,
    dbPath: null,
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  delete process.env.CATALYST_PROJECTS_CONFIG;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/projects", () => {
  it("returns empty projects when config file is missing", async () => {
    // Ensure no file at the configured path.
    rmSync(configPath, { force: true });
    const res = await fetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { projects: Record<string, unknown> };
    expect(json.projects).toEqual({});
  });

  it("returns parsed entries when the config file exists", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        projects: {
          catalyst: { label: "Catalyst", color: "amber" },
          bravo: { label: "Bravo", color: "sky" },
        },
      }),
    );
    const res = await fetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      projects: Record<
        string,
        { label: string; color: string; iconPath?: string | null }
      >;
    };
    expect(json.projects.catalyst).toEqual({
      label: "Catalyst",
      color: "amber",
      iconPath: null,
    });
    expect(json.projects.bravo.color).toBe("sky");
  });

  it("quietly drops entries with unknown palette colors", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        projects: {
          ok: { label: "Ok", color: "rose" },
          bad: { label: "Bad", color: "chartreuse" },
        },
      }),
    );
    const res = await fetch(`${baseUrl}/api/projects`);
    const json = (await res.json()) as {
      projects: Record<string, unknown>;
    };
    expect(json.projects.ok).toBeDefined();
    expect(json.projects.bad).toBeUndefined();
  });
});
