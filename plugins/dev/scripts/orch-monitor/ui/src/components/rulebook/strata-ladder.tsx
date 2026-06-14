// strata-ladder.tsx — CTL-1103 Phase 3+5: vertical ladder of the 6 belief strata.
// Uses strataTone() from rulebook-theme.ts (--chart-N tokens; distinct from
// severity and live-indicator per Phase 5 contract).
import type { StratumGroup } from "@/lib/rulebook-model";
import { strataTone } from "@/lib/rulebook-theme";

/** CSS variable string for a stratum id — used by rule-card and rulebook-surface. */
export function stratumColorForId(id: number): string {
  return strataTone(id);
}

export function StrataLadder({ groups }: { groups: StratumGroup[] }) {
  return (
    <div className="mb-6 rounded-lg border bg-card p-4">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Strata
      </p>
      <ol className="space-y-2">
        {groups.map((g) => {
          const color = strataTone(g.stratum.id);
          return (
            <li key={g.stratum.id}>
              <a
                href={`#stratum-${g.stratum.id}`}
                className="flex items-start gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted/50 transition-colors border-l-2"
                style={{ borderLeftColor: color, color }}
              >
                <span className="shrink-0 font-mono text-xs font-semibold mt-0.5">
                  S{g.stratum.id}
                </span>
                <span>
                  <span className="font-medium" style={{ color }}>
                    {g.stratum.label}
                  </span>
                  <span className="ml-2 text-muted-foreground">
                    {g.stratum.prose}
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
