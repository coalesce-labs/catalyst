// ticket-detail-page.tsx — the ticket detail PAGE BODY (CTL-913 / DETAIL2,
// detail design §4). Drops into the shared <Shell> chrome's <DetailBody> slot
// (DETAIL1 owns the breadcrumb/pager/live-dot/Properties rail/footer; this owns
// the lifecycle aggregate body: header link · PIPELINE rail · HELD banner ·
// LIFECYCLE SPINE + compact-gantt toggle · COMMS · ACTIVITY).
//
// Sourced from RESIDENT board data ALONE — BoardTicket + phaseSummary, zero new
// endpoints. Every cell that needs backend plumbing it does not have yet renders
// DIMMED and HONEST (a "↯" NEEDS-PLUMBING marker), never empty or fabricated
// (design §4.2). Telemetry strips, run-record links, and the active-node live
// tail are added by trailing tickets (DETAIL6/DETAIL7) and degrade gracefully.
//
// The PURE derivations (pipeline placement, held tone, spine nodes, deep-link,
// channel, activity predicate) live in board/ticket-page-model.ts and are unit-
// tested without a DOM; this file is the thin React skin over them.

import { useCallback, useRef, useState } from "react";
import {
  resolvePipelineRail,
  resolveHeldBanner,
  resolveSpineNodes,
  linearDeepLink,
  orchChannelFor,
  activityPredicateForTicket,
  type PipelineSegment,
  type SpineNode,
} from "@/board/ticket-page-model";
import type { BoardTicket } from "@/board/types";
import { phaseColor, fmtDuration, fmtClock } from "@/lib/formatters";
import { TicketGantt } from "./ticket-gantt";
import { CommsView } from "./comms-view";
import { ActivityEventRow } from "./activity-event-row";
import { useActivityStream } from "@/hooks/use-activity";
import { useRepoColors } from "@/hooks/use-repo-colors";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { EmptyState } from "./ui/empty-state";
import { ListTree, MessageSquare, Radio } from "lucide-react";

// ── tokens (mirror Shell.tsx / Board.tsx inline-`C` palette; cyan reserved) ──
const C = {
  s1: "#111318",
  s2: "#171a21",
  border: "#262d36",
  fg: "#e6e9ef",
  fgMuted: "#8b93a1",
  fgDim: "#5b626f",
  cyan: "#5be0ff", // the reserved live signal — current phase / active node only
  red: "#ef5d5d",
  yellow: "#eab308",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/** A NEEDS-PLUMBING cell marker — dimmed "↯" + label. Never an invented value. */
function Needs({ label }: { label: string }) {
  return (
    <span
      data-needs-plumbing={label}
      title={`${label} — NEEDS-PLUMBING (DETAIL6/DETAIL7)`}
      style={{ color: C.fgDim, font: `10px ${C.mono}` }}
    >
      ↯ {label}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        font: `10px ${C.mono}`,
        letterSpacing: 1,
        color: C.fgMuted,
        textTransform: "uppercase",
        margin: "0 0 8px",
      }}
    >
      {children}
    </div>
  );
}

// ── Header (title link + meta) ───────────────────────────────────────────────
function Header({ ticket }: { ticket: BoardTicket }) {
  const link = linearDeepLink(ticket.id);
  return (
    <div data-ticket-header style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ font: `12px ${C.mono}`, color: C.fgMuted }}>{ticket.type}</span>
        <span style={{ color: C.fgDim }}>·</span>
        <span style={{ font: `12px ${C.mono}`, color: C.fgMuted }}>{ticket.repo}</span>
        <span style={{ color: C.fgDim }}>·</span>
        <span style={{ font: `12px ${C.mono}`, color: C.fgMuted }}>{ticket.team}</span>
        <span style={{ flex: 1 }} />
        {/* ↗ Linear deep-link; absent id → plain text (never a dead arrow). */}
        {link ? (
          <a
            data-linear-link
            href={link}
            target="_blank"
            rel="noreferrer noopener"
            style={{ font: `12px ${C.mono}`, color: "#4ea1ff", textDecoration: "none" }}
          >
            ↗ Linear
          </a>
        ) : (
          <span style={{ font: `12px ${C.mono}`, color: C.fgDim }}>{ticket.id}</span>
        )}
      </div>
    </div>
  );
}

