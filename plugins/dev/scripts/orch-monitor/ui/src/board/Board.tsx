import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useAtom } from "jotai";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { fmtDuration } from "../lib/formatters";
import {
  useReducedMotion,
  cardTransition,
  rowTransition,
  enterVariants,
  enterVariantsReduced,
  reduceTransition,
} from "./motion-utils";
// CTL-892 / SHELL2: the standalone-vs-embedded height token. The board fills the
// viewport standalone (100vh) and the inset slot embedded (100%); every scroll
// region below reads it through the --cat-board-vh CSS custom property.
import { boardRootHeight, BOARD_VH_VAR } from "../lib/surface-content";
// ── types + transport (hoisted to ./types + ./board-client for CTL-733 PR-2b) ─
import { connectBoard } from "./board-client";
// ── single ordering source (CTL-882 / FND2) ──────────────────────────────────
// The board renders ticket columns + the worker queue through resolveList so the
// detail-page pager (N/total) and the j/k walk read the SAME order. See
// list-order.ts — the P1 keystone correctness item.
import { sortWorkers } from "./list-order";
// ── CTL-897 / SHELL7: the SHARED workspace scope ──────────────────────────────
// The board's repo filter (the in-grid "All / <repo>" Seg) is bound to the SAME
// FND `repoScopeAtom` the workspace switcher writes, so scoping in the switcher
// (sidebar or top strip) and scoping in the board grid are ONE state — picking a
// repo in either reflects in the other and in the other surfaces. Standalone
// (board.html, no switcher) the board's Seg is simply the only writer.
import { useRepoScope } from "../hooks/use-repo-scope";
// ── CTL-942 + CTL-951: card → detail-page deep links ──────────────────────────
// A PLAIN single-click on a ticket/worker card (kanban OR list) navigates STRAIGHT
// to the full /ticket/$id // /worker/$id page (the drawer is removed). The nav is a
// real browser navigation because the Board mounts in BOTH entries and only the
// board.html entry carries the router (the server's SPA fallback answers it).
// `openDetail` captures the on-screen list + scroll + originating card into
// sessionStorage first, so Esc/back restores the board exactly. Cmd/Ctrl-click
// (and middle-click) still open the page in a NEW tab without disturbing the board.
import {
  isNewTabClick,
  openDetail,
  openDetailInNewTab,
  ticketDetailHref,
  workerDetailHref,
  type DetailKind,
} from "./detail-nav";
import type { DetailLens } from "./route-search";
// CTL-951: the board-restore effect re-applies the persisted scroll offset + the
// originating-card focus when the operator returns from a detail page;
// `resolveScrollEl` resolves the SAME `.cat-scroll` overflow container both the
// capture (on card open) and the restore read, so the offset round-trips.
import { useBoardRestore, resolveScrollEl } from "../hooks/use-board-restore";
// ── CTL-909 / SURF1: node grouping + node filter (pure, DOM-free) ─────────────
// The Workers surface adds a "node" grouping axis + a host filter that read the
// BoardWorker.host {name,id} field (BFF10/CTL-922). The column derivation lives
// in worker-grouping.ts so the Gherkin scenarios are unit-tested without a DOM;
// Board.tsx only renders the columns it returns. SINGLE-HOST is an identity
// no-op there (one node → one column, byte-for-byte the host-unaware order).
import {
  type WorkerGrouping,
  nodeColumns,
  workerHostNames,
  filterWorkersByHost,
  isMultiHost,
  HOST_FILTER_ALL,
  UNATTRIBUTED_HOST,
} from "./worker-grouping";
// ── per-node queue grouping (CTL-910 / SURF2) ─────────────────────────────────
// The waiting table attributes each row to its HRW owner host. queueHostMode is
// the single-host identity-no-op detector (one/zero distinct host → no node
// column, zero added noise); groupQueueByHost lifts the ranked queue into ordered
// per-node buckets WITHOUT disturbing the scheduler's global rank.
import {
  queueHostMode,
  groupQueueByHost,
  type QueueHostGroup,
} from "./queue-grouping";
// ── CTL-947: in-flight worker activity grouping ────────────────────────────────
// The in-flight table groups workers by activity state: active / waiting-on-user
// / waiting / stuck / blocked (bottom). groupWorkersByActivity is PURE (no DOM),
// unit-tested in queue-worker-grouping.test.ts.
import {
  groupWorkersByActivity,
  type WorkerActivitySection,
} from "./queue-worker-grouping";
// ── BOARD2 / CTL-906: the display-options popover + its persisted prefs ────────
// One toolbar button owns every board display choice (density / grouping /
// ordering / color / show-empty / repo-lanes). The three scattered subhead Seg
// toggles (lens, colorBy, repo-lanes) are folded into it; their state moves from
// local useState into the persisted boardPrefsAtom so the choices survive a
// reload. The PURE column-derivation (group-by column set + show-empty filter +
// in-column order) lives in board-display.ts so the Gherkin is DOM-free testable.
import { boardPrefsAtom, type Density } from "./prefs-store";
import { DisplayOptionsPopover } from "./display-options-popover";
// CTL-950: shared-header column derivation. `visibleColumnDefs` picks the single
// column SET the shared header shows (over EVERY lane combined); `laneColumns`
// distributes ONE lane's tickets across that fixed set (empty cells kept, aligned).
import { laneColumns, visibleColumnDefs, PHASE_COLUMNS, type BoardColumnDef } from "./board-display";
// ── BOARD3 / CTL-907 + CTL-950: row swimlanes (none | repo | team | project | host) ─
// The generalized grouping engine (board-grouping.ts) + the shared-header,
// single-scroll <SwimlaneBoard> (CTL-950): ONE sticky column-header row spanning
// the full width, the swimlane groups as horizontal bands BELOW it, every group's
// cards laid into the SAME shared column grid under ONE horizontal scroll axis.
// axis="none" collapses to the single shared-header column board (one synthetic
// lane, no group label). The shared `C` / `LIVE` tokens are in board-tokens.ts.
import { C, LIVE, PHASE, TYPE as TYPE_MAP, NODE_ACCENTS } from "./board-tokens";
import { SwimlaneBoard, type SharedColumn, type LaneCell } from "./Swimlane";
// ── BOARD4 / CTL-908: the dense List layout ────────────────────────────────────
// When the BOARD2 popover's Layout toggle is "list", the Tickets body renders the
// dense BoardList table instead of the column kanban — the SAME resolved entities,
// flattened into one ordered, sortable, swimlane-sectioned table. BoardList owns
// its own swimlane sectioning (groupListRows), so it is NOT wrapped in SwimlaneBoard.
import { BoardList } from "./BoardList";
import type { GroupBy } from "./board-grouping";
import type { Ordering } from "./list-order";
import type {
  BoardPayload,
  BoardQueueItem as QueueItem,
  BoardWorker as Worker,
  BoardTicket as Ticket,
  BoardActiveState as ActiveState,
} from "./types";
import type { ConnectionStatus } from "@/lib/types";

// ── tokens (orch-monitor DESIGN.md) ─────────────────────────────────────────
// CTL-930 Phase 4/5: phase/type/node tokens from canonical board-tokens.ts.
// PHASE_C is an inline literal so the drift guard (board-phase-drift.test.ts)
// can text-extract its keys; values match the Phase-4 board-tokens.ts palette.
// The PHASE alias (imported from board-tokens) is available for non-guarded use.
const PHASE_C: Record<string, string> = {
  triage: "#8492a4", research: "#5e9ee8", plan: "#a98ee3", implement: "#45c08a",
  verify: "#dba14f", remediate: "#d98ab2", review: "#cdb84e", pr: "#45bcab",
  "monitor-merge": "#5e9ee8", "monitor-deploy": "#41bd7d", teardown: "#788596",
  merge: "#5e9ee8", deploy: "#41bd7d", done: "#788596",
};
// BOARD2 / CTL-906: the ticket column SETS (linear / phase) now live in the pure
// board-display.ts (LINEAR_COLUMNS / PHASE_COLUMNS) so there is ONE definition
// the DOM-free column-derivation tests can read. The Workers phase lens reuses
// PHASE_COLUMNS from there. The worker status lens keeps its own two columns.
const WORKER_COLS = [
  { key: "active", label: "Active", c: LIVE }, { key: "stuck", label: "Stuck", c: C.red },
];
// Phase statuses that mean a phase is no longer running. MUST stay in lock-step
// with the TERMINAL set in lib/board-data.mjs (the data-layer source of truth) —
// board-phase-drift.test.ts asserts this array equals [...TERMINAL] so a new
// terminal status added there cannot silently render here as a live phase
// (CTL-754).
const TERMINAL_STATUSES = ["done", "failed", "stalled", "skipped", "signal_corrupt", "superseded", "canceled"];
// CTL-755 held-indicator label names. MUST stay in lock-step with
// execution-core/scheduler.mjs HELD_LABEL_BLOCKED / HELD_LABEL_WAITING (and the
// board-data.mjs copies) — the board-held-indicator drift guard asserts all
// three agree, so the badge below reads exactly the label the daemon writes.
const HELD_LABEL_BLOCKED = "blocked";
const HELD_LABEL_WAITING = "waiting";

