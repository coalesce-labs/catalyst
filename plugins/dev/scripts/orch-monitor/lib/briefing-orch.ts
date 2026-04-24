import type { SummarizeConfig, ProviderName } from "./summarize/config";
import type { SummarizeProvider } from "./summarize/providers";
import type { SummarizeSnapshot } from "./summarize/snapshot";
import type { Cache } from "./summarize/cache";
import type { RateLimiter } from "./summarize/rate-limit";
import type { AiFetcher } from "./ai-briefing";
import { renderTemplate } from "./summarize/templates";
import { isSafeOrchId } from "./summarize/snapshot";

export interface OrchBriefingResponse {
  summary: string;
  generatedAt: string;
}

export interface OrchBriefingDisabled {
  enabled: false;
}

export interface OrchBriefingError {
  error: string;
  status: number;
}

export type OrchBriefingResult =
  | OrchBriefingResponse
  | OrchBriefingDisabled
  | OrchBriefingError;

export interface OrchBriefingDeps {
  config: SummarizeConfig;
  buildSnapshot: (orchId: string) => SummarizeSnapshot | null;
  providers: Record<ProviderName, SummarizeProvider>;
  cache: Cache<CachedEntry>;
  rateLimiter: RateLimiter;
  fetcher?: AiFetcher;
  systemPrompt?: string;
  model?: string;
  clock?: () => Date;
}

export interface OrchBriefingHandler {
  handle(orchId: string): Promise<OrchBriefingResult>;
}

interface CachedEntry {
  summary: string;
  generatedAt: string;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_SYSTEM_PROMPT =
  "You are a concise engineering briefing assistant. Given orchestration " +
  "state, produce 3-5 bullets in plain English covering: (1) what is " +
  "currently running and progressing normally, (2) what is blocked or " +
  "needs human action, (3) any PRs ready for review with their URLs, and " +
  "(4) any staging or preview URLs to check. Respond with ONLY a markdown " +
  "bullet list, max 300 tokens.";

export function createOrchBriefingHandler(
  deps: OrchBriefingDeps,
): OrchBriefingHandler {
  const systemPrompt = deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const model = deps.model ?? DEFAULT_MODEL;
  const clock = deps.clock ?? (() => new Date());

  return {
    async handle(orchId: string): Promise<OrchBriefingResult> {
      if (!isSafeOrchId(orchId)) {
        return { error: "Invalid orchId", status: 400 };
      }

      if (!deps.config.enabled) {
        return { enabled: false };
      }

      const provider: ProviderName = deps.config.defaultProvider;
      const providerCfg = deps.config.providers[provider];
      if (!providerCfg?.apiKey) {
        return { enabled: false };
      }

      const snap = deps.buildSnapshot(orchId);
      if (!snap) {
        return { error: "Orchestrator not found", status: 404 };
      }

      const cacheKey = `${orchId}:orch-briefing:${snap.snapshotHash}:${provider}:${model}`;
      const cached = deps.cache.get(cacheKey);
      if (cached) {
        return {
          summary: cached.summary,
          generatedAt: cached.generatedAt,
        };
      }

      if (!deps.rateLimiter.tryAcquire(provider)) {
        return { error: "Rate limited; try again shortly", status: 429 };
      }

      try {
        const userPrompt = renderTemplate("orch-briefing", snap);
        const providerImpl = deps.providers[provider];
        const result = await providerImpl.summarize({
          systemPrompt,
          userPrompt,
          model,
          apiKey: providerCfg.apiKey,
          fetcher: deps.fetcher,
        });
        const generatedAt = clock().toISOString();
        deps.cache.set(cacheKey, {
          summary: result.summary,
          generatedAt,
        });
        return { summary: result.summary, generatedAt };
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        console.error("[briefing-orch] provider error:", message);
        return {
          error: `provider error: ${message}`,
          status: 502,
        };
      } finally {
        deps.rateLimiter.release(provider);
      }
    },
  };
}
