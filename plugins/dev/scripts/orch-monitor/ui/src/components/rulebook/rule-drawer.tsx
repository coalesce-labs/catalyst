// rule-drawer.tsx — CTL-1328: the source drawer opened by clicking a board card.
// Shows the rule's plain-English description, its feeds/reads/negates/cfg
// relations, and a per-rule [Plain English | Datalog | SQL] toggle over the
// rule's REAL source (Datalog for the compiled rules, the extern note + SQL for
// the hand-authored ones). When the rule is firing live, its derivations rail is
// folded in at the bottom. Built on the accessible Sheet (Radix Dialog) so focus
// trap, Escape, and the scrim come for free.
import { useAtom } from "jotai";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import { strataTone } from "@/lib/rulebook-theme";
import { feedNames, splitReads } from "@/lib/rulebook-board-model";
import { highlightRuleSource } from "@/lib/rule-source-highlight";
import type {
  RuleManifestRule,
  RuleManifestStratum,
} from "@/lib/rulebook-model";
import { ruleCardTabs } from "./rule-card-model";
import { perspectiveAtom, type Perspective } from "./perspective-toggle";
import { SeverityPill } from "./severity-pill";
import { RuleChip } from "./rule-chip";
import { LiveIndicator } from "./live-indicator";
import { DerivationsRail } from "./derivations-rail";

function CodeBlock({ content }: { content: string | null }) {
  // CTL-1328: darker surface + full-contrast text + color-coded tokens
  // (highlightRuleSource emits hljs spans themed by `.rulebook-code` in app.css).
  // Source is the trusted frozen manifest and every token is HTML-escaped.
  return (
    <pre className="rulebook-code overflow-x-auto rounded-md px-3 py-2.5 text-[11.5px] font-mono leading-relaxed whitespace-pre">
      <code dangerouslySetInnerHTML={{ __html: highlightRuleSource(content) }} />
    </pre>
  );
}

function SourcePane({
  rule,
  lens,
}: {
  rule: RuleManifestRule;
  lens: Perspective;
}) {
  const tabs = ruleCardTabs(rule); // [Plain English, Datalog, SQL]
  if (lens === "english") {
    return (
      <p className="rulebook-prose text-[14px] leading-relaxed text-foreground/90">
        {rule.description}
      </p>
    );
  }
  if (lens === "datalog") {
    if (tabs[1].isExtern) {
      return (
        <p className="text-xs italic leading-relaxed text-muted-foreground">
          This rule embeds hand-authored SQL (an <em>extern</em> block) — no
          Datalog source is compiled for it. Switch to{" "}
          <strong className="font-medium text-foreground/80 not-italic">
            SQL
          </strong>{" "}
          to read it.
        </p>
      );
    }
    return <CodeBlock content={tabs[1].content} />;
  }
  return <CodeBlock content={tabs[2].content ?? "-- SQL unavailable"} />;
}

// CTL-1327: the belief as a parameterized clause head — `name(subject) → {keys}`.
// Makes the Horn-clause shape legible: every belief is name(subject) carrying a
// value record. Rules that write no value (R4, R6) show just `name(subject)`.
function HeadSignature({ rule }: { rule: RuleManifestRule }) {
  // Defensive: a stale backend (older manifest, or mid-deploy before the host
  // rebuilds rules.generated.mjs) may omit `head` — render nothing rather than
  // crash on a missing field.
  const head = rule.head;
  if (!head) return null;
  const subject = head.subject ?? "";
  const value_keys = head.value_keys ?? [];
  if (!subject && value_keys.length === 0) return null;
  return (
    <div className="mt-2 font-mono text-[12px] leading-relaxed">
      <span className="text-foreground/80">{rule.name}</span>
      <span className="text-muted-foreground/50">(</span>
      <span className="text-foreground/70">{subject || "subject"}</span>
      <span className="text-muted-foreground/50">)</span>
      {value_keys.length > 0 && (
        <>
          <span className="text-muted-foreground/50"> → {"{ "}</span>
          <span className="text-muted-foreground">{value_keys.join(", ")}</span>
          <span className="text-muted-foreground/50">{" }"}</span>
        </>
      )}
    </div>
  );
}

