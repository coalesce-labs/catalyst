// rule-card.tsx — CTL-1103 Phase 3+5: tri-lingual card (Plain English | Datalog | SQL).
// Border color uses strataTone() CSS variable; severity chip uses severityTone()
// CSS class; both are distinct from liveIndicatorTone() (Phase 5 contract).
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { ruleCardTabs } from "./rule-card-model";
import { severityTone } from "@/lib/rulebook-model";
import { stratumColorForId } from "./strata-ladder";
import type { RuleManifestRule } from "@/lib/rulebook-model";

export function RuleCard({
  rule,
  liveSlot,
}: {
  rule: RuleManifestRule;
  liveSlot?: React.ReactNode;
}) {
  const [tab, setTab] = useState<string>("english");
  const tabs = ruleCardTabs(rule);
  const sevClass = severityTone(rule.severity);
  const stratumColor = stratumColorForId(rule.stratum); // CSS var e.g. "var(--chart-1)"

  return (
    <div
      id={`rule-${rule.rule_id}`}
      className={cn("rounded-lg border bg-card mb-4 overflow-hidden border-l-4")}
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

      {/* Tri-lingual tabs */}
      <Tabs value={tab} onValueChange={setTab} className="px-4 pb-3">
        <TabsList className="h-7 mb-2">
          <TabsTrigger value="english" className="text-[11px] px-2">
            Plain English
          </TabsTrigger>
          <TabsTrigger value="datalog" className="text-[11px] px-2">
            Datalog
          </TabsTrigger>
          <TabsTrigger value="sql" className="text-[11px] px-2">
            SQL
          </TabsTrigger>
        </TabsList>

        <TabsContent value="english" className="mt-0">
          <p className="text-sm leading-relaxed text-foreground">
            {tabs[0].content ?? "No description available."}
          </p>
        </TabsContent>

        <TabsContent value="datalog" className="mt-0">
          {tabs[1].isExtern ? (
            <p className="text-xs text-muted-foreground italic">
              This rule embeds hand-authored SQL (an <em>extern</em> block) — no
              Datalog source is compiled for it.
            </p>
          ) : (
            <pre className="rounded bg-muted px-3 py-2 text-[11px] font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap">
              {tabs[1].content}
            </pre>
          )}
        </TabsContent>

        <TabsContent value="sql" className="mt-0">
          <pre className="rounded bg-muted px-3 py-2 text-[11px] font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap">
            {tabs[2].content ?? "-- SQL unavailable"}
          </pre>
        </TabsContent>
      </Tabs>
    </div>
  );
}
