// autotune.mjs — side-car auto-tuner for maxParallel (CTL-684).
// Samples host pressure (loadavg + freemem) on a cadence, applies a
// trend-based decision rule, and writes the adjusted value into Layer-2
// config so the scheduler's existing hot-reload picks it up next tick.
//
// All OS calls, timers, and I/O are injectable seams so the decision core
// and lifecycle are deterministically testable without real load or timers.

import {
  loadavg as osLoadavg,
  freemem as osFreemem,
  totalmem as osTotalmem,
  cpus as osCpus,
  platform as osPlatform,
} from "node:os";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { clampToBounds } from "./scheduler.mjs";
import {
  readExecutionCoreConcurrency,
  readExecutionCoreConcurrencyLayer2,
  mergeExecutionCoreConcurrency,
  resolveTargetSetpoint,
} from "./scheduler.mjs";
import { countBackgroundAgents, getAgentsCached } from "./claude-agents.mjs";
import { parsePsSnapshotWithCpu, rssTotalForPid, cpuTotalForPid } from "./cli/sessions.mjs";
import {
  defaultAppendParallelismSampledEvent,
  defaultAppendParallelismAdjustedEvent,
  defaultAppendAutotuneGaugeEvent,
} from "./recovery.mjs";
import { emitCapacityChangedEvent } from "./capacity-event.mjs";

function defaultAppendCapacityChangedEvent(args) {
  emitCapacityChangedEvent(args);
}
import {
  AUTOTUNE_SAMPLE_INTERVAL_MS,
  AUTOTUNE_WINDOW_SAMPLES,
  AUTOTUNE_TREND_MIN_SAMPLES,
  AUTOTUNE_LOAD_SAFE_FACTOR,
  AUTOTUNE_MEM_CRITICAL_PCT,
  AUTOTUNE_MEM_WARN_PCT,
  AUTOTUNE_ENABLED,
  AUTOTUNE_CLAUDE_RESOURCE_HIGH_WATER_PCT,
  AUTOTUNE_ATTRIBUTION_DEADBAND_PCT,
  AUTOTUNE_SCALE_UP_STEP,
  AUTOTUNE_DRIFT_DOWN_STEP,
  AUTOTUNE_CLAUDE_SHED_FACTOR,
  log,
} from "./config.mjs";

// --- Pure decision helpers --------------------------------------------------

// defaultVmStatExec — production seam for the darwin `vm_stat` shell-out. Uses
// execFileSync (the established child-process primitive in this dir:
// memory-sampler.mjs / claude-agents.mjs) so there is no shell parsing.
const defaultVmStatExec = () => execFileSync("vm_stat", [], { encoding: "utf8" });

// round1 — one-decimal rounding, matching availableMemPct's formula.
const round1 = (x) => Math.round(x * 10) / 10;

// defaultPsLinesWithCpu — CTL-775 production seam for the 4-column ps snapshot
// that drives Claude-attribution. Mirrors memory-sampler.mjs's defaultPsLines
// but adds the pcpu column: `ps -axo pid=,ppid=,pcpu=,rss=`. One shell-out per
// autotune tick (~30s cadence) — cheap. Returns [] on any failure (fail-low).
export function defaultPsLinesWithCpu() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,pcpu=,rss="], { encoding: "utf8" });
    return out.split("\n");
  } catch {
    return [];
  }
}

