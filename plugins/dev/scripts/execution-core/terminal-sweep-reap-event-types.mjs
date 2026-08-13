// Shared terminal-sweep reap event vocabulary. The producer and the closed
// reap-intent registry both import this leaf so they cannot drift.
export const TERMINAL_SWEEP_REAP_EVENT_TYPES = Object.freeze([
  "terminalSweep.would.reap-request",
]);
