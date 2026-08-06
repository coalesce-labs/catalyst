import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";
import {
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

// CTL-1506 (Codex P2): outcome of an age-aware send. `pending` is the still-fresh set
// that did NOT deliver (to DLQ/requeue or terminal-drop); `aged` is every record that
// aged out across attempts (accounting deferred to the caller); `delivered` is the set
// actually POSTed on success.
type SendResult =
  | { kind: "delivered"; delivered: CanonicalEvent[]; aged: CanonicalEvent[] }
  | { kind: "dropped_terminal"; pending: CanonicalEvent[]; aged: CanonicalEvent[] }
  | { kind: "failed_retryable"; pending: CanonicalEvent[]; aged: CanonicalEvent[]; err: unknown };

export class OtlpSender {
  constructor(private opts: OtlpSenderOpts) {}

  // CTL-1506 (Codex P2): monotonic per-process sequence folded into every emitted
  // event's id. buildCanonicalEnvelope truncates the timestamp to whole seconds and
  // derives the id solely from ts+event+idExtra, so two equally-sized drop counters
  // emitted within the same second would otherwise collide on both the event-list key
  // path and the forwarded logRecordUid; the seq makes each satisfy the per-record
  // uniqueness contract.
  private emitSeq = 0;

  private emitEvent(
    eventName: string,
    payload: Record<string, unknown>,
    extraAttrs: Record<string, unknown> = {},
    // CTL-1506 (Codex P2): default WARN/13 for drop counters; callers pass ERROR/17
    // for failure events so error-only queries still surface them.
    severity: { text: CanonicalEvent["severityText"]; number: number } = { text: "WARN", number: 13 }
  ): void {
    if (!this.opts.eventLogPath) return;
    try {
      const ev = buildCanonicalEnvelope({
        serviceName: "catalyst.otel-forward",
        eventName,
        severityText: severity.text,
        severityNumber: severity.number,
        payload,
        idExtra: `${payload.count ?? payload.batchSize ?? ""}:${this.emitSeq++}`,
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
      this.emitEvent(
        "catalyst.observability.forward_failed",
        {
          batchSize: batch.length,
          err: err instanceof Error ? err.message : String(err),
        },
        {},
        // CTL-1506 (Codex P2): failure events keep ERROR/17 so documented error-only
        // queries (severityText == "ERROR") still surface exhausted-retry delivery
        // failures; drop counters intentionally stay WARN/13.
        { text: "ERROR", number: 17 }
      );
    }
  }

  // CTL-1506 (Codex P2): send `records` with age re-partitioning on EVERY retry
  // attempt. A record just inside the window at entry can age out during the (up to
  // maxRetryElapsedMs) retry loop; re-partitioning per attempt drops it-with-counter
  // and removes it from the working set BEFORE the next send, so a stale co-rider can
  // no longer drag a fresh batch into a terminal too-old rejection. Aged records are
  // COLLECTED (not emitted) here so each caller decides WHEN to count them — the drain
  // path must defer counting until the entry is actually consumed, else a retryable
  // requeue recounts them on every later drain.
  private async sendFreshWithAging(
    rawSend: (b: CanonicalEvent[]) => Promise<void>,
    records: CanonicalEvent[],
    windowMs: number
  ): Promise<SendResult> {
    const state = { pending: records, aged: [] as CanonicalEvent[] };
    try {
      await withHttpRetry(
        async () => {
          const { fresh, aged } = partitionByAge(state.pending, Date.now(), windowMs);
          if (aged.length) state.aged.push(...aged);
          state.pending = fresh;
          if (fresh.length === 0) return; // aged out entirely → nothing to send (success)
          await rawSend(fresh);
        },
        this.opts.httpRetryPolicy,
        this.opts.retryClock
      );
      return { kind: "delivered", delivered: state.pending, aged: state.aged };
    } catch (err) {
      if (err instanceof HttpError && classifyStatus(err.status) === "terminal") {
        return { kind: "dropped_terminal", pending: state.pending, aged: state.aged };
      }
      return { kind: "failed_retryable", pending: state.pending, aged: state.aged, err };
    }
  }

  // CTL-1506: build the drain callback for drainDlqBounded. Terminal 4xx → "dropped";
  // retryable exhaustion → rethrow (preserves CTL-1060 bounded backpressure) WITHOUT
  // counting aged co-riders, so requeueing the unchanged entry never double-counts them
  // (Codex P2). Aged are counted only on a consuming outcome (delivered or terminal).
  private makeDrainSend(
    rawSend: (b: CanonicalEvent[]) => Promise<void>,
    windowMs: number
  ): (batch: unknown[]) => Promise<DrainOutcome> {
    return async (batch: unknown[]) => {
      const events = batch as CanonicalEvent[];
      const result = await this.sendFreshWithAging(rawSend, events, windowMs);
      if (result.kind === "failed_retryable") {
        // Requeue the ENTIRE entry (drainDlqBounded rewrites the original line). Aged
        // co-riders ride along and are counted only when the entry finally consumes.
        throw result.err;
      }
      if (result.aged.length) this.emitDrop("aged", result.aged);
      if (result.kind === "dropped_terminal") {
        if (result.pending.length) this.emitDrop("terminal_4xx", result.pending);
        return "dropped";
      }
      // delivered — an entry that aged out entirely is consumed but not delivered.
      return result.delivered.length > 0 ? "delivered" : "dropped";
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

    // 1) Age-partition BEFORE send — aged records never leave the client. A fully-aged
    //    incoming batch returns here (no send, no drain — the early-return invariant).
    const { fresh, aged } = partitionByAge(batch, Date.now(), windowMs);
    if (aged.length) this.emitDrop("aged", aged);
    if (fresh.length === 0) return; // nothing to send → skip drain

    // 2) Send fresh via status-aware retry, re-partitioning by age on each attempt
    //    (Codex P2). Aged records never ride the DLQ in the primary path, so we count
    //    them on every outcome; only the still-fresh `pending` set is DLQ'd/dropped.
    const result = await this.sendFreshWithAging(rawSend, fresh, windowMs);
    if (result.aged.length) this.emitDrop("aged", result.aged); // records that aged mid-retry
    if (result.kind === "dropped_terminal") {
      if (result.pending.length) this.emitDrop("terminal_4xx", result.pending);
      return; // never DLQ a terminal 4xx
    }
    if (result.kind === "failed_retryable") {
      if (result.pending.length) {
        appendToDlq(this.opts.dlqPath, result.pending);
        this.emitFailure(result.pending, result.err);
      }
      return; // backend unhealthy → skip drain
    }

    // 3) Delivered → bounded drain.
    if (result.delivered.length) this.opts.onBatchDelivered?.(result.delivered);
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