// claudeResourceShare — CTL-775. Sum the RSS + pcpu of every live background
// `claude` worker tree and express each as a percent of the whole host. This is
// the ATTRIBUTION signal that lets the control law distinguish "WE are saturating
// the host" (shed) from "another process is, our share is low" (hold).
//
// Fully seam-injected, pure, and TOTAL (never throws): on ANY error it returns
// { claudeCpuPct: 0, claudeMemPct: 0 } — FAIL-LOW. Fail-low is the safe direction
// because 0% reads as "we have headroom / we are not the cause", so attribution
// can never falsely shed work nor falsely block a scale-up; the rule-4 near-OOM
// clamp is independent of attribution and still fires regardless.
//
//   listAgents()  — array of `claude agents --json` records.
//   psSnapshot    — a parsePsSnapshotWithCpu result ({selfRss, selfCpu, children}).
//   totalmem      — host bytes.
//   coreCount     — os.cpus().length.
export function claudeResourceShare({ listAgents, psSnapshot, totalmem, coreCount } = {}) {
  try {
    // Mirror memory-sampler.mjs:113 — only kind==="background" agents with a pid.
    const liveBgAgents = (listAgents?.() ?? []).filter(
      (a) => a?.kind === "background" && a.pid,
    );
    let rssKbSum = 0;
    let cpuSum = 0;
    for (const a of liveBgAgents) {
      rssKbSum += rssTotalForPid(psSnapshot, a.pid);
      cpuSum += cpuTotalForPid(psSnapshot, a.pid);
    }
    const total = typeof totalmem === "function" ? totalmem() : totalmem;
    // rss is KB → ×1024 to bytes.
    const claudeMemPct = total > 0 ? round1(((rssKbSum * 1024) / total) * 100) : 0;
    // pcpu is %-of-one-core; normalize the tree sum to whole-host percent.
    const claudeCpuPct = coreCount > 0 ? round1((cpuSum / (coreCount * 100)) * 100) : 0;
    if (!Number.isFinite(claudeCpuPct) || !Number.isFinite(claudeMemPct)) {
      return { claudeCpuPct: 0, claudeMemPct: 0 };
    }
    return { claudeCpuPct, claudeMemPct };
  } catch {
    return { claudeCpuPct: 0, claudeMemPct: 0 };
  }
}

// availableMemPct — CTL-772: platform-aware "available memory" percentage.
//
// The bug: on darwin os.freemem() reports only the truly-free page count and
// EXCLUDES inactive/speculative/purgeable pages that the kernel reclaims on
// demand. That made memFreePct read ~0.5% on a host with tens of GB actually
// available, tripping mem-critical and pinning maxParallel at the floor.
//
// Fix: on darwin parse `vm_stat` and sum free + inactive + speculative +
// purgeable pages × page-size, divided by totalmem(). On any platform other
// than darwin — or on ANY parse/exec error — fall back to the original
// freemem()/totalmem() formula (byte-identical to the old sampleSystem code),
// so a parse failure is strictly no-worse than today and the seam-injected
// freemem/totalmem still drive the value everywhere except real darwin.
//
// Pure + total: never rethrows. All OS access is via the injected seams.
export function availableMemPct({
  freemem = osFreemem,
  totalmem = osTotalmem,
  platform = "linux",
  execSync = defaultVmStatExec,
} = {}) {
  const fallback = () => Math.round((freemem() / totalmem()) * 1000) / 10;

  if (platform !== "darwin") return fallback();

  try {
    const out = execSync("vm_stat");
    const ps = Number(out.match(/page size of (\d+) bytes/)?.[1]);
    if (!Number.isFinite(ps) || ps <= 0) throw new Error("vm_stat: bad page size");

    // vm_stat values carry a TRAILING PERIOD ("Pages free:   17612."), so the
    // regex captures the digits then a literal `.`. A missing line → 0
    // (defensive, not an error).
    const pages = (label) => {
      const m = out.match(new RegExp("Pages " + label + ":\\s+(\\d+)\\."));
      return m ? Number(m[1]) : 0;
    };
    const free = pages("free");
    const inactive = pages("inactive");
    const speculative = pages("speculative");
    const purgeable = pages("purgeable");

    const total = totalmem();
    const availBytes = (free + inactive + speculative + purgeable) * ps;
    const pct = Math.round((availBytes / total) * 1000) / 10;
    if (!Number.isFinite(pct)) throw new Error("vm_stat: non-finite pct");
    return pct;
  } catch {
    return fallback();
  }
}

