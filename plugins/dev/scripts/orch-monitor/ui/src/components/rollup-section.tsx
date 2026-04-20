import { useMemo } from "react";
import { SectionLabel } from "./ui/panel";
import { renderBriefingHtml } from "@/lib/briefings";
import type { RollupBriefing } from "@/lib/types";

interface RollupSectionProps {
  rollup: RollupBriefing;
}

export function RollupSection({ rollup }: RollupSectionProps) {
  const gotchasHtml = useMemo(
    () => (rollup.gotchas ? renderBriefingHtml(rollup.gotchas) : ""),
    [rollup.gotchas],
  );
  const whatToSeeHtml = useMemo(
    () => (rollup.whatToSee ? renderBriefingHtml(rollup.whatToSee) : ""),
    [rollup.whatToSee],
  );

  const generatedAt = new Date(rollup.generatedAt);
  const generatedLabel = Number.isFinite(generatedAt.getTime())
    ? generatedAt.toLocaleString()
    : rollup.generatedAt;

  return (
    <section className="px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <SectionLabel>Orchestrator rollup</SectionLabel>
        <span className="text-[11px] text-muted">
          {rollup.generatedBy} · {generatedLabel}
        </span>
      </div>

      {rollup.whatShipped.length > 0 && (
        <div className="mb-4">
          <div className="mb-2">
            <SectionLabel>What shipped</SectionLabel>
          </div>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {rollup.whatShipped.map((item) => (
              <li key={item.ticket} className="flex gap-2">
                <span className="font-mono font-semibold text-fg">
                  {item.ticket}
                </span>
                {typeof item.pr === "number" && (
                  <span className="font-mono text-muted">#{item.pr}</span>
                )}
                <span className="text-fg">{item.title}</span>
                {item.oneliner && (
                  <span className="truncate text-muted">— {item.oneliner}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {whatToSeeHtml && (
        <div className="mb-4">
          <div className="mb-2">
            <SectionLabel>What to see</SectionLabel>
          </div>
          <div
            className="md-content"
            dangerouslySetInnerHTML={{ __html: whatToSeeHtml }}
          />
        </div>
      )}

      {gotchasHtml && (
        <div>
          <div className="mb-2">
            <SectionLabel>Gotchas</SectionLabel>
          </div>
          <div
            className="md-content"
            dangerouslySetInnerHTML={{ __html: gotchasHtml }}
          />
        </div>
      )}
    </section>
  );
}
