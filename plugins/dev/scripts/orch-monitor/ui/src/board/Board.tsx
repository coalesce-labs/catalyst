import { useEffect, useMemo, useState } from "react";

// ── types (mirror lib/board-data.mjs) ───────────────────────────────────────
type Worker = {
  name: string; ticket: string; tickets: string[]; phase: string; status: string;
  repo: string; team: string; runtimeMs: number | null; costUSD: number | null;
};
type Ticket = {
  id: string; title: string; type: string; repo: string; team: string;
  phase: string; status: string; model: string | null; linearState: string;
  workerStatus: string | null; costUSD: number | null; tokens: number | null; pr: number | null;
};
type QueueItem = {
  id: string; title: string; priority: number; createdAt: string;
  repo: string; team: string; rank: number;
};
type BoardPayload = {
  generatedAt: string;
  config: { maxParallel: number; inFlight: number; freeSlots: number };
  repos: string[];
  workers: Worker[];
  tickets: Ticket[];
  queue: QueueItem[];
};

// ── tokens (orch-monitor DESIGN.md) ─────────────────────────────────────────
const C = {
  s0: "#0b0d10", s1: "#111318", s2: "#16191f", s3: "#1c2028",
  border: "#262d36", borderSubtle: "#1e242c",
  fg: "#e6e9ef", fgMuted: "#8b93a1", fgDim: "#5b626f",
  green: "#39d07a", blue: "#4ea1ff", red: "#ef5d5d", yellow: "#eabc3b",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};
const PHASE_C: Record<string, string> = {
  triage: "#64748b", research: "#3b82f6", plan: "#a855f7", implement: "#10b981",
  verify: "#f59e0b", review: "#eab308", pr: "#14b8a6", "monitor-merge": "#4ea1ff",
  "monitor-deploy": "#39d07a", merge: "#4ea1ff", deploy: "#39d07a", done: "#6b7280",
  remediate: "#f472b6",
};
const LINEAR_COLS = [
  { key: "Research", c: "#3b82f6" }, { key: "Plan", c: "#a855f7" },
  { key: "Implement", c: "#10b981" }, { key: "Validate", c: "#f59e0b" },
  { key: "PR", c: "#14b8a6" }, { key: "Done", c: "#6b7280" },
];
const PHASE_COLS = [
  { key: "triage", label: "Triage", c: "#64748b" }, { key: "research", label: "Research", c: "#3b82f6" },
  { key: "plan", label: "Plan", c: "#a855f7" }, { key: "implement", label: "Implement", c: "#10b981" },
  { key: "verify", label: "Verify", c: "#f59e0b" }, { key: "review", label: "Review", c: "#eab308" },
  { key: "pr", label: "PR", c: "#14b8a6" }, { key: "monitor-merge", label: "Merge", c: "#4ea1ff" },
  { key: "monitor-deploy", label: "Deploy", c: "#39d07a" },
];
const WORKER_COLS = [
  { key: "busy", label: "Busy", c: C.green }, { key: "waiting", label: "Waiting", c: C.yellow },
  { key: "idle", label: "Idle", c: C.blue }, { key: "done", label: "Done", c: "#6b7280" },
  { key: "failed", label: "Failed", c: C.red },
];
// Axis B — live worker runtime (claude agents --json): busy / idle / waiting.
const WSTATUS_C: Record<string, string> = {
  busy: C.green, waiting: C.yellow, idle: "#5b6b80", failed: C.red, done: "#6b7280",
};

// Axis A — phase-signal lifecycle. Only the "needs attention / not-plain-done"
// states get a badge; running/done/dispatched render via the phase pill + dot.
const STATUS_META: Record<string, { label: string; fg: string; bg: string }> = {
  failed: { label: "failed", fg: "#f4a8a8", bg: "rgba(239,93,93,0.14)" },
  stalled: { label: "stalled", fg: "#f4dc8a", bg: "rgba(234,188,59,0.14)" },
  "turn-cap-exhausted": { label: "turn-cap", fg: "#f4dc8a", bg: "rgba(234,188,59,0.14)" },
  preempted: { label: "paused", fg: "#9ec7f4", bg: "rgba(78,161,255,0.14)" },
  aborted: { label: "aborted", fg: "#8b93a1", bg: "#1c2028" },
  superseded: { label: "superseded", fg: "#8b93a1", bg: "#1c2028" },
  skipped: { label: "skipped", fg: "#5b626f", bg: "#16191f" },
};

