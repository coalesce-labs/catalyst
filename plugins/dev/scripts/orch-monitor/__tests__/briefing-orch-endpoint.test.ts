import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer } from "../server";

type Server = ReturnType<typeof createServer>;
import type { SummarizeConfig } from "../lib/summarize/config";
import type { SummarizeProvider } from "../lib/summarize/providers";
import { createCache } from "../lib/summarize/cache";
import { createRateLimiter } from "../lib/summarize/rate-limit";
import { buildSummarizeSnapshot } from "../lib/summarize/snapshot";
import { createOrchBriefingHandler } from "../lib/briefing-orch";

interface ProviderStub {
  provider: SummarizeProvider;
  calls: { count: number; lastPrompt: string | null };
}

function stubProvider(summary = "- doing stuff\n- all good"): ProviderStub {
  const calls = { count: 0, lastPrompt: null as string | null };
  const provider: SummarizeProvider = {
    name: "anthropic",
    summarize: (args) => {
      calls.count += 1;
      calls.lastPrompt = args.userPrompt;
      return Promise.resolve({ summary, cost: 0.002, tokens: 400 });
    },
  };
  return { provider, calls };
}

function enabledConfig(): SummarizeConfig {
  return {
    enabled: true,
    defaultProvider: "anthropic",
    defaultModel: "claude-haiku-4-5-20251001",
    providers: {
      anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY", apiKey: "sk-ant-test" },
    },
  };
}

describe("GET /api/briefing/:orchId", () => {
  let tmp: string;
  let wtDir: string;
  let server: Server;
  let baseUrl: string;
  let annDbPath: string;
  let stub: ProviderStub;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "briefing-orch-"));
    wtDir = join(tmp, "wt");
    mkdirSync(join(wtDir, "orch-demo", "workers"), { recursive: true });
    writeFileSync(
      join(wtDir, "orch-demo", "state.json"),
      JSON.stringify({
        orchestrator: "orch-demo",
        startedAt: "2026-04-22T12:00:00Z",
        waves: [{ wave: 1, status: "in_progress", tickets: ["CTL-1"] }],
        currentWave: 1,
        totalWaves: 1,
      }),
    );
    writeFileSync(
      join(wtDir, "orch-demo", "workers", "CTL-1.json"),
      JSON.stringify({
        ticket: "CTL-1",
        orchestrator: "orch-demo",
        status: "researching",
        phase: 1,
        startedAt: "2026-04-22T12:01:00Z",
        updatedAt: "2026-04-22T12:01:00Z",
      }),
    );
    annDbPath = join(tmp, "ann.db");

    stub = stubProvider();

    const handler = createOrchBriefingHandler({
      config: enabledConfig(),
      buildSnapshot: (orchId) => buildSummarizeSnapshot(wtDir, orchId),
      providers: {
        anthropic: stub.provider,
        openai: stub.provider,
        grok: stub.provider,
      },
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
      orchBriefingHandler: handler,
    });
    baseUrl = `http://localhost:${String(server.port)}`;
  });

  afterAll(() => {
    void server.stop(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 400 when orchId contains unsafe characters", async () => {
    const res = await fetch(`${baseUrl}/api/briefing/invalid%20id`);
    expect(res.status).toBe(400);
  });

  it("handler directly rejects `..` orchId with 400 error", async () => {
    const handler = createOrchBriefingHandler({
      config: enabledConfig(),
      buildSnapshot: () => null,
      providers: {
        anthropic: stub.provider,
        openai: stub.provider,
        grok: stub.provider,
      },
      cache: createCache(60_000),
      rateLimiter: createRateLimiter({
        maxConcurrent: 10,
        minIntervalMs: 0,
      }),
    });
    const result = await handler.handle("..");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(400);
    }
  });

  it("returns 404 when the orchestrator does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/briefing/nope-does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("returns { summary, generatedAt } on success and includes orch context in prompt", async () => {
    stub.calls.count = 0;
    stub.calls.lastPrompt = null;
    const res = await fetch(`${baseUrl}/api/briefing/orch-demo`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      summary: string;
      generatedAt: string;
    };
    expect(data.summary).toContain("- ");
    expect(typeof data.generatedAt).toBe("string");
    expect(() => new Date(data.generatedAt).toISOString()).not.toThrow();
    expect(stub.calls.count).toBe(1);
    expect(stub.calls.lastPrompt).not.toBeNull();
    expect(stub.calls.lastPrompt ?? "").toContain("orch-demo");
    expect(stub.calls.lastPrompt ?? "").toContain("CTL-1");
  });

  it("reuses the cached briefing on repeated requests while the snapshot is unchanged", async () => {
    const res1 = await fetch(`${baseUrl}/api/briefing/orch-demo`);
    expect(res1.status).toBe(200);
    const data1 = (await res1.json()) as {
      summary: string;
      generatedAt: string;
    };
    const res2 = await fetch(`${baseUrl}/api/briefing/orch-demo`);
    expect(res2.status).toBe(200);
    const data2 = (await res2.json()) as {
      summary: string;
      generatedAt: string;
    };
    expect(data2.summary).toBe(data1.summary);
    expect(data2.generatedAt).toBe(data1.generatedAt);
  });
});

describe("GET /api/briefing/:orchId — disabled", () => {
  let tmp: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "briefing-orch-disabled-"));
    const wtDir = join(tmp, "wt");
    mkdirSync(join(wtDir, "orch-x"), { recursive: true });
    writeFileSync(
      join(wtDir, "orch-x", "state.json"),
      JSON.stringify({
        orchestrator: "orch-x",
        waves: [],
        currentWave: 0,
        totalWaves: 0,
      }),
    );
    server = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      prStatusFetcher: null,
      linearFetcher: null,
      annotationsDbPath: join(tmp, "ann.db"),
    });
    baseUrl = `http://localhost:${String(server.port)}`;
  });

  afterAll(() => {
    void server.stop(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns { enabled: false } when no handler is configured", async () => {
    const res = await fetch(`${baseUrl}/api/briefing/orch-x`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { enabled: boolean };
    expect(data.enabled).toBe(false);
  });
});
