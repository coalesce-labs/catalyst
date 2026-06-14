// reading-pane.tsx — the master-detail READING PANE (CTL-902 / HOME4).
//
// CTL-1126: thin adapter — the header identity + hero block are now delegated
// to AttentionCard (variant="detail"). This file owns the Inbox chrome that is
// surface-specific: the View-in-Claude pills, the lazy AI summary fetch, the
// artifact deep-dive links, the Separator, and the About block.
import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink as ExternalLinkIcon } from "lucide-react";

// CTL-1041: a small, restrained Claude logomark for the View-in-Claude pill — the
// Anthropic "spark" burst rendered as a single inline SVG (no asset, no network,
// inherits currentColor). Tasteful, not branded-loud.
function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
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
  viewInClaudeFor,
} from "@/board/reading-pane-model";
import { modalityFor, escalationTypeFor } from "@/board/attention-card-model";
import {
  artifactHref,
  fetchArtifacts,
  fetchInboxSummary,
  type TicketArtifact,
} from "@/board/inbox-read-client";
import type { RespondRowStatus } from "@/hooks/use-respond";
import type { BoardWorker } from "@/board/types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { StatusIcon } from "./status-icon";
import { PhaseStrip } from "./phase-strip";
import {
  mergeSummaryIntoTicket,
  type InboxSummaryResponse,
} from "./inbox-summary-data";
import { AttentionCard } from "./attention-card";

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

/** Empty-pane state — shown when nothing is selected. */
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

  // CTL-1126: modality + escalationType for the shared AttentionCard.
  const modality = modalityFor(row.section);
  const escalationType = escalationTypeFor(effectiveRow);

  return (
    <ScrollArea className="h-full">
      <div data-reading-pane-id={row.id} className="flex flex-col px-6 py-5">
        {/* CTL-1126: header identity (StatusIcon 24 + key/subLabel/title) +
            hero block (escalation or standard) are delegated to AttentionCard. */}
        {needsYou && summaryState.kind === "loading" && (
          <p className="mt-3 text-[11px] text-muted/70" data-summarizing>
            Summarizing…
          </p>
        )}
        <AttentionCard
          row={effectiveRow}
          variant="detail"
          modality={modality}
          escalationType={escalationType}
          now={Date.now()}
          onAct={onAct}
          respondStatus={respondStatus}
        />

        {/* Action pills: View-in-Claude (CTL-1041) + research/plan artifact links
            (CTL-1042). Surface-specific chrome — stays in ReadingPane, not in
            AttentionCard (which is surface-agnostic). */}
        {(viewInClaude != null || docArtifacts.length > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
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
        )}

        <Separator className="mt-6" />

        {/* About — summary, goal, and the where-it's-at phase strip (for ANY item). */}
        <About row={effectiveRow} />
      </div>
    </ScrollArea>
  );
}
