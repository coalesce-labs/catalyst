// capacity-badges.ts — CTL-764 Phase 8: pure buildCapacityBadges helper.
// Reads optional per-disposition counts from BoardConfig and returns an ordered
// badge array (zero counts omitted). No React, no DOM — purely unit-tested.

export interface CapacityBadge {
  label: string;
  count: number;
  legend?: string;
}

interface MinimalBoardConfig {
  triage?: number;
  queued?: number;
  blocked?: number;
  needsInput?: number;
  needsHuman?: number;
}

/**
 * Build the capacity badge array for the slot-deck header.
 * Fixed order: triage · queued · blocked · needs-input · needs-human.
 * Zero-count badges are omitted. The triage badge carries a legend.
 */
export function buildCapacityBadges(config: MinimalBoardConfig): CapacityBadge[] {
  const SLOTS: Array<{ key: keyof MinimalBoardConfig; label: string; legend?: string }> = [
    { key: "triage", label: "triage", legend: "triage is intake — not counted against maxParallel" },
    { key: "queued", label: "queued" },
    { key: "blocked", label: "blocked" },
    { key: "needsInput", label: "needs-input" },
    { key: "needsHuman", label: "needs-human" },
  ];
  const badges: CapacityBadge[] = [];
  for (const s of SLOTS) {
    const count = config[s.key] ?? 0;
    if (count > 0) {
      const b: CapacityBadge = { label: s.label, count };
      if (s.legend) b.legend = s.legend;
      badges.push(b);
    }
  }
  return badges;
}
