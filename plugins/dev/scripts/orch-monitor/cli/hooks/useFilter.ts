import { useState, useMemo } from "react";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";

export type PivotMode = { type: "trace"; id: string } | { type: "orch"; id: string } | null;

export type DslPredicate = ((event: CanonicalEvent) => boolean) | null;

// CTL-367: per-event haystack cache. Events are immutable JSON objects from
// the event log (CTL-344 assigns a UUIDv4 id at build time and they are never
// mutated downstream), so a WeakMap keyed on the event reference safely
// memoizes the JSON serialization across renders. Entries are reclaimed
// automatically when events fall out of the loaded window.
const haystackCache = new WeakMap<CanonicalEvent, string>();

export function buildHaystack(event: CanonicalEvent): string {
  const cached = haystackCache.get(event);
  if (cached !== undefined) return cached;
  const built = JSON.stringify(event).toLowerCase();
  haystackCache.set(event, built);
  return built;
}

export function tokenize(filterText: string): string[] {
  return filterText.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesFilter(event: CanonicalEvent, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = buildHaystack(event);
  for (const t of tokens) {
    if (!haystack.includes(t)) return false;
  }
  return true;
}

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

    const tokens = tokenize(filterText);
    if (tokens.length === 0) return result;

    return result.filter((e) => matchesFilter(e, tokens));
  }, [events, filterText, pivot, dslPredicate]);

  return { filterText, setFilterText, pivot, setPivot, filtered };
}
