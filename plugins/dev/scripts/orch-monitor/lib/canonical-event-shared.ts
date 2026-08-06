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

export type Severity = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

export const SEVERITY_NUMBERS: Record<Severity, number> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
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

const NODE_CLASSES = ["developer", "worker", "monitor"] as const;
export type NodeClass = (typeof NODE_CLASSES)[number];

/**
 * Resolve this node's catalyst.node.class as the role STRING — the TS mirror of
 * execution-core/lib/node-class.mjs nodeClass() (and config.mjs resolveNodeClass). Same
 * precedence (CATALYST_NODE_CLASS env → Layer-2 catalyst.node.class → worker) and the same
 * validity ladder (absent/null/empty ⇒ worker; present non-string OR a non-member string ⇒
 * monitor, the most-restrictive). Inlined here (like layer2HostName) to keep this a leaf.
 */
export function nodeClass(): NodeClass {
  const envRaw = process.env.CATALYST_NODE_CLASS;
  const hasEnv = typeof envRaw === "string" && envRaw.trim().length > 0;
  let raw: unknown = hasEnv ? envRaw : undefined;
  if (!hasEnv) {
    // `||` (not `??`): an EMPTY CATALYST_LAYER2_CONFIG_FILE must fall back to the default
    // path — matching config.mjs resolveNodeClass + the MJS leaf (Codex P2 parity).
    const path = process.env.CATALYST_LAYER2_CONFIG_FILE ||
      resolve(homedir(), ".config", "catalyst", "config.json");
    try {
      raw = (JSON.parse(readFileSync(path, "utf8")) as
        { catalyst?: { node?: { class?: unknown } } })?.catalyst?.node?.class;
    } catch { raw = undefined; }
  }
  if (raw === undefined || raw === null) return "worker";
  if (typeof raw !== "string") return "monitor";
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return "worker";
  return (NODE_CLASSES as readonly string[]).includes(normalized) ? (normalized as NodeClass) : "monitor";
}

/**
 * buildCatalystResource — the TS twin of execution-core/lib/catalyst-resource.mjs. The one
 * place the broker (3 MJS files import this leaf) and the orch-monitor / otel-forward TS
 * emitters build their resource block, so catalyst.node.class is stamped once. node.class is
 * LAST. service.version included only when provided. Extra resource keys (e.g.
 * otel-forward's catalyst.node.name) are merged AFTER via the `extra` param so node.class
 * still lands in a stable position.
 */
export function buildCatalystResource(opts: {
  serviceName: string;
  serviceVersion?: string;
  host?: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const hostOpts = opts.host !== undefined ? { override: opts.host } : {};
  const resource: Record<string, unknown> = {
    "service.name": opts.serviceName,
    "service.namespace": "catalyst",
  };
  if (opts.serviceVersion !== undefined) resource["service.version"] = opts.serviceVersion;
  resource["host.name"] = hostName(hostOpts);
  resource["host.id"] = hostId(hostOpts);
  resource["catalyst.node.class"] = nodeClass();
  if (opts.extra) Object.assign(resource, opts.extra);
  return resource;
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