// BOARD4 / CTL-908: the List view (BoardList.tsx) reuses these card atoms +
// formatters as its table cells, rather than re-implementing the live/priority/
// phase render (which would let the Board and List drift). They stay module-local
// to Board.tsx (the single source of truth); BOARD4 imports the named exports.
export type ColorBy = "phase" | "status" | "repo" | "type";
// CTL-930 Phase 5: type/repo/node accents from canonical board-tokens.ts.
const TYPE_C: Record<string, string> = TYPE_MAP;
const repoColor = (repo: string) => (repo === "adva" ? C.purple : C.blue);
const isActive = (s: ActiveState) => s === "active";
// CTL-909 / SURF1: a stable per-node accent so the "group by Node" columns +
// the host chip on each worker card carry a consistent color. Hashed from the
// host name (the unattributed bucket reads dim) — deterministic, no palette
// state, and the single-host case simply gets its one color.
const NODE_PALETTE = NODE_ACCENTS;
const nodeColor = (host: string): string => {
  if (host === UNATTRIBUTED_HOST) return C.fgDim;
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0;
  // `?? C.blue` covers the (unreachable, but type-honest) empty-palette case
  // without a non-null assertion — noUncheckedIndexedAccess types this as
  // string | undefined.
  return NODE_PALETTE[h % NODE_PALETTE.length] ?? C.blue;
};

export function accentFor(t: { phase: string; repo: string; type: string; activeState: ActiveState; status: string }, by: ColorBy): string {
  if (by === "phase") return PHASE_C[t.phase] || C.blue;
  if (by === "repo") return repoColor(t.repo);
  if (by === "type") return TYPE_C[t.type] || C.fgMuted;
  if (t.activeState === "active") return LIVE;
  if (t.activeState === "stuck" || t.status === "failed") return C.red;
  return C.fgDim;
}