function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status];
  if (!m) return null;
  return (
    <span style={{
      fontFamily: C.mono, fontSize: 10, padding: "1.5px 7px", borderRadius: 6,
      color: m.fg, background: m.bg, whiteSpace: "nowrap",
    }}>{m.label}</span>
  );
}

// cost: real number → "$x.xx"; null → "—" (no metrics row, not "free").
function Cost({ v }: { v: number | null }) {
  return (
    <span style={{ fontFamily: C.mono, fontVariantNumeric: "tabular-nums", fontSize: 10.5, color: v == null ? C.fgDim : C.fgMuted }}>
      {v == null ? "—" : `$${v.toFixed(2)}`}
    </span>
  );
}

const fmtRuntime = (ms: number | null) => {
  if (!ms || !Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

// ── primitives ──────────────────────────────────────────────────────────────
function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span style={{
      width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block",
      flex: "0 0 auto", boxShadow: pulse ? `0 0 8px ${color}` : undefined,
    }} />
  );
}

function Column({ label, color, count, children }: {
  label: string; color: string; count: number; children: React.ReactNode;
}) {
  return (
    <div style={{ flex: "0 0 196px", minWidth: 196, display: "flex", flexDirection: "column" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", marginBottom: 8,
        background: C.s1, border: `1px solid ${C.border}`, borderRadius: 8, position: "relative",
      }}>
        <span style={{ position: "absolute", left: 0, top: 7, bottom: 7, width: 3, borderRadius: 3, background: color }} />
        <span style={{ fontSize: 12, fontWeight: 600, marginLeft: 4 }}>{label}</span>
        <span style={{
          marginLeft: "auto", fontFamily: C.mono, fontSize: 11, color: C.fgMuted,
          background: C.s3, padding: "1px 7px", borderRadius: 9,
        }}>{count}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {count === 0
          ? <div style={{ color: C.fgDim, fontSize: 11.5, textAlign: "center", padding: "12px 0", border: `1px dashed ${C.borderSubtle}`, borderRadius: 8 }}>—</div>
          : children}
      </div>
    </div>
  );
}

function Chip({ children, color, mono, bg, bd }: {
  children: React.ReactNode; color?: string; mono?: boolean; bg?: string; bd?: string;
}) {
  return (
    <span style={{
      fontFamily: mono ? C.mono : undefined, fontVariantNumeric: mono ? "tabular-nums" : undefined,
      fontSize: 10.5, padding: "1.5px 7px", borderRadius: 6,
      whiteSpace: "nowrap", color: color || C.fgMuted, background: bg, border: bd ? `1px solid ${bd}` : undefined,
    }}>{children}</span>
  );
}

function PhasePill({ phase }: { phase: string }) {
  return (
    <span style={{
      fontFamily: C.mono, fontSize: 10.5, padding: "1.5px 8px", borderRadius: 6,
      color: "#0b0d10", fontWeight: 600, background: PHASE_C[phase] || C.blue,
    }}>{phase}</span>
  );
}

