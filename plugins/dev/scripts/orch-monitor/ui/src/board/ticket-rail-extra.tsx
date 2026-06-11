// ticket-rail-extra.tsx — the ticket-detail v2 consolidated rail content
// (CTL-996 §B6). Mirrors the worker-page rail idiom (worker-rail-extra.tsx): the
// Shell renders this below its Properties divider via the `railExtra` slot, so
// the operator reads Properties · Labels · Relations · Dependencies in ONE
// column. Tickets never set `railExtra` before this ticket — this adds it (the
// worker rail is untouched; the Shell contract is unchanged).
//
// THREE groups, each a flat section (no nested card/border) divided by the same
// borderTop the Shell uses between rail groups:
//   1. LABELS       — colour-tinted pills from linear.labels (null → dim "—")
//   2. RELATIONS    — Blocked by / Blocks / Related / Duplicate of, ticket-ref
//                     pills as SPA Links (scope preserved); null → header + "—"
//   3. DEPENDENCIES — the per-ticket dep sub-graph, MOVED out of the body here,
//                     sized to the rail's inner width.
//
// Fail-open (the never-fabricate discipline): a null labels/relations (unloaded
// or Linear-unavailable) shows the group header + a dimmed "—", never empty or
// invented. An empty (loaded) relation sub-row simply does not render.

import { Link } from "@tanstack/react-router";
import { TicketDepSubGraph } from "./dependency-graph";
import type { BoardTicket } from "./types";
import type { LinearLabel, LinearRelations } from "../components/use-linear-ticket";

const C = {
  border: "#262d36",
  fg: "#e6e9ef",
  fgMuted: "#8b93a1",
  fgDim: "#5b626f",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        font: `11px ${C.mono}`,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: C.fgMuted,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

/** The dimmed "—" placeholder for an unloaded / unavailable group value. */
function DimDash() {
  return <span style={{ font: `12px ${C.mono}`, color: C.fgDim }}>—</span>;
}

// ── LABELS ───────────────────────────────────────────────────────────────────
function LabelsGroup({ labels }: { labels: LinearLabel[] | null }) {
  return (
    <div data-ticket-rail-labels>
      <SectionHeading>Labels</SectionHeading>
      {labels == null ? (
        <DimDash />
      ) : labels.length === 0 ? (
        <DimDash />
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {labels.map((l) => (
            <span
              key={l.name}
              data-label-pill={l.name}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "1px 8px",
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 500,
                lineHeight: "18px",
                color: l.color,
                background: `color-mix(in srgb, ${l.color} 14%, transparent)`,
                border: `1px solid color-mix(in srgb, ${l.color} 30%, transparent)`,
                whiteSpace: "nowrap",
              }}
            >
              {l.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── RELATIONS ─────────────────────────────────────────────────────────────────
/** One relation sub-row (label + ticket-ref pills). Rendered only when ids are
 *  non-empty (the parent gates on that). */
function RelationRow({ label, ids }: { label: string; ids: string[] }) {
  return (
    <div data-relation-row={label} style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 12, color: C.fgMuted, marginBottom: 3 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {ids.map((id) => (
          <Link
            key={id}
            data-relation-ref={id}
            to="/ticket/$id"
            params={{ id }}
            // preserve the current scope/context on the URL (same idiom as the
            // description's ticket-ref pills).
            search={(prev) => prev}
            // reuse the .ticket-ref-pill visual (mono 0.82em, accent tint).
            className="ticket-ref-pill"
          >
            {id}
          </Link>
        ))}
      </div>
    </div>
  );
}

function RelationsGroup({ relations, loaded }: { relations: LinearRelations | null; loaded: boolean }) {
  // null + loaded → header + dimmed "—" (honest unavailable). null + !loaded →
  // also dim (still loading). Non-null → render only the non-empty sub-rows.
  const rows: Array<{ label: string; ids: string[] }> = relations
    ? [
        { label: "Blocked by", ids: relations.blockedBy },
        { label: "Blocks", ids: relations.blocks },
        { label: "Related", ids: relations.related },
        { label: "Duplicate of", ids: relations.duplicateOf },
      ].filter((r) => r.ids.length > 0)
    : [];

  const showDash = relations == null || (loaded && rows.length === 0);

  return (
    <div data-ticket-rail-relations>
      <SectionHeading>Relations</SectionHeading>
      {showDash ? (
        <DimDash />
      ) : (
        rows.map((r) => <RelationRow key={r.label} label={r.label} ids={r.ids} />)
      )}
    </div>
  );
}

// ── DEPENDENCIES ──────────────────────────────────────────────────────────────
// The per-ticket dep sub-graph, MOVED here from the body (§B4). Wrapped in an
// overflow:hidden box sized to the rail's ~252px inner width and capped at 220px
// height with internal scroll so the @xyflow canvas compresses legibly in the
// narrow rail.
function DependenciesGroup({ ticket, tickets }: { ticket: BoardTicket; tickets: BoardTicket[] }) {
  if (tickets.length === 0) return null;
  return (
    <div data-ticket-rail-deps>
      <SectionHeading>Dependencies</SectionHeading>
      <div style={{ overflow: "hidden", width: "100%" }}>
        <TicketDepSubGraph focusId={ticket.id} tickets={tickets} height={220} />
      </div>
    </div>
  );
}

/**
 * The ticket-only rail-extra: Labels + Relations + Dependencies as grouped
 * sections, divided by the same borderTop the Shell uses between rail groups.
 * Rendered through the Shell's `railExtra` prop so the worker page's rail is
 * untouched.
 */
export function TicketRailExtra({
  linear,
  ticket,
  tickets,
}: {
  linear: { labels: LinearLabel[] | null; relations: LinearRelations | null; loaded: boolean };
  ticket: BoardTicket | undefined;
  tickets: BoardTicket[];
}) {
  return (
    <div data-ticket-rail-extra style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <LabelsGroup labels={linear.labels} />
      <div style={{ paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
        <RelationsGroup relations={linear.relations} loaded={linear.loaded} />
      </div>
      {ticket && tickets.length > 0 && (
        <div style={{ paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
          <DependenciesGroup ticket={ticket} tickets={tickets} />
        </div>
      )}
    </div>
  );
}
