// rulebook-surface.tsx — CTL-1103 Phase 3: full static textbook surface.
// Renders preface → strata ladder → per-stratum rule cards → thresholds.
// Data: one /api/beliefs/rules fetch; no dependence on belief recording.
// SSE dedup contract: use useBeliefsContext(), NEVER useBeliefs().
import { useEffect, useState } from "react";
import { useBeliefsContext } from "@/hooks/use-beliefs";
import {
  fetchRuleManifest,
  groupRulesByStratum,
  type RuleManifest,
  type StratumGroup,
} from "@/lib/rulebook-model";
import { PrefaceSection } from "./preface-section";
import { StrataLadder, stratumColorForId } from "./strata-ladder";
import { RuleCard } from "./rule-card";
import { ThresholdsAppendix } from "./thresholds-appendix";
import { cn } from "@/lib/utils";

function StratumSection({ group }: { group: StratumGroup }) {
  const colorClass = stratumColorForId(group.stratum.id);
  const borderClass = colorClass.split(" ")[0]; // border-* token only
  return (
    <section id={`stratum-${group.stratum.id}`} className="mb-8">
      <div
        className={cn(
          "flex items-baseline gap-2 mb-3 pb-2 border-b-2",
          borderClass,
        )}
      >
        <span className="font-mono text-xs text-muted-foreground">
          S{group.stratum.id}
        </span>
        <h3 className="text-sm font-semibold">{group.stratum.label}</h3>
        <span className="text-xs text-muted-foreground hidden sm:inline">
          — {group.stratum.prose}
        </span>
      </div>
      {group.rules.map((rule) => (
        <RuleCard key={rule.rule_id} rule={rule} />
      ))}
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
  useBeliefsContext(); // dedup contract: consume context, never useBeliefs()

  const [manifest, setManifest] = useState<RuleManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<StratumGroup[]>([]);

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

  if (error) {
    return (
      <div className="p-6 text-sm text-destructive">
        Could not load rulebook: {error}
      </div>
    );
  }

  return (
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
              <StratumSection key={group.stratum.id} group={group} />
            ))}

            <ThresholdsAppendix />
          </>
        )}
      </div>
    </div>
  );
}
