// inbox-summary.ts — prompt + inference provider for the per-inbox-item AI
// summary (CTL-1042). Modeled on ai-briefing.ts: injectable AiFetcher, pure
// buildInboxSummaryPrompt / parseInboxSummaryResponse, a provider closure with
// a (ticket, phase, questionHash) cache. No network in tests.

import type { AiConfig } from "./ai-config";
import type { InboxItemState } from "./inbox-state";
import { computeQuestionHash } from "./inbox-state";

// ── public interfaces ─────────────────────────────────────────────────────────

export interface DecisionOption {
  label: string;
  tradeoffs?: string;
}

export interface InboxSummary {
  summary: string | null;
  ask: string | null;
  options: DecisionOption[] | null;
  blocker: string | null;
  generatedAt: string;
}

export type AiFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface InboxSummaryProvider {
  generate(ticket: string, phase?: string): Promise<InboxSummary | null>;
  stop(): void;
}

// ── internal helpers (mirrored from ai-briefing.ts) ──────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function buildGatewayUrl(config: AiConfig): string {
  const base = (config.gateway ?? "").replace(/\/+$/, "");
  const provider = config.provider ?? "anthropic";
  if (provider === "openai") return `${base}/openai/v1/chat/completions`;
  return `${base}/anthropic/v1/messages`;
}

function buildHeaders(config: AiConfig): Record<string, string> {
  const provider = config.provider ?? "anthropic";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider === "openai") {
    headers["Authorization"] = `Bearer ${config.apiKey ?? ""}`;
  } else {
    headers["x-api-key"] = config.apiKey ?? "";
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

function buildRequestBody(config: AiConfig, prompt: string): string {
  const provider = config.provider ?? "anthropic";
  const model = config.model ?? "claude-haiku-4-5-20251001";
  if (provider === "openai") {
    return JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 512 });
  }
  return JSON.stringify({ model, max_tokens: 512, messages: [{ role: "user", content: prompt }] });
}

function extractTextFromAnthropicResponse(parsed: unknown): string | null {
  if (!isRecord(parsed)) return null;
  const content = parsed.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first: unknown = content[0];
  if (!isRecord(first)) return null;
  return typeof first.text === "string" ? first.text : null;
}

function extractTextFromOpenAIResponse(parsed: unknown): string | null {
  if (!isRecord(parsed)) return null;
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (!isRecord(first)) return null;
  const message = first.message;
  if (!isRecord(message)) return null;
  return typeof message.content === "string" ? message.content : null;
}

const defaultFetcher: AiFetcher = async (url, init) => {
  const resp = await fetch(url, init);
  return { ok: resp.ok, status: resp.status, text: () => resp.text() };
};

// ── public prompt + parser ────────────────────────────────────────────────────

/** Build a compact one-shot prompt from a stuck worker's InboxItemState.
 *  Instructs the model to return ONLY JSON {summary, ask, options?, blocker?}. */
export function buildInboxSummaryPrompt(state: InboxItemState): string {
  const parts: string[] = [];
  parts.push(
    "You are a concise status reporter for an AI-assisted development system.",
  );
  parts.push(
    "A worker agent is stuck and waiting for a human decision. Produce 2-4 sentences that state:",
    "  1. What the agent was doing when it stopped.",
    "  2. Exactly why it is stuck.",
    "  3. What specific decision or answer is needed to continue.",
    "",
    "Respond with ONLY valid JSON (no markdown, no explanation) in this exact format:",
    '{"summary":"...","ask":"...","options":[{"label":"...","tradeoffs":"..."}],"blocker":null}',
    "options and blocker are optional — omit or null when not applicable.",
    "",
    "## Worker State",
  );
  parts.push(`Ticket: ${state.ticket}`);
  if (state.title) parts.push(`Title: ${state.title}`);
  parts.push(`Phase: ${state.phase}`);
  parts.push(`Status: ${state.status}`);
  if (state.parkedFrom) parts.push(`Parked from: ${state.parkedFrom}`);
  if (state.triageSummary) parts.push(`\nTicket summary: ${state.triageSummary}`);
  if (state.raisedQuestion) parts.push(`\nRaised question: ${state.raisedQuestion}`);
  if (state.transcriptTail) parts.push(`\nTranscript tail:\n${state.transcriptTail}`);
  if (state.failureReason) parts.push(`\nFailure reason: ${state.failureReason}`);
  if (state.stalledReason) parts.push(`\nStalled reason: ${state.stalledReason}`);
  return parts.join("\n");
}

