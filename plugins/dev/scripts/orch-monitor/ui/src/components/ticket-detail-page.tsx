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

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  resolveHeldBanner,
  resolvePipelineRail,
  linearDeepLink,
  phaseLabel,
  PIPELINE_PHASES,
  orchChannelFor,
  activityPredicateForTicket,
} from "@/board/ticket-page-model";
import {
  buildTelemetryTiles,
  resolveCostByPhase,
  resolveCostByModel,
  type TicketTelemetrySeries,
  type TelemetryTile,
  type BreakdownBars,
} from "@/board/ticket-telemetry-data";
import {
  appendLiveRows,
  deriveActiveNodeTail,
  resolveActivePhaseSession,
  parseStreamEvent,
  type ActiveNodeTail,
} from "@/board/live-tail-data";
import type { BoardTicket, BoardWorker } from "@/board/types";
import type { DetailSearch, DetailTab } from "@/board/route-search";
import type { StreamEvent } from "@/lib/types";
import { phaseColor, fmtCost, fmtTokens, statusSemantic, type StatusSemantic } from "@/lib/formatters";
import { Sparkline } from "./sparkline";
import { LifecycleTimeline } from "./ticket-lifecycle-timeline";
import { TicketGantt } from "./ticket-gantt";
import { CommsView } from "./comms-view";
import { ActivityEventRow } from "./activity-event-row";
import { useActivityStream } from "@/hooks/use-activity";
import { useRepoColors } from "@/hooks/use-repo-colors";
import { TabsContent } from "./ui/tabs";
import { PillTabs, type PillTab } from "./pill-tabs";
import { TicketBadge } from "./ui/ticket-badge";
import { TicketPhaseStepper } from "./ticket-phase-stepper";
import { PriorityIcon, ScopeChip } from "@/board/Board";
import { EmptyState } from "./ui/empty-state";
import { Radio } from "lucide-react";

// CTL-974: the markdown DESCRIPTION renderer is lazy-loaded so its heavy engine
// (marked-highlight + highlight.js) code-splits OUT of the board entry chunk
// (deliverable §3). The description already loads behind an async fetch, so the
// extra dynamic import adds no perceptible latency; the Suspense fallback reuses
// the same fixed-height skeleton as the not-yet-loaded state (no layout jump).
const TicketDescription = lazy(() =>
  import("./ticket-description").then((m) => ({ default: m.TicketDescription })),
);

/** The description block's fixed-height skeleton — shared by the Suspense
 *  fallback (chunk loading) AND the lazy component's own !loaded state, so the
 *  lifecycle spine below never jumps as the chunk + fetch resolve. */
function DescriptionSkeleton() {
  return (
    <div
      data-ticket-description-skeleton
      style={{ height: 18, color: C.fgDim, font: `12px ${C.mono}` }}
    >
      Loading description…
    </div>
  );
}

