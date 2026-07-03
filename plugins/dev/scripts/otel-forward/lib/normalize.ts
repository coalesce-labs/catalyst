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

// A pino-shaped operational log: numeric `level` + string `msg`, no `event`
// string and no `attributes` block (those belong to flat / canonical records).
export function isPinoRecord(obj: unknown): obj is Record<string, unknown> {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.level === "number" &&
    typeof o.msg === "string" &&
    typeof o.event !== "string" &&
    !("attributes" in o)
  );
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

  const eventName = typeof rec.name === "string" ? rec.name : "execution-core";
  const ev = buildCanonicalEnvelope({
    ts,
    serviceName: "catalyst.execution-core",
    eventName,
    severityText,
    severityNumber,
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
