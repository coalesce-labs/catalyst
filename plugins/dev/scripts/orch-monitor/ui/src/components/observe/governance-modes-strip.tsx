// governance-modes-strip.tsx — CTL-1104 Phase 3. Fleet Ops GOVERNANCE strip.
// Full-width shrink-0 block (NOT inside the grid wrapper — ChartCard flex-collapse
// rule, fleetops-surface.tsx:186-187). One row per roster host: host name +
// GovernanceFlagsChip (data-driven) + age label + stale marker.
// Degrades to honest grey "governance status unavailable" when nodes is null
// or unavailable — never fabricates a green state.

import { Panel, PanelHeader, SectionLabel } from "@/components/ui/panel";
import { GovernanceFlagsChip } from "@/components/governance/governance-flags-chip";
import { buildGovernanceRows } from "@/components/observe/governance-strip-kit";
import type { ClusterGovernanceNode } from "@/lib/governance-model";

export interface GovernanceModesStripProps {
  nodes: ClusterGovernanceNode[] | null;
  unavailable: boolean;
  now: number;
}

export function GovernanceModesStrip({ nodes, unavailable }: GovernanceModesStripProps) {
  const rows = nodes !== null ? buildGovernanceRows(nodes) : [];

  return (
    <Panel className="shrink-0">
      <PanelHeader className="flex items-center justify-between gap-2">
        <SectionLabel>Governance</SectionLabel>
        <span className="font-mono text-[10px] tracking-wide text-muted/70">
          [heartbeat]
        </span>
      </PanelHeader>
      <div className="p-2">
        {unavailable || nodes === null ? (
          <div className="px-1 py-1 text-[12px] text-muted">
            governance status unavailable
          </div>
        ) : (
          <div className="flex flex-col gap-2 px-1 py-1">
            {rows.map((row) => (
              <div key={row.host} className="flex items-start gap-3">
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground/80 pt-0.5 min-w-[120px]">
                  {row.host}
                </span>
                <GovernanceFlagsChip
                  snapshot={row.modes}
                  reportedAtLabel={row.ageLabel}
                  stale={row.stale}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