function TicketCard({ t }: { t: Ticket }) {
  const accent = PHASE_C[t.phase] || C.blue;
  return (
    <div style={{
      background: C.s2, border: `1px solid ${C.border}`, borderTop: `2px solid ${accent}`,
      borderRadius: 9, padding: "10px 11px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 600, color: C.blue }}>{t.id}</span>
        <Dot color={t.repo === "adva" ? "#c084fc" : C.blue} />
        <span style={{ flex: 1 }} />
        <Chip mono bg={C.s3} bd={C.border}>{t.type}</Chip>
      </div>
      <div style={{
        color: C.fg, fontSize: 12.5, margin: "5px 0 9px",
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
      }}>{t.title}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        {t.workerStatus && <Dot color={WSTATUS_C[t.workerStatus] || C.fgDim} pulse={t.workerStatus === "busy"} />}
        <PhasePill phase={t.phase} />
        <StatusBadge status={t.status} />
        <span style={{ flex: 1 }} />
        {t.pr ? <Chip mono color={C.green}>#{t.pr}</Chip> : <Cost v={t.costUSD} />}
      </div>
    </div>
  );
}

function WorkerCard({ w }: { w: Worker }) {
  const accent = PHASE_C[w.phase] || C.blue;
  return (
    <div style={{
      background: C.s2, border: `1px solid ${C.border}`, borderTop: `2px solid ${accent}`,
      borderRadius: 9, padding: "10px 11px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Dot color={WSTATUS_C[w.status] || C.fgDim} pulse={w.status === "busy"} />
        <span style={{
          fontFamily: C.mono, fontSize: 11, color: C.fgMuted, overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{w.name}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: C.mono, fontSize: 10.5, color: C.fgDim }}>{fmtRuntime(w.runtimeMs)}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, margin: "8px 0 9px" }}>
        {w.tickets.map((tk) => (
          <span key={tk} style={{
            fontFamily: C.mono, fontSize: 13, fontWeight: 700, color: C.blue,
            background: "rgba(78,161,255,0.10)", border: "1px solid rgba(78,161,255,0.30)",
            padding: "3px 9px", borderRadius: 7,
          }}>{tk}</span>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <PhasePill phase={w.phase} />
        <Chip mono bg={C.s3} bd={C.borderSubtle} color={C.fgDim}>{w.repo}</Chip>
        <span style={{ flex: 1 }} />
        <Cost v={w.costUSD} />
      </div>
    </div>
  );
}

// ── boards ──────────────────────────────────────────────────────────────────
function ColumnRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: 10, alignItems: "flex-start", overflowX: "auto", paddingBottom: 6 }}>{children}</div>;
}

function TicketBoard({ tickets, lens }: { tickets: Ticket[]; lens: "linear" | "phase" }) {
  const cols = lens === "linear" ? LINEAR_COLS : PHASE_COLS;
  return (
    <ColumnRow>
      {cols.map((c: any) => {
        const items = lens === "linear"
          ? tickets.filter((t) => t.linearState === c.key)
          : tickets.filter((t) => t.phase === c.key);
        return (
          <Column key={c.key} label={c.label || c.key} color={c.c} count={items.length}>
            {items.map((t) => <TicketCard key={t.id} t={t} />)}
          </Column>
        );
      })}
    </ColumnRow>
  );
}

function WorkerBoard({ workers }: { workers: Worker[] }) {
  return (
    <ColumnRow>
      {WORKER_COLS.map((c) => {
        const items = workers.filter((w) => w.status === c.key);
        return (
          <Column key={c.key} label={c.label} color={c.c} count={items.length}>
            {items.map((w) => <WorkerCard key={w.name} w={w} />)}
          </Column>
        );
      })}
    </ColumnRow>
  );
}

function Lane({ repo, children }: { repo: string; children: React.ReactNode }) {
  const color = repo === "adva" ? "#c084fc" : C.blue;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Dot color={color} />
        <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700, color: C.fg }}>{repo}</span>
        <span style={{ flex: 1, height: 1, background: C.borderSubtle }} />
      </div>
      {children}
    </div>
  );
}

const PRIORITY_LABEL = ["—", "Urgent", "High", "Medium", "Low"];
const PRIORITY_C = ["#5b6b80", "#ef5d5d", "#f59e0b", "#eabc3b", "#5b6b80"];

