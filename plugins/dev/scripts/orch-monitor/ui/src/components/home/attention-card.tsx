// attention-card.tsx — CTL-1126. The single shared AttentionCard component for
// both the inbox list (variant="list") and the reading-pane hero (variant="detail").
// Surface-agnostic: no home-surface import. Board and HUD can adopt it later.
//
// List variant: ported from inbox-row.tsx — flat row, left accent bar, StatusIcon
// size 16, key/title/subLabel, duration cell, verb button + overflow menu, plus a
// type-glyph chip for action rows. NOT a Card primitive (Direction A).
//
// Detail variant: ported from WhatsNeededNow + header identity in reading-pane.tsx —
// StatusIcon size 24, key + subLabel + h1 title, then the hero fork:
//   • escalation (needs-human with explanation): CTA-led card with labelled fields
//     and the per-variant body (decision options / authorization fields / manual steps)
//   • standard (blocked/waiting without explanation): ask + options/blocker + verb
// View-in-Claude pills, Separator, and About stay in reading-pane.tsx (Inbox chrome).
import { GitFork, KeyRound, MoreHorizontal, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  isNeedsYouSection,
  rowDurationMs,
  type InboxRow,
} from "@/board/home-inbox";
import {
  accentFor,
  escalationExplanationFor,
  askFor,
  optionsFor,
  blockerFor,
  heroKindFor,
  type PaneAccent,
  type EscalationDecisionView,
  type EscalationAuthorizationView,
  type EscalationManualView,
} from "@/board/reading-pane-model";
import type { Modality, EscalationType } from "@/board/attention-card-model";
import { cardAccentFor } from "@/board/attention-card-model";
import { OVERFLOW_ACTIONS, verbActionFor } from "@/board/respond-client";
import type { RespondRowStatus } from "@/hooks/use-respond";
import { fmtRelativeDuration } from "@/lib/formatters";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusIcon } from "./status-icon";

// ── Accent helpers ────────────────────────────────────────────────────────────

/** Left-accent color for the list row bar. Only needs-you sections carry a color. */
function listAccentClass(section: InboxRow["section"]): string {
  if (section === "blocked") return "bg-red";
  if (section === "waiting") return "bg-yellow";
  if (section === "attention") return "bg-yellow";
  return "bg-transparent";
}

/** Tailwind classes for the detail hero emphasis — tint + left bar (never a card). */
function paneAccentClasses(accent: PaneAccent): string {
  switch (accent) {
    case "red":
      return "border-l-[3px] border-red bg-red/8";
    case "amber":
      return "border-l-[3px] border-yellow bg-yellow/8";
    case "none":
      return "";
  }
}

// ── Type-glyph chip ───────────────────────────────────────────────────────────

function EscalationGlyphIcon({ type }: { type: EscalationType }) {
  if (type === "authorization") return <ShieldCheck className="size-3" />;
  if (type === "manual") return <KeyRound className="size-3" />;
  return <GitFork className="size-3" />;
}

/** Color-blind-safe type chip: glyph is the primary cue, color is secondary. */
function EscalationTypeChip({ escalationType }: { escalationType: EscalationType }) {
  return (
    <span
      data-escalation-type={escalationType}
      className="inline-flex items-center gap-1 rounded-sm border border-border px-1 py-0.5 text-[10px] text-muted"
    >
      <EscalationGlyphIcon type={escalationType} />
    </span>
  );
}

// ── Shared sub-pieces ─────────────────────────────────────────────────────────

function KeyTitle({ row }: { row: InboxRow }) {
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono text-[11.5px] font-semibold text-accent">{row.id}</span>
      <span className="truncate text-[13px] text-fg">{row.title}</span>
    </span>
  );
}

function DetailKeyTitle({ row }: { row: InboxRow }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] font-semibold text-accent">{row.id}</span>
        <span className="text-[11px] text-muted">{row.subLabel}</span>
      </div>
      <h1 className="mt-1 text-[18px] leading-snug text-fg">{row.title}</h1>
    </div>
  );
}

// ── Verb components ───────────────────────────────────────────────────────────

