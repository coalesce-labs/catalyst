// governance-model.ts — CTL-1100 Phase 6 + CTL-1104 Phase 2.
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

// ── CTL-1104 Phase 2: cluster-governance wire model ────────────────────────

/** The bare 7-field governance modes shape (extracted from GovernanceSnapshot
 *  so GovernanceFlagsChip and GovernanceModesStrip can take either form). */
export type GovernanceSnapshotModes = Omit<GovernanceSnapshot, "available">;

/** One host's governance snapshot from /api/cluster/governance. */
export interface ClusterGovernanceNode {
  host: string;
  governance: GovernanceSnapshotModes | null;
  reportedAt: string | null;
  ageMs: number | null;
  status: "live" | "degraded" | "offline";
}

/** The full wire shape for GET /api/cluster/governance. */
export interface ClusterGovernanceSignal {
  singleHost: boolean;
  nodes: ClusterGovernanceNode[];
  generatedAt: string;
}

export function isClusterGovernanceSignal(v: unknown): v is ClusterGovernanceSignal {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (!Array.isArray(r.nodes)) return false;
  for (const node of r.nodes as unknown[]) {
    if (!node || typeof node !== "object") return false;
    if (typeof (node as Record<string, unknown>).host !== "string") return false;
  }
  return true;
}

export function decodeClusterGovernanceFrame(data: string): ClusterGovernanceSignal | null {
  try {
    const parsed = JSON.parse(data);
    return isClusterGovernanceSignal(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Human-friendly age label for a governance snapshot. */
export function governanceAgeLabel(ageMs: number | null): string {
  if (ageMs === null) return "—";
  if (ageMs < 1_000) return "just now";
  const secs = Math.floor(ageMs / 1_000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

/** True when the governance report should be marked stale. */
export function isGovernanceStale(status: ClusterGovernanceNode["status"]): boolean {
  return status !== "live";
}
