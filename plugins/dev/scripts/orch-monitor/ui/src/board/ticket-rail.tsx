// ticket-rail.tsx — the ticket-detail FLOATING RAIL CARDS (CTL-1003 §B1/§B2).
// Replaces the flat ticket-rail-extra.tsx. The rail is a transparent column of
// separate floating cards (Properties · Labels · Project · Relations ·
// Dependencies) per _v3-ref-linear-rail-floating.png — each a bordered surface-1
// card with a collapsible sentence-case header (chevron), persisted open-state,
// and no visible scrollbar.
//
// Relations (§B2) are a readable list: a 14px state icon + the truncated ticket
// TITLE (not a bare-key pill), grouped under muted headers, first 5 + a "Show N
// more" expander, each row wrapped in a HoverCard (key · full title · status ·
// project · priority) — killing the wall-of-bare-keys (_v3-ref-current-relations).
//
// Fail-open / never-fabricate: a null labels/relations (unloaded or unavailable)
// shows the card with a dimmed "—"; an undefined Property value renders dimmed;
// off-board tickets (CTL-999) feed the same cards from the live fetch alone (the
// Dependencies card is omitted when there is no resident ticket / payload).

import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Box, ChevronDown, ChevronsUpDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { TicketDepSubGraph } from "./dependency-graph";
import { RelationStateIcon } from "@/components/relation-state-icon";
import { PriorityIcon } from "./Board";
import {
  readRailCollapsed,
  writeRailCollapsed,
  relationHiddenCount,
  RELATION_GROUP_LIMIT,
} from "./ticket-rail-model";
import type { BoardTicket } from "./types";
import type {
  LinearLabel,
  LinearRelationTarget,
  LinearRelations,
  LinearTicketState,
} from "@/components/use-linear-ticket";

const C = {
  s1: "#111318",
  border: "#262d36",
  fg: "#e6e9ef",
  fgMuted: "#8b93a1",
  fgDim: "#5b626f",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

const PRIORITY_LABEL = ["No priority", "Urgent", "High", "Medium", "Low"];

// ── RailCard — a floating collapsible card ───────────────────────────────────
function RailCard({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  // CONTROLLED open-state, seeded from + written through to localStorage so the
  // collapse persists across reloads (the §B1 Gherkin "collapse state persists").
  const [open, setOpen] = useState<boolean>(() => !readRailCollapsed(id));
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        writeRailCollapsed(id, !next);
      }}
      data-rail-card={id}
      className="rounded-lg border border-border bg-surface-1 px-3.5 py-3"
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between text-[13px] font-medium text-foreground">
        <span>{title}</span>
        <ChevronDown
          className={
            "size-3.5 text-muted-foreground transition-transform " +
            (open ? "" : "-rotate-90")
          }
        />
      </CollapsibleTrigger>
      <CollapsibleContent style={{ marginTop: 8 }}>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** The dimmed "—" placeholder for an unloaded / unavailable group value. */
function DimDash() {
  return <span style={{ font: `12px ${C.mono}`, color: C.fgDim }}>—</span>;
}

// ── Properties card ──────────────────────────────────────────────────────────
/** A shared cheap Property row: undefined value → dimmed, null → "—" lit. */
interface RailPropRow {
  label: string;
  value: string | null | undefined;
}

function PropRow({ row }: { row: RailPropRow }) {
  const unplumbed = row.value === undefined;
  return (
    <div
      data-rail-prop={row.label}
      data-unplumbed={unplumbed}
      style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "3px 0", fontSize: 12 }}
    >
      <span style={{ color: C.fgMuted }}>{row.label}</span>
      <span
        style={{
          font: `11px ${C.mono}`,
          color: unplumbed ? C.fgDim : C.fg,
          textAlign: "right",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.value == null ? "—" : row.value}
      </span>
    </div>
  );
}

