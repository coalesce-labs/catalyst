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
} from "node:os";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { clampToBounds } from "./scheduler.mjs";
import {
  readExecutionCoreConcurrency,
  readExecutionCoreConcurrencyLayer2,
  mergeExecutionCoreConcurrency,
  resolveTargetSetpoint,
} from "./scheduler.mjs";
import { countBackgroundAgents } from "./claude-agents.mjs";
import {
  defaultAppendParallelismSampledEvent,
  defaultAppendParallelismAdjustedEvent,
  defaultAppendAutotuneGaugeEvent,
} from "./recovery.mjs";
import {
  AUTOTUNE_SAMPLE_INTERVAL_MS,
  AUTOTUNE_WINDOW_SAMPLES,
  AUTOTUNE_TREND_MIN_SAMPLES,
  AUTOTUNE_LOAD_SAFE_FACTOR,
  AUTOTUNE_MEM_CRITICAL_PCT,
  AUTOTUNE_MEM_WARN_PCT,
  AUTOTUNE_ENABLED,
  log,
} from "./config.mjs";

// --- Pure decision helpers --------------------------------------------------

// sampleSystem — capture current load + memory snapshot from seam-injected OS
// functions. Returns {load1, load5, load15, memFreePct, coreCount}.
export function sampleSystem({
  loadavg = osLoadavg,
  freemem = osFreemem,
  totalmem = osTotalmem,
  cpus = osCpus,
} = {}) {
  const [load1, load5, load15] = loadavg();
  const free = freemem();
  const total = totalmem();
  const memFreePct = Math.round((free / total) * 1000) / 10;
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

export function decideMaxParallel({
  window,
  concurrency,
  minSamples,
  loadSafeFactor,
  criticalPct,
  warnPct,
  layer1Max = null,   // CTL-750: Layer-1 committed maxParallel for fast recovery target
  setpoint = null,    // CTL-770: core-bounded seek-to target (host-over-repo); null → convergence no-ops
}) {
  const { maxParallel: current, minParallel, maxParallelCeiling } = concurrency;
  const clamp = (v) => clampToBounds(v, { minParallel, maxParallelCeiling });

  if (window.length === 0) {
    // CTL-770: truly-empty window has no sample to judge mem/load — keep the
    // conservative insufficient-samples hold (one tick of delay before the
    // cold-start seed can fire on the first tick with a sample).
    return { next: clamp(current), reason: "insufficient-samples" };
  }

  const latest = window[window.length - 1];
  const mem = memGuard(latest.memFreePct, { criticalPct, warnPct });

  // mem-critical overrides everything — act even without a full window.
  if (mem === "critical") {
    return { next: clamp(minParallel), reason: "mem-critical" };
  }

  if (window.length < minSamples) {
    // CTL-770 cold-start seed: a short window plus a mem-ok sample and a
    // setpoint above the current floor → jump straight to the (core-bounded)
    // target instead of idling at the persisted floor. mem-critical already
    // won above; we only seed when mem is not critical (ok or warn).
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

  // trend-up shed and mem-critical (above) always win over the setpoint logic.
  if (trend === "up") {
    return { next: clamp(Math.max(minParallel, Math.floor(current * 0.75))), reason: "trend-up" };
  }

  if (trend === "down") {
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

  if (trend === "flat-high") {
    return { next: clamp(current), reason: "flat-high" };
  }

  // CTL-770 idle/headroom convergence — generalizes CTL-750's recovery (which
  // only fired for trend==="down") to the flat-idle trend==="none" case. When
  // there is real headroom (mem ok + load below the ~75% safe line) and the
  // current value is below the setpoint, ramp toward the (already core-bounded)
  // target so a stuck-at-floor host converges in a bounded number of ticks.
  if (setpoint !== null && mem === "ok") {
    const threshold = latest.coreCount * loadSafeFactor;
    const loadSafe = latest.load1 < threshold;
    if (loadSafe) {
      // Hold within the deadband first so a value already at/near the setpoint
      // does not ping-pong (BEFORE the converge-up branch).
      if (Math.abs(current - setpoint) <= SETPOINT_DEADBAND) {
        return { next: clamp(current), reason: "at-setpoint" };
      }
      if (current < setpoint - SETPOINT_DEADBAND) {
        // Direct jump (mirrors CTL-750's recovery-to-layer1 semantics); clamp
        // guarantees no overshoot past the ceiling or the setpoint.
        return { next: clamp(Math.min(setpoint, maxParallelCeiling)), reason: "converge-to-setpoint" };
      }
    }
  }

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
    readConcurrency,
    readLayer1Concurrency,  // CTL-750: optional seam for Layer-1 committed maxParallel
    readLayer2Concurrency,  // CTL-770: optional seam for Layer-2 host targetParallel
    writeLayer2,
    appendSampledEvent,
    appendAdjustedEvent,
    appendGaugeEvent,       // CTL-771: per-tick setpoint gauge emitter
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

    const sample = sampleSystem({ loadavg, freemem, totalmem, cpus });
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
      layer1Max,  // CTL-750
      setpoint,   // CTL-770
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
  appendSampledEvent = defaultAppendParallelismSampledEvent,
  appendAdjustedEvent = defaultAppendParallelismAdjustedEvent,
  appendGaugeEvent = defaultAppendAutotuneGaugeEvent,  // CTL-771
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
    writeLayer2: (next) => writeLayer2MaxParallel(layer2Path, next),
    appendSampledEvent,
    appendAdjustedEvent,
    appendGaugeEvent,  // CTL-771
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
