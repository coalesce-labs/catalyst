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
import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink as ExternalLinkIcon } from "lucide-react";

// CTL-1041: a small, restrained Claude logomark for the View-in-Claude pill — the
// Anthropic "spark" burst rendered as a single inline SVG (no asset, no network,
// inherits currentColor). Tasteful, not branded-loud: it sits as the leading mark
// on the pill, the external-link chevron stays as the trailing affordance.
function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {/* A 12-spoke radial burst (the Claude spark): four cardinal long spokes
          plus eight shorter diagonals, all from the center. */}
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M12 3.5V9M12 15v5.5M3.5 12H9M15 12h5.5" />
        <path d="M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3" opacity="0.85" />
      </g>
    </svg>
  );
}
import { isNeedsYouSection, type InboxRow } from "@/board/home-inbox";
import { isDoneStatus, isPhase, phaseIndexOf, PHASE_LABEL } from "@/board/phase-model";
import {
  aboutBlockFor,
  accountMismatchFor,
  accentFor,
  askFor,
  blockerFor,
  escalationExplanationFor,
  heroKindFor,
  optionsFor,
  viewInClaudeFor,
  type PaneAccent,
} from "@/board/reading-pane-model";
import { verbActionFor } from "@/board/respond-client";
import {
  artifactHref,
  fetchArtifacts,
  fetchInboxSummary,
  type TicketArtifact,
} from "@/board/inbox-read-client";
import type { RespondRowStatus } from "@/hooks/use-respond";
import type { BoardWorker } from "@/board/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { StatusIcon } from "./status-icon";
import { PhaseStrip } from "./phase-strip";
import {
  mergeSummaryIntoTicket,
  type InboxSummaryResponse,
} from "./inbox-summary-data";

// ── inbox summary fetch-on-select (CTL-1042) ──────────────────────────────────
type InboxSummaryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; response: InboxSummaryResponse }
  | { kind: "error" };

function useInboxSummary(
  ticket: string | undefined,
  phase: string | undefined,
  enabled: boolean,
): InboxSummaryState {
  const [state, setState] = useState<InboxSummaryState>({ kind: "idle" });
  useEffect(() => {
    if (!enabled || !ticket) {
      setState({ kind: "idle" });
      return;
    }
    let alive = true;
    setState({ kind: "loading" });
    // The literal fetch is isolated in inbox-read-client.ts (the read-path
    // mirror of respond-client.ts); the home tree's no-fetch invariant keeps
    // this component fetch-free, reaching the network only through that client.
    void (async () => {
      const result = await fetchInboxSummary(ticket, phase);
      if (!alive) return;
      setState(result.ok ? { kind: "loaded", response: result.response } : { kind: "error" });
    })();
    return () => { alive = false; };
  }, [ticket, phase, enabled]);
  return state;
}

// ── artifact deep-dive links (CTL-1042 Scenario 4) ───────────────────────────
type ArtifactsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; artifacts: TicketArtifact[] }
  | { kind: "error" };

