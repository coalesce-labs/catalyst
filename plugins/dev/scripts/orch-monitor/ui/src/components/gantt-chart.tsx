import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  fmtDuration,
  fmtClock,
  phaseColor,
  PHASE_COLORS,
  PHASE_ORDER,
} from "@/lib/formatters";
import { ticketToWaveMap, effectiveCost } from "@/lib/computations";
import { SectionLabel } from "./ui/panel";
import { EmptyState } from "./ui/empty-state";
import type { OrchestratorState, WorkerState, WorkerAnalytics } from "@/lib/types";
import { ChevronDown, ChevronRight, BarChart3 } from "lucide-react";

interface GanttChartProps {
  orch: OrchestratorState;
  getAnalytics: (orchId: string) => Record<string, WorkerAnalytics | null>;
}

interface PhaseSegment {
  phase: string;
  from: number;
  to: number;
  noData?: boolean;
}

function buildPhaseSegments(
  w: WorkerState,
  startMs: number,
  endMs: number,
): PhaseSegment[] {
  const phaseTs = w.phaseTimestamps || {};
  const stops: { phase: string; t: number }[] = [];
  for (const phase of PHASE_ORDER) {
    const ts = phaseTs[phase];
    if (!ts) continue;
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) continue;
    stops.push({ phase, t });
  }
  stops.sort((a, b) => a.t - b.t);

  if (!stops.length) {
    return [
      { phase: w.status || "dispatched", from: startMs, to: endMs, noData: true },
    ];
  }

  const segs: PhaseSegment[] = [];
  if (stops[0].t > startMs) {
    segs.push({ phase: "dispatched", from: startMs, to: stops[0].t });
  }
  for (let i = 0; i < stops.length; i++) {
    const from = Math.max(stops[i].t, startMs);
    const to = i + 1 < stops.length ? stops[i + 1].t : endMs;
    if (to > from) segs.push({ phase: stops[i].phase, from, to });
  }
  return segs;
}

function pickTickInterval(spanMs: number): number {
  const minutes = spanMs / 60000;
  if (minutes <= 30) return 5 * 60000;
  if (minutes <= 120) return 15 * 60000;
  if (minutes <= 360) return 30 * 60000;
  return 60 * 60000;
}

const LEGEND_ITEMS = [
  { key: "researching", label: "research" },
  { key: "planning", label: "plan" },
  { key: "implementing", label: "implement" },
  { key: "validating", label: "validate" },
  { key: "shipping", label: "ship" },
  { key: "done", label: "merged" },
  { key: "failed", label: "failed" },
  { key: "stalled", label: "stalled" },
];

