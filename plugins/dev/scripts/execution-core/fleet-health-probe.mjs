// fleet-health-probe.mjs — CTL-1165 D5. Pre-exhaustion fleet-health guardrail.
//
// Every ~120s it reads four steady-state degradation signals — the
// ~/.claude/jobs dir count, the live background-agent count, the resident
// worker-proc count, and macOS swap-used MB — each wrapped in safe() so a read
// failure returns a NON-CROSSING sentinel rather than crashing the tick or
// faking a healthy reading. A pure classifyFleetHealth decides whether any
// signal crossed its threshold.
//
// CTL-1503 — the event is EDGE-TRIGGERED with a HYSTERESIS BAND + durable latch
// (was: one fleet.health.degraded per tick, which flapped ~57×/3h on a 16 GB
// Mac). `fleet.health.degraded` fires ONCE on the healthy→degraded edge; a paired
// `fleet.health.recovered` fires ONCE on the degraded→healthy edge. The latch
// clears only when EVERY signal drops strictly below its CLEAR threshold — the
// swap signal carries a distinct lower clear threshold, so a signal hovering in
// the band [clear, trip) cannot re-flap. The latch is persisted to a marker under
// getFleetHealthDir() and hydrated on first tick, so a daemon restart mid-episode
// does not re-emit `degraded` with no prior `recovered` (mirrors
// fleet-freeze-alert.mjs). Two pure helpers carry the logic: classifyFleetHealthClear
// (the clear-side verdict) and nextFleetHealthLatch (the edge state machine).
// The host lives in the OTel resource, not the dotted event name.
//
// Self-heal is DEFAULT OFF (selfHealEnabled): the first ship is a pure alert.
// When enabled, it fires the SAME reap intents the 600s orphan-reaper timer
// emits — orphans.reap-requested + phase.reconcile.reap-requested (claude-session
// sweeps) AND procOrphans.reap-requested (the orphan child-process sweep, routed
// through D2's fully-gated, shadow-default proc-reaper) — ONCE per sustained
// breach episode, re-armed only after a healthy tick (hysteresis). It gains NO
// new reaping authority: a child process dies only if proc-reaper.mode is ALSO
// 'enforce'. There is deliberately NO crude direct child-kill here — an
// empty-skip-set ppid===1 node/bun sweep would SIGTERM the daemon/broker/monitor
// themselves (they run as nohup'd node/bun reparented to launchd).
//
// All side effects are injected (clock, readers, emit, triggerSelfHeal) so
// tick() is fully unit-testable with no real timer, sysctl, ps, or kill. Models
// memory-sampler.mjs byte-for-byte.

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getAgentsCached } from "./claude-agents.mjs";
import { getJobsRoot, getFleetHealthDir, readFleetHealthConfig, log } from "./config.mjs";
import { emitFleetHealthEvent } from "./fleet-health-event.mjs";
import { emitReapIntent } from "./reap-intent.mjs";

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

// safe() — run a sync reader, returning its value, or the supplied NON-CROSSING
// sentinel on any throw. Used for the warm-cache listAgents read only.
function safe(fn, sentinel) {
  try {
    const v = fn();
    return v === undefined || v === null ? sentinel : v;
  } catch {
    return sentinel;
  }
}

function execFileAsync(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: "utf8", ...opts }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });
}

// safeAsync() — await a reader, returning its value or the sentinel on any error.
async function safeAsync(fn, sentinel) {
  try {
    const v = await fn();
    return v === undefined || v === null ? sentinel : v;
  } catch {
    return sentinel;
  }
}

// defaultReadJobsCount — count of ~/.claude/jobs/<id> dirs. try/catch → null
// (non-crossing) so a missing/unreadable jobs root never trips the guardrail.
export async function defaultReadJobsCount() {
  try {
    return (await readdir(getJobsRoot())).length;
  } catch {
    return null;
  }
}

