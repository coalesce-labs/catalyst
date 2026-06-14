// preface-section.tsx — CTL-1103 Phase 3: renders the Rulebook's opening card.
import type { Preface } from "@/lib/rulebook-model";

export function PrefaceSection({ preface }: { preface: Preface }) {
  return (
    <div className="mb-6 rounded-lg border bg-card p-6 space-y-4">
      <h2 className="text-base font-semibold">Why does this engine exist?</h2>
      <p className="text-sm leading-relaxed text-foreground">{preface.problem}</p>
      <div className="border-t pt-4">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Datalog primer
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {preface.datalog_primer}
        </p>
      </div>
    </div>
  );
}
