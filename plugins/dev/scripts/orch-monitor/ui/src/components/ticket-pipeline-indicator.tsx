// ticket-pipeline-indicator.tsx — the Q3 "where it stands" indicator (CTL-996
// §B3). THREE pure skins over the SAME pipeline model (resolvePipelineRail +
// phaseLabel from board/ticket-page-model.ts) — this file writes NO new pipeline
// logic. Each variant shows phase N of 10 from PIPELINE_PHASES and, on click,
// calls onOpenLifecycle (switches to the Lifecycle tab).
//
// Cyan (#5be0ff) is the RESERVED live signal: the current segment is cyan, and it
// breathes (the catalyst-shell-live-dot ping idiom) ONLY when ticket.working —
// respecting prefers-reduced-motion (the keyframe self-disables under it).
//
// The active variant is selected by the ?pipeline= search param; the DEFAULT
// (absent) is `strip`. Each root carries data-pipeline-variant="<id>" so a Q3
// screenshot is self-identifying.

import { useMemo } from "react";
import {
  resolvePipelineRail,
  phaseLabel,
  PIPELINE_PHASES,
  type PipelineSegment,
} from "@/board/ticket-page-model";
import type { BoardTicket } from "@/board/types";
import type { DetailPipeline } from "@/board/route-search";

// ── tokens (mirror ticket-detail-page.tsx inline `C`; cyan reserved) ─────────
const C = {
  border: "#262d36",
  fg: "#e6e9ef",
  fgMuted: "#8b93a1",
  fgDim: "#5b626f",
  cyan: "#5be0ff",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

// The breathing ring keyframe for the CURRENT segment while the ticket works.
// Reuses the catalyst-shell-live-dot ping idiom (Shell.tsx) — self-disables under
// prefers-reduced-motion. Scoped here so the indicator is self-contained.
const PIPELINE_PULSE_CSS = `
@keyframes catalystPipelinePing { 0%{box-shadow:0 0 0 0 rgba(91,224,255,.55)} 70%{box-shadow:0 0 0 5px rgba(91,224,255,0)} 100%{box-shadow:0 0 0 0 rgba(91,224,255,0)} }
.catalyst-pipeline-live { animation: catalystPipelinePing 1.9s infinite; }
@media (prefers-reduced-motion: reduce) { .catalyst-pipeline-live { animation: none; } }
`;

/** The 1-based phase index (N of 10) — the current segment, or the count of
 *  walked-past segments + 1 when the rail is fully walked (off-rail/done). */
function currentPhaseNumber(segments: PipelineSegment[]): number {
  const idx = segments.findIndex((s) => s.placement === "current");
  if (idx >= 0) return idx + 1;
  // no current (off-rail/done) — report the full count.
  return segments.length;
}

/** The current segment, or the last one when the rail is fully walked. */
function currentSegment(segments: PipelineSegment[]): PipelineSegment | undefined {
  return (
    segments.find((s) => s.placement === "current") ??
    segments[segments.length - 1]
  );
}

export interface TicketPipelineIndicatorProps {
  ticket: BoardTicket;
  /** The variant skin (URL-selected). Defaults to `strip`. */
  variant?: DetailPipeline;
  /** Switch to the Lifecycle tab (any variant click). */
  onOpenLifecycle: () => void;
}

/** TicketPipelineIndicator — the Q3 "where it stands" indicator, one of three
 *  skins over resolvePipelineRail. */
export function TicketPipelineIndicator({
  ticket,
  variant = "strip",
  onOpenLifecycle,
}: TicketPipelineIndicatorProps) {
  const segments = useMemo(() => resolvePipelineRail(ticket), [ticket]);
  const working = ticket.working;
  const total = PIPELINE_PHASES.length; // 10

  const cur = currentSegment(segments);
  const phaseNum = currentPhaseNumber(segments);
  const curLabel = cur ? phaseLabel(cur.phase) : "—";
  const curStatus = cur?.status ?? null;

  const shared = {
    segments,
    working,
    total,
    phaseNum,
    curLabel,
    curStatus,
    onOpenLifecycle,
  };

  return (
    <div style={{ margin: "12px 0 0" }}>
      <style>{PIPELINE_PULSE_CSS}</style>
      {variant === "chip" ? (
        <ChipVariant {...shared} />
      ) : variant === "dots" ? (
        <DotsVariant {...shared} />
      ) : (
        <StripVariant {...shared} />
      )}
    </div>
  );
}

interface VariantProps {
  segments: PipelineSegment[];
  working: boolean;
  total: number;
  phaseNum: number;
  curLabel: string;
  curStatus: string | null;
  onOpenLifecycle: () => void;
}

// ── strip (DEFAULT) — label row + a 10-segment bar ───────────────────────────
function StripVariant({
  segments,
  working,
  total,
  phaseNum,
  curLabel,
  curStatus,
  onOpenLifecycle,
}: VariantProps) {
  return (
    <button
      type="button"
      data-pipeline-variant="strip"
      onClick={onOpenLifecycle}
      title="Open the Lifecycle tab"
      style={{
        display: "block",
        width: "100%",
        maxWidth: 680,
        textAlign: "left",
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 5,
        }}
      >
        <span style={{ font: `12px ${C.mono}`, color: working ? C.cyan : C.fg }}>
          {curLabel}
          {curStatus ? <span style={{ color: C.fgMuted }}> — {curStatus}</span> : null}
        </span>
        <span style={{ font: `11px ${C.mono}`, color: C.fgMuted }}>
          phase {phaseNum} of {total}
        </span>
      </div>
      <div style={{ display: "flex", gap: 2 }}>
        {segments.map((seg) => {
          const isCurrent = seg.placement === "current";
          const isPast = seg.placement === "past";
          return (
            <span
              key={seg.phase}
              data-pipeline-segment={seg.phase}
              data-placement={seg.placement}
              title={`${seg.label} · ${seg.status ?? "not run"}`}
              className={isCurrent && working ? "catalyst-pipeline-live" : undefined}
              style={{
                flex: "1 1 0",
                height: 4,
                borderRadius: 2,
                background: isCurrent
                  ? C.cyan
                  : isPast
                    ? C.fgDim
                    : "transparent",
                border: seg.placement === "future" ? `1px solid ${C.border}` : "none",
                boxSizing: "border-box",
              }}
            />
          );
        })}
      </div>
    </button>
  );
}

// ── chip — one minimal pill ──────────────────────────────────────────────────
function ChipVariant({
  working,
  total,
  phaseNum,
  curLabel,
  curStatus,
  onOpenLifecycle,
}: VariantProps) {
  const dotColor = working ? C.cyan : C.fgMuted;
  return (
    <button
      type="button"
      data-pipeline-variant="chip"
      onClick={onOpenLifecycle}
      title="Open the Lifecycle tab"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        height: 22,
        padding: "0 10px",
        borderRadius: 999,
        cursor: "pointer",
        font: `12px ${C.mono}`,
        color: C.fg,
        background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
        border: `1px solid ${C.border}`,
      }}
    >
      <span
        className={working ? "catalyst-pipeline-live" : undefined}
        style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor, display: "inline-block" }}
      />
      <span>{curLabel}</span>
      <span style={{ color: C.fgDim }}>·</span>
      <span style={{ color: C.fgMuted }}>{curStatus ?? "—"}</span>
      <span style={{ color: C.fgDim }}>·</span>
      <span style={{ color: C.fgMuted }}>
        {phaseNum}/{total}
      </span>
    </button>
  );
}

