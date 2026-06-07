import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../lib/canonical-event.ts";
import { buildDetailLines } from "../cli/components/DetailPane.tsx";

// CTL-350 Phase 5: event-id field above trace/span, plus source_events
// promoted from raw JSON dump to labeled rows including the lookup_jq query.

const makeEvent = (overrides: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  ts: "2026-05-12T21:08:40.000Z",
  id: "11111111-2222-4333-8444-555555555555",
  severityText: "INFO",
  severityNumber: 9,
  traceId: "abc123def456abc123def456abc123de",
  spanId: "abc123de456abc12",
  resource: {
    "service.name": "catalyst.broker",
    "service.namespace": "catalyst",
    "service.version": "0.0.0",
    "host.name": "test-host",
    "host.id": "0000000000000000",
  },
  attributes: { "event.name": "filter.wake.orch-x" },
  body: { message: "" },
  ...overrides,
});

describe("DetailPane event-id field (CTL-350)", () => {
  test("shows event-id field when event has id", () => {
    const lines = buildDetailLines(makeEvent(), 120);
    const idField = lines.find(
      (l) => l.k === "field" && l.label === "event-id",
    );
    expect(idField).toBeDefined();
    if (idField?.k === "field") {
      expect(idField.value).toBe("11111111-2222-4333-8444-555555555555");
    }
  });

  test("event-id appears above trace and span", () => {
    const lines = buildDetailLines(makeEvent(), 120);
    const idx = (label: string) =>
      lines.findIndex((l) => l.k === "field" && l.label === label);
    const idIdx = idx("event-id");
    const traceIdx = idx("trace");
    const spanIdx = idx("span");
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(traceIdx).toBeGreaterThan(idIdx);
    expect(spanIdx).toBeGreaterThan(idIdx);
  });

  test("event-id is omitted when id is empty string", () => {
    const evt = makeEvent();
    evt.id = "";
    const lines = buildDetailLines(evt, 120);
    const idField = lines.find(
      (l) => l.k === "field" && l.label === "event-id",
    );
    expect(idField).toBeUndefined();
  });
});

describe("DetailPane source_events promotion (CTL-350)", () => {
  test("promotes single source_event to labeled rows", () => {
    const evt = makeEvent({
      body: {
        payload: {
          reason: "ticket changed",
          source_event_ids: ["uuid-1"],
          source_events: [{
            id: "uuid-1",
            name: "linear.issue.state_changed",
            ticket: "ADV-87",
            lookup_jq: "jq 'select(.id == \"uuid-1\")' ~/catalyst/events/2026-05.jsonl",
            payload_excerpt: { state: "Done" },
          }],
        },
      },
    });
    const lines = buildDetailLines(evt, 120);
    const labels = lines
      .filter((l) => l.k === "field")
      .map((l) => (l.k === "field" ? l.label : ""));
    expect(labels).toContain("source name");
    expect(labels).toContain("source ticket");
    expect(labels).toContain("source id");
    expect(labels).toContain("lookup");
  });

  test("source_events with PR field renders source pr row", () => {
    const evt = makeEvent({
      body: {
        payload: {
          source_events: [{
            id: "uuid-2",
            name: "github.pr.merged",
            pr: 87,
            lookup_jq: "jq ...",
          }],
        },
      },
    });
    const lines = buildDetailLines(evt, 120);
    const prField = lines.find(
      (l) => l.k === "field" && l.label === "source pr",
    );
    expect(prField).toBeDefined();
    if (prField?.k === "field") expect(prField.value).toBe("#87");
  });

  test("multiple source_events get indexed labels", () => {
    const evt = makeEvent({
      body: {
        payload: {
          source_events: [
            { id: "uuid-1", name: "linear.issue.state_changed", ticket: "ADV-1" },
            { id: "uuid-2", name: "linear.issue.state_changed", ticket: "ADV-2" },
          ],
        },
      },
    });
    const lines = buildDetailLines(evt, 120);
    const labels = lines
      .filter((l) => l.k === "field")
      .map((l) => (l.k === "field" ? l.label : ""));
    expect(labels).toContain("source name [1]");
    expect(labels).toContain("source name [2]");
  });

  test("does nothing when source_events is absent", () => {
    const evt = makeEvent({
      body: { payload: { reason: "x", source_event_ids: ["a"] } },
    });
    const lines = buildDetailLines(evt, 120);
    const sourceField = lines.find(
      (l) => l.k === "field" && typeof l.label === "string" && l.label.startsWith("source "),
    );
    expect(sourceField).toBeUndefined();
  });
});