function QueueView({ data }: { data: BoardPayload }) {
  const { config, queue } = data;
  return (
    <div style={{ maxWidth: 880 }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <Stat label="Max parallel" value={String(config.maxParallel)} />
        <Stat label="In flight" value={String(config.inFlight)} color={config.freeSlots === 0 ? C.yellow : C.fg} />
        <Stat label="Free slots" value={String(config.freeSlots)} color={config.freeSlots > 0 ? C.green : C.red} />
        <Stat label="Queued" value={String(queue.length)} />
      </div>
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{
          display: "flex", padding: "8px 12px", background: C.s1, borderBottom: `1px solid ${C.border}`,
          fontSize: 11, color: C.fgDim, textTransform: "uppercase", letterSpacing: 0.6,
        }}>
          <span style={{ width: 40 }}>#</span>
          <span style={{ width: 90 }}>Ticket</span>
          <span style={{ flex: 1 }}>Title</span>
          <span style={{ width: 80 }}>Priority</span>
          <span style={{ width: 80 }}>Repo</span>
        </div>
        {queue.length === 0 && <div style={{ padding: 16, color: C.fgDim, fontSize: 12 }}>Queue empty — all eligible work is in flight.</div>}
        {queue.map((q) => (
          <div key={q.id} style={{
            display: "flex", alignItems: "center", padding: "9px 12px",
            borderBottom: `1px solid ${C.borderSubtle}`, background: q.rank <= config.freeSlots ? "rgba(57,208,122,0.05)" : undefined,
          }}>
            <span style={{ width: 40, fontFamily: C.mono, color: C.fgMuted }}>{q.rank}</span>
            <span style={{ width: 90, fontFamily: C.mono, fontSize: 12, fontWeight: 600, color: C.blue }}>{q.id}</span>
            <span style={{ flex: 1, fontSize: 12.5, color: C.fg, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 12 }}>{q.title}</span>
            <span style={{ width: 80 }}><Chip color={PRIORITY_C[q.priority] || C.fgDim}>{PRIORITY_LABEL[q.priority] || "—"}</Chip></span>
            <span style={{ width: 80 }}><Chip mono color={C.fgDim}>{q.repo}</Chip></span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, fontSize: 11, color: C.fgDim }}>
        Global rank: priority → pipeline stage → created-at → id. Per-project dispatch caps apply after ranking.
        Highlighted rows would dispatch next as slots free.
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: C.s2, border: `1px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", minWidth: 100 }}>
      <div style={{ fontSize: 11, color: C.fgDim, textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontFamily: C.mono, fontVariantNumeric: "tabular-nums", fontSize: 22, fontWeight: 700, color: color || C.fg, marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ── shell ─────────────────────────────────────────────────────────────────
type View = "tickets" | "workers" | "queue";

function NavBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      border: `1px solid ${active ? C.border : "transparent"}`, background: active ? C.s3 : "transparent",
      color: active ? C.fg : C.fgMuted, font: "inherit", fontSize: 12.5, fontWeight: 500,
      padding: "5px 12px", borderRadius: 7, cursor: "pointer",
    }}>{children}</button>
  );
}

function Seg({ options, value, onChange }: { options: { k: string; label: string }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div style={{ display: "inline-flex", background: C.s2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2 }}>
      {options.map((o) => (
        <button key={o.k} onClick={() => onChange(o.k)} style={{
          border: "none", background: value === o.k ? C.s3 : "transparent", color: value === o.k ? C.fg : C.fgMuted,
          font: "inherit", fontSize: 12, padding: "4px 11px", borderRadius: 6, cursor: "pointer",
          boxShadow: value === o.k ? `inset 0 0 0 1px ${C.border}` : undefined,
        }}>{o.label}</button>
      ))}
    </div>
  );
}

export function Board() {
  const [data, setData] = useState<BoardPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<View>("tickets");
  const [lens, setLens] = useState<"linear" | "phase">("linear");
  const [repo, setRepo] = useState<string>("all");
  const [swimlanes, setSwimlanes] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/board-data");
        const j = await r.json();
        if (alive) { setData(j); setErr(null); }
      } catch (e) { if (alive) setErr(String(e)); }
    };
    load();
    const id = setInterval(load, 4000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const repos = data?.repos ?? [];
  const fWorkers = useMemo(() => (data?.workers ?? []).filter((w) => repo === "all" || w.repo === repo), [data, repo]);
  const fTickets = useMemo(() => (data?.tickets ?? []).filter((t) => repo === "all" || t.repo === repo), [data, repo]);
  // only render swim lanes that actually have content
  const ticketLanes = repos.filter((r) => fTickets.some((t) => t.repo === r));
  const workerLanes = repos.filter((r) => fWorkers.some((w) => w.repo === r));

  const wrap: React.CSSProperties = {
    background: C.s0, color: C.fg, minHeight: "100vh", fontSize: 13,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  };

  return (
    <div style={wrap}>
      {/* chrome */}
      <header style={{
        height: 48, display: "flex", alignItems: "center", gap: 18, padding: "0 16px",
        background: C.s1, borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, zIndex: 20,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, fontWeight: 600 }}>
          <span style={{ width: 16, height: 16, borderRadius: 4, background: "linear-gradient(135deg,#4ea1ff,#39d07a)", boxShadow: "0 0 12px rgba(78,161,255,0.45)" }} />
          Catalyst
        </div>
        <nav style={{ display: "flex", gap: 2 }}>
          <NavBtn active={view === "tickets"} onClick={() => setView("tickets")}>Tickets</NavBtn>
          <NavBtn active={view === "workers"} onClick={() => setView("workers")}>Workers</NavBtn>
          <NavBtn active={view === "queue"} onClick={() => setView("queue")}>Queue</NavBtn>
        </nav>
        <span style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 11.5, color: C.fgMuted }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot color={C.green} pulse /> daemon</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot color={C.green} pulse /> broker</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot color={C.green} pulse /> monitor</span>
          <span style={{ fontFamily: C.mono, fontSize: 10, letterSpacing: 1.5, color: err ? C.red : C.green, border: `1px solid ${err ? "rgba(239,93,93,0.35)" : "rgba(57,208,122,0.35)"}`, borderRadius: 5, padding: "2px 6px" }}>
            {err ? "OFFLINE" : "LIVE"}
          </span>
        </div>
      </header>

      {/* subhead */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 16px 10px", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          {view === "tickets" ? "Tickets" : view === "workers" ? "Workers" : "Priority Queue"}
        </h1>
        <span style={{ color: C.fgMuted, fontSize: 12 }}>
          {view === "tickets" ? "Every ticket the daemon is moving through the pipeline"
            : view === "workers" ? "Short-lived workers the daemon has deployed — one per phase"
            : "What dispatches next, and how many slots are free"}
        </span>

        {/* repo filter */}
        <div style={{ display: "flex", gap: 6, marginLeft: "auto", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: C.fgDim, textTransform: "uppercase", letterSpacing: 0.8 }}>Repo</span>
          <Seg
            options={[{ k: "all", label: "All" }, ...repos.map((r) => ({ k: r, label: r }))]}
            value={repo} onChange={setRepo}
          />
        </div>

        {view === "tickets" && (
          <>
            <Seg options={[{ k: "linear", label: "Linear state" }, { k: "phase", label: "Pipeline" }]} value={lens} onChange={(k) => setLens(k as any)} />
            <Seg options={[{ k: "lanes", label: "Repo lanes" }, { k: "flat", label: "Combined" }]} value={swimlanes ? "lanes" : "flat"} onChange={(k) => setSwimlanes(k === "lanes")} />
          </>
        )}
      </div>

      {/* body */}
      <div style={{ padding: "4px 16px 40px" }}>
        {!data && !err && <div style={{ color: C.fgMuted, padding: 24 }}>Connecting to execution-core…</div>}
        {err && <div style={{ color: C.red, padding: 24 }}>Board data unavailable: {err}</div>}
        {data && view === "tickets" && (
          swimlanes && repo === "all"
            ? ticketLanes.map((r) => (
                <Lane key={r} repo={r}>
                  <TicketBoard tickets={fTickets.filter((t) => t.repo === r)} lens={lens} />
                </Lane>
              ))
            : <TicketBoard tickets={fTickets} lens={lens} />
        )}
        {data && view === "workers" && (
          swimlanes && repo === "all"
            ? workerLanes.map((r) => (
                <Lane key={r} repo={r}>
                  <WorkerBoard workers={fWorkers.filter((w) => w.repo === r)} />
                </Lane>
              ))
            : <WorkerBoard workers={fWorkers} />
        )}
        {data && view === "queue" && <QueueView data={{ ...data, queue: data.queue.filter((q) => repo === "all" || q.repo === repo) }} />}

        {data && (
          <div style={{ marginTop: 18, fontSize: 11, color: C.fgDim, fontFamily: C.mono }}>
            updated {new Date(data.generatedAt).toLocaleTimeString()} · {data.workers.length} workers · {data.tickets.length} tickets · {data.queue.length} queued · refresh 4s
          </div>
        )}
      </div>
    </div>
  );
}