// ── tokens (mirror Shell.tsx / Board.tsx inline-`C` palette; cyan reserved) ──
const C = {
  s1: "#111318",
  s2: "#171a21",
  border: "#262d36",
  fg: "#e6e9ef",
  fgMuted: "#8b93a1",
  fgDim: "#5b626f",
  cyan: "#5be0ff", // the reserved live signal — current phase / active node only
  green: "#39d07a", // shipped/merged success tone (NOT cyan — cyan stays "live now")
  red: "#ef5d5d",
  yellow: "#eab308",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/** A NEEDS-PLUMBING cell marker — dimmed "↯" + label. Never an invented value. */
function Needs({ label }: { label: string }) {
  return (
    <span
      data-needs-plumbing={label}
      title={`${label} — NEEDS-PLUMBING`}
      style={{ color: C.fgDim, font: `10px ${C.mono}` }}
    >
      ↯ {label}
    </span>
  );
}

// ── Ticket artifact links (CTL-953) ─────────────────────────────────────────
/** One artifact returned by /api/ticket-artifacts/<id>. */
interface TicketArtifact {
  kind: "research" | "plan" | string;
  path: string;
  peek: string | null;
}

/** /api/ticket-artifacts/<id> response shape. */
interface ArtifactsResponse {
  ticket: string;
  artifacts: TicketArtifact[];
  crossNodeCaveat?: string;
}

/** Fetch the ticket's research/plan artifact links from /api/ticket-artifacts.
 *  Returns an empty array while loading or on any error — the spine renders a
 *  dim placeholder when none exist, never a fabricated link. */
function useTicketArtifacts(ticketId: string): TicketArtifact[] {
  const [artifacts, setArtifacts] = useState<TicketArtifact[]>([]);
  useEffect(() => {
    if (!ticketId) return;
    let stop = false;
    fetch(`/api/ticket-artifacts/${encodeURIComponent(ticketId)}`)
      .then((r) => r.ok ? r.json() as Promise<ArtifactsResponse> : null)
      .then((body) => {
        if (!stop && body?.artifacts) setArtifacts(body.artifacts);
      })
      .catch(() => {});
    return () => { stop = true; };
  }, [ticketId]);
  return artifacts;
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

// ── status-strip helpers ─────────────────────────────────────────────────────
/** A status semantic → its dark-token colour (for the icon + colored text in the
 *  status strip — no pill bg, the Linear idiom). */
const SEMANTIC_COLOR: Record<StatusSemantic, string> = {
  success: C.green,
  info: "#4ea1ff",
  danger: C.red,
  warning: C.yellow,
  neutral: C.fgMuted,
};

function statusColorFor(linearState: string): string {
  return SEMANTIC_COLOR[statusSemantic(linearState.toLowerCase())];
}

// ── Type kinds eligible for the title-line type pill ─────────────────────────
const TYPE_KINDS = ["bug", "feature", "refactor", "docs", "chore", "test"] as const;

/** The first label whose name is a known type kind (off-board path uses this to
 *  derive a type pill from `linear.labels` when there is no resident `ticket`). */
function typeKindFromLabels(labels: { name: string }[] | null | undefined): string | null {
  if (!labels) return null;
  const hit = labels.find((l) => (TYPE_KINDS as readonly string[]).includes(l.name));
  return hit?.name ?? null;
}

// ── PhaseChip (CTL-1003 §A4) ─────────────────────────────────────────────────
// The compact "where it stands" affordance in the status row — replaces the old
// pipeline strip + SETTLED box. An 8px phase-color dot + the phase label inside a
// small ghost pill; clicking it opens the Lifecycle tab (where the full stepper +
// gantt live). Placement math (phase N of 10) lifted from the deleted
// ticket-pipeline-indicator before it was removed (D6).
function PhaseChip({ ticket, onOpen }: { ticket: BoardTicket; onOpen: () => void }) {
  const segments = resolvePipelineRail(ticket);
  const idx = segments.findIndex((s) => s.placement === "current");
  const phaseNum = idx >= 0 ? idx + 1 : segments.length;
  const total = PIPELINE_PHASES.length; // 10
  return (
    <button
      type="button"
      data-phase-chip
      onClick={onOpen}
      title={`Phase ${phaseNum} of ${total} — open Lifecycle`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 22,
        padding: "0 9px",
        borderRadius: 999,
        border: `1px solid ${C.border}`,
        background: "transparent",
        fontSize: 12,
        color: C.fgMuted,
        cursor: "pointer",
      }}
    >
      <span
        style={{ width: 8, height: 8, borderRadius: "50%", background: phaseColor(ticket.phase), display: "inline-block" }}
      />
      {phaseLabel(ticket.phase)}
    </button>
  );
}

// ── Reading-column header: the SINGLE title <h1> + the status row ────────────
// CTL-1003 §A4: a calm title row. The type pill sits at the END of the title line
// (inside the <h1>); the status row carries the state dot+text, a compact phase
// chip (opens Lifecycle), Linear signal-bars priority, a board-style points pill,
// and the right-aligned ↗ Linear. The SETTLED/Shipped box, the pipeline strip,
// and the floating mono key are GONE (D5/D6).
//
// Generalised to a VIEW-MODEL so off-board tickets (CTL-999) render the same row
// from the live Linear fetch alone: `ticket` may be undefined; each field falls
// back to its `linear.*` counterpart.
function ReadingHeader({
  id,
  title,
  stateName,
  priority,
  estimate,
  estimateDisplay,
  typeKind,
  ticket,
  onOpenLifecycle,
}: {
  id: string;
  title: string;
  /** linearState (resident) or linear.state.name (off-board); null → dim "—" dot. */
  stateName: string | null;
  priority: number | null;
  estimate: number | null;
  estimateDisplay: string | null;
  /** type pill kind (bug/feature/…) or null (no pill). */
  typeKind: string | null;
  /** resident ticket — drives the PhaseChip (resident-only); undefined off-board. */
  ticket: BoardTicket | undefined;
  onOpenLifecycle: () => void;
}) {
  const link = linearDeepLink(id);
  const stateColor = stateName != null ? statusColorFor(stateName) : C.fgDim;
  const showPriority = priority != null && priority > 0;
  return (
    <div data-ticket-header style={{ marginBottom: 0 }}>
      <h1
        data-ticket-title
        style={{
          margin: "0 0 14px",
          color: C.fg,
          letterSpacing: "-0.01em",
          font: "600 21px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
        }}
      >
        {title}
        {/* §A4 D2: the type pill at the END of the title line, inline in the h1. */}
        {typeKind && (
          <span style={{ marginLeft: 10, verticalAlign: "3px" }}>
            <TicketBadge kind={typeKind} />
          </span>
        )}
      </h1>
      {/* Status row: state dot+text · phase chip · signal-bars priority · points
          pill · ↗ Linear (right-aligned). */}
      <div
        data-ticket-status-strip
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          fontSize: 12,
        }}
      >
        {/* Status: colored dot + state name in the status color, no bg. */}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: stateColor,
              display: "inline-block",
            }}
          />
          <span style={{ color: stateColor, fontWeight: 500 }}>
            {stateName ?? "—"}
          </span>
        </span>
        {/* Phase chip (resident-only): opens the Lifecycle tab. */}
        {ticket && <PhaseChip ticket={ticket} onOpen={onOpenLifecycle} />}
        {/* Priority — Linear signal bars + P{n} (omitted when no priority). */}
        {showPriority && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <PriorityIcon p={priority} size={13} />
            <span style={{ color: C.fgMuted }}>P{priority}</span>
          </span>
        )}
        {/* Estimate — the SAME board-card points pill; omitted when null. */}
        {estimate != null && (
          <ScopeChip scope={null} estimate={estimate} estimateDisplay={estimateDisplay ?? String(estimate)} />
        )}
        <span style={{ flex: 1 }} />
        {/* ↗ Linear deep-link, right-aligned; absent id → plain text. */}
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
          <span style={{ font: `12px ${C.mono}`, color: C.fgDim }}>{id}</span>
        )}
      </div>
    </div>
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

