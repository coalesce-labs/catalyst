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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 1, ok: true });
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
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 0, ok: true });
    // A missing dir is a CONCLUSIVE zero (ENOENT: there are no yields), unlike an
    // unreadable one.
    expect(countYieldedOccupancy(join(orch, "does-not-exist"))).toMatchObject({ count: 0, ok: true });
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
    expect(computeTriageBudget({ ...base, countYieldedOccupancy: () => ({ count: 0, ok: true }) }).remaining).toBe(1);
    // With one yield outstanding the only slot is taken.
    expect(computeTriageBudget({ ...base, countYieldedOccupancy: () => ({ count: 1, ok: true }) }).remaining).toBe(0);
  });

  test("a throwing occupancy reader HOLDS admission (fail-closed)", async () => {
    // This expectation is deliberately the REVERSE of its first version, which
    // asserted the budget "degrades, does not throw" and returned full capacity.
    // Degrading to full capacity is precisely the fail-OPEN behaviour that let an
    // unreadable scan read as an empty slot. It must still not throw — but the
    // safe degraded value for a limit is zero, not everything.
    const { computeTriageBudget } = await import("./monitor.mjs");
    const out = computeTriageBudget({
      orchDir: "/orch",
      readMaxParallelFn: () => 2,
      liveBackgroundCount: () => 0,
      dispatchMode: "phase-agents",
      countSdkInflight: () => 0,
      countYieldedOccupancy: () => { throw new Error("scan failed"); },
    });
    expect(out.remaining).toBe(0);
  });
});

describe("⚠️ expiry EXECUTES — not merely appears in the right place", () => {
  // The previous version of this suite asserted the SOURCE ORDER of the expiry
  // branch. It passed while the branch was dead: the inline code referenced
  // `reclaimOpts`, declared later inside the loop's own try block, so every call
  // threw a TDZ ReferenceError that the branch's best-effort catch swallowed.
  // The fix for "a bound whose enforcement point cannot fire" had become one, and
  // a text-position assertion is structurally incapable of noticing.
  //
  // These tests RUN the sweep against real files on disk.

  function orchWith(signals) {
    const orch = mkdtempSync(join(tmpdir(), "yieldsweep-"));
    for (const [ticket, phases] of Object.entries(signals)) {
      mkdirSync(join(orch, "workers", ticket), { recursive: true });
      for (const [phase, body] of Object.entries(phases)) {
        writeFileSync(join(orch, "workers", ticket, `phase-${phase}.json`), JSON.stringify({ ticket, phase, ...body }));
      }
    }
    return orch;
  }
  const read = (orch, t, p) => JSON.parse(readFileSync(join(orch, "workers", t, `phase-${p}.json`), "utf8"));
  const ago = (ms) => new Date(Date.now() - ms).toISOString();

  test("an expired yield is actually written to disk", async () => {
    const { expireYieldedSignals } = await import("./scheduler.mjs");
    const orch = orchWith({ "PROJ-1": { implement: { status: YIELDED_STATUS, yieldedAt: ago(2 * MAX_YIELD_MS) } } });
    const r = expireYieldedSignals(orch);
    expect(r).toMatchObject({ evaluated: 1, ok: true });
    expect(read(orch, "PROJ-1", "implement")).toMatchObject({
      status: "failed",
      failureReason: YIELD_EXPIRED_REASON,
    });
  });

  test("a LIVE yield is left alone", async () => {
    const { expireYieldedSignals } = await import("./scheduler.mjs");
    const orch = orchWith({ "PROJ-1": { implement: { status: YIELDED_STATUS, yieldedAt: ago(60_000) } } });
    expireYieldedSignals(orch);
    expect(read(orch, "PROJ-1", "implement").status).toBe(YIELDED_STATUS);
  });

  test("⚠️ a yield HIDDEN behind a newer sibling is still expired", async () => {
    // readWorkerSignals projects ONE canonical active-phase row per ticket, so a
    // yielded recovery-pass behind a newer running pipeline phase was invisible to
    // the sweep — while countYieldedOccupancy still charged its slot. The sweep
    // must read every phase file, not the per-ticket projection.
    const { expireYieldedSignals } = await import("./scheduler.mjs");
    const orch = orchWith({
      "PROJ-1": {
        "recovery-pass": { status: YIELDED_STATUS, yieldedAt: ago(2 * MAX_YIELD_MS), updatedAt: ago(2 * MAX_YIELD_MS) },
        implement: { status: "running", updatedAt: new Date().toISOString() },
      },
    });
    expect(expireYieldedSignals(orch).evaluated).toBe(1);
    expect(read(orch, "PROJ-1", "recovery-pass")).toMatchObject({ status: "failed", failureReason: YIELD_EXPIRED_REASON });
    expect(read(orch, "PROJ-1", "implement").status).toBe("running"); // sibling untouched
  });

  test("it never throws: unreadable dir, and one bad signal does not stop the rest", async () => {
    const { expireYieldedSignals } = await import("./scheduler.mjs");
    expect(expireYieldedSignals("/nope/does/not/exist")).toMatchObject({ evaluated: 0 });
    const orch = orchWith({
      "PROJ-1": { implement: { status: YIELDED_STATUS, yieldedAt: ago(2 * MAX_YIELD_MS) } },
      "PROJ-2": { implement: { status: YIELDED_STATUS, yieldedAt: ago(2 * MAX_YIELD_MS) } },
    });
    expect(() => expireYieldedSignals(orch)).not.toThrow();
    expect(read(orch, "PROJ-2", "implement").status).toBe("failed");
  });
});

