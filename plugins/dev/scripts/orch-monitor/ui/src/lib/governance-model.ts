// governance-model.ts — CTL-1100 Phase 6: /api/governance snapshot model.
// Pure; no DOM dependency.

/** Shape returned by GET /api/governance (mirrors readGovernanceConfig). */
export interface GovernanceSnapshot {
  available: boolean;
  beliefsShadow?: boolean;
  diagnostician?: boolean;
  intentsEnforce?: boolean;
  advanceShadowSummary?: boolean;
  stallJanitor?: { mode: string };
  watchdog?: { mode: string };
  unstuckSweep?: { mode: string };
}

export function isGovernanceSnapshot(v: unknown): v is GovernanceSnapshot {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.available === "boolean";
}

/** Human labels for the 7 governance modes, in display order. */
export const GOVERNANCE_FLAG_LABELS: Record<string, string> = {
  beliefsShadow:        "Beliefs shadow",
  diagnostician:        "Diagnostician",
  intentsEnforce:       "Intents enforce",
  advanceShadowSummary: "Advance shadow",
  stallJanitor:         "Stall janitor",
  watchdog:             "Watchdog",
  unstuckSweep:         "Unstuck sweep",
};

/** Boolean flag tone: on→"green", off→"muted". */
export function flagTone(enabled: boolean): "green" | "muted" {
  return enabled ? "green" : "muted";
}

/** Mode subsystem tone: "enforce"→"green", "shadow"→"yellow", "off"→"muted". */
export function modeTone(mode: string): "green" | "yellow" | "muted" {
  if (mode === "enforce") return "green";
  if (mode === "shadow")  return "yellow";
  return "muted";
}
