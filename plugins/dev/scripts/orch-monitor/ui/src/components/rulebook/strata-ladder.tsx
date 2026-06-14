// strata-ladder.tsx — CTL-1103 Phase 3: vertical ladder of the 6 belief strata.
// Each rung anchors to its section in the rule-card list below.
import { cn } from "@/lib/utils";
import type { StratumGroup } from "@/lib/rulebook-model";

const STRATA_COLORS = [
  "border-blue-500 text-blue-700 dark:text-blue-400",
  "border-cyan-500 text-cyan-700 dark:text-cyan-400",
  "border-teal-500 text-teal-700 dark:text-teal-400",
  "border-amber-500 text-amber-700 dark:text-amber-400",
  "border-orange-500 text-orange-700 dark:text-orange-400",
  "border-rose-500 text-rose-700 dark:text-rose-400",
];

function stratumColor(idx: number): string {
  return STRATA_COLORS[idx % STRATA_COLORS.length];
}

export function StrataLadder({ groups }: { groups: StratumGroup[] }) {
  return (
    <div className="mb-6 rounded-lg border bg-card p-4">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Strata
      </p>
      <ol className="space-y-2">
        {groups.map((g, idx) => (
          <li key={g.stratum.id}>
            <a
              href={`#stratum-${g.stratum.id}`}
              className={cn(
                "flex items-start gap-3 rounded-md border-l-2 px-3 py-2 text-sm hover:bg-muted/50 transition-colors",
                stratumColor(idx),
              )}
            >
              <span className="shrink-0 font-mono text-xs font-semibold mt-0.5">
                S{g.stratum.id}
              </span>
              <span>
                <span className="font-medium">{g.stratum.label}</span>
                <span className="ml-2 text-muted-foreground">{g.stratum.prose}</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function stratumColorForId(stratumId: number): string {
  return STRATA_COLORS[(stratumId - 1) % STRATA_COLORS.length];
}
