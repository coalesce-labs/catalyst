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
} from "./scheduler.mjs";
import { countBackgroundAgents } from "./claude-agents.mjs";
import {
  defaultAppendParallelismSampledEvent,
  defaultAppendParallelismAdjustedEvent,
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
export function decideMaxParallel({
  window,
  concurrency,
  minSamples,
  loadSafeFactor,
  criticalPct,
  warnPct,
}) {
  const { maxParallel: current, minParallel, maxParallelCeiling } = concurrency;
  const clamp = (v) => clampToBounds(v, { minParallel, maxParallelCeiling });

  if (window.length === 0) {
    return { next: clamp(current), reason: "insufficient-samples" };
  }

  const latest = window[window.length - 1];
  const mem = memGuard(latest.memFreePct, { criticalPct, warnPct });

  // mem-critical overrides everything — act even without a full window.
  if (mem === "critical") {
    return { next: clamp(minParallel), reason: "mem-critical" };
  }

  if (window.length < minSamples) {
    return { next: clamp(current), reason: "insufficient-samples" };
  }

  const trend = detectTrend(window, {
    minSamples,
    coreCount: latest.coreCount,
    loadSafeFactor,
  });

  if (trend === "up") {
    return { next: clamp(Math.max(minParallel, Math.floor(current * 0.75))), reason: "trend-up" };
  }

  if (trend === "down") {
    if (mem === "warn") return { next: clamp(current), reason: "mem-warn" };
    return { next: clamp(current + 1), reason: "trend-down" };
  }

  if (trend === "flat-high") {
    return { next: clamp(current), reason: "flat-high" };
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
    writeLayer2,
    appendSampledEvent,
    appendAdjustedEvent,
  } = seams;

  try {
    const bgCount = liveBackgroundCount();
    if (bgCount === 0) {
      state.window = [];
      return;
    }

    const sample = sampleSystem({ loadavg, freemem, totalmem, cpus });
    state.window = pushSample(state.window, sample, state.windowSamples);

    const concurrency = readConcurrency();
    const current = concurrency.maxParallel ?? 3;

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
    });

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
    writeLayer2: (next) => writeLayer2MaxParallel(layer2Path, next),
    appendSampledEvent,
    appendAdjustedEvent,
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
