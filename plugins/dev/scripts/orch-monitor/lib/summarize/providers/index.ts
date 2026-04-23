import type { AiFetcher } from "../../ai-briefing";
import type { ProviderName } from "../config";
import { anthropicProvider } from "./anthropic";
import { openaiProvider } from "./openai";
import { grokProvider } from "./grok";

export type { AiFetcher } from "../../ai-briefing";

export interface SummarizeArgs {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  apiKey: string;
  fetcher?: AiFetcher;
}

export interface SummarizeResult {
  summary: string;
  cost: number;
  tokens: number;
}

export interface SummarizeProvider {
  name: ProviderName;
  summarize(args: SummarizeArgs): Promise<SummarizeResult>;
}

export function getProvider(name: ProviderName): SummarizeProvider {
  switch (name) {
    case "anthropic":
      return anthropicProvider;
    case "openai":
      return openaiProvider;
    case "grok":
      return grokProvider;
  }
}

interface PricePair {
  input: number;
  output: number;
}

const COST_PER_MILLION_TOKENS: Record<string, PricePair> = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "grok-2-latest": { input: 2.0, output: 10.0 },
};

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = COST_PER_MILLION_TOKENS[model];
  if (!price) {
    console.info(`[summarize] unknown model for cost table: ${model}`);
    return 0;
  }
  return (
    (inputTokens * price.input + outputTokens * price.output) / 1_000_000
  );
}

const DEFAULT_FETCHER: AiFetcher = async (url, init) => {
  const resp = await fetch(url, init);
  return {
    ok: resp.ok,
    status: resp.status,
    text: () => resp.text(),
  };
};

export function defaultFetcher(): AiFetcher {
  return DEFAULT_FETCHER;
}
