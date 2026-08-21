// phase-dispatch-deadline.mjs — CTL-1851. When is a phase worker that carries NO
// background-job id provably gone?
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// `classifyWorker` (recovery.mjs) answers "unknown" for any signal whose
// liveness is not a live `bg` id, and `reclaimDeadWorkIfPossible` returns "noop"
// for "unknown". That is the whole of it: an SDK-executor worker NEVER has a
// bg_job_id — the prelaunch writes `bg_job_id: null` and nothing ever fills it
// in — so when one dies, nothing reclaims it, nothing revives it, nothing
// escalates it, and `isTicketInFlight` stays true forever. The slot is pinned by
// a worker that does not exist.
//
// MEASURED. mini, 2026-08-18 23:1x: two ghost `dispatched` signals from workers
// that had died 6 h and 3 h 38 m earlier held two of three slots, leaving the
// host at 1/3 capacity with 14 triaged-and-ready tickets queued behind them; the
// only live worker was CTL-2042's monitor-merge. It was cleared by a human
// (CTL-2053). Earlier, mini-2 2026-08-14: 3 owned eligible tickets, 4 free slots
// by the accounting, zero dispatches — the CTL-1851 report.
//
// ── ⭐ THE PROOF, AND WHY THIS IS NOT ONLY A TIMER ──────────────────────────
// The SDK executor runs its `query()` **in-process in the daemon**
// (dispatch.mjs: "the executor=sdk launch verb (in-process Agent SDK query())").
// So a daemon restart does not merely SUGGEST an in-process worker is dead — it
// PROVES it: the process that was running the agent no longer exists. The same
// argument is already accepted in this codebase for the other executor;
// readExecCoreBootEpoch's own comment reads "any --bg worker whose state.json
// mtime predates it is provably dead."
//
// Hence two rules, with very different epistemics, and both say so:
//
//   Rule 1 — DISPATCH PREDATES BOOT (proof). `dispatched|running`, no bg id,
//            executor `sdk`, and the dispatch instant precedes this daemon's
//            boot. Applies to `running` too, because the proof does not care what
//            the agent had got around to writing.
//
//   Rule 2 — NEVER STARTED (timer). `dispatched`, no bg id, this boot, older
//            than the ceiling. The skill flips `dispatched`→`running` on its
//            first turn, so a signal still at `dispatched` long after launch
//            never had a first turn. ⛔ `running` is deliberately NOT subject to
//            this rule: a live SDK phase legitimately runs for hours and a timer
//            over it would kill working agents.
//
// ── ⚠️ WHAT THE CALLER DOES WITH `dead`, AND WHY IT IS NOT A TERMINAL ───────
// This module never writes anything. Its verdict feeds `classifyWorker`, which
// hands the signal to the EXISTING CTL-574 reclaim path — so a phase that
// finished its work before the daemon died gets `phase-agent-emit-complete` via
// its work-done probe, and only a phase with nothing to show is revived or
// escalated. Writing a terminal here instead would have thrown away committed
// work in order to free a slot.
//
// ── ⛔ THE FALSE-POSITIVE THIS MUST NOT PRODUCE ─────────────────────────────
// The BASH executor also writes `bg_job_id: null` in its prelaunch and only
// fills it in after the spawn returns (phase-agent-dispatch:1591; the window is
// documented at :1435). A `claude --bg` worker DOES survive a daemon restart.
// ⛔ The age floor is NOT the guard for this — see IN_PROCESS_EXECUTOR_ID below;
// a daemon that died inside that window leaves a PERMANENTLY bg-less signal, so
// waiting longer makes it look more dead rather than less. The executor gate is
// the guard. The age floor remains, for the narrower case it is actually good
// for: a dispatch racing a boot-marker read.
//
// Zero-import leaf, like phase-yield.mjs: bare-Node loadable, pure, callable
// from the daemon, the scheduler and tests alike. Every reader is injected by
// the caller — this module does no I/O and cannot read a clock it was not given.

