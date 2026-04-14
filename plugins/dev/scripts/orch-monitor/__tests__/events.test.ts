import { describe, it, expect } from "bun:test";
import {
  createEvent,
  parseFilter,
  matchesFilter,
  EVENT_TYPES,
  emitSessionUpdate,
  emitSessionStart,
  emitSessionEnd,
  emitMetricsUpdate,
  emitAnnotationChange,
  type MonitorEventEnvelope,
  type SSEFilter,
  type MonitorEventType,
} from "../lib/events";
import { subscribe } from "../lib/event-bus";

describe("createEvent", () => {
  it("produces a valid envelope shape", () => {
    const event = createEvent("snapshot", { orchestrators: [] }, "filesystem");
    expect(event.type).toBe("snapshot");
    expect(event.data).toEqual({ orchestrators: [] });
    expect(event.source).toBe("filesystem");
    expect(typeof event.timestamp).toBe("string");
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
  });

  it("preserves the exact data payload without mutation", () => {
    const data = { sessionId: "abc", status: "active" };
    const event = createEvent("session-update", data, "sqlite");
    expect(event.data).toBe(data);
  });

  it("sets ISO timestamp close to now", () => {
    const before = Date.now();
    const event = createEvent("worker-update", {}, "filesystem");
    const after = Date.now();
    const ts = new Date(event.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("EVENT_TYPES", () => {
  it("includes all expected event types", () => {
    const expected = [
      "snapshot",
      "worker-update",
      "liveness-change",
      "session-update",
      "session-start",
      "session-end",
      "metrics-update",
      "annotation-change",
    ];
    for (const t of expected) {
      expect((EVENT_TYPES as readonly string[]).includes(t)).toBe(true);
    }
  });

  it("has no duplicates", () => {
    const unique = new Set(EVENT_TYPES);
    expect(unique.size).toBe(EVENT_TYPES.length);
  });
});

describe("parseFilter", () => {
  it("returns empty filter for no query params", () => {
    const url = new URL("http://localhost/events");
    const filter = parseFilter(url);
    expect(filter.types).toBeUndefined();
    expect(filter.sessionId).toBeUndefined();
    expect(filter.workspace).toBeUndefined();
  });

  it("parses filter param into a Set of event types", () => {
    const url = new URL("http://localhost/events?filter=snapshot,worker-update");
    const filter = parseFilter(url);
    expect(filter.types).toBeDefined();
    expect(filter.types!.has("snapshot" as MonitorEventType)).toBe(true);
    expect(filter.types!.has("worker-update" as MonitorEventType)).toBe(true);
    expect(filter.types!.size).toBe(2);
  });

  it("ignores invalid event types in filter param", () => {
    const url = new URL("http://localhost/events?filter=snapshot,bogus");
    const filter = parseFilter(url);
    expect(filter.types!.size).toBe(1);
    expect(filter.types!.has("snapshot" as MonitorEventType)).toBe(true);
  });

  it("returns undefined types when all filter values are invalid", () => {
    const url = new URL("http://localhost/events?filter=bogus,fake");
    const filter = parseFilter(url);
    expect(filter.types).toBeUndefined();
  });

  it("parses session param", () => {
    const url = new URL("http://localhost/events?session=abc-123");
    const filter = parseFilter(url);
    expect(filter.sessionId).toBe("abc-123");
  });

  it("parses workspace param", () => {
    const url = new URL("http://localhost/events?workspace=my-project");
    const filter = parseFilter(url);
    expect(filter.workspace).toBe("my-project");
  });

  it("ignores session and workspace params exceeding 256 chars", () => {
    const long = "x".repeat(257);
    const url = new URL(`http://localhost/events?session=${long}&workspace=${long}`);
    const filter = parseFilter(url);
    expect(filter.sessionId).toBeUndefined();
    expect(filter.workspace).toBeUndefined();
  });

  it("parses all params together", () => {
    const url = new URL(
      "http://localhost/events?filter=session-update&session=s1&workspace=ws1",
    );
    const filter = parseFilter(url);
    expect(filter.types!.has("session-update" as MonitorEventType)).toBe(true);
    expect(filter.sessionId).toBe("s1");
    expect(filter.workspace).toBe("ws1");
  });
});

describe("matchesFilter", () => {
  const snapshotEvent: MonitorEventEnvelope = {
    type: "snapshot",
    timestamp: new Date().toISOString(),
    data: { orchestrators: [] },
    source: "filesystem",
  };

  const sessionEvent: MonitorEventEnvelope = {
    type: "session-update",
    timestamp: new Date().toISOString(),
    data: { sessionId: "sess-1", status: "active", workspace: "my-repo" },
    source: "sqlite",
  };

  const workerEvent: MonitorEventEnvelope = {
    type: "worker-update",
    timestamp: new Date().toISOString(),
    data: { orchId: "orch-1", worker: { ticket: "T-1" } },
    source: "filesystem",
  };

  it("matches everything when filter is empty", () => {
    const filter: SSEFilter = {};
    expect(matchesFilter(snapshotEvent, filter)).toBe(true);
    expect(matchesFilter(sessionEvent, filter)).toBe(true);
    expect(matchesFilter(workerEvent, filter)).toBe(true);
  });

  it("filters by event type", () => {
    const filter: SSEFilter = {
      types: new Set(["snapshot" as MonitorEventType]),
    };
    expect(matchesFilter(snapshotEvent, filter)).toBe(true);
    expect(matchesFilter(sessionEvent, filter)).toBe(false);
    expect(matchesFilter(workerEvent, filter)).toBe(false);
  });

  it("filters by multiple event types", () => {
    const filter: SSEFilter = {
      types: new Set([
        "snapshot" as MonitorEventType,
        "worker-update" as MonitorEventType,
      ]),
    };
    expect(matchesFilter(snapshotEvent, filter)).toBe(true);
    expect(matchesFilter(workerEvent, filter)).toBe(true);
    expect(matchesFilter(sessionEvent, filter)).toBe(false);
  });

  it("filters by sessionId in data", () => {
    const filter: SSEFilter = { sessionId: "sess-1" };
    expect(matchesFilter(sessionEvent, filter)).toBe(true);
    expect(matchesFilter(snapshotEvent, filter)).toBe(false);
    expect(matchesFilter(workerEvent, filter)).toBe(false);
  });

  it("filters by workspace in data", () => {
    const filter: SSEFilter = { workspace: "my-repo" };
    expect(matchesFilter(sessionEvent, filter)).toBe(true);
    expect(matchesFilter(snapshotEvent, filter)).toBe(false);
  });

  it("combines type and sessionId filters (AND logic)", () => {
    const filter: SSEFilter = {
      types: new Set(["session-update" as MonitorEventType]),
      sessionId: "sess-1",
    };
    expect(matchesFilter(sessionEvent, filter)).toBe(true);

    const wrongSession: MonitorEventEnvelope = {
      ...sessionEvent,
      data: { sessionId: "other", status: "active" },
    };
    expect(matchesFilter(wrongSession, filter)).toBe(false);
  });

  it("snapshot events always pass when no type filter is set", () => {
    const filter: SSEFilter = { sessionId: "anything" };
    expect(matchesFilter(snapshotEvent, filter)).toBe(false);
  });
});

describe("emitter helpers", () => {
  it("emitSessionUpdate delivers envelope via event bus", () => {
    const received: unknown[] = [];
    const unsub = subscribe("session-update", (d) => received.push(d));
    emitSessionUpdate({ sessionId: "s1", status: "active", workspace: "ws" });
    unsub();
    expect(received).toHaveLength(1);
    const env = received[0] as MonitorEventEnvelope;
    expect(env.type).toBe("session-update");
    expect(env.source).toBe("sqlite");
    expect((env.data as { sessionId: string }).sessionId).toBe("s1");
  });

  it("emitSessionStart delivers envelope via event bus", () => {
    const received: unknown[] = [];
    const unsub = subscribe("session-start", (d) => received.push(d));
    emitSessionStart({ sessionId: "s2" });
    unsub();
    expect(received).toHaveLength(1);
    const env = received[0] as MonitorEventEnvelope;
    expect(env.type).toBe("session-start");
    expect(env.source).toBe("sqlite");
  });

  it("emitSessionEnd delivers envelope via event bus", () => {
    const received: unknown[] = [];
    const unsub = subscribe("session-end", (d) => received.push(d));
    emitSessionEnd({ sessionId: "s3", workspace: "proj" });
    unsub();
    expect(received).toHaveLength(1);
    const env = received[0] as MonitorEventEnvelope;
    expect(env.type).toBe("session-end");
  });

  it("emitMetricsUpdate delivers envelope via event bus", () => {
    const received: unknown[] = [];
    const unsub = subscribe("metrics-update", (d) => received.push(d));
    emitMetricsUpdate({ metrics: { latency: 42 } });
    unsub();
    expect(received).toHaveLength(1);
    const env = received[0] as MonitorEventEnvelope;
    expect(env.type).toBe("metrics-update");
    expect(env.source).toBe("otel");
  });

  it("emitAnnotationChange delivers envelope via event bus", () => {
    const received: unknown[] = [];
    const unsub = subscribe("annotation-change", (d) => received.push(d));
    emitAnnotationChange({
      targetId: "w1",
      targetType: "worker",
      key: "displayName",
      value: "My Worker",
    });
    unsub();
    expect(received).toHaveLength(1);
    const env = received[0] as MonitorEventEnvelope;
    expect(env.type).toBe("annotation-change");
    expect(env.source).toBe("api");
  });
});