// ── active-node live tail (CTL-918 / DETAIL7, design §4.2) ───────────────────
// The active spine node tails the SAME per-phase live source as the worker
// [live] tab — the BFF SSE /api/ec-worker-stream/<sessionId>, keyed by the
// running phase's sessionId (resolved from the resident live workers). It shows
// `now: <current tool> · turn N · ctx%` plus a 3-line in-loop tail. When there
// is no running phase (no sessionId) the active node renders its resident cells
// only — never an empty live tail.
function useActiveNodeTail(sessionId: string | null): ActiveNodeTail {
  const [buffer, setBuffer] = useState<StreamEvent[]>([]);

  useEffect(() => {
    setBuffer([]);
    if (!sessionId) return;
    const es = new EventSource(
      `/api/ec-worker-stream/${encodeURIComponent(sessionId)}`,
    );
    es.addEventListener("stream-event", (ev: MessageEvent<string>) => {
      const row = parseStreamEvent(ev.data);
      if (row) setBuffer((prev) => appendLiveRows(prev, [row]));
    });
    // EventSource auto-reconnects; we don't surface a connection state here (the
    // node falls back to its resident cells when no rows arrive).
    return () => es.close();
  }, [sessionId]);

  return useMemo(() => deriveActiveNodeTail(buffer), [buffer]);
}

