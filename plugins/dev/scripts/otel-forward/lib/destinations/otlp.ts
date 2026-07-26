import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";
import {
  withRetry, DEFAULT_RETRY_DELAYS_MS,
  HttpError, classifyStatus, parseRetryAfter,
  withHttpRetry, type HttpRetryPolicy, type HttpRetryClock,
} from "../retry.ts";
import { appendToDlq, drainDlqBounded, DEFAULT_MAX_DRAIN_BATCHES, type DrainOutcome } from "../dlq.ts";
import { partitionByAge } from "../age-filter.ts";
import { log } from "../logger.ts";
import { buildCanonicalEnvelope } from "../canonical.ts";

const destLog = log.child({ destination: "otlp" });

interface OtlpAttr {
  key: string;
  value: { stringValue?: string; intValue?: number; doubleValue?: number };
}

// CTL-812: fractional numbers MUST map to doubleValue. The collector's OTLP/JSON
// decoder hard-rejects a float inside intValue ("assertInteger: can not decode
// float as int" → HTTP 400), and one bad attribute 400s the ENTIRE batch — the
// catalyst-agent's float metrics (host.cpu_pct, ratelimit.*_pace, …) wedged every
// batch they rode in into the DLQ this way. Integers keep intValue so existing
// integer-valued labels are byte-for-byte unchanged in Loki.
function toAttrArray(obj: Record<string, unknown>): OtlpAttr[] {
  return Object.entries(obj).map(([key, val]) =>
    typeof val === "number"
      ? Number.isInteger(val)
        ? { key, value: { intValue: val } }
        : { key, value: { doubleValue: val } }
      : { key, value: { stringValue: String(val ?? "") } }
  );
}

export function buildOtlpPayload(events: CanonicalEvent[]): unknown {
  return {
    resourceLogs: events.map((ev) => ({
      resource: {
        attributes: toAttrArray((ev.resource as unknown as Record<string, unknown>) ?? {}),
      },
      scopeLogs: [
        {
          scope: { name: "catalyst.otel-forward" },
          logRecords: [
            {
              timeUnixNano: Date.parse(ev.ts) * 1_000_000,
              observedTimeUnixNano: Date.parse(ev.observedTs ?? ev.ts) * 1_000_000,
              severityNumber: ev.severityNumber,
              severityText: ev.severityText,
              ...(ev.traceId ? { traceId: ev.traceId } : {}),
              ...(ev.spanId ? { spanId: ev.spanId } : {}),
              // CTL-344: per-event UUID maps to OTel LogRecord.logRecordUid.
              ...(ev.id ? { logRecordUid: ev.id } : {}),
              body: { stringValue: ev.body?.message ?? ev.attributes?.["event.name"] ?? "" },
              attributes: toAttrArray((ev.attributes as unknown as Record<string, unknown>) ?? {}),
            },
          ],
        },
      ],
    })),
  };
}

// CTL-1506: 1 h — conservative default; configurable if the deployment's Loki
// window differs. Records older than this are dropped before send.
export const DEFAULT_LOKI_ACCEPT_WINDOW_MS = 3_600_000;

export interface OtlpSenderOpts {
  endpoint: string;
  dlqPath: string;
  timeoutMs?: number;
  /** @deprecated No-op; use httpRetryPolicy instead. Kept for backward-compat. */
  retryDelaysMs?: number[];
  /** CTL-1506: HTTP-status-aware retry policy for the OTLP sender. */
  httpRetryPolicy?: HttpRetryPolicy;
  /** Injected clock for deterministic testing. */
  retryClock?: HttpRetryClock;
  /** CTL-1506: age window for Loki. Records older than this are dropped before send. */
  lokiAcceptWindowMs?: number;
  /** Path to append canonical events on flush failure/drop (CTL-1008 Phase 4). */
  eventLogPath?: string;
  /** Max DLQ batches to drain per flush cycle. Defaults to DEFAULT_MAX_DRAIN_BATCHES. */
  maxDrainBatches?: number;
  /** Called after each successfully delivered batch (primary or DLQ). Used by Phase 3 lag tracking. */
  onBatchDelivered?: (batch: CanonicalEvent[]) => void;
}

// CTL-1008 Phase 4: guard against re-amplifying our own failure events —
// at most one failure-event per failed batch, and failure of that event's
// own flush does not spawn another.
function isSelfBatch(batch: CanonicalEvent[]): boolean {
  return batch.every((ev) => ev.resource?.["service.name"] === "catalyst.otel-forward");
}

export class OtlpSender {
  constructor(private opts: OtlpSenderOpts) {}

