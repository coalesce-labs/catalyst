import { useEffect, useMemo, useState } from "react";
// CTL-989: the Board is now mounted INSIDE the single app-wide router, so card
// opens + the dep-graph jump are client-side navigations (no full-doc reload).
import { useNavigate } from "@tanstack/react-router";
import { motion, AnimatePresence } from "motion/react";
import { useAtom } from "jotai";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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
// to the full /ticket/$id // /worker/$id page (the drawer is removed). CTL-989:
// the Board now mounts INSIDE the single app-wide router, so a plain click is a
// CLIENT-SIDE `navigate(...)` (no full-document reload, the left nav stays).
// Cmd/Ctrl-click (and middle-click) still open the page in a NEW tab via the
// href string (the server's SPA fallback serves index.html for the detail path).
import {
  isNewTabClick,
  openDetail,
  openDetailInNewTab,
  ticketDetailHref,
  workerDetailHref,
  type DetailKind,
} from "./detail-nav";
import type { DetailLens } from "./route-search";
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
// CTL-1015: the /queue surface (capacity + waiting-queue rendering) was lifted
// out of Board.tsx into the dedicated control-tower components under
// components/queue/ (QueueView/WaitingTable/InflightWorkerRow + the SlotBar/Stat
// cards are retired). The per-node queue grouping (queue-grouping.ts) and the
// in-flight worker activity grouping (queue-worker-grouping.ts) now live there.
// ── BOARD2 / CTL-906: the display-options popover + its persisted prefs ────────
// One toolbar button owns every board display choice (density / grouping /
// ordering / color / show-empty / repo-lanes). The three scattered subhead Seg
// toggles (lens, colorBy, repo-lanes) are folded into it; their state moves from
// local useState into the persisted boardPrefsAtom so the choices survive a
// reload. The PURE column-derivation (group-by column set + show-empty filter +
// in-column order) lives in board-display.ts so the Gherkin is DOM-free testable.
import { boardPrefsAtom, type Density } from "./prefs-store";
import { DisplayOptionsPopover } from "./display-options-popover";
// CTL-1018: portal the board's controls into the SINGLE app-shell header row
// (the breadcrumb bar) so the board has no second toolbar bar below it.
import { HeaderActions } from "@/components/header-actions";
// CTL-950: shared-header column derivation. `visibleColumnDefs` picks the single
// column SET the shared header shows (over EVERY lane combined); `laneColumns`
// distributes ONE lane's tickets across that fixed set (empty cells kept, aligned).
import {
  laneColumns,
  visibleColumnDefs,
  PHASE_COLUMNS,
  type BoardColumnDef,
} from "./board-display";
// ── BOARD3 / CTL-907 + CTL-950: row swimlanes (none | repo | team | project | host) ─
// The generalized grouping engine (board-grouping.ts) + the shared-header,
// single-scroll <SwimlaneBoard> (CTL-950): ONE sticky column-header row spanning
// the full width, the swimlane groups as horizontal bands BELOW it, every group's
// cards laid into the SAME shared column grid under ONE horizontal scroll axis.
// axis="none" collapses to the single shared-header column board (one synthetic
// lane, no group label). The shared `C` / `LIVE` tokens are in board-tokens.ts.
import { C, LIVE, NODE_ACCENTS, CARD_LIFT } from "./board-tokens";
import { typeSymbol } from "./type-icon";
import { SwimlaneBoard, type SharedColumn, type LaneCell } from "./Swimlane";
import { formatIssueCount } from "./board-counts";
import { useResolvedRepoColors } from "@/hooks/use-resolved-repo-colors";
// ── BOARD4 / CTL-908: the dense List layout ────────────────────────────────────
// When the BOARD2 popover's Layout toggle is "list", the Tickets body renders the
// dense BoardList table instead of the column kanban — the SAME resolved entities,
// flattened into one ordered, sortable, swimlane-sectioned table. BoardList owns
// its own swimlane sectioning (groupListRows), so it is NOT wrapped in SwimlaneBoard.
import { BoardList } from "./BoardList";
import { EntityMarker } from "./entity-marker";
import { ControlTower } from "../components/queue/control-tower";
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
// CTL-1153: PHASE_C / ColorBy / accentFor extracted to board-accent.ts (pure,
// no React) so unit tests and the phase-drift guard import without pulling React.
// Board.tsx re-exports all three for backward-compat (list-columns.tsx consumers).
// BOARD2 / CTL-906: the ticket column SETS (linear / phase) now live in the pure
// board-display.ts (LINEAR_COLUMNS / PHASE_COLUMNS) so there is ONE definition
// the DOM-free column-derivation tests can read. The Workers phase lens reuses
// PHASE_COLUMNS from there. The worker status lens keeps its own two columns.
const WORKER_COLS = [
  { key: "active", label: "Active", c: LIVE },
  { key: "stuck", label: "Stuck", c: C.red },
];
// Phase statuses that mean a phase is no longer running. MUST stay in lock-step
// with the TERMINAL set in lib/board-data.mjs (the data-layer source of truth) —
// board-phase-drift.test.ts asserts this array equals [...TERMINAL] so a new
// terminal status added there cannot silently render here as a live phase
// (CTL-754).
const TERMINAL_STATUSES = [
  "done",
  "failed",
  "stalled",
  "skipped",
  "signal_corrupt",
  "superseded",
  "canceled",
];
// CTL-755 held-indicator label names. MUST stay in lock-step with
// execution-core/scheduler.mjs HELD_LABEL_BLOCKED / HELD_LABEL_WAITING (and the
// board-data.mjs copies) — the board-held-indicator drift guard asserts all
// three agree, so the badge below reads exactly the label the daemon writes.
const HELD_LABEL_BLOCKED = "blocked";
// CTL-764 Phase 4: value renamed "waiting" → "queued" (identifier preserved for drift guard).
const HELD_LABEL_WAITING = "queued";

