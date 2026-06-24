// rulebook-surface.tsx — CTL-1328: the Belief Engine Rulebook as a swim-lane
// board (pass-2 of the redesign; v1 was the calm prose textbook, CTL-1320). Six
// stratum lanes stack S6 (decisions) at the top down to S1 (raw facts) at the
// bottom, with a layer-cake rail on the left. Each lane's sticky label IS its
// merged description; the rule cards scroll horizontally and open a source
// drawer on click. Live firing counts come from useBeliefsContext() (the
// already-open shared SSE — zero new EventSources, SSE dedup contract CTL-945).
import { useEffect, useMemo, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight, Activity } from "lucide-react";
import { useBeliefsContext } from "@/hooks/use-beliefs";
import {
  fetchRuleManifest,
  groupRulesByStratum,
  type RuleManifest,
  type RuleManifestRule,
  type RuleManifestStratum,
  type StratumGroup,
} from "@/lib/rulebook-model";
import {
  buildNameById,
  buildRuleIndex,
  toDisplayLanes,
  type DisplayLane,
} from "@/lib/rulebook-board-model";
import { strataTone } from "@/lib/rulebook-theme";
import { countFiringByRule, subjectsForRule } from "@/lib/rulebook-live";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SeverityPill } from "./severity-pill";
import { StratumLane } from "./stratum-lane";
import { RuleDrawer } from "./rule-drawer";
import { RuleInbox } from "./rule-inbox";
import { ThresholdsAppendix } from "./thresholds-appendix";

/** The vertical spine — its gradient is built from the LANE colours in display
 *  order (top → bottom), so it stays consistent with the lane dots after the
 *  importance reorder (escalations on top → raw facts at the bottom). */
function CakeRail({ lanes }: { lanes: DisplayLane[] }) {
  const stops = lanes.map((l) => strataTone(l.stratum.id)).join(", ");
  return (
    <div className="relative w-[46px] shrink-0 border-r">
      <div
        aria-hidden
        className="absolute left-1/2 top-2 bottom-2 w-[3px] -translate-x-1/2 rounded-full opacity-60"
        style={{ background: `linear-gradient(to bottom, ${stops})` }}
      />
      <span className="absolute left-0 top-2 [writing-mode:vertical-rl] text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
        escalations ↑
      </span>
      <span className="absolute bottom-2 left-0 [writing-mode:vertical-rl] text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
        raw facts
      </span>
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <SeverityPill severity="info" /> a plain fact
      </span>
      <span className="flex items-center gap-1.5">
        <SeverityPill severity="warn" /> needs watching
      </span>
      <span className="flex items-center gap-1.5">
        <SeverityPill severity="error" /> needs action
      </span>
      <span className="text-muted-foreground/40">·</span>
      <span>
        <span className="rounded border bg-muted/40 px-1.5 py-px text-[10px]">
          <span className="text-muted-foreground/50">→</span> name
        </span>{" "}
        the next belief this rule feeds
      </span>
    </div>
  );
}

function HowItWorks() {
  return (
    <Collapsible className="rounded-lg border bg-card/40">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-sm">
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span>
          How the rules work{" "}
          <span className="text-muted-foreground">(the Datalog model)</span>
        </span>
        <span className="ml-auto font-mono text-xs text-muted-foreground/70">
          17 rules · rules.dl
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {/* The approved mockup's bespoke calm copy (not the manifest's generic
            datalog_primer): it carries the within-layer-honesty example
            (lease_expired only fires when lease_valid did not) the redesign
            specifically called for. */}
        <p className="rulebook-prose px-4 pb-4 text-[14px] leading-relaxed text-muted-foreground">
          Each rule reads beliefs it already trusts and writes a new, named
          belief. Every tick, the engine evaluates the rules in a fixed order —
          the six <em>strata</em> from the bottom up, and the rules in order
          within each stratum — so a rule never depends on anything computed
          later in the same tick. Most rules build on the layers beneath them; a
          few also build on an earlier rule in their own layer (for example,{" "}
          <em>lease_expired</em> fires only when <em>lease_valid</em> did not).
          That fixed order is what keeps every conclusion finite and traceable —
          open any belief in the live view to see exactly which facts triggered
          which rule.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-20 rounded-lg bg-muted" />
      ))}
    </div>
  );
}