describe("⚠️ round 12: the ancillary-yield shape, three more places", () => {
  test("delegate dedup short-circuits a yield BEFORE the liveness probe", async () => {
    // Adding the status to an allow-list that then asks a question it must fail is
    // not the same as handling it: a yielded worker has EXITED, so its retained
    // bg_job_id necessarily fails isBgJobAlive, and the probe reported "not live".
    //
    // Scoped to the ENCLOSING FUNCTION: delegate-queue.mjs probes isBgJobAlive in
    // an earlier, unrelated function, so a file-wide index comparison compares
    // across functions and answers a different question than the one asked.
    for (const f of ["delegate-queue.mjs", "delegate-runner-entry.mjs"]) {
      const src = await Bun.file(new URL(`./${f}`, import.meta.url)).text();
      const sc = src.indexOf("if (sig.status === YIELDED_STATUS) return true;");
      expect({ f, hasShortCircuit: sc > -1 }).toEqual({ f, hasShortCircuit: true });
      // Body = from the short-circuit to the end of its function.
      const bodyEnd = src.indexOf("\n}", sc);
      expect(bodyEnd).toBeGreaterThan(sc);
      const before = src.slice(0, sc);
      const fnStart = Math.max(before.lastIndexOf("\nfunction "), before.lastIndexOf("\nexport function "));
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = src.slice(fnStart, bodyEnd);
      const scInFn = fnBody.indexOf("if (sig.status === YIELDED_STATUS) return true;");
      const probeInFn = fnBody.indexOf("isBgJobAlive(bgJobId)");
      expect({ f, probeFound: probeInFn > -1 }).toEqual({ f, probeFound: true });
      expect({ f, shortCircuitFirst: scInFn < probeInFn }).toEqual({ f, shortCircuitFirst: true });
    }
  });

  test("boot-resume charges an ANCILLARY yield against capacity (executed)", async () => {
    // Replaces a source-text assertion that broke on a rename — the exact weakness
    // that let the round-11 defect ship. This RUNS the selector.
    //
    // Shape: maxParallel 1. PROJ-2's only live phase is a yielded recovery-pass
    // beside a FAILED pipeline phase, so listInFlightTickets excludes the ticket
    // and an in-loop increment could never charge it. PROJ-1 is a resumable
    // candidate. With the yield charged, the single slot is taken and PROJ-1 must
    // NOT be selected.
    const { selectBootResumeCandidates } = await import("./boot-resume.mjs");
    const orch = mkdtempSync(join(tmpdir(), "bootyield-"));
    const wt = join(orch, "wt-1");
    mkdirSync(wt, { recursive: true });
    mkdirSync(join(orch, "workers", "PROJ-1"), { recursive: true });
    mkdirSync(join(orch, "workers", "PROJ-2"), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(orch, "workers", "PROJ-1", "phase-implement.json"),
      JSON.stringify({ ticket: "PROJ-1", phase: "implement", status: "running", worktreePath: wt, updatedAt: now }));
    writeFileSync(join(orch, "workers", "PROJ-2", "phase-implement.json"),
      JSON.stringify({ ticket: "PROJ-2", phase: "implement", status: "failed", updatedAt: now }));
    writeFileSync(join(orch, "workers", "PROJ-2", "phase-recovery-pass.json"),
      JSON.stringify({ ticket: "PROJ-2", phase: "recovery-pass", status: YIELDED_STATUS, yieldedAt: now, updatedAt: now }));

    const picked = selectBootResumeCandidates({ orchDir: orch, agents: [], maxParallel: 1 });
    expect(Array.isArray(picked)).toBe(true);
    // The yielded ancillary phase holds the only slot, so nothing is resumed.
    expect(picked.map((c) => c.ticket)).not.toContain("PROJ-1");
  });
});