// ── dots — a row of 10 dots + label ──────────────────────────────────────────
function DotsVariant({
  segments,
  working,
  total,
  phaseNum,
  curLabel,
  onOpenLifecycle,
}: VariantProps) {
  return (
    <button
      type="button"
      data-pipeline-variant="dots"
      onClick={onOpenLifecycle}
      title="Open the Lifecycle tab"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {segments.map((seg) => {
          const isCurrent = seg.placement === "current";
          const isPast = seg.placement === "past";
          if (isCurrent) {
            return (
              <span
                key={seg.phase}
                data-pipeline-segment={seg.phase}
                data-placement={seg.placement}
                title={`${seg.label} · ${seg.status ?? "not run"}`}
                className={working ? "catalyst-pipeline-live" : undefined}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: C.cyan,
                  boxShadow: `0 0 0 2px ${C.cyan}44`,
                  display: "inline-block",
                }}
              />
            );
          }
          return (
            <span
              key={seg.phase}
              data-pipeline-segment={seg.phase}
              data-placement={seg.placement}
              title={`${seg.label} · ${seg.status ?? "not run"}`}
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: isPast ? C.fgDim : "transparent",
                border: isPast ? "none" : `1px solid ${C.border}`,
                boxSizing: "border-box",
                display: "inline-block",
              }}
            />
          );
        })}
      </span>
      <span style={{ font: `12px ${C.mono}`, color: working ? C.cyan : C.fgMuted }}>
        {curLabel} · {phaseNum} of {total}
      </span>
    </button>
  );
}
