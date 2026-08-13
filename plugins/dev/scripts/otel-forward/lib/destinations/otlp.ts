import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";
import {
  HttpError, classifyStatus, parseRetryAfter,
  withHttpRetry, type HttpRetryPolicy, type HttpRetryClock,
} from "../retry.ts";
import { appendToDlq, drainDlqBounded, DEFAULT_MAX_DRAIN_BATCHES, type DrainOutcome } from "../dlq.ts";
import { partitionByAge } from "../age-filter.ts";
import { log } from "../logger.ts";
import { buildCanonicalEnvelope } from "../canonical.ts";
import { recordDrop, type DropReason } from "../drop-surface.ts";

const destLog = log.child({ destination: "otlp" });

// CTL-1506 (Codex P2): per-PROCESS nonce folded into every emitted event's id. The id
// hash (buildCanonicalEnvelope) covers only ts+event+idExtra — NOT host/process identity
// — and truncates the timestamp to whole seconds, so a bare per-instance sequence would
// still collide across two fleet hosts (or a same-second restart) emitting the same
// event type/count at the same seq position. A random per-process nonce makes each
// instance's ids disjoint from every other process's.
const INSTANCE_NONCE = randomUUID().slice(0, 8);

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

// CTL-1506 (Codex P2): never put a NaN timeUnixNano on the wire. An unparseable timestamp
// would serialize to JSON `null`, which the collector rejects with a terminal 400 that
// dead-drops every co-rider in the batch. Fall back to a fresh clock (NOT to a possibly-old
// observedTs, which could itself be past Loki's window and trigger the same too-old drop) —
// a record with an unknown time is sent as "now", which is always inside the accept window.
function toUnixNano(ts: string | undefined): number {
  const t = ts ? Date.parse(ts) : NaN;
  return (Number.isNaN(t) ? Date.now() : t) * 1_000_000;
}

// CTL-1817: DEGENERATE-RECORD DETECTION.
//
// A record whose body maps to "" AND whose attributes map to [] carries nothing but a
// timestamp and a severity once it is off this machine — its identity is destroyed in
// transit. That is not a delivery failure, so none of the three existing guardrails can see
// it: the forward SUCCEEDS, so `forward_failed`/DLQ-size never fire, and `forward_lag`'s
// checkpoint advances normally.
//
// ⚠️ SCOPE — this detector does NOT see a "v3" (bare-`name`) record, and must not be read as
// if it did. Such a record never reaches this mapper: the tailer's `shouldForward`
// (lib/tail.ts) drops it for matching no known shape, and `processLine` (index.ts) drops
// anything that still has no `attributes`. The 531 `phase.rescue.*` + 1 `phase.orphan-pr.*`
// of 2026-08 were discarded at those two gates, NOT forwarded degenerately — they never left
// the host. That loss is reported by `noteUnrecognizedLine` / `skippedNoAttributes`, which
// sit at the gates that can actually observe it (round-1 review, Codex P1).
//
// What DOES reach here is a record carrying a present-but-EMPTY `attributes` object (`{}`
// passes the truthiness guard above) with no resolvable body — degenerate yet forwarded.
// That is a narrower case than v3, and a real one: it is integrity loss on a delivered
// record rather than a drop.
//
// The counter is deliberately NOT a repair. The mapping output is left byte-identical so a
// degenerate record still forwards (dropping it here would trade silent corruption for
// silent loss) and so the regression test can still observe the defect on a raw fixture.
// It is a DETECTOR: it should sit at zero, so any non-zero value is itself the alarm.
//
// It is reported on destLog — the pino `~/catalyst/otel-forward.log`, which Alloy tails and
// ships to Loki independently of this file's OTLP egress (log-shipper/config.alloy:22). That
// independence is the point: an alarm that rides the transport it measures reads clean during
// exactly the outage it exists to detect.
let degenerateRecordCount = 0;

/** Running count of degenerate records seen by this process. Expected to stay 0. */
export function degenerateRecordTotal(): number {
  return degenerateRecordCount;
}

/** Test seam — reset the process-scoped counter between cases. */
export function resetDegenerateRecordTotal(): void {
  degenerateRecordCount = 0;
}

// Best-effort identity for a record that, by definition, failed to present one in the shape
// the mapper expects. Reads all three envelope shapes (v2 attributes ?? v1 event ?? v3 name)
// so the warning can NAME the offending event instead of reporting an anonymous count.
function describeDegenerate(ev: CanonicalEvent): string {
  const raw = ev as unknown as Record<string, unknown>;
  const v2 = ev.attributes?.["event.name"];
  if (typeof v2 === "string" && v2) return v2;
  if (typeof raw.event === "string" && raw.event) return raw.event;
  if (typeof raw.name === "string" && raw.name) return raw.name;
  return "(unidentifiable)";
}

