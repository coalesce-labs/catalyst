// reading-pane.tsx — the master-detail READING PANE (CTL-902 / HOME4).
//
// This is the progressive-disclosure payload that keeps the calm list rows quiet:
// the one-line ask lives on the row, EVERYTHING ELSE lives here, one selection
// deeper, with NO nested cards (Direction A). For a needs-you item it shows the
// hero "What's needed now" block (the full ask in plain language) plus either the
// decision OPTIONS (each a label + a one-line trade-off) or the BLOCKER detail;
// for ANY item it shows an ABOUT block (one-line summary + goal + the HOME2 phase
// strip for where-it's-at) and a PROMINENT View-in-Claude deep link into the
// background agent's Claude Code session (the row keeps it quiet/hover-only; the
// pane is its prominent home, per the home-directions "where View-in-Claude
// lives" table).
//
// HONESTY: the ask / goal / summary / options / blocker content is served per
// item by the BFF inbox endpoint (a separate NEEDS-PLUMBING ticket) onto the
// OPTIONAL BoardTicket fields. Every field the read-model omits renders ABSENT,
// never fabricated — the derivation in reading-pane-model.ts enforces that and
// View-in-Claude HIDES (no dead link) when no session id is known.
//
// COMPOSITION: the pane body is built from real shadcn primitives (Badge / Button
// / ScrollArea / Separator) per the standing preference; the phase strip + the
// StatusIcon glyph are the HOME2 Catalyst hand-rolls. Emphasis is a whisper of
// background TINT + a left accent BAR (the attention-bar pattern) — NEVER a
// bordered sub-card, never cyan (cyan is reserved for the live signal).
import { CheckCircle2, ExternalLink as ExternalLinkIcon } from "lucide-react";
import { isNeedsYouSection, type InboxRow } from "@/board/home-inbox";
import { isDoneStatus, isPhase, phaseIndexOf, PHASE_LABEL } from "@/board/phase-model";
import {
  aboutBlockFor,
  accentFor,
  askFor,
  blockerFor,
  heroKindFor,
  optionsFor,
  viewInClaudeFor,
  type PaneAccent,
} from "@/board/reading-pane-model";
import { verbActionFor } from "@/board/respond-client";
import type { RespondRowStatus } from "@/hooks/use-respond";
import type { BoardWorker } from "@/board/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { StatusIcon } from "./status-icon";
import { PhaseStrip } from "./phase-strip";

/** Empty-pane state — shown when nothing is selected (a wholly empty inbox).
 *  The relief payoff: calm, not an error. */
function NothingSelected() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-muted">
      <CheckCircle2 className="h-8 w-8 opacity-40" />
      <p className="text-[13px]">Nothing needs you right now.</p>
      <p className="max-w-xs text-[12px] opacity-70">
        When an agent needs a decision or hits a blocker, it lands here.
      </p>
    </div>
  );
}

/** Tailwind classes for the hero emphasis — a whisper of background tint + a left
 *  accent BAR, NEVER a bordered sub-card (Direction A). `none` renders fully
 *  neutral (no tint/bar). Amber = decision (waiting), red = blocked. Never cyan. */
function accentClasses(accent: PaneAccent): string {
  switch (accent) {
    case "red":
      return "border-l-[3px] border-red bg-red/8";
    case "amber":
      return "border-l-[3px] border-yellow bg-yellow/8";
    case "none":
      return "";
  }
}

/** The pane's PROMINENT primary verb (CTL-903 / HOME5). The reading pane is the
 *  verb's home (the row keeps a quieter copy); here it is a full bright button.
 *  Clicking it fires the read-model write (record the response + resume the
 *  agent). While the optimistic write is in flight it shows `resuming…`; on a
 *  resume-that-did-not-take it reinstates the verb + a quiet "didn't take" note. */
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

/** The hero "What's needed now" block. The bright subject of the pane: the full
 *  ask in plain language, then either the decision OPTIONS or the BLOCKER detail,
 *  and the ONE prominent primary verb (CTL-903). Emphasis is tint + left bar
 *  (accentClasses), not a card. Any field the read-model omits is simply not
 *  rendered (honest, never fabricated). */
