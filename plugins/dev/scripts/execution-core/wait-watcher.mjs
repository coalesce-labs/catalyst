// wait-watcher.mjs — CTL-650 Phase 3. The push-based session wait-state watcher.
//
// On each tick it (a) enumerates live sessions via `claude agents --json` (the
// authoritative busy/idle source), (b) incrementally tails each session's
// transcript through a per-session tracker, (c) classifies the wait state, and
// (d) emits a debounced `agent.waiting_on_user` / `agent.resumed` event ONLY on
// a real transition (per-session lastState map, the broker debounce model
// router.mjs:1634-1646). Sessions that disappear are purged so the maps stay
// bounded. Every dependency is injected (the startDaemon/Reaper test idiom) so
// the tick is fully unit-testable with a fake clock + fake emitter.

import { getAgentsCached } from "./claude-agents.mjs";
import { indexSignalsByBgJobId } from "./cli/sessions.mjs";
import { createTranscriptTracker } from "./transcript-tail.mjs";
import { findTranscript, defaultProjectsDir } from "./session-recency.mjs";
import { classifyWaitState, isWaitingState } from "./wait-state-classifier.mjs";
import { shortIdFromSessionId } from "./claude-ids.mjs";
import { emitWaitEvent } from "./wait-event.mjs";
import { EVENT_DEBOUNCE_MS, log } from "./config.mjs";

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

/**
 * startWaitWatcher — start the periodic wait-state tick. Returns `{ stop, tick }`.
 *
 * @param {object} opts
 * @param {object}   [opts.clock=realClock()]                  fake-clock seam
 * @param {number}   [opts.intervalMs=EVENT_DEBOUNCE_MS]       tick cadence
 * @param {Function} [opts.listAgents]                        live-session enumerator (default: warm getAgentsCached snapshot, CTL-731)
 * @param {Function} [opts.indexSignals=indexSignalsByBgJobId] signal join (ticket/phase)
 * @param {Function} [opts.makeTracker]                        per-session tracker factory
 * @param {Function} [opts.findTranscriptFn=findTranscript]    transcript locator
 * @param {Function} [opts.emit=emitWaitEvent]                 transition emitter
 * @param {string}   [opts.projectsDir=defaultProjectsDir()]   transcripts root
 */
export function startWaitWatcher({
  clock = realClock(),
  intervalMs = EVENT_DEBOUNCE_MS,
  // CTL-731: read the warm, never-blocking snapshot instead of a synchronous
  // execFileSync per wait-watcher tick (this runs on the shared daemon event
  // loop, so a sync `claude agents --json` here starves all timers).
  listAgents = () => getAgentsCached().agents,
  indexSignals = indexSignalsByBgJobId,
  makeTracker = (p) => createTranscriptTracker({ path: p }),
  findTranscriptFn = findTranscript,
  emit = emitWaitEvent,
  projectsDir = defaultProjectsDir(),
} = {}) {
  const trackers = new Map(); // sessionId → tracker
  const lastState = new Map(); // sessionId → state (debounce)

  function tick() {
    let agents;
    let sigIndex;
    try {
      agents = listAgents() ?? [];
      sigIndex = indexSignals() ?? new Map();
    } catch (err) {
      // A failed enumeration/index read is a transient — skip this tick, never
      // crash the daemon's watcher thread.
      log.warn({ err: err?.message }, "wait-watcher: tick enumeration failed");
      return;
    }

    const live = new Set();
    for (const a of agents) {
      if (!a || !a.sessionId) continue;
      live.add(a.sessionId);

      const path = findTranscriptFn(a.sessionId, projectsDir);
      let tracker = trackers.get(a.sessionId);
      if (!tracker && path) {
        tracker = makeTracker(path);
        trackers.set(a.sessionId, tracker);
      }
      if (tracker) tracker.poll();
      const snap = tracker ? tracker.snapshot() : { hasTranscript: false };

      const { state, waitingText, detail } = classifyWaitState({ ...snap, status: a.status });
      const prev = lastState.get(a.sessionId);
      if (state !== prev) {
        let meta = {};
        try {
          meta = sigIndex.get(shortIdFromSessionId(a.sessionId)) ?? {};
        } catch {
          meta = {};
        }
        if (isWaitingState(state) && !isWaitingState(prev ?? "")) {
          emit("agent.waiting_on_user", { a, state, waitingText, detail, meta });
        } else if (!isWaitingState(state) && isWaitingState(prev ?? "")) {
          emit("agent.resumed", { a, state, detail, meta });
        }
        lastState.set(a.sessionId, state);
      }
    }

    // Purge sessions that disappeared so the maps stay bounded and a returning
    // session re-emits its first transition rather than being debounced against
    // a stale state.
    for (const id of [...trackers.keys()]) {
      if (!live.has(id)) {
        trackers.delete(id);
        lastState.delete(id);
      }
    }
    for (const id of [...lastState.keys()]) {
      if (!live.has(id)) lastState.delete(id);
    }
  }

  const handle = clock.setInterval(tick, intervalMs);
  if (typeof handle?.unref === "function") handle.unref();
  return { stop: () => clock.clearInterval(handle), tick };
}
