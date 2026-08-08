// in-flight-supersede.test.mjs — CTL-1660 P1 round 2 (Codex #3081).
//
// Pins the SUPERSESSION decision shared by isTicketInFlight and schedulerTick's
// terminal sweep: which of a ticket's phase signals still describe its CURRENT state,
// and which are stale predecessors left behind by an out-of-order re-dispatch.
//
// Two defects are covered:
//   1. Backward redispatch — an older `review: failed` behind a fresh `implement:
//      running` was NOT superseded (its ordinal is HIGHER, and the guard compared
//      ordinals directionally), so the stale failure vetoed and live rework was
//      dropped from the slot and advancement sweeps.
//   2. Terminal sweep — it scanned every RAW status, so a superseded failure still
//      routed the ticket to needs-human/orphan handling even as the advancement
//      sweep was correctly moving it forward. Both now share livePhaseEntries.
//
// CI-INCLUDED (registered in .github/workflows/execution-core-tests.yml). The
// scheduler.test.mjs real-timer suite is EXCLUDED from CI — its supersede coverage
// therefore never runs there — so the pure-helper coverage lives here, following the
// phantom-worker-dir.test.mjs / CTL-1290 board-health-seam pattern.
//
// Run: cd plugins/dev/scripts/execution-core && bun test in-flight-supersede.test.mjs

import { describe, test, expect } from "bun:test";
import { isTicketInFlight, livePhaseEntries, deriveAdvancement } from "./scheduler.mjs";

// Key order IS the fixture: readPhaseSignals inserts entries in ascending-mtime
// order, so "first key = oldest dispatch, last key = most recent dispatch".
const live = (signals) => livePhaseEntries(signals).map(([phase]) => phase);

describe("livePhaseEntries — supersession is decided by dispatch RECENCY, not ordinal direction", () => {
  test("forward flow: an earlier completed phase is superseded by the current one", () => {
    expect(live({ implement: "done", verify: "running" })).toEqual(["verify"]);
  });

  test("backward redispatch: a LATER-ordinal stale phase is superseded by the newer dispatch", () => {
    // The round-2 defect. review's ordinal is higher than implement's, so the old
    // `phaseIndex(phase) < latestIdx` test never skipped it.
    expect(live({ review: "failed", implement: "running" })).toEqual(["implement"]);
  });

  test("an unknown/non-pipeline phase neither supersedes nor is superseded", () => {
    // A recovery-pass inspection signal carries no ordering; isPhantomWorkerDir
    // owns that case separately.
    expect(live({ implement: "failed", "recovery-pass": "done" }).sort()).toEqual(
      ["implement", "recovery-pass"].sort()
    );
  });

  test("a phase sharing the latest dispatch's ORDINAL is not superseded", () => {
    // remediate ranks AT verify's index, so the verify⇄remediate cycle must not let
    // `remediate: done` erase the `verify: failed` that caused it.
    expect(live({ verify: "failed", remediate: "done" }).sort()).toEqual(
      ["remediate", "verify"].sort()
    );
  });

  test("no known phases → nothing is superseded", () => {
    expect(live({ "recovery-pass": "done" })).toEqual(["recovery-pass"]);
  });

  test("empty / nullish input is safe", () => {
    expect(livePhaseEntries({})).toEqual([]);
    expect(livePhaseEntries(null)).toEqual([]);
    expect(livePhaseEntries(undefined)).toEqual([]);
  });
});

describe("isTicketInFlight — superseded failures no longer veto, live ones still do", () => {
  test("backward redispatch still RUNNING → in flight (the dropped-rework defect)", () => {
    expect(isTicketInFlight({ review: "failed", implement: "running" })).toBe(true);
  });

  test("backward redispatch that itself FAILED → not in flight", () => {
    expect(isTicketInFlight({ review: "done", implement: "failed" })).toBe(false);
  });

  test("stale predecessor behind a completed later phase → in flight", () => {
    expect(isTicketInFlight({ implement: "failed", verify: "done" })).toBe(true);
  });

  test("a failed verify is NOT released by a same-ordinal remediate", () => {
    expect(isTicketInFlight({ verify: "failed", remediate: "done" })).toBe(false);
  });

  test("the CURRENT phase failing still vetoes", () => {
    expect(isTicketInFlight({ research: "done", implement: "done", verify: "failed" })).toBe(false);
  });

  test("terminal phase done → not in flight even behind a stale failure", () => {
    expect(isTicketInFlight({ implement: "failed", teardown: "done" })).toBe(false);
  });

  test("no signals at all → not in flight", () => {
    expect(isTicketInFlight({})).toBe(false);
  });
});