/**
 * ⛔ THE EXECUTOR THE RESTART PROOF IS VALID FOR — Codex #3694 P1, and the
 * correction to my own age-floor argument.
 *
 * I originally gated nothing on the executor and claimed the 5-minute age floor
 * covered the bash path's prelaunch window. ⛔ IT DOES NOT, and the reason is
 * that the floor is the wrong instrument for the hazard. The floor assumes the
 * dispatcher is still alive and about to write the job id a moment later. The
 * case that matters is the one where **the daemon exited inside that window**:
 * `phase-agent-dispatch` spawned `claude --bg`, the daemon died before
 * persisting the returned id, and the signal is now bg-less **permanently** —
 * nothing will ever fill it in. Five minutes later it is not "young"; it is a
 * bg-less record of a worker that is very much alive, because a `claude --bg`
 * job is detached and supervisor-managed and SURVIVES the restart. Rule 1 would
 * have declared it dead and the reclaim could dispatch a duplicate alongside it.
 *
 * The proof is not "no bg id" — it is "this worker ran INSIDE the daemon
 * process". Only one executor does:
 *
 *   `sdk`         in-process Agent SDK `query()` → dies with the daemon. ✅
 *   `codex-exec`  spawns `codex exec` as a child → MAY outlive it. ✋
 *   `bg`          detached `claude --bg`, supervisor-managed → survives. ✋
 *
 * The signal already records which (`executor`, written at prelaunch since
 * CTL-1457), so this costs one field read. An ABSENT executor holds: a
 * pre-CTL-1457 signal cannot prove it was in-process, and the cost of guessing
 * wrong is a duplicate worker.
 *
 * ⚠️ The literal is mirrored from `sdk-run-phase-agent.mjs`'s prelaunch
 * (`{ spawn, executorId: "sdk" }`) and held to it by `executor-id-parity` in
 * phase-dispatch-deadline.test.mjs — this is a zero-import leaf and cannot
 * import the constant, so the mirror is checked mechanically rather than
 * trusted. That test also asserts `CODEX_EXECUTOR_ID !== "sdk"`, so a future
 * rename cannot silently widen the proof to a spawned executor.
 */
export const IN_PROCESS_EXECUTOR_ID = "sdk";

/** Statuses a bg-less worker can be in while it still holds a slot. */
export const DISPATCH_PENDING_STATUS = "dispatched";
export const DISPATCH_RUNNING_STATUS = "running";

/**
 * Ceiling on time at `dispatched` before the worker is judged never to have
 * started. The skill's flip to `running` happens on the agent's FIRST turn, so
 * the honest window is model start-up — seconds to a couple of minutes. 30
 * minutes is 15–30× that, and matches MAX_YIELD_MS / Linear's session-stale
 * deadline so the fleet has one number to reason about rather than two.
 */
export const MAX_DISPATCHED_MS = 30 * 60 * 1000;

/**
 * Age floor below which NO rule fires. Covers the bash prelaunch window above
 * and any dispatch racing a boot-marker read. Deliberately generous: the cost of
 * waiting five more minutes is five minutes; the cost of reclaiming a live
 * worker is a duplicate.
 */
export const MIN_DISPATCH_AGE_MS = 5 * 60 * 1000;

