// rule-inbox.tsx — CTL-1328 (pass-3 prototype): an inbox-style two-pane view of
// the rulebook, an alternative to the swim-lane board (toggled in
// rulebook-surface.tsx). Left rail: every rule as a scannable row, grouped by
// stratum (S6 decisions → S1 raw facts) with sticky group headers — the layer
// order the board renders as a cake, here as a calm grouped list. Right pane:
// the selected rule's detail (the SHARED RuleDetail, identical to the board
// drawer), so clicking a relation re-targets the pane in place. On a narrow
// screen the panes collapse to a single list; selecting a rule pushes the
// detail full-width with a Back affordance (the Gmail/Linear master-detail
// pattern Ryan asked for).
import { ChevronLeft, Braces } from "lucide-react";
import { cn } from "@/lib/utils";
import { strataTone } from "@/lib/rulebook-theme";
import { ruleHasDatalog, type DisplayLane } from "@/lib/rulebook-board-model";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useIsMobile } from "@/hooks/use-mobile";
import type {
  RuleManifestRule,
  RuleManifestStratum,
} from "@/lib/rulebook-model";
import { SeverityPill } from "./severity-pill";
import { RuleDetail, RuleDetailPage } from "./rule-drawer";

/** One rule as an inbox row — severity pill + name + id + a one-line plain
 *  English summary, with a live badge when firing. The selected row carries an
 *  accent left-border + tint (the Linear list-selection idiom). */
function InboxRow({
  rule,
  selected,
  firingCount,
  onSelect,
}: {
  rule: RuleManifestRule;
  selected: boolean;
  firingCount: number;
  onSelect: (ruleId: string) => void;
}) {
  const hasDatalog = ruleHasDatalog(rule);
  return (
    <button
      type="button"
      onClick={() => onSelect(rule.rule_id)}
      aria-current={selected ? "true" : undefined}
      aria-label={`${rule.name} (${rule.rule_id})`}
      className={cn(
        "flex w-full flex-col gap-1 border-l-2 px-4 py-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected
          ? "border-l-ring bg-accent/50"
          : "border-l-transparent hover:bg-accent/30",
      )}
    >
      <div className="flex items-start gap-2">
        <SeverityPill severity={rule.severity} />
        {/* name + id may wrap to a second line when long (the rail is roomy). */}
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span className="text-[13px] font-medium leading-snug">{rule.name}</span>
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {rule.rule_id}
          </span>
        </div>
        {/* right rail of the row: Datalog affordance + active-belief count. */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 pt-px">
          {hasDatalog && (
            <span title="Has compiled Datalog source" className="flex">
              <Braces className="size-3.5 text-muted-foreground/55" aria-label="Has Datalog" />
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
        </div>
      </div>
      <p className="line-clamp-2 text-[12px] leading-snug text-muted-foreground">
        {rule.description}
      </p>
    </button>
  );
}

/** A sticky stratum group header — the lane identity (number dot + plain
 *  headline) carried into the list, with the rule count. */
function GroupHeader({
  stratum,
  count,
}: {
  stratum: RuleManifestStratum;
  count: number;
}) {
  // Elevation, not a bright divider line (CTL-1328 — Ryan): a subtle raised band
  // (bg-surface-2, opaque so it occludes the rows scrolling beneath it).
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 bg-surface-2 px-3 py-2">
      <span
        className="grid size-4 place-items-center rounded-full text-[9px] font-bold text-background"
        style={{ backgroundColor: strataTone(stratum.id) }}
        aria-hidden
      >
        {stratum.id}
      </span>
      <span className="text-[11px] font-medium">{stratum.plain_headline}</span>
      <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/60">
        {count}
      </span>
    </div>
  );
}

function RuleList({
  lanes,
  firingCounts,
  selectedRuleId,
  onSelectRule,
}: {
  lanes: DisplayLane[];
  firingCounts: Map<string, number>;
  selectedRuleId: string | null;
  onSelectRule: (ruleId: string) => void;
}) {
  return (
    <div className="flex flex-col pb-4">
      {lanes.map((group, i) => (
        // A little air before each group band so it reads as a fresh section,
        // not flush against the previous group's last row (CTL-1328 — Ryan).
        <div key={group.key} className={i > 0 ? "mt-3" : undefined}>
          <GroupHeader stratum={group.stratum} count={group.rules.length} />
          {group.rules.map((rule) => (
            <InboxRow
              key={rule.rule_id}
              rule={rule}
              selected={rule.rule_id === selectedRuleId}
              firingCount={firingCounts.get(rule.rule_id) ?? 0}
              onSelect={onSelectRule}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function RuleInbox({
  lanes,
  firingCounts,
  ruleIndex,
  selectedRule,
  selectedStratum,
  selectedRuleId,
  firingSubjects,
  onSelectRule,
  onClear,
}: {
  /** strata top-down (S6 → S1), the same ordering the board lanes use. */
  lanes: DisplayLane[];
  firingCounts: Map<string, number>;
  ruleIndex: Map<string, RuleManifestRule>;
  selectedRule: RuleManifestRule | null;
  selectedStratum: RuleManifestStratum | null;
  selectedRuleId: string | null;
  firingSubjects: string[];
  onSelectRule: (ruleId: string) => void;
  /** Clear the selection — the mobile "← All rules" back affordance. */
  onClear: () => void;
}) {
  const isMobile = useIsMobile();

  // Mobile push uses the STACKED detail (calm in one column); the wide pane uses
  // the reading-column + right-rail page.
  const detailStacked = selectedRule ? (
    <RuleDetail
      rule={selectedRule}
      stratum={selectedStratum}
      ruleIndex={ruleIndex}
      onSelectRule={onSelectRule}
      firingSubjects={firingSubjects}
    />
  ) : null;

  const detailPage = selectedRule ? (
    <RuleDetailPage
      rule={selectedRule}
      stratum={selectedStratum}
      ruleIndex={ruleIndex}
      onSelectRule={onSelectRule}
      firingSubjects={firingSubjects}
    />
  ) : null;

  const list = (
    <RuleList
      lanes={lanes}
      firingCounts={firingCounts}
      selectedRuleId={selectedRuleId}
      onSelectRule={onSelectRule}
    />
  );

  // ── Narrow: a single column — the list, or (once a rule is picked) the detail
  // pushed full-width with a Back affordance. ──
  if (isMobile) {
    if (selectedRule) {
      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <button
            type="button"
            onClick={onClear}
            className="flex shrink-0 items-center gap-1 border-b border-border-subtle px-3 py-2 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
            All rules
          </button>
          <ScrollArea className="h-full min-h-0 flex-1">{detailStacked}</ScrollArea>
        </div>
      );
    }
    return <ScrollArea className="min-h-0 flex-1">{list}</ScrollArea>;
  }

  // ── Wide: two panes — the grouped rule list rail + the detail pane. ──
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="min-h-0 w-[360px] shrink-0 border-r border-border-subtle">
        <ScrollArea className="h-full">{list}</ScrollArea>
      </div>
      <div className="min-h-0 min-w-0 flex-1">
        <ScrollArea className="h-full">
          {detailPage ?? (
            <div className="flex h-full items-center justify-center p-10 text-center text-[13px] text-muted-foreground/70">
              Select a belief to read its source, relations, and live derivations.
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