/** The quiet row verb button (list variant). */
function RowVerb({
  row,
  onAct,
  respondStatus,
}: {
  row: InboxRow;
  onAct?: (id: string) => void;
  respondStatus: RespondRowStatus;
}) {
  const verbAction = verbActionFor(row);
  if (!verbAction) return null;
  return (
    <div className="mt-0.5 flex shrink-0 items-center gap-1">
      {respondStatus === "resuming" ? (
        <span
          data-row-resuming={row.id}
          className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted"
        >
          resuming…
        </span>
      ) : (
        <button
          type="button"
          data-row-verb={row.id}
          data-verb-kind={verbAction.kind}
          onClick={(e) => {
            e.stopPropagation();
            onAct?.(row.id);
          }}
          className={cn(
            "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
            row.section === "blocked"
              ? "border-red/40 text-red hover:bg-red/10"
              : "border-yellow/40 text-yellow hover:bg-yellow/10",
          )}
        >
          {verbAction.verb}
        </button>
      )}
      {respondStatus === "did-not-take" && (
        <span
          data-row-did-not-take={row.id}
          title="The agent did not resume — try again."
          className="text-[10px] text-muted"
        >
          didn't take
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-row-overflow={row.id}
            aria-label="More actions"
            onClick={(e) => e.stopPropagation()}
            className="rounded p-0.5 text-muted opacity-0 transition-opacity hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          {OVERFLOW_ACTIONS.map((action) => (
            <DropdownMenuItem key={action} data-overflow-action={action} disabled>
              {action}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The prominent pane verb (detail variant). */
function PaneVerb({
  row,
  onAct,
  respondStatus,
}: {
  row: InboxRow;
  onAct?: (id: string) => void;
  respondStatus: RespondRowStatus;
}) {
  const action = verbActionFor(row);
  if (!action) return null;
  if (respondStatus === "resuming") {
    return (
      <div className="mt-4" data-pane-resuming={row.id}>
        <span className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-[13px] font-medium text-muted">
          Resuming…
        </span>
      </div>
    );
  }
  return (
    <div className="mt-4 flex items-center gap-3">
      <Button
        type="button"
        size="sm"
        data-pane-verb={row.id}
        data-verb-kind={action.kind}
        onClick={() => onAct?.(row.id)}
      >
        {action.verb}
      </Button>
      {respondStatus === "did-not-take" && (
        <span data-pane-did-not-take={row.id} className="text-[11px] text-muted">
          The agent did not resume — try again.
        </span>
      )}
    </div>
  );
}

// ── Detail hero forks ─────────────────────────────────────────────────────────

function DecisionHeroBody({ view, row, onAct, respondStatus }: {
  view: EscalationDecisionView;
  row: InboxRow;
  onAct?: (id: string) => void;
  respondStatus: RespondRowStatus;
}) {
  return (
    <>
      <div className="mt-1.5 flex flex-wrap items-start gap-3">
        {view.callToAction != null && (
          <p data-escalation-cta className="flex-1 text-[14px] font-medium leading-snug text-fg">
            {view.callToAction}
          </p>
        )}
        <PaneVerb row={row} onAct={onAct} respondStatus={respondStatus} />
      </div>
      {view.options.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2" data-pane-options>
          {view.options.map((opt, i) => (
            <li key={`${opt.label}-${i}`} className="flex items-baseline gap-2">
              <Badge variant="outline" className="shrink-0 font-medium">{opt.label}</Badge>
              {opt.detail !== "" && (
                <span className="text-[12px] leading-snug text-muted">{opt.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {(
        [
          ["What this delivers", view.outcome, "outcome"],
          ["The problem", view.problem, "problem"],
          ["Why this needs you", view.whyYou, "why_you"],
          ["Why it couldn't self-heal", view.whyNotAuto, "why_not_auto"],
          ["What to do", view.whatToDo, "what_to_do"],
        ] as const
      )
        .filter(([, value]) => value != null)
        .map(([label, value, field]) => (
          <div key={field} className="mt-3" data-escalation-field={field}>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-fg/90">{value}</p>
          </div>
        ))}
    </>
  );
}

function AuthorizationHeroBody({ view, row, onAct, respondStatus }: {
  view: EscalationAuthorizationView;
  row: InboxRow;
  onAct?: (id: string) => void;
  respondStatus: RespondRowStatus;
}) {
  return (
    <>
      <div className="mt-1.5 flex flex-wrap items-start gap-3">
        {view.callToAction != null && (
          <p data-escalation-cta className="flex-1 text-[14px] font-medium leading-snug text-fg">
            {view.callToAction}
          </p>
        )}
        <PaneVerb row={row} onAct={onAct} respondStatus={respondStatus} />
      </div>
      {(
        [
          ["Recommendation", view.recommendation, "recommendation"],
          ["Risk", view.risk, "risk"],
          ["Why asking you", view.whyAsking, "why_asking"],
          ["Higher-tier retry", view.higherTierRetry, "higher_tier_retry"],
          ["What this delivers", view.outcome, "outcome"],
          ["The problem", view.problem, "problem"],
          ["Why this needs you", view.whyYou, "why_you"],
          ["Why it couldn't self-heal", view.whyNotAuto, "why_not_auto"],
          ["What to do", view.whatToDo, "what_to_do"],
        ] as const
      )
        .filter(([, value]) => value != null)
        .map(([label, value, field]) => (
          <div key={field} className="mt-3" data-escalation-field={field}>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-fg/90">{value}</p>
          </div>
        ))}
    </>
  );
}

function ManualHeroBody({ view, row, onAct, respondStatus }: {
  view: EscalationManualView;
  row: InboxRow;
  onAct?: (id: string) => void;
  respondStatus: RespondRowStatus;
}) {
  return (
    <>
      <div className="mt-1.5 flex flex-wrap items-start gap-3">
        {view.callToAction != null && (
          <p data-escalation-cta className="flex-1 text-[14px] font-medium leading-snug text-fg">
            {view.callToAction}
          </p>
        )}
        <PaneVerb row={row} onAct={onAct} respondStatus={respondStatus} />
      </div>
      {view.blockedCapability != null && (
        <div className="mt-3" data-escalation-field="blocked_capability">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Blocked capability</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-fg/90">{view.blockedCapability}</p>
        </div>
      )}
      {view.instructions.length > 0 && (
        <ol className="mt-3 flex flex-col gap-1" data-escalation-field="instructions">
          {view.instructions.map((step, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-[11px] text-muted">{i + 1}.</span>
              <span className="text-[13px] text-fg/90">{step}</span>
            </li>
          ))}
        </ol>
      )}
      {(
        [
          ["What this delivers", view.outcome, "outcome"],
          ["The problem", view.problem, "problem"],
          ["Why this needs you", view.whyYou, "why_you"],
          ["Why it couldn't self-heal", view.whyNotAuto, "why_not_auto"],
          ["What to do", view.whatToDo, "what_to_do"],
        ] as const
      )
        .filter(([, value]) => value != null)
        .map(([label, value, field]) => (
          <div key={field} className="mt-3" data-escalation-field={field}>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-fg/90">{value}</p>
          </div>
        ))}
    </>
  );
}

// ── Detail hero block ─────────────────────────────────────────────────────────

function DetailHero({
  row,
  escalationType,
  onAct,
  respondStatus,
}: {
  row: InboxRow;
  escalationType?: EscalationType;
  onAct?: (id: string) => void;
  respondStatus: RespondRowStatus;
}) {
  const kind = heroKindFor(row);
  if (kind == null) return null;

  const escalation = escalationExplanationFor(row);

  if (escalation != null) {
    const derivedType = escalationType ?? (escalation.type);
    const accent: PaneAccent = cardAccentFor({ modality: "action", escalationType: derivedType });
    return (
      <section
        data-pane-hero="escalation"
        data-pane-accent={accent === "none" ? "amber" : accent}
        data-pane-escalation
        className={cn("mt-4 rounded-sm py-3 pr-4 pl-4", paneAccentClasses(accent === "none" ? "amber" : accent))}
      >
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
          What's needed now
        </p>
        {escalation.type === "authorization" ? (
          <AuthorizationHeroBody view={escalation} row={row} onAct={onAct} respondStatus={respondStatus} />
        ) : escalation.type === "manual" ? (
          <ManualHeroBody view={escalation} row={row} onAct={onAct} respondStatus={respondStatus} />
        ) : (
          <DecisionHeroBody view={escalation} row={row} onAct={onAct} respondStatus={respondStatus} />
        )}
      </section>
    );
  }

  // Standard branch: blocked or decision without explanation
  const accent = accentFor(row);
  const ask = askFor(row);
  const options = optionsFor(row);
  const blocker = blockerFor(row);
  const heading = kind === "blocked" ? "Blocked — needs you to unblock" : "What's needed now";

  return (
    <section
      data-pane-hero={kind}
      data-pane-accent={accent}
      className={cn("mt-4 rounded-sm py-3 pr-4 pl-4", paneAccentClasses(accent))}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{heading}</p>
      {ask != null && <p className="mt-1.5 text-[14px] leading-snug text-fg">{ask}</p>}
      {kind === "decision" && options.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2" data-pane-options>
          {options.map((opt, i) => (
            <li key={`${opt.label}-${i}`} className="flex items-baseline gap-2">
              <Badge variant="outline" className="shrink-0 font-medium">{opt.label}</Badge>
              {opt.detail !== "" && (
                <span className="text-[12px] leading-snug text-muted">{opt.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {kind === "blocked" && blocker != null && (
        <p className="mt-2 text-[12px] leading-snug text-muted" data-pane-blocker>
          {blocker}
        </p>
      )}
      {kind === "blocked" && row.blockers.length > 0 && (
        <p className="mt-2 font-mono text-[11px] text-muted/80">
          blocked on: {row.blockers.join(", ")}
        </p>
      )}
      <PaneVerb row={row} onAct={onAct} respondStatus={respondStatus} />
    </section>
  );
}

// ── AttentionCard ─────────────────────────────────────────────────────────────

export function AttentionCard({
  row,
  variant,
  modality,
  escalationType,
  now,
  selected,
  onSelect,
  onAct,
  respondStatus = "idle",
}: {
  row: InboxRow;
  variant: "list" | "detail";
  modality: Modality;
  escalationType?: EscalationType;
  now: number;
  selected?: boolean;
  onSelect?: (id: string) => void;
  onAct?: (id: string) => void;
  respondStatus?: RespondRowStatus;
}) {
  const needsYou = isNeedsYouSection(row.section);
  const duration = fmtRelativeDuration(rowDurationMs(row, now));

  if (variant === "list") {
    return (
      <div
        role="button"
        tabIndex={0}
        data-inbox-row={row.id}
        data-selected={selected ? "true" : undefined}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect?.(row.id)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
            e.preventDefault();
            onSelect?.(row.id);
          }
        }}
        className={cn(
          "group flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors",
          selected ? "bg-surface-2" : "hover:bg-surface-1",
        )}
      >
        <span
          aria-hidden
          className={cn("mt-0.5 h-9 w-0.5 shrink-0 rounded-full", listAccentClass(row.section))}
        />
        <StatusIcon
          phase={row.ticket.phase}
          status={row.ticket.status}
          size={16}
          className="mt-0.5"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <KeyTitle row={row} />
          <span className="text-[11px] text-muted">
            {row.subLabel}
            {row.section === "blocked" && row.blockers.length > 0
              ? ` · ${row.blockers.join(", ")}`
              : ""}
          </span>
        </span>

        {/* Type-glyph chip for action rows (color-blind safe cue). */}
        {modality === "action" && escalationType != null && (
          <EscalationTypeChip escalationType={escalationType} />
        )}

        {duration != null ? (
          <span
            data-row-duration={duration}
            title={`${row.subLabel} for ${duration}`}
            className="mt-0.5 shrink-0 font-mono text-[11px] tabular-nums text-muted"
          >
            {duration}
          </span>
        ) : (
          <span data-row-duration-unavailable aria-hidden className="sr-only" />
        )}

        {needsYou && (
          <RowVerb row={row} onAct={onAct} respondStatus={respondStatus} />
        )}
      </div>
    );
  }

  // Detail variant: header identity + hero block only.
  // View-in-Claude pills, Separator, About stay in reading-pane.tsx.
  const needsHero = heroKindFor(row) != null;
  return (
    <div>
      <div className="flex items-start gap-3">
        <StatusIcon
          phase={row.ticket.phase}
          status={row.ticket.status}
          size={24}
          className="mt-0.5"
        />
        <DetailKeyTitle row={row} />
        {/* Type-glyph chip in the header for action rows */}
        {modality === "action" && escalationType != null && (
          <EscalationTypeChip escalationType={escalationType} />
        )}
      </div>
      {needsHero && (
        <DetailHero
          row={row}
          escalationType={escalationType}
          onAct={onAct}
          respondStatus={respondStatus}
        />
      )}
    </div>
  );
}
