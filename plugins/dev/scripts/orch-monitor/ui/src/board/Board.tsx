import { Fragment, useEffect, useMemo, useState } from "react";
import { useAtom } from "jotai";
import { TicketDetailDrawer } from "@/components/ticket-detail-drawer";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { fmtDuration } from "../lib/formatters";
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
// ── BOARD2 / CTL-906: the display-options popover + its persisted prefs ────────
// One toolbar button owns every board display choice (density / grouping /
// ordering / color / show-empty / repo-lanes). The three scattered subhead Seg
// toggles (lens, colorBy, repo-lanes) are folded into it; their state moves from
// local useState into the persisted boardPrefsAtom so the choices survive a
// reload. The PURE column-derivation (group-by column set + show-empty filter +
// in-column order) lives in board-display.ts so the Gherkin is DOM-free testable.
import { boardPrefsAtom, type Density } from "./prefs-store";
import { DisplayOptionsPopover } from "./display-options-popover";
import { ticketColumns, PHASE_COLUMNS } from "./board-display";
// ── BOARD3 / CTL-907: row swimlanes (none | repo | team | project | host) ──────
// The generalized grouping engine (board-grouping.ts) + the presentational
// <SwimlaneBoard> wrapper that renders one labeled lane per group around the
// column board, collapsing to the bare flat board for a single lane (the
// identity no-op). Replaces the repo-only Lane/ticketLanes/combined path. The
// shared `C` / `LIVE` tokens are hoisted to board-tokens.ts.
import { C, LIVE } from "./board-tokens";
import { SwimlaneBoard } from "./Swimlane";
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
// BOARD3 / CTL-907 §8.5: the `C` palette + the reserved `LIVE` signal are hoisted
// to board-tokens.ts so the swimlane chrome (Swimlane.tsx) split out of this file
// imports the SAME object — one source for the hexes, not two copies.
const PHASE_C: Record<string, string> = {
  triage: "#64748b", research: "#3b82f6", plan: "#a855f7", implement: "#10b981",
  verify: "#f59e0b", remediate: "#f472b6", review: "#eab308", pr: "#14b8a6",
  "monitor-merge": "#4ea1ff", "monitor-deploy": "#39d07a", teardown: "#6b7280", merge: "#4ea1ff", deploy: "#39d07a", done: "#6b7280",
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
const TYPE_C: Record<string, string> = {
  feature: "#4ea1ff", bug: "#ef5d5d", refactor: "#a855f7", chore: "#8b93a1", docs: "#39d07a", test: "#eabc3b",
};
const repoColor = (repo: string) => (repo === "adva" ? "#c084fc" : "#4ea1ff");
const isActive = (s: ActiveState) => s === "active";
// CTL-909 / SURF1: a stable per-node accent so the "group by Node" columns +
// the host chip on each worker card carry a consistent color. Hashed from the
// host name (the unattributed bucket reads dim) — deterministic, no palette
// state, and the single-host case simply gets its one color.
const NODE_PALETTE = ["#4ea1ff", "#39d07a", "#a855f7", "#eabc3b", "#f472b6", "#5be0ff", "#fb8b3a"];
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
  return "#5b6b80";
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

const PULSE_CSS = `
@keyframes catalystLivePing { 0%{box-shadow:0 0 0 0 rgba(91,224,255,.6)} 70%{box-shadow:0 0 0 6px rgba(91,224,255,0)} 100%{box-shadow:0 0 0 0 rgba(91,224,255,0)} }
@keyframes catalystLiveRing { 0%,100%{box-shadow:inset 0 0 0 1px rgba(91,224,255,.4), 0 0 14px rgba(91,224,255,.08)} 50%{box-shadow:inset 0 0 0 1px rgba(91,224,255,.8), 0 0 24px rgba(91,224,255,.2)} }
.catalyst-live { animation: catalystLiveRing 1.9s ease-in-out infinite; }
.catalyst-live-dot { animation: catalystLivePing 1.9s infinite; }
.cat-scroll::-webkit-scrollbar { width:9px; height:9px; }
.cat-scroll::-webkit-scrollbar-thumb { background:#2a323d; border-radius:6px; }
.cat-scroll::-webkit-scrollbar-track { background:transparent; }
/* token-lock the shadcn Tabs nav to our dark surfaces (stock bg-muted is too light) */
.cat-nav [role="tablist"] { background:#16191f; border:1px solid #262d36; height:auto; padding:3px; gap:2px; }
.cat-nav [role="tab"] { color:#8b93a1; flex:0 0 auto; padding:4px 13px; font-size:12.5px; box-shadow:none; border:none; }
.cat-nav [role="tab"]:hover { color:#e6e9ef; }
.cat-nav [role="tab"][data-state="active"] { background:#1c2028; color:#e6e9ef; box-shadow:inset 0 0 0 1px #262d36; }
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
      <rect x="0.5" y="0.5" width="13" height="13" rx="3" fill="#fb8b3a" />
      <rect x="6.1" y="2.8" width="1.8" height="5.2" rx="0.9" fill="#1b1206" />
      <rect x="6.1" y="9.4" width="1.8" height="1.9" rx="0.95" fill="#1b1206" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-label={PRIORITY_LABEL[p]}>
      {[{ x: 1, h: 5 }, { x: 5.5, h: 9 }, { x: 10, h: 13 }].map((b, i) => {
        const filled = i < (p === 2 ? 3 : p === 3 ? 2 : p === 4 ? 1 : 0);
        return <rect key={i} x={b.x} y={14 - b.h} width="3" height={b.h} rx="1" fill={filled ? "#cdd3dd" : "#39424d"} />;
      })}
    </svg>
  );
  return (
    <Tooltip><TooltipTrigger asChild><span style={{ display: "inline-flex", flex: "0 0 auto" }}>{icon}</span></TooltipTrigger>
      <TooltipContent>{PRIORITY_LABEL[p] || "No priority"}</TooltipContent></Tooltip>
  );
}
const SCOPE_ABBR: Record<string, string> = { xs: "XS", small: "S", medium: "M", large: "L", xl: "XL" };
export function ScopeChip({ scope, estimate }: { scope: string | null; estimate: number | null }) {
  if (estimate != null) return <Badge variant="outline" style={{ fontFamily: C.mono, fontSize: 10 }}>{estimate}pt</Badge>;
  if (!scope) return null;
  return (
    <Tooltip><TooltipTrigger asChild><Badge variant="outline" style={{ fontFamily: C.mono, fontSize: 10 }}>{SCOPE_ABBR[scope] || scope}</Badge></TooltipTrigger>
      <TooltipContent>scope: {scope}</TooltipContent></Tooltip>
  );
}
export function StatusBadge({ status }: { status: string }) {
  const meta: Record<string, { label: string; fg: string; bg: string }> = {
    failed: { label: "failed", fg: "#f4a8a8", bg: "rgba(239,93,93,0.14)" },
    stalled: { label: "stalled", fg: "#f4dc8a", bg: "rgba(234,188,59,0.14)" },
    aborted: { label: "aborted", fg: "#8b93a1", bg: "#1c2028" },
    superseded: { label: "superseded", fg: "#8b93a1", bg: "#1c2028" },
    skipped: { label: "skipped", fg: "#5b626f", bg: "#16191f" },
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
  const fg = isBlocked ? "#f4a8a8" : "#f4dc8a";
  const bg = isBlocked ? "rgba(239,93,93,0.14)" : "rgba(234,188,59,0.14)";
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
function TicketCard({ t, colorBy, density = "comfortable", onSelect }: { t: Ticket; colorBy: ColorBy; density?: Density; onSelect?: (id: string) => void }) {
  const accent = accentFor(t, colorBy);
  const live = t.activeState === "active";
  const stuck = t.activeState === "stuck";
  const dim = t.activeState == null;
  const compact = density === "compact";
  return (
    <div
      className={live ? "catalyst-live" : undefined}
      style={{
        background: live ? C.s3 : C.s2, borderRadius: 10, padding: compact ? "7px 10px" : "11px 13px",
        border: `1px solid ${stuck ? "rgba(239,93,93,0.5)" : C.border}`,
        opacity: dim ? 0.5 : 1, filter: dim ? "saturate(0.6)" : undefined, transition: "opacity .25s, background .25s",
        cursor: onSelect ? "pointer" : undefined,
      }}
      onClick={onSelect ? () => onSelect(t.id) : undefined}
    >
      <div style={{ display: "flex", alignItems: "center", gap: compact ? 5 : 7 }}>
        <ActivityDot state={t.activeState} fallback={accent} />
        <PriorityIcon p={t.priority} />
        <span style={{ fontFamily: C.mono, fontSize: 11.5, fontWeight: 600, color: C.blue }}>{t.id}</span>
        <span style={{ flex: 1 }} />
        {live && <span style={{ fontFamily: C.mono, fontSize: 10, color: LIVE }}>{t.working ? "working" : "active"}</span>}
        {stuck && <span style={{ fontFamily: C.mono, fontSize: 10, color: C.red }}>stuck</span>}
        {!compact && <Badge variant="secondary" style={{ fontFamily: C.mono, fontSize: 10 }}>{t.type}</Badge>}
      </div>
      <TitleText text={t.title} clamp={compact ? 1 : 2} />
      <div style={{ display: "flex", alignItems: "center", gap: compact ? 5 : 7, flexWrap: "wrap" }}>
        <PhasePill phase={t.phase} />
        <HeldBadge held={t.held} blockers={t.blockers} />
        <StatusBadge status={t.status} />
        {!compact && <ScopeChip scope={t.scope} estimate={t.estimate} />}
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
    </div>
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
function WorkerCard({ w, info, onSelect }: { w: Worker; info?: Ticket; onSelect?: (name: string) => void }) {
  const accent = PHASE_C[w.phase] || C.blue;
  const live = w.activeState === "active";
  const stuck = w.activeState === "stuck";
  const attempt = Number(/:(\d+)$/.exec(w.name)?.[1] ?? 1);
  const seen = w.lastActiveMs != null ? fmtMsAgo(w.lastActiveMs) : null;
  return (
    <div
      className={live ? "catalyst-live" : undefined}
      // CTL-909 / SURF1: clicking a worker card deep-links to its single-run
      // detail page (`/worker/$id`, keyed by w.name) via the supplied callback.
      // When no callback is wired (the legacy embedded mount has no router) the
      // card stays non-interactive exactly as before — no regression.
      onClick={onSelect ? () => onSelect(w.name) : undefined}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={onSelect ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(w.name); } } : undefined}
      style={{
        background: live ? C.s3 : C.s2, borderRadius: 10, padding: "11px 13px",
        border: `1px solid ${stuck ? "rgba(239,93,93,0.5)" : C.border}`, opacity: stuck ? 0.7 : 1,
        cursor: onSelect ? "pointer" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <ActivityDot state={w.activeState} fallback={accent} />
        {info && <PriorityIcon p={info.priority} />}
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
    </div>
  );
}

// ── column + board scaffolding (wide Linear columns, internal vertical scroll) ──
function Column({ label, color, count, live = 0, children }: { label: string; color: string; count: number; live?: number; children: React.ReactNode }) {
  return (
    <div style={{ flex: "0 0 300px", width: 300, display: "flex", flexDirection: "column", minHeight: 0, maxHeight: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 4px 12px" }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: color, flex: "0 0 auto" }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: C.fg, letterSpacing: 0.2 }}>{label}</span>
        <span style={{ fontFamily: C.mono, fontVariantNumeric: "tabular-nums", fontSize: 11, color: C.fgMuted, background: C.s3, padding: "1px 7px", borderRadius: 9 }}>{count}</span>
        {live > 0 && (
          <span title={`${live} worker${live > 1 ? "s" : ""} live in this phase`} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: C.mono, fontSize: 11, color: LIVE }}>
            <span className="catalyst-live-dot" style={{ width: 7, height: 7, borderRadius: "50%", background: LIVE, display: "inline-block" }} />{live} live
          </span>
        )}
      </div>
      <div className="cat-scroll" style={{ display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", paddingRight: 4, paddingBottom: 12 }}>
        {count === 0
          ? <div style={{ color: C.fgDim, fontSize: 11.5, padding: "10px 0", border: `1px dashed ${C.borderSubtle}`, borderRadius: 8, textAlign: "center" }}>—</div>
          : children}
      </div>
    </div>
  );
}
function BoardScroll({ children, fill }: { children: React.ReactNode; fill: boolean }) {
  return (
    <div className="cat-scroll" style={{ display: "flex", gap: 16, overflowX: "auto", alignItems: "flex-start", padding: "2px 16px 8px", height: fill ? "calc(var(--cat-board-vh, 100vh) - 104px)" : "auto" }}>
      {children}
    </div>
  );
}

// BOARD2 / CTL-906: the column derivation (which column SET by `groupBy`, the
// in-column `order`, and the `showEmpty` reflow filter) is the PURE
// `ticketColumns` helper (board-display.ts) — TicketBoard renders exactly the
// columns it returns, so the Gherkin (Column grouping / Ordering / Show empty
// columns) is unit-tested without a DOM. Each column still resolves its items
// through the shared `resolveList` inside ticketColumns, so the on-screen order
// stays the SAME list the detail-page pager + j/k walk derive (FND2 P1).
function TicketBoard({ tickets, groupBy, colorBy, density, order, showEmpty, fill, onSelect }: { tickets: Ticket[]; groupBy: "linear" | "phase"; colorBy: ColorBy; density: Density; order: Ordering; showEmpty: boolean; fill: boolean; onSelect?: (id: string) => void }) {
  const cols = ticketColumns(tickets, { groupBy, showEmptyColumns: showEmpty, order });
  return (
    <BoardScroll fill={fill}>
      {cols.map((c) => (
        <Column key={c.key} label={c.label} color={c.c} count={c.items.length} live={c.live}>
          {c.items.map((t) => <TicketCard key={t.id} t={t} colorBy={colorBy} density={density} onSelect={onSelect} />)}
        </Column>
      ))}
    </BoardScroll>
  );
}
function WorkerBoard({ workers, tickets, grouping, fill, onWorkerSelect }: { workers: Worker[]; tickets: Ticket[]; grouping: WorkerGrouping; fill: boolean; onWorkerSelect?: (name: string) => void }) {
  const infoById: Record<string, Ticket> = Object.fromEntries(tickets.map((t) => [t.id, t]));
  // CTL-909 / SURF1: "node" grouping lays out one column per host.name via the
  // pure nodeColumns derivation (single-host → one column, identity no-op). The
  // status/phase lenses are unchanged.
  if (grouping === "node") {
    const cols = nodeColumns(workers);
    return (
      <BoardScroll fill={fill}>
        {cols.map((c) => {
          const live = c.workers.filter((w) => w.activeState === "active").length;
          return (
            <Column key={c.host} label={c.host} color={nodeColor(c.host)} count={c.workers.length} live={live}>
              {c.workers.map((w) => <WorkerCard key={w.name} w={w} info={infoById[w.ticket]} onSelect={onWorkerSelect} />)}
            </Column>
          );
        })}
      </BoardScroll>
    );
  }
  const cols: readonly { key: string; label: string; c: string }[] =
    grouping === "phase" ? PHASE_COLUMNS : WORKER_COLS;
  return (
    <BoardScroll fill={fill}>
      {cols.map((c) => {
        const items = grouping === "phase"
          ? workers.filter((w) => w.phase === c.key)
          : workers.filter((w) => (w.activeState ?? "active") === c.key);
        // Status columns are already split by liveness (Active/Stuck), so the
        // "N live" chip is redundant there; only surface it in the phase lens.
        const live = grouping === "phase" ? items.filter((w) => w.activeState === "active").length : 0;
        return (
          <Column key={c.key} label={c.label} color={c.c} count={items.length} live={live}>
            {items.map((w) => <WorkerCard key={w.name} w={w} info={infoById[w.ticket]} onSelect={onWorkerSelect} />)}
          </Column>
        );
      })}
    </BoardScroll>
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
function QueueRow({ q, freeSlots, showHost }: { q: QueueItem; freeSlots: number; showHost: boolean }) {
  return (
    <TableRow style={{ background: q.rank <= freeSlots ? "rgba(57,208,122,0.06)" : undefined }}>
      <TableCell style={{ ...mono, color: C.fgMuted }}>{q.rank}</TableCell>
      <TableCell><PriorityIcon p={q.priority} /></TableCell>
      <TableCell style={{ ...mono, ...td, color: C.blue, fontWeight: 600 }}>{q.id}</TableCell>
      <TableCell style={{ ...td, ...ellip, maxWidth: 0 }}>{q.title}</TableCell>
      <TableCell><ScopeChip scope={q.scope} estimate={q.estimate} /></TableCell>
      <TableCell style={{ ...mono, fontSize: 11, color: C.fgDim }}>{q.repo}</TableCell>
      {showHost && (
        <TableCell style={{ ...mono, fontSize: 11, color: q.host ? C.fgMuted : C.fgDim }}>{q.host?.name ?? "—"}</TableCell>
      )}
    </TableRow>
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
            {queue.map((q) => <QueueRow key={q.id} q={q} freeSlots={freeSlots} showHost={showHost} />)}
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
              {g.items.map((q) => <QueueRow key={q.id} q={q} freeSlots={freeSlots} showHost={showHost} />)}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// CTL-910 / SURF2: the wide, ranked Queue surface. Promoted from the board's
// internal Queue tab into the shell as its own route (see QueueSurface, which
// connects the board transport and mounts this embedded). Reused near-verbatim
// from the original board Queue tab: capacity Stats + SlotBar + an in-flight table
// + a waiting ranked table. NEW for SURF2: an optional per-node column + a
// group-by-node toggle, both gated behind queueHostMode so a single-host fleet is
// an exact identity no-op (no node column, no toggle, no added noise).
export function QueueView({ data, embedded = false }: { data: BoardPayload; embedded?: boolean }) {
  const { config, queue, workers, tickets } = data;
  const infoById: Record<string, Ticket> = Object.fromEntries(tickets.map((t) => [t.id, t]));
  // Order through the SHARED comparator (CTL-882 / FND2): rank(active=0, stuck=2,
  // else=1) then runtimeMs desc — the same order the worker pager + j/k walk
  // resolve via resolveList({kind:"worker"}). Byte-for-byte the prior inline sort.
  const inflight = sortWorkers(workers);
  // SINGLE-HOST IDENTITY NO-OP: only surface the node column / group affordance
  // when the queue spans two or more DISTINCT owner hosts. With hosts.json absent
  // or length 1 every row resolves to one host (or none), so this is "single" and
  // the table renders exactly as it did pre-SURF2.
  const multiHost = queueHostMode(queue) === "multi";
  const [groupByNode, setGroupByNode] = useState(false);
  // The toggle only makes sense in a multi-node fleet; never grouped single-host.
  const grouped = multiHost && groupByNode;
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

        <div style={{ fontSize: 12, fontWeight: 600, color: C.fgMuted, margin: "0 0 8px" }}>On the plate — in flight ({inflight.length})</div>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 22 }}>
          <Table>
            <TableHeader><TableRow style={{ background: C.s1 }}>
              <TableHead style={{ ...th, width: 40 }}></TableHead><TableHead style={{ ...th, width: 44 }}>Pri</TableHead>
              <TableHead style={{ ...th, width: 100 }}>Ticket</TableHead><TableHead style={th}>Title</TableHead>
              <TableHead style={{ ...th, width: 130 }}>Phase</TableHead><TableHead style={{ ...th, width: 84 }}>Status</TableHead><TableHead style={{ ...th, width: 76 }}>Age</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {inflight.map((w) => (
                <TableRow key={w.name} style={{ opacity: w.activeState === "stuck" ? 0.6 : 1 }}>
                  <TableCell><ActivityDot state={w.activeState} fallback={PHASE_C[w.phase] || C.blue} /></TableCell>
                  <TableCell><PriorityIcon p={infoById[w.ticket]?.priority ?? 0} /></TableCell>
                  <TableCell style={{ ...mono, ...td, color: C.blue, fontWeight: 600 }}>{w.ticket}</TableCell>
                  <TableCell style={{ ...td, ...ellip, maxWidth: 0 }}>{infoById[w.ticket]?.title || ""}</TableCell>
                  <TableCell><PhasePill phase={w.phase} /></TableCell>
                  <TableCell style={{ ...mono, fontSize: 11, color: isActive(w.activeState) ? LIVE : w.activeState === "stuck" ? C.red : C.fgDim }}>{isActive(w.activeState) ? (w.working ? "working" : "active") : w.activeState}</TableCell>
                  <TableCell style={{ ...mono, fontSize: 11, color: C.fgDim }}>{fmtRuntime(w.runtimeMs)}</TableCell>
                </TableRow>
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

// ── shell (real shadcn Tabs + ToggleGroup, TooltipProvider) ─────────────────
type View = "tickets" | "workers" | "queue";
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
// CTL-909 / SURF1:
//   - `initialView` lets a host (e.g. the Workers app-shell surface) open the
//     board straight onto the Workers grid instead of the Tickets default.
//   - `onWorkerSelect` is the worker-card deep-link: the routed `/` board passes
//     a `useNavigate`-backed callback to `/worker/$id`; when absent (the embedded
//     mount has no router) the cards stay non-interactive, exactly as before.
export function Board({
  embedded = false,
  initialView = "tickets",
  onWorkerSelect,
}: { embedded?: boolean; initialView?: View; onWorkerSelect?: (name: string) => void } = {}) {
  const [data, setData] = useState<BoardPayload | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [view, setView] = useState<View>(initialView);
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
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);

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
  // BOARD3 / CTL-907: the generalized row-swimlane axis (none | repo | team |
  // project | host) the display-options popover writes to `prefs.swimlane`. The
  // pure board-grouping engine (buildLanes, inside <SwimlaneBoard>) now OWNS lane
  // resolution — the repo-only ticketLanes/workerLanes/combined derivation is gone.
  // A specific repo scope collapses to the flat board (a single repo has no lanes
  // to draw) by mapping the axis to "none" — preserving today's "filter ⇒ flat"
  // semantic exactly (the conservative R3 default; buildLanes would otherwise still
  // collapse to one lane for the repo axis, and could show team/host lanes within
  // one repo — a deliberate, separate product decision, not regressed here).
  const effectiveGroupBy: GroupBy = repo !== "all" ? "none" : prefs.swimlane;
  const selectedTicket =
    selectedTicketId != null
      ? (data?.tickets ?? []).find((t) => t.id === selectedTicketId) ?? null
      : null;

  return (
    <TooltipProvider delayDuration={200}>
      <div style={{ [BOARD_VH_VAR]: boardRootHeight(embedded), background: C.s0, color: C.fg, height: `var(${BOARD_VH_VAR})`, display: "flex", flexDirection: "column", fontSize: 13, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', overflow: "hidden" } as React.CSSProperties}>
        <style>{PULSE_CSS}</style>
        {/* chrome */}
        <header style={{ height: 48, display: "flex", alignItems: "center", gap: 18, padding: "0 16px", background: C.s1, borderBottom: `1px solid ${C.border}`, flex: "0 0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, fontWeight: 600 }}>
            <span style={{ width: 16, height: 16, borderRadius: 4, background: "linear-gradient(135deg,#4ea1ff,#39d07a)", boxShadow: "0 0 12px rgba(78,161,255,0.45)" }} />Catalyst
          </div>
          <div className="cat-nav">
            <Tabs value={view} onValueChange={(v) => setView(v as View)}>
              <TabsList>
                <TabsTrigger value="tickets">Tickets</TabsTrigger>
                <TabsTrigger value="workers">Workers</TabsTrigger>
                <TabsTrigger value="queue">Queue</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <span style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 11.5, color: C.fgMuted }}>
            {data && <span style={{ display: "flex", alignItems: "center", gap: 6, color: C.fg }}><span className="catalyst-live-dot" style={{ width: 8, height: 8, borderRadius: "50%", background: LIVE, display: "inline-block" }} />{data.config.active} active{data.config.stuck > 0 ? ` · ${data.config.stuck} stuck` : ""}</span>}
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot color={C.green} pulse /> daemon</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot color={C.green} pulse /> broker</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot color={C.green} pulse /> monitor</span>
            <span style={{ fontFamily: C.mono, fontSize: 10, letterSpacing: 1.5, color: status === "connected" ? C.green : C.red, border: `1px solid ${status === "connected" ? "rgba(57,208,122,0.35)" : "rgba(239,93,93,0.35)"}`, borderRadius: 5, padding: "2px 6px" }}>{status === "connected" ? "LIVE" : "OFFLINE"}</span>
          </div>
        </header>

        {/* subhead */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 16px", flex: "0 0 auto", flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{view === "tickets" ? "Tickets" : view === "workers" ? "Workers" : "Capacity & queue"}</h1>
          <span style={{ color: C.fgMuted, fontSize: 12 }}>{view === "tickets" ? "Where each ticket sits in the pipeline · cyan = a worker is live on it now" : view === "workers" ? "Workers the daemon has deployed — active vs stuck" : "What's on the plate, and what dispatches next"}</span>
          <span style={{ flex: 1 }} />
          {repos.length > 1 && <Seg value={repo} onChange={setRepo} options={[{ k: "all", label: "All" }, ...repos.map((r) => ({ k: r, label: r }))]} />}
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
        </div>

        {/* body */}
        <div style={{ flex: 1, minHeight: 0 }}>
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
            // in BoardList. effectiveGroupBy carries the same "scoped-repo => flat"
            // collapse the kanban lanes use.
            prefs.layout === "list" ? (
              <BoardList
                kind="ticket"
                tickets={fTickets}
                lens={lens}
                order={prefs.order}
                density={prefs.density}
                swimlane={effectiveGroupBy}
                onSelect={(id) => setSelectedTicketId(id)}
                embedded={embedded}
              />
            ) : (
              <SwimlaneBoard
                items={fTickets}
                groupBy={effectiveGroupBy}
                fill
                renderBoard={(laneItems, laneFill) => (
                  <TicketBoard tickets={laneItems} groupBy={lens} colorBy={colorBy} density={prefs.density} order={prefs.order} showEmpty={prefs.showEmptyColumns} fill={laneFill} onSelect={(id) => setSelectedTicketId(id)} />
                )}
              />
            )
          )}
          {data && view === "workers" && (
            // CTL-909 / SURF1: the node FILTER scopes the grid to one host
            // (`nodeWorkers`; "all" is the identity no-op). Swimlanes (rows) and the
            // node filter (scope) are orthogonal: filter first, then group. R3b: when
            // the HOST swimlane is active the column lens falls back to status/phase
            // inside each lane so host is not double-encoded (rows AND columns).
            <SwimlaneBoard
              items={nodeWorkers}
              groupBy={effectiveGroupBy}
              fill
              renderBoard={(laneItems, laneFill) => (
                <WorkerBoard workers={laneItems} tickets={data.tickets} grouping={effectiveGroupBy === "host" && workerGrouping === "node" ? "status" : workerGrouping} fill={laneFill} onWorkerSelect={onWorkerSelect} />
              )}
            />
          )}
          {data && view === "queue" && <QueueView data={{ ...data, queue: data.queue.filter((q) => repo === "all" || q.repo === repo) }} />}
        </div>
        {selectedTicket && (
          <TicketDetailDrawer
            ticket={selectedTicket}
            onClose={() => setSelectedTicketId(null)}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