function useArtifacts(ticket: string | undefined, enabled: boolean): ArtifactsState {
  const [state, setState] = useState<ArtifactsState>({ kind: "idle" });
  useEffect(() => {
    if (!enabled || !ticket) { setState({ kind: "idle" }); return; }
    let alive = true;
    setState({ kind: "loading" });
    void (async () => {
      const result = await fetchArtifacts(ticket);
      if (!alive) return;
      setState(result.ok ? { kind: "loaded", artifacts: result.artifacts } : { kind: "error" });
    })();
    return () => { alive = false; };
  }, [ticket, enabled]);
  return state;
}

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
  const escalation = escalationExplanationFor(row);

  // CTL-1110: needs-human rows with a structured explanation use the CTA-led card.
  if (escalation != null) {
    return (
      <section
        data-pane-hero="escalation"
        data-pane-accent="amber"
        data-pane-escalation
        className={cn("mt-4 rounded-sm py-3 pr-4 pl-4", accentClasses("amber"))}
      >
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
          What's needed now
        </p>

        {/* CTA row: imperative call-to-action + the Respond control. */}
        <div className="mt-1.5 flex flex-wrap items-start gap-3">
          {escalation.callToAction != null && (
            <p
              data-escalation-cta
              className="flex-1 text-[14px] font-medium leading-snug text-fg"
            >
              {escalation.callToAction}
            </p>
          )}
          <PaneVerb row={row} onAct={onAct} respondStatus={respondStatus} />
        </div>

        {/* Labelled explanation sections — each rendered only when non-null. */}
        {(
          [
            ["What this delivers", escalation.outcome, "outcome"],
            ["The problem", escalation.problem, "problem"],
            ["Why this needs you", escalation.whyYou, "why_you"],
            ["Why it couldn't self-heal", escalation.whyNotAuto, "why_not_auto"],
            ["What to do", escalation.whatToDo, "what_to_do"],
          ] as const
        )
          .filter(([, value]) => value != null)
          .map(([label, value, field]) => (
            <div key={field} className="mt-3" data-escalation-field={field}>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                {label}
              </p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-fg/90">{value}</p>
            </div>
          ))}
      </section>
    );
  }

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
  operatorAccount = null,
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
  /** CTL-1129: the operator identity (payload.daemonAccount) — compared against the
   *  session owner to decide the View-in-Claude mismatch warning. null ⇒ fail open. */
  operatorAccount?: string | null;
}) {
  if (!row) return <NothingSelected />;

  const needsYou = isNeedsYouSection(row.section);
  const viewInClaude = viewInClaudeFor(row, workers ?? []);
  // CTL-1129: account-mismatch view-model — null when there's no session to link.
  const mismatchInfo = viewInClaude ? accountMismatchFor(viewInClaude, operatorAccount) : null;

  // CTL-1042: lazy AI summary fetch — triggered only for needs-you items on select.
  const summaryState = useInboxSummary(row.id, row.ticket.phase, needsYou);
  // CTL-1042 Scenario 4: research/plan deep-dive links fetched alongside summary.
  const artifactsState = useArtifacts(row.id, needsYou);

  // Merge the AI summary into a shallow copy of the row's ticket when loaded.
  // Absent/null fields degrade to today's raw content (identity merge).
  const effectiveRow: InboxRow =
    summaryState.kind === "loaded"
      ? { ...row, ticket: mergeSummaryIntoTicket(row.ticket, summaryState.response) }
      : row;

  const docArtifacts =
    artifactsState.kind === "loaded"
      ? artifactsState.artifacts.filter((a) => a.kind === "research" || a.kind === "plan")
      : [];

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

          {/* Action pills: View-in-Claude (CTL-1041) + research/plan artifact links (CTL-1042).
              CTL-1129: the pill block is now a column so the amber mismatch warning
              sits below the pill row without displacing surrounding layout. */}
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {viewInClaude && (
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  data-view-in-claude={viewInClaude.sessionId}
                >
                  <a
                    href={viewInClaude.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open this agent's Claude Code session in a new tab"
                  >
                    <ClaudeMark className="size-3.5" />
                    View in Claude
                    {viewInClaude.ownerAccount && (
                      <span className="ml-1 text-[10px] text-muted opacity-75">
                        {viewInClaude.ownerAccount}
                      </span>
                    )}
                    <ExternalLinkIcon className="size-3.5" />
                  </a>
                </Button>
              )}
              {docArtifacts.map((a) => (
                <Button key={a.kind} asChild variant="outline" size="sm">
                  <a
                    href={artifactHref(row.id, a.kind)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open ${a.kind} doc`}
                    data-artifact-link={a.kind}
                  >
                    {a.kind === "research" ? "Research" : "Plan"}
                    <ExternalLinkIcon className="size-3.5" />
                  </a>
                </Button>
              ))}
            </div>
            {mismatchInfo?.mismatch && (
              <div
                data-account-mismatch
                className="flex flex-col gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px]"
              >
                <div className="font-medium text-amber-600 dark:text-amber-400">
                  Account mismatch — session owned by{" "}
                  <span className="font-mono">{mismatchInfo.ownerAccount}</span>
                </div>
                <div className="flex items-center gap-2 text-muted">
                  <span>Run on the daemon host:</span>
                  <code data-resume-command className="rounded bg-muted/40 px-1 font-mono">
                    {mismatchInfo.resumeCommand}
                  </code>
                  <button
                    type="button"
                    className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] hover:bg-muted/60"
                    onClick={() => void navigator.clipboard.writeText(mismatchInfo.resumeCommand)}
                    title="Copy to clipboard"
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* What's needed now — the hero ask + decision options OR blocker detail
            + the ONE prominent primary verb (CTL-903). Only present for needs-you
            items (running/done carry no hero). While the AI summary is loading,
            a subtle indicator appears; on load the merged content replaces raw. */}
        {needsYou && summaryState.kind === "loading" && (
          <p className="mt-3 text-[11px] text-muted/70" data-summarizing>
            Summarizing…
          </p>
        )}
        {needsYou && (
          <WhatsNeededNow row={effectiveRow} onAct={onAct} respondStatus={respondStatus} />
        )}

        <Separator className="mt-6" />

        {/* About — summary, goal, and the where-it's-at phase strip (for ANY item). */}
        <About row={effectiveRow} />
      </div>
    </ScrollArea>
  );
}
