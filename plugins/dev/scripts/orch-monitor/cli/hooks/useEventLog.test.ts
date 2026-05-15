// useEventLog.test.ts — mirrors the since-filter predicate logic inline.
//
// useEventLog mixes React hook machinery with filesystem I/O, so we can't
// invoke the hook directly in bun:test. Instead we mirror the exact filter
// predicate here and keep it adjacent to the source so drift is obvious.

import { describe, test, expect } from "bun:test";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";

function makeSinceFilter(sinceTs: string) {
  const sinceMs = new Date(sinceTs).getTime();
  return (e: CanonicalEvent) => new Date(e.ts).getTime() >= sinceMs;
}

function makeEvent(ts: string): CanonicalEvent {
  return {
    ts,
    body: { payload: {} },
    attributes: { "event.name": "test" },
  } as unknown as CanonicalEvent;
}

// Base sinceTs in Z format (no sub-second component so +00:00 form can match exactly)
const SINCE_Z = "2026-05-14T22:38:28.000Z";
// Same instant in +00:00 format — string comparison wrongly treats this as less than SINCE_Z
const SINCE_OFFSET = "2026-05-14T22:38:28+00:00";
const AFTER_Z = "2026-05-14T22:38:29.000Z";
const AFTER_OFFSET = "2026-05-14T22:38:29+00:00";
const BEFORE_Z = "2026-05-14T22:38:27.000Z";
const BEFORE_OFFSET = "2026-05-14T22:38:00+00:00";

describe("since-filter date comparison", () => {
  test("keeps Z-format events at or after sinceTs", () => {
    const f = makeSinceFilter(SINCE_Z);
    expect(f(makeEvent(SINCE_Z))).toBe(true);
    expect(f(makeEvent(AFTER_Z))).toBe(true);
    expect(f(makeEvent(BEFORE_Z))).toBe(false);
  });

  test("keeps +00:00 events at or after sinceTs", () => {
    const f = makeSinceFilter(SINCE_Z);
    expect(f(makeEvent(SINCE_OFFSET))).toBe(true);
    expect(f(makeEvent(AFTER_OFFSET))).toBe(true);
    expect(f(makeEvent(BEFORE_OFFSET))).toBe(false);
  });

  test("+00:00 event equal to sinceTs moment is NOT dropped (was the string-comparison bug)", () => {
    // String comparison: "2026-05-14T22:38:28+00:00" < "2026-05-14T22:38:28.000Z" → drops it
    // Date comparison: same instant → keeps it
    const f = makeSinceFilter(SINCE_Z);
    expect(f(makeEvent(SINCE_OFFSET))).toBe(true);
  });

  test("sinceTs in +00:00 format: Z events after the cutoff are kept", () => {
    const f = makeSinceFilter(SINCE_OFFSET);
    expect(f(makeEvent(AFTER_Z))).toBe(true);
    expect(f(makeEvent(BEFORE_Z))).toBe(false);
  });
});