// defaultPsLines — `ps -axo pid=,ppid=,command=` lines. Best-effort `[]` on
// failure. command= (not comm=) preserves the full argv so node/bun detection
// in the proc count + child sweep is exact.
export async function defaultPsLines() {
  try {
    const out = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return out.split("\n");
  } catch {
    return [];
  }
}

// defaultReadProcsCount — count resident node/bun worker processes from the ps
// snapshot. A null/empty snapshot yields 0 (non-crossing safe sentinel handled
// by the caller's safeAsync()).
export async function defaultReadProcsCount(psLines = defaultPsLines) {
  const lines = (await psLines()) ?? [];
  let n = 0;
  for (const line of lines) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const command = m[3];
    if (/\b(?:node|bun)\b/.test(command)) n++;
  }
  return n;
}

// defaultReadSwapUsedMb — parse macOS `sysctl -n vm.swapusage`'s `used = N.NNM`
// field → integer MB. Non-darwin → 0 (this platform has no swap concept to cross).
// A READ FAILURE (sysctl throws / unparseable output) → null = UNKNOWN, NOT 0 —
// a 0 would look healthy and could falsely clear a latched degradation (Codex P1
// on #2704). run/platform are injectable for tests.
export async function defaultReadSwapUsedMb({
  platform = process.platform,
  run = () => execFileAsync("sysctl", ["-n", "vm.swapusage"]),
} = {}) {
  if (platform !== "darwin") return 0;
  let out;
  try {
    out = await run();
  } catch {
    return null; // read failure → unknown (non-crossing for trip AND clear)
  }
  const m = /used\s*=\s*([\d.]+)M/.exec(out ?? "");
  if (!m) return null; // unparseable → unknown
  const mb = Number(m[1]);
  return Number.isFinite(mb) ? Math.round(mb) : null;
}

// defaultTriggerSelfHeal — fire the SAME reap intents the 600s orphan-reaper
// timer emits: orphans.reap-requested + phase.reconcile.reap-requested (the
// claude-session sweeps) AND procOrphans.reap-requested (the orphan
// child-process sweep). The last routes through D2's proc-reaper, which carries
// the full kill gate (LIVE_TREE / allowlist / cwd-under-worktree / etime floor /
// CATASTROPHE GUARD) and is shadow-by-default — so self-heal gains ZERO new kill
// authority and a child process dies only if proc-reaper.mode is ALSO 'enforce'.
// There is deliberately NO crude direct child-kill here (a bare ppid===1 node/bun
// SIGTERM with an empty skip set would take down the daemon/broker/monitor).
// All best-effort; NEVER throws (the guardrail must never wedge the daemon); each
// emit is independently guarded so one failure cannot suppress the others.
export async function defaultTriggerSelfHeal({ emitIntent = emitReapIntent } = {}) {
  for (const type of [
    "orphans.reap-requested",
    "phase.reconcile.reap-requested",
    "procOrphans.reap-requested",
  ]) {
    try {
      await emitIntent(type, {});
    } catch {
      /* best-effort — never wedge the daemon */
    }
  }
}

/**
 * classifyFleetHealth — pure classifier from four readings + thresholds to a
 * degraded verdict + the ordered list of tripped signals. Boundary-exact: a
 * reading >= its threshold trips (mirrors classifyMemPressure). null/sentinel
 * readings never trip (`null >= n` is false; swap's 0 sentinel is well below any
 * realistic threshold).
 *
 * @param {object} readings  { jobsCount, agentsCount, procsCount, swapUsedMb }
 * @param {object} thresholds { jobsThreshold, agentsThreshold, procsThreshold, swapUsedMbThreshold }
 * @returns {{ degraded:boolean, tripped:string[] }}
 */
export function classifyFleetHealth(readings, thresholds) {
  const { jobsCount, agentsCount, procsCount, swapUsedMb } = readings ?? {};
  const { jobsThreshold, agentsThreshold, procsThreshold, swapUsedMbThreshold } = thresholds ?? {};
  const tripped = [];
  if (jobsCount != null && jobsCount >= jobsThreshold) tripped.push("jobs");
  if (agentsCount != null && agentsCount >= agentsThreshold) tripped.push("agents");
  if (procsCount != null && procsCount >= procsThreshold) tripped.push("procs");
  if (swapUsedMb != null && swapUsedMb >= swapUsedMbThreshold) tripped.push("swap");
  return { degraded: tripped.length > 0, tripped };
}