/** Verdict reasons. Closed set — every branch names itself, none is unnamed. */
export const DISPATCH_DEADLINE_REASONS = Object.freeze([
  "dispatch-predates-boot", // ⭐ Rule 1 — proof: the in-process worker's daemon is gone
  "dispatch-never-started", // Rule 2 — timer: still `dispatched` past the ceiling
  "not-a-signal", // input was not an object
  "not-pending", // status is neither `dispatched` nor `running`
  "has-bg-job", // it HAS a bg id — the existing lifecycle machinery owns it
  "dispatch-start-unreadable", // ⚠️ cannot date the dispatch — cannot judge it
  "too-young", // inside the age floor; no rule may fire yet
  "boot-unreadable", // ⚠️ no boot instant — NEITHER rule can be evaluated
  "executor-not-in-process", // ⛔ a `bg`/`codex-exec` worker can OUTLIVE the daemon
  "executor-unknown", // ⚠️ pre-CTL-1457 signal — cannot prove it ran in-process
  "within-deadline", // dated, same boot, and not past the ceiling
]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Classify a bg-less phase signal's dispatch deadline.
 *
 * @param sig    the raw phase signal record (status / bg_job_id / startedAt).
 * @param opts.nowMs           epoch-ms now.
 * @param opts.bootedMs        epoch-ms of THIS daemon's boot, or null/undefined
 *                             when it cannot be read. ⛔ An unreadable boot
 *                             instant disables BOTH rules and the verdict is
 *                             `boot-unreadable` — never a guess. That is also the
 *                             DEFAULT, which is what makes every pre-existing
 *                             `classifyWorker` caller byte-identical until it
 *                             opts in.
 * @param opts.maxDispatchedMs Rule 2's ceiling.
 * @param opts.minAgeMs        the age floor below which no rule fires.
 *
 * @returns {{expired: boolean, reason: string, ageMs: number|null}}
 * `reason` is ALWAYS populated, including on `expired: false`, so a caller can
 * report WHY it declined rather than a bare false that is indistinguishable from
 * "I could not tell".
 */
export function classifyDispatchDeadline(
  sig,
  {
    nowMs = Date.now(),
    bootedMs = null,
    maxDispatchedMs = MAX_DISPATCHED_MS,
    minAgeMs = MIN_DISPATCH_AGE_MS,
  } = {}
) {
  if (!isPlainObject(sig)) return { expired: false, reason: "not-a-signal", ageMs: null };

  const status = String(sig.status);
  const pending = status === DISPATCH_PENDING_STATUS;
  const running = status === DISPATCH_RUNNING_STATUS;
  if (!pending && !running) return { expired: false, reason: "not-pending", ageMs: null };

  // A signal that HAS a bg id is owned by jobLifecycle — this module must not
  // second-guess it. `0` and `""` are not ids; a non-empty string is.
  const bg = sig.bg_job_id;
  if (typeof bg === "string" && bg !== "") {
    return { expired: false, reason: "has-bg-job", ageMs: null };
  }

  // ⛔ BOTH rules are gated on the executor, not just Rule 1. Rule 2's input — a
  // bg-less signal still at `dispatched` — is the SAME on-disk shape the
  // died-mid-launch bash case produces, so applying the timer to it would
  // reintroduce the duplicate by the other door. A `bg` launch that never
  // recorded its id already has its own machinery (`mark_launch_failed`,
  // CTL-511); this module deliberately does not compete with it.
  const executor = sig.executor;
  if (typeof executor !== "string" || executor === "") {
    return { expired: false, reason: "executor-unknown", ageMs: null };
  }
  if (executor !== IN_PROCESS_EXECUTOR_ID) {
    return { expired: false, reason: "executor-not-in-process", ageMs: null };
  }

  // ⚠️ UNREADABLE START HOLDS — the opposite of CTL-1854's yield, on purpose.
  // There, an unreadable anchor expired because the state is a PERMIT the agent
  // asked for and an unbounded permit is the harm. Here the signal describes a
  // worker that may be alive and working, and expiring on "I could not read the
  // date" would reclaim it on no evidence. The two fail directions are opposite
  // because the two risks are opposite.
  const startedMs = parseMs(sig.startedAt) ?? parseMs(sig.updatedAt);
  if (startedMs === null) {
    return { expired: false, reason: "dispatch-start-unreadable", ageMs: null };
  }
  if (!Number.isFinite(nowMs)) {
    // A caller that cannot tell the time cannot age anything either.
    return { expired: false, reason: "dispatch-start-unreadable", ageMs: null };
  }

  const ageMs = nowMs - startedMs;
  // The age floor applies to BOTH rules. A negative age (clock skew, or a
  // signal stamped in the future) is "too young" — never "very old".
  if (ageMs < minAgeMs) return { expired: false, reason: "too-young", ageMs };

  // ⛔ NO BOOT INSTANT → NO VERDICT, FOR EITHER RULE. Rule 1 obviously needs it.
  // Rule 2 needs it too, and the first cut of this module got that wrong: its
  // "same boot" clause was implicit, so with `bootedMs: null` the timer happily
  // expired a `dispatched` signal from ANY boot — which (a) is Rule 1's
  // territory decided without Rule 1's evidence, and (b) broke the compatibility
  // contract the caller-side default exists to keep. The
  // no-options-at-all test in phase-dispatch-deadline.test.mjs is what caught
  // it, on its first run, and it is there because a suite in which every test
  // injects is a suite in which the shipped default is untested.
  const boot = parseMs(bootedMs);
  if (boot === null) return { expired: false, reason: "boot-unreadable", ageMs };

  // Rule 1 — PROOF. Strictly `<`: a dispatch stamped at the same millisecond as
  // the boot is not proven to precede it.
  if (startedMs < boot) {
    return { expired: true, reason: "dispatch-predates-boot", ageMs };
  }

  // Rule 2 — TIMER, this boot, and only for `dispatched`.
  if (pending && ageMs > maxDispatchedMs) {
    return { expired: true, reason: "dispatch-never-started", ageMs };
  }
  return { expired: false, reason: "within-deadline", ageMs };
}

/** True only for the two verdicts that mean "this worker is gone". */
export function isDispatchExpiredReason(reason) {
  return reason === "dispatch-predates-boot" || reason === "dispatch-never-started";
}
