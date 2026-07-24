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
// field → integer MB. Non-darwin / parse-error / throw → 0 (safe sentinel,
// non-crossing). run/platform are injectable for tests.
export async function defaultReadSwapUsedMb({
  platform = process.platform,
  run = () => execFileAsync("sysctl", ["-n", "vm.swapusage"]),
} = {}) {
  if (platform !== "darwin") return 0;
  let out;
  try {
    out = await run();
  } catch {
    return 0;
  }
  const m = /used\s*=\s*([\d.]+)M/.exec(out ?? "");
  if (!m) return 0;
  const mb = Number(m[1]);
  return Number.isFinite(mb) ? Math.round(mb) : 0;
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
 * EVERY signal is strictly `<` its clear threshold, so the band [clear, trip)
 * holds state (a reading == the clear threshold is NOT clear). null/sentinel
 * readings count as below (never block a clear). `clearThresholds.swapUsedMbThreshold`
 * is the LOWER swap clear threshold; jobs/agents/procs clear at their trip
 * threshold (degenerate band).
 *
 * @param {object} readings  { jobsCount, agentsCount, procsCount, swapUsedMb }
 * @param {object} clearThresholds { jobsThreshold, agentsThreshold, procsThreshold, swapUsedMbThreshold }
 * @returns {{ clear:boolean }}
 */
export function classifyFleetHealthClear(readings, clearThresholds) {
  const { jobsCount, agentsCount, procsCount, swapUsedMb } = readings ?? {};
  const { jobsThreshold, agentsThreshold, procsThreshold, swapUsedMbThreshold } =
    clearThresholds ?? {};
  const below = (v, t) => v == null || v < t;
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
let _latchHydrated = false;

function latchMarkerPath() {
  return join(getFleetHealthDir(), "fleet-health-latch.json");
}

// hydrateLatch — lazily load the persisted latch on the first tick of this
// process. Absent/malformed marker → latch stays false (never throws).
function hydrateLatch() {
  if (_latchHydrated) return;
  _latchHydrated = true;
  try {
    _degradedLatched = JSON.parse(readFileSync(latchMarkerPath(), "utf8"))?.latched === true;
  } catch {
    _degradedLatched = false; // absent/malformed → unlatched
  }
}

// persistLatch — atomically write the latch (tmp + rename) so a restart resumes
// it. Best-effort; a failure is logged and the probe continues.
function persistLatch(latched) {
  try {
    const dir = getFleetHealthDir();
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.fleet-health-latch.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, JSON.stringify({ latched, ts: Date.now() }));
    renameSync(tmp, latchMarkerPath());
  } catch (err) {
    log.warn?.({ err: err?.message }, "fleet-health-probe: latch persist failed (continuing)");
  }
}

// __resetFleetHealthLatch — test seam so latch state never leaks across tests
// (clears the in-memory latch + the hydration flag so the next tick re-reads the
// CATALYST_DIR-scoped marker). Mirrors __resetFleetFreezeLatch.
export function __resetFleetHealthLatch() {
  _degradedLatched = false;
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
  let fired = false; // self-heal already fired this breach episode (re-armed on the clear edge)

  async function tick() {
    // Each signal read is wrapped so a throw yields a NON-CROSSING sentinel,
    // never a faked-healthy reading and never a crash.
    const jobsCount = await safeAsync(() => readJobsCount(), null);
    const agentsCount = safe(() => (listAgents() ?? []).length, null);
    const procsCount = await safeAsync(() => defaultReadProcsCount(psLines), null);
    const swapUsedMb = await safeAsync(() => readSwapUsedMb(), 0);

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
      fired = false;
    } else if (trip) {
      sustained += 1;
    }

    // Emit ONLY on an edge (degraded/recovered), then persist the new latch AFTER
    // a successful append (append-first, mirroring fleet-freeze-alert — a failed
    // emit retries next tick because the latch is not advanced).
    if (edge) {
      try {
        emit({ ...readings, tripped, sustained_n: sustained }, { action: edge });
        _degradedLatched = latched;
        persistLatch(latched);
      } catch (err) {
        log.warn({ err: err?.message }, "fleet-health-probe: emit failed");
      }
    }

    // Self-heal fires ONCE per sustained breach episode, boundary-exact at
    // sustained === sustainedTicks, and only when explicitly enabled — only on a
    // trip tick (never in-band, never on a clear tick).
    if (trip && selfHealEnabled && !fired && sustained >= sustainedTicks) {
      fired = true;
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