// sampleSystem — capture current load + memory snapshot from seam-injected OS
// functions. Returns {load1, load5, load15, memFreePct, coreCount}.
//
// CTL-772: memFreePct now delegates to availableMemPct so darwin reports
// reclaimable memory. `platform`/`execSync` are seams; platform defaults to
// "linux" (the freemem path) so callers/tests that inject only freemem/totalmem
// keep the original behavior even when bun test runs on a darwin host. Only
// startAutoTuner injects the real process.platform + real vm_stat.
export function sampleSystem({
  loadavg = osLoadavg,
  freemem = osFreemem,
  totalmem = osTotalmem,
  cpus = osCpus,
  platform = "linux",
  execSync = defaultVmStatExec,
} = {}) {
  const [load1, load5, load15] = loadavg();
  const memFreePct = availableMemPct({ freemem, totalmem, platform, execSync });
  const coreCount = cpus().length;
  return { load1, load5, load15, memFreePct, coreCount };
}

// pushSample — append a sample to the rolling window, trimming to maxSamples.
// Never mutates the input array. Returns a new array.
export function pushSample(window, sample, maxSamples) {
  const next = [...window, sample];
  if (next.length > maxSamples) return next.slice(next.length - maxSamples);
  return next;
}

// strictlyOrdered — check if `a > b > c` (dir="up") or `a < b < c` (dir="down").
function strictlyOrdered(sample, dir) {
  const { load1, load5, load15 } = sample;
  if (dir === "up") return load1 > load5 && load5 > load15;
  return load1 < load5 && load5 < load15;
}

// detectTrend — classify the rolling window's load trend.
// Returns "up" | "down" | "flat-high" | "none".
export function detectTrend(window, { minSamples, coreCount, loadSafeFactor }) {
  if (window.length < minSamples) return "none";
  const tail = window.slice(-minSamples);
  const threshold = coreCount * loadSafeFactor;

  const allUp = tail.every((s) => strictlyOrdered(s, "up"));
  if (allUp) return "up";

  const allDown = tail.every((s) => strictlyOrdered(s, "down"));
  const latestSafe = tail[tail.length - 1].load1 < threshold;
  if (allDown && latestSafe) return "down";

  // flat-high only when there is no directional trend — if the window shows a
  // systematic pattern (allDown) that is merely suppressed by load, that is
  // "none", not "flat-high" (no actionable decision either way).
  if (!allUp && !allDown) {
    const latest = tail[tail.length - 1];
    if (latest.load1 > threshold && latest.load5 > threshold) return "flat-high";
  }

  return "none";
}

// memGuard — classify current memory pressure.
// Returns "critical" | "warn" | "ok".
export function memGuard(memFreePct, { criticalPct, warnPct }) {
  if (memFreePct < criticalPct) return "critical";
  if (memFreePct < warnPct) return "warn";
  return "ok";
}

// decideMaxParallel — apply the decision matrix and return {next, reason}.
// Every result is clamped to [minParallel, maxParallelCeiling].
// CTL-770: hysteresis band around the setpoint. With 0 the at-setpoint hold
// fires only on exact equality; the converge branch (current < setpoint) and
// shed branches still bound oscillation. Kept a named constant so the deadband
// is one obvious knob.
const SETPOINT_DEADBAND = 0;

// CTL-775 named constants for the Claude-attributable resource control law.
// All env-overridable via config.mjs (EXECUTION_CORE_AUTOTUNE_*).
const CLAUDE_RESOURCE_HIGH_WATER_PCT = AUTOTUNE_CLAUDE_RESOURCE_HIGH_WATER_PCT; // shed/scale-up gate
const ATTRIBUTION_DEADBAND_PCT = AUTOTUNE_ATTRIBUTION_DEADBAND_PCT;             // hysteresis
const SCALE_UP_STEP = AUTOTUNE_SCALE_UP_STEP;                                   // +1/tick saturated growth
const DRIFT_DOWN_STEP = AUTOTUNE_DRIFT_DOWN_STEP;                               // -1/tick over-provisioned drift
const CLAUDE_SHED_FACTOR = AUTOTUNE_CLAUDE_SHED_FACTOR;                         // ×0.75 shed

