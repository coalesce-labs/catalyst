// sdk-run-phase-agent.mjs — the `executor=sdk` launch verb (CTL-1365b).
//
// Same SIGNATURE and RETURN SHAPE as dispatch.mjs:defaultRunPhaseAgent
//   ({ orchDir, ticket, phase, worktreePath, resumeSession, handoffPath,
//      attempt, clusterGeneration }) → { code, stdout, stderr, signal }
// — so it is drop-in beside the `--bg` path. `signal` is always null for the SDK
// (there is no killed-subprocess signal to surface), kept for shape parity so the
// scheduler reads ONE consistent result shape regardless of executor.
//
// ── How it REUSES the Stage-A shared pre-launch ─────────────────────────────
// The adversarial review (plan §"MUST-FIX" #1) established that the executor seam
// is the LAUNCH VERB, not the whole dispatch path: phase-agent-dispatch — NOT the
// phase skill — writes the initial status:"dispatched" signal AND the
// CATALYST_GENERATION fencing token (the skill template requires the signal to
// PRE-EXIST and only flips dispatched→running), runs the CTL-736 atomic
// single-flight claim, and performs the CTL-667/707 dispatch-time rebase. A raw
// query() would skip all of that and the skill would abort "signal file missing".
//
// So sdkRunPhaseAgent does NOT call query() directly. It runs the SAME
// phase-agent-dispatch script in `--launch-mode prelaunch-only` (Stage A seam),
// which performs the IDENTICAL pre-launch (claim + fenced "dispatched" signal +
// generation token + rebase + prompt/env/settings composition) and then, instead
// of spawning `claude --bg`, prints the resolved launch spec as one JSON line and
// exits 0. sdkRunPhaseAgent parses that spec and replaces ONLY the launch verb:
// it drives the phase skill through an in-process Agent SDK query() with the
// spec's worktreePath (cwd), prompt (the /catalyst-dev:phase-* slash command), and
// env (the composed CATALYST_* + fencing token + OTEL attrs). Everything upstream
// of the launch is byte-identical to the bg path (proven by phase-agent-dispatch
// test 70's prelaunch↔dry-run↔bg parity).
//
// ── The 3 worker contracts ──────────────────────────────────────────────────
//  1. Terminal event   phase.<name>.(complete|failed|turn-cap-exhausted|skipped).<ticket>
//     The phase SKILL emits this itself (it runs the identical phase body the bg
//     worker runs). sdkRunPhaseAgent adds a BACKSTOP emit — mirroring
//     phase-agent-dispatch's mark_launch_failed — for abnormal terminations
//     (error/cancel/interrupt/throw/no-result/turn-cap) where the skill never
//     reached its own emit, via phase-agent-emit-complete --no-signal-update.
//  2. Signal files + CATALYST_GENERATION fencing — written by the shared
//     pre-launch (status:"dispatched" + generation); the skill flips
//     dispatched→running→done/stalled. sdkRunPhaseAgent never writes them.
//  3. Phase prompt + CATALYST_* env — carried as the spec's prompt + plain env
//     (options.env). Because the SDK child inherits env normally, this collapses
//     the CTL-760/777 `--settings` env-bridge the bg path needs (that bridge only
//     existed because `claude --bg` is an RPC to a frozen-env daemon).
//
// ── Auth (plan §1c) ─────────────────────────────────────────────────────────
// Subscription auth ONLY: the env handed to query() always deletes
// ANTHROPIC_API_KEY + ANTHROPIC_AUTH_TOKEN (rungs 2-3 outrank the OAuth token and
// silently METER in headless mode) and sets CLAUDE_CODE_OAUTH_TOKEN. We never pass
// `--bare` / an API-key-reading settingSource. A dispatch-time assertion refuses
// to run (no claim, no signal) when ANTHROPIC_API_KEY is set or the OAuth token is
// missing — failing loud instead of silently metering.
//
// ── Concurrency + backoff (plan §1e) ────────────────────────────────────────
// The SDK has no built-in concurrency cap and mislabels 529 overloaded_error with
// no backoff. The daemon owns both: a process-wide semaphore sized from
// orchestration.maxParallel caps concurrent query() calls; 429/529 trigger bounded
// exponential backoff + jitter, emitting execution-core.sdk.overloaded for HUD
// backpressure, and on exhaustion return a failed result + a backstop failed event
// (never a silent drop).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getEventLogPath } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";
import { nodeClass } from "./lib/node-class.mjs";
import { registerSdkWorker as defaultRegisterSdkWorker } from "./sdk-worker-registry.mjs";

// phase-agent-dispatch + phase-agent-emit-complete sit one directory up.
const PHASE_AGENT_DISPATCH_BIN = fileURLToPath(
  new URL("../phase-agent-dispatch", import.meta.url),
);
const EMIT_COMPLETE_BIN = fileURLToPath(
  new URL("../phase-agent-emit-complete", import.meta.url),
);

// CTL-1367 item 12: the SAME ceiling the bg dispatcher (dispatch.mjs
// getDispatchTimeoutMs / phase-agent-dispatch via CATALYST_DISPATCH_TIMEOUT_MS)
// puts on the synchronous phase-agent-dispatch spawn. The SDK path runs the
// IDENTICAL prelaunch via spawnSync; without this bound a wedged
// worktree/rebase/recreate in the shared prelaunch blocks the whole daemon
// indefinitely (no rc, no failure ladder). Read lazily so tests/operators can
// override at runtime.
const getPrelaunchTimeoutMs = () =>
  Number(process.env.CATALYST_DISPATCH_TIMEOUT_MS) || 15 * 60 * 1000;

// ── Async semaphore ─────────────────────────────────────────────────────────
// A minimal counting semaphore: acquire() resolves when a slot is free, the
// returned release() frees it. Sized from maxParallel so the daemon never has
// more than N concurrent in-process query() calls (the SDK cap the runtime omits).
// This sits BELOW the existing HRW/admission gate (which decides WHICH tickets
// run) — it caps concurrent query() calls only, so the two never double-count: a
// ticket admitted by HRW simply waits here for a query slot, it is not re-gated.
export class Semaphore {
  constructor(max) {
    this.max = Math.max(1, Number.isFinite(max) ? Math.floor(max) : 1);
    this._active = 0;
    this._waiters = [];
  }
  get active() {
    return this._active;
  }
  async acquire() {
    if (this._active < this.max) {
      this._active += 1;
      return () => this._release();
    }
    // CTL-1367 item 10: park until a slot is HANDED to us. We do NOT increment
    // _active after the await — `_release` keeps the count constant across the
    // handoff (the departing holder's slot transfers straight to this waiter), so
    // a concurrent `acquire()` can never slip into the decrement→increment gap and
    // push active past max.
    await new Promise((resolve) => this._waiters.push(resolve));
    return () => this._release();
  }
  _release() {
    // CTL-1367 P2-H (WITHHOLD on shrink): if a SHRINK left us ABOVE the (lowered)
    // cap, a release must DRAIN toward the new max — NOT hand the freed slot to a
    // parked waiter. Handing it over keeps `active` pinned above the cap forever
    // (active stays constant across a handoff), so the lowered limit would never
    // take effect. Decrement instead; the waiter stays parked until active has
    // drained back to/below max (or a later GROW wakes it). Preserves the
    // exceed-max invariant (active only ever decreases here).
    if (this._active > this.max) {
      this._active -= 1;
      return;
    }
    // CTL-1367 item 10: at/below the cap, if a waiter is parked, hand it the slot
    // directly (active is unchanged — one holder swapped for the next). Only when no
    // one is waiting does the slot actually free (active--). This closes the
    // exceed-max race.
    const next = this._waiters.shift();
    if (next) {
      next();
    } else {
      this._active -= 1;
    }
  }
  // CTL-1367 item 10: re-size in place. The old sharedSemaphore() replaced the
  // whole instance when maxParallel changed, abandoning parked waiters (their
  // promises never resolved → deadlock). Mutating `max` keeps every parked waiter
  // attached.
  //
  // CTL-1367 P2-H: on a GROW, eagerly wake parked waiters into the newly-created
  // slots (FIFO) instead of leaving them parked until the next `_release` — up to
  // (newMax − active) of them. Each woken waiter takes a NEW slot, so active++ here
  // (NOT a hand-off transfer like `_release`, where the count stays constant). The
  // loop condition `_active < max` bounds it so active can never exceed the (raised)
  // cap. A SHRINK only lowers `max`; held slots drain toward it as their holders
  // release — `_release` WITHHOLDS the freed slot from waiters while active > max
  // (see above), so the lowered cap actually takes hold instead of being defeated
  // by a release→waiter handoff.
  setMax(max) {
    this.max = Math.max(1, Number.isFinite(max) ? Math.floor(max) : 1);
    while (this._active < this.max && this._waiters.length > 0) {
      const next = this._waiters.shift();
      this._active += 1;
      next();
    }
  }
}

