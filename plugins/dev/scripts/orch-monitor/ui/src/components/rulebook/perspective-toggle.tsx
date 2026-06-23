// perspective-toggle.tsx — CTL-1320: ONE hoisted control that switches every rule
// card between Plain English | Datalog | SQL. This replaces the 17 repeating
// per-card tab strips (the "nested chrome" the operator flagged): switch once and
// all cards follow, with cross-visit memory (atomWithStorage). The Datalog/SQL
// triggers are muted to keep the jargon demoted by default.
import { atomWithStorage } from "jotai/utils";
import { useAtom } from "jotai";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type Perspective = "english" | "datalog" | "sql";

/** The active per-rule perspective, shared by every RuleCard. Persisted so a
 *  chosen lens (e.g. an engineer who lives in Datalog) survives a reload. */
export const perspectiveAtom = atomWithStorage<Perspective>(
  "rulebook-perspective",
  "english",
);

export function PerspectiveToggle() {
  const [perspective, setPerspective] = useAtom(perspectiveAtom);
  return (
    <div className="sticky top-0 z-10 -mx-6 mb-2 flex items-center gap-3 border-b bg-background/80 px-6 py-2.5 backdrop-blur">
      <span className="text-xs text-muted-foreground">Show each rule as</span>
      <ToggleGroup
        type="single"
        size="sm"
        value={perspective}
        // A single-select toggle can return "" when the active item is re-clicked;
        // ignore that so a lens is always selected.
        onValueChange={(v) => v && setPerspective(v as Perspective)}
      >
        <ToggleGroupItem value="english" className="px-3 text-xs">
          Plain English
        </ToggleGroupItem>
        <ToggleGroupItem
          value="datalog"
          className="px-3 text-xs text-muted-foreground data-[state=on]:text-foreground"
        >
          Datalog
        </ToggleGroupItem>
        <ToggleGroupItem
          value="sql"
          className="px-3 text-xs text-muted-foreground data-[state=on]:text-foreground"
        >
          SQL
        </ToggleGroupItem>
      </ToggleGroup>
      <span className="ml-auto hidden text-xs text-muted-foreground/60 sm:inline">
        switch once — all rules follow
      </span>
    </div>
  );
}