// decideMaxParallel — CTL-775 control law. Branch precedence is top→bottom,
// first match wins. Integrates the CTL-770/772 setpoint+OOM behavior with the
// new Claude-attribution gates:
//   1. host near-OOM        → clamp(minParallel)            [hard safety floor]
//   2. <minSamples          → cold-start-seed / hold
//   3. host trend-up        → coarse-load shed (kept above attribution)
//   4. claude at limit      → claude-resource-shed          [law rule 2]
//   5. host warn, not us    → host-pressure-not-ours-hold   [law rule 3]
//   6. saturated + headroom → saturated-scale-up            [law rule 1]
//   7. host trend-down      → CTL-750 recovery (saturation-gated)
//   8. host flat-high       → hold
//   9. setpoint converge/drift                              [law rule 5]
//  10. fallback             → hold
//
// New params (all default to a back-compat-safe value):
//   runningWorkers  — live bg worker count; null ⇒ unknown ⇒ treated as
//                     saturated so legacy CTL-750 trend-down growth still fires
//                     for direct unit callers that don't supply it.
//   claudeCpuPct /
//   claudeMemPct    — Claude-attributable host share; null ⇒ attribution
//                     unavailable ⇒ the attribution gates (4,5,6) are skipped and
//                     the function degrades to CTL-770/772 setpoint+drift behavior.
export function decideMaxParallel({
  window,
  concurrency,
  minSamples,
  loadSafeFactor,
  criticalPct,
  warnPct,
  layer1Max = null,         // CTL-750: Layer-1 committed maxParallel for fast recovery target
  setpoint = null,          // CTL-770: core-bounded seek-to target; null → convergence no-ops
  runningWorkers = null,    // CTL-775: live bg worker count; null ⇒ unknown ⇒ saturated (back-compat)
  claudeCpuPct = null,      // CTL-775: Claude-attributable host CPU %; null ⇒ attribution unavailable
  claudeMemPct = null,      // CTL-775: Claude-attributable host MEM %; null ⇒ attribution unavailable
}) {
  const { maxParallel: current, minParallel, maxParallelCeiling } = concurrency;
  const clamp = (v) => clampToBounds(v, { minParallel, maxParallelCeiling });

  // Attribution-derived helpers. attribution-known ⇒ at least one pct supplied.
  const attributionKnown = claudeCpuPct != null || claudeMemPct != null;
  const claudeAtLimit =
    (claudeCpuPct != null && claudeCpuPct >= CLAUDE_RESOURCE_HIGH_WATER_PCT) ||
    (claudeMemPct != null && claudeMemPct >= CLAUDE_RESOURCE_HIGH_WATER_PCT);
  const headroomLine = CLAUDE_RESOURCE_HIGH_WATER_PCT - ATTRIBUTION_DEADBAND_PCT;
  const claudeHasHeadroom =
    attributionKnown &&
    (claudeCpuPct == null || claudeCpuPct < headroomLine) &&
    (claudeMemPct == null || claudeMemPct < headroomLine);
  // No-free-slots. runningWorkers==null ⇒ unknown demand ⇒ assume saturated so
  // legacy CTL-750 trend-down recovery (which has no runningWorkers concept)
  // keeps firing for direct unit callers. autoTuneTick ALWAYS supplies bgCount,
  // so null only happens in hand-built unit calls. Documented in risks.
  const saturated = runningWorkers == null || runningWorkers >= current;

  if (window.length === 0) {
    // CTL-770: truly-empty window has no sample to judge mem/load — keep the
    // conservative insufficient-samples hold (one tick of delay before the
    // cold-start seed can fire on the first tick with a sample).
    return { next: clamp(current), reason: "insufficient-samples" };
  }

  const latest = window[window.length - 1];
  const mem = memGuard(latest.memFreePct, { criticalPct, warnPct });

  // RULE 1 — mem-critical hard floor. Runs before ALL attribution so the host
  // near-OOM clamp fires regardless of whose load it is.
  if (mem === "critical") {
    return { next: clamp(minParallel), reason: "mem-critical" };
  }

  // RULE 2 — cold-start seed / insufficient-samples (CTL-770).
  if (window.length < minSamples) {
    if (setpoint !== null && current < setpoint) {
      return { next: clamp(setpoint), reason: "cold-start-seed" };
    }
    return { next: clamp(current), reason: "insufficient-samples" };
  }

  const trend = detectTrend(window, {
    minSamples,
    coreCount: latest.coreCount,
    loadSafeFactor,
  });

  // RULE 3 — host-load trend-up shed (CTL-684), now ONLY a coarse backstop when
  // attribution is UNKNOWN (old/unwired callers, or a ps snapshot we couldn't
  // read). When attribution IS known, a host up-trend must NOT blindly shed our
  // workers (CTL-775 law rule 3) — defer to the claude-at-limit shed (RULE 4)
  // and the not-ours hold (RULE 5), so a non-Claude CPU spike holds, not sheds.
  if (trend === "up" && !attributionKnown) {
    return { next: clamp(Math.max(minParallel, Math.floor(current * 0.75))), reason: "trend-up" };
  }

  // RULE 4 — CLAUDE-DRIVEN SHED (law rule 2). Only fires when WE are the cause:
  // a current sample whose Claude-attributable cpu OR mem is at/over the
  // high-water. Stateless v1 (no per-sample share-history threaded), so the
  // "approaching + rising" sub-clause is intentionally omitted.
  if (claudeAtLimit) {
    return {
      next: clamp(Math.max(minParallel, Math.floor(current * CLAUDE_SHED_FACTOR))),
      reason: "claude-resource-shed",
    };
  }

  // RULE 5 — NON-CLAUDE PRESSURE HOLD (law rule 3). Host is pressured — either a
  // sub-critical mem-warn OR a load up-trend — but our attributable share is low
  // → another process is the cause. Shedding wouldn't help our throughput, and
  // growing would pour onto an already-busy host. HOLD. Requires attribution
  // KNOWN so the no-attribution mem-warn tests still reach rule 7's mem-warn
  // semantics (different reason string); the up-trend coarse shed for the
  // no-attribution case already returned in RULE 3.
  if (attributionKnown && !claudeAtLimit && (mem === "warn" || trend === "up")) {
    return { next: clamp(current), reason: "host-pressure-not-ours-hold" };
  }

  // RULE 6 — SATURATED SCALE-UP (law rule 1). The ONLY path that grows ABOVE the
  // setpoint. Requires no-free-slots AND our-own-headroom AND mem ok. Bounded by
  // the ceiling via clamp. Kills the "16 ceiling with 2 running" ramp: not
  // saturated → never reached.
  if (saturated && claudeHasHeadroom && mem === "ok" && current < maxParallelCeiling) {
    return { next: clamp(current + SCALE_UP_STEP), reason: "saturated-scale-up" };
  }

  // RULE 7 — host trend-down recovery (CTL-750), now SATURATION-GATED so it
  // never grows on demand-free falling load. NOT saturated → fall through to the
  // setpoint logic.
  if (trend === "down" && saturated) {
    if (mem === "warn") {
      // CTL-750: allow slow recovery from absolute floor even under mem-warn.
      if (current <= minParallel) return { next: clamp(current + 1), reason: "mem-warn-recovery" };
      return { next: clamp(current), reason: "mem-warn" };
    }
    // CTL-750: jump to Layer-1's committed target when recovering from below it.
    if (layer1Max !== null && current < layer1Max) {
      return { next: clamp(layer1Max), reason: "recovery-to-layer1" };
    }
    return { next: clamp(current + 1), reason: "trend-down" };
  }

  // RULE 8 — host flat-high coarse-load hold (CTL-684).
  if (trend === "flat-high") {
    return { next: clamp(current), reason: "flat-high" };
  }

  // RULE 9 — setpoint converge (CTL-770) + drift-down (CTL-775 law rule 5).
  if (setpoint !== null && mem === "ok") {
    const threshold = latest.coreCount * loadSafeFactor;
    const loadSafe = latest.load1 < threshold;
    if (loadSafe) {
      // 9a — hold within the deadband (BEFORE converge/drift so a value at the
      // setpoint never ping-pongs).
      if (Math.abs(current - setpoint) <= SETPOINT_DEADBAND) {
        return { next: clamp(current), reason: "at-setpoint" };
      }
      // 9b — converge UP to the baseline (always; first-wave headroom).
      if (current < setpoint - SETPOINT_DEADBAND) {
        return { next: clamp(Math.min(setpoint, maxParallelCeiling)), reason: "converge-to-setpoint" };
      }
      // 9c — DRIFT DOWN to the baseline when over-provisioned and NOT saturated.
      // Floored at setpoint so it never undershoots, and never below
      // runningWorkers so the lowered ceiling can't drop under in-flight work.
      if (current > setpoint + SETPOINT_DEADBAND && !saturated) {
        const floor = Math.max(setpoint, runningWorkers ?? setpoint);
        return { next: clamp(Math.max(floor, current - DRIFT_DOWN_STEP)), reason: "drift-to-setpoint" };
      }
    }
  }

  // RULE 10 — final fallback hold.
  return { next: clamp(current), reason: "hold" };
}

