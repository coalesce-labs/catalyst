// fleet-health-probe.mjs — CTL-1165 D5. Pre-exhaustion fleet-health guardrail.
//
// Every ~120s it reads four steady-state degradation signals — the
// ~/.claude/jobs dir count, the live background-agent count, the resident
// worker-proc count, and macOS swap-used MB — each wrapped in safe() so a read
// failure returns a NON-CROSSING sentinel rather than crashing the tick or
// faking a healthy reading. A pure classifyFleetHealth decides whether any
// signal crossed its threshold; on a breach it emits ONE fleet.health.degraded
// event (host in the OTel resource, not the dotted name).
//
// Self-heal is DEFAULT OFF (selfHealEnabled): the first ship is a pure alert.
// When enabled, it fires the SAME two reap intents the 600s orphan-reaper timer
// emits (orphans.reap-requested + phase.reconcile.reap-requested) plus a bounded
// ppid===1 node/bun child sweep — ONCE per sustained breach episode, re-armed
// only after a healthy tick (hysteresis). It never gains new reaping authority.
//
// All side effects are injected (clock, readers, emit, triggerSelfHeal) so
// tick() is fully unit-testable with no real timer, sysctl, ps, or kill. Models
// memory-sampler.mjs byte-for-byte.

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { getAgentsCached } from "./claude-agents.mjs";
import { getJobsRoot, readFleetHealthConfig, log } from "./config.mjs";
import { emitFleetHealthEvent } from "./fleet-health-event.mjs";
import { emitReapIntent } from "./reap-intent.mjs";

const FLEET_REAP_CHILD_CAP = 25; // bound the self-heal child sweep

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

// safe() — run a reader, returning its value, or the supplied NON-CROSSING
// sentinel on any throw. The sentinel must be a value that can never trip a
// threshold (null for counts; 0 for swap), so an unreadable signal can only
// cause the guardrail to UNDER-react — never to over-react / over-reap.
function safe(fn, sentinel) {
  try {
    const v = fn();
    return v === undefined || v === null ? sentinel : v;
  } catch {
    return sentinel;
  }
}

// defaultReadJobsCount — count of ~/.claude/jobs/<id> dirs. try/catch → null
// (non-crossing) so a missing/unreadable jobs root never trips the guardrail.
export function defaultReadJobsCount() {
  try {
    return readdirSync(getJobsRoot()).length;
  } catch {
    return null;
  }
}

// defaultPsLines — `ps -axo pid=,ppid=,command=` lines. Best-effort `[]` on
// failure. command= (not comm=) preserves the full argv so node/bun detection
// in the proc count + child sweep is exact.
export function defaultPsLines() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return out.split("\n");
  } catch {
    return [];
  }
}

