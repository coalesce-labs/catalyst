// rulebook-surface.tsx — CTL-1103 Phase 3+4: full static textbook + live margins.
// Renders preface → strata ladder → per-stratum rule cards → thresholds.
// Live firing counts come from useBeliefsContext() (the already-open shared SSE
// — zero new EventSources, SSE dedup contract CTL-945).
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
import { StrataLadder, stratumColorForId } from "./strata-ladder";
import { RuleCard } from "./rule-card";
import { LiveIndicator } from "./live-indicator";
import { DerivationsRail } from "./derivations-rail";
import { ThresholdsAppendix } from "./thresholds-appendix";
import { cn } from "@/lib/utils";
import type { RuleManifestRule } from "@/lib/rulebook-model";

function StratumSection({
  group,
  firingCounts,
  selectedRuleId,
  onSelectRule,
}: {
  group: StratumGroup;
  firingCounts: Map<string, number>;
  selectedRuleId: string | null;
  onSelectRule: (id: string) => void;
}) {
  const color = stratumColorForId(group.stratum.id); // CSS var e.g. "var(--chart-1)"
  return (
    <section id={`stratum-${group.stratum.id}`} className="mb-8">
      <div
        className={cn("flex items-baseline gap-2 mb-3 pb-2 border-b-2")}
        style={{ borderBottomColor: color }}
      >
        <span className="font-mono text-xs text-muted-foreground">
          S{group.stratum.id}
        </span>
        <h3 className="text-sm font-semibold">{group.stratum.label}</h3>
        <span className="text-xs text-muted-foreground hidden sm:inline">
          — {group.stratum.prose}
        </span>
      </div>
      {group.rules.map((rule) => {
        const count = firingCounts.get(rule.rule_id) ?? 0;
        // CTL-1103 remediate: selection is scoped to the LiveIndicator badge (the
        // dedicated header affordance) rather than wrapping the whole card in a
        // <button>. That wrapper nested the card's Tabs buttons + feed/cfg anchors
        // inside a button (invalid HTML) and let tab/anchor clicks bubble out as
        // unintended rule selections. The badge only renders when count > 0, so
        // selection stays gated on a firing rule exactly as before.
        return (
          <div key={rule.rule_id}>
            <RuleCard
              rule={rule}
              liveSlot={
                <LiveIndicator
                  count={count}
                  onSelect={
                    count > 0 ? () => onSelectRule(rule.rule_id) : undefined
                  }
                />
              }
            />
          </div>
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
      {/* Main textbook column */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <div className="mb-6">
            <h1 className="text-xl font-bold">Belief Engine Rulebook</h1>
            <p className="text-sm text-muted-foreground mt-1">
              17 rules · 6 strata · compiled from{" "}
              <span className="font-mono">beliefs/rules.dl</span>
            </p>
          </div>

          {manifest === null ? (
            <LoadingSkeleton />
          ) : (
            <>
              <PrefaceSection preface={manifest.preface} />
              <StrataLadder groups={groups} />

              {groups.map((group) => (
                <StratumSection
                  key={group.stratum.id}
                  group={group}
                  firingCounts={firingCounts}
                  selectedRuleId={selectedRuleId}
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
