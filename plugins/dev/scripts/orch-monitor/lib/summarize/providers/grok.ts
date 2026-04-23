import type {
  SummarizeArgs,
  SummarizeProvider,
  SummarizeResult,
} from "./index";
import { calculateCost, defaultFetcher } from "./index";

const GROK_URL = "https://api.x.ai/v1/chat/completions";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function extractText(parsed: unknown): string | null {
  if (!isRecord(parsed)) return null;
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (!isRecord(first)) return null;
  const message = isRecord(first.message) ? first.message : null;
  if (!message) return null;
  return typeof message.content === "string" ? message.content : null;
}

function extractTokens(parsed: unknown): { input: number; output: number } {
  if (!isRecord(parsed)) return { input: 0, output: 0 };
  const usage = isRecord(parsed.usage) ? parsed.usage : null;
  if (!usage) return { input: 0, output: 0 };
  const input =
    typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const output =
    typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : 0;
  return { input, output };
}

export const grokProvider: SummarizeProvider = {
  name: "grok",
  async summarize(args: SummarizeArgs): Promise<SummarizeResult> {
    const fetcher = args.fetcher ?? defaultFetcher();
    const body = JSON.stringify({
      model: args.model,
      messages: [
        { role: "system", content: args.systemPrompt },
        { role: "user", content: args.userPrompt },
      ],
    });
    const resp = await fetcher(GROK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.apiKey}`,
      },
      body,
    });
    if (!resp.ok) {
      throw new Error(`grok provider returned ${String(resp.status)}`);
    }
    const raw = await resp.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("grok provider returned non-JSON body");
    }
    const summary = extractText(parsed);
    if (!summary) {
      throw new Error("grok provider returned no text content");
    }
    const tokens = extractTokens(parsed);
    return {
      summary,
      cost: calculateCost(args.model, tokens.input, tokens.output),
      tokens: tokens.input + tokens.output,
    };
  },
};