// BOARD4 / CTL-908: the List view (BoardList.tsx) reuses these card atoms +
// formatters as its table cells, rather than re-implementing the live/priority/
// phase render (which would let the Board and List drift). They stay module-local
// to Board.tsx (the single source of truth); BOARD4 imports the named exports.
// CTL-1153: ColorBy / accentFor / PHASE_C live in board-accent.ts (pure, no React)
// so unit tests and the phase-drift guard import without pulling React. Re-exported
// here for backward-compat with list-columns.tsx and other callers. PHASE_C is also
// imported for direct use in PhaseStrip — the drift guard reads it from board-accent.ts
// but the board renders it via this import.
export type { ColorBy } from "./board-accent";
import { PHASE_C, accentFor, type ColorBy } from "./board-accent";
export { accentFor };
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
// CTL-973: bump nudge classes — translateX applied by the wheel guard when the
// user's 2-finger swipe hits the left/right scroll boundary. The quick snap-back
// (cubic-bezier jolt) is the visual analog of the iOS rubber-band that the CSS
// contain alone can't provide in Safari. Gated on prefers-reduced-motion: under
// reduce, the translateX is 0 (no motion) and only the edge shadow remains.
// CTL-1036: the board-local always-visible 9px .cat-scroll bar is retired — every
// board/lane scroller now uses the shared .cat-overlay-scroll utility (app.css),
// hidden at rest and revealed transiently while scrolling. PULSE_CSS keeps only
// the rubber-band bump classes.
const PULSE_CSS = `
@media (prefers-reduced-motion: no-preference) {
  .cat-board-bump-left  { transform: translateX(4px);  transition: transform 150ms cubic-bezier(0.36, 0.07, 0.19, 0.97); }
  .cat-board-bump-right { transform: translateX(-4px); transition: transform 150ms cubic-bezier(0.36, 0.07, 0.19, 0.97); }
}
@media (prefers-reduced-motion: reduce) {
  .cat-board-bump-left, .cat-board-bump-right { transform: none; }
}
`;

