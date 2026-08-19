// phase-dispatch-deadline.test.mjs — CTL-1851.
//
// Run: cd plugins/dev/scripts/execution-core && bun test phase-dispatch-deadline.test.mjs
//
// ── WHAT THIS HAS TO PROVE ───────────────────────────────────────────────────
//
// The feature reclassifies a live-looking worker as DEAD, which hands it to a
// reclaim path that can revive it, complete it, or escalate it. Its risk is
// symmetric and both directions are real:
//
//   TOO NARROW → the measured incident recurs: a ghost pins a slot forever and a
//     human has to clear it by hand (that is CTL-2053, on the record).
//   TOO WIDE   → a LIVE agent is declared dead and duplicated.
//
// So "it expires the ghost" is the easy half. Three things carry the weight:
//
//   1. THE COMPATIBILITY CONTRACT IS ASSERTED, NOT ASSUMED. `bootedMs` defaults
//      to null and classifyWorker must then answer exactly what it answered
//      before this ticket. A test pins the no-args shape (memory: every test
//      injects → the default is untested).
//   2. THE LIVE-WORKER CONTROLS. A young dispatch, a same-boot `running`, a bg
//      worker inside the bash prelaunch window — each must survive.
//   3. THE WIRING, NOT JUST THE PREDICATE. classifyWorker must actually CALL
//      this, with the boot instant the reclaim path actually reads. Deleting
//      each guard in turn must go red.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyDispatchDeadline,
  isDispatchExpiredReason,
  DISPATCH_DEADLINE_REASONS,
  MAX_DISPATCHED_MS,
  MIN_DISPATCH_AGE_MS,
  IN_PROCESS_EXECUTOR_ID,
} from "../lib/phase-dispatch-deadline.mjs";
import { readFileSync } from "node:fs";
import { classifyWorker, reclaimDeadWorkIfPossible } from "./recovery.mjs";

const BOOT = Date.parse("2026-08-18T23:10:00Z");
const iso = (ms) => new Date(ms).toISOString();

// A bg-less phase signal in the SDK shape: the prelaunch writes bg_job_id null
// and nothing ever fills it in.
const sdk = (over = {}) => ({
  ticket: "CTL-1",
  phase: "implement",
  status: "dispatched",
  bg_job_id: null,
  executor: "sdk", // CTL-1457 writes this at prelaunch; Codex #3694 P1 gates on it

  startedAt: iso(BOOT - 6 * 60 * 60 * 1000), // 6 h before boot — the measured ghost
  ...over,
});

const at = (offsetMs) => BOOT + offsetMs;

