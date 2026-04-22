import { describe, it, expect } from "bun:test";
import { getProvider, calculateCost } from "../lib/summarize/providers";
import type { AiFetcher } from "../lib/ai-briefing";

interface RequestRecord {
  url: string;
  body: string;
  headers: Record<string, string>;
}

interface FetcherCtx {
  fetcher: AiFetcher;
  getLastRequest(): RequestRecord | null;
}

function makeAnthropicFetcher(): FetcherCtx {
  let lastRequest: RequestRecord | null = null;
  const fetcher: AiFetcher = (url, init) => {
    lastRequest = {
      url,
      body: typeof init.body === "string" ? init.body : "",
      headers: init.headers,
    };
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            content: [{ type: "text", text: "Concise summary." }],
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
        ),
    });
  };
  return { fetcher, getLastRequest: () => lastRequest };
}

function makeChatCompletionsFetcher(): FetcherCtx {
  let lastRequest: RequestRecord | null = null;
  const fetcher: AiFetcher = (url, init) => {
    lastRequest = {
      url,
      body: typeof init.body === "string" ? init.body : "",
      headers: init.headers,
    };
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            choices: [{ message: { content: "Concise summary." } }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
            },
          }),
        ),
    });
  };
  return { fetcher, getLastRequest: () => lastRequest };
}

describe("calculateCost", () => {
  it("returns 0 for unknown model", () => {
    expect(calculateCost("unknown-model", 1000, 1000)).toBe(0);
  });

  it("calculates cost for known model", () => {
    // claude-sonnet-4-6: input $3/M, output $15/M. 1000 in + 1000 out → 0.003 + 0.015 = 0.018
    const cost = calculateCost("claude-sonnet-4-6", 1000, 1000);
    expect(cost).toBeCloseTo(0.018, 5);
  });
});

describe("anthropicProvider", () => {
  const provider = getProvider("anthropic");

  it("has name 'anthropic'", () => {
    expect(provider.name).toBe("anthropic");
  });

  it("POSTs to Anthropic URL with correct headers", async () => {
    const ctx = makeAnthropicFetcher();
    await provider.summarize({
      systemPrompt: "you are a bot",
      userPrompt: "summarize this",
      model: "claude-sonnet-4-6",
      apiKey: "sk-ant",
      fetcher: ctx.fetcher,
    });
    const last = ctx.getLastRequest();
    expect(last).not.toBeNull();
    expect(last!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(last!.headers["x-api-key"]).toBe("sk-ant");
    expect(last!.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("parses success response into summary + cost + tokens", async () => {
    const ctx = makeAnthropicFetcher();
    const result = await provider.summarize({
      systemPrompt: "sys",
      userPrompt: "user",
      model: "claude-sonnet-4-6",
      apiKey: "sk-ant",
      fetcher: ctx.fetcher,
    });
    expect(result.summary).toBe("Concise summary.");
    expect(result.tokens).toBe(150);
    expect(result.cost).toBeGreaterThan(0);
  });

  it("throws on non-ok response", async () => {
    const fetcher: AiFetcher = () =>
      Promise.resolve({
        ok: false,
        status: 429,
        text: () => Promise.resolve("rate limited"),
      });
    let caught: Error | null = null;
    try {
      await provider.summarize({
        systemPrompt: "sys",
        userPrompt: "user",
        model: "claude-sonnet-4-6",
        apiKey: "sk",
        fetcher,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/429/);
  });

  it("throws on non-JSON body", async () => {
    const fetcher: AiFetcher = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve("not json"),
      });
    let caught: Error | null = null;
    try {
      await provider.summarize({
        systemPrompt: "sys",
        userPrompt: "user",
        model: "claude-sonnet-4-6",
        apiKey: "sk",
        fetcher,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
  });
});

describe("openaiProvider", () => {
  const provider = getProvider("openai");

  it("has name 'openai'", () => {
    expect(provider.name).toBe("openai");
  });

  it("POSTs to OpenAI URL with Bearer auth", async () => {
    const ctx = makeChatCompletionsFetcher();
    await provider.summarize({
      systemPrompt: "sys",
      userPrompt: "user",
      model: "gpt-4o-mini",
      apiKey: "sk-oai",
      fetcher: ctx.fetcher,
    });
    const last = ctx.getLastRequest();
    expect(last).not.toBeNull();
    expect(last!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(last!.headers["Authorization"]).toBe("Bearer sk-oai");
  });

  it("parses success response", async () => {
    const ctx = makeChatCompletionsFetcher();
    const result = await provider.summarize({
      systemPrompt: "sys",
      userPrompt: "user",
      model: "gpt-4o-mini",
      apiKey: "sk",
      fetcher: ctx.fetcher,
    });
    expect(result.summary).toBe("Concise summary.");
    expect(result.tokens).toBe(150);
  });

  it("throws on non-ok response", async () => {
    const fetcher: AiFetcher = () =>
      Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve("boom"),
      });
    let caught: Error | null = null;
    try {
      await provider.summarize({
        systemPrompt: "sys",
        userPrompt: "user",
        model: "gpt-4o-mini",
        apiKey: "sk",
        fetcher,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/500/);
  });
});

describe("grokProvider", () => {
  const provider = getProvider("grok");

  it("has name 'grok'", () => {
    expect(provider.name).toBe("grok");
  });

  it("POSTs to xAI URL with Bearer auth", async () => {
    const ctx = makeChatCompletionsFetcher();
    await provider.summarize({
      systemPrompt: "sys",
      userPrompt: "user",
      model: "grok-2-latest",
      apiKey: "sk-xai",
      fetcher: ctx.fetcher,
    });
    const last = ctx.getLastRequest();
    expect(last).not.toBeNull();
    expect(last!.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(last!.headers["Authorization"]).toBe("Bearer sk-xai");
  });

  it("parses success response", async () => {
    const ctx = makeChatCompletionsFetcher();
    const result = await provider.summarize({
      systemPrompt: "sys",
      userPrompt: "user",
      model: "grok-2-latest",
      apiKey: "sk",
      fetcher: ctx.fetcher,
    });
    expect(result.summary).toBe("Concise summary.");
  });
});