// The swim-lane board view (CTL-1328): the reading prose in a calm capped
// column, the full-bleed layer-cake board, then the supporting collapsibles.
// The page title now lives in the shared header bar (RulebookSurface), so the
// board header leads with the subtitle + the layer explanation.
function BoardView({
  lanes,
  nameById,
  firingCounts,
  onOpenRule,
}: {
  lanes: DisplayLane[];
  nameById: Map<string, string>;
  firingCounts: Map<string, number>;
  onOpenRule: (ruleId: string) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto py-8">
      <div className="px-6">
        <header className="mb-6 max-w-[80ch]">
          <p className="text-sm text-muted-foreground">
            How the daemon decides who&apos;s working, who&apos;s wedged, and when
            to call a human.
          </p>
          <p className="rulebook-prose mt-4 max-w-[74ch] text-[15px] leading-relaxed text-foreground/80">
            Every few seconds — once per tick — the daemon reasons from{" "}
            <em>what it can see</em> up to <em>what to do about it</em>. It works
            in six layers: raw observations enter at the base and rise into
            decisions. The engine evaluates them in a fixed order — layer by
            layer, and rule by rule within each layer — so every rule already
            sees whatever it builds on, whether that&apos;s a layer beneath it or
            an earlier rule in its own layer. Read each lane as one layer; the
            cards inside are the rules that fire there.{" "}
            <span className="text-muted-foreground">
              Click any rule to read its source.
            </span>
          </p>
          <Legend />
        </header>
      </div>

      {/* Full-bleed board — edge to edge (CTL-1328). border-y only, no side cap,
          so the lanes can use the whole viewport width; the reading prose above
          and below stays in the capped px-6 column. */}
      <div className="flex items-stretch overflow-hidden border-y bg-card/40">
        <CakeRail lanes={lanes} />
        <div className="min-w-0 flex-1">
          {lanes.map((group) => (
            <StratumLane
              key={group.key}
              group={group}
              nameById={nameById}
              firingCounts={firingCounts}
              onOpenRule={onOpenRule}
            />
          ))}
        </div>
      </div>

      {/* Supporting collapsibles read in the calm narrow column. */}
      <div className="mt-7 max-w-[74ch] px-6">
        <HowItWorks />
        <ThresholdsAppendix />
      </div>
    </div>
  );
}