describe("⚠️ the dispatcher change and the spec parser are one change", () => {
  // Found by sweeping my OWN round-13 fix rather than by the next review round.
  // The dispatcher's idempotent branch echoes the EXISTING signal status into the
  // spec it prints on stdout. Teaching it to short-circuit on `awaiting-work`
  // therefore makes that status reach isLaunchSpec's structural parser — and the
  // parser rejects any status outside its closed set, so the runner would find NO
  // spec at all. Adding one without the other is a broken half-change.
  test("isLaunchSpec accepts an idempotent awaiting-work spec", async () => {
    const src = await Bun.file(new URL("./sdk-run-phase-agent.mjs", import.meta.url)).text();
    const i = src.indexOf("const PRELAUNCH_SPEC_STATUSES");
    const j = src.indexOf("]);", i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(src.slice(i, j)).toContain("YIELDED_STATUS");
  });

  test("the dispatcher really does emit that status (the reason the above matters)", async () => {
    const dispatch = await Bun.file(new URL("../phase-agent-dispatch", import.meta.url)).text();
    // The idempotent branch echoes $EXISTING_STATUS into the spec's `status`.
    const guard = dispatch.indexOf('$EXISTING_STATUS == "awaiting-work"');
    expect(guard).toBeGreaterThan(-1);
    const branch = dispatch.slice(guard, guard + 900);
    expect(branch).toContain('--arg status "$EXISTING_STATUS"');
    expect(branch).toContain("idempotent: true");
  });
});


describe("⚠️ occupancy fails CLOSED: could-not-look is not an empty slot", () => {
  test("a truncated signal yields ok:false, not a confident zero", async () => {
    const { countYieldedOccupancy } = await import("./signal-reader.mjs");
    const orch = mkdtempSync(join(tmpdir(), "yieldclosed-"));
    mkdirSync(join(orch, "workers", "PROJ-1"), { recursive: true });
    // Positive control first: a VALID yielded signal must report count 1 / ok true,
    // so a later ok:false is evidence of the truncation and not of a broken probe.
    const p = join(orch, "workers", "PROJ-1", "phase-implement.json");
    writeFileSync(p, JSON.stringify({ status: YIELDED_STATUS, ticket: "PROJ-1", phase: "implement" }));
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 1, ok: true });
    // Now truncate that same present signal — a torn write lands exactly here.
    writeFileSync(p, '{"status":"awaiting-work","tick');
    const out = countYieldedOccupancy(orch);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("signal-unparseable");
  });

  test("callers hold admission rather than treating it as capacity", async () => {
    const { computeTriageBudget } = await import("./monitor.mjs");
    const base = {
      orchDir: "/orch",
      readMaxParallelFn: () => 4,
      liveBackgroundCount: () => 0,
      dispatchMode: "phase-agents",
      countSdkInflight: () => 0,
    };
    // Conclusive zero → full budget. Inconclusive → zero, not four.
    expect(computeTriageBudget({ ...base, countYieldedOccupancy: () => ({ count: 0, ok: true }) }).remaining).toBe(4);
    expect(computeTriageBudget({ ...base, countYieldedOccupancy: () => ({ count: 0, ok: false }) }).remaining).toBe(0);
    expect(computeTriageBudget({ ...base, countYieldedOccupancy: () => { throw new Error("EIO"); } }).remaining).toBe(0);
  });
});

describe("⚠️ a live yield still OWNS its worktree", () => {
  test("the rebase guard and the stale-PR rescue both recognize it", async () => {
    const rebase = await Bun.file(new URL("../orchestrate-auto-rebase", import.meta.url)).text();
    expect(rebase).toContain("dispatched|running|done|awaiting-work");
    const rescue = await Bun.file(new URL("./stale-pr-rescue-timer.mjs", import.meta.url)).text();
    // Ownership is read off the SIGNAL: the worker has exited by design, so a
    // bg_job_id liveness probe necessarily says "not alive" for a live yield.
    expect(rescue).toContain("!classifyYield(raw).expired");
  });
});
