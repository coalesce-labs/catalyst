/**
 * Subscribe to the global Catalyst event log multiplexed onto the existing
 * /events SSE endpoint. Server-side filtering is performed by passing a jq
 * predicate as the `?activity=` query parameter — pass an empty string to
 * receive all events.
 *
 * Mirrors the pattern from `use-comms.ts`: lazy connect, exponential backoff
 * reconnect, and a hard cap on retained events to bound memory.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface ActivityEventScope {
  repo?: string;
  pr?: number;
  ticket?: string;
  orchestrator?: string | null;
  worker?: string | null;
  sha?: string;
  ref?: string;
  environment?: string;
}

export interface ActivityEvent {
  ts: string;
  event: string;
  scope?: ActivityEventScope;
  detail?: unknown;
  source?: string;
  schemaVersion?: number;
  // v1 backward-compat top-level fields written by the bash CLI tools.
  orchestrator?: string | null;
  worker?: string | null;
  session?: string;
  raw: unknown;
}

export type ActivityStatus = "loading" | "ok" | "error";

interface UseActivityStreamResult {
  events: ActivityEvent[];
  status: ActivityStatus;
  error: string | null;
  live: boolean;
  retry: () => void;
}

const MAX_EVENTS = 500;

export function useActivityStream(predicate: string): UseActivityStreamResult {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [status, setStatus] = useState<ActivityStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(0);
  const retry = useCallback(() => setTick((n) => n + 1), []);
  const eventsRef = useRef<ActivityEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 500;
    const BACKOFF_MAX = 15000;

    setStatus("loading");
    setError(null);
    setEvents([]);
    eventsRef.current = [];

    function connect(): void {
      if (cancelled) return;
      const url = `/events?activity=${encodeURIComponent(predicate)}`;
      try {
        es = new EventSource(url);
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
        scheduleReconnect();
        return;
      }

      es.addEventListener("open", () => {
        backoff = 500;
        setLive(true);
        setStatus("ok");
        setError(null);
      });

      es.addEventListener("global-event-backlog", (e) => {
        try {
          const env = JSON.parse((e as MessageEvent<string>).data) as {
            data?: { events?: unknown[] };
          };
          const list: unknown[] = env.data?.events ?? [];
          const projected = list.map(projectEnvelope);
          if (cancelled) return;
          eventsRef.current = projected.slice(-MAX_EVENTS);
          setEvents([...eventsRef.current]);
          setStatus("ok");
        } catch (err) {
          console.error("activity backlog parse failed", err);
        }
      });

      es.addEventListener("global-event", (e) => {
        try {
          const env = JSON.parse((e as MessageEvent<string>).data) as {
            data?: unknown;
          };
          const projected = projectEnvelope(env.data);
          if (cancelled) return;
          const next = [...eventsRef.current, projected];
          eventsRef.current = next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
          setEvents([...eventsRef.current]);
        } catch (err) {
          console.error("activity event parse failed", err);
        }
      });

      es.onerror = () => {
        setLive(false);
        try {
          es?.close();
        } catch {
          /* ignore */
        }
        es = null;
        scheduleReconnect();
      };
    }

    function scheduleReconnect(): void {
      if (cancelled) return;
      const delay = backoff;
      backoff = Math.min(BACKOFF_MAX, backoff * 2);
      reconnectTimer = setTimeout(connect, delay);
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        es?.close();
      } catch {
        /* ignore */
      }
    };
  }, [predicate, tick]);

  return { events, status, error, live, retry };
}

function projectEnvelope(raw: unknown): ActivityEvent {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ts: typeof r.ts === "string" ? r.ts : "",
    event: typeof r.event === "string" ? r.event : "",
    scope: (r.scope as ActivityEventScope | undefined) ?? undefined,
    detail: r.detail,
    source: typeof r.source === "string" ? r.source : undefined,
    schemaVersion:
      typeof r.schemaVersion === "number" ? r.schemaVersion : undefined,
    orchestrator: (r.orchestrator as string | null | undefined) ?? null,
    worker: (r.worker as string | null | undefined) ?? null,
    session: typeof r.session === "string" ? r.session : undefined,
    raw,
  };
}

/**
 * Build a jq predicate from a list of active topic prefixes. Used by the topic
 * palette to translate chip toggles into a server-side filter.
 *
 *   buildPredicate([])                               // ""  (no filter)
 *   buildPredicate(["github.pr."])                   // (.event | startswith("github.pr."))
 *   buildPredicate(["github.pr.", "linear."])        // (.event | startswith("github.pr.")) or (.event | startswith("linear."))
 *   buildPredicate(["github.push"])                  // (.event == "github.push" or (.event | startswith("github.push-")))
 */
export function buildPredicateFromPrefixes(prefixes: string[]): string {
  if (prefixes.length === 0) return "";
  const parts = prefixes.map((p) => {
    if (p.endsWith(".")) return `(.event | startswith("${escapeJqString(p)}"))`;
    // Bare names match exactly OR as a prefix with a hyphen separator (covers
    // unprefixed bash topics like `worker-done`, `wave-started`, etc.).
    return `(.event == "${escapeJqString(p)}" or (.event | startswith("${escapeJqString(p)}-")))`;
  });
  return parts.join(" or ");
}

function escapeJqString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
