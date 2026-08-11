// blocked-ghost.mjs — CAT-171 Source-A liveness policy.

import {
  agentStateForShortId,
  isBgJobAlive,
  TERMINAL_AGENT_STATES,
} from "./claude-agents.mjs";

// Return a drop-in isBgJobAlive probe. `off` is the exact base verdict;
// `shadow` observes blocked listings while preserving that verdict; `enforce`
// classifies them as not alive. All telemetry is best-effort.
export function makeBlockedGhostAwareIsBgJobAlive({
  mode = "shadow",
  emit = null,
  base = isBgJobAlive,
  terminalStates = TERMINAL_AGENT_STATES,
} = {}) {
  const emitted = new Set();

  return (bgJobId, options = {}) => {
    const alive = base(bgJobId, options);
    if (!alive || mode === "off") return alive;

    const shortId = String(bgJobId).slice(0, 8);
    const agents = options.agents;
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

    return mode === "enforce" ? false : alive;
  };
}