function ActiveNodeTailView({ tail }: { tail: ActiveNodeTail }) {
  // Never blank: while no rows have arrived the active node keeps its resident
  // phase/status/duration/model cells (rendered by SpineRow) — this returns null
  // rather than an empty tail box.
  if (!tail.hasRows) return null;
  const ctx = tail.contextPct != null ? `${tail.contextPct}%` : "—";
  return (
    <div
      data-active-node-tail
      style={{
        marginTop: 4,
        marginLeft: 22,
        paddingLeft: 10,
        borderLeft: `1px solid ${C.cyan}55`,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      {/* now: <current tool> · turn N · ctx% — the live "here right now" line. */}
      <div data-active-node-now style={{ font: `11px ${C.mono}`, color: C.cyan }}>
        now: <span style={{ color: C.fg }}>{tail.currentTool ?? "…"}</span>
        <span style={{ color: C.fgDim }}> · turn {tail.turn ?? "—"} · ctx </span>
        <span data-active-node-ctx style={{ color: tail.contextPct != null ? C.fg : C.fgDim }}>{ctx}</span>
      </div>
      {/* the 3-line in-loop tail (the newest rows). */}
      <div data-active-node-lines style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {tail.tail.map((r, i) => (
          <div key={`${r.ts}-${i}`} style={{ font: `10px ${C.mono}`, color: C.fgMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <span style={{ color: C.fgDim }}>&gt; </span>
            {activeNodeRowText(r)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Single-line text for one in-loop tail row (mirrors the live StreamEventRow's
 *  text choice, condensed for the 3-line spine tail). */
function activeNodeRowText(r: StreamEvent): string {
  switch (r.type) {
    case "tool_start":
      return `${r.tool ?? "tool"}${r.toolInput ? ` ${r.toolInput.slice(0, 48)}` : ""}`;
    case "reasoning":
      return `◌ ${r.text?.slice(0, 56) ?? "thinking…"}`;
    case "text":
      return r.text?.slice(0, 64) ?? "…";
    case "turn":
      return r.turnTools && r.turnTools.length > 0 ? r.turnTools.join(", ") : "new turn";
    case "retry":
      return `retry ${r.retryInfo?.attempt}/${r.retryInfo?.maxRetries}`;
    case "rate_limit":
      return "rate limited";
    default:
      return r.type;
  }
}

// ── COST summary line (DETAIL2-v2 §4c — the Overview money rollup) ───────────
/** One muted line so the operator sees the cost/tokens/turns rollup on Overview
 *  without leaving the tab; the full breakdown lives in the Cost tab. Each value
 *  dims to "—" when null (honest, never fabricated). */
function CostSummaryLine({ ticket }: { ticket: BoardTicket }) {
  return (
    <div
      data-ticket-cost-summary
      style={{ font: `11px ${C.mono}`, color: C.fgMuted, marginBottom: 16 }}
    >
      total{" "}
      <span style={{ color: ticket.costUSD != null ? C.fg : C.fgDim }}>
        {ticket.costUSD != null ? fmtCost(ticket.costUSD) : "—"}
      </span>
      <span style={{ color: C.fgDim }}> · </span>
      <span style={{ color: ticket.tokens != null ? C.fg : C.fgDim }}>
        {ticket.tokens != null ? fmtTokens(ticket.tokens) : "—"}
      </span>{" "}
      tokens
      <span style={{ color: C.fgDim }}> · </span>
      <span style={{ color: ticket.turns != null ? C.fg : C.fgDim }}>
        {ticket.turns != null ? ticket.turns : "—"}
      </span>{" "}
      turns
    </div>
  );
}

// ── COMMS (the Activity tab is the disclosure — no inner Collapsible) ────────
// v2: the Collapsible wrapper is dropped — opening the Activity tab IS the
// disclosure, so Comms renders inline under its sub-label (design DETAIL2-v2 §6).
function CommsSection({ ticket }: { ticket: BoardTicket }) {
  const channel = orchChannelFor(ticket.id);
  return (
    <section data-ticket-comms style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <SectionLabel>Comms</SectionLabel>
        <span style={{ color: C.fgDim, font: `10px ${C.mono}` }}>{channel}</span>
      </div>
      {/* Reuses the existing CommsView, keyed to "orch-<id>" (design §4.2). */}
      <CommsView initialFilter={{ channel, types: null, author: null }} />
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

// ── TELEMETRY strip (CTL-917 / DETAIL6) ─────────────────────────────────────
/** Fetch the ticket telemetry strip's REAL Prometheus sparklines for this Linear
 *  key. REAL today — no new plumbing. A 503 (Prometheus not configured) yields
 *  null series and the strip falls back to BoardTicket.{costUSD,tokens} +
 *  phaseCosts for an instant no-sparkline paint — never blank. Refreshes while
 *  the ticket is working so the live series grows. */
function useTicketTelemetry(id: string, working: boolean): TicketTelemetrySeries | null {
  const [series, setSeries] = useState<TicketTelemetrySeries | null>(null);

  useEffect(() => {
    if (!id) {
      setSeries(null);
      return;
    }
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/otel/ticket-telemetry/${encodeURIComponent(id)}?range=1h`);
        if (stop) return;
        if (res.ok) {
          const body = (await res.json()) as { data: TicketTelemetrySeries };
          setSeries(body.data ?? null);
        } else {
          setSeries(null); // 503 / 4xx → resident-scalar + phaseCosts fallback
        }
      } catch {
        if (!stop) setSeries(null);
      }
    };
    void load();
    const timer = working ? setInterval(() => void load(), 30_000) : null;
    return () => {
      stop = true;
      if (timer) clearInterval(timer);
    };
  }, [id, working]);

  return series;
}

function fmtTelemetryValue(tile: TelemetryTile): string {
  if (tile.value == null) return "—";
  if (tile.label === "COST") return fmtCost(tile.value);
  if (tile.label === "TOKENS") return fmtTokens(tile.value);
  return String(tile.value);
}

function TelemetryTileCell({ tile }: { tile: TelemetryTile }) {
  const live = tile.source === "sparkline";
  return (
    <div
      data-telemetry-tile={tile.label}
      data-source={tile.source}
      style={{
        flex: "1 1 0",
        minWidth: 110,
        background: C.s1,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <span style={{ font: `9px ${C.mono}`, letterSpacing: 1, color: C.fgMuted }}>{tile.label}</span>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ font: `13px ${C.mono}`, color: tile.value != null ? C.fg : C.fgDim, fontWeight: 600 }}>
          {fmtTelemetryValue(tile)}
        </span>
        {live && tile.points.length > 0 ? (
          <Sparkline points={tile.points} color={C.cyan} ariaLabel={`${tile.label} sparkline`} />
        ) : tile.source === "needs-plumbing" ? (
          <span title="git-sourced, not telemetry" style={{ font: `9px ${C.mono}`, color: C.fgDim }}>
            ↯ git
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** A horizontal bar group (cost-by-phase / cost-by-model). Bars are width-scaled
 *  to the max value; the unavailable source dims the whole group honestly. */
function BreakdownBarGroup({
  title,
  group,
  colorFor,
}: {
  title: string;
  group: BreakdownBars;
  colorFor: (label: string) => string;
}) {
  const max = group.bars.reduce((m, b) => Math.max(m, b.value), 0) || 1;
  return (
    <div data-breakdown={title} data-source={group.source} style={{ flex: "1 1 0", minWidth: 200 }}>
      <div style={{ font: `9px ${C.mono}`, letterSpacing: 1, color: C.fgMuted, marginBottom: 6 }}>
        {title}
        {group.source === "scalar-fallback" && (
          <span style={{ color: C.fgDim }}> · resident</span>
        )}
      </div>
      {group.source === "unavailable" || group.bars.length === 0 ? (
        <span data-breakdown-empty style={{ font: `10px ${C.mono}`, color: C.fgDim }}>
          ↯ no per-{title.includes("model") ? "model" : "phase"} split
        </span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {group.bars.map((b) => (
            <div key={b.label} data-breakdown-bar={b.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 72, flexShrink: 0, font: `10px ${C.mono}`, color: C.fgMuted, textAlign: "right" }}>
                {b.label}
              </span>
              <span
                style={{
                  height: 9,
                  borderRadius: 2,
                  background: colorFor(b.label),
                  width: `${Math.max(4, (b.value / max) * 100)}%`,
                  minWidth: 4,
                }}
              />
              <span style={{ font: `10px ${C.mono}`, color: C.fg, flexShrink: 0 }}>{fmtCost(b.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// A small palette for the per-model bars (cost-by-phase reuses phaseColor).
const MODEL_COLORS: Record<string, string> = {
  opus: "#a855f7",
  sonnet: "#3b82f6",
  haiku: "#10b981",
};
function modelColor(model: string): string {
  const key = Object.keys(MODEL_COLORS).find((k) => model.toLowerCase().includes(k));
  return key ? MODEL_COLORS[key] : "#64748b";
}

function TelemetryStrip({ ticket }: { ticket: BoardTicket }) {
  const series = useTicketTelemetry(ticket.id, ticket.working);
  const tiles = useMemo(() => buildTelemetryTiles(series, ticket), [series, ticket]);
  const byPhase = useMemo(() => resolveCostByPhase(series, ticket), [series, ticket]);
  const byModel = useMemo(() => resolveCostByModel(series), [series]);

  return (
    <section data-ticket-telemetry style={{ marginBottom: 16 }}>
      <SectionLabel>Telemetry</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        {tiles.map((t) => (
          <TelemetryTileCell key={t.label} tile={t} />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <BreakdownBarGroup title="cost by phase" group={byPhase} colorFor={phaseColor} />
        <BreakdownBarGroup title="cost by model" group={byModel} colorFor={modelColor} />
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
 * `workers` are the resident live bg workers (DETAIL7) — used to resolve the
 * running phase's sessionId so the active spine node can tail the live stream.
 */
export function TicketDetailPage({
  ticket,
  workers = [],
  realTitle = null,
  description = null,
  descLoaded = false,
  search,
}: {
  ticket: BoardTicket | undefined;
  workers?: BoardWorker[];
  /** CTL-974: the LIVE Linear title from /api/linear-ticket — wins over the
   *  stale board title in the Header; null falls back to the board title. */
  realTitle?: string | null;
  /** CTL-974: the LIVE Linear markdown description — the Spec tab lead. */
  description?: string | null;
  /** CTL-974: whether the live fetch has resolved (drives the honest skeleton
   *  vs honest-empty in the description block). */
  descLoaded?: boolean;
  /** CTL-996: the typed URL search params — `tab` drives the active tab and
   *  `pipeline` drives the Q3 indicator variant (URL = source of truth). */
  search: DetailSearch;
}) {
  // Spine node refs — LifecycleTimeline registers its nodes here (the Shell's
  // "g a" goto-active also relies on the data-spine-active attr these set).
  const nodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const registerNode = useCallback((phase: string, el: HTMLDivElement | null) => {
    if (el) nodeRefs.current.set(phase, el);
    else nodeRefs.current.delete(phase);
  }, []);

  // DETAIL7: the running phase's session for the active-node live tail. Resolved
  // from the resident live workers (the same per-phase live source the worker
  // [live] tab uses). Only the ticket's CURRENT, non-terminal phase has a live
  // worker; a settled ticket resolves to null (no tail, resident cells only).
  const activeSession = ticket
    ? resolveActivePhaseSession(
        ticket.id,
        ticket.working && ticket.activeState != null ? ticket.phase : null,
        workers,
      )
    : null;

  // Hooks must run unconditionally (before the empty-ticket early return). Both
  // guard an empty/null input internally, so an absent ticket is a no-op.
  // One SSE per ticket page, subscribed only while there IS a running phase.
  const activeNodeTail = useActiveNodeTail(activeSession);
  // CTL-953: artifact links from /api/ticket-artifacts — keyed by kind.
  const artifacts = useTicketArtifacts(ticket?.id ?? "");
  const artifactsByKind = useMemo<Record<string, TicketArtifact[]>>(() => {
    const map: Record<string, TicketArtifact[]> = {};
    for (const a of artifacts) {
      (map[a.kind] ??= []).push(a);
    }
    return map;
  }, [artifacts]);

  // CTL-996: URL-DRIVEN tab state (URL = source of truth, CTL-989). The active
  // tab is `search.tab` (absent = the `spec` default — `spec` is dropped from the
  // URL to keep it clean, same idiom as scope:"all"). Writes via TanStack
  // navigate with replace:true so tab switches don't pollute the back stack.
  const navigate = useNavigate();
  const value: "spec" | DetailTab = search.tab ?? "spec";
  const setTab = useCallback(
    (next: string) => {
      void navigate({
        to: ".",
        search: (prev) => ({
          ...prev,
          tab: next === "spec" ? undefined : (next as DetailTab),
        }),
        replace: true,
      });
    },
    [navigate],
  );
  const openLifecycle = useCallback(() => setTab("lifecycle"), [setTab]);

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
    // CTL-996 §B2: the 680px reading column, centered in the body area, 24px top
    // padding. The spec body is the hero; telemetry lives behind the Cost tab.
    <div
      data-ticket-page={ticket.id}
      style={{ maxWidth: 680, margin: "0 auto", paddingTop: 24 }}
    >
      {/* The SINGLE title + status row (CTL-1003 §A4: type pill on the title
          line, signal-bars priority, board points pill, compact phase chip). The
          SETTLED box + pipeline strip + floating mono key are gone. */}
      <ReadingHeader
        id={ticket.id}
        title={realTitle ?? ticket.title}
        stateName={ticket.linearState}
        priority={ticket.priority}
        estimate={ticket.estimate}
        estimateDisplay={ticket.estimateDisplay ?? null}
        typeKind={(TYPE_KINDS as readonly string[]).includes(ticket.type) ? ticket.type : null}
        ticket={ticket}
        onOpenLifecycle={openLifecycle}
      />

      {/* The HELD (blocked/waiting) banner stays in the reading view. */}
      <div style={{ marginTop: 16 }}>
        <HeldBanner ticket={ticket} />
      </div>

      {/* ── TABS — Spec (default) · Lifecycle · Cost · Activity ── */}
      <div style={{ marginTop: 20 }} data-ticket-tabs data-active-tab={value}>
        <PillTabs value={value} onValueChange={setTab} tabs={TAB_DEFS}>
          {/* Spec: the description prose — the hero, nothing else. */}
          <TabsContent value="spec">
            <div data-ticket-spec style={{ paddingTop: 16 }}>
              {(description || descLoaded) && (
                <section data-ticket-description-section>
                  <Suspense fallback={<DescriptionSkeleton />}>
                    <TicketDescription markdown={description} loaded={descLoaded} />
                  </Suspense>
                </section>
              )}
            </div>
          </TabsContent>

          {/* Lifecycle: educational phase stepper + the live LifecycleTimeline +
              live tail + the Gantt (moved OUT of the reading column for good). */}
          <TabsContent value="lifecycle">
            <div data-ticket-lifecycle style={{ paddingTop: 16 }}>
              <SectionLabel>The pipeline</SectionLabel>
              <TicketPhaseStepper ticket={ticket} />
              <SectionLabel>This ticket</SectionLabel>
              <LifecycleTimeline
                ticket={ticket}
                registerNode={registerNode}
                artifactsByKind={artifactsByKind}
                renderActiveTail={
                  activeNodeTail.hasRows ? <ActiveNodeTailView tail={activeNodeTail} /> : null
                }
              />
              <section data-ticket-gantt-section style={{ marginTop: 16 }}>
                <SectionLabel>Timeline</SectionLabel>
                <TicketGantt ticket={ticket} phaseCosts={ticket.phaseCosts} />
              </section>
            </div>
          </TabsContent>

          {/* Cost: the cost rollup line + the TelemetryStrip charts. */}
          <TabsContent value="cost">
            <div style={{ paddingTop: 16 }}>
              <CostSummaryLine ticket={ticket} />
              <TelemetryStrip ticket={ticket} />
            </div>
          </TabsContent>

          {/* Activity: the comms + scoped event feed (chatter). */}
          <TabsContent value="activity">
            <div style={{ paddingTop: 16 }}>
              <CommsSection ticket={ticket} />
              <ActivitySection ticket={ticket} />
            </div>
          </TabsContent>
        </PillTabs>
      </div>
    </div>
  );
}

/** The visible tab set (Spec default · Lifecycle · Cost · Activity). */
const TAB_DEFS: PillTab[] = [
  { value: "spec", label: "Spec" },
  { value: "lifecycle", label: "Lifecycle" },
  { value: "cost", label: "Cost" },
  { value: "activity", label: "Activity" },
];
