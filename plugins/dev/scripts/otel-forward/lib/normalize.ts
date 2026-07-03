import type { CanonicalEvent } from "../../orch-monitor/lib/canonical-event.ts";
import { buildCanonicalEnvelope } from "./canonical.ts";
import { pinoLevelToSeverity } from "./pino-severity.ts";

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

// A pino-shaped operational log: numeric `level` + string `msg`, no
// `attributes` block (that belongs to already-canonical records). A structured
// `event` field is ALLOWED — execution-core pino calls attach one as ordinary
// structured data (e.g. `reaper.mjs` logs `{ level, msg, event }` on WARN/ERROR)
// — and processLine checks isPinoRecord BEFORE isFlatEvent so those records keep
// their severity instead of being misread as flat INFO events (CTL-1424).
export function isPinoRecord(obj: unknown): obj is Record<string, unknown> {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o.level === "number" && typeof o.msg === "string" && !("attributes" in o);
}

// isHexId — an OTLP trace/span id is a fixed-length lowercase-hex string
// (32 for trace, 16 for span). Validate before forwarding so a malformed
// value never reaches the collector (which would reject the whole record).
function isHexId(v: unknown, len: number): v is string {
  return typeof v === "string" && v.length === len && /^[0-9a-f]+$/i.test(v);
}

export function normalizePinoRecord(rec: Record<string, unknown>): CanonicalEvent {
  const time = typeof rec.time === "number" && rec.time > 0 ? rec.time : undefined;
  const ts = time !== undefined ? new Date(time).toISOString() : new Date().toISOString();
  const { text: severityText, number: severityNumber } = pinoLevelToSeverity(rec.level);

  // Residual fields: everything except `level`, `time`, `msg` goes to payload.
  const payload: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(rec)) {
    if (key === "level" || key === "time" || key === "msg") continue;
    payload[key] = val;
  }

  // Each daemon pino logger sets its own `name` (execution-core, broker,
  // cloud-sync, …) and the repo convention maps each to its own OTel service
  // `catalyst.<name>`, so a broker log routes under catalyst.broker rather than
  // being mis-stamped catalyst.execution-core and vanishing from service-scoped
  // OTLP/Loki queries (CTL-1424).
  const loggerName = typeof rec.name === "string" && rec.name ? rec.name : "execution-core";
  const serviceName = loggerName.startsWith("catalyst.") ? loggerName : `catalyst.${loggerName}`;

  // Preserve pino trace context: the scheduler stamps trace_id/span_id on its
  // Tier-1 line for log↔Tempo pivoting, so lift them to the envelope's top-level
  // traceId/spanId (the only fields otlp.ts forwards) instead of leaving the
  // correlation stranded in body.payload (CTL-1424).
  const traceId = isHexId(rec.trace_id, 32) ? rec.trace_id : undefined;
  const spanId = isHexId(rec.span_id, 16) ? rec.span_id : undefined;

  const ev = buildCanonicalEnvelope({
    ts,
    serviceName,
    eventName: loggerName,
    severityText,
    severityNumber,
    traceId,
    spanId,
    // Disambiguate bursts: pino `time` is ms-precision and `name` is constant
    // per logger, so without an idExtra two records emitted in the same ms would
    // collide on the deterministic id / OTLP logRecordUid and be deduped or
    // mis-correlated downstream. pid + level + msg keeps distinct lines distinct
    // while staying deterministic (no Math.random in the hot path) (CTL-1424).
    idExtra: `${typeof rec.pid === "number" ? rec.pid : ""}:${severityNumber}:${rec.msg as string}`,
    payload: Object.keys(payload).length > 0 ? payload : undefined,
  });
  // Override body.message with the actual log message rather than the event name.
  (ev.body as Record<string, unknown>).message = rec.msg as string;
  return ev;
}

export function normalizeFlatEvent(flat: Record<string, unknown>): CanonicalEvent {
  const ts = (flat.ts as string) ?? new Date(0).toISOString();
  const eventName = (flat.event as string) ?? "unknown";

  const attributes: Record<string, unknown> = {};
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

  return buildCanonicalEnvelope({
    ts,
    serviceName: "catalyst.execution-core",
    eventName,
    attributes,
    payload: Object.keys(payload).length > 0 ? payload : undefined,
    idExtra: flat.bg_job_id as string | undefined,
  });
}
