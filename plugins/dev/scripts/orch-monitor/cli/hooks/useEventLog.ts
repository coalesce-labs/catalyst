import { useState, useEffect, useRef } from "react";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import { readBacklog, tailEventLog } from "../../lib/event-log-reader.ts";
import { shouldSkipEvent } from "../lib/format.ts";

/**
 * Microtask coalescer: enqueue is O(1) and synchronous; flush fires once
 * per microtask tick with the full batch. Used by useEventLog to collapse
 * the N-events-per-200ms-poll-tick flood into one React commit (CTL-473).
 */
export function createCoalescer<T>(flush: (batch: T[]) => void) {
  let buffer: T[] = [];
  let scheduled = false;
  return {
    enqueue(item: T) {
      buffer.push(item);
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          if (buffer.length === 0) return;
          const batch = buffer;
          buffer = [];
          flush(batch);
        });
      }
    },
  };
}

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
        const sinceMs = new Date(sinceTs).getTime();
        initial = initial.filter((e) => new Date(e.ts).getTime() >= sinceMs);
      }
      if (repoFilter) {
        initial = initial.filter((e) => {
          const repo = e.attributes?.["vcs.repository.name"] ?? "";
          return !repo || repo.includes(repoFilter);
        });
      }

      setEvents(initial);
      setLoading(false);

      // CTL-473: coalesce per-line setEvents calls so each 200ms poll tick
      // produces at most one React commit regardless of how many lines arrived.
      // Ink runs in LegacyRoot mode, so React 18 auto-batching does NOT apply
      // to setStates from setTimeout/async callbacks — each commit otherwise
      // fires independently.
      const coalescer = createCoalescer<CanonicalEvent>((batch) => {
        try {
          setEvents((prev) => {
            const next = prev.length === 0 ? batch.slice() : prev.concat(batch);
            return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
          });
        } catch (err: unknown) {
          // CTL-473: never swallow flush errors silently — coalescer's
          // scheduled flag is already reset, so dropping the throw here would
          // lose `batch` with no trace.
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[catalyst-hud] coalesce flush error: ${msg}\n`);
        }
      });

      await tailEventLog({
        catalystDir: CATALYST_DIR,
        predicate,
        signal: controller.signal,
        onEvent: (line) => {
          try {
            const event = JSON.parse(line) as CanonicalEvent;
            if (shouldSkipEvent(event)) return;
            if (sinceTs && new Date(event.ts).getTime() < new Date(sinceTs).getTime()) return;
            if (repoFilter) {
              const repo = event.attributes["vcs.repository.name"] ?? "";
              if (repo && !repo.includes(repoFilter)) return;
            }
            coalescer.enqueue(event);
          } catch (err: unknown) {
            // CTL-473: only malformed JSON is expected — surface anything else
            // (e.g. shouldSkipEvent throw, coalescer throw) so programming
            // errors don't disappear into the catch.
            if (err instanceof SyntaxError) return;
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[catalyst-hud] onEvent error: ${msg}\n`);
          }
        },
      });
    }

    run().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[catalyst-hud] load error: ${msg}\n`);
      setLoading(false);
    });
    return () => controller.abort();
  }, [predicate, repoFilter, sinceTs]);

  return { events, loading };
}