// ─────────────────────────────────────────────────────────────────────────────
describe("Rule 1 — a dispatch that predates the boot is PROVEN dead", () => {
  test("⭐ the measured ghost: dispatched 6 h before boot, still `dispatched`", () => {
    const v = classifyDispatchDeadline(sdk(), { nowMs: at(60_000), bootedMs: BOOT });
    expect(v.expired).toBe(true);
    expect(v.reason).toBe("dispatch-predates-boot");
  });

  // The proof does not care what the agent had got around to writing — an SDK
  // worker that reached `running` before its daemon died is just as gone.
  test("⭐ it applies to `running` too, which the TIMER deliberately does not", () => {
    const v = classifyDispatchDeadline(sdk({ status: "running" }), {
      nowMs: at(60_000),
      bootedMs: BOOT,
    });
    expect(v.expired).toBe(true);
    expect(v.reason).toBe("dispatch-predates-boot");
  });

  test("a dispatch AT the boot instant is not proven to precede it (strict <)", () => {
    const v = classifyDispatchDeadline(sdk({ startedAt: iso(BOOT) }), {
      nowMs: at(MIN_DISPATCH_AGE_MS + 1000),
      bootedMs: BOOT,
    });
    expect(v.reason).not.toBe("dispatch-predates-boot");
  });

  test("a dispatch AFTER the boot is this daemon's own work — never Rule 1", () => {
    const v = classifyDispatchDeadline(sdk({ startedAt: iso(BOOT + 1000), status: "running" }), {
      nowMs: at(60 * 60 * 1000), // an hour of legitimate running
      bootedMs: BOOT,
    });
    expect(v.expired).toBe(false);
    expect(v.reason).toBe("within-deadline");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Rule 2 — still `dispatched` long past the ceiling never had a first turn", () => {
  const sameBoot = (ageMs, over = {}) =>
    classifyDispatchDeadline(sdk({ startedAt: iso(BOOT + 1000), ...over }), {
      nowMs: BOOT + 1000 + ageMs,
      bootedMs: BOOT,
    });

  test("past the ceiling → dead", () => {
    const v = sameBoot(MAX_DISPATCHED_MS + 1000);
    expect(v.expired).toBe(true);
    expect(v.reason).toBe("dispatch-never-started");
  });

  test("exactly at the ceiling is still within it (strict >)", () => {
    expect(sameBoot(MAX_DISPATCHED_MS).expired).toBe(false);
  });

  // ⛔ The control that keeps this from killing working agents. A live SDK
  // implement phase legitimately runs for hours.
  test("⛔ `running` on the SAME boot is NEVER expired by the timer, at any age", () => {
    for (const hours of [1, 6, 24, 72]) {
      const v = sameBoot(hours * 60 * 60 * 1000, { status: "running" });
      expect(v.expired).toBe(false);
      expect(v.reason).toBe("within-deadline");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the controls that protect a live worker", () => {
  test.each([[0], [1000], [MIN_DISPATCH_AGE_MS - 1]])(
    "a dispatch aged %pms is too young for ANY rule, boot-predating or not",
    (ageMs) => {
      // ⚠️ The dispatch PREDATES the boot, so Rule 1 would fire on it — the age
      // floor is the only thing that can be holding it. (First cut of this test
      // kept the fixture's 6-h-old startedAt and varied only `nowMs`, which made
      // every case 6 h old and proved nothing about the floor.)
      const v = classifyDispatchDeadline(sdk({ startedAt: iso(BOOT - 1000) }), {
        nowMs: BOOT - 1000 + ageMs,
        bootedMs: BOOT,
      });
      expect(v.expired).toBe(false);
      expect(v.reason).toBe("too-young");
    }
  );

  // ⛔ The bash-executor false positive named in the module header: its prelaunch
  // also writes bg_job_id null and fills it in seconds later, and a `claude --bg`
  // worker DOES survive a restart.
  test("⛔ a bash prelaunch inside its fill-in window is held by the age floor", () => {
    const v = classifyDispatchDeadline(sdk({ startedAt: iso(BOOT - 3000) }), {
      nowMs: BOOT + 2000,
      bootedMs: BOOT,
    });
    expect(v.expired).toBe(false);
    expect(v.reason).toBe("too-young");
  });

  test.each([["job-abc"], ["bg-1"]])(
    "a signal carrying a bg id (%p) is never judged here — jobLifecycle owns it",
    (bg_job_id) => {
      const v = classifyDispatchDeadline(sdk({ bg_job_id }), { nowMs: at(60_000), bootedMs: BOOT });
      expect(v.expired).toBe(false);
      expect(v.reason).toBe("has-bg-job");
    }
  );

  test.each([[""], [null], [undefined], [0], [{}]])(
    "a non-id bg_job_id (%p) is NOT a bg job — the signal is still judged",
    (bg_job_id) => {
      const v = classifyDispatchDeadline(sdk({ bg_job_id }), { nowMs: at(60_000), bootedMs: BOOT });
      expect(v.reason).not.toBe("has-bg-job");
    }
  );

  // ⚠️ The fail direction is the OPPOSITE of CTL-1854's yield, on purpose — and
  // the reason is in the module header. Pinned here so a later reader does not
  // "make the two consistent".
  test.each([[undefined], [null], ["not a date"], [{}], [NaN]])(
    "an undatable dispatch (%p) HOLDS — unlike a yield, which expires",
    (startedAt) => {
      const v = classifyDispatchDeadline(sdk({ startedAt, updatedAt: startedAt }), {
        nowMs: at(60_000),
        bootedMs: BOOT,
      });
      expect(v.expired).toBe(false);
      expect(v.reason).toBe("dispatch-start-unreadable");
    }
  );

  test("startedAt absent falls back to updatedAt rather than giving up", () => {
    const v = classifyDispatchDeadline(
      { status: "dispatched", bg_job_id: null, executor: "sdk", updatedAt: iso(BOOT - 60 * 60 * 1000) },
      { nowMs: at(60_000), bootedMs: BOOT }
    );
    expect(v.expired).toBe(true);
    expect(v.reason).toBe("dispatch-predates-boot");
  });

  // ⛔ The first cut let the TIMER fire with no boot instant, which decided Rule
  // 1's question without Rule 1's evidence AND broke the caller-side default.
  // Both statuses now hold, and the reason names the missing fact rather than
  // reporting a generic decline.
  test.each([[null], [undefined], ["garbage"], [NaN], [{}]])(
    "an unreadable boot instant (%p) disables BOTH rules, for both statuses",
    (bootedMs) => {
      for (const status of ["dispatched", "running"]) {
        const v = classifyDispatchDeadline(sdk({ status }), {
          nowMs: at(24 * 60 * 60 * 1000), // a full day past the ceiling
          bootedMs,
        });
        expect(v.expired).toBe(false);
        expect(v.reason).toBe("boot-unreadable");
      }
    }
  );

  test.each([["done"], ["failed"], ["stalled"], ["needs-input"], ["awaiting-work"], ["skipped"]])(
    "status %p is not this module's business",
    (status) => {
      const v = classifyDispatchDeadline(sdk({ status }), { nowMs: at(60_000), bootedMs: BOOT });
      expect(v.expired).toBe(false);
      expect(v.reason).toBe("not-pending");
    }
  );

  test.each([[null], [undefined], [42], [[]], ["x"]])("a non-signal (%p) is not-a-signal", (sig) => {
    const v = classifyDispatchDeadline(sig, { nowMs: at(60_000), bootedMs: BOOT });
    expect(v.expired).toBe(false);
    expect(v.reason).toBe("not-a-signal");
  });

  // ⚠️ `undefined` is deliberately absent from this list: it selects the
  // parameter default (a real Date.now()), so including it would assert against
  // the wall clock rather than against the guard.
  test("a caller that cannot read the clock expires nothing", () => {
    for (const nowMs of [NaN, Infinity, -Infinity]) {
      const v = classifyDispatchDeadline(sdk(), { nowMs, bootedMs: BOOT });
      expect(v.expired).toBe(false);
    }
  });

  test("a future-stamped dispatch (clock skew) is too-young, never very-old", () => {
    const v = classifyDispatchDeadline(sdk({ startedAt: iso(BOOT + 10 * 60 * 60 * 1000) }), {
      nowMs: at(60_000),
      bootedMs: BOOT,
    });
    expect(v.expired).toBe(false);
    expect(v.reason).toBe("too-young");
    expect(v.ageMs).toBeLessThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⛔ Codex #3694 P1 — the correction to my own age-floor argument.
//
// I had claimed the 5-minute floor covered the bash prelaunch window. It does
// not: if the DAEMON dies inside that window, `phase-agent-dispatch` never
// persists the job id and the signal is bg-less PERMANENTLY — so waiting longer
// makes a live, detached `claude --bg` worker look MORE dead, not less. Rule 1
// would then declare it dead and the reclaim could dispatch a duplicate
// alongside it. The proof is not "no bg id", it is "ran inside the daemon".
describe("the executor gate — the restart proof is only valid in-process", () => {
  const wouldOtherwiseExpire = { nowMs: at(60_000), bootedMs: BOOT };

  test.each([["bg"], ["codex-exec"], ["worker"], ["SDK"], ["sdk-exec"]])(
    "⛔ executor %p is NOT declared dead by a restart, even pre-boot and past the ceiling",
    (executor) => {
      for (const status of ["dispatched", "running"]) {
        const v = classifyDispatchDeadline(sdk({ executor, status }), wouldOtherwiseExpire);
        expect(v.expired).toBe(false);
        expect(v.reason).toBe("executor-not-in-process");
      }
    }
  );

  // ⭐ THE MEASURED CASE, stated as a scenario rather than as a field value: a
  // `claude --bg` worker whose id was never persisted because the daemon died
  // mid-launch. It is bg-less forever, it is old, its dispatch predates the boot
  // — and it is ALIVE.
  test("⭐ a bash worker whose job id was never persisted survives the restart", () => {
    const v = classifyDispatchDeadline(
      sdk({ executor: "bg", status: "running", startedAt: iso(BOOT - 6 * 60 * 60 * 1000) }),
      wouldOtherwiseExpire
    );
    expect(v.expired).toBe(false);
    expect(v.reason).toBe("executor-not-in-process");
  });

  test.each([[undefined], [null], [""], [42], [{}]])(
    "an absent/unusable executor (%p) HOLDS — it cannot prove it ran in-process",
    (executor) => {
      const v = classifyDispatchDeadline(sdk({ executor }), wouldOtherwiseExpire);
      expect(v.expired).toBe(false);
      expect(v.reason).toBe("executor-unknown");
      // ⚠️ and NOT the other executor reason — "I have no evidence" and "I have
      // evidence it is the wrong executor" are different facts.
      expect(v.reason).not.toBe("executor-not-in-process");
    }
  );

  // ⛔ Rule 2 is gated too, not just Rule 1. Its input — a bg-less signal still
  // at `dispatched` — is the SAME on-disk shape the died-mid-launch bash case
  // produces, so leaving the timer ungated would reintroduce the duplicate by
  // the other door.
  test("⛔ the TIMER is gated on the executor too, not only the restart proof", () => {
    const sameBootPastCeiling = {
      nowMs: BOOT + 1000 + MAX_DISPATCHED_MS + 60_000,
      bootedMs: BOOT,
    };
    const v = classifyDispatchDeadline(
      sdk({ executor: "bg", startedAt: iso(BOOT + 1000) }),
      sameBootPastCeiling
    );
    expect(v.expired).toBe(false);
    expect(v.reason).toBe("executor-not-in-process");
  });

  // ⭐ PARITY. This is a zero-import leaf, so the literal is a MIRROR of the
  // production prelaunch and has to be checked mechanically rather than trusted
  // — the same discipline as ASSERTED_BY's two bash mirrors. It also fails
  // CLOSED: if either anchor disappears, the test errors rather than passing on
  // a vacuous match.
  test("⭐ executor-id-parity: the literal matches the SDK prelaunch and excludes codex", () => {
    const sdkSrc = readFileSync("./sdk-run-phase-agent.mjs", "utf8");
    const m = sdkSrc.match(/executorId:\s*"([^"]+)"/);
    expect(m).not.toBeNull(); // fails closed if the anchor is renamed
    expect(m[1]).toBe(IN_PROCESS_EXECUTOR_ID);

    const codexSrc = readFileSync("./codex-run-phase-agent.mjs", "utf8");
    const c = codexSrc.match(/CODEX_EXECUTOR_ID\s*=\s*"([^"]+)"/);
    expect(c).not.toBeNull();
    // ⛔ A future rename must not silently widen the proof to a SPAWNED executor.
    expect(c[1]).not.toBe(IN_PROCESS_EXECUTOR_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the verdict vocabulary is closed and every branch names itself", () => {
  test("every reason produced is registered, and both expiring reasons are recognised", () => {
    const produced = new Set();
    const sigs = [
      null,
      42,
      sdk(),
      sdk({ status: "running" }),
      sdk({ status: "done" }),
      sdk({ bg_job_id: "job-1" }),
      sdk({ startedAt: "nope", updatedAt: "nope" }),
      sdk({ startedAt: iso(BOOT + 1000) }),
    ];
    for (const sig of sigs) {
      for (const bootedMs of [BOOT, null]) {
        for (const nowMs of [BOOT + 1000, at(MAX_DISPATCHED_MS + 60_000)]) {
          const v = classifyDispatchDeadline(sig, { nowMs, bootedMs });
          produced.add(v.reason);
          expect(DISPATCH_DEADLINE_REASONS).toContain(v.reason);
          expect(isDispatchExpiredReason(v.reason)).toBe(v.expired);
        }
      }
    }
    expect(produced.size).toBeGreaterThanOrEqual(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⛔ THE WIRING. The predicate above being correct proves nothing about whether
// classifyWorker calls it — and a discriminator that is read but never changes
// the answer is a shape this lane has shipped before.
describe("classifyWorker — the wiring, and the compatibility contract", () => {
  const wsig = (over = {}) => ({
    ticket: "CTL-1",
    phase: "implement",
    status: "dispatched",
    liveness: { kind: "bg", value: null }, // the SDK shape readAllPhaseSignals produces
    raw: sdk(over),
    ...(over.status ? { status: over.status } : {}),
  });

  // ⭐ THE COMPATIBILITY CONTRACT. Every OTHER caller of classifyWorker passes no
  // boot instant, so the no-args shape is the one that ships to them — and a
  // suite where every test injects is a suite in which the default is untested.
  test("⭐ with NO options at all, a bg-less signal is still `unknown` (unchanged)", () => {
    expect(classifyWorker(wsig())).toBe("unknown");
    expect(classifyWorker(wsig({ status: "running" }))).toBe("unknown");
  });

  test("with only statJob (the pre-CTL-1851 call shape) it is still `unknown`", () => {
    expect(classifyWorker(wsig(), { statJob: () => null })).toBe("unknown");
  });

  test("⭐ given the boot instant, the measured ghost becomes `dead`", () => {
    expect(classifyWorker(wsig(), { bootedMs: BOOT, nowMs: at(60_000) })).toBe("dead");
  });

  test("⭐ a `running` SDK worker from before the boot becomes `dead` too", () => {
    expect(
      classifyWorker(wsig({ status: "running" }), { bootedMs: BOOT, nowMs: at(60_000) })
    ).toBe("dead");
  });

  test("⛔ a live same-boot `running` SDK worker stays out of the dead bucket", () => {
    const live = wsig({ status: "running", startedAt: iso(BOOT + 1000) });
    expect(classifyWorker(live, { bootedMs: BOOT, nowMs: at(6 * 60 * 60 * 1000) })).toBe("unknown");
  });

  test("a terminal signal short-circuits before any of this", () => {
    expect(classifyWorker(wsig({ status: "done" }), { bootedMs: BOOT, nowMs: at(60_000) })).toBe(
      "terminal"
    );
  });

  test("a signal WITH a live bg id is still routed through jobLifecycle, not here", () => {
    const bg = {
      ticket: "CTL-1",
      phase: "implement",
      status: "running",
      liveness: { kind: "bg", value: "job-1" },
      raw: { status: "running", bg_job_id: "job-1", startedAt: iso(BOOT - 60_000) },
    };
    // statJob is the jobLifecycle seam; a live state.json keeps it `running`
    // even though its dispatch predates the boot — a --bg worker survives.
    expect(
      classifyWorker(bg, {
        statJob: () => ({ isDirectory: () => true }),
        bootedMs: BOOT,
        nowMs: at(60_000),
      })
    ).not.toBe("dead");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⛔ THE WIRING, ONE LEVEL UP — and the control that started GREEN.
//
// Every test above drives classifyWorker DIRECTLY, so deleting `bootedMs` from
// reclaimDeadWorkIfPossible's call to it left the whole suite 50 pass / 0 fail
// (measured, mutation M7). The predicate was proven correct and proven wired to
// classifyWorker, and the one call site that actually runs on the fleet was
// covered by nothing. Exactly the shape that shipped twice on this lane in the
// last 24 hours.
//
// This describe drives the REAL reclaim entry point over a REAL orchDir, and
// deliberately does NOT inject `readBootSince`: the boot instant must come from
// the same daemon-boot.json production reads, or the test proves the seam works
// and not the wiring.
describe("reclaimDeadWorkIfPossible — the ghost reaches the reclaim path", () => {
  const recorder = (returnValue) => {
    const calls = [];
    const fn = (...args) => {
      calls.push(args);
      return typeof returnValue === "function" ? returnValue(...args) : returnValue;
    };
    fn.calls = calls;
    return fn;
  };

  // A real orchDir with a real boot marker, and a bg-less `dispatched` signal
  // stamped before it: the measured mini shape from 2026-08-18 23:1x.
  const ghostOrch = ({ dispatchedAtMs, status = "dispatched" }) => {
    const orch = mkdtempSync(join(tmpdir(), "ctl1851-"));
    writeFileSync(join(orch, "daemon-boot.json"), JSON.stringify({ bootedAt: iso(BOOT) }));
    mkdirSync(join(orch, "workers", "CTL-GHOST"), { recursive: true });
    const raw = {
      ticket: "CTL-GHOST",
      phase: "implement",
      orchestrator: "CTL-GHOST",
      status,
      bg_job_id: null,
      executor: "sdk",
      startedAt: iso(dispatchedAtMs),
      catalystSessionId: "sess_ghost",
    };
    writeFileSync(join(orch, "workers", "CTL-GHOST", "phase-implement.json"), JSON.stringify(raw));
    return {
      orch,
      sig: {
        ticket: "CTL-GHOST",
        phase: "implement",
        status,
        liveness: { kind: "bg", value: null },
        signalPath: join(orch, "workers", "CTL-GHOST", "phase-implement.json"),
        raw,
      },
    };
  };

  const seams = (probe, emit) => ({
    statJob: () => null,
    probes: { implement: probe },
    emitComplete: emit,
    appendEvent: recorder(undefined),
    postReclaimMirror: () => {},
    liveness: () => "absent",
    now: () => BOOT + 60_000,
  });

  test("⭐ the pre-boot ghost is reclaimed — its committed work is COMPLETED, not discarded", () => {
    const { orch, sig } = ghostOrch({ dispatchedAtMs: BOOT - 6 * 60 * 60 * 1000 });
    const probe = recorder(true); // the work-done probe says the commits landed
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, sig, seams(probe, emit));
    // ⭐ Not "the slot was freed by writing a terminal" — the EXISTING reclaim
    // path ran, so a phase that finished before its daemon died is completed
    // through phase-agent-emit-complete rather than thrown away.
    expect(r).toBe("reclaimed");
    expect(probe.calls.length).toBe(1);
    expect(emit.calls.length).toBe(1);
  });

  test("a `running` pre-boot SDK worker reaches it too", () => {
    const { orch, sig } = ghostOrch({
      dispatchedAtMs: BOOT - 3 * 60 * 60 * 1000,
      status: "running",
    });
    const probe = recorder(true);
    const r = reclaimDeadWorkIfPossible(orch, sig, seams(probe, recorder({ code: 0 })));
    expect(r).toBe("reclaimed");
    expect(probe.calls.length).toBe(1);
  });

  // ⛔ The live-worker control at the same altitude. Same orchDir, same boot
  // marker, same bg-less shape — only the dispatch instant differs.
  test("⛔ a live same-boot `running` SDK worker is still a noop — the probe never runs", () => {
    const { orch, sig } = ghostOrch({ dispatchedAtMs: BOOT + 1000, status: "running" });
    const probe = recorder(true);
    const emit = recorder({ code: 0 });
    const r = reclaimDeadWorkIfPossible(orch, sig, seams(probe, emit));
    expect(r).toBe("noop");
    expect(probe.calls.length).toBe(0);
    expect(emit.calls.length).toBe(0);
  });

  // ⚠️ And the fail-closed half: with no boot marker on disk, the ghost is NOT
  // reclaimed. That is the pre-CTL-1851 behaviour, preserved deliberately — the
  // rules assert a proof and there is no evidence for it here.
  test("no daemon-boot.json → the ghost is held, not guessed at", () => {
    const { orch, sig } = ghostOrch({ dispatchedAtMs: BOOT - 6 * 60 * 60 * 1000 });
    writeFileSync(join(orch, "daemon-boot.json"), "not json");
    const probe = recorder(true);
    const r = reclaimDeadWorkIfPossible(orch, sig, seams(probe, recorder({ code: 0 })));
    expect(r).toBe("noop");
    expect(probe.calls.length).toBe(0);
  });
});