  private emitEvent(eventName: string, payload: Record<string, unknown>, extraAttrs: Record<string, unknown> = {}): void {
    if (!this.opts.eventLogPath) return;
    try {
      const ev = buildCanonicalEnvelope({
        serviceName: "catalyst.otel-forward",
        eventName,
        severityText: "WARN",
        severityNumber: 13,
        payload,
        idExtra: String(payload.count ?? payload.batchSize ?? ""),
        attributes: extraAttrs,
      });
      mkdirSync(dirname(this.opts.eventLogPath), { recursive: true });
      appendFileSync(this.opts.eventLogPath, JSON.stringify(ev) + "\n");
    } catch {
      // Best-effort — never throw from event emission
    }
  }

  private emitDrop(reason: "aged" | "terminal_4xx", records: CanonicalEvent[]): void {
    if (!this.opts.eventLogPath || isSelfBatch(records)) return;
    this.emitEvent(
      "catalyst.observability.forward_dropped",
      { count: records.length, reason },
      { "catalyst.observability.drop_reason": reason }
    );
  }

  private emitFailure(batch: CanonicalEvent[], err: unknown): void {
    destLog.error(
      { batchSize: batch.length, err: err instanceof Error ? err.message : String(err) },
      "flush failed, wrote events to DLQ"
    );
    if (this.opts.eventLogPath && !isSelfBatch(batch)) {
      this.emitEvent("catalyst.observability.forward_failed", {
        batchSize: batch.length,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // CTL-1506: build the drain callback for drainDlqBounded. Each queued batch is
  // age-partitioned; aged records are dropped-with-counter; fresh records are sent
  // via withHttpRetry. Terminal 4xx → "dropped"; retryable exhaustion → rethrow
  // (preserves CTL-1060 bounded backpressure).
  private makeDrainSend(
    rawSend: (b: CanonicalEvent[]) => Promise<void>,
    windowMs: number
  ): (batch: unknown[]) => Promise<DrainOutcome> {
    return async (batch: unknown[]) => {
      const events = batch as CanonicalEvent[];
      const { fresh, aged } = partitionByAge(events, Date.now(), windowMs);
      if (aged.length) this.emitDrop("aged", aged);
      if (fresh.length === 0) return "dropped";
      try {
        await withHttpRetry(() => rawSend(fresh), this.opts.httpRetryPolicy, this.opts.retryClock);
      } catch (err) {
        if (err instanceof HttpError && classifyStatus(err.status) === "terminal") {
          this.emitDrop("terminal_4xx", fresh);
          return "dropped";
        }
        throw err; // retryable exhausted → drainDlqBounded stops + requeues remainder
      }
      return "delivered" as const;
    };
  }

  async flush(batch: CanonicalEvent[]): Promise<void> {
    const url = `${this.opts.endpoint.replace(/:4317/, ":4318").replace(/\/$/, "")}/v1/logs`;
    const windowMs = this.opts.lokiAcceptWindowMs ?? DEFAULT_LOKI_ACCEPT_WINDOW_MS;

    const rawSend = async (b: CanonicalEvent[]) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildOtlpPayload(b)),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
      if (!res.ok) {
        throw new HttpError(
          res.status,
          parseRetryAfter(res.headers.get("retry-after"), Date.now())
        );
      }
    };

    // 1) Age-partition BEFORE send — aged records never leave the client.
    const { fresh, aged } = partitionByAge(batch, Date.now(), windowMs);
    if (aged.length) this.emitDrop("aged", aged);
    if (fresh.length === 0) return; // nothing to send → skip drain

    // 2) Send fresh via status-aware retry.
    try {
      await withHttpRetry(() => rawSend(fresh), this.opts.httpRetryPolicy, this.opts.retryClock);
    } catch (err) {
      if (err instanceof HttpError && classifyStatus(err.status) === "terminal") {
        this.emitDrop("terminal_4xx", fresh);
        return; // never DLQ a terminal 4xx
      }
      appendToDlq(this.opts.dlqPath, fresh);
      this.emitFailure(fresh, err);
      return; // backend unhealthy → skip drain
    }

    // 3) Delivered → bounded drain.
    this.opts.onBatchDelivered?.(fresh);
    await drainDlqBounded(
      this.opts.dlqPath,
      this.makeDrainSend(rawSend, windowMs),
      {
        maxBatches: this.opts.maxDrainBatches ?? DEFAULT_MAX_DRAIN_BATCHES,
        onBatchDelivered: this.opts.onBatchDelivered
          ? (b) => this.opts.onBatchDelivered!(b as CanonicalEvent[])
          : undefined,
      }
    );
  }
}

// Keep withRetry export for PostHog/Cloudflare callers that import it from here
export { withRetry, DEFAULT_RETRY_DELAYS_MS };