// ── domain viz (hand-rolled per DESIGN.md) ──────────────────────────────────
export function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        display: "inline-block",
        flex: "0 0 auto",
        boxShadow: pulse ? `0 0 8px ${color}` : undefined,
      }}
    />
  );
}
export function ActivityDot({ state, fallback }: { state: ActiveState; fallback: string }) {
  if (state === "active")
    return (
      <span
        className="catalyst-live-dot"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: LIVE,
          display: "inline-block",
          flex: "0 0 auto",
        }}
      />
    );
  if (state === "stuck") return <Dot color={C.red} />;
  return <Dot color={fallback} />;
}
export function PhasePill({ phase }: { phase: string }) {
  const c = PHASE_C[phase] || C.blue;
  // muted treatment (dark tint bg + colored fg) — keeps phase identity without
  // a wall of fully-saturated pills competing with the status signal.
  return (
    <span
      style={{
        fontFamily: C.mono,
        fontSize: 10.5,
        padding: "1.5px 8px",
        borderRadius: 6,
        color: c,
        fontWeight: 600,
        background: `${c}22`,
        whiteSpace: "nowrap",
      }}
    >
      {phase}
    </span>
  );
}
function PhaseStrip({
  phaseSummary,
}: {
  phaseSummary: { phase: string; status: string; durationMs: number | null }[];
}) {
  if (!phaseSummary.length) return null;
  return (
    <div style={{ display: "flex", gap: 3, marginTop: 7, flexWrap: "wrap", alignItems: "center" }}>
      {phaseSummary.map((p) => {
        const c = PHASE_C[p.phase] || C.blue;
        const running = !TERMINAL_STATUSES.includes(p.status) && p.durationMs != null;
        return (
          <Tooltip key={p.phase}>
            <TooltipTrigger asChild>
              <span
                style={{
                  width: 16,
                  height: 4,
                  borderRadius: 2,
                  background: c,
                  opacity: p.status === "failed" ? 0.4 : 1,
                  outline: running ? `1px solid ${c}` : undefined,
                  display: "inline-block",
                  flex: "0 0 auto",
                }}
              />
            </TooltipTrigger>
            <TooltipContent style={{ fontFamily: C.mono, fontSize: 11 }}>
              {p.phase}
              {p.durationMs != null ? ` · ${fmtDuration(p.durationMs)}` : ""}
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
  const icon =
    p === 1 ? (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-label="Urgent">
        <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill={C.orange} />
        <rect x="6.1" y="2.8" width="1.8" height="5.2" rx="0.9" fill="#1b1206" />
        <rect x="6.1" y="9.4" width="1.8" height="1.9" rx="0.95" fill="#1b1206" />
      </svg>
    ) : (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-label={PRIORITY_LABEL[p]}>
        {[
          { x: 1, h: 5 },
          { x: 5.5, h: 9 },
          { x: 10, h: 13 },
        ].map((b, i) => {
          const filled = i < (p === 2 ? 3 : p === 3 ? 2 : p === 4 ? 1 : 0);
          return (
            <rect
              key={i}
              x={b.x}
              y={14 - b.h}
              width="3"
              height={b.h}
              rx="1"
              fill={filled ? "#d3dae4" : "#424d5c"}
            />
          );
        })}
      </svg>
    );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span style={{ display: "inline-flex", flex: "0 0 auto" }}>{icon}</span>
      </TooltipTrigger>
      <TooltipContent>{PRIORITY_LABEL[p] || "No priority"}</TooltipContent>
    </Tooltip>
  );
}
const SCOPE_ABBR: Record<string, string> = {
  xs: "XS",
  small: "S",
  medium: "M",
  large: "L",
  xl: "XL",
};
// CTL-957: one-estimate chip — show the Linear estimate (method-aware) when
// present, else fall back to the triage scope string. NEVER both.
// `estimateDisplay` is the pre-computed method-aware label from board-data.mjs
// (fibonacci → "5", tShirt → "M"); when present it takes sole precedence.
export function ScopeChip({
  scope,
  estimate,
  estimateDisplay,
}: {
  scope: string | null;
  estimate: number | null;
  estimateDisplay?: string | null;
}) {
  // A real Linear estimate: show method-correct display label.
  if (estimateDisplay != null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" style={{ fontFamily: C.mono, fontSize: 10 }}>
            {estimateDisplay}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>estimate: {estimate}</TooltipContent>
      </Tooltip>
    );
  }
  // No Linear estimate: fall back to triage scope string.
  if (!scope) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" style={{ fontFamily: C.mono, fontSize: 10 }}>
          {SCOPE_ABBR[scope] || scope}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>scope: {scope}</TooltipContent>
    </Tooltip>
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
  return (
    <span
      style={{
        fontFamily: C.mono,
        fontSize: 10,
        padding: "1.5px 7px",
        borderRadius: 6,
        color: m.fg,
        background: m.bg,
        whiteSpace: "nowrap",
      }}
    >
      {m.label}
    </span>
  );
}
// CTL-755: held indicator. A triaged-waiting ticket the admission gate is
// holding before the triage→research promotion carries a `blocked` or `queued`
// (formerly `waiting`) Linear label. We render a distinct amber "⏸" chip so an
// operator sees at a glance the ticket is HELD on a dependency (blocked, names
// the blocker ids) vs merely awaiting capacity/priority (queued).
// CTL-764 Phase 4: back-compat — tolerate legacy "waiting" value during rollout.
export function HeldBadge({
  held,
  blockers,
}: {
  held: "blocked" | "queued" | "waiting" | null | undefined;
  blockers?: string[];
}) {
  if (held !== HELD_LABEL_BLOCKED && held !== HELD_LABEL_WAITING && held !== "waiting") return null;
  const isBlocked = held === HELD_LABEL_BLOCKED;
  const fg = isBlocked ? C.redSoft : C.yellowSoft;
  const bg = isBlocked ? `${C.red}24` : `${C.yellow}24`;
  const ids = (blockers ?? []).filter(Boolean);
  const label = isBlocked ? `⏸ blocked${ids.length ? `: ${ids.join(", ")}` : ""}` : "⏸ queued";
  const tip = isBlocked
    ? ids.length
      ? `Held — blocked on open dependency: ${ids.join(", ")}`
      : "Held — blocked on an open dependency"
    : "Held — deps satisfied, awaiting capacity or priority (queued)";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          style={{
            fontFamily: C.mono,
            fontSize: 10,
            padding: "1.5px 7px",
            borderRadius: 6,
            color: fg,
            background: bg,
            whiteSpace: "nowrap",
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "inline-block",
          }}
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent style={{ fontFamily: C.mono, fontSize: 11 }}>{tip}</TooltipContent>
    </Tooltip>
  );
}
// CTL-729: the single "needs attention" badge (operator-approved 2026-06-11). ONE
// yellow accent merges the live "waiting on you" (a blocked bg job) and the
// watchdog/needs-human escalation into one operator-action signal, with small
// sub-text saying WHY: "waiting on your answer" vs "escalated — needs human". This
// is DISTINCT from HeldBadge (the admission-gate blocked/waiting pair). The ONLY
// new color is the single yellow accent (Linear-calm: color reserved for meaning).
export function AttentionBadge({
  attention,
}: {
  attention?: "waiting-on-you" | "needs-human" | null;
}) {
  if (attention !== "waiting-on-you" && attention !== "needs-human") return null;
  const label =
    attention === "needs-human" ? "⚑ escalated — needs human" : "⏸ waiting on your answer";
  const tip =
    attention === "needs-human"
      ? "Escalated to you — a human must act (watchdog / needs-human)"
      : "Paused waiting for your answer (a permission grant or prompt)";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          style={{
            fontFamily: C.mono,
            fontSize: 10,
            padding: "1.5px 7px",
            borderRadius: 6,
            color: C.yellowSoft,
            background: `${C.yellow}24`,
            whiteSpace: "nowrap",
            maxWidth: 200,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "inline-block",
          }}
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent style={{ fontFamily: C.mono, fontSize: 11 }}>{tip}</TooltipContent>
    </Tooltip>
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
            <span
              style={{
                fontFamily: C.mono,
                fontSize: 10,
                padding: "1.5px 6px",
                borderRadius: 6,
                color: C.fgDim,
                background: C.s1,
                border: `1px solid ${C.borderSubtle}`,
                whiteSpace: "nowrap",
                cursor: "default",
              }}
            >
              {fwd.length === 1 ? `← ${fwd[0]}` : `← ${fwd.length}`}
            </span>
          </TooltipTrigger>
          <TooltipContent style={{ fontFamily: C.mono, fontSize: 11 }}>
            blocked by: {fwd.join(", ")}
          </TooltipContent>
        </Tooltip>
      )}
      {rev.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              style={{
                fontFamily: C.mono,
                fontSize: 10,
                padding: "1.5px 6px",
                borderRadius: 6,
                color: C.fgDim,
                background: C.s1,
                border: `1px solid ${C.borderSubtle}`,
                whiteSpace: "nowrap",
                cursor: "default",
              }}
            >
              {rev.length === 1 ? `→ ${rev[0]}` : `→ ${rev.length}`}
            </span>
          </TooltipTrigger>
          <TooltipContent style={{ fontFamily: C.mono, fontSize: 11 }}>
            blocks: {rev.join(", ")}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
export function Cost({ v }: { v: number | null }) {
  return (
    <span
      style={{
        fontFamily: C.mono,
        fontVariantNumeric: "tabular-nums",
        fontSize: 10.5,
        color: v == null ? C.fgDim : C.fgMuted,
      }}
    >
      {v == null ? "—" : `$${v.toFixed(2)}`}
    </span>
  );
}
// CTL-1022: the title is a plain clamped block — NO hover tooltip. The old
// Tooltip dumped the full title (the "description dump" Ryan flagged) on hover,
// which was jarring and not built for reading. A future intentional rich
// hover-card can replace it; for now hovering a card title shows nothing.
export function TitleText({ text, clamp = 2 }: { text: string; clamp?: number }) {
  return (
    <div
      style={{
        color: C.fg,
        fontSize: 13,
        lineHeight: 1.35,
        margin: clamp === 1 ? "5px 0 6px" : "7px 0 9px",
        display: "-webkit-box",
        WebkitLineClamp: clamp,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
        cursor: "default",
      }}
    >
      {text}
    </div>
  );
}

// CTL-1022: the board card's corner type pill — a compact, Linear-calm symbol.
// It shows ONLY the type's icon in its type color over a quiet muted background
// (never a saturated badge, never the type word). The icon + color + label all
// come from the shared `typeSymbol` map. Hovering names the type ("Feature").
// Unknown/absent types render a neutral dot (typeSymbol returns icon: null) so a
// stray triage value can never produce a broken card.
export function TypePill({ type }: { type: string }) {
  const { icon: Icon, color, label } = typeSymbol(type);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={label}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            borderRadius: 5,
            background: C.s1,
            border: `1px solid ${C.borderSubtle}`,
            cursor: "default",
          }}
        >
          {Icon ? (
            <Icon size={11} color={color} strokeWidth={2.25} />
          ) : (
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: color }} />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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
  ctx: { ids: string[]; lens?: DetailLens; col?: string }
) => void;

