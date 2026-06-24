// rule-card.tsx — CTL-1328: the compact board card. One rule on a swim-lane:
// id + name + severity pill, a Datalog mark + active-belief count on the right
// (the same Browse-list affordances), a plain-English one-liner, and aligned
// feeds/cfg rows. A thin stratum-coloured left tick. The whole card is a button —
// clicking it opens the source drawer.
import { Braces } from "lucide-react";
import { cn } from "@/lib/utils";
import { strataTone } from "@/lib/rulebook-theme";
import { feedNames, ruleHasDatalog } from "@/lib/rulebook-board-model";
import type { RuleManifestRule } from "@/lib/rulebook-model";
import { SeverityPill } from "./severity-pill";

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
  const hasDatalog = ruleHasDatalog(rule);

  return (
    <button
      type="button"
      onClick={() => onOpen(rule.rule_id)}
      aria-label={`${rule.name} (${rule.rule_id}) — open source`}
      className={cn(
        "group flex w-[280px] shrink-0 flex-col rounded-lg border border-l-2 bg-card p-3.5 text-left",
        "transition hover:-translate-y-px hover:border-ring/40 hover:bg-accent/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
      style={{ borderLeftColor: strataTone(rule.stratum) }}
    >
      <div className="flex items-start gap-2">
        <span className="font-mono text-[10px] leading-snug text-muted-foreground">
          {rule.rule_id}
        </span>
        <span className="text-[13px] font-medium leading-snug">{rule.name}</span>
        <SeverityPill severity={rule.severity} />
        {/* right markers — Datalog affordance + active-belief count (Browse parity) */}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pt-px">
          {hasDatalog && (
            <span title="Has compiled Datalog source" className="flex">
              <Braces
                className="size-3.5 text-muted-foreground/55"
                aria-label="Has Datalog"
              />
            </span>
          )}
          {firingCount > 0 && (
            <span
              title={`${firingCount} active belief${firingCount === 1 ? "" : "s"}`}
              className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground"
            >
              {firingCount}
            </span>
          )}
        </span>
      </div>

      <p className="rulebook-prose mt-1.5 line-clamp-4 text-[12.5px] leading-snug text-foreground/80">
        {rule.description}
      </p>

      {/* feeds / cfg as aligned label→value rows (higher contrast than the old
          faint chips, labels lined up in a column — CTL-1328 — Ryan). */}
      {(feeds.length > 0 || rule.cfg_keys.length > 0) && (
        <dl className="mt-2.5 grid grid-cols-[3rem_1fr] gap-x-2 gap-y-1 text-[11px]">
          {feeds.length > 0 && (
            <>
              <dt className="uppercase tracking-wide text-muted-foreground/55">
                feeds
              </dt>
              <dd className="flex flex-wrap gap-x-2 gap-y-0.5 text-foreground/75">
                {feeds.map((name) => (
                  <span key={name} className="inline-flex items-center gap-0.5">
                    <span className="text-muted-foreground/50">→</span>
                    {name}
                  </span>
                ))}
              </dd>
            </>
          )}
          {rule.cfg_keys.length > 0 && (
            <>
              <dt className="uppercase tracking-wide text-muted-foreground/55">
                cfg
              </dt>
              <dd className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-foreground/70">
                {rule.cfg_keys.map((k) => (
                  <span key={k}>{k}</span>
                ))}
              </dd>
            </>
          )}
        </dl>
      )}

      <span className="mt-2 text-[10px] text-transparent transition group-hover:text-muted-foreground">
        view source ›
      </span>
    </button>
  );
}
