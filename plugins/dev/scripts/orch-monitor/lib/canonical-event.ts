/**
 * Canonical OTel-shaped event envelope.
 *
 * Modeled directly on OTel `LogRecord` so the on-disk JSONL is a clean
 * projection — a future sidecar can transcode to OTLP without translation.
 *
 * Trace/span IDs are derived deterministically from orchestrator/worker
 * identifiers so any producer (TS or bash) can compute the same IDs from
 * the same inputs without coordination.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Severity = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface Resource {
  "service.name": string;
  "service.namespace": "catalyst";
  "service.version": string;
}

export interface Attributes {
  // catalyst-internal classifier
  "event.name": string;
  "event.entity"?: string;
  "event.action"?: string;
  "event.label"?: string;
  "event.value"?: string | number;
  "event.channel"?: "webhook" | "sme.io";

  // catalyst entities
  "catalyst.orchestrator.id"?: string;
  "catalyst.worker.ticket"?: string;
  "catalyst.session.id"?: string;
  "catalyst.phase"?: number;

  // VCS semconv (OTel published)
  "vcs.repository.name"?: string;
  "vcs.pr.number"?: number;
  "vcs.ref.name"?: string;
  "vcs.revision"?: string;

  // CI/CD semconv (OTel published)
  "cicd.pipeline.run.id"?: number;
  "cicd.pipeline.run.conclusion"?: string;
  "cicd.pipeline.name"?: string;

  // Linear (catalyst-defined; no OTel semconv yet)
  "linear.issue.identifier"?: string;
  "linear.team.key"?: string;
  "linear.actor.id"?: string;

  // Deployment semconv (OTel published)
  "deployment.environment"?: string;
  "deployment.id"?: number;
}

export interface Body {
  message?: string;
  payload?: unknown;
}

export interface CanonicalEvent {
  ts: string;
  observedTs?: string;
  severityText: Severity;
  severityNumber: number;
  traceId: string | null;
  spanId: string | null;
  parentSpanId?: string | null;
  resource: Resource;
  attributes: Attributes;
  body: Body;
}

export interface BuildInput {
  ts: string;
  observedTs?: string;
  severityText: Severity;
  traceId: string | null;
  spanId: string | null;
  parentSpanId?: string | null;
  resource: { "service.name": string; "service.version"?: string };
  attributes: Attributes;
  body: Body;
}

const SEVERITY_NUMBERS: Record<Severity, number> = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

export function severityNumber(text: Severity): number {
  return SEVERITY_NUMBERS[text];
}

function sha256Hex(input: string): string {
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

let cachedVersion: string | null = null;

/**
 * Reads the catalyst-dev plugin version from `.claude-plugin/plugin.json`,
 * cached after first read. Falls back to the orch-monitor `package.json`
 * `version` (if present) and finally to "0.0.0" when neither is reachable.
 */
export function pluginVersion(): string {
  if (cachedVersion !== null) return cachedVersion;

  const candidates = [
    resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "..", ".claude-plugin", "plugin.json"),
    resolve(dirname(new URL(import.meta.url).pathname), "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "version" in parsed &&
        typeof (parsed as { version: unknown }).version === "string"
      ) {
        cachedVersion = (parsed as { version: string }).version;
        return cachedVersion;
      }
    } catch {
      // try next candidate
    }
  }
  cachedVersion = "0.0.0";
  return cachedVersion;
}

/**
 * Build a canonical event with defaults applied:
 *   - severityNumber from severityText
 *   - observedTs defaults to ts
 *   - resource.service.namespace = "catalyst"
 *   - resource.service.version defaults to pluginVersion()
 */
export function buildCanonicalEvent(input: BuildInput): CanonicalEvent {
  const observedTs = input.observedTs ?? input.ts;
  const version = input.resource["service.version"] ?? pluginVersion();
  const event: CanonicalEvent = {
    ts: input.ts,
    observedTs,
    severityText: input.severityText,
    severityNumber: severityNumber(input.severityText),
    traceId: input.traceId,
    spanId: input.spanId,
    resource: {
      "service.name": input.resource["service.name"],
      "service.namespace": "catalyst",
      "service.version": version,
    },
    attributes: input.attributes,
    body: input.body,
  };
  if (input.parentSpanId !== undefined) {
    event.parentSpanId = input.parentSpanId;
  }
  return event;
}

