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

export function ReadingPane({ row }: { row: InboxRow | null }) {
  if (!row) return <NothingSelected />;

  const needsYou = isNeedsYouSection(row.section);

  return (
    <div data-reading-pane-id={row.id} className="flex h-full flex-col px-6 py-5">
      {/* Header: the key + the one-line ask (the bright subject of the pane). */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] font-semibold text-accent">{row.id}</span>
        <span className="text-[11px] text-muted">{row.subLabel}</span>
      </div>
      <h1 className="mt-1 text-[18px] leading-snug text-fg">{row.title}</h1>

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