// Monitor (coming soon): the live-beliefs lens — what the engine currently holds
// true, with provenance, and (later) tick-by-tick rewind. The live belief store
// already streams (useBeliefsContext / countFiringByRule), so this is the
// placeholder until that view is built. Shows the current firing count as a teaser.
function BeliefsMonitorStub({ firingRuleCount }: { firingRuleCount: number }) {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-10">
      <div className="max-w-[52ch] text-center">
        <div className="mx-auto mb-4 grid size-10 place-items-center rounded-full bg-muted/50 text-muted-foreground">
          <Activity className="size-5" />
        </div>
        <h2 className="rulebook-prose text-lg font-semibold">Monitor</h2>
        <p className="mt-1 text-sm text-muted-foreground">Coming soon</p>
        <p className="rulebook-prose mt-4 text-[14px] leading-relaxed text-muted-foreground">
          A live view of the beliefs the engine currently holds — what&apos;s
          firing right now, the facts that triggered each one, and eventually a
          tick-by-tick rewind to replay how the picture changed.
        </p>
        <p className="mt-4 text-xs text-muted-foreground/70">
          {firingRuleCount > 0
            ? `${firingRuleCount} rule${firingRuleCount === 1 ? "" : "s"} firing right now.`
            : "No rules firing right now."}
        </p>
      </div>
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
  // CTL-1328 (Beliefs IA): Overview (the swim-lane board — orientation/teaching)
  // · Browse (grouped list + detail page — the reference) · Monitor (live beliefs
  // — coming soon). Browse is the default reference view.
  const [view, setView] = useState<"overview" | "browse" | "monitor">("browse");

  useEffect(() => {
    let alive = true;
    fetchRuleManifest()
      .then((m) => {
        if (!alive) return;
        setManifest(m);
        setGroups(groupRulesByStratum(m));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Failed to load manifest");
      });
    return () => {
      alive = false;
    };
  }, []);

  const nameById = useMemo(
    () => buildNameById(manifest?.rules ?? []),
    [manifest],
  );
  // id+name → rule, so the drawer can resolve a relation target (feeds carry
  // ids, reads/negates carry names) to a clickable, hover-previewable link.
  const ruleIndex = useMemo(
    () => buildRuleIndex(manifest?.rules ?? []),
    [manifest],
  );
  const lanes = useMemo(() => toDisplayLanes(groups), [groups]);

  const selectedRule: RuleManifestRule | null =
    selectedRuleId && manifest
      ? (manifest.rules.find((r) => r.rule_id === selectedRuleId) ?? null)
      : null;
  const selectedStratum: RuleManifestStratum | null =
    selectedRule && manifest
      ? (manifest.strata.find((s) => s.id === selectedRule.stratum) ?? null)
      : null;

  if (error) {
    return (
      <div className="p-6 text-sm text-destructive">
        Could not load rulebook: {error}
      </div>
    );
  }

  // The selected rule's live firing subjects — shared by the board drawer and
  // the inbox detail pane.
  const firingSubjects = selectedRule
    ? subjectsForRule(beliefs.store, selectedRule.rule_id)
    : [];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Shared header bar: the section title + the Overview · Browse · Monitor
          sub-nav (the three lenses on the belief domain). */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-6 py-3">
        <h1 className="rulebook-prose text-base font-semibold tracking-tight">
          Agent Beliefs
        </h1>
        <ToggleGroup
          type="single"
          size="sm"
          value={view}
          // A single-select toggle returns "" when the active item is
          // re-clicked; ignore that so a view is always selected.
          onValueChange={(v) =>
            v && setView(v as "overview" | "browse" | "monitor")
          }
          className="ml-auto"
        >
          <ToggleGroupItem value="overview" className="px-3 text-xs">
            Overview
          </ToggleGroupItem>
          <ToggleGroupItem value="browse" className="px-3 text-xs">
            Browse
          </ToggleGroupItem>
          <ToggleGroupItem value="monitor" className="px-3 text-xs">
            Monitor
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {manifest === null ? (
        <div className="flex-1 overflow-y-auto px-6 py-8">
          <LoadingSkeleton />
        </div>
      ) : view === "browse" ? (
        <RuleInbox
          lanes={lanes}
          firingCounts={firingCounts}
          ruleIndex={ruleIndex}
          selectedRule={selectedRule}
          selectedStratum={selectedStratum}
          selectedRuleId={selectedRuleId}
          firingSubjects={firingSubjects}
          onSelectRule={setSelectedRuleId}
          onClear={() => setSelectedRuleId(null)}
        />
      ) : view === "monitor" ? (
        <BeliefsMonitorStub firingRuleCount={firingCounts.size} />
      ) : (
        <BoardView
          lanes={lanes}
          nameById={nameById}
          firingCounts={firingCounts}
          onOpenRule={setSelectedRuleId}
        />
      )}

      {/* Sheet drawer — OVERVIEW (board) only. Browse renders the detail in its
          right pane (wide) or a full-width push (narrow); Monitor has none yet. */}
      <RuleDrawer
        rule={selectedRule}
        stratum={selectedStratum}
        ruleIndex={ruleIndex}
        onSelectRule={setSelectedRuleId}
        firingSubjects={firingSubjects}
        open={selectedRule !== null && view === "overview"}
        onOpenChange={(o) => {
          if (!o) setSelectedRuleId(null);
        }}
      />
    </div>
  );
}