// One process-wide semaphore, lazily created at the configured size. The daemon
// is a single process, so a module-level singleton is the right scope for the
// fleet-wide concurrency cap. Tests inject their own Semaphore.
let _sharedSemaphore = null;
function sharedSemaphore(maxParallel) {
  if (_sharedSemaphore) {
    // CTL-1367 item 10: mutate in place — NEVER re-create — so parked waiters are
    // never abandoned when maxParallel changes between ticks.
    if (_sharedSemaphore.max !== maxParallel) _sharedSemaphore.setMax(maxParallel);
    return _sharedSemaphore;
  }
  _sharedSemaphore = new Semaphore(maxParallel);
  return _sharedSemaphore;
}

// resolveMaxParallel — the concurrency cap. CATALYST_SDK_MAX_PARALLEL overrides
// (test/tuning) then the generic CATALYST_MAX_PARALLEL, else the same default 3 the
// scheduler uses. Never returns < 1.
export function resolveMaxParallel(env = process.env) {
  const raw = env.CATALYST_SDK_MAX_PARALLEL ?? env.CATALYST_MAX_PARALLEL;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 3;
}

// ── Auth guard (plan §1c) ───────────────────────────────────────────────────
// assertSdkAuth — refuse to dispatch under sdk when the env would silently meter.
// Returns { ok, reason }. `ok:false` means: ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)
// is set in the ambient env (rungs 2-3 would override the subscription token), OR
// the OAuth token is missing (nothing to authenticate the subscription). Pure;
// never throws. Exported so the daemon boot assertion (plan §1c) can reuse it.
export function assertSdkAuth({ env = process.env, oauthToken } = {}) {
  if (env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      reason:
        "ANTHROPIC_API_KEY is set — refusing to dispatch under executor=sdk (would silently meter; unset it and authenticate via CLAUDE_CODE_OAUTH_TOKEN)",
    };
  }
  if (env.ANTHROPIC_AUTH_TOKEN) {
    return {
      ok: false,
      reason:
        "ANTHROPIC_AUTH_TOKEN is set — refusing to dispatch under executor=sdk (overrides the subscription OAuth token)",
    };
  }
  if (!oauthToken) {
    return {
      ok: false,
      reason:
        "CLAUDE_CODE_OAUTH_TOKEN is missing — refusing to dispatch under executor=sdk (run `claude setup-token`)",
    };
  }
  return { ok: true, reason: null };
}

// resolveSdkBootExecutor — CTL-1367 item 9 + P3 observability. The DAEMON-BOOT
// executor gate: if executor=sdk but the subscription-auth precondition fails
// (ANTHROPIC_API_KEY set → would silently meter, or CLAUDE_CODE_OAUTH_TOKEN missing →
// nothing to authenticate the subscription), degrade the WHOLE boot to "bg" rather
// than letting every per-dispatch sdk attempt refuse/meter. Beyond the existing WARN
// log it ALSO emits a structured observability event so the silent bg-fallback is
// VISIBLE in monitoring — this matters because the daemon's launchd env can diverge
// from doctor's PASS (the operator shell that ran doctor has the OAuth token; the
// daemon may not), and without an event the divergence is invisible. Pure +
// best-effort: `assertAuth`/`emitEvent`/`log` are injectable; emit/log throws are
// swallowed; returns the effective executor regardless. For executor != "sdk" it is
// a pure pass-through (no auth check, no event) → byte-identical to bg/oneshot-legacy.
export function resolveSdkBootExecutor(
  executor,
  {
    env = process.env,
    oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN,
    assertAuth = assertSdkAuth,
    emitEvent, // ({ "event.name", payload }) => append to the unified event log
    log: logger,
  } = {},
) {
  if (executor !== "sdk") return { executor, fellBack: false, reason: null };
  const auth = assertAuth({ env, oauthToken });
  if (auth.ok) return { executor, fellBack: false, reason: null };
  if (logger?.warn) {
    try {
      logger.warn(
        { reason: auth.reason },
        "execution-core: executor=sdk requested but the subscription-auth precondition FAILED — falling back to executor=bg for this boot (fix the env and restart to arm sdk)",
      );
    } catch {
      /* logging must never break boot */
    }
  }
  if (emitEvent) {
    try {
      emitEvent({
        "event.name": "execution-core.executor.bg-fallback",
        payload: { requested: "sdk", effective: "bg", reason: auth.reason },
      });
    } catch {
      /* best-effort observability — never break boot */
    }
  }
  return { executor: "bg", fellBack: true, reason: auth.reason };
}

// ── Default seams (overridable for tests; default = real) ───────────────────

// defaultRunQuery — lazily import the Agent SDK so the module loads (and its tests
// run) WITHOUT the SDK installed. Returns an async iterable of streamed messages.
// Tests inject a fake async-iterable and never touch the real SDK / network.
function defaultRunQuery({ prompt, options }) {
  return (async function* () {
    // Non-literal specifier so bun build's static resolution check (CI import
    // graph) skips it — literal dynamic imports are still statically resolved
    // even when lazy (same trap as vite + bun:sqlite, PR #1561). The SDK is an
    // optionalDependency, loaded only at runtime where the executor=sdk path runs.
    const sdkPkg = ["@anthropic-ai", "claude-agent-sdk"].join("/");
    const { query } = await import(sdkPkg);
    for await (const m of query({ prompt, options })) yield m;
  })();
}

// defaultEmitEvent — observability events (execution-core.sdk.overloaded /
// execution-core.auth.misconfigured). These are non-phase, non-routed events, so
// the default is a dependency-free best-effort stderr line; the daemon injects a
// real unified-event-log writer at the dispatch seam. Never throws.
function defaultEmitEvent(name, payload) {
  try {
    process.stderr.write(
      `[sdk-run-phase-agent] ${name} ${JSON.stringify(payload ?? {})}\n`,
    );
  } catch {
    /* best-effort */
  }
}