export function buildOtlpPayload(events: CanonicalEvent[]): unknown {
  for (const ev of events) {
    const bodyEmpty = !(ev.body?.message ?? ev.attributes?.["event.name"] ?? "");
    const attrsEmpty = Object.keys((ev.attributes as unknown as Record<string, unknown>) ?? {}).length === 0;
    if (bodyEmpty && attrsEmpty) {
      degenerateRecordCount++;
      destLog.warn(
        {
          event: describeDegenerate(ev),
          ts: ev.ts,
          service: ev.resource?.["service.name"] ?? null,
          degenerate_total: degenerateRecordCount,
        },
        "otlp: DEGENERATE record — empty body AND no attributes; forwarded anyway, identity lost off-machine (CTL-1817)",
      );
    }
  }
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
              timeUnixNano: toUnixNano(ev.ts),
              observedTimeUnixNano: toUnixNano(ev.observedTs ?? ev.ts),
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
  /** Path to append canonical events on flush failure/drop (CTL-1008 Phase 4). May be a
   *  resolver so the CURRENT monthly log file is picked at emission time — a long-running
   *  daemon that crosses a UTC month boundary must not keep writing to the previous
   *  month's file the tailer no longer reads (CTL-1506 Codex P2). */
  eventLogPath?: string | (() => string);
  /** Max DLQ batches to drain per flush cycle. Defaults to DEFAULT_MAX_DRAIN_BATCHES. */
  maxDrainBatches?: number;
  /** Called after each successfully delivered batch (primary or DLQ). Used by Phase 3 lag tracking. */
  onBatchDelivered?: (batch: CanonicalEvent[]) => void;
  /** CTL-1506 (Codex P1): shutdown signal. When aborted, in-flight retries stop and the
   *  batch is DLQ'd immediately, so a flush can't outlive the launcher's SIGKILL grace. */
  signal?: AbortSignal;
  /** CTL-1818: accounting seam for a DISCARDED batch. Defaults to the host-local drop
   *  surface (lib/drop-surface.ts) so the wiring cannot be forgotten at a call site; a test
   *  passes a no-op to bypass it (the ticket's required positive control) or a spy to assert
   *  the exact reason/count. Never used to CHANGE what is dropped — only to record it. */
  dropRecorder?: (reason: DropReason, records: number) => void;
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
    // CTL-1506 (Codex P2): resolve the path per emission so a month rollover is honored.
    const logPath = typeof this.opts.eventLogPath === "function"
      ? this.opts.eventLogPath()
      : this.opts.eventLogPath;
    if (!logPath) return;
    try {
      const ev = buildCanonicalEnvelope({
        serviceName: "catalyst.otel-forward",
        eventName,
        severityText: severity.text,
        severityNumber: severity.number,
        payload,
        idExtra: `${payload.count ?? payload.batchSize ?? ""}:${INSTANCE_NONCE}:${this.emitSeq++}`,
        attributes: extraAttrs,
      });
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, JSON.stringify(ev) + "\n");
    } catch {
      // Best-effort — never throw from event emission
    }
  }

  private emitDrop(reason: "aged" | "terminal_4xx", records: CanonicalEvent[]): void {
    // CTL-1818: account for the discard on the host-local surface BEFORE the two guards
    // below, both of which suppress the event entirely — no `eventLogPath` (nothing to write
    // to) and `isSelfBatch` (the CTL-1008 loop guard). A discard suppressed there is today
    // invisible on EVERY surface: aged records never ride the DLQ, so the CTL-1502 watchdog's
    // DLQ-size predicate stays flat, and the checkpoint keeps advancing past them.
    //
    // This is deliberately unconditional and destination-local: the surface must survive the
    // transport it reports on, so it can never be gated on the event log being writable.
    (this.opts.dropRecorder ?? recordDrop)(reason, records.length);
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
    // CTL-1506 (Codex P2): partition for send against a slightly stricter cutoff (window
    // minus a delivery margin) so a record barely inside the window can't cross the cutoff
    // DURING the request/collector processing and trigger a terminal too-old response that
    // drops its fresher co-riders. Margin is bounded to ≤ ¼ of the window so it never
    // inverts the cutoff on small windows.
    const margin = Math.min(this.opts.timeoutMs ?? 5000, Math.floor(windowMs / 4));
    const sendWindowMs = Math.max(1, windowMs - margin);
    const clock: HttpRetryClock = {
      ...this.opts.retryClock,
      signal: this.opts.retryClock?.signal ?? this.opts.signal,
    };
    try {
      await withHttpRetry(
        async () => {
          const { fresh, aged } = partitionByAge(state.pending, Date.now(), sendWindowMs);
          if (aged.length) state.aged.push(...aged);
          state.pending = fresh;
          if (fresh.length === 0) return; // aged out entirely → nothing to send (success)
          await rawSend(fresh);
        },
        this.opts.httpRetryPolicy,
        clock
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
      // CTL-1506 (Codex P1): abort the in-flight request on shutdown too, not just on the
      // per-request timeout, so a graceful stop doesn't wait out a slow socket.
      const timeoutSignal = AbortSignal.timeout(this.opts.timeoutMs ?? 5000);
      const signal = this.opts.signal
        ? AbortSignal.any([timeoutSignal, this.opts.signal])
        : timeoutSignal;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildOtlpPayload(b)),
        signal,
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

    // 3) Delivered → bounded drain. But ONLY when a real POST actually succeeded
    //    (delivered.length > 0). If the fresh set aged out entirely during the retry
    //    backoff, withHttpRetry resolves without ever confirming the backend is healthy
    //    (Codex P2) — draining then would start another full retry window against a
    //    possibly-unhealthy backend, exactly the failed-primary case that skips draining.
    if (result.delivered.length === 0) return;
    this.opts.onBatchDelivered?.(result.delivered);
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

