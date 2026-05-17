// event-list-keys.test.ts — locks in the key contract for EventList rows.
// Adjacent to EventList.tsx so drift between the keying logic and this test
// is obvious. Covers the post-CTL-473 contract:
//   key = event.id when present
//   key = synthesizeEventId(event) when event.id is null/undefined
// Matches the broker's canonical fallback pattern at broker/index.mjs:162.

import { describe, test, expect } from "bun:test";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import { synthesizeEventId } from "../../lib/canonical-event-shared.ts";
import { eventRowKey } from "./EventList.tsx";

function makeEvent(over: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    traceId: "trace-1",
    spanId: "span-1",
    ts: "2026-05-17T12:00:00.000Z",
    attributes: { "event.name": "test.event" },
    body: { payload: {} },
    ...over,
  } as unknown as CanonicalEvent;
}

describe("EventList row key (CTL-473)", () => {
  test("uses event.id when present (UUIDv4)", () => {
    const e = makeEvent({ id: "00000000-0000-4000-8000-000000000001" });
    expect(eventRowKey(e)).toBe("00000000-0000-4000-8000-000000000001");
  });

  test("falls back to synthesizeEventId when id is null (legacy record)", () => {
    const e = makeEvent({ id: null as unknown as string });
    expect(eventRowKey(e)).toBe(synthesizeEventId(e));
  });

  test("falls back when id is undefined", () => {
    const e = makeEvent();
    delete (e as { id?: string }).id;
    expect(eventRowKey(e)).toBe(synthesizeEventId(e));
  });

  test("two legacy events with different ts but same traceId/spanId/name produce distinct keys", () => {
    const a = makeEvent({ id: null as unknown as string, ts: "2026-05-17T12:00:00.000Z" });
    const b = makeEvent({ id: null as unknown as string, ts: "2026-05-17T12:00:01.000Z" });
    expect(eventRowKey(a)).not.toBe(eventRowKey(b));
  });

  test("two legacy events with identical traceId/spanId/ts/name produce the same key (deterministic)", () => {
    const a = makeEvent({ id: null as unknown as string });
    const b = makeEvent({ id: null as unknown as string });
    expect(eventRowKey(a)).toBe(eventRowKey(b));
  });

  test("the key does not include scrollOffset or row index (stable across scrolls)", () => {
    // Direct semantic check: eventRowKey takes only an event — no positional args.
    // Function arity reflects this; the test asserts the contract via signature.
    expect(eventRowKey.length).toBe(1);
  });
});
