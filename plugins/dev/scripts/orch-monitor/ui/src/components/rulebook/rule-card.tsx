// rule-card.tsx — CTL-1103 / CTL-1320: one rule, shown in the perspective chosen
// by the single hoisted PerspectiveToggle (Plain English | Datalog | SQL). The
// per-card Tabs strip is gone — all 17 cards render the same lens, driven by
// perspectiveAtom — so the page reads as a calm column, not 17 repeating toolbars.
// The stratum-colored left accent is a thin tick, not a heavy 4px bar.
import type { ReactNode } from "react";
import { useAtomValue } from "jotai";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ruleCardTabs } from "./rule-card-model";
import { severityTone } from "@/lib/rulebook-model";
import { stratumColorForId } from "./strata-ladder";
import { perspectiveAtom } from "./perspective-toggle";
import type { RuleManifestRule } from "@/lib/rulebook-model";

function CodeBlock({ content }: { content: string | null }) {
  return (
    <pre className="rounded bg-muted px-3 py-2 text-[11px] font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap">
      {content}
    </pre>
  );
}

export function RuleCard({
  rule,
  liveSlot,
}: {
  rule: RuleManifestRule;
  liveSlot?: ReactNode;
}) {
  const perspective = useAtomValue(perspectiveAtom);
  const tabs = ruleCardTabs(rule); // [Plain English, Datalog, SQL]
  const sevClass = severityTone(rule.severity);
  const stratumColor = stratumColorForId(rule.stratum); // CSS var e.g. "var(--chart-1)"

  return (
    <div
      id={`rule-${rule.rule_id}`}
      className={cn("rounded-lg border bg-card mb-3 overflow-hidden border-l-2")}
      style={{ borderLeftColor: stratumColor }}
    >
      {/* Header */}
      <div className="flex items-start gap-3 px-4 pt-3 pb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs text-muted-foreground shrink-0">
              {rule.rule_id}
            </span>
            <span className="font-medium text-sm truncate">{rule.name}</span>
            {rule.extern && (
              <Badge variant="outline" className="text-[10px] h-4 px-1 shrink-0">
                extern
              </Badge>
            )}
            {rule.severity && (
              <span className={cn("text-xs font-medium shrink-0", sevClass)}>
                {rule.severity}
              </span>
            )}
          </div>
          {rule.feeds.length > 0 && (
            <div className="mt-1 flex items-center gap-1 flex-wrap">
              <span className="text-[10px] text-muted-foreground">feeds:</span>
              {rule.feeds.map((f) => (
                <a
                  key={f}
                  href={`#rule-${f}`}
                  className="text-[10px] font-mono text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {f}
                </a>
              ))}
            </div>
          )}
          {rule.cfg_keys.length > 0 && (
            <div className="mt-0.5 flex items-center gap-1 flex-wrap">
              <span className="text-[10px] text-muted-foreground">cfg:</span>
              {rule.cfg_keys.map((k) => (
                <a
                  key={k}
                  href={`#cfg-${k}`}
                  className="text-[10px] font-mono text-muted-foreground hover:underline"
                >
                  {k}
                </a>
              ))}
            </div>
          )}
        </div>
        {/* Phase 4 live indicator slot */}
        {liveSlot && <div className="shrink-0">{liveSlot}</div>}
      </div>

      {/* Body — the single active perspective (driven by the hoisted toggle) */}
      <div className="px-4 pb-3">
        {perspective === "english" && (
          <p className="text-sm leading-relaxed text-foreground">
            {tabs[0].content ?? "No description available."}
          </p>
        )}
        {perspective === "datalog" &&
          (tabs[1].isExtern ? (
            <p className="text-xs text-muted-foreground italic">
              This rule embeds hand-authored SQL (an <em>extern</em> block) — no
              Datalog source is compiled for it.
            </p>
          ) : (
            <CodeBlock content={tabs[1].content} />
          ))}
        {perspective === "sql" && (
          <CodeBlock content={tabs[2].content ?? "-- SQL unavailable"} />
        )}
      </div>
    </div>
  );
}
