import { useState, useEffect, useRef } from "react";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import { readBacklog, tailEventLog } from "../../lib/event-log-reader.ts";
import { shouldSkipEvent } from "../lib/format.ts";

const MAX_EVENTS = 10_000;
const CATALYST_DIR = process.env["CATALYST_DIR"] ?? `${process.env["HOME"]}/catalyst`;

interface UseEventLogOpts {
  predicate?: string;
  repoFilter?: string;
  sinceTs?: string;
}

export function useEventLog({ predicate = "", repoFilter = "", sinceTs }: UseEventLogOpts = {}) {
  const [events, setEvents] = useState<CanonicalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    async function run() {
      const raw = await readBacklog({ catalystDir: CATALYST_DIR, predicate, limit: MAX_EVENTS });
      let initial = raw
        .map((line) => {
          try {
            return JSON.parse(line) as CanonicalEvent;
          } catch {
            return null;
          }
        })
        .filter((e): e is CanonicalEvent => e !== null)
        .filter((e) => !shouldSkipEvent(e));

      if (sinceTs) {
        initial = initial.filter((e) => e.ts >= sinceTs);
      }
      if (repoFilter) {
        initial = initial.filter((e) => {
          const repo = e.attributes["vcs.repository.name"] ?? "";
          return !repo || repo.includes(repoFilter);
        });
      }

      setEvents(initial);
      setLoading(false);

      await tailEventLog({
        catalystDir: CATALYST_DIR,
        predicate,
        signal: controller.signal,
        onEvent: (line) => {
          try {
            const event = JSON.parse(line) as CanonicalEvent;
            if (shouldSkipEvent(event)) return;
            if (sinceTs && event.ts < sinceTs) return;
            if (repoFilter) {
              const repo = event.attributes["vcs.repository.name"] ?? "";
              if (repo && !repo.includes(repoFilter)) return;
            }
            setEvents((prev) => {
              const next = [...prev, event];
              return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
            });
          } catch {
            // ignore malformed lines
          }
        },
      });
    }

    run().catch(() => {});
    return () => controller.abort();
  }, [predicate, repoFilter, sinceTs]);

  return { events, loading };
}