// ── PIPELINE rail ─────────────────────────────────────────────────────────────
function PipelineRail({
  ticket,
  onSegmentClick,
}: {
  ticket: BoardTicket;
  onSegmentClick: (phase: string) => void;
}) {
  const segments = resolvePipelineRail(ticket);
  return (
    <section data-ticket-pipeline style={{ marginBottom: 16 }}>
      <SectionLabel>Pipeline</SectionLabel>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        {segments.map((seg, i) => (
          <PipelineSegmentChip
            key={seg.phase}
            seg={seg}
            isLast={i === segments.length - 1}
            onClick={() => onSegmentClick(seg.phase)}
          />
        ))}
      </div>
    </section>
  );
}

function PipelineSegmentChip({
  seg,
  isLast,
  onClick,
}: {
  seg: PipelineSegment;
  isLast: boolean;
  onClick: () => void;
}) {
  const base = phaseColor(seg.phase);
  // current = cyan (the reserved live signal); past = solid phase color; future
  // = dotted ghost (muted, dashed border, no fill).
  const isCurrent = seg.placement === "current";
  const isFuture = seg.placement === "future";
  return (
    <>
      <button
        type="button"
        data-pipeline-segment={seg.phase}
        data-placement={seg.placement}
        onClick={onClick}
        title={`${seg.label}${seg.status ? ` · ${seg.status}` : ""} — click to scroll spine`}
        style={{
          font: `10px ${C.mono}`,
          letterSpacing: 0.4,
          padding: "2px 7px",
          borderRadius: 4,
          cursor: "pointer",
          color: isFuture ? C.fgDim : isCurrent ? "#04222a" : C.fg,
          background: isCurrent ? C.cyan : isFuture ? "transparent" : base + "33",
          border: isFuture
            ? `1px dashed ${C.border}`
            : `1px solid ${isCurrent ? C.cyan : base + "55"}`,
        }}
      >
        {seg.label}
      </button>
      {!isLast && <span style={{ color: C.fgDim, font: `10px ${C.mono}` }}>▸</span>}
    </>
  );
}

