import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useActivityStream,
  buildPredicateFromPrefixes,
} from "@/hooks/use-activity";
import { ActivityTopicPalette } from "./activity-topic-palette";
import { ActivityEventRow } from "./activity-event-row";
import { Radio } from "lucide-react";
import { EmptyState } from "./ui/empty-state";

const FILTER_KEY = "catalyst-activity-filter";
const PREFIXES_KEY = "catalyst-activity-prefixes";

interface ActivityViewProps {
  /**
   * Called when the user clicks a worker chip on an event row whose scope
   * carries both an orchestrator and a worker. The parent uses this to switch
   * the top view back to the dashboard, select the orchestrator, and open the
   * worker drawer.
   */
  onPivot: (orchId: string, ticket: string) => void;
}

export function ActivityView({ onPivot }: ActivityViewProps) {
  // Source of truth: the raw jq predicate text in the input. The topic palette
  // is a write-through helper that reformats this string when chips toggle.
  const [predicate, setPredicate] = useState<string>(
    () => localStorage.getItem(FILTER_KEY) ?? "",
  );
  const [debouncedPredicate, setDebouncedPredicate] = useState<string>(predicate);
  const [activePrefixes, setActivePrefixes] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(PREFIXES_KEY);
      if (!stored) return new Set();
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    const t = setTimeout(() => setDebouncedPredicate(predicate), 300);
    return () => clearTimeout(t);
  }, [predicate]);

  useEffect(() => {
    localStorage.setItem(FILTER_KEY, predicate);
  }, [predicate]);

  useEffect(() => {
    localStorage.setItem(
      PREFIXES_KEY,
      JSON.stringify([...activePrefixes]),
    );
  }, [activePrefixes]);

  const togglePrefix = useCallback((prefix: string) => {
    setActivePrefixes((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      const built = buildPredicateFromPrefixes([...next]);
      setPredicate(built);
      return next;
    });
  }, []);

  const clearPrefixes = useCallback(() => {
    setActivePrefixes(new Set());
    setPredicate("");
  }, []);

  const { events, status, error, live } = useActivityStream(debouncedPredicate);

  // Newest first in the UI; the backend returns chronological order.
  // Groq no-match wakes are pure noise — hidden before render (CTL-280).
  const ordered = useMemo(
    () =>
      [...events]
        .reverse()
        .filter((e) => {
          if (e.event.startsWith("filter.wake")) {
            const detail = (e.detail ?? {}) as Record<string, unknown>;
            return (detail.reason as string) !== "No matching events found";
          }
          return true;
        }),
    [events],
  );

  return (
    <div className="flex h-[calc(100vh-140px)] gap-4">
      <ActivityTopicPalette
        active={activePrefixes}
        onToggle={togglePrefix}
        onClear={clearPrefixes}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={predicate}
            onChange={(e) => setPredicate(e.target.value)}
            placeholder='jq predicate (e.g. .event == "github.pr.merged")'
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            className="flex-1 rounded border border-border bg-surface-2 px-2 py-1 font-mono text-[12px] text-fg placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <span className="shrink-0 text-[11px] tabular-nums text-muted">
            {events.length} event{events.length === 1 ? "" : "s"}
            {live ? " · live" : ""}
          </span>
        </div>
        {error && (
          <div className="rounded bg-red/15 px-2 py-1 text-[12px] text-red">
            {error}
          </div>
        )}
        <div className="flex-1 overflow-y-auto rounded bg-surface-2">
          {status === "loading" && events.length === 0 ? (
            <EmptyState icon={Radio} message="Connecting to activity stream…" />
          ) : ordered.length === 0 ? (
            <EmptyState icon={Radio} message="No events match filter." />
          ) : (
            ordered.map((e, i) => (
              <ActivityEventRow
                key={`${e.ts}-${i}`}
                event={e}
                onPivot={onPivot}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
