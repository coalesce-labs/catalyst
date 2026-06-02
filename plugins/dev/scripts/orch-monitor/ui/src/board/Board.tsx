import { useEffect, useMemo, useState } from "react";
import { TicketDetailDrawer } from "@/components/ticket-detail-drawer";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { fmtDuration } from "../lib/formatters";
// ── types + transport (hoisted to ./types + ./board-client for CTL-733 PR-2b) ─
import { connectBoard } from "./board-client";
import type {
  BoardPayload,
  BoardWorker as Worker,
  BoardTicket as Ticket,
  BoardActiveState as ActiveState,
} from "./types";
import type { ConnectionStatus } from "@/lib/types";

// ── tokens (orch-monitor DESIGN.md) ─────────────────────────────────────────
const C = {
  s0: "#0b0d10", s1: "#111318", s2: "#16191f", s3: "#1c2028",
  border: "#262d36", borderSubtle: "#1e242c",
  fg: "#e6e9ef", fgMuted: "#8b93a1", fgDim: "#5b626f",
  green: "#39d07a", blue: "#4ea1ff", red: "#ef5d5d", yellow: "#eabc3b",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};
const LIVE = "#5be0ff"; // reserved "in-loop" color — deliberately not green/phase
const PHASE_C: Record<string, string> = {
  triage: "#64748b", research: "#3b82f6", plan: "#a855f7", implement: "#10b981",
  verify: "#f59e0b", remediate: "#f472b6", review: "#eab308", pr: "#14b8a6",
  "monitor-merge": "#4ea1ff", "monitor-deploy": "#39d07a", merge: "#4ea1ff", deploy: "#39d07a", done: "#6b7280",
};
const LINEAR_COLS = [
  { key: "Research", c: "#3b82f6" }, { key: "Plan", c: "#a855f7" }, { key: "Implement", c: "#10b981" },
  { key: "Validate", c: "#f59e0b" }, { key: "PR", c: "#14b8a6" }, { key: "Done", c: "#6b7280" },
];
const PHASE_COLS = [
  { key: "triage", label: "Triage", c: "#64748b" }, { key: "research", label: "Research", c: "#3b82f6" },
  { key: "plan", label: "Plan", c: "#a855f7" }, { key: "implement", label: "Implement", c: "#10b981" },
  { key: "verify", label: "Verify", c: "#f59e0b" }, { key: "review", label: "Review", c: "#eab308" },
  { key: "pr", label: "PR", c: "#14b8a6" }, { key: "monitor-merge", label: "Merge", c: "#4ea1ff" },
  { key: "monitor-deploy", label: "Deploy", c: "#39d07a" },
];
const WORKER_COLS = [
  { key: "active", label: "Active", c: LIVE }, { key: "stuck", label: "Stuck", c: C.red },
];
// Phase statuses that mean a phase is no longer running. MUST stay in lock-step
// with the TERMINAL set in lib/board-data.mjs (the data-layer source of truth) —
// board-phase-drift.test.ts asserts this array equals [...TERMINAL] so a new
// terminal status added there cannot silently render here as a live phase
// (CTL-754).
const TERMINAL_STATUSES = ["done", "failed", "stalled", "skipped", "signal_corrupt", "superseded", "canceled"];

type ColorBy = "phase" | "status" | "repo" | "type";
const TYPE_C: Record<string, string> = {
  feature: "#4ea1ff", bug: "#ef5d5d", refactor: "#a855f7", chore: "#8b93a1", docs: "#39d07a", test: "#eabc3b",
};
const repoColor = (repo: string) => (repo === "adva" ? "#c084fc" : "#4ea1ff");
const isActive = (s: ActiveState) => s === "active";

function accentFor(t: { phase: string; repo: string; type: string; activeState: ActiveState; status: string }, by: ColorBy): string {
  if (by === "phase") return PHASE_C[t.phase] || C.blue;
  if (by === "repo") return repoColor(t.repo);
  if (by === "type") return TYPE_C[t.type] || C.fgMuted;
  if (t.activeState === "active") return LIVE;
  if (t.activeState === "stuck" || t.status === "failed") return C.red;
  return "#5b6b80";
}

