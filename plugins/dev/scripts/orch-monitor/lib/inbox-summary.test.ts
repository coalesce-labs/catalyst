// inbox-summary.test.ts — Phase 2 TDD: prompt + inference provider for the
// per-inbox-item AI summary (CTL-1042). All network calls are injected via a
// mock AiFetcher so tests run with no network and no real model.

import { test, expect, describe, mock } from "bun:test";
import type { AiConfig } from "./ai-config";
import type { InboxItemState } from "./inbox-state";
import {
  buildInboxSummaryPrompt,
  parseInboxSummaryResponse,
  createInboxSummaryProvider,
} from "./inbox-summary";

// ── fixtures ──────────────────────────────────────────────────────────────────

const CONFIG: AiConfig = {
  enabled: true,
  gateway: "https://gateway.example.com",
  provider: "anthropic",
  model: "claude-haiku-4-5-20251001",
  apiKey: "test-key",
};

const STATE_FIXTURE: InboxItemState = {
  ticket: "CTL-1042",
  title: "Stuck workers should explain themselves",
  phase: "implement",
  status: "needs-input",
  failureReason: null,
  stalledReason: null,
  parkedFrom: "implement",
  handoffPath: null,
  triageSummary: "Add an AI summary to the inbox.",
  raisedQuestion: "Should the cache key include the model id?",
  transcriptTail: "Worker was implementing the cache. Should the cache key include the model id?",
  bgJobId: "testjob1",
  humanQuestion: null,
};

const ANTHROPIC_OK_RESPONSE = JSON.stringify({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        summary: "Worker was implementing the AI summary cache.",
        ask: "Should the cache key include the model id?",
        options: [
          { label: "Include model", tradeoffs: "safer, more cache misses" },
          { label: "Omit model", tradeoffs: "fewer cache misses, stale on model change" },
        ],
        blocker: null,
      }),
    },
  ],
});

const OPENAI_OK_RESPONSE = JSON.stringify({
  choices: [
    {
      message: {
        content: JSON.stringify({
          summary: "Worker paused on cache key design.",
          ask: "Pick A or B?",
          options: null,
          blocker: null,
        }),
      },
    },
  ],
});

function okFetcher(body: string) {
  return mock(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(body),
    }),
  );
}

// ── buildInboxSummaryPrompt ───────────────────────────────────────────────────

describe("buildInboxSummaryPrompt", () => {
  test("includes the raised question (Scenario 1 — real state)", () => {
    const p = buildInboxSummaryPrompt(STATE_FIXTURE);
    expect(p).toContain(STATE_FIXTURE.raisedQuestion!);
  });

  test("includes the phase", () => {
    const p = buildInboxSummaryPrompt(STATE_FIXTURE);
    expect(p).toContain(STATE_FIXTURE.phase);
  });

  test("includes the triage summary", () => {
    const p = buildInboxSummaryPrompt(STATE_FIXTURE);
    expect(p).toContain(STATE_FIXTURE.triageSummary!);
  });

  test("includes the ticket id", () => {
    const p = buildInboxSummaryPrompt(STATE_FIXTURE);
    expect(p).toContain(STATE_FIXTURE.ticket);
  });

  test("requests JSON output in the prompt", () => {
    const p = buildInboxSummaryPrompt(STATE_FIXTURE);
    expect(p.toLowerCase()).toMatch(/json/);
  });
});

// ── parseInboxSummaryResponse ─────────────────────────────────────────────────

