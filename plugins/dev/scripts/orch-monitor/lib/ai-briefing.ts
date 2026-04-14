import type { AiConfig } from "./ai-config";
import type { MonitorSnapshot, WorkerState } from "./state-reader";
import type { LinearTicket } from "./linear";

export interface BriefingResult {
  briefing: string;
  suggestedLabels: Record<string, string[]>;
  generatedAt: string;
}

export type AiFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface BriefingProvider {
  generate(
    snapshot: MonitorSnapshot,
    linearTickets: Record<string, LinearTicket>,
  ): Promise<BriefingResult | null>;
  stop(): void;
}

interface CacheEntry {
  result: BriefingResult;
  fetchedAt: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function statusSummary(w: WorkerState): string {
  let line = `${w.ticket}: status=${w.status}, phase=${w.phase}`;
  if (w.pr) line += `, PR=#${w.pr.number}`;
  if (w.cost?.costUSD) line += `, cost=$${w.cost.costUSD.toFixed(2)}`;
  if (w.timeSinceUpdate > 0) line += `, idle=${Math.round(w.timeSinceUpdate)}s`;
  if (!w.alive && w.pid) line += ` [process dead]`;
  return line;
}

export function buildPrompt(
  snapshot: MonitorSnapshot,
  linearTickets: Record<string, LinearTicket>,
): string {
  const sections: string[] = [];

  sections.push(
    "You are a concise status reporter for an AI-assisted development orchestration system.",
  );
  sections.push(
    "Produce a natural-language briefing (2-4 sentences) highlighting what needs attention and what is progressing fine.",
  );
  sections.push(
    'Also classify each ticket into categories: "bugfix", "feature", "refactor", "infrastructure", "docs".',
  );
  sections.push(
    "Respond with ONLY valid JSON in this exact format (no markdown, no explanation):",
  );
  sections.push(
    '{"briefing":"...","suggestedLabels":{"TICKET-1":["category1"],"TICKET-2":["category2"]}}',
  );

  sections.push("\n## Current State");
  sections.push(`Timestamp: ${snapshot.timestamp}`);
  sections.push(`Orchestrators: ${snapshot.orchestrators.length}`);

  for (const orch of snapshot.orchestrators) {
    sections.push(
      `\n### Orchestrator: ${orch.id} (wave ${orch.currentWave}/${orch.totalWaves})`,
    );

    const workers = Object.values(orch.workers);
    if (workers.length === 0) {
      sections.push("No workers.");
      continue;
    }

    sections.push("Workers:");
    for (const w of workers) {
      sections.push(`- ${statusSummary(w)}`);
    }

    if (orch.attention.length > 0) {
      sections.push("\nAttention items:");
      for (const item of orch.attention) {
        if (isRecord(item)) {
          const iType = typeof item.type === "string" ? item.type : "unknown";
          const iTicket = typeof item.ticket === "string" ? item.ticket : "";
          const iMsg = typeof item.message === "string" ? item.message : "";
          sections.push(`- [${iType}] ${iTicket} — ${iMsg}`);
        }
      }
    }
  }

  const ticketKeys = Object.keys(linearTickets);
  if (ticketKeys.length > 0) {
    sections.push("\n## Linear Ticket Context");
    for (const key of ticketKeys) {
      const t = linearTickets[key];
      if (!t) continue;
      let line = `- ${t.key}: "${t.title}" (state: ${t.state}`;
      if (t.project) line += `, project: ${t.project}`;
      if (t.labels.length > 0) line += `, labels: [${t.labels.join(", ")}]`;
      line += ")";
      sections.push(line);
    }
  }

  return sections.join("\n");
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

export function parseBriefingResponse(raw: string): BriefingResult | null {
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

  let briefingData: unknown;
  try {
    briefingData = JSON.parse(text) as unknown;
  } catch {
    return {
      briefing: text,
      suggestedLabels: {},
      generatedAt: new Date().toISOString(),
    };
  }

  if (!isRecord(briefingData)) return null;

  const briefing =
    typeof briefingData.briefing === "string" ? briefingData.briefing : "";
  if (!briefing) return null;

  const labels: Record<string, string[]> = {};
  if (isRecord(briefingData.suggestedLabels)) {
    for (const [k, v] of Object.entries(briefingData.suggestedLabels)) {
      if (Array.isArray(v)) {
        labels[k] = v.filter((x): x is string => typeof x === "string");
      }
    }
  }

  return {
    briefing,
    suggestedLabels: labels,
    generatedAt: new Date().toISOString(),
  };
}

function buildGatewayUrl(config: AiConfig): string {
  const base = (config.gateway ?? "").replace(/\/+$/, "");
  const provider = config.provider ?? "anthropic";

  if (provider === "openai") return `${base}/openai/v1/chat/completions`;
  return `${base}/anthropic/v1/messages`;
}

function buildRequestBody(config: AiConfig, prompt: string): string {
  const provider = config.provider ?? "anthropic";
  const model = config.model ?? "claude-haiku-4-5-20251001";

  if (provider === "openai") {
    return JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
    });
  }

  return JSON.stringify({
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
}

function buildHeaders(config: AiConfig): Record<string, string> {
  const provider = config.provider ?? "anthropic";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (provider === "openai") {
    headers["Authorization"] = `Bearer ${config.apiKey ?? ""}`;
  } else {
    headers["x-api-key"] = config.apiKey ?? "";
    headers["anthropic-version"] = "2023-06-01";
  }

  return headers;
}

const defaultFetcher: AiFetcher = async (url, init) => {
  const resp = await fetch(url, init);
  return {
    ok: resp.ok,
    status: resp.status,
    text: () => resp.text(),
  };
};

export function createBriefingProvider(
  config: AiConfig,
  opts: { fetcher?: AiFetcher; cacheTtlMs?: number } = {},
): BriefingProvider {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  let cache: CacheEntry | null = null;

  return {
    async generate(snapshot, linearTickets) {
      if (!config.enabled) return null;

      if (cache && Date.now() - cache.fetchedAt < cacheTtlMs) {
        return cache.result;
      }

      const prompt = buildPrompt(snapshot, linearTickets);
      const url = buildGatewayUrl(config);
      const headers = buildHeaders(config);
      const body = buildRequestBody(config, prompt);

      let raw: string;
      try {
        const resp = await fetcher(url, { method: "POST", headers, body });
        if (!resp.ok) {
          console.warn(
            `[ai-briefing] API returned ${String(resp.status)}`,
          );
          return null;
        }
        raw = await resp.text();
      } catch (err) {
        console.warn(
          `[ai-briefing] fetch failed:`,
          err instanceof Error ? err.message : "unknown error",
        );
        return null;
      }

      const result = parseBriefingResponse(raw);
      if (result) {
        cache = { result, fetchedAt: Date.now() };
      }
      return result;
    },

    stop() {
      cache = null;
    },
  };
}
