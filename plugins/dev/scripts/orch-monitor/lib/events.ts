import { emit as emitBus } from "./event-bus";

export type EventSource = "filesystem" | "sqlite" | "otel" | "api";

export const EVENT_TYPES = [
  "snapshot",
  "worker-update",
  "liveness-change",
  "session-update",
  "session-start",
  "session-end",
  "metrics-update",
  "annotation-change",
  // Global event log multiplex (per-client tail; see server.ts /events handler):
  "global-event-backlog",
  "global-event",
] as const;

export type MonitorEventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(EVENT_TYPES);

export interface MonitorEventEnvelope<T = unknown> {
  type: MonitorEventType;
  timestamp: string;
  data: T;
  source: EventSource;
}

interface SessionPayload {
  sessionId: string;
  status: string;
  workspace?: string;
}

interface SessionLifecyclePayload {
  sessionId: string;
  workspace?: string;
}

interface MetricsPayload {
  sessionId?: string;
  metrics: Record<string, number>;
}

interface AnnotationPayload {
  targetId: string;
  targetType: string;
  key: string;
  value: string | null;
}

export interface SSEFilter {
  types?: Set<MonitorEventType>;
  sessionId?: string;
  workspace?: string;
  /**
   * If set, the client opts into the global-event stream multiplexed onto the
   * same SSE connection. Empty string = no jq predicate (receive all global
   * events). Undefined = client does not want the global-event stream.
   */
  activityPredicate?: string;
}

export function createEvent<T>(
  type: MonitorEventType,
  data: T,
  source: EventSource,
): MonitorEventEnvelope<T> {
  return {
    type,
    timestamp: new Date().toISOString(),
    data,
    source,
  };
}

export function parseFilter(url: URL): SSEFilter {
  const filter: SSEFilter = {};

  const filterParam = url.searchParams.get("filter");
  if (filterParam) {
    const valid = filterParam
      .split(",")
      .filter((t) => EVENT_TYPE_SET.has(t)) as MonitorEventType[];
    if (valid.length > 0) {
      filter.types = new Set(valid);
    }
  }

  const session = url.searchParams.get("session");
  if (session && session.length <= 256) filter.sessionId = session;

  const workspace = url.searchParams.get("workspace");
  if (workspace && workspace.length <= 256) filter.workspace = workspace;

  const activity = url.searchParams.get("activity");
  if (activity !== null && activity.length <= 4096) {
    filter.activityPredicate = activity;
  }

  return filter;
}

export function emitSessionUpdate(payload: SessionPayload): void {
  emitBus("session-update", createEvent("session-update", payload, "sqlite"));
}

export function emitSessionStart(payload: SessionLifecyclePayload): void {
  emitBus("session-start", createEvent("session-start", payload, "sqlite"));
}

export function emitSessionEnd(payload: SessionLifecyclePayload): void {
  emitBus("session-end", createEvent("session-end", payload, "sqlite"));
}

export function emitMetricsUpdate(payload: MetricsPayload): void {
  emitBus("metrics-update", createEvent("metrics-update", payload, "otel"));
}

export function emitAnnotationChange(payload: AnnotationPayload): void {
  emitBus(
    "annotation-change",
    createEvent("annotation-change", payload, "api"),
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function matchesFilter(
  event: MonitorEventEnvelope,
  filter: SSEFilter,
): boolean {
  if (filter.types && !filter.types.has(event.type)) return false;

  if (filter.sessionId) {
    if (!isRecord(event.data) || event.data.sessionId !== filter.sessionId)
      return false;
  }

  if (filter.workspace) {
    if (!isRecord(event.data) || event.data.workspace !== filter.workspace)
      return false;
  }

  return true;
}
