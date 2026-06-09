// reading-pane.tsx — the master-detail READING PANE (CTL-899 / HOME1), STUBBED.
// The full reading pane ("What's needed now" + decision options / blocker +
// View in Claude + About) is HOME4's deliverable; this ticket stands up the
// master-detail wiring and stubs the pane body. What's load-bearing HERE is that
// selecting a row (click or j/k) drives THIS pane to that item — the CTL-899
// "Selecting a row updates the reading pane" Gherkin. So the stub faithfully
// reflects the SELECTED row (key, ask, sub-label, the blocker ids when blocked)
// and marks the deeper body as "arriving in HOME4", rather than being inert.
import { CheckCircle2 } from "lucide-react";
import { isNeedsYouSection, type InboxRow } from "@/board/home-inbox";
import { isDoneStatus, isPhase, phaseIndexOf, PHASE_LABEL } from "@/board/phase-model";
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

/** The compact "Where it's at" block (CTL-900 / HOME2) — a small glyph + the
 *  human phase label + the full done/current/pending phase strip. Flat, no
 *  nested card (Direction A). */
function WhereItsAt({ phase, status }: { phase: string; status: string }) {
  const phaseIndex = phaseIndexOf(phase);
  const done = isDoneStatus(status);
  const phaseLabel = done ? "Done" : isPhase(phase) ? PHASE_LABEL[phase] : phase;
  return (
    <div className="mt-6">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Where it's at</p>
      <div className="mt-2 flex items-center gap-3">
        <StatusIcon phase={phase} status={status} size={16} />
        <span className="text-[12px] text-muted">{phaseLabel}</span>
        <PhaseStrip phaseIndex={phaseIndex} />
      </div>
    </div>
  );
}

export function ReadingPane({ row }: { row: InboxRow | null }) {
  if (!row) return <NothingSelected />;

  const needsYou = isNeedsYouSection(row.section);

  return (
    <div data-reading-pane-id={row.id} className="flex h-full flex-col px-6 py-5">
      {/* Header: the StatusIcon glyph + the key + the one-line ask (the bright
          subject of the pane). The glyph carries progress + stage in one slot. */}
      <div className="flex items-start gap-3">
        <StatusIcon phase={row.ticket.phase} status={row.ticket.status} size={24} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] font-semibold text-accent">{row.id}</span>
            <span className="text-[11px] text-muted">{row.subLabel}</span>
          </div>
          <h1 className="mt-1 text-[18px] leading-snug text-fg">{row.title}</h1>
        </div>
      </div>

      {/* Where it's at — the full phase strip read. */}
      <WhereItsAt phase={row.ticket.phase} status={row.ticket.status} />

      {/* What's needed now — the needs-you cue. The decision options / blocker
          detail + the View-in-Claude deep link are HOME4. */}
      {needsYou && (
        <div className="mt-4 rounded-md border border-border bg-surface-1 px-4 py-3">
          <p className="text-[12px] font-medium text-fg">
            {row.section === "blocked" ? "Blocked — needs you to unblock" : "Waiting on your answer"}
          </p>
          {row.section === "blocked" && row.blockers.length > 0 && (
            <p className="mt-1 font-mono text-[11px] text-muted">
              blocked on: {row.blockers.join(", ")}
            </p>
          )}
          {row.verb && (
            <span className="mt-3 inline-block rounded-md border border-accent/40 px-3 py-1 text-[12px] font-medium text-accent">
              {row.verb}
            </span>
          )}
        </div>
      )}

      {/* The deeper body (full AI summary, phase spine, About) arrives in HOME4. */}
      <p className="mt-6 text-[12px] text-muted opacity-60">
        Full detail — summary, pipeline, and View in Claude — arrives with the reading-pane build (HOME4).
      </p>
    </div>
  );
}
