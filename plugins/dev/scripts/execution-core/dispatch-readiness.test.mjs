import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canOccupySlotNow,
  NOT_DISPATCHABLE_TRIAGE_PROBE_ERROR,
  NOT_DISPATCHABLE_UNTRIAGED,
  triageCapTripped,
  triageReservationDeadlocked,
} from "./dispatch-readiness.mjs";

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "cat36-readiness-"));
  mkdirSync(join(orchDir, "workers"), { recursive: true });
});
afterEach(() => rmSync(orchDir, { recursive: true, force: true }));

function seedTriage(ticket) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "triage.json"), JSON.stringify({ ticket }));
}

describe("canOccupySlotNow (CAT-36)", () => {
  test("a ticket with triage.json can occupy a slot", () => {
    seedTriage("CAT-1");
    expect(canOccupySlotNow(orchDir, "CAT-1")).toEqual({ ok: true, reason: null });
  });
  test("a ticket with no worker dir cannot occupy a slot", () => {
    expect(canOccupySlotNow(orchDir, "CAT-2")).toEqual({
      ok: false,
      reason: NOT_DISPATCHABLE_UNTRIAGED,
    });
  });
  test("a worker dir without triage.json cannot occupy a slot", () => {
    mkdirSync(join(orchDir, "workers", "CAT-3"));
    expect(canOccupySlotNow(orchDir, "CAT-3").ok).toBe(false);
  });
  test("honours the injected artifact probe", () => {
    expect(canOccupySlotNow(orchDir, "CAT-4", { hasTriageArtifact: () => true }).ok).toBe(true);
  });
  test("fails closed when the artifact probe throws", () => {
    const result = canOccupySlotNow(orchDir, "CAT-5", {
      hasTriageArtifact: () => {
        throw new Error("EACCES");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(NOT_DISPATCHABLE_TRIAGE_PROBE_ERROR);
    expect(result.error).toBeInstanceOf(Error);
  });
});

// ── CTL-2090: capped-reservation deadlock predicates ─────────────────────────

function seedCapRecord(ticket, rec) {
  const dir = join(orchDir, ".triage-dispatch-counts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ticket}.json`), typeof rec === "string" ? rec : JSON.stringify(rec));
}

describe("triageCapTripped (CTL-2090)", () => {
  test("no counter file → not capped", () => {
    expect(triageCapTripped(orchDir, "CAT-10")).toBe(false);
  });
  test("counter without cappedAt (attempts remaining) → not capped", () => {
    seedCapRecord("CAT-11", { count: 2, lastDispatchAt: "2026-08-19T05:01:03Z" });
    expect(triageCapTripped(orchDir, "CAT-11")).toBe(false);
  });
  test("cappedAt stamped → capped (the mini-2 CTC-750 record shape)", () => {
    seedCapRecord("CAT-12", {
      count: 3,
      lastDispatchAt: "2026-08-19T05:01:03Z",
      cappedAt: "2026-08-19T05:10:51Z",
      cap: 3,
    });
    expect(triageCapTripped(orchDir, "CAT-12")).toBe(true);
  });
  test("malformed counter file → not capped (fail-open, mirrors readTriageDispatchRecord)", () => {
    seedCapRecord("CAT-13", "garbage{");
    expect(triageCapTripped(orchDir, "CAT-13")).toBe(false);
  });
});

describe("triageReservationDeadlocked (CTL-2090)", () => {
  const capped = { count: 3, cappedAt: "2026-08-19T05:10:51Z", cap: 3 };

  test("capped AND artifact-less → deadlocked (the reservation can never be consumed)", () => {
    seedCapRecord("CAT-20", capped);
    expect(triageReservationDeadlocked(orchDir, "CAT-20")).toBe(true);
  });
  test("capped but the final attempt produced triage.json → NOT deadlocked (dispatchable)", () => {
    seedCapRecord("CAT-21", capped);
    seedTriage("CAT-21");
    expect(triageReservationDeadlocked(orchDir, "CAT-21")).toBe(false);
  });
  test("artifact-less but NOT capped → not deadlocked (the normal CAT-36 reservation)", () => {
    expect(triageReservationDeadlocked(orchDir, "CAT-22")).toBe(false);
  });
  test("artifact probe throws → not deadlocked (fail-open: an FS hiccup never changes admission)", () => {
    seedCapRecord("CAT-23", capped);
    expect(
      triageReservationDeadlocked(orchDir, "CAT-23", {
        hasTriageArtifact: () => {
          throw new Error("EACCES");
        },
      })
    ).toBe(false);
  });
  test("honours the injected artifact probe", () => {
    seedCapRecord("CAT-24", capped);
    expect(
      triageReservationDeadlocked(orchDir, "CAT-24", { hasTriageArtifact: () => true })
    ).toBe(false);
  });
});
