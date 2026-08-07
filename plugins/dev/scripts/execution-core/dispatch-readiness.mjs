import { existsSync } from "node:fs";
import { join } from "node:path";

export const NOT_DISPATCHABLE_UNTRIAGED = "untriaged-no-triage-artifact";

export function defaultHasTriageArtifact(orchDir, ticket) {
  return existsSync(join(orchDir, "workers", ticket, "triage.json"));
}

export function canOccupySlotNow(orchDir, ticket, { hasTriageArtifact } = {}) {
  const probe = hasTriageArtifact ?? defaultHasTriageArtifact;
  try {
    return probe(orchDir, ticket)
      ? { ok: true, reason: null }
      : { ok: false, reason: NOT_DISPATCHABLE_UNTRIAGED };
  } catch {
    return { ok: false, reason: NOT_DISPATCHABLE_UNTRIAGED };
  }
}
