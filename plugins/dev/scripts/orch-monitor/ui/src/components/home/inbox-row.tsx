// inbox-row.tsx — ONE bare inbox row (CTL-899 / HOME1). The list itself is the
// container; this row is NOT a card. No border, no background box, no nested
// summary — just a flat row separated from its neighbour by the list's hairline
// divider (Direction A non-negotiable #1: "No card-in-card. Ever.").
//
// Row anatomy (Direction A): a 2px LEFT ACCENT (the section-meaning signal,
// present only on the needs-you rows — red blocked / amber waiting); the project
// FAVICON (from the repo icon map, falls back to nothing when undiscovered); a
// single Catalyst StatusIcon GLYPH (CTL-900 / HOME2) that encodes BOTH progress
// + stage, replacing the old text status/label chips; the monospace muted KEY
// (shrink-0, never soft-wrapped); the two-line-clamped ASK (the bright line, the
// ticket title); a muted human SUB-LABEL. Running/Done rows are fully neutral (no
// accent) — that's how 90% of the page de-alarms by subtraction.
//
// The row is select-only: it carries no action affordances. The ONE bright verb
// (Respond/Unblock/Answer) lives exclusively in the reading pane's PaneVerb so
// the list stays calm. Because the row is a pure selection target (no nested
// interactive children), it may be a role="button" DIV — keyboard/aria parity
// is preserved via Enter/Space handlers.
import { cn } from "@/lib/utils";
import { rowDurationMs, type InboxRow as InboxRowModel } from "@/board/home-inbox";
import { rowFaviconSrc } from "@/board/entity-icon";
import { useRepoIconMap } from "@/board/repo-icon-context";
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
  const favicon = rowFaviconSrc(row.ticket.repo, useRepoIconMap());
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
        "flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors",
        selected ? "bg-surface-2" : "hover:bg-surface-1",
      )}
    >
      {/* 2px left accent — the section-meaning signal, only on needs-you rows. */}
      <span
        aria-hidden
        className={cn("mt-0.5 h-9 w-0.5 shrink-0 rounded-full", accentClass(row.section))}
      />

      {/* Project favicon (when discovered) + single Catalyst StatusIcon glyph.
          The favicon is decorative project identity; StatusIcon encodes progress
          + stage. Both are visible when a favicon exists; when none is discovered
          StatusIcon-only presentation is the fallback (today's default). */}
      {favicon != null && (
        <img
          src={favicon}
          alt=""
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0 rounded-sm"
        />
      )}
      <StatusIcon
        phase={row.ticket.phase}
        status={row.ticket.status}
        size={16}
        className="mt-0.5"
      />

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* Monospace muted key — shrink-0 + whitespace-nowrap so the key can
            never be squeezed or soft-wrapped at a narrow viewport. */}
        <span className="shrink-0 whitespace-nowrap font-mono text-[11.5px] font-semibold text-accent">{row.id}</span>
        {/* The ask — the bright line. Clamps to two lines on the row; the full
            title lives in the reading pane (no nesting on the row). */}
        <span className="line-clamp-2 text-[13px] text-fg">{row.title}</span>
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

    </div>
  );
}
