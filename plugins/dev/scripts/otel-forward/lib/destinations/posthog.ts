import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";
import { withRetry, DEFAULT_RETRY_DELAYS_MS } from "../retry.ts";
import { appendToDlq, drainDlq } from "../dlq.ts";

export function buildPosthogBatch(events: CanonicalEvent[], apiKey: string): unknown {
  return {
    api_key: apiKey,
    batch: events.map((ev) => ({
      event: ev.attributes?.["event.name"] ?? "unknown",
      distinct_id: ev.resource?.["service.name"] ?? "catalyst",
      timestamp: ev.ts,
      properties: { ...(ev.attributes as unknown as Record<string, unknown>), $lib: "catalyst-otel-forward" },
    })),
  };
}

export class PosthogSender {
  constructor(private opts: { apiKey: string; host: string; dlqPath: string; timeoutMs?: number }) {}

  async flush(batch: CanonicalEvent[]): Promise<void> {
    const url = `${this.opts.host.replace(/\/$/, "")}/batch`;
    try {
      await withRetry(async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildPosthogBatch(batch, this.opts.apiKey)),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10000),
        });
        if (!res.ok) throw new Error(`PostHog HTTP ${res.status}`);
        for (const dlqBatch of drainDlq(this.opts.dlqPath)) {
          await this.flush(dlqBatch as CanonicalEvent[]);
        }
      }, 3, [...DEFAULT_RETRY_DELAYS_MS]);
    } catch (err) {
      appendToDlq(this.opts.dlqPath, batch);
      console.error(`[posthog] flush failed, wrote ${batch.length} events to DLQ:`, err);
    }
  }
}
