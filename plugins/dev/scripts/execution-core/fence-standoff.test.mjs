import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordDurableEscalation } from "./durable-escalation.mjs";
import {
  recordFenceSuppression, readFenceStandoff, clearFenceStandoff,
  evaluateStandoff, markBreakGlass, buildFenceStandoffEvent,
  maybeBreakGlass,
  FENCE_STANDOFF_EVENT, FENCE_STANDOFF_CAP_DEFAULT, FENCE_STANDOFF_MIN_AGE_MS_DEFAULT,
  FENCE_STANDOFF_DELIVERY_RETRY_MAX_DEFAULT,
} from "./fence-standoff.mjs";

describe("fence-standoff ledger (CAT-173)", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fs-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("first suppression seeds count:1 and anchors firstSuppressedAt", () => {
    const r = recordFenceSuppression({ orchDir: dir, ticket: "CAT-53", site: "terminal-sweep", reason: "superseded", now: 1000 });
    expect(r.count).toBe(1);
    expect(r.firstSuppressedAt).toBe(1000);
    expect(r.lastSuppressedAt).toBe(1000);
  });

  test("repeat suppressions increment count and PRESERVE firstSuppressedAt (the age anchor)", () => {
    recordFenceSuppression({ orchDir: dir, ticket: "CAT-53", site: "terminal-sweep", reason: "superseded", now: 1000 });
    const r = recordFenceSuppression({ orchDir: dir, ticket: "CAT-53", site: "terminal-sweep", reason: "unverifiable", now: 5000 });
    expect(r.count).toBe(2);
    expect(r.firstSuppressedAt).toBe(1000);
    expect(r.lastSuppressedAt).toBe(5000);
    expect(r.reason).toBe("unverifiable");
  });

  test("clearFenceStandoff is idempotent and safe on an absent record", () => {
    clearFenceStandoff(dir, "NOPE");
    recordFenceSuppression({ orchDir: dir, ticket: "CAT-53", site: "s", reason: "superseded", now: 1 });
    clearFenceStandoff(dir, "CAT-53");
    clearFenceStandoff(dir, "CAT-53");
    expect(readFenceStandoff(dir, "CAT-53")).toBeNull();
  });

  test("a malformed record file degrades to null, never throws", () => {
    mkdirSync(join(dir, ".fence-standoff"), { recursive: true });
    writeFileSync(join(dir, ".fence-standoff", "CAT-53.json"), "{not json");
    expect(readFenceStandoff(dir, "CAT-53")).toBeNull();
    expect(recordFenceSuppression({ orchDir: dir, ticket: "CAT-53", site: "s", reason: "superseded", now: 9 }).count).toBe(1);
  });

  test("an unwritable orchDir fails open — returns a synthetic record, never throws", () => {
    const r = recordFenceSuppression({ orchDir: "/proc/nonexistent-cat173", ticket: "CAT-53", site: "s", reason: "superseded", now: 3 });
    expect(r.count).toBe(1);
    expect(r.ticket).toBe("CAT-53");
  });

  test("ticket identifiers cannot escape the ledger directory", () => {
    recordFenceSuppression({ orchDir: dir, ticket: "../../escaped", site: "s", reason: "superseded", now: 3 });
    clearFenceStandoff(dir, "../../escaped");
    expect(existsSync(join(dir, "..", "..", "escaped.json"))).toBe(false);
  });

  test("markBreakGlass preserves the first break-glass timestamp", () => {
    recordFenceSuppression({ orchDir: dir, ticket: "CAT-53", site: "s", reason: "superseded", now: 1 });
    expect(markBreakGlass({ orchDir: dir, ticket: "CAT-53", now: 9 }).breakGlassAt).toBe(9);
    expect(markBreakGlass({ orchDir: dir, ticket: "CAT-53", now: 12 }).breakGlassAt).toBe(9);
  });
});

