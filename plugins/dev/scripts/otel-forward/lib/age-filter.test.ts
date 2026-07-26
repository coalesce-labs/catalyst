import { describe, test, expect } from "bun:test";
import { partitionByAge } from "./age-filter.ts";
import type { CanonicalEvent } from "../../orch-monitor/lib/canonical-event.ts";

function makeEvent(tsIso: string): CanonicalEvent {
  return {
    ts: tsIso,
    id: "00000000-0000-4000-8000-000000000000",
    traceId: null,
    spanId: null,
    severityText: "INFO",
    severityNumber: 9,
    resource: {
      "service.name": "test",
      "service.namespace": "catalyst" as const,
      "service.version": "1.0.0",
      "host.name": "test",
      "host.id": "test-id",
    },
    attributes: { "event.name": "test.event" },
    body: { message: "test", payload: null },
  };
}

describe("partitionByAge", () => {
  const NOW = 1_700_000_000_000; // fixed epoch for deterministic tests
  const WINDOW_MS = 3_600_000;   // 1 hour

  test("all-fresh batch → { fresh: all, aged: [] }", () => {
    const events = [
      makeEvent(new Date(NOW - 100).toISOString()),
      makeEvent(new Date(NOW - 200).toISOString()),
    ];
    const { fresh, aged } = partitionByAge(events, NOW, WINDOW_MS);
    expect(fresh.length).toBe(2);
    expect(aged.length).toBe(0);
  });

  test("all-aged batch → { fresh: [], aged: all }", () => {
    const events = [
      makeEvent(new Date(NOW - WINDOW_MS - 1).toISOString()),
      makeEvent(new Date(NOW - WINDOW_MS - 2000).toISOString()),
    ];
    const { fresh, aged } = partitionByAge(events, NOW, WINDOW_MS);
    expect(fresh.length).toBe(0);
    expect(aged.length).toBe(2);
  });

  test("mixed batch → correct split, order preserved", () => {
    const e1 = makeEvent(new Date(NOW - 100).toISOString());        // fresh
    const e2 = makeEvent(new Date(NOW - WINDOW_MS - 1).toISOString()); // aged
    const e3 = makeEvent(new Date(NOW - 200).toISOString());        // fresh
    const { fresh, aged } = partitionByAge([e1, e2, e3], NOW, WINDOW_MS);
    expect(fresh).toEqual([e1, e3]);
    expect(aged).toEqual([e2]);
  });

  test("boundary: record exactly at now - windowMs is fresh (strict < for aged)", () => {
    const boundary = makeEvent(new Date(NOW - WINDOW_MS).toISOString());
    const { fresh, aged } = partitionByAge([boundary], NOW, WINDOW_MS);
    expect(fresh.length).toBe(1);
    expect(aged.length).toBe(0);
  });

  test("empty batch → { fresh: [], aged: [] }", () => {
    const { fresh, aged } = partitionByAge([], NOW, WINDOW_MS);
    expect(fresh.length).toBe(0);
    expect(aged.length).toBe(0);
  });

  test("unparseable ts → treated as fresh (fail-open)", () => {
    const bad = makeEvent("not-a-date");
    const { fresh, aged } = partitionByAge([bad], NOW, WINDOW_MS);
    expect(fresh.length).toBe(1);
    expect(aged.length).toBe(0);
  });
});
