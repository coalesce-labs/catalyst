// governance-strip-kit.ts — CTL-1104 Phase 3. Pure helpers for GovernanceModesStrip.
// All label/stale/tone logic lives here; the strip component is a thin skin.
// Mirrors service-health-kit.ts separation pattern.

import {
  governanceAgeLabel,
  isGovernanceStale,
  type ClusterGovernanceNode,
  type GovernanceSnapshotModes,
} from "@/lib/governance-model";

/** The per-row data the strip component consumes. */
export interface GovernanceRow {
  host: string;
  modes: GovernanceSnapshotModes | null;
  ageLabel: string;
  stale: boolean;
}

/**
 * buildGovernanceRows — project ClusterGovernanceNode[] into strip rows.
 * Preserves roster order (stable per-host rendering).
 */
export function buildGovernanceRows(nodes: ClusterGovernanceNode[]): GovernanceRow[] {
  return nodes.map((n) => ({
    host: n.host,
    modes: n.governance as GovernanceSnapshotModes | null,
    ageLabel: governanceAgeLabel(n.ageMs),
    stale: isGovernanceStale(n.status),
  }));
}
