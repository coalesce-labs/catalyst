// rule-drawer.tsx — CTL-1328: the source drawer opened by clicking a board card.
// Shows the rule's plain-English description, its feeds/reads/negates/cfg
// relations, and a per-rule [Plain English | Datalog | SQL] toggle over the
// rule's REAL source (Datalog for the compiled rules, the extern note + SQL for
// the hand-authored ones). When the rule is firing live, its derivations rail is
// folded in at the bottom. Built on the accessible Sheet (Radix Dialog) so focus
// trap, Escape, and the scrim come for free.
import { Fragment, type ReactNode } from "react";
import { useAtom } from "jotai";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { strataTone } from "@/lib/rulebook-theme";
import { splitReads } from "@/lib/rulebook-board-model";
import { highlightRuleSource } from "@/lib/rule-source-highlight";
import type {
  RuleManifestRule,
  RuleManifestStratum,
} from "@/lib/rulebook-model";
import { ruleCardTabs } from "./rule-card-model";
import { perspectiveAtom, type Perspective } from "./perspective-toggle";
import { SeverityPill } from "./severity-pill";
import { LiveIndicator } from "./live-indicator";
import { DerivationsRail } from "./derivations-rail";
import { useBeliefCfg, CfgValue, cfgDescription } from "./rulebook-cfg";

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
  if (lens === "example") {
    // CTL-1328: a realistic example instance of the belief + a one-line note of
    // what it means in real life (moved here from the belief-shape block — Ryan).
    const shape = rule.shape;
    if (!shape?.exampleInstance) {
      return (
        <p className="text-xs italic leading-relaxed text-muted-foreground">
          No example available for this belief.
        </p>
      );
    }
    return (
      <div>
        <pre className="rulebook-code overflow-x-auto rounded-md px-3 py-2.5 text-[11.5px] font-mono leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          {shape.exampleInstance}
        </pre>
        {shape.exampleNote && (
          <p className="mt-2 text-[13px] leading-relaxed text-foreground/80">
            {shape.exampleNote}
          </p>
        )}
      </div>
    );
  }
  return <CodeBlock content={tabs[2].content ?? "-- SQL unavailable"} />;
}

// The lens toggle — English · Datalog · SQL · Example — over the rule's source +
// a concrete example. No "Source" label (it's more than source now — Ryan).
// Shared by RuleDetail (stacked) and RuleDetailPage (reading column).
function SourceSection({
  rule,
  lens,
  setLens,
}: {
  rule: RuleManifestRule;
  lens: Perspective;
  setLens: (lens: Perspective) => void;
}) {
  const item = "px-3 text-xs text-muted-foreground data-[state=on]:text-foreground";
  const hasExample = !!rule.shape?.exampleInstance;
  // If the persisted lens is "example" but this belief has none, fall back to
  // English so the pane is never blank.
  const effectiveLens = lens === "example" && !hasExample ? "english" : lens;
  return (
    <>
      <div className="mb-2">
        <ToggleGroup
          type="single"
          size="sm"
          value={effectiveLens}
          // A single-select toggle returns "" when the active item is
          // re-clicked; ignore that so a lens is always selected.
          onValueChange={(v) => v && setLens(v as Perspective)}
        >
          <ToggleGroupItem value="english" className={item}>
            English
          </ToggleGroupItem>
          <ToggleGroupItem value="datalog" className={item}>
            Datalog
          </ToggleGroupItem>
          <ToggleGroupItem value="sql" className={item}>
            SQL
          </ToggleGroupItem>
          {hasExample && (
            <ToggleGroupItem value="example" className={item}>
              Example
            </ToggleGroupItem>
          )}
        </ToggleGroup>
      </div>
      <SourcePane rule={rule} lens={effectiveLens} />
    </>
  );
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
    <div className="font-mono text-[12px] leading-relaxed [overflow-wrap:anywhere]">
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

// CTL-1328: a single relation target in the drawer's Relations detail list. The
// flat low-contrast pills were reworked (Ryan) into a calm definition-list of
// dot + name links that mirror the app's ticket-detail right-rail: a stratum-
// coloured dot, a full-contrast name, click → re-target the drawer to that rule,
// hover → a preview of that rule's plain-English line. A target that doesn't
// resolve to a rule (a raw fact, or an unknown id) renders as a quiet static
// token rather than a dead link.
interface ResolvedTarget {
  /** stable key + the label shown (belief name, or the raw id as a fallback). */
  key: string;
  label: string;
  /** the resolved rule, or undefined when the target is not a rule. */
  rule: RuleManifestRule | undefined;
}

function RelationTarget({
  target,
  onSelectRule,
}: {
  target: ResolvedTarget;
  onSelectRule: (ruleId: string) => void;
}) {
  const rule = target.rule;
  if (!rule) {
    // Unresolved (raw fact / unknown) — a calm, non-interactive token.
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] text-foreground/65">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
        />
        {target.label}
      </span>
    );
  }
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={() => onSelectRule(rule.rule_id)}
          aria-label={`${rule.name} (${rule.rule_id}) — open rule`}
          className="group/rel inline-flex items-center gap-1.5 rounded text-[13px] text-foreground/90 transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: strataTone(rule.stratum) }}
          />
          <span className="underline-offset-2 group-hover/rel:underline">
            {rule.name}
          </span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="grid size-4 place-items-center rounded-full text-[9px] font-bold text-background"
            style={{ backgroundColor: strataTone(rule.stratum) }}
            aria-hidden
          >
            {rule.stratum}
          </span>
          <span className="text-[13px] font-medium">{rule.name}</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {rule.rule_id}
          </span>
          <SeverityPill severity={rule.severity} />
        </div>
        <p className="rulebook-prose mt-2 text-[12px] leading-relaxed text-muted-foreground">
          {rule.description}
        </p>
      </HoverCardContent>
    </HoverCard>
  );
}