describe("terminal-sweep parity — the sweep's failure scan uses the same decision", () => {
  // schedulerTick's terminal sweep derives anyStalled/anyFailed from
  // livePhaseEntries(signals) rather than Object.values(signals). These assertions
  // pin the exact inputs that used to produce an erroneous escalation.
  const sweepWouldEscalate = (signals) => {
    const statuses = livePhaseEntries(signals).map(([, s]) => s);
    return statuses.some((s) => s === "stalled" || s === "failed");
  };

  test("superseded failure behind a completed later phase → no escalation", () => {
    expect(sweepWouldEscalate({ implement: "failed", verify: "done" })).toBe(false);
  });

  test("superseded failure behind a fresh backward redispatch → no escalation", () => {
    expect(sweepWouldEscalate({ review: "failed", implement: "running" })).toBe(false);
  });

  test("a LIVE failure on the current phase → still escalates", () => {
    expect(sweepWouldEscalate({ implement: "done", verify: "failed" })).toBe(true);
  });

  test("a LIVE stall on the current phase → still escalates", () => {
    expect(sweepWouldEscalate({ implement: "done", verify: "stalled" })).toBe(true);
  });

  test("a same-ordinal remediate does not mask a failed verify → still escalates", () => {
    expect(sweepWouldEscalate({ verify: "failed", remediate: "done" })).toBe(true);
  });
});

describe("deriveAdvancement — consumes the SAME supersession decision", () => {
  // CTL-1660 P1 round 3 (Codex #3081): once livePhaseEntries admits a
  // backward-redispatched ticket to the advancement sweep, deriveAdvancement's raw
  // ordinal scan became reachable — and would select the stale higher-ordinal phase.
  test("stale `review: done` behind a running redispatched implement does NOT advance to pr", () => {
    // The regression: ordinal scan picked `review` (done) and returned "pr",
    // dispatching the PR phase while implement was still running — skipping
    // verify and review for the replacement work.
    expect(deriveAdvancement({ review: "done", implement: "running" })).toBe(null);
  });

  test("stale `review: done` behind a FAILED redispatched implement does not advance", () => {
    expect(deriveAdvancement({ review: "done", implement: "failed" })).toBe(null);
  });

  test("normal forward advancement is unchanged", () => {
    expect(deriveAdvancement({ triage: "done" })).toBe("research");
    expect(deriveAdvancement({ triage: "done", research: "done" })).toBe("plan");
  });

  test("a still-running current phase never advances", () => {
    expect(deriveAdvancement({ implement: "done", verify: "running" })).toBe(null);
  });

  test("an already-dispatched successor still blocks advancement (conservative guard)", () => {
    expect(deriveAdvancement({ triage: "done", research: "running" })).toBe(null);
  });
});

describe("deriveAdvancement — a superseded successor must not wedge the pipeline", () => {
  // CTL-1660 P1 round 4 (Codex #3081): the round-3 guard consulted the RAW signal map,
  // so after a backward redispatch COMPLETED, the previous pass's successor signal
  // blocked the new one forever — in flight, never re-verified, never escalated.
  test("completed backward redispatch re-dispatches verify despite a stale verify signal", () => {
    // mtime order: verify and review are the OLD pass; implement is the new one.
    expect(deriveAdvancement({ verify: "done", review: "done", implement: "done" })).toBe("verify");
  });

  test("a CURRENT successor still vetoes (no double dispatch)", () => {
    expect(deriveAdvancement({ implement: "done", verify: "running" })).toBe(null);
    expect(deriveAdvancement({ triage: "done", research: "dispatched" })).toBe(null);
  });

  test("normal forward advancement is still unchanged", () => {
    expect(deriveAdvancement({ triage: "done" })).toBe("research");
    expect(deriveAdvancement({ triage: "done", research: "done" })).toBe("plan");
  });
});
