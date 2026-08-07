import { statSync } from "node:fs";
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