function WhatsNeededNow({
  row,
  onAct,
  respondStatus,
}: {
  row: InboxRow;
  onAct?: (id: string) => void;
  respondStatus: RespondRowStatus;
}) {
  const kind = heroKindFor(row);
  if (kind == null) return null; // neutral (running/done) sets carry no hero.

  const accent = accentFor(row);
  const ask = askFor(row);
  const options = optionsFor(row);
  const blocker = blockerFor(row);
  const heading = kind === "blocked" ? "Blocked — needs you to unblock" : "What's needed now";

  return (
    <section
      data-pane-hero={kind}
      data-pane-accent={accent}
      className={cn("mt-4 rounded-sm py-3 pr-4 pl-4", accentClasses(accent))}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{heading}</p>

      {/* The full ask, plain language — the bright line of the hero. */}
      {ask != null && <p className="mt-1.5 text-[14px] leading-snug text-fg">{ask}</p>}

      {/* A decision shows its options (label + one-line trade-off, flat lines —
          no nested card). A blocker shows its plain-language detail instead. */}
      {kind === "decision" && options.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2" data-pane-options>
          {options.map((opt, i) => (
            <li key={`${opt.label}-${i}`} className="flex items-baseline gap-2">
              <Badge variant="outline" className="shrink-0 font-medium">
                {opt.label}
              </Badge>
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

      {/* The blocker ids the hold is waiting on (when known) — quiet, monospace. */}
      {kind === "blocked" && row.blockers.length > 0 && (
        <p className="mt-2 font-mono text-[11px] text-muted/80">
          blocked on: {row.blockers.join(", ")}
        </p>
      )}

      {/* The ONE prominent primary verb (CTL-903) — the payoff of the Inbox. */}
      <PaneVerb row={row} onAct={onAct} respondStatus={respondStatus} />
    </section>
  );
}

/** The About block (for ANY item): the one-line summary, the goal, and the HOME2
 *  phase strip for where-it's-at. Flat, no nested card; omitted fields render
 *  absent rather than fabricated. */
function About({ row }: { row: InboxRow }) {
  const about = aboutBlockFor(row, phaseIndexOf, isDoneStatus);
  const phaseLabel = about.done
    ? "Done"
    : isPhase(row.ticket.phase)
      ? PHASE_LABEL[row.ticket.phase]
      : row.ticket.phase;

  return (
    <section className="mt-6" data-pane-about>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">About</p>

      {about.summary != null && (
        <p className="mt-2 text-[13px] leading-relaxed text-fg" data-pane-summary>
          {about.summary}
        </p>
      )}

      {about.goal != null && (
        <p className="mt-2 text-[12px] leading-relaxed text-muted" data-pane-goal>
          <span className="text-muted/70">Goal — </span>
          {about.goal}
        </p>
      )}

      {/* Where it's at — the full HOME2 phase strip read. */}
      <div className="mt-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Where it's at</p>
        <div className="mt-2 flex items-center gap-3">
          <StatusIcon phase={row.ticket.phase} status={row.ticket.status} size={16} />
          <span className="text-[12px] text-muted">{phaseLabel}</span>
          <PhaseStrip phaseIndex={about.phaseIndex} />
        </div>
      </div>
    </section>
  );
}

export function ReadingPane({
  row,
  workers,
  onAct,
  respondStatus = "idle",
}: {
  row: InboxRow | null;
  /** The resident read-model workers — the View-in-Claude session id is the
   *  matching worker's `sessionId`. Defaults to [] so the pane is usable without
   *  a worker set (View-in-Claude is simply hidden then). */
  workers?: readonly BoardWorker[];
  /** CTL-903 (HOME5): fire the pane's prominent primary verb — record the
   *  operator's response + resume the agent. */
  onAct?: (id: string) => void;
  /** CTL-903 (HOME5): the optimistic write status for the selected row. */
  respondStatus?: RespondRowStatus;
}) {
  if (!row) return <NothingSelected />;

  const needsYou = isNeedsYouSection(row.section);
  const viewInClaude = viewInClaudeFor(row, workers ?? []);

  return (
    <ScrollArea className="h-full">
      <div data-reading-pane-id={row.id} className="flex flex-col px-6 py-5">
        {/* Header: the StatusIcon glyph + the key + the one-line ask (the bright
            subject). The glyph carries progress + stage in one slot. The
            View-in-Claude deep link is PROMINENT here (the row keeps it quiet) —
            and HIDDEN entirely when no session id is known (no dead link). */}
        <div className="flex items-start gap-3">
          <StatusIcon
            phase={row.ticket.phase}
            status={row.ticket.status}
            size={24}
            className="mt-0.5"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] font-semibold text-accent">{row.id}</span>
              <span className="text-[11px] text-muted">{row.subLabel}</span>
            </div>
            <h1 className="mt-1 text-[18px] leading-snug text-fg">{row.title}</h1>
          </div>

          {viewInClaude && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="shrink-0"
              data-view-in-claude={viewInClaude.sessionId}
            >
              <a
                href={viewInClaude.href}
                target="_blank"
                rel="noopener noreferrer"
                title="Open this agent's Claude Code session in a new tab"
              >
                View in Claude
                <ExternalLinkIcon className="size-3.5" />
              </a>
            </Button>
          )}
        </div>

        {/* What's needed now — the hero ask + decision options OR blocker detail
            + the ONE prominent primary verb (CTL-903). Only present for needs-you
            items (running/done carry no hero). */}
        {needsYou && <WhatsNeededNow row={row} onAct={onAct} respondStatus={respondStatus} />}

        <Separator className="mt-6" />

        {/* About — summary, goal, and the where-it's-at phase strip (for ANY item). */}
        <About row={row} />
      </div>
    </ScrollArea>
  );
}