// ── HELD banner ────────────────────────────────────────────────────────────────
function HeldBanner({ ticket }: { ticket: BoardTicket }) {
  const held = resolveHeldBanner(ticket);
  if (!held) return null; // renders ONLY when held != null
  const borderColor = held.tone === "blocked" ? C.red : C.yellow;
  return (
    <section
      data-ticket-held={held.tone}
      style={{
        marginBottom: 16,
        padding: "8px 12px",
        borderRadius: 6,
        border: `1px solid ${borderColor}`,
        background: borderColor + "14",
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        font: `12px ${C.mono}`,
      }}
    >
      <span style={{ color: borderColor, fontWeight: 600 }}>
        ⚠ HELD · {held.tone}
      </span>
      {held.tone === "blocked" && (
        <span style={{ color: C.fgMuted }}>
          {held.blockers.length > 0 ? (
            <>
              waiting on{" "}
              {held.blockers.map((b, i) => (
                <span key={b}>
                  {i > 0 && ", "}
                  <span style={{ color: C.fg }}>{b}</span>
                </span>
              ))}
            </>
          ) : (
            <span style={{ color: C.fgDim }}>no blockers named</span>
          )}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {/* held-duration carries no timestamp — honest NEEDS-PLUMBING, never faked. */}
      <span style={{ color: C.fgMuted }}>
        held-duration <Needs label="NEEDS-PLUMBING" />
      </span>
    </section>
  );
}

// ── LIFECYCLE SPINE ─────────────────────────────────────────────────────────────
function LifecycleSpine({
  ticket,
  registerNode,
}: {
  ticket: BoardTicket;
  registerNode: (phase: string, el: HTMLDivElement | null) => void;
}) {
  const [compact, setCompact] = useState(false);
  const nodes = resolveSpineNodes(ticket);

  return (
    <section data-ticket-spine style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <SectionLabel>Lifecycle Spine</SectionLabel>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-spine-compact-toggle
          aria-pressed={compact}
          onClick={() => setCompact((v) => !v)}
          style={{
            font: `10px ${C.mono}`,
            color: compact ? C.fg : C.fgMuted,
            background: compact ? C.s2 : "transparent",
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            padding: "2px 8px",
            cursor: "pointer",
          }}
        >
          ⊟ compact
        </button>
      </div>

      {compact ? (
        // The [compact] toggle swaps in the existing TicketGantt over the SAME
        // phaseSummary data (design §4.2 — verified drop-in consumer).
        <div data-spine-gantt>
          <TicketGantt ticket={ticket} />
        </div>
      ) : nodes.length === 0 ? (
        <EmptyState icon={ListTree} message="No phases yet" />
      ) : (
        <div data-spine-nodes>
          {nodes.map((node) => (
            <SpineRow key={node.phase} node={node} registerNode={registerNode} />
          ))}
        </div>
      )}
    </section>
  );
}

function SpineRow({
  node,
  registerNode,
}: {
  node: SpineNode;
  registerNode: (phase: string, el: HTMLDivElement | null) => void;
}) {
  const color = phaseColor(node.phase);
  const started = node.startedAt ? fmtClock(new Date(Date.parse(node.startedAt))) : null;
  const completed = node.completedAt ? fmtClock(new Date(Date.parse(node.completedAt))) : null;
  return (
    <div
      ref={(el) => registerNode(node.phase, el)}
      data-spine-row={node.phase}
      {...(node.isActive ? { "data-spine-active": "true" } : {})}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "6px 8px",
        borderRadius: 5,
        marginBottom: 4,
        background: node.isActive ? C.cyan + "12" : C.s1,
        border: `1px solid ${node.isActive ? C.cyan + "55" : C.border}`,
        font: `11px ${C.mono}`,
      }}
    >
      {/* phase chip + active ring */}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, width: 110, flexShrink: 0 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: node.isActive ? C.cyan : color,
            flex: "0 0 auto",
          }}
        />
        <span style={{ color: C.fg }}>{node.label}</span>
      </span>

      {/* status */}
      <span style={{ width: 86, flexShrink: 0, color: C.fgMuted }}>{node.status}</span>

      {/* duration */}
      <span style={{ width: 64, flexShrink: 0, color: C.fgMuted, textAlign: "right" }}>
        {node.durationMs != null ? fmtDuration(node.durationMs) : "…"}
      </span>

      {/* started → completed */}
      <span style={{ width: 96, flexShrink: 0, color: C.fgDim }}>
        {started ?? "—"}
        {completed ? `–${completed}` : node.isActive ? "–now" : ""}
      </span>

      {/* model — plumbed (BFF6); dimmed em-dash when the signal carried none */}
      <span style={{ width: 72, flexShrink: 0, color: node.model ? C.fgMuted : C.fgDim }}>
        {node.model ? `◆${node.model}` : "—"}
      </span>

      <span style={{ flex: 1 }} />

      {/* run-link / artifact / cost-sparkline — NEEDS-PLUMBING (DETAIL6/DETAIL7) */}
      <span style={{ display: "inline-flex", gap: 10, flexShrink: 0 }}>
        {node.costSparkline === "pending" && <Needs label="cost" />}
        {node.runLink === "pending" && <Needs label="run" />}
        {node.artifact === "pending" && <Needs label="artifact" />}
      </span>
    </div>
  );
}