// defaultEmitBackstop — emit the canonical terminal event as a BACKSTOP, mirroring
// phase-agent-dispatch:mark_launch_failed (phase-agent-emit-complete with
// --no-signal-update so the skill/pre-launch keeps ownership of the signal file).
// Best-effort; never throws.
export function defaultEmitBackstop(
  { phase, ticket, status, reason, orchDir, signalFile },
  {
    spawn = spawnSync,
    writeSignalStalled = defaultWriteSignalStalled,
    writeSignalTerminal = defaultWriteSignalTerminal,
    appendEventLog = defaultAppendEventLog,
  } = {},
) {
  // Step 1 (CTL-1367 item 4 + P2-F): mirror mark_launch_failed — flip the signal to
  // a TERMINAL status BEFORE the event-only emit. The bg path jq-writes stalled
  // first; the SDK backstop used to ONLY emit, so the signal stayed at
  // dispatched/running and reclaim saw the worker in-flight forever.
  //
  // CTL-1367 P2-F: the signal status MUST MATCH the backstop's terminal event.
  // A turn-cap-exhausted backstop emits phase.<phase>.turn-cap-exhausted, so the
  // signal must read "turn-cap-exhausted" — NOT "stalled". The terminal sweep
  // applies needs-human to stalled/failed signals, so an unconditional "stalled"
  // write here would mislabel a max-turns outcome as operator-stalled even though
  // the event stream says turn-cap-exhausted. Every other abnormal backstop
  // (failed / overloaded-exhausted) still writes "stalled".
  if (signalFile) {
    if (status === "turn-cap-exhausted") {
      writeSignalTerminal(signalFile, "turn-cap-exhausted", reason);
    } else {
      writeSignalStalled(signalFile, reason);
    }
  }

  // Step 2 (CTL-1367 item 5): emit with --no-signal-update (step 1 owns the
  // signal), then INSPECT the result instead of swallowing it — a missing/failing
  // emit binary falls back to a direct event-log append so the terminal event is
  // never silently dropped.
  const args = [
    "--phase", phase,
    "--ticket", ticket,
    "--status", status,
    "--orch-dir", orchDir,
    "--orch-id", ticket,
    "--no-signal-update",
  ];
  if (reason) args.push("--reason", reason);
  let res;
  try {
    res = spawn(EMIT_COMPLETE_BIN, args, { encoding: "utf8" });
  } catch (err) {
    res = { error: err };
  }
  // CTL-1367 item 5 + P2-E + P3 (DOCUMENTED DECISION): fall back to the direct
  // event-log append whenever the emit binary did NOT cleanly succeed. A clean
  // success is the ONLY no-fallback case: status === 0, no spawn error, AND no
  // terminating signal. Everything else falls back:
  //   • spawn error / ENOENT (res.error)               — binary missing/unspawnable
  //   • non-zero exit                                   — bad args / pre-write crash
  //   • CTL-1367 P2-E: SIGKILL/OOM — spawnSync returns status:null + a non-null
  //     `signal`. The OLD predicate keyed only on `typeof status === "number"`, so a
  //     signal-killed emit (status null) looked like success and SILENTLY DROPPED the
  //     terminal event. Treat any non-null signal (or a null/non-number status) as a
  //     failed emit so the fallback runs.
  // A non-zero/killed exit where the binary already WROTE the event then died yields
  // a DUPLICATE terminal event, but phase-advance is IDEMPOTENT (the broker/advance
  // dedupes on the terminal-status signal), so a duplicate is harmless. We
  // deliberately prefer a harmless duplicate over a possible silent drop.
  const emitFailed =
    !res ||
    res.error != null ||
    res.signal != null ||
    typeof res.status !== "number" ||
    res.status !== 0;
  if (emitFailed) {
    appendEventLog({ phase, ticket, status, reason });
  }
}

// ── Secret scrubbing (CTL-1367 item 11) ─────────────────────────────────────
// Returned stderr (thrown error messages, pre.stderr) can echo the env we built —
// which carries CLAUDE_CODE_OAUTH_TOKEN and may transit ANTHROPIC_* keys. Scrub
// token-shaped substrings AND any known literal secrets before returning so a
// dispatch-failure log / event never leaks a credential. Pure; never throws.
export function scrubSecrets(s, secrets = []) {
  if (typeof s !== "string" || s.length === 0) return s;
  let out = s;
  // Redact known literal secret values first (most precise).
  for (const sec of secrets) {
    if (typeof sec === "string" && sec.length >= 8) {
      out = out.split(sec).join("[redacted]");
    }
  }
  // Then redact token-SHAPED substrings the SDK / CLI might surface independently.
  out = out
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted-token]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted-token]")
    .replace(/\blin_(?:oauth|api)_[A-Za-z0-9]{8,}/g, "[redacted-token]")
    .replace(
      /\b(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)=\S+/g,
      "$1=[redacted]",
    );
  return out;
}

// CTL-1367 P3: the phase-signal statuses the backstop must NEVER clobber — a
// TERMINAL status the phase SKILL (or a prior backstop) already wrote. Flipping a
// done/complete SUCCESS to "stalled" would falsely strand a phase that actually
// finished; the backstop's job is only to rescue a still-in-flight
// (dispatched/running) signal whose worker died without emitting its own terminal
// event. Mirrors signal-reader.mjs's TERMINAL set (done/failed/stalled/skipped/
// turn-cap-exhausted) plus the success synonyms a skill might write (complete/
// completed). failed/stalled/turn-cap-exhausted are already-terminal too, so
// re-flipping them is a pointless write we also skip.
const SIGNAL_TERMINAL_STATUSES = new Set([
  "done",
  "complete",
  "completed",
  "failed",
  "stalled",
  "skipped",
  "turn-cap-exhausted",
]);