const fmtRuntime = (ms: number | null) => {
  if (!ms || !Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const fmtAgo = (iso: string) => {
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
const fmtMsAgo = (ms: number) => {
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
function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block", flex: "0 0 auto", boxShadow: pulse ? `0 0 8px ${color}` : undefined }} />;
}
function ActivityDot({ state, fallback }: { state: ActiveState; fallback: string }) {
  if (state === "active") return <span className="catalyst-live-dot" style={{ width: 8, height: 8, borderRadius: "50%", background: LIVE, display: "inline-block", flex: "0 0 auto" }} />;
  if (state === "stuck") return <Dot color={C.red} />;
  return <Dot color={fallback} />;
}
function PhasePill({ phase }: { phase: string }) {
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
function PriorityIcon({ p, size = 14 }: { p: number; size?: number }) {
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
function ScopeChip({ scope, estimate }: { scope: string | null; estimate: number | null }) {
  if (estimate != null) return <Badge variant="outline" style={{ fontFamily: C.mono, fontSize: 10 }}>{estimate}pt</Badge>;
  if (!scope) return null;
  return (
    <Tooltip><TooltipTrigger asChild><Badge variant="outline" style={{ fontFamily: C.mono, fontSize: 10 }}>{SCOPE_ABBR[scope] || scope}</Badge></TooltipTrigger>
      <TooltipContent>scope: {scope}</TooltipContent></Tooltip>
  );
}
function StatusBadge({ status }: { status: string }) {
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
function Cost({ v }: { v: number | null }) {
  return <span style={{ fontFamily: C.mono, fontVariantNumeric: "tabular-nums", fontSize: 10.5, color: v == null ? C.fgDim : C.fgMuted }}>{v == null ? "—" : `$${v.toFixed(2)}`}</span>;
}
function TitleText({ text }: { text: string }) {
  return (
    <Tooltip><TooltipTrigger asChild>
      <div style={{ color: C.fg, fontSize: 13, lineHeight: 1.35, margin: "7px 0 9px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", cursor: "default" }}>{text}</div>
    </TooltipTrigger><TooltipContent style={{ maxWidth: 360 }}>{text}</TooltipContent></Tooltip>
  );
}

// ── Linear-style ticket card ────────────────────────────────────────────────
function TicketCard({ t, colorBy, onSelect }: { t: Ticket; colorBy: ColorBy; onSelect?: (id: string) => void }) {
  const accent = accentFor(t, colorBy);
  const live = t.activeState === "active";
  const stuck = t.activeState === "stuck";
  const dim = t.activeState == null;
  return (
    <div
      className={live ? "catalyst-live" : undefined}
      style={{
        background: live ? C.s3 : C.s2, borderRadius: 10, padding: "11px 13px",
        border: `1px solid ${stuck ? "rgba(239,93,93,0.5)" : C.border}`,
        opacity: dim ? 0.5 : 1, filter: dim ? "saturate(0.6)" : undefined, transition: "opacity .25s, background .25s",
        cursor: onSelect ? "pointer" : undefined,
      }}
      onClick={onSelect ? () => onSelect(t.id) : undefined}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <ActivityDot state={t.activeState} fallback={accent} />
        <PriorityIcon p={t.priority} />
        <span style={{ fontFamily: C.mono, fontSize: 11.5, fontWeight: 600, color: C.blue }}>{t.id}</span>
        <span style={{ flex: 1 }} />
        {live && <span style={{ fontFamily: C.mono, fontSize: 10, color: LIVE }}>{t.working ? "working" : "active"}</span>}
        {stuck && <span style={{ fontFamily: C.mono, fontSize: 10, color: C.red }}>stuck</span>}
        <Badge variant="secondary" style={{ fontFamily: C.mono, fontSize: 10 }}>{t.type}</Badge>
      </div>
      <TitleText text={t.title} />
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
        <PhasePill phase={t.phase} />
        <StatusBadge status={t.status} />
        <ScopeChip scope={t.scope} estimate={t.estimate} />
        {t.project && <Badge variant="outline" style={{ fontSize: 10, color: C.fgDim }}>{t.project}</Badge>}
      </div>
      <PhaseStrip phaseSummary={t.phaseSummary} />
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 9 }}>
        <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }}>
          {t.activeState == null && t.status !== "done" ? `idle · ${fmtAgo(t.updatedAt)}` : fmtAgo(t.updatedAt)}
        </span>
        <span style={{ flex: 1 }} />
        {t.turns != null && <span style={{ fontFamily: C.mono, fontSize: 10, color: C.fgDim }} title="total turns">{t.turns}t</span>}
        {t.pr ? <span style={{ fontFamily: C.mono, fontSize: 10.5, color: C.green }}>#{t.pr}</span> : <Cost v={t.costUSD} />}
      </div>
    </div>
  );
}

// ── worker card (Workers board) ─────────────────────────────────────────────
function WorkerCard({ w, info }: { w: Worker; info?: Ticket }) {
  const accent = PHASE_C[w.phase] || C.blue;
  const live = w.activeState === "active";
  const stuck = w.activeState === "stuck";
  const attempt = Number(/:(\d+)$/.exec(w.name)?.[1] ?? 1);
  const seen = w.lastActiveMs != null ? fmtMsAgo(w.lastActiveMs) : null;
  return (
    <div className={live ? "catalyst-live" : undefined} style={{
      background: live ? C.s3 : C.s2, borderRadius: 10, padding: "11px 13px",
      border: `1px solid ${stuck ? "rgba(239,93,93,0.5)" : C.border}`, opacity: stuck ? 0.7 : 1,
    }}>
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
    <div className="cat-scroll" style={{ display: "flex", gap: 16, overflowX: "auto", alignItems: "flex-start", padding: "2px 16px 8px", height: fill ? "calc(100vh - 104px)" : "auto" }}>
      {children}
    </div>
  );
}

function TicketBoard({ tickets, lens, colorBy, fill, onSelect }: { tickets: Ticket[]; lens: "linear" | "phase"; colorBy: ColorBy; fill: boolean; onSelect?: (id: string) => void }) {
  const cols = lens === "linear" ? LINEAR_COLS : PHASE_COLS;
  return (
    <BoardScroll fill={fill}>
      {cols.map((c: any) => {
        const items = lens === "linear" ? tickets.filter((t) => t.linearState === c.key) : tickets.filter((t) => t.phase === c.key);
        const live = items.filter((t) => t.activeState === "active").length;
        return (
          <Column key={c.key} label={c.label || c.key} color={c.c} count={items.length} live={live}>
            {items.map((t) => <TicketCard key={t.id} t={t} colorBy={colorBy} onSelect={onSelect} />)}
          </Column>
        );
      })}
    </BoardScroll>
  );
}
function WorkerBoard({ workers, tickets, grouping, fill }: { workers: Worker[]; tickets: Ticket[]; grouping: WorkerGrouping; fill: boolean }) {
  const infoById: Record<string, Ticket> = Object.fromEntries(tickets.map((t) => [t.id, t]));
  const cols = grouping === "phase" ? PHASE_COLS : WORKER_COLS;
  return (
    <BoardScroll fill={fill}>
      {cols.map((c: any) => {
        const items = grouping === "phase"
          ? workers.filter((w) => w.phase === c.key)
          : workers.filter((w) => (w.activeState ?? "active") === c.key);
        // Status columns are already split by liveness (Active/Stuck), so the
        // "N live" chip is redundant there; only surface it in the phase lens.
        const live = grouping === "phase" ? items.filter((w) => w.activeState === "active").length : 0;
        return (
          <Column key={c.key} label={c.label} color={c.c} count={items.length} live={live}>
            {items.map((w) => <WorkerCard key={w.name} w={w} info={infoById[w.ticket]} />)}
          </Column>
        );
      })}
    </BoardScroll>
  );
}
function Lane({ repo, children }: { repo: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 16px 8px" }}>
        <Dot color={repoColor(repo)} />
        <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700, color: C.fg }}>{repo}</span>
      </div>
      {children}
    </div>
  );
}

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

function QueueView({ data }: { data: BoardPayload }) {
  const { config, queue, workers, tickets } = data;
  const infoById: Record<string, Ticket> = Object.fromEntries(tickets.map((t) => [t.id, t]));
  const rank = (w: Worker) => (isActive(w.activeState) ? 0 : w.activeState === "stuck" ? 2 : 1);
  const inflight = [...workers].sort((a, b) => rank(a) - rank(b) || (b.runtimeMs ?? 0) - (a.runtimeMs ?? 0));
  return (
    <div className="cat-scroll" style={{ overflowY: "auto", height: "calc(100vh - 104px)", padding: "2px 16px 24px" }}>
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

        <div style={{ fontSize: 12, fontWeight: 600, color: C.fgMuted, margin: "0 0 8px" }}>Waiting in queue ({queue.length})</div>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          <Table>
            <TableHeader><TableRow style={{ background: C.s1 }}>
              <TableHead style={{ ...th, width: 40 }}>#</TableHead><TableHead style={{ ...th, width: 44 }}>Pri</TableHead>
              <TableHead style={{ ...th, width: 100 }}>Ticket</TableHead><TableHead style={th}>Title</TableHead>
              <TableHead style={{ ...th, width: 70 }}>Size</TableHead><TableHead style={{ ...th, width: 84 }}>Repo</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {queue.map((q) => (
                <TableRow key={q.id} style={{ background: q.rank <= config.freeSlots ? "rgba(57,208,122,0.06)" : undefined }}>
                  <TableCell style={{ ...mono, color: C.fgMuted }}>{q.rank}</TableCell>
                  <TableCell><PriorityIcon p={q.priority} /></TableCell>
                  <TableCell style={{ ...mono, ...td, color: C.blue, fontWeight: 600 }}>{q.id}</TableCell>
                  <TableCell style={{ ...td, ...ellip, maxWidth: 0 }}>{q.title}</TableCell>
                  <TableCell><ScopeChip scope={q.scope} estimate={q.estimate} /></TableCell>
                  <TableCell style={{ ...mono, fontSize: 11, color: C.fgDim }}>{q.repo}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: C.fgDim }}>Global rank: priority → pipeline stage → created-at → id. Per-project caps apply after ranking. Highlighted rows dispatch next as slots free.</div>
      </div>
    </div>
  );
}

// ── shell (real shadcn Tabs + ToggleGroup, TooltipProvider) ─────────────────
type View = "tickets" | "workers" | "queue";
type WorkerGrouping = "status" | "phase";
function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { k: T; label: string }[] }) {
  return (
    <ToggleGroup type="single" value={value} onValueChange={(v) => v && onChange(v as T)} variant="outline" size="sm">
      {options.map((o) => <ToggleGroupItem key={o.k} value={o.k} style={{ fontSize: 12, color: value === o.k ? C.fg : C.fgMuted }}>{o.label}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}

export function Board() {
  const [data, setData] = useState<BoardPayload | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [view, setView] = useState<View>("tickets");
  const [lens, setLens] = useState<"linear" | "phase">("linear");
  const [workerGrouping, setWorkerGrouping] = useState<WorkerGrouping>("status");
  const [repo, setRepo] = useState<string>("all");
  const [swimlanes, setSwimlanes] = useState(false); // default Combined (single Linear board)
  const [colorBy, setColorBy] = useState<ColorBy>("phase");
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
  const fWorkers = useMemo(() => (data?.workers ?? []).filter((w) => repo === "all" || w.repo === repo), [data, repo]);
  const fTickets = useMemo(() => (data?.tickets ?? []).filter((t) => repo === "all" || t.repo === repo), [data, repo]);
  const ticketLanes = repos.filter((r) => fTickets.some((t) => t.repo === r));
  const workerLanes = repos.filter((r) => fWorkers.some((w) => w.repo === r));
  const combined = !swimlanes || repo !== "all";
  const selectedTicket =
    selectedTicketId != null
      ? (data?.tickets ?? []).find((t) => t.id === selectedTicketId) ?? null
      : null;

  return (
    <TooltipProvider delayDuration={200}>
      <div style={{ background: C.s0, color: C.fg, height: "100vh", display: "flex", flexDirection: "column", fontSize: 13, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', overflow: "hidden" }}>
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
          {view === "tickets" && <>
            <Seg value={lens} onChange={setLens} options={[{ k: "linear", label: "Linear state" }, { k: "phase", label: "Pipeline" }]} />
            <Seg value={colorBy} onChange={setColorBy} options={[{ k: "phase", label: "Phase" }, { k: "status", label: "Status" }, { k: "repo", label: "Repo" }, { k: "type", label: "Type" }]} />
            <Seg value={swimlanes ? "lanes" : "flat"} onChange={(v) => setSwimlanes(v === "lanes")} options={[{ k: "flat", label: "Combined" }, { k: "lanes", label: "Repo lanes" }]} />
          </>}
          {view === "workers" && (
            <Seg value={workerGrouping} onChange={setWorkerGrouping} options={[{ k: "status", label: "Status" }, { k: "phase", label: "Pipeline" }]} />
          )}
        </div>

        {/* body */}
        <div style={{ flex: 1, minHeight: 0 }}>
          {!data && <div style={{ color: C.fgMuted, padding: 24 }}>Connecting to execution-core…</div>}
          {data && view === "tickets" && (combined
            ? <TicketBoard tickets={fTickets} lens={lens} colorBy={colorBy} fill onSelect={(id) => setSelectedTicketId(id)} />
            : <div className="cat-scroll" style={{ overflowY: "auto", height: "calc(100vh - 104px)", paddingTop: 4 }}>{ticketLanes.map((r) => <Lane key={r} repo={r}><TicketBoard tickets={fTickets.filter((t) => t.repo === r)} lens={lens} colorBy={colorBy} fill={false} onSelect={(id) => setSelectedTicketId(id)} /></Lane>)}</div>)}
          {data && view === "workers" && (combined
            ? <WorkerBoard workers={fWorkers} tickets={data.tickets} grouping={workerGrouping} fill />
            : <div className="cat-scroll" style={{ overflowY: "auto", height: "calc(100vh - 104px)", paddingTop: 4 }}>{workerLanes.map((r) => <Lane key={r} repo={r}><WorkerBoard workers={fWorkers.filter((w) => w.repo === r)} tickets={data.tickets} grouping={workerGrouping} fill={false} /></Lane>)}</div>)}
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
