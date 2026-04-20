import { useMemo } from "react";
import { SectionLabel } from "./ui/panel";
import { collectBriefings, renderBriefingHtml } from "@/lib/briefings";
import { RollupSection } from "./rollup-section";
import type { OrchestratorState } from "@/lib/types";

interface BriefingTabProps {
  orch: OrchestratorState;
}

export function BriefingTab({ orch }: BriefingTabProps) {
  const entries = useMemo(() => collectBriefings(orch), [orch]);
  const rollup = orch.rollupBriefing;

  if (entries.length === 0 && !rollup) {
    return (
      <div className="px-4 py-6 text-[12px] text-muted">No briefings.</div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border">
      {rollup && <RollupSection rollup={rollup} />}
      {entries.map((entry) => (
        <BriefingSection
          key={entry.wave}
          wave={entry.wave}
          body={entry.body}
        />
      ))}
    </div>
  );
}

function BriefingSection({ wave, body }: { wave: number; body: string }) {
  const html = useMemo(() => renderBriefingHtml(body), [body]);
  return (
    <section className="px-4 py-4">
      <div className="mb-3">
        <SectionLabel>Wave {wave} briefing</SectionLabel>
      </div>
      <div className="md-content" dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  );
}