// defaultWriteSignalStalled — CTL-1367 item 4. Mirror phase-agent-dispatch's
// mark_launch_failed: flip the phase signal to status:"stalled" with an
// `attentionReason` (NOT `failureReason` — a failureReason trips revive Loop 2's
// escalate branch, which does NOT retry). Atomic write (tmp + rename) so a
// concurrent reader never sees a half-written file. Best-effort; never throws.
//
// CTL-1367 P3: refuses to flip a signal whose current on-disk status is already
// TERMINAL (SIGNAL_TERMINAL_STATUSES) — most importantly a done/complete success
// the phase skill wrote between the launch and an abnormal-looking termination. The
// backstop only flips a still-in-flight (dispatched/running) signal.
//
// CTL-1367 P2-F: defaultWriteSignalTerminal is the generalized writer — it flips the
// signal to ANY terminal `status` so the on-disk signal MATCHES the backstop's
// terminal event (a turn-cap-exhausted backstop must leave "turn-cap-exhausted", not
// "stalled"; the terminal sweep applies needs-human only to stalled/failed). The P3
// terminal-clobber guard and the atomic tmp+rename are shared by every status.
function defaultWriteSignalTerminal(signalFile, status, reason) {
  try {
    let sig;
    try {
      sig = JSON.parse(readFileSync(signalFile, "utf8"));
    } catch {
      return; // no signal to flip (prelaunch never wrote one) — nothing to do
    }
    if (!sig || typeof sig !== "object") return;
    // CTL-1367 P3: never clobber a terminal status (esp. a done/complete success).
    if (SIGNAL_TERMINAL_STATUSES.has(String(sig.status))) return;
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    sig.status = status;
    sig.attentionReason = reason || "sdk-backstop";
    sig.updatedAt = ts;
    sig.phaseTimestamps = { ...(sig.phaseTimestamps ?? {}), [status]: ts };
    const tmp = `${signalFile}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(sig));
    renameSync(tmp, signalFile);
  } catch {
    /* best-effort — reclaim will still pick up the terminal event */
  }
}

// defaultWriteSignalStalled — CTL-1367 item 4. Thin back-compat wrapper over
// defaultWriteSignalTerminal that writes status:"stalled" with an `attentionReason`
// (NOT `failureReason` — a failureReason trips revive Loop 2's escalate branch,
// which does NOT retry). Mirror of phase-agent-dispatch's mark_launch_failed. The
// 2-arg shape is the seam defaultEmitBackstop injects for the failed/overloaded
// (non-turn-cap) backstops.
function defaultWriteSignalStalled(signalFile, reason) {
  return defaultWriteSignalTerminal(signalFile, "stalled", reason);
}

// CTL-1410 Phase A: the SDK success-branch signal flip. When query() resolves
// subtype==="success", mapResult returns backstop:null — historically the phase
// SKILL was solely responsible for flipping its own signal to done (via the
// phase-agent-emit-complete wrapper). That holds now that the two event-only
// phases (triage, monitor-deploy) route their terminal emit through the wrapper,
// but this is the in-process belt-and-suspenders net: on a clean success, if the
// signal is STILL in-flight (dispatched|running) — the skill exited 0 without its
// own flip — flip it to done here so occupancy (countSdkInflight) releases the
// slot and deriveAdvancement sees a terminal status. Under executor=sdk there is
// no bg reclaim path to synthesize the flip, so without this a success that
// skipped its wrapper call would strand the slot.
//
// Distinct from defaultWriteSignalTerminal on purpose:
//   - acts ONLY on an in-flight (dispatched|running) signal — it NEVER resurrects
//     a parked (needs-input) hold into done, and never clobbers an already-terminal
//     status (done/failed/skipped/turn-cap-exhausted);
//   - honors the CTL-736 generation fence — a stale superseded worker must NOT
//     write an outcome (see below);
//   - writes status:"done" + completedAt (a SUCCESS terminal), no attentionReason
//     (an attentionReason/failureReason would trip revive's escalate branch).
const SIGNAL_INFLIGHT_STATUSES = new Set(["dispatched", "running"]);

// Plain-integer test shared by the generation fence — mirrors the bash
// `[[ $x =~ ^[0-9]+$ ]]` in phase-agent-emit-complete and claim.mjs's
// isCurrentGeneration semantics exactly.
const isPlainInt = (v) => /^[0-9]+$/.test(String(v));

export function flipSignalDoneOnSuccess(signalFile, generation) {
  if (!signalFile) return;
  try {
    let sig;
    try {
      sig = JSON.parse(readFileSync(signalFile, "utf8"));
    } catch {
      return; // no signal on disk (prelaunch never wrote one) — nothing to flip
    }
    if (!sig || typeof sig !== "object") return;
    // In-flight-only precondition. A terminal signal is already correct; a
    // needs-input (parked) signal must stay parked.
    if (!SIGNAL_INFLIGHT_STATUSES.has(String(sig.status))) return;
    // CTL-736 generation fence (adversarial-review catch, CTL-1410 Phase A): an
    // in-process query cannot be killed (preemption's killBgJob(null) is a no-op,
    // the per-attempt AbortController is not externally wired), so a preempt→
    // re-dispatch or revive leaves a stale gen-N query floating while gen-N+1 owns
    // the SAME signal path. That stale worker's skill correctly bows out at the
    // wrapper's fence — this flip must not override that refusal by flipping the
    // newer dispatch's in-flight signal to done (slot over-admission + premature
    // advancement). Bow out ONLY when both generations are plain integers AND
    // mine < signal's; anything missing/non-numeric fails open so legacy and
    // unfenced dispatches are unaffected (isCurrentGeneration parity).
    if (isPlainInt(generation) && isPlainInt(sig.generation) && Number(generation) < Number(sig.generation)) {
      return;
    }
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    sig.status = "done";
    sig.completedAt = ts;
    sig.updatedAt = ts;
    sig.phaseTimestamps = { ...(sig.phaseTimestamps ?? {}), done: ts };
    const tmp = `${signalFile}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(sig));
    renameSync(tmp, signalFile);
  } catch {
    /* best-effort — the skill's own wrapper flip is the primary path */
  }
}