export const fmtRuntime = (ms: number | null) => {
  if (!ms || !Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
export const fmtAgo = (iso: string) => {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};
export const fmtMsAgo = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
};

// CTL-930 Phase 5: live keyframes hoisted to app.css (available on all surfaces).
// PULSE_CSS retains only the board-local scroll styling.
const PULSE_CSS = `
.cat-scroll::-webkit-scrollbar { width:9px; height:9px; }
.cat-scroll::-webkit-scrollbar-thumb { background:${C.s4}; border-radius:6px; }
.cat-scroll::-webkit-scrollbar-track { background:transparent; }
`;

// ── domain viz (hand-rolled per DESIGN.md) ──────────────────────────────────
export function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block", flex: "0 0 auto", boxShadow: pulse ? `0 0 8px ${color}` : undefined }} />;
}
export function ActivityDot({ state, fallback }: { state: ActiveState; fallback: string }) {
  if (state === "active") return <span className="catalyst-live-dot" style={{ width: 8, height: 8, borderRadius: "50%", background: LIVE, display: "inline-block", flex: "0 0 auto" }} />;
  if (state === "stuck") return <Dot color={C.red} />;
  return <Dot color={fallback} />;
}
export function PhasePill({ phase }: { phase: string }) {
  const c = PHASE_C[phase] || C.blue;
  // muted treatment (dark tint bg + colored fg) — keeps phase identity without
  // a wall of fully-saturated pills competing with the status signal.
  return <span style={{ fontFamily: C.mono, fontSize: 10.5, padding: "1.5px 8px", borderRadius: 6, color: c, fontWeight: 600, background: `${c}22`, whiteSpace: "nowrap" }}>{phase}</span>;
}
function PhaseStrip({ phaseSummary }: { phaseSummary: { phase: string; status: string; durationMs: number | null }[] }) {
  if (!phaseSummary.length) return null;
  return (
    <div style={{ display: "flex", gap: 3, marginTop: 7, flexWrap: "wrap", alignItems: "center" }}>
      {phaseSummary.map((p) => {
        const c = PHASE_C[p.phase] || C.blue;
        const running = !TERMINAL_STATUSES.includes(p.status) && p.durationMs != null;
        return (
          <Tooltip key={p.phase}>
            <TooltipTrigger asChild>
              <span style={{
                width: 16, height: 4, borderRadius: 2, background: c,
                opacity: p.status === "failed" ? 0.4 : 1,
                outline: running ? `1px solid ${c}` : undefined,
                display: "inline-block", flex: "0 0 auto",
              }} />
            </TooltipTrigger>
            <TooltipContent style={{ fontFamily: C.mono, fontSize: 11 }}>
              {p.phase}{p.durationMs != null ? ` · ${fmtDuration(p.durationMs)}` : ""}
              {p.status === "failed" ? " · failed" : running ? " · running" : ""}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
const PRIORITY_LABEL = ["No priority", "Urgent", "High", "Medium", "Low"];
export function PriorityIcon({ p, size = 14 }: { p: number; size?: number }) {
  const icon = p === 1 ? (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-label="Urgent">
      <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill={C.orange} />
      <rect x="6.1" y="2.8" width="1.8" height="5.2" rx="0.9" fill="#1b1206" />
      <rect x="6.1" y="9.4" width="1.8" height="1.9" rx="0.95" fill="#1b1206" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-label={PRIORITY_LABEL[p]}>
      {[{ x: 1, h: 5 }, { x: 5.5, h: 9 }, { x: 10, h: 13 }].map((b, i) => {
        const filled = i < (p === 2 ? 3 : p === 3 ? 2 : p === 4 ? 1 : 0);
        return <rect key={i} x={b.x} y={14 - b.h} width="3" height={b.h} rx="1" fill={filled ? "#d3dae4" : "#424d5c"} />;
      })}
    </svg>
  );
  return (
    <Tooltip><TooltipTrigger asChild><span style={{ display: "inline-flex", flex: "0 0 auto" }}>{icon}</span></TooltipTrigger>
      <TooltipContent>{PRIORITY_LABEL[p] || "No priority"}</TooltipContent></Tooltip>
  );
}
const SCOPE_ABBR: Record<string, string> = { xs: "XS", small: "S", medium: "M", large: "L", xl: "XL" };
// CTL-957: one-estimate chip — show the Linear estimate (method-aware) when
// present, else fall back to the triage scope string. NEVER both.
// `estimateDisplay` is the pre-computed method-aware label from board-data.mjs
// (fibonacci → "5", tShirt → "M"); when present it takes sole precedence.
export function ScopeChip({ scope, estimate, estimateDisplay }: {
  scope: string | null;
  estimate: number | null;
  estimateDisplay?: string | null;
}) {
  // A real Linear estimate: show method-correct display label.
  if (estimateDisplay != null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" style={{ fontFamily: C.mono, fontSize: 10 }}>{estimateDisplay}</Badge>
        </TooltipTrigger>
        <TooltipContent>estimate: {estimate}</TooltipContent>
      </Tooltip>
    );
  }
  // No Linear estimate: fall back to triage scope string.
  if (!scope) return null;
  return (
    <Tooltip><TooltipTrigger asChild><Badge variant="outline" style={{ fontFamily: C.mono, fontSize: 10 }}>{SCOPE_ABBR[scope] || scope}</Badge></TooltipTrigger>
      <TooltipContent>scope: {scope}</TooltipContent></Tooltip>
  );
}
export function StatusBadge({ status }: { status: string }) {
  const meta: Record<string, { label: string; fg: string; bg: string }> = {
    failed: { label: "failed", fg: C.redSoft, bg: `${C.red}24` },
    stalled: { label: "stalled", fg: C.yellowSoft, bg: `${C.yellow}24` },
    aborted: { label: "aborted", fg: C.fgMuted, bg: C.s2 },
    superseded: { label: "superseded", fg: C.fgMuted, bg: C.s2 },
    skipped: { label: "skipped", fg: C.fgDim, bg: C.s1 },
  };
  const m = meta[status];
  if (!m) return null;
  return <span style={{ fontFamily: C.mono, fontSize: 10, padding: "1.5px 7px", borderRadius: 6, color: m.fg, background: m.bg, whiteSpace: "nowrap" }}>{m.label}</span>;
}
// CTL-755: held indicator. A triaged-waiting ticket the admission gate is
// holding before the triage→research promotion carries a `blocked` or `waiting`
// Linear label. We render a distinct amber "⏸" chip so an operator sees at a
// glance the ticket is HELD on a dependency (blocked, names the blocker ids) vs
// merely awaiting capacity/priority (waiting) — NOT silently mid-triage.
export function HeldBadge({ held, blockers }: { held: "blocked" | "waiting" | null | undefined; blockers?: string[] }) {
  if (held !== HELD_LABEL_BLOCKED && held !== HELD_LABEL_WAITING) return null;
  const isBlocked = held === HELD_LABEL_BLOCKED;
  const fg = isBlocked ? C.redSoft : C.yellowSoft;
  const bg = isBlocked ? `${C.red}24` : `${C.yellow}24`;
  const ids = (blockers ?? []).filter(Boolean);
  const label = isBlocked
    ? `⏸ blocked${ids.length ? `: ${ids.join(", ")}` : ""}`
    : "⏸ waiting";
  const tip = isBlocked
    ? ids.length
      ? `Held — blocked on open dependency: ${ids.join(", ")}`
      : "Held — blocked on an open dependency"
    : "Held — deps satisfied, awaiting capacity or priority";
  return (
    <Tooltip><TooltipTrigger asChild>
      <span style={{ fontFamily: C.mono, fontSize: 10, padding: "1.5px 7px", borderRadius: 6, color: fg, background: bg, whiteSpace: "nowrap", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", display: "inline-block" }}>{label}</span>
    </TooltipTrigger><TooltipContent style={{ fontFamily: C.mono, fontSize: 11 }}>{tip}</TooltipContent></Tooltip>
  );
}
// CTL-957: dependency chips — compact `blocked_by: X, Y` and `blocks: A`
// chips on every ticket card that has deps (not only held ones). Extends the
// HeldBadge pattern to all cards with dependencies regardless of held state.
// blockers[] = what this ticket waits on; blockedBy[] = tickets waiting on this.
// Both are optional; absent/empty → that direction is not rendered.
export function DepChips({ blockers, blockedBy }: { blockers?: string[]; blockedBy?: string[] }) {
  const fwd = (blockers ?? []).filter(Boolean);
  const rev = (blockedBy ?? []).filter(Boolean);
  if (!fwd.length && !rev.length) return null;
  return (
    <>
      {fwd.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span style={{ fontFamily: C.mono, fontSize: 10, padding: "1.5px 6px", borderRadius: 6, color: C.fgDim, background: C.s1, border: `1px solid ${C.borderSubtle}`, whiteSpace: "nowrap", cursor: "default" }}>
              {fwd.length === 1 ? `← ${fwd[0]}` : `← ${fwd.length}`}
            </span>
          </TooltipTrigger>
          <TooltipContent style={{ fontFamily: C.mono, fontSize: 11 }}>blocked by: {fwd.join(", ")}</TooltipContent>
        </Tooltip>
      )}
      {rev.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span style={{ fontFamily: C.mono, fontSize: 10, padding: "1.5px 6px", borderRadius: 6, color: C.fgDim, background: C.s1, border: `1px solid ${C.borderSubtle}`, whiteSpace: "nowrap", cursor: "default" }}>
              {rev.length === 1 ? `→ ${rev[0]}` : `→ ${rev.length}`}
            </span>
          </TooltipTrigger>
          <TooltipContent style={{ fontFamily: C.mono, fontSize: 11 }}>blocks: {rev.join(", ")}</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
export function Cost({ v }: { v: number | null }) {
  return <span style={{ fontFamily: C.mono, fontVariantNumeric: "tabular-nums", fontSize: 10.5, color: v == null ? C.fgDim : C.fgMuted }}>{v == null ? "—" : `$${v.toFixed(2)}`}</span>;
}
export function TitleText({ text, clamp = 2 }: { text: string; clamp?: number }) {
  return (
    <Tooltip><TooltipTrigger asChild>
      <div style={{ color: C.fg, fontSize: 13, lineHeight: 1.35, margin: clamp === 1 ? "5px 0 6px" : "7px 0 9px", display: "-webkit-box", WebkitLineClamp: clamp, WebkitBoxOrient: "vertical", overflow: "hidden", cursor: "default" }}>{text}</div>
    </TooltipTrigger><TooltipContent style={{ maxWidth: 360 }}>{text}</TooltipContent></Tooltip>
  );
}

// ── Linear-style ticket card ────────────────────────────────────────────────
// BOARD2 / CTL-906: `density` is a per-surface knob (default "comfortable" =
// today's full Linear anatomy). The "compact" path keeps the keystone signals —
// activity dot (the LIVE cyan), priority, ticket id, phase pill, held + status
// badges — and folds the secondary chips/strip/footer into ONE trailing meta
// line (~40% shorter card so more fit per column). The live ring + dim/saturate
// treatment is IDENTICAL in both densities — the live signal never degrades.
// CTL-951: the card-open callback the kanban + list cards share. The Board
// supplies it (resolving the on-screen scroll offset + the originating list ids);
// `ids` is the ordered id list of the card's own column (the walk list the pager
// + j/k inherit), `col`/`lens` mark the list-origin in the URL + breadcrumb.
type OpenDetailFn = (
  kind: DetailKind,
  id: string,
  ctx: { ids: string[]; lens?: DetailLens; col?: string },
) => void;

// CTL-952: motion.div gives each card a stable layoutId keyed by ticket id so
// when it moves between columns (phase change) the browser animates its position
// rather than jump-cutting. AnimatePresence (in the column container) handles
// enter/exit. `useReducedMotion` collapses everything to instant when the OS
// accessibility preference is set.
function TicketCard({ t, colorBy, density = "comfortable", colIds, lens, col, onOpen, blockedBy }: { t: Ticket; colorBy: ColorBy; density?: Density; colIds?: string[]; lens?: DetailLens; col?: string; onOpen?: OpenDetailFn; blockedBy?: string[] }) {
  const accent = accentFor(t, colorBy);
  const live = t.activeState === "active";
  const stuck = t.activeState === "stuck";
  const dim = t.activeState == null;
  const compact = density === "compact";
  const reduced = useReducedMotion();
  const variants = reduced ? enterVariantsReduced : enterVariants;
  const trans = reduceTransition(cardTransition, reduced);
  const open = (newTab: boolean) => {
    if (newTab) {
      openDetailInNewTab(ticketDetailHref(t.id));
      return;
    }
    onOpen?.("ticket", t.id, { ids: colIds ?? [t.id], lens, col });
  };
  return (
    <motion.div
      layoutId={`ticket-card-${t.id}`}
      layout="position"
      variants={variants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={trans}
      className={live ? "catalyst-live" : undefined}
      data-card-id={t.id}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      style={{
        background: live ? C.s3 : C.s2, borderRadius: 10, padding: compact ? "7px 10px" : "11px 13px",
        border: `1px solid ${stuck ? `${C.red}80` : dim ? C.borderSubtle : C.border}`,
        transition: "background .25s",
        cursor: onOpen ? "pointer" : undefined,
      }}
      // CTL-951: a PLAIN click navigates straight to /ticket/$id (the drawer is
      // gone). Cmd/Ctrl-click opens it in a new tab; middle-click is onAuxClick.
      onClick={(e) => {
        if (isNewTabClick(e)) {
          e.preventDefault();
          e.stopPropagation();
          open(true);
          return;
        }
        open(false);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          open(true);
        }
      }}
      onKeyDown={onOpen ? (e) => { if (e.key === "Enter" || e.key === " " || e.key === "o") { e.preventDefault(); open(false); } } : undefined}
    >
      <div style={{ display: "flex", alignItems: "center", gap: compact ? 5 : 7 }}>
        <ActivityDot state={t.activeState} fallback={accent} />
        <span style={{ fontFamily: C.mono, fontSize: 11.5, fontWeight: 600, color: C.blue }}>{t.id}</span>
        <span style={{ flex: 1 }} />
        {live && <span style={{ fontFamily: C.mono, fontSize: 10, color: LIVE }}>{t.working ? "working" : "active"}</span>}
        {stuck && <span style={{ fontFamily: C.mono, fontSize: 10, color: C.red }}>stuck</span>}
        {!compact && <Badge variant="secondary" style={{ fontFamily: C.mono, fontSize: 10 }}>{t.type}</Badge>}
      </div>
      <TitleText text={t.title} clamp={compact ? 1 : 2} />
      <div style={{ display: "flex", alignItems: "center", gap: compact ? 5 : 7, flexWrap: "wrap" }}>
        <PriorityIcon p={t.priority} />
        <PhasePill phase={t.phase} />
        <HeldBadge held={t.held} blockers={t.blockers} />
        <StatusBadge status={t.status} />
        {!compact && <ScopeChip scope={t.scope} estimate={t.estimate} estimateDisplay={t.estimateDisplay} />}
        {!compact && <DepChips blockers={t.blockers} blockedBy={blockedBy} />}
        {!compact && t.project && <Badge variant="outline" style={{ fontSize: 10, color: C.fgDim }}>{t.project}</Badge>}
      </div>
      {!compact && <PhaseStrip phaseSummary={t.phaseSummary} />}
      {compact ? (
        // one collapsed meta line: age · turns · (PR or cost)
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 6 }}>
          <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }}>{fmtAgo(t.updatedAt)}</span>
          <span style={{ flex: 1 }} />
          {t.turns != null && <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }} title="total turns">{t.turns}t</span>}
          {t.pr ? <span style={{ fontFamily: C.mono, fontSize: 10.5, color: C.green }}>#{t.pr}</span> : <Cost v={t.costUSD} />}
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 9 }}>
          <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }}>
            {t.activeState == null && t.status !== "done" ? `idle · ${fmtAgo(t.updatedAt)}` : fmtAgo(t.updatedAt)}
          </span>
          <span style={{ flex: 1 }} />
          {t.turns != null && <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }} title="total turns">{t.turns}t</span>}
          {t.pr ? <span style={{ fontFamily: C.mono, fontSize: 10.5, color: C.green }}>#{t.pr}</span> : <Cost v={t.costUSD} />}
        </div>
      )}
    </motion.div>
  );
}