/** Parse the model's raw API response body into an InboxSummary.
 *  Handles Anthropic + OpenAI response shapes. If the model text is not valid
 *  JSON, degrades to summary-only (the raw prose becomes the summary). */
export function parseInboxSummaryResponse(raw: string): InboxSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  const text =
    extractTextFromAnthropicResponse(parsed) ??
    extractTextFromOpenAIResponse(parsed);
  if (!text) return null;

  const generatedAt = new Date().toISOString();

  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    // Prose fallback — wrap the raw text as the summary.
    return { summary: text, ask: null, options: null, blocker: null, generatedAt };
  }

  if (!isRecord(data)) {
    return { summary: text, ask: null, options: null, blocker: null, generatedAt };
  }

  const summary = typeof data.summary === "string" ? data.summary : null;
  const ask = typeof data.ask === "string" ? data.ask : null;
  const blocker = typeof data.blocker === "string" ? data.blocker : null;

  let options: DecisionOption[] | null = null;
  if (Array.isArray(data.options) && data.options.length > 0) {
    options = (data.options as unknown[])
      .filter(isRecord)
      .filter((o) => typeof o.label === "string" && o.label !== "")
      .map((o) => ({
        label: o.label as string,
        ...(typeof o.tradeoffs === "string" ? { tradeoffs: o.tradeoffs } : {}),
      }));
    if (options.length === 0) options = null;
  }

  return { summary, ask, options, blocker, generatedAt };
}

// ── provider factory ──────────────────────────────────────────────────────────

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  result: InboxSummary;
  fetchedAt: number;
}

/** Create an InboxSummaryProvider: generates summaries via the Cloudflare AI
 *  Gateway, caches per `${ticket}:${phase}:${questionHash}`, degrades to null
 *  on any error (Scenario 3). The AiFetcher and collectState are injectable. */
export function createInboxSummaryProvider(
  config: AiConfig,
  opts: {
    fetcher?: AiFetcher;
    cacheTtlMs?: number;
    collectState: (ticket: string, phase?: string) => Promise<InboxItemState | null>;
  },
): InboxSummaryProvider {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  return {
    async generate(ticket, phase) {
      if (!config.enabled) return null;

      const state = await opts.collectState(ticket, phase);
      if (!state) return null;

      const questionHash = computeQuestionHash(state.phase, state.raisedQuestion);
      const cacheKey = `${ticket}:${state.phase}:${questionHash}`;

      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < cacheTtlMs) {
        return cached.result;
      }

      const prompt = buildInboxSummaryPrompt(state);
      const url = buildGatewayUrl(config);
      const headers = buildHeaders(config);
      const body = buildRequestBody(config, prompt);

      let raw: string;
      try {
        const resp = await fetcher(url, { method: "POST", headers, body });
        if (!resp.ok) {
          console.warn(`[inbox-summary] API returned ${String(resp.status)}`);
          return null;
        }
        raw = await resp.text();
      } catch (err) {
        console.warn(
          `[inbox-summary] fetch failed:`,
          err instanceof Error ? err.message : "unknown error",
        );
        return null;
      }

      const result = parseInboxSummaryResponse(raw);
      if (result) {
        cache.set(cacheKey, { result, fetchedAt: Date.now() });
      }
      return result;
    },

    stop() {
      cache.clear();
    },
  };
}
