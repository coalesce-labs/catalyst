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
      { readFile: () => JSON.stringify(diskSig()), writeFile: (_p, s) => { written = JSON.parse(s); }, rename: () => {}, rm: () => {} }
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
        { readFile: () => JSON.stringify(diskSig(status)), writeFile: (_p, s) => { written = s; }, rename: () => {}, rm: () => {} }
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
        rename: () => {},
        rm: () => {},
      })
    ).toBe(false);
  });
});

// ── CTL-1854 round 4: the two sweeps that must NOT touch a yielded signal ─────
// Both findings are the same shape — a sweep that keys on "non-terminal" and so
// adopts a status invented after it was written. Neither is hypothetical: one
// strands the ticket permanently, the other pages a human on a daemon bounce.
describe("⚠️ sweeps that must leave a yield alone", () => {
  test("preemption never selects awaiting-work as a victim", async () => {
    // A yielded worker has already exited and has no bg_job_id, so killBgJob
    // frees NO capacity — but the sweep would rewrite the signal to `preempted`,
    // and the reclaim sweep explicitly skips PREEMPTED_STATUS, which disables
    // yield expiry forever while the real slot-holder survives.
    const src = await Bun.file(new URL("./scheduler.mjs", import.meta.url)).text();
    const reduce = src.slice(src.indexOf("const activePhase = Object.entries(signals).reduce"));
    const body = reduce.slice(0, reduce.indexOf("}, null);"));
    expect(body).toContain("YIELDED_STATUS");
    // Fails closed: if the reduce is refactored away, the slice above is empty
    // and this assertion cannot pass vacuously.
    expect(body.length).toBeGreaterThan(80);
  });

  test("boot-resume skips awaiting-work instead of opening an approval gate", async () => {
    // Treated as an active phase, the expensive-phase branch opens an OPERATOR
    // APPROVAL gate for a state whose contract is that it needs no human — the
    // exact false page this status exists to avoid, through a different door.
    const src = await Bun.file(new URL("./boot-resume.mjs", import.meta.url)).text();
    expect(src).toContain("YIELDED_STATUS");
    // The skip must sit beside the needs-input skip, i.e. BEFORE the worktreePath
    // branch that leads to candidate creation.
    const yieldAt = src.indexOf("YIELDED_STATUS)");
    const worktreeAt = src.indexOf("if (!active.worktreePath)");
    expect(yieldAt).toBeGreaterThan(0);
    expect(worktreeAt).toBeGreaterThan(0);
    expect(yieldAt).toBeLessThan(worktreeAt);
  });
});

describe("⚠️ a yield occupies its slot in EVERY dispatch mode", () => {
  // Round 5's fix added the status to SDK_INFLIGHT_STATUSES. That was half a fix:
  // countSdkInflight excludes any signal with a bg_job_id AND the scheduler calls
  // it only for in-process modes, so under the DEFAULT `phase-agents` mode the
  // term is never added. Meanwhile the yielded worker's `claude --bg` job is
  // terminal, so liveBackgroundCount drops it too — the slot silently freed for
  // the whole live yield.
  test("countYieldedOccupancy counts a yielded signal that HAS a bg_job_id", async () => {
    const { countYieldedOccupancy } = await import("./signal-reader.mjs");
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const orch = mkdtempSync(join(tmpdir(), "yieldocc-"));
    mkdirSync(join(orch, "workers", "PROJ-9"), { recursive: true });
    writeFileSync(
      join(orch, "workers", "PROJ-9", "phase-implement.json"),
      // bg_job_id present — this is the bg-worker shape countSdkInflight EXCLUDES.
      JSON.stringify({ status: YIELDED_STATUS, ticket: "PROJ-9", phase: "implement", bg_job_id: "bg-123" })
    );
    expect(countYieldedOccupancy(orch)).toBe(1);
  });

  test("it does not count non-yielded signals, and never throws on a missing dir", async () => {
    const { countYieldedOccupancy } = await import("./signal-reader.mjs");
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const orch = mkdtempSync(join(tmpdir(), "yieldocc2-"));
    mkdirSync(join(orch, "workers", "PROJ-8"), { recursive: true });
    writeFileSync(
      join(orch, "workers", "PROJ-8", "phase-implement.json"),
      JSON.stringify({ status: "running", ticket: "PROJ-8", phase: "implement" })
    );
    expect(countYieldedOccupancy(orch)).toBe(0);
    expect(countYieldedOccupancy(join(orch, "does-not-exist"))).toBe(0);
  });
});