// defaultReadProcsCount — count resident node/bun worker processes from the ps
// snapshot. A null/empty snapshot yields 0 (non-crossing safe sentinel handled
// by the caller's safe()).
export function defaultReadProcsCount(psLines = defaultPsLines) {
  const lines = psLines() ?? [];
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
export function defaultReadSwapUsedMb({
  platform = process.platform,
  run = () => execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" }),
} = {}) {
  if (platform !== "darwin") return 0;
  let out;
  try {
    out = run();
  } catch {
    return 0;
  }
  const m = /used\s*=\s*([\d.]+)M/.exec(out ?? "");
  if (!m) return 0;
  const mb = Number(m[1]);
  return Number.isFinite(mb) ? Math.round(mb) : 0;
}

// defaultReapOrphanChildren — NET-NEW bounded sweep. Kills ONLY reparented
// (ppid===1) node/bun processes, capped at maxPerSweep, never the daemon's own
// pid(s). Best-effort: a throwing kill is swallowed. Returns the count reaped.
// (D2's proc-reaper.mjs is the corroboration-heavy enforcement path; this is the
// guardrail's last-resort bounded backstop.)
export function defaultReapOrphanChildren({
  psLines = defaultPsLines,
  kill = process.kill,
  daemonPids = [],
  maxPerSweep = FLEET_REAP_CHILD_CAP,
} = {}) {
  const lines = psLines() ?? [];
  const skip = new Set(daemonPids.map((p) => Number(p)));
  let reaped = 0;
  for (const line of lines) {
    if (reaped >= maxPerSweep) break;
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const command = m[3];
    if (ppid !== 1) continue; // only reparented orphans
    if (!/\b(?:node|bun)\b/.test(command)) continue; // only node/bun
    if (skip.has(pid)) continue; // never the daemon's own tree
    try {
      kill(pid, "SIGTERM");
      reaped++;
    } catch {
      /* ESRCH / EPERM — best-effort */
    }
  }
  return reaped;
}

// defaultTriggerSelfHeal — fire the SAME two reap intents the 600s orphan-reaper
// timer emits, then run the bounded child sweep. All best-effort; NEVER throws
// (the guardrail must never wedge the daemon). Each step is independently
// guarded so a failing emit cannot suppress the sweep.
export async function defaultTriggerSelfHeal({
  emitIntent = emitReapIntent,
  reapChildren = defaultReapOrphanChildren,
  daemonPids = [],
} = {}) {
  try {
    await emitIntent("orphans.reap-requested", {});
  } catch {
    /* best-effort */
  }
  try {
    await emitIntent("phase.reconcile.reap-requested", {});
  } catch {
    /* best-effort */
  }
  try {
    reapChildren({ daemonPids });
  } catch {
    /* best-effort */
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
  const { jobsThreshold, agentsThreshold, procsThreshold, swapUsedMbThreshold } =
    thresholds ?? {};
  const tripped = [];
  if (jobsCount != null && jobsCount >= jobsThreshold) tripped.push("jobs");
  if (agentsCount != null && agentsCount >= agentsThreshold) tripped.push("agents");
  if (procsCount != null && procsCount >= procsThreshold) tripped.push("procs");
  if (swapUsedMb != null && swapUsedMb >= swapUsedMbThreshold) tripped.push("swap");
  return { degraded: tripped.length > 0, tripped };
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
 * @param {Function} [opts.emit]                            fleet.health.degraded emitter
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
  } = config;
  void orchDir;

  let sustained = 0; // consecutive degraded ticks
  let fired = false; // self-heal already fired this breach episode (re-armed on a healthy tick)

  function tick() {
    // Each signal read is wrapped so a throw yields a NON-CROSSING sentinel,
    // never a faked-healthy reading and never a crash.
    const jobsCount = safe(() => readJobsCount(), null);
    const agentsCount = safe(() => (listAgents() ?? []).length, null);
    const procsCount = safe(() => defaultReadProcsCount(psLines), null);
    const swapUsedMb = safe(() => readSwapUsedMb(), 0);

    const readings = { jobsCount, agentsCount, procsCount, swapUsedMb };
    const { degraded, tripped } = classifyFleetHealth(readings, {
      jobsThreshold,
      agentsThreshold,
      procsThreshold,
      swapUsedMbThreshold,
    });

    if (!degraded) {
      // Healthy tick: reset the sustained counter and re-arm the self-heal.
      sustained = 0;
      fired = false;
      return;
    }

    sustained += 1;
    try {
      emit({ ...readings, tripped, sustained_n: sustained });
    } catch (err) {
      log.warn({ err: err?.message }, "fleet-health-probe: emit failed");
    }

    // Self-heal fires ONCE per sustained breach episode, boundary-exact at
    // sustained === sustainedTicks, and only when explicitly enabled.
    if (selfHealEnabled && !fired && sustained >= sustainedTicks) {
      fired = true;
      try {
        triggerSelfHeal();
      } catch (err) {
        log.warn({ err: err?.message }, "fleet-health-probe: self-heal failed");
      }
    }
  }

  const handle = clock.setInterval(tick, intervalMs);
  if (typeof handle?.unref === "function") handle.unref();
  return { stop: () => clock.clearInterval(handle), tick };
}
