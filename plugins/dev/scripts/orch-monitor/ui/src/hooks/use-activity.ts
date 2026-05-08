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
import type { CanonicalEvent } from "../../../lib/canonical-event";

// Re-export so consumers can import from one place.
export type { CanonicalEvent as ActivityEvent };

export type ActivityStatus = "loading" | "ok" | "error";

interface UseActivityStreamResult {
  events: CanonicalEvent[];
  status: ActivityStatus;
  error: string | null;
  live: boolean;
  retry: () => void;
}

const MAX_EVENTS = 500;

export function useActivityStream(predicate: string): UseActivityStreamResult {
  const [events, setEvents] = useState<CanonicalEvent[]>([]);
  const [status, setStatus] = useState<ActivityStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(0);
  const retry = useCallback(() => setTick((n) => n + 1), []);
  const eventsRef = useRef<CanonicalEvent[]>([]);

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

function projectEnvelope(raw: unknown): CanonicalEvent {
  const r = (raw ?? {}) as Record<string, unknown>;
  const attrs = (r.attributes ?? {}) as Record<string, unknown>;
  const body = (r.body ?? {}) as Record<string, unknown>;
  const resource = (r.resource ?? {}) as Record<string, unknown>;
  return {
    ts: typeof r.ts === "string" ? r.ts : "",
    observedTs: typeof r.observedTs === "string" ? r.observedTs : undefined,
    severityText:
      r.severityText === "DEBUG" ||
      r.severityText === "INFO" ||
      r.severityText === "WARN" ||
      r.severityText === "ERROR"
        ? r.severityText
        : "INFO",
    severityNumber: typeof r.severityNumber === "number" ? r.severityNumber : 9,
    traceId: typeof r.traceId === "string" ? r.traceId : null,
    spanId: typeof r.spanId === "string" ? r.spanId : null,
    parentSpanId:
      r.parentSpanId === null || typeof r.parentSpanId === "string"
        ? r.parentSpanId
        : undefined,
    resource: {
      "service.name":
        typeof resource["service.name"] === "string"
          ? resource["service.name"]
          : "catalyst.session",
      "service.namespace": "catalyst",
      "service.version":
        typeof resource["service.version"] === "string"
          ? resource["service.version"]
          : "0.0.0",
    },
    attributes: {
      "event.name":
        typeof attrs["event.name"] === "string" ? attrs["event.name"] : "",
      ...attrs,
    },
    body: {
      message: typeof body.message === "string" ? body.message : undefined,
      payload: body.payload,
    },
  };
}

/**
 * Build a jq predicate from a list of active topic prefixes. Used by the topic
 * palette to translate chip toggles into a server-side filter.
 *
 *   buildPredicate([])                               // ""  (no filter)
 *   buildPredicate(["github.pr."])                   // (.attributes["event.name"] | startswith("github.pr."))
 *   buildPredicate(["github.pr.", "linear."])        // (.attributes["event.name"] | startswith("github.pr.")) or (.attributes["event.name"] | startswith("linear."))
 *   buildPredicate(["github.push"])                  // (.attributes["event.name"] == "github.push" or (.attributes["event.name"] | startswith("github.push.")))
 */
export function buildPredicateFromPrefixes(prefixes: string[]): string {
  if (prefixes.length === 0) return "";
  const field = `.attributes["event.name"]`;
  const parts = prefixes.map((p) => {
    if (p.endsWith(".")) return `(${field} | startswith("${escapeJqString(p)}"))`;
    // Bare names match exactly OR as a prefix with a dot separator (canonical
    // names use dots, e.g. "session.phase", "orchestrator.worker.done").
    return `(${field} == "${escapeJqString(p)}" or (${field} | startswith("${escapeJqString(p)}.")))`;
  });
  return parts.join(" or ");
}

function escapeJqString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
