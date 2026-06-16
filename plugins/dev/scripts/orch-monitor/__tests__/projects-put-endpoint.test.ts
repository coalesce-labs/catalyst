// projects-put-endpoint.test.ts — CTL-1153 (M2): HTTP route-plumbing tests for
// PUT /api/projects/:key — the first config-mutation endpoint in orch-monitor.
// Validates server.ts wiring: method gate, JSON parse, validateProjectPatch, the
// PUT→GET round-trip, and byte-for-byte preservation of unrelated config sections.
// The pure mutation logic (upsertProject, validateProjectPatch) is covered by
// __tests__/config-writer.test.ts; these tests prove the route is mounted, matched,
// method-gated, guarded, and writes the correct fixture.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;
let fixtureCfg: string;

const FIXTURE_CONFIG = {
  catalyst: {
    projectKey: "test-workspace",
    linear: {
      teamKey: "CTL",
      stateMap: { inReview: "PR", done: "Done" },
    },
    orchestration: { dispatchMode: "phase-agent" },
    monitor: {
      github: { repoColors: { "coalesce-labs/catalyst": "green" } },
      linear: {
        teams: [
          { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
          { key: "ADV", vcsRepo: "coalesce-labs/adva" },
        ],
      },
    },
  },
};

async function put(key: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/projects/${key}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "projects-put-endpoint-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  // Write the fixture config the server will read and write
  const cfgDir = join(tmpDir, ".catalyst");
  mkdirSync(cfgDir, { recursive: true });
  fixtureCfg = join(cfgDir, "config.json");
  writeFileSync(fixtureCfg, JSON.stringify(FIXTURE_CONFIG, null, 2) + "\n");

  server = createServer({
    port: 0,
    wtDir,
    startWatcher: false,
    projectsConfigPath: fixtureCfg,
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("PUT /api/projects/:key — method gate", () => {
  it("returns 405 for DELETE", async () => {
    const res = await fetch(`${baseUrl}/api/projects/CTL`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("returns 405 for GET on the key path", async () => {
    // The bare /api/projects path is GET-only; the key sub-path allows only PUT
    const res = await fetch(`${baseUrl}/api/projects/CTL`);
    expect(res.status).toBe(405);
  });
});

describe("PUT /api/projects/:key — body validation", () => {
  it("returns 400 for a non-JSON body", async () => {
    const res = await put("CTL", "{ not json");
    expect(res.status).toBe(400);
  });

  it("returns 400 for a bad hue (magenta)", async () => {
    const res = await put("CTL", { color: "magenta" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown field (vcsRepo)", async () => {
    const res = await put("CTL", { vcsRepo: "owner/repo" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown stateMap key", async () => {
    const res = await put("CTL", { stateMap: { bogusKey: "X" } });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/projects/:key — unknown key", () => {
  it("returns 404 for a key not in teams[]", async () => {
    const res = await put("NOPE", { color: "green" });
    expect(res.status).toBe(404);
    // Fixture must be unchanged
    const after = JSON.parse(readFileSync(fixtureCfg, "utf8"));
    expect(after.catalyst.projects).toBeUndefined();
  });
});

describe("PUT /api/projects/:key — happy path", () => {
  it("returns 200 with project + projects on success", async () => {
    // Reset fixture
    writeFileSync(fixtureCfg, JSON.stringify(FIXTURE_CONFIG, null, 2) + "\n");

    const res = await put("ctl", { color: "green", name: "Catalyst Core" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: unknown; projects: unknown[] };
    expect(body.project).toBeTruthy();
    expect(Array.isArray(body.projects)).toBe(true);
  });

  it("writes the patch to the fixture config", async () => {
    // Reset fixture
    writeFileSync(fixtureCfg, JSON.stringify(FIXTURE_CONFIG, null, 2) + "\n");

    await put("CTL", { color: "blue", name: "Catalyst Core" });
    const written = JSON.parse(readFileSync(fixtureCfg, "utf8"));
    expect(written.catalyst.projects).toContainEqual(
      expect.objectContaining({ key: "CTL", vcsRepo: "coalesce-labs/catalyst", color: "blue", name: "Catalyst Core" }),
    );
  });

  it("preserves all unrelated config sections after a PUT", async () => {
    writeFileSync(fixtureCfg, JSON.stringify(FIXTURE_CONFIG, null, 2) + "\n");
    const before = JSON.parse(readFileSync(fixtureCfg, "utf8"));

    await put("CTL", { color: "teal" });
    const after = JSON.parse(readFileSync(fixtureCfg, "utf8"));
    expect(after.catalyst.orchestration).toEqual(before.catalyst.orchestration);
    expect(after.catalyst.linear.stateMap).toEqual(before.catalyst.linear.stateMap);
    expect(after.catalyst.monitor.linear.teams).toEqual(before.catalyst.monitor.linear.teams);
  });

  it("GET /api/projects reflects the PUT (round-trip via same injectable fixture)", async () => {
    writeFileSync(fixtureCfg, JSON.stringify(FIXTURE_CONFIG, null, 2) + "\n");

    await put("CTL", { color: "purple" });
    const roster = (await (await fetch(`${baseUrl}/api/projects`)).json()) as { projects: Array<{ key: string; defaultColor: string | null }> };
    const ctl = roster.projects.find((p) => p.key === "CTL");
    expect(ctl).toBeDefined();
    expect(ctl!.defaultColor).toBe("purple");
  });

  it("key is case-insensitive: 'ctl' resolves the CTL project", async () => {
    writeFileSync(fixtureCfg, JSON.stringify(FIXTURE_CONFIG, null, 2) + "\n");

    const res = await put("ctl", { color: "amber" });
    expect(res.status).toBe(200);
    const written = JSON.parse(readFileSync(fixtureCfg, "utf8"));
    expect(written.catalyst.projects[0].key).toBe("CTL");
    expect(written.catalyst.projects[0].color).toBe("amber");
  });

  // CTL-1208: phosphor glyph icon round-trip via HTTP
  it("PUT icon: 'phosphor:git-fork' → 200 and persists to config", async () => {
    writeFileSync(fixtureCfg, JSON.stringify(FIXTURE_CONFIG, null, 2) + "\n");
    const res = await put("CTL", { icon: "phosphor:git-fork" });
    expect(res.status).toBe(200);
    const written = JSON.parse(readFileSync(fixtureCfg, "utf8"));
    const ctl = written.catalyst.projects?.find((p: { key: string }) => p.key === "CTL");
    expect(ctl?.icon).toBe("phosphor:git-fork");
  });

  it("PUT icon: null clears the icon override", async () => {
    writeFileSync(fixtureCfg, JSON.stringify(FIXTURE_CONFIG, null, 2) + "\n");
    await put("CTL", { icon: "phosphor:rocket" });
    const res = await put("CTL", { icon: null });
    expect(res.status).toBe(200);
    const written = JSON.parse(readFileSync(fixtureCfg, "utf8"));
    const ctl = written.catalyst.projects?.find((p: { key: string }) => p.key === "CTL");
    expect(ctl?.icon).toBeUndefined();
  });
});
