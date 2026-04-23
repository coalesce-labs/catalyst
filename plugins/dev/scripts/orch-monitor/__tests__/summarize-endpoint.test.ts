import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer } from "../server";

type Server = ReturnType<typeof createServer>;
import type { SummarizeConfig, ProviderName } from "../lib/summarize/config";
import type { SummarizeProvider } from "../lib/summarize/providers";
import { createCache } from "../lib/summarize/cache";
import { createRateLimiter } from "../lib/summarize/rate-limit";
import { buildSummarizeSnapshot } from "../lib/summarize/snapshot";
import { createSummarizeHandler } from "../lib/summarize";

function enabledConfig(): SummarizeConfig {
  return {
    enabled: true,
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-6",
    providers: {
      anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY", apiKey: "sk-ant" },
    },
  };
}

function stubProvider(overrides?: {
  summary?: string;
  cost?: number;
  tokens?: number;
  throwOnce?: boolean;
  count?: { n: number };
}): SummarizeProvider {
  return {
    name: "anthropic",
    summarize: () => {
      if (overrides?.count) overrides.count.n += 1;
      if (overrides?.throwOnce) {
        overrides.throwOnce = false;
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve({
        summary: overrides?.summary ?? "stub summary",
        cost: overrides?.cost ?? 0.001,
        tokens: overrides?.tokens ?? 100,
      });
    },
  };
}

describe("POST /api/summarize", () => {
  let tmp: string;
  let wtDir: string;
  let server: Server;
  let baseUrl: string;
  let annDbPath: string;
  let callCount: { n: number };

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "summarize-endpoint-"));
    wtDir = join(tmp, "wt");
    mkdirSync(join(wtDir, "orch-test", "workers"), { recursive: true });
    writeFileSync(
      join(wtDir, "orch-test", "state.json"),
      JSON.stringify({
        orchestrator: "orch-test",
        startedAt: "2026-04-22T12:00:00Z",
        waves: [{ wave: 1, status: "in_progress", tickets: ["CTL-1"] }],
        currentWave: 1,
        totalWaves: 1,
      }),
    );
    writeFileSync(
      join(wtDir, "orch-test", "workers", "CTL-1.json"),
      JSON.stringify({
        ticket: "CTL-1",
        orchestrator: "orch-test",
        status: "researching",
        phase: 1,
        startedAt: "2026-04-22T12:01:00Z",
        updatedAt: "2026-04-22T12:01:00Z",
      }),
    );
    annDbPath = join(tmp, "ann.db");

    callCount = { n: 0 };
    const providers: Record<ProviderName, SummarizeProvider> = {
      anthropic: stubProvider({ count: callCount }),
      openai: stubProvider(),
      grok: stubProvider(),
    };

    const handler = createSummarizeHandler({
      config: enabledConfig(),
      buildSnapshot: (orchId) => buildSummarizeSnapshot(wtDir, orchId),
      providers,
      cache: createCache(60_000),
      rateLimiter: createRateLimiter({
        maxConcurrent: 10,
        minIntervalMs: 0,
      }),
    });

    server = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      prStatusFetcher: null,
      linearFetcher: null,
      annotationsDbPath: annDbPath,
      summarizeHandler: handler,
    });
    baseUrl = `http://localhost:${String(server.port)}`;
  });

  afterAll(() => {
    void server.stop(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    callCount.n = 0;
  });

  it("returns 400 on invalid JSON body", async () => {
    const res = await fetch(`${baseUrl}/api/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Invalid JSON");
  });

  it("returns 400 when orchId is missing", async () => {
    const res = await fetch(`${baseUrl}/api/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects path-traversal orchId with 400", async () => {
    const res = await fetch(`${baseUrl}/api/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orchId: "../../../etc" }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("unsafe");
  });

  it("returns 404 when orchestrator does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orchId: "nonexistent" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 on unknown template", async () => {
    const res = await fetch(`${baseUrl}/api/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orchId: "orch-test",
        template: "bogus-template",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on unknown provider", async () => {
    const res = await fetch(`${baseUrl}/api/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orchId: "orch-test",
        provider: "bogus",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 200 with summary body for valid request", async () => {
    const res = await fetch(`${baseUrl}/api/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orchId: "orch-test" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      summary: string;
      provider: string;
      model: string;
      cost: number;
      tokens: number;
      cached: boolean;
      generatedAt: string;
    };
    expect(data.summary).toBe("stub summary");
    expect(data.provider).toBe("anthropic");
    expect(data.model).toBe("claude-sonnet-4-6");
    expect(data.cost).toBe(0.001);
    expect(data.tokens).toBe(100);
    expect(data.cached).toBe(false);
    expect(data.generatedAt.length).toBeGreaterThan(0);
  });

  it("returns cached result on second identical request", async () => {
    // First call populates the cache
    await fetch(`${baseUrl}/api/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orchId: "orch-test" }),
    });
    const before = callCount.n;
    // Second call should hit cache
    const res = await fetch(`${baseUrl}/api/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orchId: "orch-test" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { cached: boolean };
    expect(data.cached).toBe(true);
    expect(callCount.n).toBe(before);
  });
});

describe("POST /api/summarize — disabled", () => {
  let tmp: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "summarize-disabled-"));
    mkdirSync(join(tmp, "wt"), { recursive: true });
    server = createServer({
      port: 0,
      wtDir: join(tmp, "wt"),
      startWatcher: false,
      prStatusFetcher: null,
      linearFetcher: null,
      annotationsDbPath: join(tmp, "ann.db"),
      summarizeHandler: null,
    });
    baseUrl = `http://localhost:${String(server.port)}`;
  });

  afterAll(() => {
    void server.stop(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 503 when summarize handler is not configured", async () => {
    const res = await fetch(`${baseUrl}/api/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orchId: "any" }),
    });
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("AI not configured");
  });
});

describe("POST /api/summarize — rate limited", () => {
  let tmp: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "summarize-ratelimit-"));
    const wtDir = join(tmp, "wt");
    mkdirSync(join(wtDir, "orch-test", "workers"), { recursive: true });
    writeFileSync(
      join(wtDir, "orch-test", "state.json"),
      JSON.stringify({
        orchestrator: "orch-test",
        startedAt: "2026-04-22T12:00:00Z",
        waves: [{ wave: 1, status: "in_progress", tickets: ["CTL-1"] }],
        currentWave: 1,
        totalWaves: 1,
      }),
    );
    writeFileSync(
      join(wtDir, "orch-test", "workers", "CTL-1.json"),
      JSON.stringify({
        ticket: "CTL-1",
        orchestrator: "orch-test",
        status: "researching",
        phase: 1,
        startedAt: "2026-04-22T12:01:00Z",
        updatedAt: "2026-04-22T12:01:00Z",
      }),
    );

    // Rate limiter with 0 slots always rejects
    const limiter = createRateLimiter({
      maxConcurrent: 0,
      minIntervalMs: 0,
    });

    const providers: Record<ProviderName, SummarizeProvider> = {
      anthropic: stubProvider(),
      openai: stubProvider(),
      grok: stubProvider(),
    };

    const handler = createSummarizeHandler({
      config: enabledConfig(),
      buildSnapshot: (orchId) => buildSummarizeSnapshot(wtDir, orchId),
      providers,
      cache: createCache(60_000),
      rateLimiter: limiter,
    });

    server = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      prStatusFetcher: null,
      linearFetcher: null,
      annotationsDbPath: join(tmp, "ann.db"),
      summarizeHandler: handler,
    });
    baseUrl = `http://localhost:${String(server.port)}`;
  });

  afterAll(() => {
    void server.stop(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 429 when rate-limited", async () => {
    const res = await fetch(`${baseUrl}/api/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orchId: "orch-test" }),
    });
    expect(res.status).toBe(429);
  });
});
