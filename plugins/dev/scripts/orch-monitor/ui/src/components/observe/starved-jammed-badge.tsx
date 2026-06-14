// starved-jammed-badge.tsx — the UTILIZATION surface's marquee diagnostic (OBS-16).
//
// The two HISTORICAL failure modes — STARVED (backlog) and JAMMED (dispatcher) —
// rendered as a LOUD, named, color-coded full-width banner, NEVER buried in a chart
// (Principle 3 / design §3.2 P2). It sits between the hero and the panel grid so it
// cannot be missed: an icon, a bold NAMED label, a one-line plain-language cause,
// and a cross-surface action link.
//
// The pathology itself is the PURE `pathology(freeSlots, queueLen)` decision from
// utilization-kit.ts (unit-tested there). Every count in the copy is the AUTOTUNED
// live capacity from /api/board config — never a static config-file read. This is a
// BOARD-backed component: it NEVER gates on OTEL health, so it is always live.

import { cn } from "@/lib/utils";
import { AlertTriangle, Inbox, CheckCircle2, Activity } from "lucide-react";
import type { Pathology } from "./utilization-kit";

export interface StarvedJammedBadgeProps {
  pathology: Pathology;
  /** Autotuned free slots from /api/board config.freeSlots. */
  freeSlots: number;
  /** Autotuned total capacity from /api/board config.maxParallel. */
  maxParallel: number;
  /** The waiting queue depth (board.queue.length). */
  queueLen: number;
  /** STARVED → opens the eligible-set view; JAMMED → FleetOps reconcile. */
  onAction?: (target: "eligible" | "reconcile") => void;
}

/** Per-pathology treatment: the banner tone classes, the icon glyph, and the
 *  action affordance. STARVED/JAMMED/SATURATED are STATUS colors (amber/red/green —
 *  Principle 3); HEALTHY is neutral and quiet. */
interface Treatment {
  /** Banner container classes (bg/border tint) + the text/icon color. */
  tone: string;
  icon: typeof AlertTriangle;
  /** The bold NAMED label (e.g. "JAMMED"). */
  label: string;
}

const TREATMENT: Record<Pathology, Treatment> = {
  JAMMED: {
    tone: "border-red/40 bg-red/15 text-red",
    icon: AlertTriangle,
    label: "JAMMED",
  },
  STARVED: {
    tone: "border-yellow/40 bg-yellow/15 text-yellow",
    icon: Inbox,
    label: "STARVED",
  },
  SATURATED: {
    tone: "border-green/40 bg-green/15 text-green",
    icon: CheckCircle2,
    label: "SATURATED",
  },
  HEALTHY: {
    tone: "border-border bg-surface-1 text-muted",
    icon: Activity,
    label: "running",
  },
};

export function StarvedJammedBadge({
  pathology,
  freeSlots,
  maxParallel,
  queueLen,
  onAction,
}: StarvedJammedBadgeProps) {
  const t = TREATMENT[pathology];
  const Icon = t.icon;

  // The one-line plain-language cause + the optional action affordance, per state.
  // Counts are the AUTOTUNED live values (never static).
  let cause: string;
  let action: { label: string; target: "eligible" | "reconcile" } | null = null;
  switch (pathology) {
    case "JAMMED":
      cause = `${freeSlots} free ${freeSlots === 1 ? "slot" : "slots"} but ${queueLen} ${
        queueLen === 1 ? "ticket" : "tickets"
      } waiting · dispatcher not placing work`;
      action = { label: "reconcile health →", target: "reconcile" };
      break;
    case "STARVED":
      cause = `${freeSlots} free ${
        freeSlots === 1 ? "slot" : "slots"
      }, queue empty · feed the backlog`;
      action = { label: "eligible set →", target: "eligible" };
      break;
    case "SATURATED":
      cause = `all ${maxParallel} slots busy`;
      break;
    default:
      cause = "slots tracking the queue";
      break;
  }

  return (
    <div
      role="status"
      aria-label={`${t.label} — ${cause}`}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border px-4 py-3",
        t.tone,
      )}
    >
      <Icon className="h-5 w-5 shrink-0" aria-hidden />
      <span className="font-mono text-sm font-bold tracking-wide">{t.label}</span>
      <span className="text-muted/60">—</span>
      {/* Cause copy stays readable on the tinted banner — muted-foreground, not the
          loud status color (which is reserved for the label + icon). */}
      <span className="text-[12px] text-foreground/80">{cause}</span>
      {action && (
        <button
          type="button"
          onClick={() => onAction?.(action!.target)}
          className="ml-auto shrink-0 font-mono text-[11px] underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {action.label}
        </button>
      )}
      {/* board+events chip — queue is board, the eligible set is the events/file
          projection; both live so no degradation. Right-aligned when no action. */}
      <span
        className={cn(
          "shrink-0 font-mono text-[10px] tracking-wide text-muted/70",
          !action && "ml-auto",
        )}
      >
        [board+events]
      </span>
    </div>
  );
}
