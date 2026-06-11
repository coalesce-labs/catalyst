// phase-strip.tsx — the compact "where it's at" pipeline indicator (CTL-900 /
// HOME2). A hand-rolled strip of done / current / pending dots joined by hairline
// connectors, rendered in the reading pane for a fuller progress read than the
// single row glyph gives. Calm, flat, no nesting (Direction A): done phases are a
// solid phase-color dot, the current phase a larger ringed dot, and pending
// phases a faint hollow dot. The 10 canonical pipeline steps come from the ONE
// phase-model (no synthetic "done" pseudo-step — "done" is the outcome, not a
// step). Colors come from formatters.PHASE_COLORS via phaseColor (never cyan).
import { cn } from "@/lib/utils";
import { phaseColor, PHASE_LIST, PHASE_SHORT } from "@/board/phase-model";

export function PhaseStrip({ phaseIndex }: { phaseIndex: number }) {
  return (
    <ol className="flex items-center gap-0" aria-label="Pipeline progress">
      {PHASE_LIST.map((phase, i) => {
        const isDone = i < phaseIndex;
        const isCurrent = i === phaseIndex;
        const color = phaseColor(phase);
        return (
          <li key={phase} className="flex min-w-0 items-center">
            <span
              className="relative flex shrink-0 items-center justify-center"
              title={`${PHASE_SHORT[phase]}${isCurrent ? " — current" : isDone ? " — done" : ""}`}
            >
              <span
                aria-hidden
                className={cn("block rounded-full transition-all", isCurrent ? "size-2.5" : "size-1.5")}
                style={{
                  backgroundColor: isDone || isCurrent ? color : "transparent",
                  border: isDone || isCurrent ? undefined : `1.5px solid var(--color-border)`,
                  boxShadow: isCurrent ? `0 0 0 3px ${color}33` : undefined,
                }}
              />
            </span>
            {i < PHASE_LIST.length - 1 && (
              <span
                aria-hidden
                className="h-px w-3 shrink-0"
                style={{
                  backgroundColor: isDone ? color : "var(--color-border)",
                  opacity: isDone ? 0.5 : 1,
                }}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
