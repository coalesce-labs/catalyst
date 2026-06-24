// rule-card.tsx — CTL-1328: the compact board card. One rule on a swim-lane:
// id + name + severity pill + a plain-English one-liner + quiet feeds/cfg chips,
// with a thin stratum-coloured left tick. The whole card is a button — clicking
// it opens the source drawer (description, relations, and the Plain English |
// Datalog | SQL toggle). A live firing badge shows when the rule is firing now.
import { cn } from "@/lib/utils";
import { strataTone } from "@/lib/rulebook-theme";
import { feedNames } from "@/lib/rulebook-board-model";
import type { RuleManifestRule } from "@/lib/rulebook-model";
import { SeverityPill } from "./severity-pill";
import { RuleChip } from "./rule-chip";
import { LiveIndicator } from "./live-indicator";

export function RuleCard({
  rule,
  nameById,
  firingCount,
  onOpen,
}: {
  rule: RuleManifestRule;
  nameById: Map<string, string>;
  firingCount: number;
  onOpen: (ruleId: string) => void;
}) {
  const feeds = feedNames(rule, nameById);

  return (
    <button
      type="button"
      onClick={() => onOpen(rule.rule_id)}
      aria-label={`${rule.name} (${rule.rule_id}) — open source`}
      className={cn(
        "group flex w-[248px] shrink-0 flex-col rounded-lg border border-l-2 bg-card p-3 text-left",
        "transition hover:-translate-y-px hover:border-ring/40 hover:bg-accent/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
      style={{ borderLeftColor: strataTone(rule.stratum) }}
    >
      {/* flex-wrap (not truncate) so a long rule name + the live badge wrap
          rather than clipping the primary identifier — matches the mockup. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">
          {rule.rule_id}
        </span>
        <span className="text-[13px] font-medium">{rule.name}</span>
        <SeverityPill severity={rule.severity} />
        {firingCount > 0 && (
          <LiveIndicator count={firingCount} className="ml-auto shrink-0" />
        )}
      </div>

      <p className="rulebook-prose mt-1.5 line-clamp-4 text-[12.5px] leading-snug text-foreground/80">
        {rule.description}
      </p>

      {feeds.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="text-[9.5px] uppercase tracking-wide text-muted-foreground/70">
            feeds
          </span>
          {feeds.map((name) => (
            <RuleChip key={name} arrow="→" label={name} />
          ))}
        </div>
      )}

      {rule.cfg_keys.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-[9.5px] uppercase tracking-wide text-muted-foreground/70">
            cfg
          </span>
          {rule.cfg_keys.map((k) => (
            <RuleChip key={k} label={k} mono />
          ))}
        </div>
      )}

      <span className="mt-2 text-[10px] text-transparent transition group-hover:text-muted-foreground">
        view source ›
      </span>
    </button>
  );
}
