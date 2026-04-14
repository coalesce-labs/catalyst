import { describe, it, expect, beforeEach } from "bun:test";
import {
  createBriefingProvider,
  buildPrompt,
  parseBriefingResponse,
  type AiFetcher,
} from "../lib/ai-briefing";
import type { AiConfig } from "../lib/ai-config";
import type { MonitorSnapshot } from "../lib/state-reader";
import type { LinearTicket } from "../lib/linear";

function makeConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    enabled: true,
    gateway: "https://gateway.ai.cloudflare.com/v1/acct/gw",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    apiKey: "sk-test",
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<MonitorSnapshot> = {},
): MonitorSnapshot {
  return {
    timestamp: "2026-04-14T12:00:00Z",
    sessions: [],
    sessionStoreAvailable: false,
    orchestrators: [
      {
        id: "orch-test",
        path: "/tmp/orch-test",
        startedAt: "2026-04-14T11:00:00Z",
        currentWave: 1,
        totalWaves: 2,
        waves: [
          { wave: 1, status: "in_progress", tickets: ["CTL-10", "CTL-11"] },
        ],
        workers: {
          "CTL-10": {
            ticket: "CTL-10",
            status: "pr-created",
            phase: 5,
            wave: 1,
            pid: 1234,
            alive: true,
            pr: { number: 42, url: "https://github.com/org/repo/pull/42" },
            startedAt: "2026-04-14T11:10:00Z",
            updatedAt: "2026-04-14T11:50:00Z",
            timeSinceUpdate: 600,
            lastHeartbeat: "2026-04-14T11:50:00Z",
            definitionOfDone: {},
            label: null,
          },
          "CTL-11": {
            ticket: "CTL-11",
            status: "failed",
            phase: 3,
            wave: 1,
            pid: 1235,
            alive: false,
            pr: null,
            startedAt: "2026-04-14T11:15:00Z",
            updatedAt: "2026-04-14T11:40:00Z",
            timeSinceUpdate: 1200,
            lastHeartbeat: "2026-04-14T11:35:00Z",
            definitionOfDone: {},
            label: null,
          },
        },
        dashboard: null,
        briefings: {},
        attention: [
          {
            type: "waiting-for-user",
            ticket: "CTL-11",
            message: "Worker failed: test failures",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function makeLinearTickets(): Record<string, LinearTicket> {
  return {
    "CTL-10": {
      key: "CTL-10",
      title: "Add OAuth2 support",
      url: "https://linear.app/issue/CTL-10",
      state: "In Review",
      project: "Auth",
      labels: ["feature"],
      fetchedAt: "2026-04-14T12:00:00Z",
    },
    "CTL-11": {
      key: "CTL-11",
      title: "Fix login redirect loop",
      url: "https://linear.app/issue/CTL-11",
      state: "In Progress",
      project: "Auth",
      labels: ["bug"],
      fetchedAt: "2026-04-14T12:00:00Z",
    },
  };
}

function makeSuccessResponse(): string {
  return JSON.stringify({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          briefing:
            "You have 1 orchestrator running with 2 workers. CTL-10 has a PR open waiting for CI. CTL-11 failed during implementation — needs attention.",
          suggestedLabels: {
            "CTL-10": ["feature", "auth"],
            "CTL-11": ["bugfix", "auth"],
          },
        }),
      },
    ],
  });
}

describe("buildPrompt", () => {
  it("includes worker status information", () => {
    const prompt = buildPrompt(makeSnapshot(), makeLinearTickets());
    expect(prompt).toContain("CTL-10");
    expect(prompt).toContain("CTL-11");
    expect(prompt).toContain("pr-created");
    expect(prompt).toContain("failed");
  });

  it("includes attention items", () => {
    const prompt = buildPrompt(makeSnapshot(), makeLinearTickets());
    expect(prompt).toContain("Worker failed: test failures");
  });

  it("includes Linear ticket context", () => {
    const prompt = buildPrompt(makeSnapshot(), makeLinearTickets());
    expect(prompt).toContain("Add OAuth2 support");
    expect(prompt).toContain("Fix login redirect loop");
  });

  it("handles empty snapshot gracefully", () => {
    const empty: MonitorSnapshot = {
      timestamp: "2026-04-14T12:00:00Z",
      orchestrators: [],
      sessions: [],
      sessionStoreAvailable: false,
    };
    const prompt = buildPrompt(empty, {});
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

describe("parseBriefingResponse", () => {
  it("extracts briefing and labels from valid Anthropic response", () => {
    const result = parseBriefingResponse(makeSuccessResponse());
    expect(result).not.toBeNull();
    expect(result!.briefing).toContain("CTL-10 has a PR open");
    expect(result!.suggestedLabels["CTL-10"]).toEqual(["feature", "auth"]);
    expect(result!.suggestedLabels["CTL-11"]).toEqual(["bugfix", "auth"]);
  });

  it("returns null for malformed JSON", () => {
    expect(parseBriefingResponse("not json")).toBeNull();
  });

  it("returns null for missing content array", () => {
    expect(parseBriefingResponse(JSON.stringify({}))).toBeNull();
  });

  it("returns null for empty content array", () => {
    expect(
      parseBriefingResponse(JSON.stringify({ content: [] })),
    ).toBeNull();
  });

  it("handles OpenAI-format response", () => {
    const openaiResp = JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              briefing: "All systems nominal.",
              suggestedLabels: {},
            }),
          },
        },
      ],
    });
    const result = parseBriefingResponse(openaiResp);
    expect(result).not.toBeNull();
    expect(result!.briefing).toBe("All systems nominal.");
  });
});