function RelRow({
  label,
  arrow,
  items,
  mono,
}: {
  label: string;
  arrow?: string;
  items: string[];
  mono?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 w-[64px] shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </span>
      <div className="flex flex-wrap gap-1">
        {items.map((i) => (
          <RuleChip key={i} arrow={arrow} label={i} mono={mono} />
        ))}
      </div>
    </div>
  );
}

function DrawerBody({
  rule,
  stratum,
  nameById,
  firingSubjects,
}: {
  rule: RuleManifestRule;
  stratum: RuleManifestStratum | null;
  nameById: Map<string, string>;
  firingSubjects: string[];
}) {
  const [lens, setLens] = useAtom(perspectiveAtom);
  const feeds = feedNames(rule, nameById);
  const { reads, negates } = splitReads(rule);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b px-5 pb-4 pt-5">
        <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span
            className="grid size-4 place-items-center rounded-full text-[9px] font-bold text-background"
            style={{ backgroundColor: strataTone(rule.stratum) }}
            aria-hidden
          >
            {rule.stratum}
          </span>
          <span>
            S{rule.stratum}
            {stratum ? ` · ${stratum.plain_headline}` : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 pr-8">
          <span className="text-[17px] font-semibold">{rule.name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {rule.rule_id}
          </span>
          <SeverityPill severity={rule.severity} />
          {rule.extern && (
            <Badge variant="outline" className="h-4 px-1 text-[10px]">
              extern
            </Badge>
          )}
        </div>
        <HeadSignature rule={rule} />
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <p className="rulebook-prose mb-4 text-[15px] leading-relaxed text-foreground/90">
          {rule.description}
        </p>

        <div className="mb-5 flex flex-col gap-1.5">
          <RelRow label="feeds" arrow="→" items={feeds} />
          <RelRow label="reads" arrow="←" items={reads} />
          <RelRow label="negates" arrow="⊣" items={negates} />
          <RelRow label="thresholds" items={rule.cfg_keys} mono />
        </div>

        <div className="mb-2 flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Source</span>
          <ToggleGroup
            type="single"
            size="sm"
            value={lens}
            // A single-select toggle returns "" when the active item is
            // re-clicked; ignore that so a lens is always selected.
            onValueChange={(v) => v && setLens(v as Perspective)}
          >
            <ToggleGroupItem value="english" className="px-3 text-xs">
              Plain English
            </ToggleGroupItem>
            <ToggleGroupItem
              value="datalog"
              className="px-3 text-xs text-muted-foreground data-[state=on]:text-foreground"
            >
              Datalog
            </ToggleGroupItem>
            <ToggleGroupItem
              value="sql"
              className="px-3 text-xs text-muted-foreground data-[state=on]:text-foreground"
            >
              SQL
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <SourcePane rule={rule} lens={lens} />

        {firingSubjects.length > 0 && (
          <div className="mt-6 border-t pt-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Firing now
              </span>
              <LiveIndicator count={firingSubjects.length} />
            </div>
            <DerivationsRail ruleId={rule.rule_id} subjects={firingSubjects} />
          </div>
        )}
      </div>
    </div>
  );
}

export function RuleDrawer({
  rule,
  stratum,
  nameById,
  firingSubjects,
  open,
  onOpenChange,
}: {
  rule: RuleManifestRule | null;
  stratum: RuleManifestStratum | null;
  nameById: Map<string, string>;
  firingSubjects: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-[560px]">
        {/* Always present for Radix Dialog a11y; the visible header is below. */}
        <SheetTitle className="sr-only">
          {rule ? `${rule.name} — rule source` : "Rule source"}
        </SheetTitle>
        <SheetDescription className="sr-only">
          {rule
            ? `Stratum ${rule.stratum} rule ${rule.rule_id}: ${rule.description}`
            : ""}
        </SheetDescription>
        {rule && (
          <DrawerBody
            rule={rule}
            stratum={stratum}
            nameById={nameById}
            firingSubjects={firingSubjects}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
