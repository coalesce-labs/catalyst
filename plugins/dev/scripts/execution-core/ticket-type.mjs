// ticket-type.mjs — resolve the canonical work-type dimension (CTL-1023).
//
// Work type (bug/feature/chore/refactor/docs/test) is a telemetry dimension so
// DevOps/FinOps views can group cost, effort, duration, and throughput by it.
// The single source of truth is triage.json `.classification` in the worker dir
// (workers/<TICKET>/triage.json) — written by phase-triage (skills/phase-triage)
// as one of feature|bug|docs|refactor|chore.
//
// CONTRACT (gherkin, CTL-1023): the resolved value is attached to phase /
// dispatch / linear-state events under the `catalyst.ticket.type` attribute and
// must be CONSISTENTLY present — a ticket with no classification yet (e.g. the
// triage phase itself, or a pre-triage dispatch) carries "unknown" rather than
// omitting the attribute. Naming coordinates with CTL-1009's semconv audit;
// `catalyst.ticket.type` is additive and renames/removes nothing.
//
// Additive + fail-open: any read error (missing file, bad JSON, absent orchDir)
// resolves to UNKNOWN_TICKET_TYPE. No throw.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const UNKNOWN_TICKET_TYPE = "unknown";

// resolveTicketType — read workers/<ticket>/triage.json and return its
// `.classification` (feature|bug|docs|refactor|chore), else UNKNOWN_TICKET_TYPE.
// Pure-ish: the only side effect is a single best-effort file read. Never throws.
export function resolveTicketType(orchDir, ticket) {
  if (!orchDir || !ticket) return UNKNOWN_TICKET_TYPE;
  try {
    const raw = readFileSync(join(orchDir, "workers", ticket, "triage.json"), "utf8");
    const classification = JSON.parse(raw)?.classification;
    if (typeof classification === "string" && classification.trim() !== "") {
      return classification;
    }
    return UNKNOWN_TICKET_TYPE;
  } catch {
    return UNKNOWN_TICKET_TYPE;
  }
}
