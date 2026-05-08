import { useState, useMemo } from "react";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import { formatRepo, formatSource, formatEvent, formatRef, formatDetails } from "../lib/format.ts";

export type PivotMode = { type: "trace"; id: string } | { type: "orch"; id: string } | null;

export type DslPredicate = ((event: CanonicalEvent) => boolean) | null;

export function useFilter(events: CanonicalEvent[], dslPredicate: DslPredicate = null) {
  const [filterText, setFilterText] = useState("");
  const [pivot, setPivot] = useState<PivotMode>(null);

  const filtered = useMemo(() => {
    let result = events;

    if (pivot?.type === "trace") {
      result = result.filter((e) => e.traceId === pivot.id);
    } else if (pivot?.type === "orch") {
      result = result.filter((e) => e.attributes["catalyst.orchestrator.id"] === pivot.id);
    }

    if (dslPredicate) {
      result = result.filter(dslPredicate);
    }

    if (!filterText) return result;

    const text = filterText.toLowerCase();
    return result.filter((e) => {
      const row = [
        formatRepo(e),
        formatSource(e),
        formatEvent(e),
        formatRef(e),
        formatDetails(e),
      ]
        .join(" ")
        .toLowerCase();
      return row.includes(text);
    });
  }, [events, filterText, pivot, dslPredicate]);

  return { filterText, setFilterText, pivot, setPivot, filtered };
}