// CTL-1328: the Relations detail block — an aligned label→value definition list
// (Feeds / Reads / Negates), each a row of RelationTargets. Thresholds are their
// own section now (ThresholdsSection). Renders a calm "no upstream rules" line
// when the rule derives straight from raw observations, never an empty section.
function RelationsSection({
  feeds,
  reads,
  negates,
  onSelectRule,
  heading = true,
}: {
  feeds: ResolvedTarget[];
  reads: ResolvedTarget[];
  negates: ResolvedTarget[];
  onSelectRule: (ruleId: string) => void;
  /** Render the "Relations" heading + section margin (default). Set false
   *  inside a RailCard whose own title already names the section. */
  heading?: boolean;
}) {
  const rows: { label: string; glyph: string; items: ResolvedTarget[] }[] = [
    { label: "Feeds", glyph: "→", items: feeds },
    { label: "Reads", glyph: "←", items: reads },
    { label: "Negates", glyph: "⊣", items: negates },
  ].filter((r) => r.items.length > 0);

  if (rows.length === 0) {
    return (
      <p
        className={`text-[13px] leading-relaxed text-muted-foreground/80${
          heading ? " mb-5" : ""
        }`}
      >
        Derives directly from raw observations — no upstream rules.
      </p>
    );
  }

  const grid = (
    <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-2.5">
      {rows.map((r) => (
        <Fragment key={r.label}>
          <dt className="pt-px text-[11px] text-muted-foreground">
            <span className="mr-1 text-muted-foreground/50">{r.glyph}</span>
            {r.label}
          </dt>
          <dd className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {r.items.map((t) => (
              <RelationTarget
                key={t.key}
                target={t}
                onSelectRule={onSelectRule}
              />
            ))}
          </dd>
        </Fragment>
      ))}
    </dl>
  );

  if (!heading) return grid;

  return (
    <section className="mb-5">
      <h3 className="mb-2.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Relations
      </h3>
      {grid}
    </section>
  );
}

// CTL-1328 (Ryan): the tunable thresholds this rule reads, as a key → VALUE
// section (not just bare key names) — the live configured value + a one-line
// note of what it tunes. Values come from the shared cfg fetch.
function ThresholdsSection({ cfgKeys }: { cfgKeys: string[] }) {
  const { byKey } = useBeliefCfg();
  return (
    <dl className="space-y-3">
      {cfgKeys.map((key) => {
        const row = byKey.get(key);
        const desc = cfgDescription(key);
        return (
          <div key={key}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[12px] text-foreground/90">
                {key}
              </span>
              {row ? (
                <CfgValue row={row} />
              ) : (
                <span className="text-[11px] text-muted-foreground/50">—</span>
              )}
            </div>
            {desc && (
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                {desc}
              </p>
            )}
          </div>
        );
      })}
    </dl>
  );
}

