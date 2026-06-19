import type { CanonicalEvent } from "../../orch-monitor/lib/canonical-event.ts";
import { hostName, hostId } from "../../orch-monitor/lib/canonical-event-shared.ts";

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
    resource: {
      "service.name": opts.serviceName,
      "service.namespace": "catalyst",
      "service.version": opts.serviceVersion ?? "0.0.0",
      "host.name": hostName(),
      "host.id": hostId(),
      // CTL-1262: stable Catalyst node name as a DISTINCT resource attribute so
      // dashboards / the delegate can attribute signals per node. Resolved the
      // SAME way as execution-core/config.mjs getHostName() — the shared
      // hostName() helper applies the identical precedence (CATALYST_HOST_NAME
      // env -> catalyst.host.name in Layer-2 config -> os.hostname() first DNS
      // label) and never throws, falling back safely. NOT the Tailscale device
      // name. Keyed distinctly from the OS hostname (host.name); when the two
      // resolve to the same value today they remain semantically separate keys.
      // buildOtlpPayload's generic toAttrArray serializes the whole resource, so
      // this lands on the OTLP wire with no otlp.ts change.
      "catalyst.node.name": nodeName(),
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
