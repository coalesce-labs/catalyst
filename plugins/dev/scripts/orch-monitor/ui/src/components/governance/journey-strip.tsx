// journey-strip.tsx — CTL-1100 Phase 6: 10-phase horizontal status strip.
// Modeled on components/home/phase-strip.tsx. Pure CSS colors from board/phase-model.
import { journeyPhaseStatus, PHASE_LIST, type Journey } from "../../lib/journey-model";

const STATUS_CLASSES: Record<string, string> = {
  done:    "bg-green-500",
  current: "bg-blue-500",
  failed:  "bg-red-500",
  pending: "bg-muted",
};

interface PhaseDotsProps {
  journey: Journey;
}

export function JourneyStrip({ journey }: PhaseDotsProps) {
  return (
    <div className="flex items-center gap-1" role="list" aria-label="journey phases">
      {PHASE_LIST.map((phase) => {
        const status = journeyPhaseStatus(journey, phase);
        return (
          <div
            key={phase}
            role="listitem"
            title={`${phase}: ${status}`}
            className={`h-2 w-2 rounded-full ${STATUS_CLASSES[status] ?? "bg-muted"}`}
          />
        );
      })}
    </div>
  );
}
