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
import { getAgentsCached } from "./claude-agents.mjs";
import { getJobsRoot, readFleetHealthConfig, log } from "./config.mjs";
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

  async function tick() {
    // Each signal read is wrapped so a throw yields a NON-CROSSING sentinel,
    // never a faked-healthy reading and never a crash.
    const jobsCount = await safeAsync(() => readJobsCount(), null);
    const agentsCount = safe(() => (listAgents() ?? []).length, null);
    const procsCount = await safeAsync(() => defaultReadProcsCount(psLines), null);
    const swapUsedMb = await safeAsync(() => readSwapUsedMb(), 0);

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

  const handle = clock.setInterval(() => {
    tick().catch(() => {});
  }, intervalMs);
  if (typeof handle?.unref === "function") handle.unref();
  return { stop: () => clock.clearInterval(handle), tick };
}