// CTL-952: motion.div gives each card a stable layoutId keyed by ticket id so
// when it moves between columns (phase change) the browser animates its position
// rather than jump-cutting. AnimatePresence (in the column container) handles
// enter/exit. `useReducedMotion` collapses everything to instant when the OS
// accessibility preference is set.
function TicketCard({
  t,
  colorBy,
  density = "comfortable",
  colIds,
  lens,
  col,
  onOpen,
  blockedBy,
  repoAccents,
}: {
  t: Ticket;
  colorBy: ColorBy;
  density?: Density;
  colIds?: string[];
  lens?: DetailLens;
  col?: string;
  onOpen?: OpenDetailFn;
  blockedBy?: string[];
  repoAccents?: Record<string, string>;
}) {
  const accent = accentFor(t, colorBy, repoAccents);
  const live = t.activeState === "active";
  const stuck = t.activeState === "stuck";
  const dim = t.activeState == null;
  // CTL-729: the single needs-attention signal — ONE yellow accent for either
  // 'waiting-on-you' or 'needs-human'. A left inset rule tints the card like the
  // existing waitingOnUser yellow; stuck (red) still wins the border treatment.
  const attention = t.attention === "waiting-on-you" || t.attention === "needs-human";
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
        background: live ? C.s3 : C.s2,
        borderRadius: 10,
        padding: compact ? "7px 10px" : "11px 13px",
        border: `1px solid ${stuck ? `${C.red}80` : attention ? `${C.yellow}80` : dim ? C.borderSubtle : C.border}`,
        // CTL-729: a quiet yellow left rule when the ticket needs the operator —
        // the same single accent the Inbox "Needs you" row carries. Stuck (red)
        // takes precedence so a dead/zombie signal is never masked by attention.
        // CTL-1033: compose that attention rule WITH the card lift (inset top-
        // highlight + soft ambient shadow) so cards FLOAT off the canvas. Live cards
        // keep the animated `.catalyst-live` ring (no static shadow).
        boxShadow: live
          ? undefined
          : !stuck && attention
            ? `inset 2px 0 0 0 ${C.yellow}, ${CARD_LIFT}`
            : CARD_LIFT,
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
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key === "Enter" || e.key === " " || e.key === "o") {
                e.preventDefault();
                open(false);
              }
            }
          : undefined
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: compact ? 5 : 7 }}>
        <EntityMarker repo={t.repo} state={t.activeState} fallback={accent} />
        <span style={{ fontFamily: C.mono, fontSize: 11.5, fontWeight: 600, color: C.blue }}>
          {t.id}
        </span>
        <span style={{ flex: 1 }} />
        {live && (
          <span style={{ fontFamily: C.mono, fontSize: 10, color: LIVE }}>
            {t.working ? "working" : "active"}
          </span>
        )}
        {stuck && <span style={{ fontFamily: C.mono, fontSize: 10, color: C.red }}>stuck</span>}
        {!compact && <TypePill type={t.type} />}
      </div>
      <TitleText text={t.title} clamp={compact ? 1 : 2} />
      <div
        style={{ display: "flex", alignItems: "center", gap: compact ? 5 : 7, flexWrap: "wrap" }}
      >
        <PriorityIcon p={t.priority} />
        <PhasePill phase={t.phase} />
        {/* CTL-729: the single needs-attention badge — yellow, with WHY sub-text. */}
        <AttentionBadge attention={t.attention} />
        <HeldBadge held={t.held} blockers={t.blockers} />
        <StatusBadge status={t.status} />
        {!compact && (
          <ScopeChip scope={t.scope} estimate={t.estimate} estimateDisplay={t.estimateDisplay} />
        )}
        {!compact && <DepChips blockers={t.blockers} blockedBy={blockedBy} />}
        {!compact && t.project && (
          <Badge variant="outline" style={{ fontSize: 10, color: C.fgDim }}>
            {t.project}
          </Badge>
        )}
      </div>
      {!compact && <PhaseStrip phaseSummary={t.phaseSummary} />}
      {compact ? (
        // one collapsed meta line: age · turns · (PR or cost)
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 6 }}>
          <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }}>
            {fmtAgo(t.updatedAt)}
          </span>
          <span style={{ flex: 1 }} />
          {t.turns != null && (
            <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }} title="total turns">
              {t.turns}t
            </span>
          )}
          {t.pr ? (
            <span style={{ fontFamily: C.mono, fontSize: 10.5, color: C.green }}>#{t.pr}</span>
          ) : (
            <Cost v={t.costUSD} />
          )}
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 9 }}>
          <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }}>
            {t.activeState == null && t.status !== "done"
              ? `idle · ${fmtAgo(t.updatedAt)}`
              : fmtAgo(t.updatedAt)}
          </span>
          <span style={{ flex: 1 }} />
          {t.turns != null && (
            <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }} title="total turns">
              {t.turns}t
            </span>
          )}
          {t.pr ? (
            <span style={{ fontFamily: C.mono, fontSize: 10.5, color: C.green }}>#{t.pr}</span>
          ) : (
            <Cost v={t.costUSD} />
          )}
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
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: C.mono,
            fontSize: 10,
            color: c,
            background: `${c}1f`,
            border: `1px solid ${c}3a`,
            padding: "0 6px",
            borderRadius: 5,
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: c,
              display: "inline-block",
            }}
          />
          {host.name}
        </span>
      </TooltipTrigger>
      <TooltipContent>node {host.name}</TooltipContent>
    </Tooltip>
  );
}

