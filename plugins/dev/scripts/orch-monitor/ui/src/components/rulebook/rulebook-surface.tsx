// rulebook-surface.tsx — CTL-1103 Phase 2 (placeholder; full UI in Phase 3–5)
import { useBeliefsContext } from "@/hooks/use-beliefs";

export function RulebookSurface() {
  useBeliefsContext(); // dedup contract: consume context, never useBeliefs()
  return <div className="p-6 text-muted-foreground">Rulebook — coming soon</div>;
}