// ── host chip — the worker's owning node (CTL-909 / SURF1) ────────────────────
// Renders the BoardWorker.host.name (BFF10/CTL-922). SINGLE-HOST: with one node
// every card shows the same name — it reads as a quiet provenance tag, not extra
// chrome; the moment a second node joins, the per-host color disambiguates them.
// A worker with no named host shows nothing (we never fabricate a host name).
function HostChip({ host }: { host: Worker["host"] }) {
  if (!host?.name) return null;
  const c = nodeColor(host.name);
  return (
    <Tooltip><TooltipTrigger asChild>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: C.mono, fontSize: 10, color: c, background: `${c}1f`, border: `1px solid ${c}3a`, padding: "0 6px", borderRadius: 5, whiteSpace: "nowrap" }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: c, display: "inline-block" }} />{host.name}
      </span>
    </TooltipTrigger><TooltipContent>node {host.name}</TooltipContent></Tooltip>
  );
}

// ── worker card (Workers board) ─────────────────────────────────────────────
// CTL-952: motion.div with layoutId keyed by worker name — same layout/enter/exit
// treatment as TicketCard. Workers move between Active/Stuck columns when their
// state changes; AnimatePresence in the column container triggers enter/exit.
function WorkerCard({ w, info, colIds, onOpen }: { w: Worker; info?: Ticket; colIds?: string[]; onOpen?: OpenDetailFn }) {
  const accent = PHASE_C[w.phase] || C.blue;
  const live = w.activeState === "active";
  const stuck = w.activeState === "stuck";
  const attempt = Number(/:(\d+)$/.exec(w.name)?.[1] ?? 1);
  const seen = w.lastActiveMs != null ? fmtMsAgo(w.lastActiveMs) : null;
  const reduced = useReducedMotion();
  const variants = reduced ? enterVariantsReduced : enterVariants;
  const trans = reduceTransition(cardTransition, reduced);
  const open = (newTab: boolean) => {
    if (newTab) {
      openDetailInNewTab(workerDetailHref(w.name));
      return;
    }
    onOpen?.("worker", w.name, { ids: colIds ?? [w.name] });
  };
  return (
    <motion.div
      layoutId={`worker-card-${w.name}`}
      layout="position"
      variants={variants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={trans}
      className={live ? "catalyst-live" : undefined}
      data-card-id={w.name}
      // CTL-951: a PLAIN click on a worker card navigates STRAIGHT to its
      // single-run detail page (`/worker/$id`, keyed by w.name). Cmd/Ctrl-click
      // (and middle-click via onAuxClick) open it in a NEW tab. The nav is a real
      // browser navigation — it works in BOTH entries (the server SPA fallback
      // serves board.html), and `openDetail` stashes the board-restore snapshot
      // first so Esc/back returns to the exact Workers grid state.
      onClick={(e) => {
        if (isNewTabClick(e)) {
          e.preventDefault();
          e.stopPropagation();
          open(true);
          return;
        }
        open(false);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          open(true);
        }
      }}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={onOpen ? (e) => { if (e.key === "Enter" || e.key === " " || e.key === "o") { e.preventDefault(); open(false); } } : undefined}
      style={{
        background: live ? C.s3 : C.s2, borderRadius: 10, padding: "11px 13px",
        border: `1px solid ${stuck ? `${C.red}80` : C.border}`,
        boxShadow: stuck ? `inset 2px 0 0 0 ${C.red}` : undefined,
        cursor: onOpen ? "pointer" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <ActivityDot state={w.activeState} fallback={accent} />
        <span style={{ fontFamily: C.mono, fontSize: 12.5, fontWeight: 700, color: C.blue }}>{w.ticket}</span>
        {w.sessionId && (
          <Tooltip><TooltipTrigger asChild>
            <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim, background: C.s1, border: `1px solid ${C.borderSubtle}`, padding: "0 5px", borderRadius: 5 }}>{w.sessionId.slice(0, 7)}</span>
          </TooltipTrigger><TooltipContent>worker {w.sessionId} · {w.name}</TooltipContent></Tooltip>
        )}
        {w.tickets.length > 1 && <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }}>+{w.tickets.length - 1}</span>}
        <span style={{ flex: 1 }} />
        {attempt > 1 && <span style={{ fontFamily: C.mono, fontSize: 10, color: C.yellow }}>retry #{attempt}</span>}
        <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }}>{fmtRuntime(w.runtimeMs)}</span>
      </div>
      {info?.title && <TitleText text={info.title} />}
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginTop: info?.title ? 0 : 9 }}>
        {info && <PriorityIcon p={info.priority} />}
        <PhasePill phase={w.phase} />
        {/* CTL-909 / SURF1: owning host.name on every worker card. */}
        <HostChip host={w.host} />
        <Badge variant="outline" style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }}>{w.repo}</Badge>
        {info?.model && <Badge variant="secondary" style={{ fontFamily: C.mono, fontSize: 10 }}>{info.model}</Badge>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 9 }}>
        <span style={{ fontFamily: C.mono, fontSize: 10, color: live ? LIVE : stuck ? C.red : C.fgDim }}>
          {live ? (w.working ? "working now" : seen ? `active · ${seen}` : "active") : stuck ? `stuck · ${seen ?? "?"}` : w.status}
        </span>
        <span style={{ flex: 1 }} />
        <Cost v={w.costUSD} />
      </div>
    </motion.div>
  );
}

// ── CTL-950 shared-header column derivation (tickets + workers) ───────────────
// The single-scroll <SwimlaneBoard> wants TWO things from the Board: the SHARED
// header column set (totals across EVERY lane), and a per-lane `deriveLane` that
// distributes ONE lane's entities across that fixed set into aligned LaneCells.
// The pure column logic stays in board-display.ts (tickets) / worker-grouping.ts
// (workers) so the on-screen order remains the SAME `resolveList` order the
// detail-page pager + j/k walk read (FND2 P1).