describe("createBriefingProvider", () => {
  let lastRequest: { url: string; body: string; headers: Record<string, string> } | null;
  let fetchResponse: string;
  let fetchShouldFail: boolean;

  function makeFetcher(): AiFetcher {
    return (url, init) => {
      if (fetchShouldFail) return Promise.reject(new Error("network failure"));
      lastRequest = {
        url,
        body: typeof init.body === "string" ? init.body : "",
        headers: init.headers,
      };
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(fetchResponse) });
    };
  }

  beforeEach(() => {
    lastRequest = null;
    fetchResponse = makeSuccessResponse();
    fetchShouldFail = false;
  });

  it("returns null when config is disabled", async () => {
    const provider = createBriefingProvider(
      { enabled: false },
      { fetcher: makeFetcher() },
    );
    const result = await provider.generate(makeSnapshot(), makeLinearTickets());
    expect(result).toBeNull();
    expect(lastRequest).toBeNull();
  });

  it("calls the correct Anthropic gateway URL", async () => {
    const config = makeConfig();
    const provider = createBriefingProvider(config, { fetcher: makeFetcher() });
    await provider.generate(makeSnapshot(), makeLinearTickets());
    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages",
    );
  });

  it("calls the correct OpenAI gateway URL", async () => {
    const config = makeConfig({ provider: "openai", model: "gpt-4o-mini" });
    const provider = createBriefingProvider(config, { fetcher: makeFetcher() });
    fetchResponse = JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              briefing: "All good.",
              suggestedLabels: {},
            }),
          },
        },
      ],
    });
    await provider.generate(makeSnapshot(), makeLinearTickets());
    expect(lastRequest).not.toBeNull();
    expect(lastRequest!.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/v1/chat/completions",
    );
  });

  it("sends correct headers for Anthropic", async () => {
    const provider = createBriefingProvider(makeConfig(), {
      fetcher: makeFetcher(),
    });
    await provider.generate(makeSnapshot(), makeLinearTickets());
    expect(lastRequest!.headers["x-api-key"]).toBe("sk-test");
    expect(lastRequest!.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("returns cached result within TTL", async () => {
    let callCount = 0;
    const countingFetcher: AiFetcher = (_url, _init) => {
      callCount++;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(fetchResponse) });
    };
    const provider = createBriefingProvider(makeConfig(), {
      fetcher: countingFetcher,
      cacheTtlMs: 60_000,
    });

    const r1 = await provider.generate(makeSnapshot(), makeLinearTickets());
    const r2 = await provider.generate(makeSnapshot(), makeLinearTickets());
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.briefing).toBe(r2!.briefing);
    expect(callCount).toBe(1);
  });

  it("returns null on fetch failure", async () => {
    fetchShouldFail = true;
    const provider = createBriefingProvider(makeConfig(), {
      fetcher: makeFetcher(),
    });
    const result = await provider.generate(makeSnapshot(), makeLinearTickets());
    expect(result).toBeNull();
  });

  it("returns null on non-ok response", async () => {
    const failFetcher: AiFetcher = () =>
      Promise.resolve({
        ok: false,
        status: 429,
        text: () => Promise.resolve("rate limited"),
      });
    const provider = createBriefingProvider(makeConfig(), {
      fetcher: failFetcher,
    });
    const result = await provider.generate(makeSnapshot(), makeLinearTickets());
    expect(result).toBeNull();
  });

  it("stop clears any pending operations", () => {
    const provider = createBriefingProvider(makeConfig(), {
      fetcher: makeFetcher(),
    });
    expect(() => provider.stop()).not.toThrow();
  });
});
