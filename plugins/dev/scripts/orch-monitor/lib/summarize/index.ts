import type { AiFetcher } from "../ai-briefing";
import {
  isKnownProvider,
  type ProviderName,
  type SummarizeConfig,
} from "./config";
import type { SummarizeSnapshot } from "./snapshot";
import type { SummarizeProvider } from "./providers";
import type { Cache } from "./cache";
import type { RateLimiter } from "./rate-limit";
import { TEMPLATE_NAMES, renderTemplate, type TemplateName } from "./templates";
import { isSafeOrchId } from "./snapshot";

export type { SummarizeConfig, ProviderName } from "./config";
export type { SummarizeSnapshot } from "./snapshot";

export interface SummarizeResponseBody {
  summary: string;
  provider: ProviderName;
  model: string;
  cost: number;
  tokens: number;
  cached: boolean;
  generatedAt: string;
}

interface CachedEntry {
  summary: string;
  cost: number;
  tokens: number;
  generatedAt: string;
}

export interface SummarizeHandlerDeps {
  config: SummarizeConfig;
  buildSnapshot: (orchId: string) => SummarizeSnapshot | null;
  providers: Record<ProviderName, SummarizeProvider>;
  cache: Cache<CachedEntry>;
  rateLimiter: RateLimiter;
  fetcher?: AiFetcher;
  systemPrompt?: string;
}

export interface SummarizeHandler {
  handle(req: Request): Promise<Response>;
}

interface RequestBody {
  orchId: string;
  template?: string;
  provider?: ProviderName;
  model?: string;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isKnownTemplate(name: string): name is TemplateName {
  return (TEMPLATE_NAMES as readonly string[]).includes(name);
}

function parseBody(raw: unknown): RequestBody | { error: string } {
  if (!isRecord(raw)) return { error: "Invalid JSON body" };
  if (typeof raw.orchId !== "string" || raw.orchId.length === 0) {
    return { error: "orchId is required" };
  }
  if (!isSafeOrchId(raw.orchId)) {
    return { error: "orchId contains unsafe characters" };
  }
  const body: RequestBody = { orchId: raw.orchId };
  if (raw.template !== undefined) {
    if (typeof raw.template !== "string") {
      return { error: "template must be a string" };
    }
    body.template = raw.template;
  }
  if (raw.provider !== undefined) {
    if (typeof raw.provider !== "string" || !isKnownProvider(raw.provider)) {
      return { error: "unknown provider" };
    }
    body.provider = raw.provider;
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string") {
      return { error: "model must be a string" };
    }
    body.model = raw.model;
  }
  return body;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a concise status reporter for an AI-assisted development orchestration system. Reply in plain prose.";

export function createSummarizeHandler(
  deps: SummarizeHandlerDeps,
): SummarizeHandler {
  const systemPrompt = deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  return {
    async handle(req: Request): Promise<Response> {
      if (!deps.config.enabled) {
        return Response.json(
          { error: "AI not configured" },
          { status: 503 },
        );
      }

      let rawBody: unknown;
      try {
        rawBody = (await req.json());
      } catch {
        return Response.json(
          { error: "Invalid JSON body" },
          { status: 400 },
        );
      }

      const parsed = parseBody(rawBody);
      if ("error" in parsed) {
        return Response.json({ error: parsed.error }, { status: 400 });
      }

      const template = parsed.template ?? "run-summary";
      if (!isKnownTemplate(template)) {
        return Response.json(
          { error: `unknown template: ${template}` },
          { status: 400 },
        );
      }

      const provider = parsed.provider ?? deps.config.defaultProvider;
      const model = parsed.model ?? deps.config.defaultModel;
      const providerCfg = deps.config.providers[provider];
      if (!providerCfg?.apiKey) {
        return Response.json(
          { error: `provider ${provider} is not configured` },
          { status: 503 },
        );
      }

      const snap = deps.buildSnapshot(parsed.orchId);
      if (!snap) {
        return Response.json(
          { error: `orchestrator not found: ${parsed.orchId}` },
          { status: 404 },
        );
      }

      const cacheKey = `${parsed.orchId}:${template}:${snap.snapshotHash}:${provider}:${model}`;
      const cached = deps.cache.get(cacheKey);
      if (cached) {
        const body: SummarizeResponseBody = {
          summary: cached.summary,
          provider,
          model,
          cost: cached.cost,
          tokens: cached.tokens,
          cached: true,
          generatedAt: cached.generatedAt,
        };
        return Response.json(body);
      }

      if (!deps.rateLimiter.tryAcquire(provider)) {
        return Response.json(
          { error: "Rate limited; try again shortly" },
          { status: 429 },
        );
      }

      try {
        const userPrompt = renderTemplate(template, snap);
        const providerImpl = deps.providers[provider];
        const result = await providerImpl.summarize({
          systemPrompt,
          userPrompt,
          model,
          apiKey: providerCfg.apiKey,
          fetcher: deps.fetcher,
        });
        const generatedAt = new Date().toISOString();
        deps.cache.set(cacheKey, {
          summary: result.summary,
          cost: result.cost,
          tokens: result.tokens,
          generatedAt,
        });
        const body: SummarizeResponseBody = {
          summary: result.summary,
          provider,
          model,
          cost: result.cost,
          tokens: result.tokens,
          cached: false,
          generatedAt,
        };
        return Response.json(body);
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        console.error("[summarize] provider error:", message);
        return Response.json(
          { error: `provider error: ${message}` },
          { status: 502 },
        );
      } finally {
        deps.rateLimiter.release(provider);
      }
    },
  };
}