// Roll up per-lane derived columns into the shared header's totals — count + live
// summed across the lanes (so the top header chip reads the WHOLE board's depth).
function sharedHeaderTotals(
  defs: readonly BoardColumnDef[],
  perLaneCounts: { count: number; live: number }[][],
): SharedColumn[] {
  return defs.map((def, i) => {
    let count = 0;
    let live = 0;
    for (const lane of perLaneCounts) {
      const cell = lane[i];
      if (cell) { count += cell.count; live += cell.live; }
    }
    return { key: def.key, label: def.label, c: def.c, count, live };
  });
}

// CTL-957: build a reverse-dependency index from the full ticket set.
// blockedByIndex[ticketId] = ids of tickets whose blockers[] includes ticketId
// (i.e. the tickets that are waiting on ticketId to complete).
function buildBlockedByIndex(tickets: Ticket[]): Record<string, string[]> {
  const idx: Record<string, string[]> = {};
  for (const t of tickets) {
    for (const b of t.blockers ?? []) {
      if (!idx[b]) idx[b] = [];
      idx[b].push(t.id);
    }
  }
  return idx;
}

// The TICKET shared-header board: the column SET is `visibleColumnDefs` over the
// WHOLE ticket array (so a column the header shows is real in SOME lane); each
// lane's cards come from `laneColumns(laneItems, defs)` (empty cells kept). The
// card render + the column order are byte-identical to the legacy TicketBoard.
function TicketSwimlaneBoard({
  tickets, groupBy, swimlane, colorBy, density, order, showEmpty, fill, onOpen,
}: {
  tickets: Ticket[]; groupBy: "linear" | "phase"; swimlane: GroupBy; colorBy: ColorBy;
  density: Density; order: Ordering; showEmpty: boolean; fill: boolean; onOpen?: OpenDetailFn;
}) {
  const defs = visibleColumnDefs(tickets, { groupBy, showEmptyColumns: showEmpty });
  const blockedByIdx = buildBlockedByIndex(tickets);
  const deriveLane = (laneItems: Ticket[]): LaneCell[] =>
    laneColumns(laneItems, defs, { groupBy, order }).map((c) => {
      // CTL-951: each card carries its COLUMN's ordered ids — the exact walk list
      // the detail pager + j/k inherit (resolveList order, byte-identical to the
      // on-screen order). `col` = the column key (the list-origin in the URL).
      const colIds = c.items.map((t) => t.id);
      return {
        count: c.items.length,
        live: c.live,
        cards: c.items.map((t) => (
          <TicketCard key={t.id} t={t} colorBy={colorBy} density={density} colIds={colIds} lens={groupBy} col={c.key} onOpen={onOpen} blockedBy={blockedByIdx[t.id]} />
        )),
      };
    });
  // header totals = the lane cells across every lane combined (== the flat set).
  const columns = sharedHeaderTotals(defs, [deriveLane(tickets)]);
  return (
    <SwimlaneBoard
      items={tickets}
      groupBy={swimlane}
      fill={fill}
      entityNoun="ticket"
      columns={columns}
      deriveLane={deriveLane}
    />
  );
}

// The WORKER shared-header board. The column SET depends on the lens:
//   • node  → nodeColumns over ALL workers (so lanes share the same node columns),
//   • phase → PHASE_COLUMNS,           • status → WORKER_COLS (Active/Stuck).
// Each lane distributes its workers into that fixed set. R3b: when the HOST
// swimlane is active the caller already falls the lens back to status/phase so
// host is not double-encoded (rows AND columns).
function WorkerSwimlaneBoard({
  workers, tickets, swimlane, grouping, fill, onOpen,
}: {
  workers: Worker[]; tickets: Ticket[]; swimlane: GroupBy; grouping: WorkerGrouping;
  fill: boolean; onOpen?: OpenDetailFn;
}) {
  const infoById: Record<string, Ticket> = Object.fromEntries(tickets.map((t) => [t.id, t]));
  // CTL-951: the worker detail pager walks the WHOLE rank-sorted worker queue
  // (resolveList's worker branch is `sortWorkers(payload.workers)`, NOT per-column
  // — see list-order.ts), so every worker card carries the SAME full ordered id
  // list. This keeps the pager's N/total + j/k in lock-step with that single
  // queue order regardless of which swimlane/column the card is rendered in.
  const workerIds = sortWorkers(workers).map((w) => w.name);
  // The shared column DEFS (key/label/color), derived over the FULL worker set so
  // every lane lays into the same tracks.
  const defs: BoardColumnDef[] =
    grouping === "node"
      ? nodeColumns(workers).map((c) => ({ key: c.host, label: c.host, c: nodeColor(c.host) }))
      : grouping === "phase"
        ? PHASE_COLUMNS.map((c) => ({ key: c.key, label: c.label, c: c.c }))
        : WORKER_COLS.map((c) => ({ key: c.key, label: c.label, c: c.c }));
  const colWorkers = (laneItems: Worker[], key: string): Worker[] =>
    grouping === "node"
      ? sortWorkers(laneItems.filter((w) => (w.host?.name ?? UNATTRIBUTED_HOST) === key))
      : grouping === "phase"
        ? laneItems.filter((w) => w.phase === key)
        : laneItems.filter((w) => (w.activeState ?? "active") === key);
  const deriveLane = (laneItems: Worker[]): LaneCell[] =>
    defs.map((def) => {
      const items = colWorkers(laneItems, def.key);
      // Status columns are already split by liveness (Active/Stuck), so the "N
      // live" chip is redundant there; surface it only in the phase / node lens.
      const live = grouping === "status" ? 0 : items.filter((w) => w.activeState === "active").length;
      return {
        count: items.length,
        live,
        cards: items.map((w) => <WorkerCard key={w.name} w={w} info={infoById[w.ticket]} colIds={workerIds} onOpen={onOpen} />),
      };
    });
  const columns = sharedHeaderTotals(defs, [deriveLane(workers)]);
  return (
    <SwimlaneBoard
      items={workers}
      groupBy={swimlane}
      fill={fill}
      entityNoun="worker"
      columns={columns}
      deriveLane={deriveLane}
    />
  );
}
// BOARD3 / CTL-907: the repo-only `Lane` component is replaced by the generalized
// <Swimlane>/<SwimlaneBoard> (Swimlane.tsx), driven by the pure board-grouping
// engine over the full none|repo|team|project|host axis.

// ── capacity + queue ────────────────────────────────────────────────────────
function SlotBar({ capacity, inFlight }: { capacity: number; inFlight: number }) {
  const total = Math.max(capacity, inFlight, 1);
  const free = Math.max(0, capacity - inFlight), over = Math.max(0, inFlight - capacity);
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", gap: 4 }}>
        {Array.from({ length: total }).map((_, i) => {
          const filled = i < inFlight, isOver = i >= capacity;
          return <span key={i} style={{ flex: 1, height: 16, borderRadius: 4, background: filled ? (isOver ? C.red : C.blue) : "transparent", border: filled ? "none" : `1px solid ${C.border}` }} />;
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7, fontFamily: C.mono, fontSize: 11, color: C.fgDim }}>
        <span style={{ color: over ? C.red : C.fgDim }}>{inFlight} in flight{over ? ` · ${over} over capacity` : ""}</span>
        <span>capacity {capacity} · {free} free</span>
      </div>
    </div>
  );
}
function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", minWidth: 104 }}>
      <div style={{ fontSize: 11, color: C.fgDim, textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontFamily: C.mono, fontVariantNumeric: "tabular-nums", fontSize: 22, fontWeight: 700, color: color || C.fg, marginTop: 2 }}>{value}</div>
    </div>
  );
}
const th = { color: C.fgDim, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 0.6, fontWeight: 500 };
const td = { fontSize: 12.5, color: C.fg };
const mono = { fontFamily: C.mono, fontVariantNumeric: "tabular-nums" as const };
const ellip = { overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const };

// ── waiting-queue row + grouped body (CTL-910 / SURF2) ───────────────────────
// One waiting row. `showHost` adds the node column ONLY in a multi-node fleet —
// single-host collapses it away so the column adds no visual noise (the identity
// no-op). The host cell renders the owner name, or a dim "—" for an un-attributed
// row (host:null, e.g. before a fence claim).
// CTL-952: motion-enhanced TableRow for queue / in-flight animate-presence.
const MotionTableRow = motion.create(TableRow);

