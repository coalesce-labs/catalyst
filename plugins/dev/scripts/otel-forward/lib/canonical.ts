import type { CanonicalEvent } from "../../orch-monitor/lib/canonical-event.ts";
import { hostName, hostId } from "../../orch-monitor/lib/canonical-event-shared.ts";

// Shared canonical-envelope builder for in-process event emission.
// Mirrors the structure of broker/router.mjs:buildCanonicalEnvelope so all
// internally-generated events (normalize.ts flat→canonical, Phase 4 failure
// events) have a consistent shape.
//
// id derivation: deterministic djb2 hash over ts+event+extra to avoid
// Math.random in the hot path (Math.random throws in workflow scripts).
function deterministicId(ts: string, eventName: string, extra?: string): string {
  const input = `${ts}:${eventName}:${extra ?? ""}`;
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
    h = h >>> 0;
  }
  const tsDigits = ts.replace(/\D/g, "").slice(0, 12).padStart(12, "0");
  return `${h.toString(16).padStart(8, "0")}-${tsDigits}`;
}

export interface BuildOpts {
  ts?: string;
  serviceName: string;
  serviceNamespace?: string;
  serviceVersion?: string;
  eventName: string;
  severityText?: CanonicalEvent["severityText"];
  severityNumber?: number;
  attributes?: Record<string, unknown>;
  payload?: unknown;
  idExtra?: string;
}

export function buildCanonicalEnvelope(opts: BuildOpts): CanonicalEvent {
  const ts = opts.ts ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    ts,
    observedTs: ts,
    id: deterministicId(ts, opts.eventName, opts.idExtra),
    severityText: opts.severityText ?? "INFO",
    severityNumber: opts.severityNumber ?? 9,
    traceId: null,
    spanId: null,
    resource: {
      "service.name": opts.serviceName,
      "service.namespace": "catalyst" as const,
      "service.version": opts.serviceVersion ?? "0.0.0",
      "host.name": hostName(),
      "host.id": hostId(),
    },
    attributes: {
      "event.name": opts.eventName,
      ...opts.attributes,
    } as CanonicalEvent["attributes"],
    body: {
      message: opts.eventName,
      ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    },
  };
}