function activeLabel(state: BoardTicket["activeState"], working: boolean): string {
  if (state === "active") return working ? "Working" : "Active";
  if (state === "stuck") return "Stuck";
  return "Settled";
}

/**
 * The shared cheap Property rows (CTL-1003 §B1: Priority/Estimate/Project rows
 * REMOVED — priority+estimate live on the title row, project gets its own card).
 * Resident ticket → AVAILABLE-NOW fields; off-board → Status from the live state,
 * everything else dimmed.
 */
function ticketRailRows(
  ticket: BoardTicket | undefined,
  linear: LinearTicketState,
): RailPropRow[] {
  if (ticket) {
    return [
      { label: "Status", value: `${ticket.linearState} · ${activeLabel(ticket.activeState, ticket.working)}` },
      { label: "Phase", value: ticket.phase },
      { label: "Repo", value: ticket.repo },
      { label: "Team", value: ticket.team },
      { label: "Updated", value: ticket.updatedAt },
      { label: "PR", value: ticket.pr != null ? `#${ticket.pr}` : null },
      { label: "Model (current phase)", value: ticket.model ?? null },
    ];
  }
  // Off-board (CTL-999): Status from the live Linear state; the rest dimmed.
  return [
    { label: "Status", value: linear.state?.name ?? undefined },
    { label: "Phase", value: undefined },
    { label: "Repo", value: undefined },
    { label: "Team", value: undefined },
    { label: "Updated", value: undefined },
    { label: "PR", value: undefined },
    { label: "Model (current phase)", value: undefined },
  ];
}

function PropertiesCard({
  ticket,
  linear,
}: {
  ticket: BoardTicket | undefined;
  linear: LinearTicketState;
}) {
  const rows = ticketRailRows(ticket, linear);
  return (
    <RailCard id="properties" title="Properties">
      <div data-rail-properties>
        {rows.map((r) => (
          <PropRow key={r.label} row={r} />
        ))}
      </div>
    </RailCard>
  );
}

// ── Labels card ──────────────────────────────────────────────────────────────
function LabelsCard({ labels }: { labels: LinearLabel[] | null }) {
  return (
    <RailCard id="labels" title="Labels">
      <div data-rail-labels>
        {labels == null || labels.length === 0 ? (
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
    </RailCard>
  );
}

// ── Project card ─────────────────────────────────────────────────────────────
function ProjectCard({ project }: { project: string | null }) {
  return (
    <RailCard id="project" title="Project">
      <div data-rail-project style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
        {project == null ? (
          <DimDash />
        ) : (
          <>
            <Box className="size-3.5 text-muted-foreground" />
            <span style={{ fontSize: 12.5, color: C.fg }}>{project}</span>
          </>
        )}
      </div>
    </RailCard>
  );
}

// ── Relations card (§B2) ─────────────────────────────────────────────────────
const PRIORITY_BARS_LABEL: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

/** One relation row: state icon + truncated title, wrapped in a HoverCard. */
function RelationRow({ r }: { r: LinearRelationTarget }) {
  const stateType = r.state?.type ?? "unstarted";
  const title = r.title ?? r.identifier;
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Link
          data-relation-row={r.identifier}
          to="/ticket/$id"
          params={{ id: r.identifier }}
          search={(prev) => prev}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "2px 0",
            textDecoration: "none",
            minWidth: 0,
          }}
        >
          <RelationStateIcon type={stateType} size={14} />
          <span
            style={{
              fontSize: 12.5,
              color: C.fg,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </span>
        </Link>
      </HoverCardTrigger>
      <HoverCardContent>
        <div data-relation-hover={r.identifier} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ font: `11px ${C.mono}`, color: C.fgMuted }}>{r.identifier}</span>
          <span style={{ fontSize: 13, lineHeight: 1.45, color: C.fg }}>
            {r.title ?? r.identifier}
          </span>
          {/* status · project · priority — each row omitted when its value is null. */}
          {r.state != null && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: C.fgMuted }}>
              <RelationStateIcon type={r.state.type} size={12} />
              {r.state.name}
            </span>
          )}
          {r.project != null && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: C.fgMuted }}>
              <Box className="size-3" />
              {r.project}
            </span>
          )}
          {r.priority != null && r.priority > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: C.fgMuted }}>
              <PriorityIcon p={r.priority} size={12} />
              {PRIORITY_BARS_LABEL[r.priority] ?? PRIORITY_LABEL[r.priority] ?? "—"}
            </span>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** One relation GROUP (Blocking / Blocked by / Related / Duplicate of): a muted
 *  header + first 5 rows + a "Show N more" toggle. */