describe("evaluateStandoff — pure break-glass predicate (CAT-173)", () => {
  const rec = (count, firstSuppressedAt, breakGlassAt = null) => ({ ticket: "CAT-53", count, firstSuppressedAt, breakGlassAt });
  const opts = { cap: 4, minAgeMs: 45 * 60_000 };

  test("count reached but episode TOO YOUNG → no break-glass (a fast tick loop cannot trip it)", () => {
    expect(evaluateStandoff(rec(9, 0), { now: 60_000, ...opts }).breakGlass).toBe(false);
  });
  test("old enough but UNDER the cap → no break-glass (one blip is not a standoff)", () => {
    expect(evaluateStandoff(rec(2, 0), { now: 3 * 60 * 60_000, ...opts }).breakGlass).toBe(false);
  });
  test("cap AND age both satisfied → break-glass, flagged as the FIRST for this episode", () => {
    expect(evaluateStandoff(rec(4, 0), { now: 46 * 60_000, ...opts })).toEqual({ breakGlass: true, firstBreakGlass: true, ageMs: 46 * 60_000 });
  });
  test("already broken glass this episode → still breakGlass, but firstBreakGlass:false (fires ONCE)", () => {
    const v = evaluateStandoff(rec(50, 0, 46 * 60_000), { now: 99 * 60_000, ...opts });
    expect(v.breakGlass).toBe(true);
    expect(v.firstBreakGlass).toBe(false);
  });
  test("a null/garbage record is not a standoff", () => {
    expect(evaluateStandoff(null, { now: 1e12, ...opts }).breakGlass).toBe(false);
    expect(evaluateStandoff({}, { now: 1e12, ...opts }).breakGlass).toBe(false);
  });
  test("defaults are the documented bound: cap 4, min age 45m (3x the 15m fence cooldown)", () => {
    expect(FENCE_STANDOFF_CAP_DEFAULT).toBe(4);
    expect(FENCE_STANDOFF_MIN_AGE_MS_DEFAULT).toBe(45 * 60_000);
  });
});

describe("buildFenceStandoffEvent (CAT-173)", () => {
  test("event name is the per-ticket canonical form", () => {
    const ev = JSON.parse(buildFenceStandoffEvent({ ticket: "CAT-53", site: "terminal-sweep", reason: "superseded", count: 4, ageMs: 2_700_000 }, { now: () => new Date("2026-08-11T00:00:00Z") }));
    expect(ev.attributes["event.name"]).toBe("escalation.fence-standoff.CAT-53");
    expect(ev.body.payload).toMatchObject({ ticket: "CAT-53", site: "terminal-sweep", reason: "superseded", count: 4 });
  });
  test("FENCE_STANDOFF_EVENT is the registrable prefix form", () => {
    expect(FENCE_STANDOFF_EVENT).toBe("escalation.fence-standoff.CTL-1");
  });
});

