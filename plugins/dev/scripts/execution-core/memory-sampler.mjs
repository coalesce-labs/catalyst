// memory-sampler.mjs — CTL-685. Periodic per-worker memory sampler.
//
// Every ~30s it enumerates live background Claude agents, computes each
// worker's full process-tree RSS (self + descendants via parsePsSnapshot +
// rssTotalForPid), and emits worker.memory.sampled / .warn / .killed events.
// On a *sustained* kill-threshold breach (N consecutive samples) it issues
// `claude stop` and marks the signal failed.
//
// All side effects are injected (clock, listAgents, psLines, emit, killWorker,
// markOom, resolveMeta) so tick() is fully unit-testable with no real I/O.

import { execFileSync } from "node:child_process";
import { cachedListClaudeAgents } from "./claude-agents.mjs";
import { claudeStop } from "./claude-agents.mjs";
import { shortIdFromSessionId } from "./claude-ids.mjs";
import { parsePsSnapshot, rssTotalForPid, parseSessionName } from "./cli/sessions.mjs";
import { readMemorySamplerConfig, log } from "./config.mjs";
import {
  emitMemoryEvent,
  MEMORY_EVENT_SAMPLED,
  MEMORY_EVENT_WARN,
  MEMORY_EVENT_KILLED,
} from "./memory-event.mjs";
import { defaultMarkWorkerOom } from "./memory-sampler-signal.mjs";

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

function defaultPsLines() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" });
    return out.split("\n");
  } catch {
    return [];
  }
}

function defaultResolveMeta(agent) {
  const parsed = parseSessionName(agent.name);
  let shortId = null;
  try {
    shortId = shortIdFromSessionId(agent.sessionId);
  } catch {}
  return {
    ticket: parsed?.ticket ?? null,
    phase: parsed?.phase ?? null,
    shortId,
  };
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * classifyMemPressure — pure classifier from RSS in MB to pressure level.
 * Boundary-exact: >= kill is KILL, >= warn is WARN, else OK.
 *
 * @param {number} rssMb
 * @param {object} thresholds
 * @param {number} thresholds.warnThresholdMb
 * @param {number} thresholds.killThresholdMb
 * @returns {"OK"|"WARN"|"KILL"}
 */
export function classifyMemPressure(rssMb, { warnThresholdMb, killThresholdMb }) {
  if (rssMb >= killThresholdMb) return "KILL";
  if (rssMb >= warnThresholdMb) return "WARN";
  return "OK";
}

/**
 * startMemorySampler — start the periodic memory-sample tick. Returns { stop, tick }.
 *
 * @param {object} opts
 * @param {object}   [opts.clock=realClock()]              fake-clock seam
 * @param {object}   [opts.config=readMemorySamplerConfig()] thresholds + kill knobs
 * @param {Function} [opts.listAgents]                     live-session enumerator (sync)
 * @param {Function} [opts.psLines]                        `ps -axo pid=,ppid=,rss=` lines
 * @param {Function} [opts.emit]                           event emitter
 * @param {Function} [opts.killWorker]                     claudeStop(shortId)
 * @param {Function} [opts.markOom]                        signal-file writer
 * @param {Function} [opts.resolveMeta]                    agent → { ticket, phase, shortId }
 */
export function startMemorySampler({
  clock = realClock(),
  config = readMemorySamplerConfig(),
  listAgents = cachedListClaudeAgents,
  psLines = defaultPsLines,
  emit = emitMemoryEvent,
  killWorker = claudeStop,
  markOom = defaultMarkWorkerOom,
  resolveMeta = defaultResolveMeta,
} = {}) {
  const { intervalMs, warnThresholdMb, killThresholdMb, killEnabled, killSustainedSamples } =
    config;
  const aboveKillSince = new Map(); // sessionId → consecutive kill-threshold sample count

  function tick() {
    let agents, snapshot;
    try {
      agents = (listAgents() ?? []).filter((a) => a?.kind === "background" && a.pid);
      snapshot = parsePsSnapshot(psLines());
    } catch (err) {
      log.warn({ err: err?.message }, "memory-sampler: tick failed");
      return;
    }

    const live = new Set();
    for (const a of agents) {
      live.add(a.sessionId);
      const rssMb = Math.round(rssTotalForPid(snapshot, a.pid) / 1024);
      const meta = safe(() => resolveMeta(a)) ?? {};
      const shortId = meta.shortId ?? safe(() => shortIdFromSessionId(a.sessionId));
      const base = {
        sessionId: a.sessionId,
        shortId,
        ticket: meta.ticket ?? null,
        phase: meta.phase ?? null,
        rss_mb: rssMb,
        swap_mb: null,
      };

      emit(MEMORY_EVENT_SAMPLED, base);

      const level = classifyMemPressure(rssMb, { warnThresholdMb, killThresholdMb });

      if (level === "WARN") {
        emit(MEMORY_EVENT_WARN, { ...base, threshold_mb: warnThresholdMb });
        aboveKillSince.delete(a.sessionId);
      } else if (level === "KILL") {
        const n = (aboveKillSince.get(a.sessionId) ?? 0) + 1;
        aboveKillSince.set(a.sessionId, n);
        // WARN still fires so dashboards see the escalation ladder
        emit(MEMORY_EVENT_WARN, { ...base, threshold_mb: killThresholdMb, sample_count: n });
        if (killEnabled && n >= killSustainedSamples) {
          if (shortId) safe(() => killWorker(shortId));
          safe(() => markOom(a, meta));
          emit(MEMORY_EVENT_KILLED, { ...base, threshold_mb: killThresholdMb, sample_count: n });
          aboveKillSince.delete(a.sessionId); // reset after enforcement
        }
      } else {
        aboveKillSince.delete(a.sessionId); // hysteresis reset when below kill
      }
    }

    // Prune counters for sessions that have vanished from `claude agents`
    for (const id of [...aboveKillSince.keys()]) {
      if (!live.has(id)) aboveKillSince.delete(id);
    }
  }

  const handle = clock.setInterval(tick, intervalMs);
  if (typeof handle?.unref === "function") handle.unref();
  return { stop: () => clock.clearInterval(handle), tick };
}
