import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { withRetry, DEFAULT_RETRY_DELAYS_MS } from "../../otel-forward/lib/retry.ts";
import { appendToDlq, drainDlqBounded, DEFAULT_MAX_DRAIN_BATCHES } from "../../otel-forward/lib/dlq.ts";
import { buildCanonicalEnvelope } from "../../otel-forward/lib/canonical.ts";

export const SERVICE_NAME = "catalyst.coordination-publish";
export const DEGRADED_EVENT_NAME = "catalyst.observability.coordination_publish_degraded";

// A coordination mirror row destined for the hub — an envelope plus its
// tailer-assigned local_seq. Kept structurally open (Record) since the daemon
// forwards the raw stamped envelope untouched.
type CoordinationRecord = Record<string, unknown>;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number }>;

export interface HubClientOpts {
  hubUrl: string;
  dlqPath: string;
  /** Append a coordination_publish_degraded event here after N consecutive failures. */
  eventLogPath?: string;
  /** Consecutive-failure count that trips the degraded event. Default 5. */
  degradedThreshold?: number;
  /** Override retry delays for testing. Defaults to [0, 1000, 5000] ms. */
  retryDelaysMs?: number[];
  timeoutMs?: number;
  /** Max DLQ batches to drain per successful publish. Defaults to DEFAULT_MAX_DRAIN_BATCHES. */
  maxDrainBatches?: number;
  /** Inject a fetch impl for tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
}

function maxSeq(batch: CoordinationRecord[]): number {
  let m = 0;
  for (const r of batch) {
    const s = typeof r.local_seq === "number" ? r.local_seq : 0;
    if (s > m) m = s;
  }
  return m;
}

/**
 * HubClient — outbound publish half of coordination-publish (enforce mode).
 *
 * The local-first mirror write has ALWAYS already happened before publish() is
 * called, so publish() NEVER throws: a hub outage degrades to the DLQ + a
 * visible degraded event, never a lost mirror row or a crashed daemon. Modeled
 * 1:1 on otel-forward/lib/destinations/otlp.ts's flush control flow — primary
 * inside withRetry, bounded failure-isolated DLQ drain outside.
 */
export class HubClient {
  lastPublishedSeq = 0;
  private consecutiveFailures = 0;
  private readonly fetchImpl: FetchLike;

  constructor(private opts: HubClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  }

  private url(): string {
    return `${this.opts.hubUrl.replace(/\/$/, "")}/coordination/publish`;
  }

  private async sendBatch(batch: CoordinationRecord[]): Promise<void> {
    const res = await this.fetchImpl(this.url(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: batch }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
    });
    if (!res.ok) throw new Error(`coordination hub HTTP ${res.status}`);
  }

  async publish(batch: CoordinationRecord[]): Promise<void> {
    if (batch.length === 0) return;
    const retryDelays = this.opts.retryDelaysMs ?? [...DEFAULT_RETRY_DELAYS_MS];

    try {
      await withRetry(() => this.sendBatch(batch), 3, retryDelays);
    } catch (err) {
      appendToDlq(this.opts.dlqPath, batch);
      this.consecutiveFailures++;
      this.maybeEmitDegraded(batch.length, err);
      return; // local-first: never throw, never block the mirror
    }

    // Primary delivered → hub healthy.
    this.consecutiveFailures = 0;
    this.lastPublishedSeq = Math.max(this.lastPublishedSeq, maxSeq(batch));
    await drainDlqBounded(
      this.opts.dlqPath,
      (b) => withRetry(() => this.sendBatch(b as CoordinationRecord[]), 3, [...retryDelays]),
      {
        maxBatches: this.opts.maxDrainBatches ?? DEFAULT_MAX_DRAIN_BATCHES,
        onBatchDelivered: (b) => {
          this.lastPublishedSeq = Math.max(this.lastPublishedSeq, maxSeq(b as CoordinationRecord[]));
        },
      }
    );
  }

  private maybeEmitDegraded(batchSize: number, err: unknown): void {
    const threshold = this.opts.degradedThreshold ?? 5;
    // Emit once at the crossing so a sustained outage isn't a per-batch spam,
    // but is never silent (mirrors otlp.ts forward_failed intent).
    if (this.consecutiveFailures !== threshold || !this.opts.eventLogPath) return;
    try {
      const ev = buildCanonicalEnvelope({
        serviceName: SERVICE_NAME,
        eventName: DEGRADED_EVENT_NAME,
        severityText: "ERROR",
        severityNumber: 17,
        payload: {
          consecutiveFailures: this.consecutiveFailures,
          batchSize,
          err: err instanceof Error ? err.message : String(err),
        },
        idExtra: String(this.consecutiveFailures),
      });
      mkdirSync(dirname(this.opts.eventLogPath), { recursive: true });
      appendFileSync(this.opts.eventLogPath, JSON.stringify(ev) + "\n");
    } catch {
      // Best-effort — failure to write the degraded event must never throw.
    }
  }
}
