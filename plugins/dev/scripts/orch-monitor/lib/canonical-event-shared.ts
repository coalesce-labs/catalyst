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
import { hostname, homedir } from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

// Layer-2 (machine-local) config — mirrors config.mjs getLayer2ConfigPath()/getHostName().
function layer2HostName(): string | null {
  const path = process.env.CATALYST_LAYER2_CONFIG_FILE ??
    resolve(homedir(), ".config", "catalyst", "config.json");
  try {
    const name = (JSON.parse(readFileSync(path, "utf8")) as
      { catalyst?: { host?: { name?: unknown } } })?.catalyst?.host?.name;
    if (typeof name === "string" && name.length > 0) return name;
  } catch { /* missing/malformed → caller falls through */ }
  return null;
}

/**
 * Resolve the effective host name.
 * Mirrors lib/host-identity.sh (bash) and execution-core/lib/host-identity.mjs (MJS).
 *
 * Precedence:
 *   1. explicit override param
 *   2. CATALYST_HOST_NAME env var
 *   3. catalyst.host.name from Layer-2 config
 *   4. os.hostname() reduced to its first DNS label
 */
export function hostName(opts: { raw?: string; override?: string } = {}): string {
  const override = opts.override ?? process.env.CATALYST_HOST_NAME;
  if (override) return override;
  if (opts.raw === undefined) {
    const cfg = layer2HostName();
    if (cfg) return cfg;
  }
  // Fallback only — collapse a FQDN os.hostname() to its first label (CTL-1252).
  const base = opts.raw ?? hostname();
  const dot = base.indexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

/**
 * Resolve the effective host id: sha256(hostName())[:16].
 * Same shape as spanId (16 hex chars). Identical across all three runtimes
 * for the same resolved host.name.
 */
export function hostId(opts: { raw?: string; override?: string } = {}): string {
  return sha256Hex(hostName(opts)).slice(0, 16);
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