describe("the expiry write is atomic", () => {
  // A direct write TRUNCATES the canonical signal first: a crash mid-write leaves
  // partial JSON, every scan skips an unparseable signal, and the ticket drops out
  // of BOTH recovery and capacity accounting — permanently, since the next tick
  // can no longer see it to retry.
  test("writes to a temp path and renames over the signal", () => {
    const calls = [];
    defaultExpireYield(
      "/orch",
      { ticket: "PROJ-1", phase: "implement" },
      { reason: "deadline-passed" },
      {
        readFile: () => JSON.stringify({ status: YIELDED_STATUS }),
        writeFile: (p) => calls.push(["write", p]),
        rename: (from, to) => calls.push(["rename", from, to]),
        rm: () => calls.push(["rm"]),
      }
    );
    const [write, ren] = calls;
    expect(write[0]).toBe("write");
    expect(write[1]).toContain(".tmp."); // never the canonical path directly
    expect(ren[0]).toBe("rename");
    expect(ren[1]).toBe(write[1]);
    expect(ren[2]).toMatch(/phase-implement\.json$/);
    expect(ren[2]).not.toContain(".tmp.");
  });

  test("a failed rename cleans up its temp file rather than leaving debris", () => {
    let removed = null;
    const ok = defaultExpireYield(
      "/orch",
      { ticket: "PROJ-1", phase: "implement" },
      {},
      {
        readFile: () => JSON.stringify({ status: YIELDED_STATUS }),
        writeFile: () => {},
        rename: () => { throw new Error("EXDEV"); },
        rm: (p) => { removed = p; },
      }
    );
    expect(ok).toBe(false);
    expect(removed).toContain(".tmp.");
  });
});

describe("⚠️ every admission budget charges the yield, not just the scheduler's", () => {
  // A limit that holds in one admission path and leaks in the next is not a
  // limit. countYieldedOccupancy was first wired only into schedulerTick, so a
  // webhook drain could still dispatch Triage straight through a live yield.
  test("computeTriageBudget subtracts yielded occupancy at maxParallel=1", async () => {
    const { computeTriageBudget } = await import("./monitor.mjs");
    const base = {
      orchDir: "/orch",
      readMaxParallelFn: () => 1,
      liveBackgroundCount: () => 0, // the yielded worker's bg job is TERMINAL
      dispatchMode: "phase-agents", // the DEFAULT — countSdkInflight is not even called
      countSdkInflight: () => 0,
    };
    expect(computeTriageBudget({ ...base, countYieldedOccupancy: () => 0 }).remaining).toBe(1);
    // With one yield outstanding the only slot is taken.
    expect(computeTriageBudget({ ...base, countYieldedOccupancy: () => 1 }).remaining).toBe(0);
  });

  test("a throwing occupancy reader never blocks triage admission", async () => {
    const { computeTriageBudget } = await import("./monitor.mjs");
    const out = computeTriageBudget({
      orchDir: "/orch",
      readMaxParallelFn: () => 2,
      liveBackgroundCount: () => 0,
      dispatchMode: "phase-agents",
      countSdkInflight: () => 0,
      countYieldedOccupancy: () => { throw new Error("scan failed"); },
    });
    expect(out.remaining).toBe(2); // degrades, does not throw
  });
});
