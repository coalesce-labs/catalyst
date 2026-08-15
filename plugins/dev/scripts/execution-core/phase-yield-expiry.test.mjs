// phase-yield-expiry.test.mjs — CTL-1854 round 1: where a yield actually expires.
//
// Run: cd plugins/dev/scripts/execution-core && bun test phase-yield-expiry.test.mjs
//
// ── WHY THIS FILE EXISTS (Codex #3383, 2× P1) ───────────────────────────────
// The first cut of CTL-1854 evaluated a yield in exactly one place: the runner's
// undeclared-exit flip, which runs as the worker exits — MICROSECONDS after
// `yieldedAt` was written. At that instant a yield is always live, so the check
// always returned "leave it alone" and nothing ever looked again. The 30-minute
// ceiling and `--yield-seconds` were therefore a bound whose only enforcement
// point could not fire, and an `awaiting-work` signal held its slot forever
// (isTicketInFlight frees a slot only for failed|stalled|aborted).
//
// That is the same defect class the ticket exists to remove, rebuilt inside its
// own fix: a check that cannot fail. These tests pin the real evaluator —
// reclaimDeadWorkIfPossible, which schedulerTick calls once per signal per tick.

import { describe, expect, test } from "bun:test";
import { reclaimDeadWorkIfPossible, defaultExpireYield } from "./recovery.mjs";
import { YIELDED_STATUS, MAX_YIELD_MS, YIELD_EXPIRED_REASON } from "../lib/phase-yield.mjs";

const T0 = Date.parse("2026-08-15T04:00:00Z");
const sig = (over = {}, raw = {}) => ({
  ticket: "PROJ-1",
  phase: "implement",
  status: YIELDED_STATUS,
  // No `liveness` — an SDK-path signal has no bg_job_id, so classifyWorker
  // returns "unknown". That is exactly the shape whose short-circuit used to
  // return "noop" before any yield logic ran.
  raw: { yieldedAt: new Date(T0).toISOString(), ...raw },
  ...over,
});

// Capture-only expiry seam so these tests touch no filesystem.
function withCapture(overrides = {}) {
  const calls = [];
  return {
    calls,
    opts: {
      expireYield: (orchDir, signal, verdict) => {
        calls.push({ orchDir, ticket: signal?.ticket, reason: verdict?.reason });
        return true;
      },
      ...overrides,
    },
  };
}

describe("⚠️ the deadline is enforced somewhere that can actually observe it", () => {
  test("an EXPIRED yield writes a terminal — even with no bg_job_id", () => {
    // The regression that shipped: classifyWorker returns "unknown" for this
    // signal, and the unknown short-circuit returned "noop" before status was
    // ever consulted. If the yield check sits below that line, this test fails
    // and the ticket is stranded forever.
    const { calls, opts } = withCapture();
    reclaimDeadWorkIfPossible("/orch", sig(), { ...opts, now: () => T0 + MAX_YIELD_MS + 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ticket: "PROJ-1", reason: "deadline-passed" });
  });

  test("a LIVE yield is honored — never reclaimed, never escalated", () => {
    // The mirror-image P1: with the default `claude --bg` executor the worker is
    // dead-terminal the moment it writes this status, so without the exemption
    // the next tick reclaims or revives it and cuts the declared wait short.
    const { calls, opts } = withCapture();
    const out = reclaimDeadWorkIfPossible("/orch", sig(), { ...opts, now: () => T0 + 60_000 });
    expect(out).toBe("noop");
    expect(calls).toHaveLength(0);
  });

  test("a short --yield-seconds expires on ITS deadline, not the ceiling", () => {
    const { calls, opts } = withCapture();
    const s = sig({}, { yieldMs: 5 * 60_000 });
    reclaimDeadWorkIfPossible("/orch", s, { ...opts, now: () => T0 + 4 * 60_000 });
    expect(calls).toHaveLength(0); // still inside the requested window
    reclaimDeadWorkIfPossible("/orch", s, { ...opts, now: () => T0 + 6 * 60_000 });
    expect(calls).toHaveLength(1); // past it
  });

  test("an unreadable yield start expires rather than holding the slot", () => {
    const { calls, opts } = withCapture();
    reclaimDeadWorkIfPossible("/orch", sig({}, { yieldedAt: "not-a-date" }), {
      ...opts,
      now: () => T0,
    });
    expect(calls).toHaveLength(1);
  });

  test("non-yield signals do not enter this branch at all", () => {
    // Additivity: if the state is not declared, behaviour is exactly as before.
    for (const status of ["running", "dispatched", "needs-input", "failed", "done"]) {
      const { calls, opts } = withCapture();
      reclaimDeadWorkIfPossible("/orch", sig({ status }), { ...opts, now: () => T0 });
      expect({ status, expired: calls.length }).toEqual({ status, expired: 0 });
    }
  });
});

describe("the expiry write itself", () => {
  const diskSig = (status = YIELDED_STATUS) => ({
    status,
    ticket: "PROJ-1",
    phase: "implement",
    generation: 3,
    catalystSessionId: "sess-abc",
  });

  test("writes the SAME terminal the runner writes, with its own reason", () => {
    let written = null;
    const ok = defaultExpireYield(
      "/orch",
      { ticket: "PROJ-1", phase: "implement" },
      { reason: "deadline-passed" },
      { readFile: () => JSON.stringify(diskSig()), writeFile: (_p, s) => { written = JSON.parse(s); } }
    );
    expect(ok).toBe(true);
    // `failed` (not a novel token) so all 29 existing status sets handle it, and
    // NOT `stalled` — stalled routes to needs-human and would page an operator
    // for every expired yield, making this strictly worse than the abandonment
    // it replaces.
    expect(written).toMatchObject({
      status: "failed",
      outcome: "abandoned",
      failureReason: YIELD_EXPIRED_REASON,
      assertedBy: "recovery-reclaim",
    });
    expect(written.status).not.toBe("stalled");
    // Untouched fields survive.
    expect(written).toMatchObject({ generation: 3, catalystSessionId: "sess-abc" });
  });

  test("⚠️ refuses to overwrite a signal that is no longer yielded", () => {
    // A late completion can land between the tick's read and this write.
    // Clobbering it would destroy a real result and re-manufacture the exact
    // abandonment this ticket exists to remove.
    for (const status of ["done", "failed", "needs-input", "running"]) {
      let written = null;
      const ok = defaultExpireYield(
        "/orch",
        { ticket: "PROJ-1", phase: "implement" },
        { reason: "deadline-passed" },
        { readFile: () => JSON.stringify(diskSig(status)), writeFile: (_p, s) => { written = s; } }
      );
      expect({ status, ok, wrote: written !== null }).toEqual({ status, ok: false, wrote: false });
    }
  });

  test("an unreadable or unwritable signal is a no-op, never a throw", () => {
    const boom = () => { throw new Error("EIO"); };
    expect(defaultExpireYield("/o", { ticket: "T", phase: "p" }, {}, { readFile: boom })).toBe(false);
    expect(
      defaultExpireYield("/o", { ticket: "T", phase: "p" }, {}, {
        readFile: () => JSON.stringify(diskSig()),
        writeFile: boom,
      })
    ).toBe(false);
  });
});
