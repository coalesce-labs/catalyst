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
import { cn } from "@/lib/utils";
import {
  isNeedsYouSection,
  rowDurationMs,
  type InboxRow as InboxRowModel,
} from "@/board/home-inbox";
import { fmtRelativeDuration } from "@/lib/formatters";
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
}: {
  row: InboxRowModel;
  selected: boolean;
  onSelect: (id: string) => void;
  /** CTL-901 (HOME3): the "current time" the relative duration is measured
   *  against, threaded from the surface so all rows agree on one clock (and so
   *  the cell stays honest under test). */
  now: number;
}) {
  const needsYou = isNeedsYouSection(row.section);
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
    <button
      type="button"
      data-inbox-row={row.id}
      data-selected={selected ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(row.id)}
      className={cn(
        // A flat row: full-width, left-aligned, NO border/box. The selected row
        // gets a subtle raised surface (not a card outline) so the reading pane's
        // subject is obvious without nesting.
        "group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors",
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

      {/* The single primary verb — present only on needs-you rows. Everything
          else (View in Claude / Snooze / Dismiss) is one click deeper (HOME4). */}
      {needsYou && row.verb && (
        <span
          className={cn(
            "mt-0.5 shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium",
            row.section === "blocked"
              ? "border-red/40 text-red"
              : "border-yellow/40 text-yellow",
          )}
        >
          {row.verb}
        </span>
      )}
    </button>
  );
}