// ── worker card (Workers board) ─────────────────────────────────────────────
// CTL-952: motion.div with layoutId keyed by worker name — same layout/enter/exit
// treatment as TicketCard. Workers move between Active/Stuck columns when their
// state changes; AnimatePresence in the column container triggers enter/exit.
function WorkerCard({
  w,
  info,
  colIds,
  onOpen,
}: {
  w: Worker;
  info?: Ticket;
  colIds?: string[];
  onOpen?: OpenDetailFn;
}) {
  const accent = PHASE_C[w.phase] || C.blue;
  const live = w.activeState === "active";
  const stuck = w.activeState === "stuck";
  // CTL-729: the worker's needs-attention signal — the ONE yellow treatment,
  // keyed off the SAME concept as the ticket card. A worker's own bg-job
  // waitingOnUser flag and its ticket's needs-human escalation fold into one
  // attention value (needs-human wins). The card mirrors the ticket's yellow rule.
  const attentionState: "waiting-on-you" | "needs-human" | null =
    info?.attention === "needs-human" || info?.attention === "waiting-on-you"
      ? info.attention
      : w.waitingOnUser
        ? "waiting-on-you"
        : null;
  const attention = attentionState != null;
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
      // CTL-951 / CTL-989: a PLAIN click on a worker card navigates STRAIGHT to
      // its single-run detail page (`/worker/$id`, keyed by w.name) via a
      // CLIENT-SIDE router navigate (no reload, the left nav stays). Cmd/Ctrl-click
      // (and middle-click via onAuxClick) open it in a NEW tab. Browser back
      // returns to the exact Workers grid (native router scroll restoration).
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
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key === "Enter" || e.key === " " || e.key === "o") {
                e.preventDefault();
                open(false);
              }
            }
          : undefined
      }
      style={{
        background: live ? C.s3 : C.s2,
        borderRadius: 10,
        padding: "11px 13px",
        border: `1px solid ${stuck ? `${C.red}80` : attention ? `${C.yellow}80` : C.border}`,
        // CTL-729: the ONE yellow rule when this worker needs the operator —
        // identical accent to the ticket card. Stuck (red) takes precedence.
        // CTL-1033: compose the stuck/attention inset rule WITH the card lift so
        // worker cards float; live keeps the `.catalyst-live` animated ring (no
        // static shadow).
        boxShadow: stuck
          ? `inset 2px 0 0 0 ${C.red}, ${CARD_LIFT}`
          : attention
            ? `inset 2px 0 0 0 ${C.yellow}, ${CARD_LIFT}`
            : live
              ? undefined
              : CARD_LIFT,
        cursor: onOpen ? "pointer" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <EntityMarker repo={w.repo} state={w.activeState} fallback={accent} />
        <span style={{ fontFamily: C.mono, fontSize: 12.5, fontWeight: 700, color: C.blue }}>
          {w.ticket}
        </span>
        {w.sessionId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                style={{
                  fontFamily: C.mono,
                  fontSize: 10,
                  color: C.fgDim,
                  background: C.s1,
                  border: `1px solid ${C.borderSubtle}`,
                  padding: "0 5px",
                  borderRadius: 5,
                }}
              >
                {w.sessionId.slice(0, 7)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              worker {w.sessionId} · {w.name}
            </TooltipContent>
          </Tooltip>
        )}
        {w.tickets.length > 1 && (
          <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }}>
            +{w.tickets.length - 1}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {attempt > 1 && (
          <span style={{ fontFamily: C.mono, fontSize: 10, color: C.yellow }}>
            retry #{attempt}
          </span>
        )}
        <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }}>
          {fmtRuntime(w.runtimeMs)}
        </span>
      </div>
      {info?.title && <TitleText text={info.title} />}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          flexWrap: "wrap",
          marginTop: info?.title ? 0 : 9,
        }}
      >
        {info && <PriorityIcon p={info.priority} />}
        <PhasePill phase={w.phase} />
        {/* CTL-729: the single needs-attention badge, same yellow as the ticket. */}
        <AttentionBadge attention={attentionState} />
        {/* CTL-909 / SURF1: owning host.name on every worker card. */}
        <HostChip host={w.host} />
        <Badge variant="outline" style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }}>
          {w.repo}
        </Badge>
        {info?.model && (
          <Badge variant="secondary" style={{ fontFamily: C.mono, fontSize: 10 }}>
            {info.model}
          </Badge>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 9 }}>
        <span
          style={{ fontFamily: C.mono, fontSize: 10, color: live ? LIVE : stuck ? C.red : C.fgDim }}
        >
          {live
            ? w.working
              ? "working now"
              : seen
                ? `active · ${seen}`
                : "active"
            : stuck
              ? `stuck · ${seen ?? "?"}`
              : w.status}
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
  perLaneCounts: { count: number; live: number }[][]
): SharedColumn[] {
  return defs.map((def, i) => {
    let count = 0;
    let live = 0;
    for (const lane of perLaneCounts) {
      const cell = lane[i];
      if (cell) {
        count += cell.count;
        live += cell.live;
      }
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
  tickets,
  groupBy,
  swimlane,
  colorBy,
  density,
  order,
  showEmpty,
  fill,
  embedded = false,
  onOpen,
  laneColors,
  repoAccents,
}: {
  tickets: Ticket[];
  groupBy: "linear" | "phase";
  swimlane: GroupBy;
  colorBy: ColorBy;
  density: Density;
  order: Ordering;
  showEmpty: boolean;
  fill: boolean;
  embedded?: boolean;
  onOpen?: OpenDetailFn;
  laneColors?: Record<string, string>;
  repoAccents?: Record<string, string>;
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
          <TicketCard
            key={t.id}
            t={t}
            colorBy={colorBy}
            density={density}
            colIds={colIds}
            lens={groupBy}
            col={c.key}
            onOpen={onOpen}
            blockedBy={blockedByIdx[t.id]}
            repoAccents={repoAccents}
          />
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
      embedded={embedded}
      entityNoun="ticket"
      columns={columns}
      deriveLane={deriveLane}
      // CTL-1010: density drives the per-lane MINIMUM in the water-fill (real
      // heights are measured); the card render already receives density above.
      density={density}
      laneColors={laneColors}
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
  workers,
  tickets,
  swimlane,
  grouping,
  fill,
  embedded = false,
  onOpen,
  laneColors,
}: {
  workers: Worker[];
  tickets: Ticket[];
  swimlane: GroupBy;
  grouping: WorkerGrouping;
  fill: boolean;
  embedded?: boolean;
  onOpen?: OpenDetailFn;
  laneColors?: Record<string, string>;
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
      const live =
        grouping === "status" ? 0 : items.filter((w) => w.activeState === "active").length;
      return {
        count: items.length,
        live,
        cards: items.map((w) => (
          <WorkerCard
            key={w.name}
            w={w}
            info={infoById[w.ticket]}
            colIds={workerIds}
            onOpen={onOpen}
          />
        )),
      };
    });
  const columns = sharedHeaderTotals(defs, [deriveLane(workers)]);
  return (
    <SwimlaneBoard
      items={workers}
      groupBy={swimlane}
      fill={fill}
      embedded={embedded}
      entityNoun="worker"
      columns={columns}
      deriveLane={deriveLane}
      laneColors={laneColors}
    />
  );
}
// BOARD3 / CTL-907: the repo-only `Lane` component is replaced by the generalized
// <Swimlane>/<SwimlaneBoard> (Swimlane.tsx), driven by the pure board-grouping
// engine over the full none|repo|team|project|host axis.

// ── shell (ToggleGroup, TooltipProvider) ──────────────────────────────────────
// CTL-930/CTL-1016: Board view is narrowed to "tickets"|"workers".
// CTL-948: "graph" is not a Board view — it navigates to the /dep-graph route;
// the Board exposes `onDepGraph` so BoardRoot (router.tsx) can inject the
// navigate() callback without leaking router coupling into the component.
type View = "tickets" | "workers";
// WorkerGrouping ("status" | "phase" | "node") is now owned by worker-grouping.ts
// (CTL-909 / SURF1) so the column derivation + the type stay in lock-step.
function Seg<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { k: T; label: string }[];
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      variant="outline"
      size="sm"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.k}
          value={o.k}
          style={{ fontSize: 12, color: value === o.k ? C.fg : C.fgMuted }}
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