// --- Layer-2 write-back -----------------------------------------------------

// writeLayer2MaxParallel — atomically update catalyst.orchestration.executionCore.maxParallel
// in the Layer-2 config file. Preserves all other JSON keys. Returns true on
// success, false on any parse/IO error (fail-safe).
export function writeLayer2MaxParallel(layer2Path, next, {
  readFileSync: readFile = readFileSync,
  writeFileSync: writeFile = writeFileSync,
  renameSync: rename = renameSync,
} = {}) {
  let existing = {};
  try {
    existing = JSON.parse(readFile(layer2Path, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      try {
        log.warn({ err: err.message, layer2Path }, "autotune: Layer-2 parse error; skipping write");
      } catch {}
      return false;
    }
    // ENOENT → start from {}
  }
  try {
    if (!existing.catalyst) existing.catalyst = {};
    if (!existing.catalyst.orchestration) existing.catalyst.orchestration = {};
    if (!existing.catalyst.orchestration.executionCore) existing.catalyst.orchestration.executionCore = {};
    existing.catalyst.orchestration.executionCore.maxParallel = next;
    const tmp = `${layer2Path}.tmp.${process.pid}`;
    writeFile(tmp, JSON.stringify(existing, null, 2));
    rename(tmp, layer2Path);
    return true;
  } catch (err) {
    try {
      log.warn({ err: err.message, layer2Path }, "autotune: Layer-2 write failed");
    } catch {}
    return false;
  }
}

// --- Side-car lifecycle -----------------------------------------------------

let _timer = null;
let _state = null;

// autoTuneTick — the per-interval body. All seams injected.
export function autoTuneTick(state, seams) {
  const {
    liveBackgroundCount,
    loadavg,
    freemem,
    totalmem,
    cpus,
    // CTL-772: platform defaults to "linux" at this seam boundary so existing
    // tests that build seams by hand (injecting only freemem/totalmem) take the
    // freemem path and stay green even on a darwin CI/dev host. Only
    // startAutoTuner's real wiring passes process.platform + real vm_stat.
    platform = "linux",
    execSync,
    readConcurrency,
    readLayer1Concurrency,  // CTL-750: optional seam for Layer-1 committed maxParallel
    readLayer2Concurrency,  // CTL-770: optional seam for Layer-2 host targetParallel
    listAgents,             // CTL-775: optional seam for Claude attribution; default undefined
    psLinesWithCpu,         // CTL-775: optional seam — () => string[] for the 4-col ps snapshot
    writeLayer2,
    appendSampledEvent,
    appendAdjustedEvent,
    appendGaugeEvent,       // CTL-771: per-tick setpoint gauge emitter
    appendCapacityChangedEvent, // CTL-1092: node.capacity.changed alongside parallelism-adjusted
  } = seams;

  try {
    const bgCount = liveBackgroundCount();
    if (bgCount === 0) {
      // CTL-770 fix-up: idle (zero live workers) is exactly when capacity should
      // sit AT the setpoint so the scheduler can dispatch a full wave the moment
      // work arrives. The original `return` here left the autotuner inert at
      // idle — effective maxParallel stayed pinned at whatever floor it was last
      // shed to (the stuck-at-1 observed live) and the CTL-771 gauges went dark.
      // Reset the trend window (no workers ⇒ no meaningful load trend) but fall
      // through so the sample → gauge → cold-start-seed/hold-at-setpoint path
      // still runs (decideMaxParallel's <minSamples seed handles the fresh
      // single-sample window).
      state.window = [];
    }

    const sample = sampleSystem({ loadavg, freemem, totalmem, cpus, platform, execSync });
    state.window = pushSample(state.window, sample, state.windowSamples);

    const concurrency = readConcurrency();
    const current = concurrency.maxParallel ?? 3;
    // CTL-750: pass Layer-1's committed target so decideMaxParallel can jump on recovery.
    // Fail-safe: if the seam is absent (old callers), layer1Max stays null.
    const layer1 = readLayer1Concurrency?.();
    const layer1Max = (Number.isInteger(layer1?.maxParallel) && layer1.maxParallel > 0)
      ? layer1.maxParallel
      : null;

    // CTL-770: resolve the seek-to setpoint with host-over-repo layering, then
    // core-bound it. Fail-safe: a missing/throwing Layer-2 seam → setpoint
    // resolves from Layer-1 maxParallel; neither set → resolveTargetSetpoint
    // returns undefined → setpoint=null → convergence/seed branches no-op.
    let layer2 = {};
    try {
      layer2 = readLayer2Concurrency?.() ?? {};
    } catch {
      layer2 = {};
    }
    const rawTarget = resolveTargetSetpoint(layer1 ?? {}, layer2 ?? {});
    const coreCount = sample.coreCount;
    const setpoint =
      rawTarget == null
        ? null
        : clampToBounds(
            Math.min(rawTarget, Math.max(concurrency.minParallel ?? 1, coreCount - 2)),
            {
              minParallel: concurrency.minParallel ?? 1,
              maxParallelCeiling: concurrency.maxParallelCeiling ?? rawTarget,
            },
          );

    // CTL-775: Claude-attributable resource share. Guarded behind both seams so
    // the existing hand-built test seams (which inject neither) no-op cleanly:
    // null pcts → decideMaxParallel's attribution gates are SKIPPED and the
    // function degrades to the CTL-770/772 setpoint+drift behavior. Any throw
    // (a hung ps, a malformed snapshot) is swallowed → null → same fail-low path.
    let claudeCpuPct = null;
    let claudeMemPct = null;
    if (listAgents && psLinesWithCpu) {
      try {
        const snap = parsePsSnapshotWithCpu(psLinesWithCpu());
        ({ claudeCpuPct, claudeMemPct } = claudeResourceShare({
          listAgents,
          psSnapshot: snap,
          totalmem: totalmem(),
          coreCount: sample.coreCount,
        }));
      } catch {
        claudeCpuPct = null;
        claudeMemPct = null;
      }
    }

    try {
      appendSampledEvent({
        label: "execution-core",
        load1: sample.load1,
        load5: sample.load5,
        load15: sample.load15,
        memFreePct: sample.memFreePct,
        bgCount,
        maxParallelCurrent: current,
      });
    } catch {}

    const { next, reason } = decideMaxParallel({
      window: state.window,
      concurrency,
      minSamples: state.trendMinSamples,
      loadSafeFactor: state.loadSafeFactor,
      criticalPct: state.criticalPct,
      warnPct: state.warnPct,
      layer1Max,                  // CTL-750
      setpoint,                   // CTL-770
      runningWorkers: bgCount,    // CTL-775: live worker count is the saturation signal
      claudeCpuPct,               // CTL-775: Claude-attributable host CPU %
      claudeMemPct,               // CTL-775: Claude-attributable host MEM %
    });

    // CTL-771: emit the setpoint gauge EVERY tick (unconditional, unlike the
    // change-gated parallelism-adjusted event) so the OTel dashboard renders
    // effective/target/load/mem continuously. Best-effort; mirrors the
    // appendSampledEvent try/catch above. running_workers reuses bgCount — no
    // extra `claude agents` shell-out.
    try {
      appendGaugeEvent?.({
        label: "execution-core",
        maxParallelEffective: current,
        maxParallelTarget: setpoint,
        runningWorkers: bgCount,
        load1: sample.load1,
        loadPerCore: coreCount ? sample.load1 / coreCount : sample.load1,
        memFreePct: sample.memFreePct,
        claudeCpuPct,  // CTL-775: additive — dashboard visibility into attribution
        claudeMemPct,  // CTL-775
        reason,
      });
    } catch {}

    if (next !== current) {
      try {
        writeLayer2(next);
      } catch {}
      try {
        appendAdjustedEvent({
          label: "execution-core",
          oldMaxParallel: current,
          newMaxParallel: next,
          reason,
        });
      } catch {}
      try {
        appendCapacityChangedEvent?.({
          label: "execution-core",
          oldMaxParallel: current,
          newMaxParallel: next,
          reason,
        });
      } catch {}
    }
  } catch {}
}

// startAutoTuner — start the sampling interval. Returns a stop handle.
// When disabled, returns a no-op stop handle without starting any timer.
export function startAutoTuner({
  configPath,
  layer2Path,
  liveBackgroundCount = () => countBackgroundAgents(),
  sampleIntervalMs = AUTOTUNE_SAMPLE_INTERVAL_MS,
  windowSamples = AUTOTUNE_WINDOW_SAMPLES,
  trendMinSamples = AUTOTUNE_TREND_MIN_SAMPLES,
  loadSafeFactor = AUTOTUNE_LOAD_SAFE_FACTOR,
  criticalPct = AUTOTUNE_MEM_CRITICAL_PCT,
  warnPct = AUTOTUNE_MEM_WARN_PCT,
  enabled = AUTOTUNE_ENABLED,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  loadavg = osLoadavg,
  freemem = osFreemem,
  totalmem = osTotalmem,
  cpus = osCpus,
  // CTL-772: the REAL daemon path uses the host platform + real vm_stat so
  // darwin reports reclaimable (available) memory instead of os.freemem().
  platform = osPlatform(),
  execSync = defaultVmStatExec,
  appendSampledEvent = defaultAppendParallelismSampledEvent,
  appendAdjustedEvent = defaultAppendParallelismAdjustedEvent,
  appendGaugeEvent = defaultAppendAutotuneGaugeEvent,  // CTL-771
  appendCapacityChangedEvent = defaultAppendCapacityChangedEvent,  // CTL-1092
} = {}) {
  if (!enabled) return () => {};

  _state = {
    window: [],
    windowSamples,
    trendMinSamples,
    loadSafeFactor,
    criticalPct,
    warnPct,
  };

  const seams = {
    liveBackgroundCount,
    loadavg,
    freemem,
    totalmem,
    cpus,
    platform,   // CTL-772: host platform (process.platform via os.platform())
    execSync,   // CTL-772: real vm_stat shell-out
    readConcurrency: () =>
      mergeExecutionCoreConcurrency(
        readExecutionCoreConcurrency(configPath),
        readExecutionCoreConcurrencyLayer2(layer2Path),
      ),
    // CTL-750: Layer-1 only (no Layer-2 merge) — the committed operator target.
    readLayer1Concurrency: () => readExecutionCoreConcurrency(configPath),
    // CTL-770: Layer-2 host file — carries the NEW targetParallel key (the
    // autotuner's seek-to setpoint), separate from maxParallel.
    readLayer2Concurrency: () => readExecutionCoreConcurrencyLayer2(layer2Path),
    // CTL-775: Claude-attribution seams. listAgents reads the SAME warm,
    // non-blocking snapshot memory-sampler uses (getAgentsCached) — never a sync
    // spawn on the loop. psLinesWithCpu shells out the 4-col ps once per tick.
    listAgents: () => getAgentsCached().agents,
    psLinesWithCpu: defaultPsLinesWithCpu,
    writeLayer2: (next) => writeLayer2MaxParallel(layer2Path, next),
    appendSampledEvent,
    appendAdjustedEvent,
    appendGaugeEvent,  // CTL-771
    appendCapacityChangedEvent,  // CTL-1092
  };

  _timer = setIntervalFn(() => autoTuneTick(_state, seams), sampleIntervalMs);

  return stopAutoTuner.bind(null, { clearIntervalFn });
}

// stopAutoTuner — clear the interval. Idempotent (safe to call before start
// or multiple times).
export function stopAutoTuner({ clearIntervalFn = clearInterval } = {}) {
  if (_timer !== null) {
    clearIntervalFn(_timer);
    _timer = null;
  }
  _state = null;
}
