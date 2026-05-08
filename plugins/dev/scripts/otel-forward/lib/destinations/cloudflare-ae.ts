import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";
import { withRetry, DEFAULT_RETRY_DELAYS_MS } from "../retry.ts";
import { appendToDlq, drainDlq } from "../dlq.ts";

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
  constructor(private opts: { accountId: string; apiToken: string; dataset: string; dlqPath: string; timeoutMs?: number }) {}

  async flush(batch: CanonicalEvent[]): Promise<void> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.opts.accountId}/analytics_engine/datasets/${this.opts.dataset}`;
    try {
      await withRetry(async () => {
        for (const ev of batch) {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Authorization": `Bearer ${this.opts.apiToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(buildCloudflareAEPayload(ev)),
            signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
          });
          if (!res.ok) throw new Error(`CF AE HTTP ${res.status}`);
        }
        for (const dlqBatch of drainDlq(this.opts.dlqPath)) {
          await this.flush(dlqBatch as CanonicalEvent[]);
        }
      }, 3, [...DEFAULT_RETRY_DELAYS_MS]);
    } catch (err) {
      appendToDlq(this.opts.dlqPath, batch);
      console.error(`[cloudflare-ae] flush failed, wrote ${batch.length} events to DLQ:`, err);
    }
  }
}