// defaultAppendEventLog — CTL-1367 item 5. Last-resort terminal-event append when
// the phase-agent-emit-complete binary is missing or fails. Writes one canonical
// v2 envelope `phase.<phase>.<status>.<ticket>` to the unified event log so the
// terminal event is NEVER silently dropped (the broker routes on
// attributes["event.name"]). Best-effort; never throws.
function defaultAppendEventLog({ phase, ticket, status, reason }) {
  try {
    const path = getEventLogPath();
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      resource: {
        "service.name": "catalyst.execution-core",
        "service.namespace": "catalyst",
        "catalyst.node.class": nodeClass(),
      },
      attributes: {
        "event.name": `phase.${phase}.${status}.${ticket}`,
        "linear.issue.identifier": ticket,
        "catalyst.worker.ticket": ticket,
      },
      body: { message: reason ?? `sdk backstop: ${status}` },
    });
    appendFileSync(path, line + "\n");
  } catch {
    /* best-effort — the emit binary is the primary path */
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Overloaded (429/529) detection ──────────────────────────────────────────
const OVERLOADED_STATUSES = new Set([429, 529]);

function statusOf(x) {
  // Tolerate a few shapes the SDK / underlying API surface uses.
  return (
    x?.api_error_status ??
    x?.status ??
    x?.statusCode ??
    x?.error?.status ??
    null
  );
}

// isOverloadedResult — a terminal result that is a 429/529 overload, or an
// overloaded_error subtype.
function isOverloadedResult(result) {
  if (!result) return false;
  const s = statusOf(result);
  if (OVERLOADED_STATUSES.has(Number(s))) return true;
  const t = result.error?.type ?? result.error_type;
  return t === "overloaded_error";
}

// isOverloadedError — a thrown error that is a 429/529 overload.
function isOverloadedError(err) {
  if (!err) return false;
  const s = statusOf(err);
  if (OVERLOADED_STATUSES.has(Number(s))) return true;
  const t = err?.error?.type ?? err?.type;
  if (t === "overloaded_error") return true;
  return /\b(429|529|overloaded)\b/i.test(String(err?.message ?? ""));
}

// backoffMs — exponential backoff (base·2^i) capped, plus full jitter. `random`
// is injectable so the backoff test is deterministic.
function backoffMs(i, { baseMs = 1000, capMs = 30000, random = Math.random } = {}) {
  const ceil = Math.min(capMs, baseMs * 2 ** i);
  return Math.floor(ceil * (0.5 + 0.5 * random())); // 50%-100% of the ceiling
}

// ── The run loop ────────────────────────────────────────────────────────────

// ── Prelaunch-spec recovery contract (CTL-1367 item 15) ─────────────────────
// The prelaunch emits the resolved launch spec as a JSON line on stdout. The
// original parser took the LAST parseable JSON line, which is brittle: a trailing
// log line that happens to be valid JSON would be mis-selected as the spec.
//
// CONTRACT (documented decision): we do NOT prefix the spec with a sentinel or
// move it to a dedicated fd, because the protected phase-agent-dispatch test
// (Test 68/70) asserts the prelaunch-only stdout is RAW JSON (`echo "$SPEC" | jq`)
// — a prefix would break it. Instead we select STRUCTURALLY: scanning from the
// last line, the spec is the JSON object that carries the dispatch-spec shape
// (string `ticket` + `phase` + `status`, with `status` in the closed set of
// dispatch statuses). A stray JSON log line lacks that shape and is skipped. This
// is an explicit contract on the object's STRUCTURE rather than its POSITION.
const PRELAUNCH_SPEC_STATUSES = new Set([
  "prelaunch-ready", // a fresh dispatch — proceed to query()
  "dispatched",      // idempotent: an in-flight worker already owns this phase
  "running",         // idempotent: ditto
  "done",            // idempotent: already completed
  "claim-lost",      // idempotent: a concurrent dispatcher won the single-flight claim
]);

function isLaunchSpec(obj) {
  return (
    obj != null &&
    typeof obj === "object" &&
    typeof obj.ticket === "string" &&
    typeof obj.phase === "string" &&
    typeof obj.status === "string" &&
    PRELAUNCH_SPEC_STATUSES.has(obj.status)
  );
}

// runPrelaunch — invoke phase-agent-dispatch in prelaunch-only mode (the Stage-A
// shared pre-launch) and return the parsed launch spec. Builds the SAME arg array
// + env as dispatch.mjs:defaultRunPhaseAgent (so the pre-launch behaves
// identically) plus `--launch-mode prelaunch-only`. Returns
// { ok, idempotent, spec, code, stderr }:
//   • ok          — a fresh prelaunch-ready spec; the caller drives query().
//   • idempotent  — the prelaunch was a NO-OP (an existing dispatched/running/done
//                   signal, or a lost single-flight claim). NOT a failure (item 18):
//                   the existing/winning worker owns the phase; the caller returns
//                   success without launching query().
function runPrelaunch(
  { orchDir, ticket, phase, worktreePath, resumeSession, handoffPath, attempt, clusterGeneration },
  { spawn = spawnSync } = {},
) {
  const args = [
    "--phase", phase,
    "--ticket", ticket,
    "--orch-dir", orchDir,
    "--orch-id", ticket,
    "--launch-mode", "prelaunch-only",
  ];
  if (resumeSession) args.push("--resume-session", resumeSession);
  if (attempt != null) args.push("--attempt", String(attempt));
  const extraEnv = {};
  if (handoffPath) extraEnv.CATALYST_HANDOFF_PATH = handoffPath;
  if (clusterGeneration != null) extraEnv.CATALYST_CLUSTER_GENERATION = String(clusterGeneration);
  const env = {
    ...process.env,
    CATALYST_ORCHESTRATOR_DIR: orchDir,
    CATALYST_ORCHESTRATOR_ID: ticket,
    CATALYST_PHASE: phase,
    CATALYST_TICKET: ticket,
    CATALYST_EXECUTION_CORE: "1",
    ...extraEnv,
  };
  delete env.CATALYST_RECREATE_ATTEMPTED; // per-dispatch marker (mirror dispatch.mjs)
  const res = spawn(PHASE_AGENT_DISPATCH_BIN, args, {
    cwd: worktreePath,
    encoding: "utf8",
    env,
    // CTL-1367 item 12: bound the synchronous prelaunch exactly like the bg
    // dispatcher does — a wedged worktree/rebase/recreate must surface as a failed
    // dispatch, not block the daemon. SIGKILL because a wedged dispatch may ignore
    // SIGTERM mid-exec-loop (mirrors dispatch.mjs defaultRunPhaseAgent).
    timeout: getPrelaunchTimeoutMs(),
    killSignal: "SIGKILL",
  });
  const code = res.error ? 127 : (res.status ?? 0);
  const stderr = res.error
    ? (res.stderr && res.stderr.length ? res.stderr : res.error.message)
    : (res.stderr ?? "");
  // Structural spec recovery (item 15): the LAST line that is a valid launch spec.
  let spec = null;
  const lines = String(res.stdout ?? "").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (isLaunchSpec(obj)) {
        spec = obj;
        break;
      }
    } catch {
      /* not a JSON line */
    }
  }
  const ok = code === 0 && spec != null && spec.status === "prelaunch-ready";
  // CTL-1367 item 18: an exit-0 prelaunch whose spec is an idempotent no-op
  // (claim-lost, or an existing dispatched/running/done signal) is SUCCESS, not a
  // "shared pre-launch failed". Distinguish it so the caller can return cleanly.
  const idempotent =
    code === 0 &&
    spec != null &&
    spec.status !== "prelaunch-ready" &&
    (spec.idempotent === true || PRELAUNCH_SPEC_STATUSES.has(spec.status));
  return { ok, idempotent, spec, code, stderr };
}

// buildSdkEnv — the env handed to query(), built from the shared-pre-launch spec's
// composed env array (KEY=VALUE strings: CATALYST_* + CATALYST_GENERATION fencing
// token + OTEL attrs) layered over process.env, with the auth guards applied. This
// is plain env (Contract 3) — it REPLACES the CTL-760/777 --settings bridge.
export function buildSdkEnv(specEnv, { base = process.env, oauthToken, settingsEnv } = {}) {
  const env = { ...base };
  // CTL-1367 item 8: layer the spec's settings.env FIRST — this is the object the
  // bg path threads through `claude --bg --settings '{"env":{…}}'` and it carries
  // the telemetry keys (OTEL_* / CLAUDE_CODE_ENABLE_TELEMETRY). Without layering it
  // the in-process SDK worker would run telemetry-DISABLED. The spec.env ARRAY
  // (post-composition CATALYST_* + fencing token + OTEL_RESOURCE_ATTRIBUTES) is
  // layered AFTER so its explicit values win on any overlap.
  if (settingsEnv && typeof settingsEnv === "object") {
    for (const [k, v] of Object.entries(settingsEnv)) {
      if (typeof k === "string" && k.length > 0) env[k] = String(v);
    }
  }
  for (const kv of specEnv ?? []) {
    const idx = String(kv).indexOf("=");
    if (idx <= 0) continue;
    env[kv.slice(0, idx)] = kv.slice(idx + 1);
  }
  // AUTH GUARD: subscription only. Rungs 2-3 outrank the OAuth token + silently
  // meter in headless mode — always strip them; set the OAuth token.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  delete env.CATALYST_RECREATE_ATTEMPTED;
  return env;
}

// pluginsForSdk — map the prelaunch spec's pluginDirs (an array of absolute paths)
// to the Agent SDK `plugins` option shape (CTL-1367 item 8). Verified against
// @anthropic-ai/claude-agent-sdk sdk.d.ts: `plugins?: SdkPluginConfig[]` where
// `SdkPluginConfig = { type: 'local', path: string }`. Without this the
// /catalyst-dev:phase-* plugin skills the prompt invokes never resolve.
function pluginsForSdk(pluginDirs) {
  if (!Array.isArray(pluginDirs)) return [];
  return pluginDirs
    .filter((p) => typeof p === "string" && p.length > 0)
    .map((path) => ({ type: "local", path }));
}

