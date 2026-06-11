import type { CanonicalEvent } from "../../orch-monitor/lib/canonical-event.ts";

// Promote key identifier fields to OTel attributes. All other flat fields
// land in body.payload (nothing dropped). Fields not listed here are not
// first-class OTel attributes for these events (e.g. reason, worktree_path).
const ATTR_MAP: Record<string, string> = {
  ticket: "catalyst.worker.ticket",
  phase: "catalyst.worker.phase",
  bg_job_id: "catalyst.worker.bg_job_id",
  branch: "catalyst.worker.branch",
  orch_id: "catalyst.orchestrator.id",
  dominant_phase: "catalyst.worker.dominant_phase",
};

export function isFlatEvent(obj: unknown): obj is Record<string, unknown> {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o.event === "string" && !("attributes" in o);
}

// Build a deterministic id from ts + event + bg_job_id without Math.random.
// Uses a simple djb2-style hash over the combined string, hex-encoded.
function deterministicId(ts: string, event: string, bgJobId?: string): string {
  const input = `${ts}:${event}:${bgJobId ?? ""}`;
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
    h = h >>> 0; // keep 32-bit unsigned
  }
  // Pad to 8 hex chars + timestamp suffix to approach UUID shape
  const tsHex = String(ts.replace(/\D/g, "")).slice(0, 12).padStart(12, "0");
  return `${h.toString(16).padStart(8, "0")}-${tsHex}`;
}

export function normalizeFlatEvent(flat: Record<string, unknown>): CanonicalEvent {
  const ts = (flat.ts as string) ?? new Date(0).toISOString();
  const eventName = (flat.event as string) ?? "unknown";

  const attributes: Record<string, unknown> = { "event.name": eventName };
  const payload: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(flat)) {
    if (key === "ts" || key === "event") continue;
    const attrKey = ATTR_MAP[key];
    if (attrKey) {
      attributes[attrKey] = val;
    } else {
      payload[key] = val;
    }
  }

  return {
    ts,
    observedTs: ts,
    id: deterministicId(ts, eventName, flat.bg_job_id as string | undefined),
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: {
      "service.name": "catalyst.execution-core",
      "service.namespace": "catalyst",
      "service.version": "0.0.0",
    },
    attributes: attributes as CanonicalEvent["attributes"],
    body: { message: eventName, payload: Object.keys(payload).length > 0 ? payload : undefined },
  };
}
