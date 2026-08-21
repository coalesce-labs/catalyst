import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const NOT_DISPATCHABLE_UNTRIAGED = "untriaged-no-triage-artifact";
export const NOT_DISPATCHABLE_TRIAGE_PROBE_ERROR = "triage-probe-error";

export function defaultHasTriageArtifact(orchDir, ticket) {
  try {
    statSync(join(orchDir, "workers", ticket, "triage.json"));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

// triageCapTripped — has this ticket's triage re-dispatch cap PARKED it (CTL-1441)?
// Reads the counter record monitor.mjs writes at orchDir/.triage-dispatch-counts/
// <ticket>.json; `cappedAt` is stamped exactly once, when the park fires. The path
// contract is shared with monitor.mjs (triageDispatchCountPath) — kept as a read-only
// twin here rather than an import so the scheduler stays uncoupled from the monitor
// daemon (same rationale as defaultHasTriageArtifact above).
// Fail-open: absent/unreadable/malformed → not capped (mirrors readTriageDispatchRecord).
export function triageCapTripped(orchDir, ticket) {
  try {
    const rec = JSON.parse(
      readFileSync(join(orchDir, ".triage-dispatch-counts", `${ticket}.json`), "utf8")
    );
    return typeof rec?.cappedAt === "string";
  } catch {
    return false;
  }
}

// triageReservationDeadlocked — CTL-2090. True iff reserving a slot (or preempting a
// worker) on this ticket's behalf can never pay off: its triage re-dispatch cap has
// tripped AND it still has no triage.json. The reservation design (CAT-36) rests on
// "the freed slot is what lets the monitor TRIAGE this ticket" — for a capped ticket
// the monitor's dispatchTriage refuses forever, so the reservation is a deadlock:
// on a maxParallel=1 host it starves every triaged waiter behind it (mini-2,
// 2026-08-20: CTC-750 held the only slot for 36h across three daemon restarts).
// A capped ticket that DOES have its artifact is NOT deadlocked — its final attempt
// produced the artifact and normal dispatch can consume the slot.
// Fail-open on a probe error: an unreadable artifact probe keeps the ticket ranked
// (never changes admission behaviour on an FS hiccup).
export function triageReservationDeadlocked(orchDir, ticket, { hasTriageArtifact } = {}) {
  if (!triageCapTripped(orchDir, ticket)) return false;
  const probe = hasTriageArtifact ?? defaultHasTriageArtifact;
  try {
    return !probe(orchDir, ticket);
  } catch {
    return false;
  }
}

export function canOccupySlotNow(orchDir, ticket, { hasTriageArtifact } = {}) {
  const probe = hasTriageArtifact ?? defaultHasTriageArtifact;
  try {
    return probe(orchDir, ticket)
      ? { ok: true, reason: null }
      : { ok: false, reason: NOT_DISPATCHABLE_UNTRIAGED };
  } catch (error) {
    return { ok: false, reason: NOT_DISPATCHABLE_TRIAGE_PROBE_ERROR, error };
  }
}
