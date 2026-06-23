// rulebook-surface.tsx — CTL-1103 / CTL-1320: the Belief Engine Rulebook as a
// calm prose textbook. One capped reading column: plain "why" → ladder of
// reasoning → per-stratum rule sections (one hoisted perspective toggle) →
// collapsed thresholds. Live firing counts come from useBeliefsContext() (the
// already-open shared SSE — zero new EventSources, SSE dedup contract CTL-945).
import { useEffect, useState } from "react";
import { useBeliefsContext } from "@/hooks/use-beliefs";
import {
  fetchRuleManifest,
  groupRulesByStratum,
  type RuleManifest,
  type StratumGroup,
} from "@/lib/rulebook-model";
import { countFiringByRule, subjectsForRule } from "@/lib/rulebook-live";
import { PrefaceSection } from "./preface-section";
import { LadderOfReasoning } from "./strata-ladder";
import { PerspectiveToggle } from "./perspective-toggle";
import { RuleCard } from "./rule-card";
import { LiveIndicator } from "./live-indicator";
import { DerivationsRail } from "./derivations-rail";
import { ThresholdsAppendix } from "./thresholds-appendix";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { RuleManifestRule } from "@/lib/rulebook-model";

/** "S1 ground correlations" → "ground correlations" (the redundant number prefix
 *  is rendered once, from the id, in the heading — never doubled). */
function techLabel(label: string): string {
  return label.replace(/^S\d+\s+/, "");
}

function StratumSection({
  group,
  firingCounts,
  onSelectRule,
}: {
  group: StratumGroup;
  firingCounts: Map<string, number>;
  onSelectRule: (id: string) => void;
}) {
  return (
    <section id={`stratum-${group.stratum.id}`} className="pt-8 scroll-mt-4">
      {/* The number appears exactly once, leading the plain headline. */}
      <h2 className="text-lg font-semibold">
        {group.stratum.id} · {group.stratum.plain_headline}
      </h2>
      <p className="mt-0.5 mb-4 font-mono text-xs text-muted-foreground/70">
        {techLabel(group.stratum.label)} · {group.stratum.prose}
      </p>
      {group.rules.map((rule) => {
        const count = firingCounts.get(rule.rule_id) ?? 0;
        return (
          <RuleCard
            key={rule.rule_id}
            rule={rule}
            liveSlot={
              <LiveIndicator
                count={count}
                onSelect={count > 0 ? () => onSelectRule(rule.rule_id) : undefined}
              />
            }
          />
        );
      })}
    </section>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-24 rounded-lg bg-muted" />
      ))}
    </div>
  );
}

export function RulebookSurface() {
  const beliefs = useBeliefsContext(); // dedup contract: never useBeliefs()
  const firingCounts = countFiringByRule(beliefs.store);

  const [manifest, setManifest] = useState<RuleManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<StratumGroup[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);

  useEffect(() => {
    fetchRuleManifest()
      .then((m) => {
        setManifest(m);
        setGroups(groupRulesByStratum(m));
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load manifest");
      });
  }, []);

  const selectedRule: RuleManifestRule | null =
    selectedRuleId && manifest
      ? (manifest.rules.find((r) => r.rule_id === selectedRuleId) ?? null)
      : null;

  if (error) {
    return (
      <div className="p-6 text-sm text-destructive">
        Could not load rulebook: {error}
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main reading column — capped measure, centered, calm. */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[72ch] px-6 py-10">
          <header className="mb-7">
            <h1 className="text-2xl font-bold tracking-tight">
              Belief Engine Rulebook
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              How the daemon decides who&apos;s working, who&apos;s wedged, and when
              to call a human.
            </p>
            {/* CTL-1320: Read / Map mode switch. The React Flow strata map is a
                deferred fast-follow (?view=map) — Map is disabled until it lands. */}
            <div className="mt-4">
              <ToggleGroup type="single" size="sm" value="read">
                <ToggleGroupItem value="read" className="px-3 text-xs">
                  Read
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="map"
                  disabled
                  title="Strata map — coming soon"
                  className="px-3 text-xs"
                >
                  Map
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </header>

          {manifest === null ? (
            <LoadingSkeleton />
          ) : (
            <>
              <PrefaceSection preface={manifest.preface} />
              <LadderOfReasoning groups={groups} />

              <PerspectiveToggle />

              {groups.map((group) => (
                <StratumSection
                  key={group.stratum.id}
                  group={group}
                  firingCounts={firingCounts}
                  onSelectRule={setSelectedRuleId}
                />
              ))}

              <ThresholdsAppendix />
            </>
          )}
        </div>
      </div>

      {/* Derivations rail — shown when a firing rule is selected */}
      {selectedRule && (
        <div className="w-80 shrink-0 border-l overflow-y-auto p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Derivations
            </span>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setSelectedRuleId(null)}
            >
              ×
            </button>
          </div>
          <DerivationsRail
            ruleId={selectedRule.rule_id}
            subjects={subjectsForRule(beliefs.store, selectedRule.rule_id)}
            onOpenSource={(ruleId) => {
              document
                .getElementById(`rule-${ruleId}`)
                ?.scrollIntoView({ behavior: "smooth" });
            }}
          />
        </div>
      )}
    </div>
  );
}
