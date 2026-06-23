// strata-ladder.tsx — CTL-1320: "The ladder of reasoning".
// The six belief strata as a quiet, scannable ladder rather than peer cards:
// the PLAIN headline leads, the technical label is demoted to muted subtext, and
// the stratum NUMBER is rendered exactly once (the dot on the connector spine —
// the old design printed it twice because the label already embeds "S{id}").
// A left spine, tinted strataTone(id), reads bottom-to-top: facts rise to decisions.
import type { StratumGroup } from "@/lib/rulebook-model";
import { strataTone } from "@/lib/rulebook-theme";

/** CSS variable string for a stratum id — used by rule-card and rulebook-surface. */
export function stratumColorForId(id: number): string {
  return strataTone(id);
}

/** "S1 ground correlations" → "ground correlations" — the technical label with its
 *  redundant stratum-number prefix stripped (belt-and-suspenders; STRATA_META now
 *  also leads with plain_headline so this only formats the subtext). */
function techLabel(label: string): string {
  return label.replace(/^S\d+\s+/, "");
}

/** First clause of the technical prose — a short implementation hint for the subtext. */
function techHint(prose: string): string {
  return prose.split(/[;.]/)[0]?.trim() ?? "";
}

export function LadderOfReasoning({ groups }: { groups: StratumGroup[] }) {
  return (
    <section className="mb-12">
      <h2 className="text-base font-semibold">The ladder of reasoning</h2>
      <p className="mt-1 mb-5 text-sm text-muted-foreground">
        Facts enter at the bottom and rise into decisions. Six layers, 17 rules.
      </p>

      <ol className="relative">
        {/* the spine */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-[11px] top-3 bottom-3 w-px bg-border"
        />
        {groups.map((g) => {
          const color = strataTone(g.stratum.id);
          const n = g.rules.length;
          return (
            <li key={g.stratum.id}>
              <a
                href={`#stratum-${g.stratum.id}`}
                className="group relative block rounded-lg py-2.5 pl-9 pr-3 -ml-2 hover:bg-foreground/[0.025] transition-colors"
              >
                <span
                  aria-hidden
                  className="absolute left-[3px] top-3.5 grid size-[18px] place-items-center rounded-full text-[10px] font-semibold text-background"
                  style={{ backgroundColor: color }}
                >
                  {g.stratum.id}
                </span>
                <div className="font-medium text-[15px] text-foreground">
                  {g.stratum.plain_headline}
                </div>
                <div className="text-sm text-muted-foreground">
                  {g.stratum.plain_body}
                </div>
                <div className="mt-0.5 font-mono text-xs text-muted-foreground/60">
                  {techLabel(g.stratum.label)} · {techHint(g.stratum.prose)} · {n}{" "}
                  {n === 1 ? "rule" : "rules"}
                </div>
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
