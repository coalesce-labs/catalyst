// stratum-lane.tsx — CTL-1328: one stratum as a horizontal swim-lane. The sticky
// left label IS the merged description (number dot + plain headline + plain body
// + technical subtext + rule count) — there is no separate ladder-of-reasoning
// ToC. The label stays pinned while the rule cards (in evaluation order, left to
// right) scroll horizontally past it.
import { strataTone } from "@/lib/rulebook-theme";
import { laneSubtext } from "@/lib/rulebook-board-model";
import type { StratumGroup } from "@/lib/rulebook-model";
import { RuleCard } from "./rule-card";

export function StratumLane({
  group,
  nameById,
  firingCounts,
  onOpenRule,
}: {
  group: StratumGroup;
  nameById: Map<string, string>;
  firingCounts: Map<string, number>;
  onOpenRule: (ruleId: string) => void;
}) {
  const { stratum, rules } = group;
  const color = strataTone(stratum.id);

  return (
    <div className="flex items-stretch overflow-x-auto border-t first:border-t-0">
      {/* Sticky merged label — pinned while the cards scroll. */}
      <div className="sticky left-0 z-[5] w-[252px] shrink-0 border-r bg-background px-4 py-4">
        <div className="flex items-center gap-2">
          <span
            className="grid size-[22px] shrink-0 place-items-center rounded-full text-[11px] font-bold text-background"
            style={{ backgroundColor: color }}
            aria-hidden
          >
            {stratum.id}
          </span>
          <span className="text-[14px] font-semibold leading-tight">
            {stratum.plain_headline}
          </span>
        </div>
        <p className="mt-2 text-[12px] leading-snug text-muted-foreground">
          {stratum.plain_body}
        </p>
        <p className="mt-2 font-mono text-[10.5px] leading-snug text-muted-foreground/60">
          {laneSubtext(stratum, rules.length)}
        </p>
        {/* soft right fade so a scrolling card slides under the label cleanly */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 -right-3 w-3 bg-gradient-to-r from-background to-transparent"
        />
      </div>

      {/* Rule cards in evaluation order. */}
      <div className="flex gap-3 px-4 py-4">
        {rules.map((rule) => (
          <RuleCard
            key={rule.rule_id}
            rule={rule}
            nameById={nameById}
            firingCount={firingCounts.get(rule.rule_id) ?? 0}
            onOpen={onOpenRule}
          />
        ))}
      </div>
    </div>
  );
}
