// blocked-ghost.mjs — CAT-171 Source-A liveness policy.

import {
  agentStateForShortId,
  isBgJobAlive,
  listClaudeAgents,
  TERMINAL_AGENT_STATES,
} from "./claude-agents.mjs";

// Return a drop-in isBgJobAlive probe. `off` is the exact base verdict;
// `shadow` observes blocked listings while preserving that verdict; `enforce`
// classifies them as not alive. All telemetry is best-effort.
export function makeBlockedGhostAwareIsBgJobAlive({
  mode = "shadow",
  emit = null,
  emitReap = null,
  base = isBgJobAlive,
  terminalStates = TERMINAL_AGENT_STATES,
} = {}) {
  const emitted = new Set();
  const reaped = new Set();
  const reapPending = new Set();

  return (bgJobId, options = {}) => {
    if (mode === "off") return base(bgJobId, options);
    // Resolve one listing and thread it through both the base presence probe and
    // the state lookup. Production scheduler callers already supply the warm
    // snapshot; the detached runner uses this fallback without double-spawning.
    const agents = options.agents ?? listClaudeAgents({ exec: options.exec });
    const alive = base(bgJobId, { ...options, agents });
    if (!alive) return alive;

    const shortId = String(bgJobId).slice(0, 8);
    const state = agentStateForShortId(shortId, agents);
    if (state === null || !terminalStates.has(state)) return alive;

    if (!emitted.has(shortId)) {
      emitted.add(shortId);
      try {
        emit?.(
          mode === "enforce"
            ? "liveness.blocked-ghost.reclaimable"
            : "liveness.blocked-ghost.observed",
          { bg_job_id: bgJobId, state, mode },
        );
      } catch {
        // Telemetry must never change the liveness verdict.
      }
    }
    if (mode === "enforce" && !reaped.has(shortId) && !reapPending.has(shortId)) {
      try {
        const result = emitReap?.("phase.terminal.reap-requested", {
          reason: "cat-171-blocked-ghost",
          bgJobId,
        });
        if (result?.then) {
          reapPending.add(shortId);
          Promise.resolve(result)
            .then((ok) => {
              if (ok !== false) reaped.add(shortId);
            })
            .catch(() => {})
            .finally(() => reapPending.delete(shortId));
        } else if (result !== false) {
          reaped.add(shortId);
        }
      } catch {
        // Cleanup intent emission is best-effort and cannot alter liveness.
      }
    }

    return mode === "enforce" ? false : alive;
  };
}
