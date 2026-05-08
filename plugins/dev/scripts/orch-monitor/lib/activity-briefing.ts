import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SummarizeConfig } from "./summarize/config";
import { getProvider, type SummarizeProvider } from "./summarize/providers";
import { createCache, type Cache } from "./summarize/cache";
import type { CanonicalEvent } from "./canonical-event";

export type ActivityWindow = "30m" | "1h" | "6h";

/**
 * Internal projection of a CanonicalEvent (CTL-300) onto the fields the
 * activity preprocessor cares about. We keep a flat shape with the canonical
 * event already extracted so downstream code doesn't have to re-quote
 * `attributes."event.name"` on every read.
 */
export interface RawEvent {
  ts: string;
  event: string;
  orchestrator: string | null;
  worker: string | null;
  detail: Record<string, unknown> | null;
}

export interface EventThread {
  orchestrator: string | null;
  worker: string | null;
  events: Array<{ ts: string; event: string; detail: Record<string, unknown> | null }>;
}

export interface AttentionItem {
  orchestrator: string | null;
  worker: string | null;
  ts: string;
  reason: string;
}

export interface PreprocessResult {
  threads: EventThread[];
  attentionItems: AttentionItem[];
  noMatchWakeCount: number;
  strippedCount: number;
  signalEvents: RawEvent[];
  windowLabel: string;
}

export interface ActivityBriefingResult {
  enabled: true;
  briefing: string;
  window: ActivityWindow;
  eventCount: number;
  strippedCount: number;
  generatedAt: string;
  cached: boolean;
}

export interface ActivityBriefingDisabled {
  enabled: false;
}

export const VALID_ACTIVITY_WINDOWS = new Set<ActivityWindow>(["30m", "1h", "6h"]);

const WINDOW_MS: Record<ActivityWindow, number> = {
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
};

export function parseWindowMs(w: ActivityWindow): number {
  return WINDOW_MS[w] ?? WINDOW_MS["30m"];
}

function monthlyPath(catalystDir: string, d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return join(catalystDir, "events", `${y}-${m}.jsonl`);
}

/**
 * Project a CanonicalEvent onto the flat RawEvent shape the activity
 * preprocessor consumes. Returns null if the line doesn't parse as a
 * canonical envelope (e.g. legacy or malformed lines).
 */
export function projectCanonical(line: string): RawEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const env = parsed as Partial<CanonicalEvent> & {
    attributes?: Record<string, unknown>;
    body?: { payload?: unknown };
  };
  const attrs: Record<string, unknown> = env.attributes ?? {};
  const rawName = attrs["event.name"];
  const eventName = typeof rawName === "string" ? rawName : "";
  const ts = typeof env.ts === "string" ? env.ts : "";
  if (eventName === "" || ts === "") return null;
  const rawOrch = attrs["catalyst.orchestrator.id"];
  const orch = typeof rawOrch === "string" ? rawOrch : null;
  const rawWorker = attrs["catalyst.worker.ticket"];
  const worker = typeof rawWorker === "string" ? rawWorker : null;
  const payload = env.body?.payload;
  const detail =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  return { ts, event: eventName, orchestrator: orch, worker, detail };
}

export function readActivityEvents(
  catalystDir: string,
  windowMs: number,
  now: Date = new Date(),
): RawEvent[] {
  const cutoff = new Date(now.getTime() - windowMs);
  const cutoffIso = cutoff.toISOString();

  const currentPath = monthlyPath(catalystDir, now);
  const prevPath = monthlyPath(catalystDir, cutoff);
  const paths = currentPath === prevPath ? [currentPath] : [prevPath, currentPath];

  const events: RawEvent[] = [];
  for (const filePath of paths) {
    if (!existsSync(filePath)) continue;
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const evt = projectCanonical(line);
      if (evt === null) continue;
      if (evt.ts >= cutoffIso) {
        events.push(evt);
      }
    }
  }
  return events;
}