test("maybeBreakGlass emits and records exactly once after the bound", () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-break-"));
  const events = [];
  const escalations = [];
  try {
    const opts = {
      orchDir: dir,
      ticket: "CAT-53",
      site: "terminal-sweep",
      verdict: { reason: "superseded" },
      env: { CATALYST_FENCE_STANDOFF_CAP: "2", CATALYST_FENCE_STANDOFF_MIN_AGE_MS: "1" },
      appendEvent: (event) => { events.push(event); return true; },
      recordEscalation: (record) => { escalations.push(record); return recordDurableEscalation(record); },
      logger: { warn() {} },
    };
    maybeBreakGlass({ ...opts, now: 1 });
    maybeBreakGlass({ ...opts, now: 2 });
    maybeBreakGlass({ ...opts, now: 3 });
    expect(events).toHaveLength(1);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ labelConfirmed: false, source: "fence-standoff" });
    expect(escalations[0].now).toBe("1970-01-01T00:00:00.002Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maybeBreakGlass retries delivery before latching the episode", () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-retry-"));
  let eventAttempts = 0;
  try {
    const opts = {
      orchDir: dir,
      ticket: "CAT-53",
      site: "terminal-sweep",
      verdict: { reason: "superseded" },
      env: { CATALYST_FENCE_STANDOFF_CAP: "1", CATALYST_FENCE_STANDOFF_MIN_AGE_MS: "1" },
      appendEvent: () => { eventAttempts += 1; return eventAttempts > 1; },
      logger: { warn() {} },
    };
    recordFenceSuppression({ orchDir: dir, ticket: "CAT-53", site: "terminal-sweep", reason: "superseded", now: 0 });
    expect(maybeBreakGlass({ ...opts, now: 1 }).deliveryPending).toBe(true);
    expect(readFenceStandoff(dir, "CAT-53").breakGlassAt).toBeNull();
    expect(maybeBreakGlass({ ...opts, now: 2 }).deliveryPending).toBeUndefined();
    expect(readFenceStandoff(dir, "CAT-53").breakGlassAt).toBe(2);
    expect(eventAttempts).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// CAT-173 review: the retry above lets the caller drop its own suppression cooldown
// to re-try next tick. A PERSISTENTLY failing sink must stop earning that bypass, or
// the caller's per-tick probe runs forever (the CTL-1329 quota burn).
test("maybeBreakGlass stops reporting a persistently failing delivery as retryable", () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-retry-bound-"));
  try {
    const opts = {
      orchDir: dir,
      ticket: "CAT-53",
      site: "terminal-sweep",
      verdict: { reason: "superseded" },
      env: {
        CATALYST_FENCE_STANDOFF_CAP: "1",
        CATALYST_FENCE_STANDOFF_MIN_AGE_MS: "1",
        CATALYST_FENCE_STANDOFF_DELIVERY_RETRY_MAX: "3",
      },
      appendEvent: () => false, // never succeeds
      logger: { warn() {} },
    };
    recordFenceSuppression({ orchDir: dir, ticket: "CAT-53", site: "terminal-sweep", reason: "superseded", now: 0 });
    const verdicts = [1, 2, 3, 4, 5].map((now) => maybeBreakGlass({ ...opts, now }));
    expect(verdicts.map((v) => v.deliveryPending)).toEqual([true, true, true, true, true]);
    expect(verdicts.map((v) => v.deliveryAttempts)).toEqual([1, 2, 3, 4, 5]);
    expect(verdicts.map((v) => v.deliveryRetryable)).toEqual([true, true, true, false, false]);
    // The episode is still unlatched, so delivery keeps being ATTEMPTED — only the
    // caller's cooldown bypass is withdrawn.
    expect(readFenceStandoff(dir, "CAT-53").breakGlassAt).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the delivery-retry bound defaults to 5 and survives across suppression ticks", () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-retry-default-"));
  try {
    expect(FENCE_STANDOFF_DELIVERY_RETRY_MAX_DEFAULT).toBe(5);
    const opts = {
      orchDir: dir,
      ticket: "CAT-53",
      site: "terminal-sweep",
      verdict: { reason: "superseded" },
      env: { CATALYST_FENCE_STANDOFF_CAP: "1", CATALYST_FENCE_STANDOFF_MIN_AGE_MS: "1" },
      appendEvent: () => false,
      logger: { warn() {} },
    };
    recordFenceSuppression({ orchDir: dir, ticket: "CAT-53", site: "terminal-sweep", reason: "superseded", now: 0 });
    for (let i = 1; i <= 5; i++) expect(maybeBreakGlass({ ...opts, now: i }).deliveryRetryable).toBe(true);
    expect(maybeBreakGlass({ ...opts, now: 6 }).deliveryRetryable).toBe(false);
    // Ending the episode resets the counter — a later recurrence retries promptly again.
    clearFenceStandoff(dir, "CAT-53");
    recordFenceSuppression({ orchDir: dir, ticket: "CAT-53", site: "terminal-sweep", reason: "superseded", now: 100 });
    expect(maybeBreakGlass({ ...opts, now: 101 }).deliveryRetryable).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