/**
 * classifyFleetHealthClear — pure clear-side verdict for the hysteresis band
 * (CTL-1503). Complement of classifyFleetHealth's `>=` trip: `clear` is true iff
 * EVERY signal is a VALID reading strictly `<` its clear threshold, so the band
 * [clear, trip) holds state (a reading == the clear threshold is NOT clear).
 * A null/unavailable reading is UNKNOWN, not clear — a health-reader failure must
 * never declare recovery and release a latched degradation (Codex P1 on #2704);
 * the swap reader's failure sentinel is null (not 0) for the same reason.
 * `clearThresholds.swapUsedMbThreshold` is the LOWER swap clear threshold;
 * jobs/agents/procs clear at their trip threshold (degenerate band).
 *
 * @param {object} readings  { jobsCount, agentsCount, procsCount, swapUsedMb }
 * @param {object} clearThresholds { jobsThreshold, agentsThreshold, procsThreshold, swapUsedMbThreshold }
 * @returns {{ clear:boolean }}
 */
export function classifyFleetHealthClear(readings, clearThresholds) {
  const { jobsCount, agentsCount, procsCount, swapUsedMb } = readings ?? {};
  const { jobsThreshold, agentsThreshold, procsThreshold, swapUsedMbThreshold } =
    clearThresholds ?? {};
  // A valid reading strictly below its clear threshold. null/undefined = UNKNOWN
  // → NOT clear, so a reader failure holds the latch rather than falsely clearing it.
  const below = (v, t) => v != null && v < t;
  const clear =
    below(jobsCount, jobsThreshold) &&
    below(agentsCount, agentsThreshold) &&
    below(procsCount, procsThreshold) &&
    below(swapUsedMb, swapUsedMbThreshold);
  return { clear };
}

/**
 * nextFleetHealthLatch — pure edge state machine (CTL-1503). Given the prior
 * latch and the {trip, clear} verdicts, returns the next latch value and which
 * edge event (if any) to emit. Precedence: `trip` is only checked when NOT
 * latched; once latched only `clear` releases it — a signal in the band
 * [clear, trip) never re-emits.
 *
 * @param {boolean} prev  prior latch (true = currently degraded/latched)
 * @param {{trip:boolean, clear:boolean}} verdict
 * @returns {{ latched:boolean, emit:("degraded"|"recovered"|null) }}
 */
export function nextFleetHealthLatch(prev, { trip, clear } = {}) {
  if (!prev && trip) return { latched: true, emit: "degraded" };
  if (prev && clear) return { latched: false, emit: "recovered" };
  return { latched: prev, emit: null };
}

// ─── Durable edge-trigger latch (CTL-1503, mirrors fleet-freeze-alert.mjs) ────
// Module-scoped so the latch persists across ticks; PERSISTED to disk + hydrated
// on first tick so a daemon RESTART mid-episode does not re-emit `degraded` with
// no intervening `recovered`. Best-effort — a persist/hydrate failure never
// wedges the probe.
let _degradedLatched = false;
// CTL-1503 (Codex P2): the durable episode state carried across restarts. `fired`
// = self-heal already ran this breach episode (so a restart mid-episode doesn't
// re-reap); `trippedAt` = the signal set captured at the degradation edge (so the
// paired recovery event can report WHICH alarm it closes — at the recovery tick
// `tripped` is empty). Both persisted with the latch and hydrated on the first tick.
let _fired = false;
let _trippedAt = [];
let _latchHydrated = false;

function latchMarkerPath() {
  return join(getFleetHealthDir(), "fleet-health-latch.json");
}