// Resolve a rule's relations to ResolvedTargets for the Relations list: feeds[]
// carries rule ids, reads[]/negates[] carry belief names; the single ruleIndex
// resolves both key spaces to the target rule (or undefined → a static token).
// Shared by the stacked RuleDetail (Sheet/mobile) and the RuleDetailPage rail.
function resolveRelations(
  rule: RuleManifestRule,
  ruleIndex: Map<string, RuleManifestRule>,
): { feeds: ResolvedTarget[]; readTargets: ResolvedTarget[]; negateTargets: ResolvedTarget[] } {
  const feeds: ResolvedTarget[] = rule.feeds.map((id) => {
    const target = ruleIndex.get(id);
    return { key: id, label: target?.name ?? id, rule: target };
  });
  const { reads, negates } = splitReads(rule);
  const readTargets: ResolvedTarget[] = reads.map((name) => ({
    key: name,
    label: name,
    rule: ruleIndex.get(name),
  }));
  const negateTargets: ResolvedTarget[] = negates.map((name) => ({
    key: name,
    label: name,
    rule: ruleIndex.get(name),
  }));
  return { feeds, readTargets, negateTargets };
}

// CTL-1328: the rule's detail body — header (stratum, name, severity, head
// signature), the Relations definition-list, the Plain English|Datalog|SQL
// source toggle, and the live derivations rail. STACKED layout, used in the
// board view's right-side Sheet (RuleDrawer) and the inbox's mobile push.
export function RuleDetail({
  rule,
  stratum,
  ruleIndex,
  onSelectRule,
  firingSubjects,
}: {
  rule: RuleManifestRule;
  stratum: RuleManifestStratum | null;
  ruleIndex: Map<string, RuleManifestRule>;
  onSelectRule: (ruleId: string) => void;
  firingSubjects: string[];
}) {
  const [lens, setLens] = useAtom(perspectiveAtom);
  const { feeds, readTargets, negateTargets } = resolveRelations(rule, ruleIndex);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border-subtle px-5 pb-4 pt-5">
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
        <div className="mt-2">
          <HeadSignature rule={rule} />
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <p className="rulebook-prose mb-4 text-[15px] leading-relaxed text-foreground/90">
          {rule.narrative || rule.description}
        </p>

        <div className="mb-5">
          <BeliefShape rule={rule} />
        </div>

        <RelationsSection
          feeds={feeds}
          reads={readTargets}
          negates={negateTargets}
          onSelectRule={onSelectRule}
        />

        {rule.cfg_keys.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-2.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Thresholds
            </h3>
            <ThresholdsSection cfgKeys={rule.cfg_keys} />
          </section>
        )}

        <SourceSection rule={rule} lens={lens} setLens={setLens} />

        <div className="mt-6 border-t border-border-subtle pt-4">
          <ActiveBeliefs
            ruleId={rule.rule_id}
            subjects={firingSubjects}
            onSelectRule={onSelectRule}
          />
        </div>
      </div>
    </div>
  );
}

// A compact rail card — the elevation-based panel idiom (bg-card raised off the
// canvas + a SOFT hairline + lift), so the detail rail separates by elevation,
// not bright divider lines. Mirrors the app's Panel / the Catalyst Cloud rail.
function RailCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="gap-0 rounded-lg border-border-subtle py-0">
      <div className="px-3.5 pt-3 pb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {title}
      </div>
      <div className="px-3.5 pb-3.5">{children}</div>
    </Card>
  );
}

// The live "active beliefs" for this rule — the subjects currently asserting it,
// each expandable to its derivation trace. Always rendered (DerivationsRail
// shows an honest "not currently firing" when empty) so the detail always
// surfaces this dimension.
function ActiveBeliefs({
  ruleId,
  subjects,
  onSelectRule,
}: {
  ruleId: string;
  subjects: string[];
  onSelectRule: (ruleId: string) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Active beliefs
        </span>
        {subjects.length > 0 && <LiveIndicator count={subjects.length} />}
      </div>
      <DerivationsRail
        ruleId={ruleId}
        subjects={subjects}
        onOpenSource={onSelectRule}
      />
    </div>
  );
}