function GanttLegend() {
  return (
    <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
      {LEGEND_ITEMS.map(({ key, label }) => (
        <span key={key} className="inline-flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: PHASE_COLORS[key] }}
          />
          {label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block h-2.5 w-2.5 rounded-sm bg-muted opacity-70"
          style={{
            backgroundImage:
              "repeating-linear-gradient(45deg, rgba(255,255,255,0.3) 0, rgba(255,255,255,0.3) 2px, transparent 2px, transparent 4px)",
          }}
        />
        no phase data
      </span>
    </div>
  );
}

function GanttSegment({
  seg,
  segPct,
  isLive,
}: {
  seg: PhaseSegment;
  segPct: number;
  isLive: boolean;
}) {
  return (
    <div
      className={cn(
        "h-full relative",
        seg.phase === "merged" && "opacity-70",
        seg.noData && "opacity-55",
      )}
      style={{
        width: segPct.toFixed(2) + "%",
        background: phaseColor(seg.phase),
        ...(seg.noData
          ? {
              backgroundImage:
                "repeating-linear-gradient(45deg, rgba(255,255,255,0.12) 0, rgba(255,255,255,0.12) 4px, transparent 4px, transparent 8px)",
            }
          : {}),
      }}
      title={`${seg.phase} ${fmtClock(new Date(seg.from))}–${fmtClock(new Date(seg.to))}`}
    >
      {isLive && (
        <div
          className="absolute inset-y-0 right-0 w-1"
          style={{
            background: "rgba(255,255,255,0.35)",
            animation: "gantt-pulse 1.4s ease-in-out infinite",
          }}
        />
      )}
    </div>
  );
}

export function GanttChart({ orch, getAnalytics }: GanttChartProps) {
  const [collapsed, setCollapsed] = useState(false);
  const tToW = ticketToWaveMap(orch);
  const analytics = getAnalytics(orch.id);
  const now = Date.now();

  const entries = Object.entries(orch.workers).sort((a, b) => {
    const wa = tToW[a[0]] ?? 999;
    const wb = tToW[b[0]] ?? 999;
    return wa !== wb ? wa - wb : a[0].localeCompare(b[0]);
  });

  if (!entries.length) return null;

  const rowData = entries.map(([ticket, w]) => {
    const startMs = w.startedAt ? Date.parse(w.startedAt) : NaN;
    const isLive =
      !w.completedAt && w.status !== "done" && w.status !== "merged" && w.status !== "failed";
    const endMs = w.completedAt
      ? Date.parse(w.completedAt)
      : isLive
        ? now
        : Date.parse(w.updatedAt || w.startedAt || "") || now;
    return {
      ticket,
      w,
      wave: tToW[ticket],
      startMs: Number.isFinite(startMs) ? startMs : null,
      endMs: Number.isFinite(endMs) ? endMs : null,
      isLive,
    };
  });

  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const r of rowData) {
    if (r.startMs != null && r.startMs < minStart) minStart = r.startMs;
    if (r.endMs != null && r.endMs > maxEnd) maxEnd = r.endMs;
  }

  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd) || maxEnd <= minStart) {
    return <EmptyState icon={BarChart3} message="Not enough data to render timeline" />;
  }

  const span = maxEnd - minStart;
  const pct = (t: number) => ((t - minStart) / span) * 100;

  const waveFirst = new Map<number, number>();
  for (const r of rowData) {
    if (r.startMs == null || r.wave == null) continue;
    const cur = waveFirst.get(r.wave);
    if (cur == null || r.startMs < cur) waveFirst.set(r.wave, r.startMs);
  }
  const sortedWaves = Array.from(waveFirst.entries()).sort((a, b) => a[1] - b[1]);

  const interval = pickTickInterval(span);
  const ticks: { left: number; label: string }[] = [];
  const firstTick = Math.ceil(minStart / interval) * interval;
  for (let t = firstTick; t <= maxEnd; t += interval) {
    ticks.push({ left: pct(t), label: fmtClock(new Date(t)) });
  }

  return (
    <div className="border-t border-border px-4 py-3">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="mb-2 flex w-full items-center justify-between"
      >
        <SectionLabel>Timeline</SectionLabel>
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 text-muted" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted" />
        )}
      </button>

      {!collapsed && (
        <div className="font-mono">
          <GanttLegend />
          <div className="relative">
            {/* Axis */}
            <div className="relative ml-[100px] mr-[55px] h-4 border-b border-border">
              {ticks.map((tick, i) => (
                <div key={i}>
                  <div
                    className="absolute top-0 bottom-0 w-px bg-border"
                    style={{ left: tick.left.toFixed(2) + "%" }}
                  />
                  <div
                    className="absolute top-0 -translate-x-1/2 text-[10px] text-muted whitespace-nowrap"
                    style={{ left: tick.left.toFixed(2) + "%" }}
                  >
                    {tick.label}
                  </div>
                </div>
              ))}
            </div>

            {/* Rows */}
            {rowData.map((r) => {
              const cost = effectiveCost(r.w, analytics[r.ticket] || null);
              const costLabel = cost > 0 ? "$" + cost.toFixed(2) : "";

              if (
                r.startMs == null ||
                r.endMs == null ||
                r.endMs <= r.startMs
              ) {
                return (
                  <div key={r.ticket} className="mt-1 flex h-[22px] items-center">
                    <div className="w-[100px] shrink-0 truncate pr-2 text-[11px] text-fg">
                      <span className="mr-1 text-muted">W{r.wave ?? "?"}</span>
                      {r.ticket}
                    </div>
                    <div className="relative h-[14px] flex-1 rounded-sm bg-surface-3" />
                    <div className="w-[55px] shrink-0 pl-2 text-right text-[11px] text-muted">
                      {costLabel}
                    </div>
                  </div>
                );
              }

              const segs = buildPhaseSegments(r.w, r.startMs, r.endMs);
              const totalSegSpan = r.endMs - r.startMs;
              const left = pct(r.startMs);
              const width = ((r.endMs - r.startMs) / span) * 100;

              return (
                <div key={r.ticket} className="mt-1 flex h-[22px] items-center">
                  <div className="w-[100px] shrink-0 truncate pr-2 text-[11px] text-fg">
                    <span className="mr-1 text-muted">W{r.wave ?? "?"}</span>
                    {r.ticket}
                  </div>
                  <div
                    className="relative h-[14px] flex-1 rounded-sm bg-surface-3"
                    title={`${r.ticket} · ${r.w.status || "?"} · ${fmtDuration(totalSegSpan)}${cost > 0 ? " · $" + cost.toFixed(2) : ""}`}
                  >
                    <div
                      className="absolute inset-y-0 flex"
                      style={{
                        left: left.toFixed(2) + "%",
                        width: width.toFixed(2) + "%",
                      }}
                    >
                      {segs.map((s, i) => (
                        <GanttSegment
                          key={i}
                          seg={s}
                          segPct={((s.to - s.from) / totalSegSpan) * 100}
                          isLive={r.isLive && i === segs.length - 1}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="w-[55px] shrink-0 pl-2 text-right text-[11px] text-muted">
                    {costLabel}
                  </div>
                </div>
              );
            })}

            {/* Wave dividers */}
            <div className="pointer-events-none absolute inset-y-0 left-[100px] right-[55px]">
              {sortedWaves.slice(1).map(([wn, t]) => (
                <div
                  key={wn}
                  className="absolute inset-y-0 w-0 border-l border-dashed border-border"
                  style={{ left: pct(t).toFixed(2) + "%" }}
                >
                  <span className="absolute top-0.5 left-1 text-[10px] text-muted whitespace-nowrap">
                    Wave {wn}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