// ── COMMS (collapsed → CommsView) ───────────────────────────────────────────────
function CommsSection({ ticket }: { ticket: BoardTicket }) {
  const [open, setOpen] = useState(false);
  const channel = orchChannelFor(ticket.id);
  return (
    <section data-ticket-comms style={{ marginBottom: 16 }}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          data-comms-toggle
          aria-expanded={open}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            font: `10px ${C.mono}`,
            letterSpacing: 1,
            color: C.fgMuted,
            textTransform: "uppercase",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: "4px 0",
          }}
        >
          <MessageSquare size={12} />
          <span>Comms</span>
          <span style={{ color: C.fgDim }}>{open ? "▾" : "▸"}</span>
          <span style={{ color: C.fgDim, textTransform: "none" }}>{channel}</span>
        </CollapsibleTrigger>
        <CollapsibleContent data-comms-content>
          {/* Reuses the existing CommsView, keyed to "orch-<id>" (design §4.2). */}
          {open && (
            <div style={{ marginTop: 8 }}>
              <CommsView
                initialFilter={{ channel, types: null, author: null }}
              />
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

// ── ACTIVITY (scoped live feed) ─────────────────────────────────────────────────
function ActivitySection({ ticket }: { ticket: BoardTicket }) {
  const predicate = activityPredicateForTicket(ticket.id);
  const { events, status, live } = useActivityStream(predicate);
  const repoColors = useRepoColors();
  // newest first (the backend returns chronological order, mirroring ActivityView)
  const ordered = [...events].reverse();

  return (
    <section data-ticket-activity style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <SectionLabel>Activity</SectionLabel>
        <span style={{ flex: 1 }} />
        <span style={{ font: `10px ${C.mono}`, color: live ? C.cyan : C.fgDim }}>
          {events.length} event{events.length === 1 ? "" : "s"}
          {live ? " · live" : ""}
        </span>
      </div>
      <div
        style={{
          maxHeight: 320,
          overflowY: "auto",
          borderRadius: 6,
          border: `1px solid ${C.border}`,
          background: C.s2,
        }}
      >
        {status === "loading" && events.length === 0 ? (
          <EmptyState icon={Radio} message="Connecting to activity stream…" />
        ) : ordered.length === 0 ? (
          <EmptyState icon={Radio} message="No activity for this ticket yet" />
        ) : (
          ordered.map((e, i) => (
            // The existing row renderer; cyan accents the active row internally.
            // No onPivot — the ticket page is a route, not a drawer-pivot host.
            <ActivityEventRow key={`${e.ts}-${i}`} event={e} repoColors={repoColors} />
          ))
        )}
      </div>
    </section>
  );
}

// ── page body ─────────────────────────────────────────────────────────────────
/**
 * The ticket detail page body. Renders inside the shared <Shell>'s <DetailBody>
 * slot (DETAIL1). `ticket` is the resident BoardTicket; when it is undefined (a
 * cold-linked Done ticket not in the resident payload) the body shows an honest
 * placeholder rather than a fabricated lifecycle (design §4 — resident-only).
 */
export function TicketDetailPage({ ticket }: { ticket: BoardTicket | undefined }) {
  // Spine node refs so a PIPELINE segment click smooth-scrolls to its node.
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const registerNode = useCallback((phase: string, el: HTMLDivElement | null) => {
    if (el) nodeRefs.current.set(phase, el);
    else nodeRefs.current.delete(phase);
  }, []);
  const scrollToPhase = useCallback((phase: string) => {
    nodeRefs.current.get(phase)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  if (!ticket) {
    return (
      <div
        data-ticket-page-empty
        style={{ color: C.fgDim, font: `12px ${C.mono}` }}
      >
        This ticket is not in the resident board payload — its lifecycle is not
        available off resident data alone (a Done ticket off the board). Open it in
        Linear from the header.
      </div>
    );
  }

  return (
    <div data-ticket-page={ticket.id}>
      <Header ticket={ticket} />
      <PipelineRail ticket={ticket} onSegmentClick={scrollToPhase} />
      <HeldBanner ticket={ticket} />
      <LifecycleSpine ticket={ticket} registerNode={registerNode} />
      <CommsSection ticket={ticket} />
      <ActivitySection ticket={ticket} />
    </div>
  );
}