// buildQueryOptions — the query() options. `--bare` is NEVER set; settingSources is
// always ["user","project"] (NEVER [] — that hides the plugin phase skills).
export function buildQueryOptions(spec, env, { turnCap } = {}) {
  const options = {
    cwd: spec.worktreePath,
    env, // plain env — replaces the CTL-760/777 --settings bridge
    executable: "bun", // #266: avoid "Bun is not defined" under a Node spawn
    settingSources: ["user", "project"], // REQUIRED so plugin phase skills resolve
    permissionMode: "bypassPermissions", // unattended; skills self-gate via frontmatter
    // CTL-1367 item 13: bypassPermissions REQUIRES allowDangerouslySkipPermissions
    // (verified in sdk.d.ts: "Must be set to true when using
    // permissionMode: 'bypassPermissions'"). It is the in-process equivalent of the
    // bg path's `--dangerously-skip-permissions`; without it an unattended SDK
    // worker would prompt/fail on the first tool use.
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: "preset", preset: "claude_code" }, // keep CLI behavior
  };
  // CTL-1367 item 6: bound the run by the per-phase turn cap. Precedence: an
  // explicit option override (tests/tuning), else the spec's turnCap (the value
  // phase-agent-dispatch resolved for this phase). Without this the SDK ran
  // unbounded and turn-cap-exhausted could never fire.
  const cap = turnCap ?? spec.turnCap;
  if (cap != null) options.maxTurns = cap; // → error_max_turns → turn-cap-exhausted
  // CTL-1367 item 7: pin the per-phase model the dispatcher resolved (else the SDK
  // falls back to its own default model, ignoring per-phase model selection).
  if (typeof spec.model === "string" && spec.model.length > 0) options.model = spec.model;
  // CTL-1367 item 8: forward the resolved plugin dirs so /catalyst-dev:phase-*
  // skills resolve in-process.
  const plugins = pluginsForSdk(spec.pluginDirs);
  if (plugins.length > 0) options.plugins = plugins;
  if (spec.resumeSession) options.resume = spec.resumeSession; // cwd === worktreePath (set above)
  return options;
}

// mapResult — terminal SDK result → { code, stdout, stderr, signal } + the backstop
// emit decision. subtype "success" → code 0, NO backstop (the skill emitted
// complete). error_max_turns → turn-cap-exhausted backstop. anything else (error /
// cancelled / interrupted / no result) → failed backstop.
function mapResult(result) {
  if (!result) {
    return {
      result: { code: 1, stdout: "", stderr: "sdk: query ended with no terminal result", signal: null },
      backstop: { status: "failed", reason: "sdk-no-result" },
    };
  }
  if (result.subtype === "success" && !result.is_error) {
    return {
      result: { code: 0, stdout: result.result ?? "", stderr: "", signal: null },
      backstop: null,
    };
  }
  if (result.subtype === "error_max_turns") {
    return {
      result: { code: 1, stdout: result.result ?? "", stderr: "sdk: max turns exhausted", signal: null },
      backstop: { status: "turn-cap-exhausted", reason: "sdk-error-max-turns" },
    };
  }
  return {
    result: { code: 1, stdout: result.result ?? "", stderr: `sdk: ${result.subtype ?? "error"}`, signal: null },
    backstop: { status: "failed", reason: `sdk-${result.subtype ?? "error"}` },
  };
}