// CTL-300: legacy event names rewritten to canonical
//   heartbeat → session.heartbeat
const STRIP_EVENTS = new Set([
  "session.heartbeat",
  "filter.register",
  "filter.deregister",
]);

const SIGNAL_PRIORITY: Record<string, number> = {
  "orchestrator.attention.raised": 1,
  "orchestrator.worker.status_terminal": 2,
  "github.check_suite.completed": 3,
  "github.workflow_run.completed": 3,
  "github.pr.merged": 4,
  "linear.issue.state_changed": 5,
  "linear.issue.created": 5,
  "comms.message.posted": 6,
  "orchestrator.worker.phase_advanced": 7,
};

export function preprocessEvents(events: RawEvent[]): PreprocessResult {
  const threads = new Map<string, EventThread>();
  const attentionItems: AttentionItem[] = [];
  const signalEvents: RawEvent[] = [];
  let strippedCount = 0;
  let noMatchWakeCount = 0;

  for (const evt of events) {
    if (STRIP_EVENTS.has(evt.event)) {
      strippedCount++;
      continue;
    }

    if (evt.event.startsWith("filter.wake")) {
      const ids = (evt.detail as { source_event_ids?: unknown[] } | null)?.source_event_ids;
      if (!Array.isArray(ids) || ids.length === 0) {
        noMatchWakeCount++;
        continue;
      }
    }

    if (evt.event === "orchestrator.attention.raised") {
      const rawReason = (evt.detail as { reason?: unknown } | null)?.reason;
      attentionItems.push({
        orchestrator: evt.orchestrator,
        worker: evt.worker,
        ts: evt.ts,
        reason: typeof rawReason === "string" ? rawReason : "",
      });
    }

    const orchKey = evt.orchestrator ?? "_global";
    const workerKey = evt.worker ?? "_orch";
    const threadKey = `${orchKey}::${workerKey}`;

    let thread = threads.get(threadKey);
    if (!thread) {
      thread = { orchestrator: evt.orchestrator, worker: evt.worker, events: [] };
      threads.set(threadKey, thread);
    }
    thread.events.push({ ts: evt.ts, event: evt.event, detail: evt.detail });
    signalEvents.push(evt);
  }

  const sortedThreads = [...threads.values()].sort((a, b) => {
    const aHasAttention = a.events.some(
      (e) => e.event === "orchestrator.attention.raised",
    );
    const bHasAttention = b.events.some(
      (e) => e.event === "orchestrator.attention.raised",
    );
    if (aHasAttention && !bHasAttention) return -1;
    if (!aHasAttention && bHasAttention) return 1;
    return (b.events[0]?.ts ?? "").localeCompare(a.events[0]?.ts ?? "");
  });

  return {
    threads: sortedThreads,
    attentionItems,
    noMatchWakeCount,
    strippedCount,
    signalEvents,
    windowLabel: "",
  };
}

