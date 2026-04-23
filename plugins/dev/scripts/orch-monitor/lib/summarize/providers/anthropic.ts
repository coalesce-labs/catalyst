import type {
  SummarizeArgs,
  SummarizeProvider,
  SummarizeResult,
} from "./index";
import { calculateCost, defaultFetcher } from "./index";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 1024;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function extractText(parsed: unknown): string | null {
  if (!isRecord(parsed)) return null;
  const content = parsed.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first: unknown = content[0];
  if (!isRecord(first)) return null;
  return typeof first.text === "string" ? first.text : null;
}

function extractTokens(parsed: unknown): { input: number; output: number } {
  if (!isRecord(parsed)) return { input: 0, output: 0 };
  const usage = isRecord(parsed.usage) ? parsed.usage : null;
  if (!usage) return { input: 0, output: 0 };
  const input =
    typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const output =
    typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  return { input, output };
}

export const anthropicProvider: SummarizeProvider = {
  name: "anthropic",
  async summarize(args: SummarizeArgs): Promise<SummarizeResult> {
    const fetcher = args.fetcher ?? defaultFetcher();
    const body = JSON.stringify({
      model: args.model,
      max_tokens: MAX_TOKENS,
      system: args.systemPrompt,
      messages: [{ role: "user", content: args.userPrompt }],
    });
    const resp = await fetcher(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": args.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
    });
    if (!resp.ok) {
      throw new Error(`anthropic provider returned ${String(resp.status)}`);
    }
    const raw = await resp.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("anthropic provider returned non-JSON body");
    }
    const summary = extractText(parsed);
    if (!summary) {
      throw new Error("anthropic provider returned no text content");
    }
    const tokens = extractTokens(parsed);
    return {
      summary,
      cost: calculateCost(args.model, tokens.input, tokens.output),
      tokens: tokens.input + tokens.output,
    };
  },
};