// extractNumTurns — CTL-1396 item B. `num_turns` is a standard Claude Agent SDK
// terminal-result field (how many turns the run actually took). Return it only when
// it is a finite number; otherwise null (older SDK / no terminal result / malformed
// value). Pure + total — never throws — so the phase-turns telemetry stays
// best-effort regardless of the SDK's result shape.
function extractNumTurns(result) {
  const n = result?.num_turns;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// extractContextUsage — CTL-1406. Derive context-window fill from the SDK terminal result
// so detached SDK workers can populate dashboard panels 50/51 (Context Window % / Turn),
// which the interactive statusline (catalyst-session.sh cmd_emit_context) never reaches in a
// background/SDK run. The used context at the final turn is the LAST iteration's input side
// (input + cache_read + cache_creation); the model's window is
// result.modelUsage[<model>].contextWindow (e.g. 1_000_000 for opus-4-8). Verified live
// against @anthropic-ai/claude-agent-sdk@0.3.195. Pure + total — returns null when the result
// lacks the fields (older SDK / no terminal result / zero usage) so the emit stays best-effort.
function extractContextUsage(result) {
  const iters = result?.usage?.iterations;
  const lastIter = Array.isArray(iters) && iters.length > 0 ? iters[iters.length - 1] : null;
  const u = lastIter ?? result?.usage ?? null;
  if (!u) return null;
  // Context fill at the final turn = the last call's input side (prompt + cache) PLUS its
  // output_tokens — those are appended to the transcript and count toward the window on any
  // resume/next turn, which is why the SDK's own compaction threshold includes them. Summing
  // input/cache only underreports the %. (CTL-1406, Codex P2.)
  const used =
    (Number(u.input_tokens) || 0) +
    (Number(u.cache_read_input_tokens) || 0) +
    (Number(u.cache_creation_input_tokens) || 0) +
    (Number(u.output_tokens) || 0);
  // Use the PRIMARY phase model's window — NOT modelUsage's first key. A mixed-model run (e.g.
  // a Haiku/Sonnet helper at 200k alongside the Opus phase model at 1M) would otherwise divide
  // the final-turn tokens by the wrong window and inflate/cap the %. The phase model dominates
  // token volume, so pick the modelUsage entry with the most input tokens. (CTL-1406, Codex P2.)
  let contextWindow = Number.NaN;
  let bestInput = -1;
  for (const m of Object.values(result?.modelUsage ?? {})) {
    const inTok = Number(m?.inputTokens) || 0;
    const cw = Number(m?.contextWindow);
    if (inTok > bestInput && Number.isFinite(cw) && cw > 0) {
      bestInput = inTok;
      contextWindow = cw;
    }
  }
  if (!Number.isFinite(used) || used <= 0 || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return { pct: Math.min(100, Math.round((used / contextWindow) * 100)), tokens: used, max: contextWindow };
}

// defaultEmitContextEvent — CTL-1406. Append a `session.context` event so detached SDK phase
// workers feed dashboard panels 50/51. The panels select {service_name="catalyst.session"}
// |= "session.context" and unwrap `claude_context_used_pct` + `claude_turn` (the dotted attrs
// below become those underscored Loki structured-metadata names via the Alloy transform), with
// a {{linear_key}} legend (resource linear.key). So we emit that EXACT shape directly to the
// unified event log — distinct from emitEvent's defaultAppendOperatorEvent, which stamps
// service.name=catalyst.execution-core (the panels' selector would miss it). Best-effort: never
// throws — telemetry must not break a dispatch (mirrors defaultEmitEvent).
function defaultEmitContextEvent({ ticket, phase, pct, turn, tokens, max } = {}) {
  try {
    if (!Number.isFinite(pct)) return false;
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const resource = buildCatalystResource({ serviceName: "catalyst.session" });
    if (ticket) resource["linear.key"] = ticket;
    const attributes = { "event.name": "session.context", "claude.context.used_pct": pct };
    if (Number.isFinite(turn)) attributes["claude.turn"] = turn;
    if (Number.isFinite(tokens)) attributes["claude.context.tokens"] = tokens;
    if (ticket) attributes["linear.issue.identifier"] = ticket;
    const line =
      JSON.stringify({
        ts,
        id: randomBytes(8).toString("hex"),
        observedTs: ts,
        severityText: "INFO",
        severityNumber: 9,
        traceId: randomBytes(16).toString("hex"),
        spanId: randomBytes(8).toString("hex"),
        resource,
        attributes,
        body: {
          message: `session.context ${ticket ?? ""}`.trim(),
          payload: {
            context_pct: pct,
            context_tokens: Number.isFinite(tokens) ? tokens : null,
            context_max: Number.isFinite(max) ? max : null,
            turn: Number.isFinite(turn) ? turn : null,
            phase: phase ?? null,
          },
        },
      }) + "\n";
    const path = getEventLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line);
    return true;
  } catch {
    /* best-effort — a write/serialize failure must never break a dispatch */
    return false;
  }
}

// sdkRunPhaseAgent — the executor=sdk launch verb. async (the in-process query loop
// awaits the SDK stream), returns the defaultRunPhaseAgent shape.
export async function sdkRunPhaseAgent(
  { orchDir, ticket, phase, worktreePath, resumeSession, handoffPath, attempt, clusterGeneration },
  {
    runQuery = defaultRunQuery,
    oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN,
    turnCap,
    env: authEnv = process.env, // the AMBIENT env the auth guard inspects
    spawn = spawnSync, // for the prelaunch + backstop emit
    semaphore, // injectable; defaults to the process-wide shared one
    maxParallel = resolveMaxParallel(),
    emitEvent = defaultEmitEvent,
    emitContextEvent = defaultEmitContextEvent, // CTL-1406: session.context for panels 50/51
    emitBackstop = defaultEmitBackstop,
    sleep = defaultSleep,
    random = Math.random,
    maxRetries = 5, // bound the 429/529 backoff
    backoff = {}, // { baseMs, capMs } overrides for tests
    registerWorker = defaultRegisterSdkWorker, // CTL-1410 Phase B: the in-process worker registry
  } = {},
) {
  // ── AUTH GUARD: refuse BEFORE any side effect (no claim, no signal) ───────
  const auth = assertSdkAuth({ env: authEnv, oauthToken });
  if (!auth.ok) {
    emitEvent("execution-core.auth.misconfigured", { ticket, phase, reason: auth.reason });
    return { code: 1, stdout: "", stderr: auth.reason, signal: null };
  }

  // ── SHARED PRE-LAUNCH (claim + fenced "dispatched" signal + generation +
  //    rebase + prompt/env composition) via phase-agent-dispatch prelaunch-only ─
  const pre = runPrelaunch(
    { orchDir, ticket, phase, worktreePath, resumeSession, handoffPath, attempt, clusterGeneration },
    { spawn },
  );
  // CTL-1367 item 18: an idempotent prelaunch (claim-lost / existing
  // dispatched|running|done signal) is a NO-OP SUCCESS, NOT a failure — the
  // existing or winning worker owns the phase. Returning code 0 (no query, no
  // backstop) keeps a duplicate dispatch from tripping the dispatch-failure ladder.
  // CTL-1367 P2-G: for a claim-lost loser there is NO local signal (the WINNER owns
  // it). The consumer's SDK-aware verify treats that as benign via a YOUNG
  // single-flight claim (signal-reader:hasFreshClaim), so this no-op does not get
  // mis-recorded as verify_failed:signal_missing.
  if (pre.idempotent) {
    return { code: 0, stdout: "", stderr: "", signal: null };
  }
  if (!pre.ok) {
    // CTL-1367 P1-B: a prelaunch that DIED (timeout / SIGKILL / spawn error) AFTER
    // writing its status:"dispatched" signal but BEFORE printing the spec returns
    // !ok yet leaves a RUNNABLE signal on disk. The synchronous consumer verifies
    // ONLY that signal (sees "dispatched" → runnable) and the detached settlement
    // ignores the resolved {code:1}, so the phase is recorded as LAUNCHED FOREVER —
    // no query, no terminal event, no reclaim. Flip any still-in-flight signal to
    // "stalled" so the consumer's verify demotes it to a dispatch failure (and the
    // terminal sweep can reclaim/escalate). defaultWriteSignalStalled's P3 guard
    // makes this a no-op when the signal is absent (a clean pre-claim failure) or
    // already terminal (the prelaunch's own mark_launch_failed already stalled it —
    // no double write). Derive the path: a pre-spec death has no spec.signalFile.
    const failedSignalFile =
      pre.spec?.signalFile ?? join(orchDir, "workers", ticket, `phase-${phase}.json`);
    defaultWriteSignalStalled(failedSignalFile, "sdk-prelaunch-failed");
    // The pre-launch otherwise owns its own failure event (mark_launch_failed) on a
    // clean claim/launch failure; surface its code/stderr without a duplicate backstop.
    // CTL-1367 item 11: scrub any token-shaped substrings out of the surfaced
    // stderr (the prelaunch env carries CLAUDE_CODE_OAUTH_TOKEN).
    const secrets = [oauthToken, authEnv.ANTHROPIC_API_KEY, authEnv.ANTHROPIC_AUTH_TOKEN];
    return {
      code: pre.code || 1,
      stdout: "",
      stderr: scrubSecrets(pre.stderr, secrets) || "sdk: shared pre-launch failed (no launch spec)",
      signal: null,
    };
  }
  const spec = pre.spec;
  const signalFile = spec.signalFile; // CTL-1367 item 4: the file the backstop flips to stalled
  const secrets = [oauthToken, authEnv.ANTHROPIC_API_KEY, authEnv.ANTHROPIC_AUTH_TOKEN];

  const env = buildSdkEnv(spec.env, { base: authEnv, oauthToken, settingsEnv: spec.settings?.env });
  const options = buildQueryOptions(spec, env, { turnCap });

  // CTL-1410 Phase B: register in the in-process worker registry — the SDK-native
  // liveness fact (bg_job_id is null, so every bg-keyed probe is blind to this
  // worker). Registered BEFORE sem.acquire on purpose: a parked waiter already
  // owns its claim + "dispatched" signal, so the phantom-sweep / worktree-refresh
  // consumers must see it as live while it queues. The three early-returns above
  // never register (no claim, or another worker owns the phase).
  const reg = registerWorker({
    ticket,
    phase,
    worktreePath: spec.worktreePath ?? worktreePath,
    generation: spec.generation,
    orchDir,
    // CTL-1422 review fix (D): a warm resume knows its session UUID up front —
    // seed the projection so a crash before the first streamed message doesn't
    // break the warm chain (the init capture below overwrites/confirms it).
    sessionId: spec.resumeSession ?? null,
  });

  // ── LAUNCH VERB: the in-process query() loop, under the concurrency cap ───
  //
  // CTL-1367 item 16 (semaphore scope — DOCUMENTED DECISION): the cap wraps ONLY
  // query() — NOT runPrelaunch/rebase, which ran (synchronously) above before we
  // acquire. This is deliberate: the prelaunch is the cheap, fast, single-flight
  // claim + signal write (it must NOT queue behind long-running query() slots, or a
  // duplicate-dispatch no-op would block on a full semaphore); query() is the
  // expensive in-process phase run that actually consumes a model/concurrency slot.
  // Capping query() only also matches the bg path, where phase-agent-dispatch
  // (prelaunch+spawn) is never concurrency-capped — only the live `claude --bg`
  // workers are, by the scheduler's maxParallel admission gate upstream.
  const sem = semaphore ?? sharedSemaphore(maxParallel);
  const release = await sem.acquire();
  // CTL-1422: the live SDK session UUID — the warm-resume key. Captured from the
  // first streamed message that carries one (the init message; a 429-retry starts
  // a NEW session, so a changed id re-captures). Persisted to the registry
  // projection the moment it is known (a daemon crash must not lose it) and
  // announced on the unified event log (worker.session.started|resumed) so the
  // fleet view / orphan lookback can be built centrally (Loki ships the same log).
  let sessionId = null;
  try {
    let lastOverload = null;
    for (let i = 0; i <= maxRetries; i++) {
      const ac = new AbortController();
      // Phase B: expose the per-attempt controller so cancel/abort (preemption,
      // watchdog) can reach the live query; a pending abort fires immediately.
      reg.setAbortController(ac);
      let result = null;
      let thrown = null;
      try {
        const q = runQuery({ prompt: spec.prompt, options: { ...options, abortController: ac } });
        for await (const m of q) {
          reg.touch(); // registry heartbeat (internally throttled to disk)
          if (typeof m?.session_id === "string" && m.session_id && m.session_id !== sessionId) {
            // A 429-retry starts a NEW session: close the old id first so the
            // log never carries a dangling started (the "interrupted" shape is
            // reserved for real crashes/kills).
            if (sessionId) {
              emitEvent("worker.session.stopped", {
                ticket, phase, session_id: sessionId, generation: spec.generation ?? null,
              });
            }
            sessionId = m.session_id;
            reg.setSessionId?.(sessionId); // optional-chained: Phase B test fakes lack it
            emitEvent(
              spec.resumeSession ? "worker.session.resumed" : "worker.session.started",
              { ticket, phase, session_id: sessionId, generation: spec.generation ?? null },
            );
          }
          if (m?.type === "result") result = m; // exactly one terminal
        }
      } catch (err) {
        thrown = err;
      }

      // 429/529 → bounded backoff + retry. Check BOTH a thrown error AND a captured
      // terminal result (the overload can surface either way).
      //
      // CTL-1367 item 17 (overload-retry idempotency — DOCUMENTED GUARANTEE): the
      // shared pre-launch (single-flight claim + "dispatched" signal + rebase) ran
      // EXACTLY ONCE, above the retry loop; only query() is retried. query() resumes
      // the SAME session (options.resume is set on a resume dispatch; a fresh
      // dispatch's first turns are establishment) against the SAME worktree + signal,
      // so a 429/529 retry never re-claims, never re-rebases, and never re-writes the
      // dispatched signal. The phase skill itself is idempotent across turns (it flips
      // dispatched→running once and checkpoints its own progress), so re-entering
      // query() after an overload cannot double-apply partial phase progress.
      const overloaded =
        (thrown && isOverloadedError(thrown)) || isOverloadedResult(result);
      if (overloaded) {
        lastOverload = thrown ?? result;
        if (i < maxRetries) {
          const delay = backoffMs(i, { ...backoff, random });
          emitEvent("execution-core.sdk.overloaded", {
            ticket, phase, attempt: i, delayMs: delay, status: statusOf(lastOverload),
          });
          await sleep(delay);
          continue;
        }
        // Exhausted: failed result + backstop failed event (never a silent drop).
        emitEvent("execution-core.sdk.overloaded", {
          ticket, phase, attempt: i, exhausted: true, status: statusOf(lastOverload),
        });
        emitBackstop({ phase, ticket, status: "failed", reason: "sdk-overloaded-exhausted", orchDir, signalFile }, { spawn });
        return {
          code: 1,
          stdout: "",
          stderr: `sdk: overloaded (429/529) after ${maxRetries + 1} attempts`,
          signal: null,
        };
      }

      // CTL-1367 item 14: a terminal result captured BEFORE the iterator raised is
      // the REAL outcome — map it. Only a throw with NO captured result is a generic
      // failure. Without this, a single-message query that yields error_max_turns and
      // then raises on iterator cleanup was reported as generic sdk-threw (failed)
      // instead of turn-cap-exhausted (because the thrown branch returned before
      // mapResult).
      if (thrown && !result) {
        emitBackstop({ phase, ticket, status: "failed", reason: "sdk-threw", orchDir, signalFile }, { spawn });
        return {
          code: 1,
          stdout: "",
          stderr: scrubSecrets(String(thrown?.message ?? thrown), secrets),
          signal: null,
        };
      }

      // Terminal result → map + (conditional) backstop emit.
      const { result: mapped, backstop } = mapResult(result);
      // CTL-1396 item B: record the ACTUAL turn count the SDK reported for this
      // phase run so the per-phase turn caps can be calibrated from real usage
      // (set arbitrarily high while we measure, so turn-cap-exhausted won't fire).
      // Fires once per phase run for EVERY terminal subtype routed through mapResult
      // — success, error_max_turns (turns-at-exhaustion), and other error/cancelled.
      // execution-core.* is outside every broker-protected namespace (NOT filter.*,
      // broker.daemon.*, session.heartbeat, or phase.<name>.<terminal>.<ticket>), so
      // it cannot collide with the routing/feedback spaces. Additive telemetry only:
      // does NOT change mapResult's return contract or the dispatch behavior.
      // Best-effort via the emitEvent seam (defaultEmitEvent never throws), exactly
      // like the execution-core.sdk.overloaded calls above; num_turns is guarded to
      // null when absent/non-numeric.
      emitEvent("execution-core.sdk.phase-turns", {
        ticket,
        phase,
        num_turns: extractNumTurns(result),
        subtype: result?.subtype ?? null,
        turnCap: turnCap ?? spec.turnCap,
      });
      // CTL-1406: emit context-window % so detached SDK workers populate dashboard panels
      // 50/51 (the interactive statusline never runs here). Best-effort + only when the SDK
      // result carries usage + a model context window; a null extract is silently skipped.
      const ctxUsage = extractContextUsage(result);
      if (ctxUsage) {
        const numTurns = extractNumTurns(result);
        emitContextEvent({
          ticket,
          phase,
          pct: ctxUsage.pct,
          turn: typeof numTurns === "number" ? numTurns : undefined,
          tokens: ctxUsage.tokens,
          max: ctxUsage.max,
        });
      }
      if (backstop) {
        emitBackstop({ phase, ticket, status: backstop.status, reason: backstop.reason, orchDir, signalFile }, { spawn });
      } else if (signalFile) {
        // CTL-1410 Phase A: clean SDK success (no backstop) — in-process safety
        // net that flips a still-in-flight signal to done. No-op when the phase
        // SKILL already flipped it via the wrapper (the primary path), or when
        // this run's generation is stale (superseded by a newer dispatch).
        flipSignalDoneOnSuccess(signalFile, spec.generation);
      }
      return mapped;
    }
    // Unreachable (the loop always returns), but keep a defined shape.
    return { code: 1, stdout: "", stderr: "sdk: retry loop exhausted", signal: null };
  } finally {
    // CTL-1422: the lifecycle close — "started/resumed without a stopped" is the
    // boot-time (and Loki) definition of an interrupted session, so stopped must
    // fire on EVERY post-capture exit path. A daemon crash/SIGKILL skips this by
    // nature, which is exactly what makes the interrupted session harvestable.
    if (sessionId) {
      emitEvent("worker.session.stopped", {
        ticket, phase, session_id: sessionId, generation: spec.generation ?? null,
      });
    }
    reg.deregister(); // every post-registration exit path, including throws
    release();
  }
}