describe("parseInboxSummaryResponse", () => {
  test("parses an Anthropic-shaped response into ask/summary/options", () => {
    const r = parseInboxSummaryResponse(ANTHROPIC_OK_RESPONSE);
    expect(r).not.toBeNull();
    expect(r!.ask).toContain("model id");
    expect(r!.summary).toContain("cache");
    expect(r!.options).toHaveLength(2);
    expect(r!.options![0].label).toBe("Include model");
    expect(r!.options![0].tradeoffs).toContain("safer");
  });

  test("parses an OpenAI-shaped response", () => {
    const r = parseInboxSummaryResponse(OPENAI_OK_RESPONSE);
    expect(r).not.toBeNull();
    expect(r!.ask).toContain("Pick A");
    expect(r!.summary).toContain("cache key");
  });

  test("malformed / non-JSON model text degrades to summary-only, never throws", () => {
    const raw = JSON.stringify({
      content: [{ type: "text", text: "The worker is stuck on a tricky question." }],
    });
    const r = parseInboxSummaryResponse(raw);
    expect(r).not.toBeNull();
    expect(r!.summary).toContain("tricky question");
    expect(r!.ask).toBeNull();
  });

  test("completely unparseable response returns null", () => {
    expect(parseInboxSummaryResponse("not json at all")).toBeNull();
  });

  test("empty content array returns null", () => {
    expect(parseInboxSummaryResponse(JSON.stringify({ content: [] }))).toBeNull();
  });

  test("generatedAt is always set", () => {
    const r = parseInboxSummaryResponse(ANTHROPIC_OK_RESPONSE);
    expect(r!.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── createInboxSummaryProvider ────────────────────────────────────────────────

describe("createInboxSummaryProvider", () => {
  test("caches per (ticket, phase, questionHash) — second call does not re-fetch (Scenario 2)", async () => {
    const fetcher = okFetcher(ANTHROPIC_OK_RESPONSE);
    const provider = createInboxSummaryProvider(CONFIG, {
      fetcher,
      collectState: () => Promise.resolve(STATE_FIXTURE),
    });
    await provider.generate("CTL-1042", "implement");
    await provider.generate("CTL-1042", "implement");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("re-fetches when the question changes (different questionHash)", async () => {
    let call = 0;
    const fetcher = mock(() => {
      call++;
      const body =
        call === 1 ? ANTHROPIC_OK_RESPONSE : ANTHROPIC_OK_RESPONSE;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
    });
    const states: InboxItemState[] = [
      { ...STATE_FIXTURE, raisedQuestion: "question A?" },
      { ...STATE_FIXTURE, raisedQuestion: "question B?" },
    ];
    let stateIdx = 0;
    const provider = createInboxSummaryProvider(CONFIG, {
      fetcher,
      collectState: () => Promise.resolve(states[stateIdx++] ?? null),
    });
    await provider.generate("CTL-1042", "implement");
    await provider.generate("CTL-1042", "implement");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("returns null when fetcher returns !ok (Scenario 3 — degrade)", async () => {
    const bad = mock(() => Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("") }));
    const provider = createInboxSummaryProvider(CONFIG, {
      fetcher: bad,
      collectState: () => Promise.resolve(STATE_FIXTURE),
    });
    expect(await provider.generate("CTL-1042", "implement")).toBeNull();
  });

  test("returns null when fetcher throws (Scenario 3 — degrade)", async () => {
    const throws = mock((): Promise<never> => Promise.reject(new Error("network error")));
    const provider = createInboxSummaryProvider(CONFIG, {
      fetcher: throws,
      collectState: () => Promise.resolve(STATE_FIXTURE),
    });
    expect(await provider.generate("CTL-1042", "implement")).toBeNull();
  });

  test("returns null when config.enabled is false", async () => {
    const fetcher = okFetcher(ANTHROPIC_OK_RESPONSE);
    const provider = createInboxSummaryProvider(
      { ...CONFIG, enabled: false },
      { fetcher, collectState: () => Promise.resolve(STATE_FIXTURE) },
    );
    expect(await provider.generate("CTL-1042", "implement")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("returns null when collectState yields null (no stuck phase)", async () => {
    const fetcher = okFetcher(ANTHROPIC_OK_RESPONSE);
    const provider = createInboxSummaryProvider(CONFIG, {
      fetcher,
      collectState: () => Promise.resolve(null),
    });
    expect(await provider.generate("CTL-1042", "implement")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("provider.stop() clears the cache so next call re-fetches", async () => {
    const fetcher = okFetcher(ANTHROPIC_OK_RESPONSE);
    const provider = createInboxSummaryProvider(CONFIG, {
      fetcher,
      collectState: () => Promise.resolve(STATE_FIXTURE),
    });
    await provider.generate("CTL-1042", "implement");
    provider.stop();
    await provider.generate("CTL-1042", "implement");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("returns a non-null result with all fields on success", async () => {
    const provider = createInboxSummaryProvider(CONFIG, {
      fetcher: okFetcher(ANTHROPIC_OK_RESPONSE),
      collectState: () => Promise.resolve(STATE_FIXTURE),
    });
    const r = await provider.generate("CTL-1042", "implement");
    expect(r).not.toBeNull();
    expect(r!.ask).not.toBeNull();
    expect(r!.summary).not.toBeNull();
    expect(r!.generatedAt).toBeTruthy();
  });

  describe("claude-cli (--bg subscription) path", () => {
    const CLI_CONFIG: AiConfig = {
      enabled: true,
      provider: "claude-cli",
      model: "claude-haiku-4-5-20251001",
    };

    const CLI_JSON_OUTPUT = JSON.stringify({
      summary: "S",
      ask: "A",
      options: null,
      blocker: null,
    });

    test("uses claude-cli path (never fetches) when provider is claude-cli", async () => {
      let fetched = false;
      const provider = createInboxSummaryProvider(CLI_CONFIG, {
        fetcher: () => { fetched = true; throw new Error("should not fetch"); },
        collectState: () => Promise.resolve(STATE_FIXTURE),
        runClaudeCli: () => Promise.resolve({ text: CLI_JSON_OUTPUT, tokens: 0 }),
      });
      const res = await provider.generate("CTL-1");
      expect(fetched).toBe(false);
      expect(res?.summary).toBe("S");
      expect(res?.ask).toBe("A");
    });

    test("degrades to null when claude-cli produces no output", async () => {
      const provider = createInboxSummaryProvider(CLI_CONFIG, {
        collectState: () => Promise.resolve(STATE_FIXTURE),
        runClaudeCli: () => Promise.resolve({ text: null, tokens: 0 }),
      });
      expect(await provider.generate("CTL-1")).toBeNull();
    });

    test("caches claude-cli result on second call", async () => {
      let callCount = 0;
      const provider = createInboxSummaryProvider(CLI_CONFIG, {
        collectState: () => Promise.resolve(STATE_FIXTURE),
        runClaudeCli: () => {
          callCount++;
          return Promise.resolve({ text: CLI_JSON_OUTPUT, tokens: 0 });
        },
      });
      await provider.generate("CTL-1");
      await provider.generate("CTL-1");
      expect(callCount).toBe(1);
    });
  });

  test("phase parameter is forwarded to collectState", async () => {
    let capturedPhase: string | undefined;
    const provider = createInboxSummaryProvider(CONFIG, {
      fetcher: okFetcher(ANTHROPIC_OK_RESPONSE),
      collectState: (_ticket, phase) => {
        capturedPhase = phase;
        return Promise.resolve(STATE_FIXTURE);
      },
    });
    await provider.generate("CTL-1042", "plan");
    expect(capturedPhase).toBe("plan");
  });
});