// CTL-1328: the belief's SHAPE as dev-docs — the clause signature, what the
// belief is keyed on (subject), each value field (name · type · meaning), and a
// realistic example instance with a one-line real-life note. Lives in the main
// content (it's load-bearing, not rail metadata — Ryan). Renders nothing when a
// (pre-CTL-1328) manifest carries no shape.
function BeliefShape({ rule }: { rule: RuleManifestRule }) {
  const shape = rule.shape;
  if (!shape) return null;
  const hasContent = !!shape.subjectDoc || shape.values.length > 0;
  if (!hasContent) return null;
  const subjectLabel = rule.head?.subject || "subject";
  return (
    <section>
      <h3 className="mb-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Belief shape
      </h3>
      <div className="mb-3 text-[13px]">
        <HeadSignature rule={rule} />
      </div>
      {shape.subjectDoc && (
        <p className="mb-4 text-[13px] leading-relaxed text-muted-foreground">
          <span className="font-mono text-[12px] text-foreground/80">
            {subjectLabel}
          </span>
          {" — "}
          {shape.subjectDoc}
        </p>
      )}
      {shape.values.length > 0 && (
        <dl className="mb-4 space-y-2.5">
          {shape.values.map((v) => (
            <div key={v.key}>
              <dt className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-[12px] text-foreground/90">
                  {v.key}
                </span>
                <span className="text-[11px] text-muted-foreground/60">
                  {v.type}
                </span>
              </dt>
              <dd className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
                {v.meaning}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

// CTL-1328 (Beliefs IA): the rule's detail as a ticket-detail-style PAGE — a
// reading column (description prose + the source toggle + the live "active
// beliefs") and a calm right rail of CARDS (Properties + Relations). Two columns
// at xl, stacked below. Natural-flow (no internal scroll) — its host (the inbox
// Browse pane) provides the ScrollArea. Mirrors ticket-detail-page's
// reading-column + right-rail idiom so Beliefs reads like the rest of the app.
export function RuleDetailPage({
  rule,
  stratum,
  ruleIndex,
  onSelectRule,
  firingSubjects,
}: {
  rule: RuleManifestRule;
  stratum: RuleManifestStratum | null;
  ruleIndex: Map<string, RuleManifestRule>;
  onSelectRule: (ruleId: string) => void;
  firingSubjects: string[];
}) {
  const [lens, setLens] = useAtom(perspectiveAtom);
  const { feeds, readTargets, negateTargets } = resolveRelations(rule, ruleIndex);

  return (
    <div className="px-6 py-6 xl:px-8 xl:py-8">
      {/* Header — stratum context line, then the belief name + id + severity. */}
      <div className="mb-6">
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
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="rulebook-prose text-[22px] font-semibold tracking-tight">
            {rule.name}
          </h2>
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
      </div>

      {/* Reading column + right-rail CARDS (two columns at xl, stacked below).
          Sections separate by elevation (cards) + spacing — no bright divider
          lines (CTL-1328 — Ryan). */}
      <div className="grid gap-x-8 gap-y-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        {/* Reading column: prose · source · the live active beliefs. */}
        <div className="min-w-0 max-w-[70ch] space-y-7">
          <p className="rulebook-prose text-[15px] leading-relaxed text-foreground/90">
            {rule.narrative || rule.description}
          </p>
          <BeliefShape rule={rule} />
          <div>
            <SourceSection rule={rule} lens={lens} setLens={setLens} />
          </div>
          <ActiveBeliefs
            ruleId={rule.rule_id}
            subjects={firingSubjects}
            onSelectRule={onSelectRule}
          />
        </div>

        {/* Right rail: Properties + Relations as elevated cards. */}
        <aside className="space-y-4">
          <RailCard title="Properties">
            <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-2 text-[13px]">
              <dt className="text-muted-foreground">Stratum</dt>
              <dd className="text-foreground/90">
                S{rule.stratum}
                {stratum ? ` · ${stratum.plain_headline}` : ""}
              </dd>
              <dt className="text-muted-foreground">Severity</dt>
              <dd>
                <SeverityPill severity={rule.severity} />
              </dd>
            </dl>
          </RailCard>
          <RailCard title="Relations">
            <RelationsSection
              feeds={feeds}
              reads={readTargets}
              negates={negateTargets}
              onSelectRule={onSelectRule}
              heading={false}
            />
          </RailCard>
          {rule.cfg_keys.length > 0 && (
            <RailCard title="Thresholds">
              <ThresholdsSection cfgKeys={rule.cfg_keys} />
            </RailCard>
          )}
        </aside>
      </div>
    </div>
  );
}

export function RuleDrawer({
  rule,
  stratum,
  ruleIndex,
  onSelectRule,
  firingSubjects,
  open,
  onOpenChange,
}: {
  rule: RuleManifestRule | null;
  stratum: RuleManifestStratum | null;
  /** id+name → rule, resolving a relation target to its full rule. */
  ruleIndex: Map<string, RuleManifestRule>;
  /** Re-target the drawer to a related rule (click a relation link). */
  onSelectRule: (ruleId: string) => void;
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
          <RuleDetail
            rule={rule}
            stratum={stratum}
            ruleIndex={ruleIndex}
            onSelectRule={onSelectRule}
            firingSubjects={firingSubjects}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