export function buildActivityPrompt(result: PreprocessResult): string {
  const lines: string[] = [];

  lines.push(
    `You are a concise status reporter for an AI-assisted development system.`,
    `Summarize the last ${result.windowLabel || "30m"} of activity in 3-6 paragraphs of plain markdown.`,
    `Focus on: what needs attention, what shipped, what's in progress. Omit routine phase transitions unless they're the only signal.`,
    `Format: start with a one-sentence "TL;DR", then grouped paragraphs by orchestrator/worker.`,
    `Use **bold** for ticket IDs and important states. Use bullet lists for multiple items.`,
    ``,
    `=== ACTIVITY WINDOW: ${result.windowLabel || "30m"} ===`,
    `Total signal events: ${result.signalEvents.length}`,
    `Stripped (heartbeats/noise): ${result.strippedCount}`,
    `Filter wakes with no match (collapsed): ${result.noMatchWakeCount}`,
    ``,
  );

  if (result.attentionItems.length > 0) {
    lines.push(`=== ATTENTION REQUIRED (${result.attentionItems.length}) ===`);
    for (const item of result.attentionItems) {
      const who = item.worker ?? item.orchestrator ?? "unknown";
      lines.push(`ATTENTION [${who}] @ ${item.ts.slice(0, 19)}Z: ${item.reason}`);
    }
    lines.push(``);
  }

  if (result.threads.length === 0) {
    lines.push(`No activity in this window.`);
  } else {
    lines.push(`=== THREADS (${result.threads.length}) ===`);
    for (const thread of result.threads.slice(0, 20)) {
      const label = thread.worker
        ? `[${thread.orchestrator ?? "global"}/${thread.worker}]`
        : `[${thread.orchestrator ?? "global"}]`;
      lines.push(``, `Thread ${label} (${thread.events.length} events):`);

      const sorted = [...thread.events].sort((a, b) => {
        const pa = SIGNAL_PRIORITY[a.event] ?? 10;
        const pb = SIGNAL_PRIORITY[b.event] ?? 10;
        return pa - pb;
      });

      for (const evt of sorted.slice(0, 8)) {
        const detail = evt.detail
          ? ` — ${JSON.stringify(evt.detail).slice(0, 120)}`
          : "";
        lines.push(`  ${evt.ts.slice(11, 19)}Z ${evt.event}${detail}`);
      }
      if (thread.events.length > 8) {
        lines.push(`  ... and ${thread.events.length - 8} more events`);
      }
    }
    if (result.threads.length > 20) {
      lines.push(``, `... and ${result.threads.length - 20} more threads`);
    }
  }

  return lines.join("\n");
}

// Per-window cache with 2-minute TTL (shorter than session briefing since it's time-windowed)
const caches = new Map<ActivityWindow, Cache<ActivityBriefingResult>>();

function getWindowCache(w: ActivityWindow): Cache<ActivityBriefingResult> {
  let cache = caches.get(w);
  if (!cache) {
    cache = createCache<ActivityBriefingResult>(2 * 60 * 1000);
    caches.set(w, cache);
  }
  return cache;
}

const CACHE_KEY = "activity-brief";

// In-flight deduplication: concurrent cache-miss requests for the same window coalesce
const inflightCalls = new Map<ActivityWindow, Promise<ActivityBriefingResult>>();

export async function generateActivityBriefing(
  catalystDir: string,
  config: SummarizeConfig,
  window: ActivityWindow = "30m",
  overrideProvider?: SummarizeProvider,
): Promise<ActivityBriefingResult | ActivityBriefingDisabled> {
  if (!config.enabled) return { enabled: false };

  const providerName = config.defaultProvider;
  const providerConfig = config.providers[providerName];
  if (!providerConfig?.apiKey) return { enabled: false };
  const apiKey = providerConfig.apiKey;

  const cache = getWindowCache(window);
  const cached = cache.get(CACHE_KEY);
  if (cached) return { ...cached, cached: true };

  const existing = inflightCalls.get(window);
  if (existing) return existing;

  const promise = (async (): Promise<ActivityBriefingResult> => {
    try {
      const windowMs = parseWindowMs(window);
      const events = readActivityEvents(catalystDir, windowMs);
      const preprocessed = preprocessEvents(events);
      preprocessed.windowLabel = window;

      const userPrompt = buildActivityPrompt(preprocessed);
      const provider = overrideProvider ?? getProvider(providerName);

      const { summary } = await provider.summarize({
        systemPrompt:
          "You are a concise status reporter for an AI-assisted development system. Reply in markdown.",
        userPrompt,
        model: config.defaultModel,
        apiKey,
      });

      const result: ActivityBriefingResult = {
        enabled: true,
        briefing: summary,
        window,
        eventCount: preprocessed.signalEvents.length,
        strippedCount: preprocessed.strippedCount,
        generatedAt: new Date().toISOString(),
        cached: false,
      };

      cache.set(CACHE_KEY, result);
      return result;
    } finally {
      inflightCalls.delete(window);
    }
  })();

  inflightCalls.set(window, promise);
  return promise;
}