function QueueRow({ q, freeSlots, showHost }: { q: QueueItem; freeSlots: number; showHost: boolean }) {
  const reduced = useReducedMotion();
  const variants = reduced ? enterVariantsReduced : enterVariants;
  const trans = reduceTransition(rowTransition, reduced);
  return (
    <MotionTableRow
      variants={variants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={trans}
      style={{ background: q.rank <= freeSlots ? "rgba(57,208,122,0.06)" : undefined }}
    >
      <TableCell style={{ ...mono, color: C.fgMuted }}>{q.rank}</TableCell>
      <TableCell><PriorityIcon p={q.priority} /></TableCell>
      <TableCell style={{ ...mono, ...td, color: C.blue, fontWeight: 600 }}>{q.id}</TableCell>
      <TableCell style={{ ...td, ...ellip, maxWidth: 0 }}>{q.title}</TableCell>
      <TableCell><ScopeChip scope={q.scope} estimate={q.estimate} estimateDisplay={q.estimateDisplay} /></TableCell>
      <TableCell style={{ ...mono, fontSize: 11, color: C.fgDim }}>{q.repo}</TableCell>
      {showHost && (
        <TableCell style={{ ...mono, fontSize: 11, color: q.host ? C.fgMuted : C.fgDim }}>{q.host?.name ?? "—"}</TableCell>
      )}
    </MotionTableRow>
  );
}

// The waiting table. `grouped` (only offered in a multi-node fleet) splits the
// ranked queue into per-node sections so an operator can read per-node depth; the
// global rank within each section is preserved (groupQueueByHost never re-sorts).
function WaitingTable({ queue, freeSlots, showHost, grouped }: { queue: QueueItem[]; freeSlots: number; showHost: boolean; grouped: boolean }) {
  const header = (
    <TableHeader><TableRow style={{ background: C.s1 }}>
      <TableHead style={{ ...th, width: 40 }}>#</TableHead><TableHead style={{ ...th, width: 44 }}>Pri</TableHead>
      <TableHead style={{ ...th, width: 100 }}>Ticket</TableHead><TableHead style={th}>Title</TableHead>
      <TableHead style={{ ...th, width: 70 }}>Size</TableHead><TableHead style={{ ...th, width: 84 }}>Repo</TableHead>
      {showHost && <TableHead style={{ ...th, width: 130 }}>Node</TableHead>}
    </TableRow></TableHeader>
  );
  const colSpan = showHost ? 7 : 6;
  if (!grouped) {
    return (
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
        <Table>
          {header}
          <TableBody>
            {/* CTL-952: AnimatePresence for queue reorder enter/exit */}
            <AnimatePresence initial={false}>
              {queue.map((q) => <QueueRow key={q.id} q={q} freeSlots={freeSlots} showHost={showHost} />)}
            </AnimatePresence>
          </TableBody>
        </Table>
      </div>
    );
  }
  const groups: QueueHostGroup[] = groupQueueByHost(queue);
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
      <Table>
        {header}
        <TableBody>
          {groups.map((g) => (
            <Fragment key={g.host?.id ?? g.label}>
              <TableRow style={{ background: C.s1 }}>
                <TableCell colSpan={colSpan} style={{ ...mono, fontSize: 11, color: C.fgMuted, padding: "6px 12px" }}>
                  <span style={{ color: g.host ? C.fg : C.fgDim, fontWeight: 600 }}>{g.label}</span>
                  <span style={{ color: C.fgDim }}> · {g.items.length} queued</span>
                </TableCell>
              </TableRow>
              {/* CTL-952: AnimatePresence for grouped queue reorder */}
              <AnimatePresence initial={false}>
                {g.items.map((q) => <QueueRow key={q.id} q={q} freeSlots={freeSlots} showHost={showHost} />)}
              </AnimatePresence>
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// CTL-952: in-flight worker row — extracted from the inline QueueView map so the
// `useReducedMotion` hook call is valid (hooks must be called from a component).
function InflightWorkerRow({ w, ticket, blockers }: {
  w: Worker;
  ticket: Ticket | undefined;
  blockers: string[];
}) {
  const reduced = useReducedMotion();
  const variants = reduced ? enterVariantsReduced : enterVariants;
  const trans = reduceTransition(rowTransition, reduced);
  return (
    <MotionTableRow
      variants={variants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={trans}
      style={{ opacity: w.activeState === "stuck" ? 0.6 : 1 }}
    >
      <TableCell><ActivityDot state={w.activeState} fallback={PHASE_C[w.phase] || C.blue} /></TableCell>
      <TableCell><PriorityIcon p={ticket?.priority ?? 0} /></TableCell>
      <TableCell style={{ ...mono, ...td, color: C.blue, fontWeight: 600 }}>{w.ticket}</TableCell>
      <TableCell style={{ ...td, ...ellip, maxWidth: 0 }}>
        {ticket?.title || ""}
        {blockers.length > 0 && (
          <span style={{ marginLeft: 8, fontFamily: C.mono, fontSize: 10, color: C.red }}>
            blocked on: {blockers.join(", ")}
          </span>
        )}
      </TableCell>
      <TableCell><PhasePill phase={w.phase} /></TableCell>
      <TableCell style={{ ...mono, fontSize: 11, color: isActive(w.activeState) ? LIVE : w.activeState === "stuck" ? C.red : w.waitingOnUser ? C.yellow : C.fgDim }}>
        {workerStatusText(w)}
      </TableCell>
      <TableCell style={{ ...mono, fontSize: 11, color: C.fgDim }}>{fmtRuntime(w.runtimeMs)}</TableCell>
    </MotionTableRow>
  );
}

// CTL-910 / SURF2: the wide, ranked Queue surface. Promoted from the board's
// internal Queue tab into the shell as its own route (see QueueSurface, which
// connects the board transport and mounts this embedded). Reused near-verbatim
// from the original board Queue tab: capacity Stats + SlotBar + an in-flight table
// + a waiting ranked table. NEW for SURF2: an optional per-node column + a
// group-by-node toggle, both gated behind queueHostMode so a single-host fleet is
// an exact identity no-op (no node column, no toggle, no added noise).
// CTL-947: accent color for each activity group section header.
const WORKER_GROUP_C: Record<string, string> = {
  active: LIVE,
  "waiting-on-user": C.yellow,
  waiting: C.fgDim,
  stuck: C.red,
  blocked: C.red,
};

// CTL-947: status cell text for a worker row.
function workerStatusText(w: Worker): string {
  if (isActive(w.activeState)) return w.working ? "working" : "active";
  if (w.activeState === "stuck") return "stuck";
  if (w.waitingOnUser) return "waiting on you";
  return w.activeState ?? "idle";
}

export function QueueView({ data, embedded = false }: { data: BoardPayload; embedded?: boolean }) {
  const { config, queue, workers, tickets } = data;
  const infoById: Record<string, Ticket> = Object.fromEntries(tickets.map((t) => [t.id, t]));
  // CTL-947: build the ticket held lookup so the grouper can sink blocked tickets.
  const ticketHeld: Record<string, "blocked" | "waiting" | null | undefined> =
    Object.fromEntries(tickets.map((t) => [t.id, t.held]));
  // CTL-947: group in-flight workers by activity state. This replaces the flat
  // sortWorkers call — groupWorkersByActivity sorts internally using rankWorker
  // (which now includes waitingOnUser + blocked from the ticket held lookup).
  const inflightSections: WorkerActivitySection[] = groupWorkersByActivity(workers, ticketHeld);
  const inflightCount = workers.length;
  // SINGLE-HOST IDENTITY NO-OP: only surface the node column / group affordance
  // when the queue spans two or more DISTINCT owner hosts. With hosts.json absent
  // or length 1 every row resolves to one host (or none), so this is "single" and
  // the table renders exactly as it did pre-SURF2.
  const multiHost = queueHostMode(queue) === "multi";
  const [groupByNode, setGroupByNode] = useState(false);
  // The toggle only makes sense in a multi-node fleet; never grouped single-host.
  const grouped = multiHost && groupByNode;
  // Whether there are multiple non-empty groups (drives section header visibility:
  // single-group = no chrome, multi-group = show labeled dividers).
  const multiGroup = inflightSections.length > 1;
  return (
    <div className="cat-scroll" style={{ overflowY: "auto", height: embedded ? "100%" : "calc(var(--cat-board-vh, 100vh) - 104px)", padding: "2px 16px 24px" }}>
      <div style={{ maxWidth: 1040 }}>
        <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
          <Stat label="Max parallel" value={String(config.maxParallel)} />
          <Stat label="In flight" value={String(config.inFlight)} color={config.inFlight > config.maxParallel ? C.red : config.freeSlots === 0 ? C.yellow : C.fg} />
          <Stat label="Free slots" value={String(config.freeSlots)} color={config.freeSlots > 0 ? C.green : C.red} />
          <Stat label="Active" value={String(config.active)} color={LIVE} />
          <Stat label="Queued" value={String(queue.length)} />
        </div>
        <SlotBar capacity={config.maxParallel} inFlight={config.inFlight} />

        <div style={{ fontSize: 12, fontWeight: 600, color: C.fgMuted, margin: "0 0 8px" }}>On the plate — in flight ({inflightCount})</div>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 22 }}>
          <Table>
            <TableHeader><TableRow style={{ background: C.s1 }}>
              <TableHead style={{ ...th, width: 40 }}></TableHead><TableHead style={{ ...th, width: 44 }}>Pri</TableHead>
              <TableHead style={{ ...th, width: 100 }}>Ticket</TableHead><TableHead style={th}>Title</TableHead>
              <TableHead style={{ ...th, width: 130 }}>Phase</TableHead><TableHead style={{ ...th, width: 84 }}>Status</TableHead><TableHead style={{ ...th, width: 76 }}>Age</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {inflightSections.map((section: WorkerActivitySection) => (
                <Fragment key={section.group}>
                  {/* CTL-947: section header row — only rendered when there are
                      multiple non-empty groups, so a homogenous fleet (all active)
                      renders exactly as before with no extra chrome. */}
                  {multiGroup && (
                    <TableRow style={{ background: C.s1 }}>
                      <TableCell colSpan={7} style={{ ...mono, fontSize: 11, color: C.fgMuted, padding: "6px 12px" }}>
                        <span style={{ color: WORKER_GROUP_C[section.group] ?? C.fgDim, fontWeight: 600 }}>{section.label}</span>
                        <span style={{ color: C.fgDim }}> · {section.workers.length}</span>
                      </TableCell>
                    </TableRow>
                  )}
                  {/* CTL-952: AnimatePresence for in-flight worker enter/exit
                      (worker moves working<->waiting<->blocked). */}
                  <AnimatePresence initial={false}>
                  {section.workers.map((w) => {
                    // CTL-947: blocked rows show the blocker ids inline.
                    const ticket = infoById[w.ticket];
                    const blockers: string[] = section.group === "blocked"
                      ? (ticket?.blockers ?? [])
                      : [];
                    // per-row reduced-motion is resolved in QueueRow / MotionTableRow
                    // wrappers; here we create the row inline so we call the hook once.
                    return (
                      <InflightWorkerRow
                        key={w.name}
                        w={w}
                        ticket={ticket}
                        blockers={blockers}
                      />
                    );
                  })}
                  </AnimatePresence>
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 8px" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: C.fgMuted }}>Waiting in queue ({queue.length})</span>
          <span style={{ flex: 1 }} />
          {/* The group-by-node affordance only appears in a multi-node fleet
              (queueHostMode === "multi"); single-host shows nothing here. */}
          {multiHost && (
            <Seg
              value={groupByNode ? "node" : "rank"}
              onChange={(v) => setGroupByNode(v === "node")}
              options={[{ k: "rank", label: "Global rank" }, { k: "node", label: "By node" }]}
            />
          )}
        </div>
        <WaitingTable queue={queue} freeSlots={config.freeSlots} showHost={multiHost} grouped={grouped} />
        <div style={{ marginTop: 12, fontSize: 11, color: C.fgDim }}>Global rank: priority → pipeline stage → created-at → id. Per-project caps apply after ranking. Highlighted rows dispatch next as slots free.{multiHost ? " Node = the HRW owner host for each queued ticket." : ""}</div>
      </div>
    </div>
  );
}

// ── shell (ToggleGroup, TooltipProvider) ──────────────────────────────────────
// CTL-930: View narrows from "tickets"|"workers"|"queue" to "tickets"|"workers".
// Queue is now its own left-nav destination (QueueSurface), never a board view.
// CTL-948: "graph" is not a Board view — it navigates to the /dep-graph route;
// the Board exposes `onDepGraph` so BoardRoot (router.tsx) can inject the
// navigate() callback without leaking router coupling into the component.
type View = "tickets" | "workers";
// WorkerGrouping ("status" | "phase" | "node") is now owned by worker-grouping.ts
// (CTL-909 / SURF1) so the column derivation + the type stay in lock-step.
function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { k: T; label: string }[] }) {
  return (
    <ToggleGroup type="single" value={value} onValueChange={(v) => v && onChange(v as T)} variant="outline" size="sm">
      {options.map((o) => <ToggleGroupItem key={o.k} value={o.k} style={{ fontSize: 12, color: value === o.k ? C.fg : C.fgMuted }}>{o.label}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}

// CTL-892 / SHELL2: the board is hosted in TWO places now — the legacy
// standalone `board.html` entry (full viewport) and, newly, the shared app shell
// (inside SidebarInset, below the 48px top strip). `embedded` is the ONLY mount
// difference: it swaps the root height from 100vh → 100% so the dense grid fills
// the inset's flex slot instead of overflowing the viewport by the strip height.
// The data path (connectBoard / SharedWorker EventSource) is untouched in both.
//
// CTL-930: Board.props changes from `initialView?: View` to `view?: View; onViewChange?`.
// The SurfaceSwitch collapses to ONE <Board> branch; internal useState is the
// uncontrolled fallback for standalone board.html mount.
export function Board({
  embedded = false,
  view: viewProp,
  onViewChange,
  onDepGraph,
}: { embedded?: boolean; view?: View; onViewChange?: (v: View) => void; onDepGraph?: () => void } = {}) {
  const [data, setData] = useState<BoardPayload | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [viewInternal, setViewInternal] = useState<View>("tickets");
  // Controlled when viewProp is provided; uncontrolled (own state) otherwise.
  const view = viewProp ?? viewInternal;
  const setView = (v: View) => {
    setViewInternal(v);
    onViewChange?.(v);
  };
  const [workerGrouping, setWorkerGrouping] = useState<WorkerGrouping>("status");
  // CTL-909 / SURF1: the Workers node FILTER — "all" (no filter, single-host
  // identity no-op) or a specific host.name to scope the grid to one node.
  const [hostFilter, setHostFilter] = useState<string>(HOST_FILTER_ALL);
  // BOARD2 / CTL-906: the board display prefs (density / groupBy / colorBy /
  // order / showEmptyColumns / swimlane) now live in the persisted boardPrefsAtom
  // — the display-options popover is the single writer, and the choices survive a
  // reload. This replaces the former lens / colorBy / swimlanes local useState.
  const [prefs] = useAtom(boardPrefsAtom);
  const lens = prefs.groupBy; // the generalized "Group by" (Status / Pipeline)
  const colorBy = prefs.colorBy;
  // CTL-951: the board scroll-container. `openDetail` reads its offset into the
  // sessionStorage snapshot on a card click; `useBoardRestore` re-applies that
  // offset (+ re-focuses the originating card) when the operator returns. ONE ref
  // shared by the tickets + workers + list bodies (they all live inside it).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useBoardRestore(scrollRef, data != null);
  // CTL-951: the single card-open seam. Reads the live board scroll offset off the
  // `.cat-scroll` overflow container (NOT the flex body wrapper, which never
  // scrolls — `resolveScrollEl` is the SAME lookup the restore uses, so the offset
  // round-trips), stashes the restore snapshot + walk-list, then hard-navigates.
  const onOpen: OpenDetailFn = (kind, id, ctx) => {
    const el = resolveScrollEl(scrollRef.current);
    openDetail(kind, id, {
      ids: ctx.ids,
      lens: ctx.lens,
      col: ctx.col,
      from: "board",
      scroll: el ? { top: el.scrollTop, left: el.scrollLeft } : { top: 0, left: 0 },
    });
  };

  // CTL-733 PR-2b: subscribe through the board transport — a SharedWorker shares
  // ONE EventSource (+ an IndexedDB cache) across every tab, with a direct
  // per-tab EventSource fallback. Boots from cache for an instant warm paint and
  // re-requests a fresh snapshot whenever the tab regains focus.
  useEffect(() => {
    let alive = true;
    const conn = connectBoard({
      onSnapshot: (p) => { if (alive) setData(p); },
      onStatus: (s) => { if (alive) setStatus(s); },
    });
    const onVis = () => { if (!document.hidden) conn.requestReconcile(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      conn.close();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const repos = data?.repos ?? [];
  // CTL-897 / SHELL7: the repo filter is the SHARED workspace scope (FND atom),
  // reconciled against the live repo list (a stale repo → "all"). `repo` /
  // `setRepo` keep their names so every downstream filter + the in-grid Seg are
  // unchanged; the value is now shared with the workspace switcher.
  const { scope: repo, setScope: setRepo } = useRepoScope(repos);
  const fWorkers = useMemo(() => (data?.workers ?? []).filter((w) => repo === "all" || w.repo === repo), [data, repo]);
  const fTickets = useMemo(() => (data?.tickets ?? []).filter((t) => repo === "all" || t.repo === repo), [data, repo]);
  // CTL-909 / SURF1: distinct host names across the (repo-filtered) workers — the
  // node filter's option list. With one node this is a single entry, so the
  // filter control hides (isMultiHost === false) and the single-host case stays
  // chrome-free. The node grid + filter scope `fWorkers` (repo ∧ host).
  const workerHosts = useMemo(() => workerHostNames(fWorkers), [fWorkers]);
  const showNodeFilter = useMemo(() => isMultiHost(fWorkers), [fWorkers]);
  // Drop a stale host filter when the selected node no longer has workers (its
  // column vanished) so the grid never goes silently empty — fall back to "all".
  const activeHostFilter =
    hostFilter !== HOST_FILTER_ALL && !workerHosts.includes(hostFilter)
      ? HOST_FILTER_ALL
      : hostFilter;
  const nodeWorkers = useMemo(
    () => filterWorkersByHost(fWorkers, activeHostFilter),
    [fWorkers, activeHostFilter],
  );
  // CTL-930 Phase 3: swimlanes engage under any workspace scope. The repo scope
  // narrows the entity set (fTickets/fWorkers at :841–842) and the axis groups
  // within it — swimlane=repo under a single-repo scope collapses naturally to
  // ONE labeled repo lane (+ hint) rather than silently flattening to "none".
  const swimlane: GroupBy = prefs.swimlane;

  return (
    <TooltipProvider delayDuration={200}>
      <div style={{ [BOARD_VH_VAR]: boardRootHeight(embedded), background: C.s0, color: C.fg, height: `var(${BOARD_VH_VAR})`, display: "flex", flexDirection: "column", fontSize: 13, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', overflow: "hidden" } as React.CSSProperties}>
        <style>{PULSE_CSS}</style>
        {/* CTL-930: in-board header (Catalyst swatch + Tabs nav + status cluster)
            DELETED — the left sidebar is now the sole navigation and the app footer
            carries the status cluster. The subhead carries only the view label,
            description, display popover, and worker-grouping controls. */}

        {/* subhead */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 16px", flex: "0 0 auto", flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{view === "tickets" ? "Tickets" : "Workers"}</h1>
          <span style={{ color: C.fgMuted, fontSize: 12 }}>{view === "tickets" ? "Where each ticket sits in the pipeline · cyan = a worker is live on it now" : "Workers the daemon has deployed — active vs stuck"}</span>
          <span style={{ flex: 1 }} />
          {/* BOARD2 / CTL-906: the three scattered Tickets subhead toggles (lens /
              colorBy / repo-lanes) are folded into ONE Display-options popover —
              "density is a knob". The popover rides along in both the embedded
              shell mount and the standalone board.html mount (it lives here in
              Board's own subhead). It reads/writes the persisted boardPrefsAtom. */}
          {view === "tickets" && <DisplayOptionsPopover repos={repos} />}
          {view === "workers" && <>
            {/* CTL-909 / SURF1: group-by Status · Pipeline phase · Node. */}
            <Seg value={workerGrouping} onChange={setWorkerGrouping} options={[{ k: "status", label: "Status" }, { k: "phase", label: "Pipeline" }, { k: "node", label: "Node" }]} />
            {/* CTL-909 / SURF1: the node FILTER scopes the grid to one host. Shown
                only for a multi-node fleet — with a single node the filter is
                inert, so the single-host case stays chrome-free (identity no-op). */}
            {showNodeFilter && (
              <Seg
                value={activeHostFilter}
                onChange={setHostFilter}
                options={[{ k: HOST_FILTER_ALL, label: "All nodes" }, ...workerHosts.map((h) => ({ k: h, label: h === UNATTRIBUTED_HOST ? "Unattributed" : h }))]}
              />
            )}
          </>}
          {/* CTL-948: dep-graph link — only shown when a navigate callback is
              wired (BoardRoot in router.tsx injects it; embedded callers that
              don't mount the router leave it absent, so no broken link). */}
          {onDepGraph && (
            <button
              onClick={onDepGraph}
              style={{
                fontFamily: C.mono, fontSize: 11, padding: "3px 10px", borderRadius: 6,
                background: "transparent", border: `1px solid ${C.border}`,
                color: C.fgMuted, cursor: "pointer", whiteSpace: "nowrap",
              }}
              title="Open backlog dependency graph"
            >
              Dep Graph
            </button>
          )}
        </div>

        {/* body — CTL-951: the board root the scroll-restore hook resolves the
            `.cat-scroll` container under (so Esc/back returns to the exact offset). */}
        <div ref={scrollRef} style={{ flex: 1, minHeight: 0 }}>
          {!data && <div style={{ color: C.fgMuted, padding: 24 }}>Connecting to execution-core…</div>}
          {/* BOARD3 / CTL-907: row swimlanes. <SwimlaneBoard> groups the entities
              through the pure board-grouping engine and renders one labeled lane
              per group around the SAME column board — collapsing to the bare flat
              board for a single lane (the identity no-op: none / single-team /
              single-node / single-repo / single-repo-scope). The TicketBoard /
              WorkerBoard renderers are unchanged. */}
          {data && view === "tickets" && (
            // BOARD4 / CTL-908: fork the Tickets body on the Layout toggle. "list"
            // renders the dense BoardList table (its own swimlane sectioning via
            // groupListRows, so NOT wrapped in SwimlaneBoard); "board" keeps the
            // untouched column kanban. Flipping back restores the kanban with the
            // SAME lens/filters/density/live cards — all live in shared atoms, never
            // in BoardList.
            prefs.layout === "list" ? (
              <BoardList
                kind="ticket"
                tickets={fTickets}
                lens={lens}
                order={prefs.order}
                density={prefs.density}
                swimlane={swimlane}
                onOpen={onOpen}
                embedded={embedded}
              />
            ) : (
              // CTL-950: ONE sticky shared column-header row + ONE horizontal
              // scroll across every swimlane group. The column SET is derived once
              // over fTickets; each lane lays its cards into the SAME grid tracks.
              <TicketSwimlaneBoard
                tickets={fTickets}
                groupBy={lens}
                swimlane={swimlane}
                colorBy={colorBy}
                density={prefs.density}
                order={prefs.order}
                showEmpty={prefs.showEmptyColumns}
                fill
                onOpen={onOpen}
              />
            )
          )}
          {data && view === "workers" && (
            // CTL-909 / SURF1: the node FILTER scopes the grid to one host
            // (`nodeWorkers`; "all" is the identity no-op). Swimlanes (rows) and the
            // node filter (scope) are orthogonal: filter first, then group. R3b: when
            // the HOST swimlane is active the column lens falls back to status/phase
            // inside each lane so host is not double-encoded (rows AND columns).
            // CTL-950: shared header + single horizontal scroll across the lanes.
            <WorkerSwimlaneBoard
              workers={nodeWorkers}
              tickets={data.tickets}
              swimlane={swimlane}
              grouping={swimlane === "host" && workerGrouping === "node" ? "status" : workerGrouping}
              fill
              onOpen={onOpen}
            />
          )}
          {/* CTL-930: queue view branch removed — Queue is now its own left-nav
              destination (QueueSurface). Board view is narrowed to tickets|workers. */}
        </div>
        {/* CTL-951: the TicketDetailDrawer is removed — a plain card click now
            navigates STRAIGHT to /ticket/$id (the full detail page). */}
      </div>
    </TooltipProvider>
  );
}
