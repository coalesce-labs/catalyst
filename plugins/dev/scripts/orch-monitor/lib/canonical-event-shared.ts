/**
 * Shared canonical-event primitives — imported by both `canonical-event.ts`
 * (orch-monitor TS surface) and `broker/index.mjs` (broker daemon). Anything
 * that must produce identical output across the two runtimes lives here.
 *
 * SHA-256 derivation for traceId / spanId mirrors the bash twin in
 * `plugins/dev/scripts/lib/canonical-event.sh`. Per-event `id` (CTL-344) is
 * non-deterministic on purpose — every emission gets a unique UUIDv4.
 * `synthesizeEventId` produces a stable synthetic id for legacy events that
 * lack a real `id` on the read side.
 */

import { createHash, randomUUID } from "node:crypto";

export type Severity = "DEBUG" | "INFO" | "WARN" | "ERROR";

export const SEVERITY_NUMBERS: Record<Severity, number> = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

export function severityNumber(text: Severity): number {
  return SEVERITY_NUMBERS[text];
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Trace ID derivation. Hex-truncated SHA-256 — OTel requires 32 hex chars.
 * Returns null when no useful seed is available.
 *
 * Precedence:
 *   1. Non-empty orchestratorId → sha256(orchestratorId).slice(0, 32)
 *   2. Non-empty sessionId → sha256("standalone:" + sessionId).slice(0, 32)
 *   3. otherwise → null (ambient event with no trace context)
 */
export function deriveTraceId(
  orchestratorId: string | null | undefined,
  sessionId?: string | null,
): string | null {
  if (orchestratorId !== null && orchestratorId !== undefined && orchestratorId.length > 0) {
    return sha256Hex(orchestratorId).slice(0, 32);
  }
  if (sessionId !== null && sessionId !== undefined && sessionId.length > 0) {
    return sha256Hex("standalone:" + sessionId).slice(0, 32);
  }
  return null;
}

/**
 * Span ID derivation. Hex-truncated SHA-256 — OTel requires 16 hex chars.
 *
 * Precedence:
 *   1. Non-empty workerTicket → sha256(workerTicket).slice(0, 16)
 *   2. Non-empty sessionId → sha256(sessionId).slice(0, 16)
 *   3. otherwise → null
 */
export function deriveSpanId(
  workerTicket: string | null | undefined,
  sessionId?: string | null,
): string | null {
  if (workerTicket !== null && workerTicket !== undefined && workerTicket.length > 0) {
    return sha256Hex(workerTicket).slice(0, 16);
  }
  if (sessionId !== null && sessionId !== undefined && sessionId.length > 0) {
    return sha256Hex(sessionId).slice(0, 16);
  }
  return null;
}

/**
 * Generate a per-event unique identifier. UUIDv4 via `crypto.randomUUID()`.
 * Maps cleanly to OTel `LogRecord.logRecordUid` on OTLP forward.
 */
export function generateEventId(): string {
  return randomUUID();
}

/**
 * Stable synthetic id for legacy records that lack a real `id`. Inputs that
 * are most likely to differ between events: traceId, spanId, ts, event name.
 * Returns a 32-char lowercase hex string distinguishable from real UUIDv4
 * (no hyphens, no `4xxx-yxxx` pattern).
 */
export function synthesizeEventId(event: {
  traceId?: string | null;
  spanId?: string | null;
  ts: string;
  attributes?: { "event.name"?: string };
}): string {
  const input =
    (event.traceId ?? "") +
    ":" +
    (event.spanId ?? "") +
    ":" +
    event.ts +
    ":" +
    (event.attributes?.["event.name"] ?? "");
  return sha256Hex(input).slice(0, 32);
}
