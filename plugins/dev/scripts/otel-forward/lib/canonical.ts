import type { CanonicalEvent } from "../../orch-monitor/lib/canonical-event.ts";
import { hostName, buildCatalystResource } from "../../orch-monitor/lib/canonical-event-shared.ts";

// CTL-1262: stable Catalyst node name. Identical resolution to
// execution-core/config.mjs getHostName(): CATALYST_HOST_NAME env ->
// catalyst.host.name in the Layer-2 (~/.config/catalyst/config.json) config ->
// os.hostname() reduced to its first DNS label. The shared hostName() helper
// already implements exactly this precedence and never throws, so we delegate
// to it. It is deliberately a SEPARATE function from the OS-hostname concept:
// host.name is the OS identity, catalyst.node.name is the stable coordination
// name HRW / the delegate key off, and they are kept as distinct resource keys
// even though the helper currently resolves them through the same code path.
// The node name is NEVER derived from a Tailscale device name.
export function nodeName(): string {
  return hostName();
}

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
    // CTL-1368: built through buildCatalystResource so catalyst.node.class (the
    // node ROLE) is stamped LAST. service.name / service.version / host identity
    // are unchanged (host resolved via the bare hostName()/hostId() the helper
    // uses internally with no override). The CTL-1262 catalyst.node.name — a
    // DISTINCT resource attribute (the stable coordination name HRW / the
    // delegate key off, resolved the SAME way as getHostName()) — is carried
    // through `extra` so it lands AFTER node.class on the OTLP wire (toAttrArray
    // serializes the whole resource generically, so no otlp.ts change).
    // as unknown as: the shared builder returns Record<string, unknown>; bridge the
    // index-signature gap (runtime shape is a valid resource — version always set here).
    resource: buildCatalystResource({
      serviceName: opts.serviceName,
      serviceVersion: opts.serviceVersion ?? "0.0.0",
      extra: { "catalyst.node.name": nodeName() },
    }) as unknown as CanonicalEvent["resource"],
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
