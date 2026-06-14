import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";
import { withRetry, DEFAULT_RETRY_DELAYS_MS } from "../retry.ts";
import { appendToDlq, drainDlqBounded, DEFAULT_MAX_DRAIN_BATCHES } from "../dlq.ts";
import { log } from "../logger.ts";

const destLog = log.child({ destination: "posthog" });

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
  constructor(private opts: { apiKey: string; host: string; dlqPath: string; timeoutMs?: number; maxDrainBatches?: number; retryDelaysMs?: number[] }) {}

  async flush(batch: CanonicalEvent[]): Promise<void> {
    const url = `${this.opts.host.replace(/\/$/, "")}/batch`;
    const retryDelays = this.opts.retryDelaysMs ?? [...DEFAULT_RETRY_DELAYS_MS];

    const sendBatch = async (b: CanonicalEvent[]) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPosthogBatch(b, this.opts.apiKey)),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10000),
      });
      if (!res.ok) throw new Error(`PostHog HTTP ${res.status}`);
    };

    try {
      await withRetry(() => sendBatch(batch), 3, retryDelays);
    } catch (err) {
      appendToDlq(this.opts.dlqPath, batch);
      destLog.error(
        { batchSize: batch.length, err: err instanceof Error ? err.message : String(err) },
        "flush failed, wrote events to DLQ",
      );
      return;
    }

    await drainDlqBounded(
      this.opts.dlqPath,
      (b) => withRetry(() => sendBatch(b as CanonicalEvent[]), 3, [...retryDelays]),
      { maxBatches: this.opts.maxDrainBatches ?? DEFAULT_MAX_DRAIN_BATCHES }
    );
  }
}
