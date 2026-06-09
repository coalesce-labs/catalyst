// inbox-row.tsx — ONE bare inbox row (CTL-899 / HOME1). The list itself is the
// container; this row is NOT a card. No border, no background box, no nested
// summary — just a flat row separated from its neighbour by the list's hairline
// divider (Direction A non-negotiable #1: "No card-in-card. Ever.").
//
// Row anatomy (Direction A): a 2px LEFT ACCENT (the section-meaning signal,
// present only on the needs-you rows — red blocked / amber waiting); a single
// Catalyst StatusIcon GLYPH (CTL-900 / HOME2) that encodes BOTH progress + stage,
// replacing the old text status/label chips; the monospace muted KEY; the
// one-line ASK (the bright line, the ticket title); a muted human SUB-LABEL; and
// the single primary VERB. Running/Done rows are fully neutral (no accent, no
// verb) — that's how 90% of the page de-alarms by subtraction.
//
// CTL-903 / HOME5 — the ONE bright verb is now a real ACTION button: clicking it
// fires the read-model write (record the response + resume the agent) instead of
// merely selecting the row. Everything else (View-in-Claude / Snooze / Dismiss)
// is DEMOTED to a hover-revealed `⋯` overflow menu so the row stays calm with one
// bright button (Direction A non-negotiable #3). Because the verb + overflow are
// real <button>s, the row itself is a clickable role="button" DIV (a <button>
// cannot legally nest interactive children) — keyboard/aria parity is preserved.
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  isNeedsYouSection,
  rowDurationMs,
  type InboxRow as InboxRowModel,
} from "@/board/home-inbox";
import { OVERFLOW_ACTIONS, verbActionFor } from "@/board/respond-client";
import type { RespondRowStatus } from "@/hooks/use-respond";
import { fmtRelativeDuration } from "@/lib/formatters";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusIcon } from "./status-icon";

/** Left-accent color per section. Only the needs-you sections carry an accent;
 *  running/done are intentionally accent-less (transparent). Reserved live cyan
 *  (#5be0ff) is deliberately NOT used here — accent = meaning, not liveness. */
function accentClass(section: InboxRowModel["section"]): string {
  if (section === "blocked") return "bg-red";
  if (section === "waiting") return "bg-yellow";
  return "bg-transparent";
}

export function InboxRow({
  row,
  selected,
  onSelect,
  now,
  onAct,
  respondStatus = "idle",
}: {
  row: InboxRowModel;
  selected: boolean;
  onSelect: (id: string) => void;
  /** CTL-901 (HOME3): the "current time" the relative duration is measured
   *  against, threaded from the surface so all rows agree on one clock (and so
   *  the cell stays honest under test). */
  now: number;
  /** CTL-903 (HOME5): fire the row's ONE bright verb — record the operator's
   *  response + resume the agent. Omitted for the neutral (running/done) sets,
   *  which carry no verb. */
  onAct?: (id: string) => void;
  /** CTL-903 (HOME5): the optimistic write status — `resuming` hides the verb
   *  and shows the in-flight affordance; `did-not-take` reinstates the verb and
   *  flags that the resume did not take. Defaults to `idle`. */
  respondStatus?: RespondRowStatus;
}) {
  const needsYou = isNeedsYouSection(row.section);
  const verbAction = verbActionFor(row);
  const blockerSuffix =
    row.section === "blocked" && row.blockers.length > 0
      ? ` · ${row.blockers.join(", ")}`
      : "";

  // CTL-901 (HOME3): the quiet relative duration — how long this row has been
  // waiting on you / blocked (held rows) or running in its current state
  // (running rows). null when there is no honest backing timestamp → we OMIT the
  // cell entirely rather than render a fabricated value (the "never fabricated"
  // Gherkin). The done set carries no live duration.
  const duration = fmtRelativeDuration(rowDurationMs(row, now));

  return (
    <div
      role="button"
      tabIndex={0}
      data-inbox-row={row.id}
      data-selected={selected ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(row.id)}
      onKeyDown={(e) => {
        // Enter / Space select the row (button parity) — but only when the row
        // itself is focused, so a keypress inside the verb/overflow isn't stolen.
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onSelect(row.id);
        }
      }}
      className={cn(
        // A flat row: full-width, left-aligned, NO border/box. The selected row
        // gets a subtle raised surface (not a card outline) so the reading pane's
        // subject is obvious without nesting.
        "group flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors",
        selected ? "bg-surface-2" : "hover:bg-surface-1",
      )}
    >
      {/* 2px left accent — the section-meaning signal, only on needs-you rows. */}
      <span
        aria-hidden
        className={cn("mt-0.5 h-9 w-0.5 shrink-0 rounded-full", accentClass(row.section))}
      />

      {/* The single Catalyst StatusIcon glyph — encodes progress (ring/pie fill =
          (phaseIndex+1)/total) AND stage (phase color). This REPLACES any text
          status badge on the row (Direction A: status is one glyph, not chips). */}
      <StatusIcon
        phase={row.ticket.phase}
        status={row.ticket.status}
        size={16}
        className="mt-0.5"
      />

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          {/* Monospace muted key. */}
          <span className="font-mono text-[11.5px] font-semibold text-accent">{row.id}</span>
          {/* The one-line ask — the bright line. Truncates to one line on the row;
              the full title lives in the reading pane (no nesting on the row). */}
          <span className="truncate text-[13px] text-fg">{row.title}</span>
        </span>
        {/* The muted human sub-label — plain language, one line. */}
        <span className="text-[11px] text-muted">
          {row.subLabel}
          {blockerSuffix}
        </span>
      </span>

      {/* The quiet relative duration — "how long has this needed me / been
          running". A muted, right-aligned figure (never an alarm). OMITTED
          entirely when there is no honest backing timestamp (held/running rows
          with no durable anchor, and every done row) so the row never shows a
          fabricated time. The data-* attributes let the headless suite assert
          the honest present/absent behaviour without a DOM. */}
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

      {/* The single primary VERB — present only on needs-you rows. Now a real
          ACTION button (CTL-903): clicking it records the response + resumes the
          agent (it does NOT select the row). While the optimistic write is in
          flight the verb is replaced by a quiet `resuming…` affordance; if the
          resume did not take within the grace window it reinstates the verb with
          a "didn't take" note. Everything else (View in Claude / Snooze /
          Dismiss) is DEMOTED to the hover-revealed `⋯` overflow menu. */}
      {needsYou && verbAction && (
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
                // The verb acts; it must NOT bubble up to select the row.
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

          {/* "It didn't take" — the optimistic rollback surfaced (the resume did
              not happen within the grace window). Quiet, never an alarm. */}
          {respondStatus === "did-not-take" && (
            <span
              data-row-did-not-take={row.id}
              title="The agent did not resume — try again."
              className="text-[10px] text-muted"
            >
              didn't take
            </span>
          )}

          {/* The DEMOTED actions — hover-revealed `⋯` overflow (View in Claude /
              Snooze / Dismiss), kept OFF the bright button so the row stays calm.
              These are presentational placeholders here (HOME5 ships the WRITE
              path; View-in-Claude's live target is the reading pane, HOME4). */}
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
      )}
    </div>
  );
}
