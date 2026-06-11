import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";
import { withRetry, DEFAULT_RETRY_DELAYS_MS } from "../retry.ts";
import { appendToDlq, drainDlq } from "../dlq.ts";
import { log } from "../logger.ts";
import { buildCanonicalEnvelope } from "../canonical.ts";

const destLog = log.child({ destination: "otlp" });

interface OtlpAttr { key: string; value: { stringValue?: string; intValue?: number; doubleValue?: number } }

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
      resource: { attributes: toAttrArray((ev.resource as unknown as Record<string, unknown>) ?? {}) },
      scopeLogs: [{
        scope: { name: "catalyst.otel-forward" },
        logRecords: [{
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
        }],
      }],
    })),
  };
}

export interface OtlpSenderOpts {
  endpoint: string;
  dlqPath: string;
  timeoutMs?: number;
  /** Override retry delays for testing. Defaults to [0, 1000, 5000] ms. */
  retryDelaysMs?: number[];
  /** Path to append a canonical forward_failed event on flush failure (CTL-1008 Phase 4). */
  eventLogPath?: string;
}

// CTL-1008 Phase 4: guard against re-amplifying our own failure events —
// at most one failure-event per failed batch, and failure of that event's
// own flush does not spawn another.
function isSelfBatch(batch: CanonicalEvent[]): boolean {
  return batch.every(ev => ev.resource?.["service.name"] === "catalyst.otel-forward");
}

export class OtlpSender {
  constructor(private opts: OtlpSenderOpts) {}

  async flush(batch: CanonicalEvent[]): Promise<void> {
    const url = `${this.opts.endpoint.replace(/:4317/, ":4318").replace(/\/$/, "")}/v1/logs`;
    const retryDelays = this.opts.retryDelaysMs ?? [...DEFAULT_RETRY_DELAYS_MS];
    try {
      await withRetry(async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildOtlpPayload(batch)),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
        });
        if (!res.ok) throw new Error(`OTLP HTTP ${res.status}`);
        for (const dlqBatch of drainDlq(this.opts.dlqPath)) {
          await this.flush(dlqBatch as CanonicalEvent[]);
        }
      }, 3, retryDelays);
    } catch (err) {
      appendToDlq(this.opts.dlqPath, batch);
      destLog.error(
        { batchSize: batch.length, err: err instanceof Error ? err.message : String(err) },
        "flush failed, wrote events to DLQ",
      );
      // CTL-1008 Phase 4: emit a canonical forward_failed event for subscriber visibility.
      // Loop guard: skip if the failed batch is already self-emitted failure events to
      // prevent a feedback loop (at most one failure-event per failed batch).
      if (this.opts.eventLogPath && !isSelfBatch(batch)) {
        try {
          const failureEvent = buildCanonicalEnvelope({
            serviceName: "catalyst.otel-forward",
            eventName: "catalyst.observability.forward_failed",
            severityText: "ERROR",
            severityNumber: 17,
            payload: {
              batchSize: batch.length,
              err: err instanceof Error ? err.message : String(err),
            },
            idExtra: String(batch.length),
          });
          mkdirSync(dirname(this.opts.eventLogPath), { recursive: true });
          appendFileSync(this.opts.eventLogPath, JSON.stringify(failureEvent) + "\n");
        } catch {
          // Best-effort — failure to write the failure event must never throw
        }
      }
    }
  }
}
