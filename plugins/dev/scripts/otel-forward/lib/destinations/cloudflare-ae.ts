import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";
import { withRetry, DEFAULT_RETRY_DELAYS_MS } from "../retry.ts";
import { appendToDlq, drainDlqBounded, DEFAULT_MAX_DRAIN_BATCHES } from "../dlq.ts";
import { log } from "../logger.ts";

const destLog = log.child({ destination: "cloudflare-ae" });

export function buildCloudflareAEPayload(event: CanonicalEvent): { indexes: string[]; blobs: string[] } {
  return {
    indexes: [
      event.attributes?.["event.name"] ?? "unknown",
      event.resource?.["service.name"] ?? "catalyst",
    ],
    blobs: [JSON.stringify(event)],
  };
}

export class CloudflareAESender {
  constructor(private opts: { accountId: string; apiToken: string; dataset: string; dlqPath: string; timeoutMs?: number; maxDrainBatches?: number; retryDelaysMs?: number[] }) {}

  async flush(batch: CanonicalEvent[]): Promise<void> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.opts.accountId}/analytics_engine/datasets/${this.opts.dataset}`;
    const retryDelays = this.opts.retryDelaysMs ?? [...DEFAULT_RETRY_DELAYS_MS];

    const sendBatch = async (b: CanonicalEvent[]) => {
      for (const ev of b) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Authorization": `Bearer ${this.opts.apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(buildCloudflareAEPayload(ev)),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
        });
        if (!res.ok) throw new Error(`CF AE HTTP ${res.status}`);
      }
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