// hydrateLatch — lazily load the persisted episode state on the first tick of
// this process. Absent/malformed marker → unlatched, not-fired, no tripped set
// (never throws).
function hydrateLatch() {
  if (_latchHydrated) return;
  _latchHydrated = true;
  try {
    const m = JSON.parse(readFileSync(latchMarkerPath(), "utf8"));
    _degradedLatched = m?.latched === true;
    _fired = m?.fired === true;
    _trippedAt = Array.isArray(m?.tripped) ? m.tripped : [];
  } catch {
    _degradedLatched = false; // absent/malformed → unlatched
    _fired = false;
    _trippedAt = [];
  }
}

// persistLatch — atomically write the episode state (tmp + rename) so a restart
// resumes it. Best-effort; a failure is logged and the probe continues.
function persistLatch({ latched, fired, tripped }) {
  try {
    const dir = getFleetHealthDir();
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.fleet-health-latch.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, JSON.stringify({ latched, fired, tripped, ts: Date.now() }));
    renameSync(tmp, latchMarkerPath());
  } catch (err) {
    log.warn?.({ err: err?.message }, "fleet-health-probe: latch persist failed (continuing)");
  }
}

// __resetFleetHealthLatch — test seam so episode state never leaks across tests
// (clears the in-memory latch/fired/tripped + the hydration flag so the next tick
// re-reads the CATALYST_DIR-scoped marker). Mirrors __resetFleetFreezeLatch.
export function __resetFleetHealthLatch() {
  _degradedLatched = false;
  _fired = false;
  _trippedAt = [];
  _latchHydrated = false;
}

/**
 * startFleetHealthProbe — arm the periodic fleet-health tick. Returns { stop, tick }.
 *
 * @param {object} opts
 * @param {object}   [opts.clock=realClock()]               fake-clock seam
 * @param {object}   [opts.config=readFleetHealthConfig()]  thresholds + cadence + selfHeal knobs
 * @param {Function} [opts.readJobsCount]                   ~/.claude/jobs dir count (sync)
 * @param {Function} [opts.listAgents]                      live-session enumerator (sync)
 * @param {Function} [opts.psLines]                         `ps -axo pid=,ppid=,command=` lines
 * @param {Function} [opts.readSwapUsedMb]                  macOS swap-used MB
 * @param {Function} [opts.emit]                            fleet.health.{degraded,recovered} emitter (payload, { action })
 * @param {Function} [opts.triggerSelfHeal]                 self-heal action (default OFF via config)
 * @param {string}   [opts.orchDir]                         (reserved) daemon orch dir
 */