// CTL-892 / SHELL2 / CTL-989: the board is hosted ONLY inside the shared app
// shell now — the /board (tickets) and /workers routes mount it inside the
// AppShell SidebarInset (below the 48px top strip). The legacy standalone
// board.html entry is retired. `embedded` is retained for the height contract:
// embedded → the board fills the inset's flex slot (flex:1/minHeight:0);
// `embedded=false` keeps the standalone 100vh root for any future full-viewport
// mount. The data path (connectBoard / SharedWorker EventSource) is untouched.
//
// CTL-930: Board.props changes from `initialView?: View` to `view?: View`.
// CTL-989: the board.html standalone entry is retired, so the Board is ALWAYS
// mounted with a `view` prop by the /board (tickets) and /workers routes — the
// view is the route's concern, not in-board state. `view` defaults to "tickets".
export function Board({
  embedded = false,
  view = "tickets",
  onDepGraph,
}: { embedded?: boolean; view?: View; onDepGraph?: () => void } = {}) {
  const navigate = useNavigate();
  const [data, setData] = useState<BoardPayload | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [workerGrouping, setWorkerGrouping] = useState<WorkerGrouping>("phase");
  // CTL-1098: the Workers surface is two one-at-a-time screens — the dispatch
  // panel (ControlTower) and the pipeline board (WorkerSwimlaneBoard). A header
  // Seg switches between them so the swimlane's sticky column header can never
  // float over dispatch content (they are never co-mounted). Defaults to dispatch.
  const [workerSurface, setWorkerSurface] = useState<"dispatch" | "board">("dispatch");
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
  // CTL-989: board scroll restoration is now NATIVE — the `.cat-board-scroll`
  // scroller carries `data-scroll-restoration-id="board-scroll"`, so TanStack
  // Router (scrollRestoration: true) saves + restores its offset (both axes) per
  // history entry on back-from-detail. The former sessionStorage scroll snapshot
  // + `useBoardRestore` are retired with the full-document navigation that forced
  // them.

  // CTL-733 PR-2b: subscribe through the board transport — a SharedWorker shares
  // ONE EventSource (+ an IndexedDB cache) across every tab, with a direct
  // per-tab EventSource fallback. Boots from cache for an instant warm paint and
  // re-requests a fresh snapshot whenever the tab regains focus.
  useEffect(() => {
    let alive = true;
    const conn = connectBoard({
      onSnapshot: (p) => {
        if (alive) setData(p);
      },
      onStatus: (s) => {
        if (alive) setStatus(s);
      },
    });
    const onVis = () => {
      if (!document.hidden) conn.requestReconcile();
    };
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
  const fWorkers = useMemo(
    () => (data?.workers ?? []).filter((w) => repo === "all" || w.repo === repo),
    [data, repo]
  );
  const fTickets = useMemo(
    () => (data?.tickets ?? []).filter((t) => repo === "all" || t.repo === repo),
    [data, repo]
  );
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
    [fWorkers, activeHostFilter]
  );
  // CTL-930 Phase 3: swimlanes engage under any workspace scope. The repo scope
  // narrows the entity set (fTickets/fWorkers at :841–842) and the axis groups
  // within it — swimlane=repo under a single-repo scope collapses naturally to
  // ONE labeled repo lane (+ hint) rather than silently flattening to "none".
  const swimlane: GroupBy = prefs.swimlane;

  // CTL-1027: per-project swimlane tint — local picks layered over server defaults.
  // CTL-1153 (M2): repoAccents uses .text (legible foreground) for card accent dots;
  // laneColors uses .bg (lane background tint). Both derive from the same resolved map.
  const resolvedColors = useResolvedRepoColors();
  const laneColors = useMemo(
    () => Object.fromEntries(Object.entries(resolvedColors).map(([k, v]) => [k, v.bg])),
    [resolvedColors]
  );
  const repoAccents = useMemo(
    () => Object.fromEntries(Object.entries(resolvedColors).map(([k, v]) => [k, v.text])),
    [resolvedColors]
  );

  // CTL-989: the single card-open seam — a CLIENT-SIDE router navigation to the
  // detail page (no full-document reload; the left nav stays). The list-origin
  // (from/lens/col/cursor) rides in the typed search params so the detail Shell
  // reconstructs the breadcrumb + pager from the URL; the inherited `?scope` is
  // preserved by the search updater. Browser back returns here and the router
  // restores the board scroller's offset natively (data-scroll-restoration-id).
  // A /worker/$id path is intrinsically the Workers surface for nav highlight, so
  // `from` stays the valid DetailFrom "board" (route-surface keys the highlight
  // off the path kind for worker pages).
  const onOpen: OpenDetailFn = (kind, id, ctx) => {
    openDetail(navigate, kind, id, {
      ids: ctx.ids,
      lens: ctx.lens,
      col: ctx.col,
      from: "board",
    });
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div
        style={
          {
            [BOARD_VH_VAR]: boardRootHeight(embedded),
            background: C.s1,
            color: C.fg, // CTL-1013: board is the content canvas (s1), not chrome (s0)
            // CTL-989 board-height fix: embedded → fill the AppShell inset content slot
            // via the flex chain (`flex:1; minHeight:0`) so there is no dead space below
            // the columns. Standalone (board.html) keeps the 100vh root. The
            // `--cat-board-vh` var still resolves to 100% (embedded) / 100vh (standalone)
            // for the QueueView scroller + the standalone Swimlane calc.
            ...(embedded ? { flex: 1, minHeight: 0 } : { height: `var(${BOARD_VH_VAR})` }),
            display: "flex",
            flexDirection: "column",
            fontSize: 13,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            overflow: "hidden",
          } as unknown as React.CSSProperties
        }
      >
        <style>{PULSE_CSS}</style>
        {/* CTL-930: in-board header (Catalyst swatch + Tabs nav + status cluster)
            DELETED — the left sidebar is now the sole navigation and the app footer
            carries the status cluster. The subhead carries only the view label,
            description, display popover, and worker-grouping controls. */}

        {/* CTL-1018: the board's second toolbar bar is GONE. The surface subtitle
            (lens-aware tagline + quiet lens chip) and ALL controls (Display popover
            / worker group-by + node filter / Dep Graph) are portaled into the
            SINGLE app-shell header row (the breadcrumb bar already names the
            surface). One header per surface; behavior + persistence unchanged. */}
        <HeaderActions>
          {/* CTL-1144: combined board total — quiet, mono, no accent color. */}
          {view === "tickets" && data && (
            <span
              style={{
                fontFamily: C.mono,
                fontVariantNumeric: "tabular-nums",
                fontSize: 12,
                fontWeight: 600,
                color: C.fg,
                whiteSpace: "nowrap",
              }}
            >
              {formatIssueCount(fTickets.length)}
            </span>
          )}
          {/* CTL-972: lens-aware tagline + quiet active-lens indicator. Muted, and
              hidden on narrow widths so the header stays calm. */}
          <span className="hidden text-[12px] text-muted-foreground lg:inline">
            {view === "tickets"
              ? lens === "phase"
                ? "Which phase-agent is working each ticket · cyan = live worker"
                : "Linear stage for each ticket · cyan = a worker is live on it now"
              : "Workers the daemon has deployed — active vs stuck"}
          </span>
          {view === "tickets" && (
            <span
              style={{
                fontSize: 11,
                color: C.fgDim,
                background: C.s1,
                border: `1px solid ${C.border}`,
                borderRadius: 4,
                padding: "1px 6px",
                whiteSpace: "nowrap",
              }}
            >
              {lens === "phase" ? "Pipeline phase" : "Linear stage"}
            </span>
          )}
          {/* BOARD2 / CTL-906: the lens / colorBy / repo-lanes toggles folded into
              ONE Display-options popover, reading/writing the persisted prefs. */}
          {view === "tickets" && <DisplayOptionsPopover repos={repos} />}
          {view === "workers" && (
            <>
              {/* CTL-1098: Dispatch vs Board surface switch — labeled "Board" (not
                "Pipeline") to avoid colliding with the grouping toggle's Pipeline option. */}
              <Seg
                value={workerSurface}
                onChange={setWorkerSurface}
                options={[
                  { k: "dispatch", label: "Dispatch" },
                  { k: "board", label: "Board" },
                ]}
              />
              {workerSurface === "board" && (
                <>
                  {/* CTL-909 / SURF1: group-by Status · Pipeline phase · Node — board screen only. */}
                  <Seg
                    value={workerGrouping}
                    onChange={setWorkerGrouping}
                    options={[
                      { k: "status", label: "Status" },
                      { k: "phase", label: "Pipeline" },
                      { k: "node", label: "Node" },
                    ]}
                  />
                  {/* CTL-909 / SURF1: the node FILTER scopes the grid to one host. Shown
                  only for a multi-node fleet — with a single node the filter is
                  inert, so the single-host case stays chrome-free (identity no-op). */}
                  {showNodeFilter && (
                    <Seg
                      value={activeHostFilter}
                      onChange={setHostFilter}
                      options={[
                        { k: HOST_FILTER_ALL, label: "All nodes" },
                        ...workerHosts.map((h) => ({
                          k: h,
                          label: h === UNATTRIBUTED_HOST ? "Unattributed" : h,
                        })),
                      ]}
                    />
                  )}
                </>
              )}
            </>
          )}
          {/* CTL-948 / CTL-989: dep-graph link — a client-side navigate to
              /dep-graph (an `onDepGraph` prop still wins for back-compat callers). */}
          <button
            onClick={() =>
              onDepGraph
                ? onDepGraph()
                : void navigate({ to: "/dep-graph", search: (prev) => prev })
            }
            style={{
              fontFamily: C.mono,
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 6,
              background: "transparent",
              border: `1px solid ${C.border}`,
              color: C.fgMuted,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
            title="Open backlog dependency graph"
          >
            Dep Graph
          </button>
        </HeaderActions>

        {/* body — CTL-989 board-height fix: a flex COLUMN so the scroller child can
            `flex:1; minHeight:0` and FILL the remaining space below the subhead
            (replacing the embedded `100% - 104px` magic subtraction that left dead
            space below the columns). `minHeight:0` lets it shrink inside the flex
            parent; `display:flex` is the load-bearing addition. */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {!data && (
            <div style={{ color: C.fgMuted, padding: 24 }}>Connecting to execution-core…</div>
          )}
          {/* BOARD3 / CTL-907: row swimlanes. <SwimlaneBoard> groups the entities
              through the pure board-grouping engine and renders one labeled lane
              per group around the SAME column board — collapsing to the bare flat
              board for a single lane (the identity no-op: none / single-team /
              single-node / single-repo / single-repo-scope). The TicketBoard /
              WorkerBoard renderers are unchanged. */}
          {data &&
            view === "tickets" &&
            // BOARD4 / CTL-908: fork the Tickets body on the Layout toggle. "list"
            // renders the dense BoardList table (its own swimlane sectioning via
            // groupListRows, so NOT wrapped in SwimlaneBoard); "board" keeps the
            // untouched column kanban. Flipping back restores the kanban with the
            // SAME lens/filters/density/live cards — all live in shared atoms, never
            // in BoardList.
            (prefs.layout === "list" ? (
              <BoardList
                kind="ticket"
                tickets={fTickets}
                lens={lens}
                order={prefs.order}
                density={prefs.density}
                swimlane={swimlane}
                onOpen={onOpen}
                embedded={embedded}
                laneColors={laneColors}
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
                embedded={embedded}
                onOpen={onOpen}
                laneColors={laneColors}
                repoAccents={repoAccents}
              />
            ))}
          {data && view === "workers" && workerSurface === "dispatch" && (
            // CTL-1098: Dispatch screen — ControlTower owns its own scroll container.
            // The pipeline board is NOT mounted here, so the swimlane's sticky header
            // cannot escape into this scroller.
            <div
              className="cat-overlay-scroll cat-board-scroll"
              data-scroll-restoration-id="dispatch-scroll"
              style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
            >
              <ControlTower
                payload={data}
                onOpenTicket={(key) => openDetail(navigate, "ticket", key, { ids: [] })}
              />
            </div>
          )}
          {data && view === "workers" && workerSurface === "board" && (
            // CTL-1098: Board screen — WorkerSwimlaneBoard owns its own scroll
            // (fill embedded → SwimlaneBoard root is flex:1/minHeight:0, Swimlane.tsx:722),
            // so the sticky ColumnHeaderRow pins inside the board's own scroller.
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
              grouping={
                swimlane === "host" && workerGrouping === "node" ? "status" : workerGrouping
              }
              fill={true}
              embedded={true}
              onOpen={onOpen}
              laneColors={laneColors}
            />
          )}
        </div>
        {/* CTL-951: the TicketDetailDrawer is removed — a plain card click now
            navigates STRAIGHT to /ticket/$id (the full detail page). */}
      </div>
    </TooltipProvider>
  );
}
