import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MonitorSnapshot,
  WorkerAnalytics,
  LinearTicket,
  ConnectionStatus,
  EventEntry,
  CollectedAttention,
  WorkerState,
  OrchestratorState,
  SessionState,
} from "@/lib/types";

const MAX_EVENTS = 200;
const STALE_THRESHOLD = 900;

interface WorkerPrev {
  status: string;
  phase: number;
  pid: number | null;
  alive: boolean;
  pr: WorkerState["pr"];
}

function collectAttention(snap: MonitorSnapshot): CollectedAttention[] {
  const items: CollectedAttention[] = [];
  const done = new Set(["done", "merged", "failed", "stalled"]);
  for (const orch of snap.orchestrators) {
    for (const [ticket, w] of Object.entries(orch.workers)) {
      if (w.status === "failed" || w.status === "stalled") {
        items.push({
          orchId: orch.id,
          ticket,
          reason: "Status: " + w.status,
          severity: "error",
        });
      } else if (w.pid && w.alive === false && !done.has(w.status)) {
        items.push({
          orchId: orch.id,
          ticket,
          reason: "Worker died",
          severity: "error",
        });
      }
    }
  }
  items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    return a.ticket.localeCompare(b.ticket);
  });
  return items;
}

export function useMonitor() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot>({
    timestamp: "",
    orchestrators: [],
  });
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [analytics, setAnalytics] = useState<
    Map<string, Record<string, WorkerAnalytics | null>>
  >(new Map());
  const [linear, setLinear] = useState<Map<string, LinearTicket>>(new Map());
  const [attention, setAttention] = useState<CollectedAttention[]>([]);
  const [sessions, setSessions] = useState<SessionState[]>([]);

  const prevWorkerRef = useRef<Map<string, WorkerPrev>>(new Map());
  const seenAttentionRef = useRef<Set<string>>(new Set());
  const prevWaveStatusRef = useRef<Map<string, string>>(new Map());
  const briefingSeenRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);
  const eventsRef = useRef<EventEntry[]>([]);

  const addEvent = useCallback(
    (kind: string, message: string, ticket?: string, orchId?: string) => {
      const when = new Date().toLocaleTimeString();
      const entry: EventEntry = { when, kind, message, ticket, orchId };
      eventsRef.current = [entry, ...eventsRef.current].slice(0, MAX_EVENTS);
      setEvents([...eventsRef.current]);
    },
    [],
  );

  const diffWorker = useCallback(
    (orchId: string, prev: WorkerPrev | undefined, next: WorkerState) => {
      const ticket = next.ticket || "?";
      if (!prev) {
        if (primedRef.current) {
          addEvent(
            "new",
            `${ticket} discovered · status ${next.status || "?"} · phase ${next.phase ?? 0}`,
            ticket,
            orchId,
          );
        }
        return;
      }
      if (prev.status !== next.status) {
        addEvent(
          "status",
          `${ticket} status ${prev.status || "?"} → ${next.status || "?"}`,
          ticket,
          orchId,
        );
      }
      if ((prev.phase ?? 0) !== (next.phase ?? 0)) {
        addEvent(
          "phase",
          `${ticket} phase ${prev.phase ?? 0} → ${next.phase ?? 0}`,
          ticket,
          orchId,
        );
      }
      const prevPr = prev.pr?.number;
      const nextPr = next.pr?.number;
      if (nextPr && prevPr !== nextPr) {
        addEvent(
          "pr",
          `${ticket} PR opened #${nextPr}`,
          ticket,
          orchId,
        );
      }
      if (prev.alive !== next.alive) {
        addEvent(
          "live",
          `${ticket} process ${prev.alive ? "alive" : "dead"} → ${next.alive ? "alive" : "dead"}`,
          ticket,
          orchId,
        );
      }
      if (!prev.pid && next.pid) {
        addEvent("live", `${ticket} PID acquired · ${next.pid}`, ticket, orchId);
      }
    },
    [addEvent],
  );

  const processSnapshot = useCallback(
    (snap: MonitorSnapshot) => {
      const nowKeys = new Set<string>();
      for (const orch of snap.orchestrators) {
        // Wave status changes
        if (Array.isArray(orch.waves)) {
          for (const w of orch.waves) {
            const key = orch.id + ":" + w.wave;
            const prev = prevWaveStatusRef.current.get(key);
            if (
              prev !== undefined &&
              prev !== w.status &&
              primedRef.current
            ) {
              addEvent(
                "wave",
                `Wave ${w.wave} ${prev} → ${w.status}`,
                undefined,
                orch.id,
              );
            }
            prevWaveStatusRef.current.set(key, w.status);
          }
          // Briefings
          if (orch.briefings && primedRef.current) {
            for (const nStr of Object.keys(orch.briefings)) {
              const bKey = orch.id + ":" + nStr;
              if (!briefingSeenRef.current.has(bKey)) {
                briefingSeenRef.current.add(bKey);
                addEvent("brief", `Wave ${nStr} briefing written`, undefined, orch.id);
              }
            }
          } else if (orch.briefings) {
            for (const nStr of Object.keys(orch.briefings)) {
              briefingSeenRef.current.add(orch.id + ":" + nStr);
            }
          }
        }

        // Attention items
        if (Array.isArray(orch.attention)) {
          for (const item of orch.attention) {
            const raw = item as Record<string, unknown>;
            const key =
              orch.id +
              ":" +
              ((raw.id as string) ||
                (raw.ticket as string) ||
                JSON.stringify(raw));
            if (!seenAttentionRef.current.has(key)) {
              seenAttentionRef.current.add(key);
              const ticket =
                (raw.ticket as string) || (raw.workerName as string) || "";
              const reason =
                (raw.reason as string) ||
                (raw.message as string) ||
                (raw.type as string) ||
                "needs attention";
              addEvent("attn", `${ticket ? ticket + " · " : ""}${reason}`, ticket, orch.id);
            }
          }
        }

        // Worker diffs
        for (const [key, w] of Object.entries(orch.workers)) {
          const k = orch.id + ":" + (w.ticket || key);
          nowKeys.add(k);
          diffWorker(orch.id, prevWorkerRef.current.get(k), w);
          prevWorkerRef.current.set(k, {
            status: w.status,
            phase: w.phase,
            pid: w.pid,
            alive: w.alive,
            pr: w.pr,
          });
        }
      }

      for (const k of Array.from(prevWorkerRef.current.keys())) {
        if (!nowKeys.has(k)) {
          const [orchId, ticket] = k.split(":");
          addEvent("live", `${ticket} removed from ${orchId}`, ticket, orchId);
          prevWorkerRef.current.delete(k);
        }
      }

      primedRef.current = true;
      setSnapshot(snap);
      setAttention(collectAttention(snap));
    },
    [addEvent, diffWorker],
  );

  const patchWorker = useCallback(
    (payload: { orchId: string; worker: WorkerState }) => {
      setSnapshot((prev) => {
        const orch = prev.orchestrators.find((o) => o.id === payload.orchId);
        if (!orch) return prev;
        const next = { ...prev };
        const orchIdx = next.orchestrators.indexOf(orch);
        next.orchestrators = [...next.orchestrators];
        next.orchestrators[orchIdx] = {
          ...orch,
          workers: { ...orch.workers, [payload.worker.ticket]: payload.worker },
        };
        setAttention(collectAttention(next));
        return next;
      });

      const w = payload.worker;
      const k = payload.orchId + ":" + (w.ticket || "?");
      diffWorker(payload.orchId, prevWorkerRef.current.get(k), w);
      prevWorkerRef.current.set(k, {
        status: w.status,
        phase: w.phase,
        pid: w.pid,
        alive: w.alive,
        pr: w.pr,
      });
    },
    [diffWorker],
  );

  // SSE connection
  useEffect(() => {
    let es: EventSource | null = null;
    let backoff = 500;
    const BACKOFF_MAX = 15000;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      try {
        es = new EventSource("/events");
      } catch {
        scheduleReconnect();
        return;
      }
      es.addEventListener("open", () => {
        backoff = 500;
        setConnectionStatus("connected");
      });
      es.addEventListener("snapshot", (e) => {
        try {
          const envelope = JSON.parse(e.data);
          processSnapshot(envelope.data ?? envelope);
        } catch (err) {
          console.error("snapshot parse failed", err);
        }
      });
      es.addEventListener("worker-update", (e) => {
        try {
          const envelope = JSON.parse(e.data);
          patchWorker(envelope.data ?? envelope);
        } catch (err) {
          console.error("worker-update parse failed", err);
        }
      });
      es.addEventListener("liveness-change", (e) => {
        try {
          const envelope = JSON.parse(e.data);
          patchWorker(envelope.data ?? envelope);
        } catch (err) {
          console.error("liveness-change parse failed", err);
        }
      });
      es.onerror = () => {
        setConnectionStatus("reconnecting");
        try {
          es?.close();
        } catch {}
        es = null;
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (cancelled) return;
      const delay = backoff;
      backoff = Math.min(BACKOFF_MAX, backoff * 2);
      setTimeout(connect, delay);
    }

    connect();
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [processSnapshot, patchWorker]);

  // Analytics polling
  useEffect(() => {
    async function refresh() {
      try {
        const resp = await fetch("/api/analytics");
        if (!resp.ok) return;
        const data = await resp.json();
        const orchs = data?.orchestrators || [];
        const next = new Map<string, Record<string, WorkerAnalytics | null>>();
        for (const oa of orchs) {
          next.set(oa.id, oa.workers || {});
        }
        setAnalytics(next);
      } catch {}
    }
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, []);

  // Linear polling
  useEffect(() => {
    async function refresh() {
      try {
        const resp = await fetch("/api/linear");
        if (!resp.ok) return;
        const data = await resp.json();
        const tickets = data?.tickets || {};
        const next = new Map<string, LinearTicket>();
        for (const [key, t] of Object.entries(tickets)) {
          const lt = t as LinearTicket;
          if (lt?.key) next.set(lt.key, lt);
        }
        setLinear(next);
      } catch {}
    }
    refresh();
    const id = setInterval(refresh, 60000);
    return () => clearInterval(id);
  }, []);

  // Sessions polling
  useEffect(() => {
    async function refresh() {
      try {
        const resp = await fetch("/api/sessions?limit=50");
        if (!resp.ok) return;
        const data = await resp.json();
        if (data?.available && Array.isArray(data.sessions)) {
          setSessions(data.sessions);
        }
      } catch {}
    }
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  const getAnalytics = useCallback(
    (orchId: string) => analytics.get(orchId) || {},
    [analytics],
  );

  const getLinear = useCallback(
    (ticket: string) => linear.get(ticket) || null,
    [linear],
  );

  return {
    snapshot,
    connectionStatus,
    events,
    attention,
    analytics: getAnalytics,
    linear: getLinear,
    sessions,
    staleThreshold: STALE_THRESHOLD,
  };
}