export function startFleetHealthProbe({
  clock = realClock(),
  config = readFleetHealthConfig(),
  readJobsCount = defaultReadJobsCount,
  // CTL-731: read the warm, never-blocking snapshot (mirrors memory-sampler).
  listAgents = () => getAgentsCached().agents,
  psLines = defaultPsLines,
  readSwapUsedMb = defaultReadSwapUsedMb,
  emit = emitFleetHealthEvent,
  triggerSelfHeal = defaultTriggerSelfHeal,
  orchDir = null,
} = {}) {
  const {
    intervalMs,
    selfHealEnabled,
    sustainedTicks,
    jobsThreshold,
    agentsThreshold,
    procsThreshold,
    swapUsedMbThreshold,
    swapUsedMbClearThreshold,
  } = config;
  void orchDir;

  let sustained = 0; // consecutive degraded ticks (count at the edge)
  // self-heal-fired is the module-scoped, PERSISTED `_fired` (re-armed on the clear
  // edge) so a restart mid-episode doesn't re-run the reap (Codex P2 on #2704).

  async function tick() {
    // Each signal read is wrapped so a throw yields a NON-CROSSING sentinel,
    // never a faked-healthy reading and never a crash.
    const jobsCount = await safeAsync(() => readJobsCount(), null);
    const agentsCount = safe(() => (listAgents() ?? []).length, null);
    const procsCount = await safeAsync(() => defaultReadProcsCount(psLines), null);
    // CTL-1503 (Codex P1): a swap-read failure yields null (a NON-CROSSING sentinel
    // for both trip `>=` and clear `<`), NOT 0 — 0 would look healthy and could
    // falsely clear a latched degradation.
    const swapUsedMb = await safeAsync(() => readSwapUsedMb(), null);

    const readings = { jobsCount, agentsCount, procsCount, swapUsedMb };
    // Trip side (>=, absolute thresholds) — unchanged.
    const { degraded: trip, tripped } = classifyFleetHealth(readings, {
      jobsThreshold,
      agentsThreshold,
      procsThreshold,
      swapUsedMbThreshold,
    });
    // Clear side (strict <, swap uses the lower clear threshold) — the band.
    const { clear } = classifyFleetHealthClear(readings, {
      jobsThreshold,
      agentsThreshold,
      procsThreshold,
      swapUsedMbThreshold: swapUsedMbClearThreshold,
    });

    // Hydrate the persisted latch on the first tick so a restart mid-episode
    // resumes the prior degraded/recovered state (idempotent thereafter).
    hydrateLatch();
    const { latched, emit: edge } = nextFleetHealthLatch(_degradedLatched, { trip, clear });

    // Sustained/self-heal counter, driven off the trip/clear verdicts. On a clear
    // edge (or any clear tick) reset + re-arm; on a trip tick count up; in the
    // band leave both untouched (hold).
    if (clear) {
      sustained = 0;
      _fired = false;
    } else if (trip) {
      sustained += 1;
    }

    // Emit ONLY on an edge (degraded/recovered), then advance + persist the latch
    // AFTER a SUCCESSFUL append. emitFleetHealthEvent returns false (not throws) on
    // an event-log append failure, so a false result must NOT advance the latch —
    // otherwise a transient log failure permanently swallows that edge until the
    // next transition (Codex P1 on #2704). Leaving the latch un-advanced re-attempts
    // the same edge next tick.
    if (edge) {
      // A recovery tick has an empty `tripped` (all signals cleared), so report the
      // signal set captured at the degradation edge — the alarm this recovery closes
      // (Codex P2 on #2704). A degraded edge reports the fresh `tripped`.
      const edgeTripped = edge === "degraded" ? tripped : _trippedAt;
      let emitted = false;
      try {
        emitted =
          emit({ ...readings, tripped: edgeTripped, sustained_n: sustained }, { action: edge }) !== false;
      } catch (err) {
        log.warn({ err: err?.message }, "fleet-health-probe: emit failed");
        emitted = false;
      }
      if (emitted) {
        _degradedLatched = latched;
        _trippedAt = edge === "degraded" ? tripped.slice() : [];
        persistLatch({ latched, fired: _fired, tripped: _trippedAt });
      }
    }

    // Self-heal fires ONCE per sustained breach episode, boundary-exact at
    // sustained === sustainedTicks, and only when explicitly enabled — only on a
    // trip tick (never in-band, never on a clear tick).
    if (trip && selfHealEnabled && _degradedLatched && !_fired && sustained >= sustainedTicks) {
      // Gate on _degradedLatched so `fired` is only ever set within a LATCHED
      // episode. Without this, a run of failed degraded-edge appends (latch stays
      // false) could still fire self-heal and persist {latched:false, fired:true} —
      // an inconsistent state that, after a restart, would suppress self-heal for
      // the NEXT genuine episode (Codex P2 on #2704). Since the latch only advances
      // on a successful append, self-heal now waits until the degraded edge is
      // durably recorded, keeping fired tied to a persisted latched episode.
      _fired = true;
      // Persist the fired flag immediately so a daemon restart while the host is
      // still degraded does not re-invoke self-heal for the same episode (Codex P2).
      persistLatch({ latched: _degradedLatched, fired: _fired, tripped: _trippedAt });
      try {
        triggerSelfHeal();
      } catch (err) {
        log.warn({ err: err?.message }, "fleet-health-probe: self-heal failed");
      }
    }
  }

  const handle = clock.setInterval(() => {
    tick().catch(() => {});
  }, intervalMs);
  if (typeof handle?.unref === "function") handle.unref();
  return { stop: () => clock.clearInterval(handle), tick };
}