function RelationGroup({ label, items }: { label: string; items: LinearRelationTarget[] }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = relationHiddenCount(items.length);
  const shown = expanded ? items : items.slice(0, RELATION_GROUP_LIMIT);
  return (
    <div data-relation-group={label} style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, color: C.fgMuted, marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {shown.map((r) => (
          <RelationRow key={r.identifier} r={r} />
        ))}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          data-relation-show-more={label}
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            marginTop: 2,
            padding: 0,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: 12,
            color: C.fgMuted,
          }}
        >
          <ChevronsUpDown className="size-3.5" />
          {expanded ? "Show less" : `Show ${hidden} more`}
        </button>
      )}
    </div>
  );
}

function RelationsCard({
  relations,
  loaded,
}: {
  relations: LinearRelations | null;
  loaded: boolean;
}) {
  const groups: Array<{ label: string; items: LinearRelationTarget[] }> = relations
    ? [
        { label: "Blocked by", items: relations.blockedBy },
        { label: "Blocks", items: relations.blocks },
        { label: "Related", items: relations.related },
        { label: "Duplicate of", items: relations.duplicateOf },
      ].filter((g) => g.items.length > 0)
    : [];
  const showDash = relations == null || (loaded && groups.length === 0);
  return (
    <RailCard id="relations" title="Relations">
      <div data-rail-relations>
        {showDash ? (
          <DimDash />
        ) : (
          groups.map((g) => <RelationGroup key={g.label} label={g.label} items={g.items} />)
        )}
      </div>
    </RailCard>
  );
}

// ── Dependencies card (resident-only) ────────────────────────────────────────
function DependenciesCard({ ticket, tickets }: { ticket: BoardTicket; tickets: BoardTicket[] }) {
  return (
    <RailCard id="dependencies" title="Dependencies">
      <div data-rail-deps style={{ overflow: "hidden", width: "100%" }}>
        <TicketDepSubGraph focusId={ticket.id} tickets={tickets} height={220} />
      </div>
    </RailCard>
  );
}

/**
 * TicketRailCards — the floating rail column (CTL-1003 §B1/§B2). Rendered through
 * Shell's `rail` slot so the worker page's flat rail is untouched. Cards in order:
 * Properties · Labels · Project · Relations · Dependencies (Dependencies only when
 * resident && tickets.length > 0).
 */
export function TicketRailCards({
  linear,
  ticket,
  tickets,
}: {
  linear: LinearTicketState;
  ticket: BoardTicket | undefined;
  tickets: BoardTicket[];
}) {
  // Resident project wins; off-board falls back to the live Linear project.
  const project = ticket ? (ticket.project ?? null) : (linear.project ?? null);
  return (
    <aside
      data-shell-rail
      className="no-scrollbar"
      style={{
        width: 280,
        flex: "0 0 280px",
        background: "transparent",
        padding: "12px 12px",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <PropertiesCard ticket={ticket} linear={linear} />
      <LabelsCard labels={linear.labels} />
      <ProjectCard project={project} />
      <RelationsCard relations={linear.relations} loaded={linear.loaded} />
      {ticket && tickets.length > 0 && (
        <DependenciesCard ticket={ticket} tickets={tickets} />
      )}
    </aside>
  );
}
