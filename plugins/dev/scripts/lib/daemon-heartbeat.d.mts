// Types for daemon-heartbeat.mjs (CTL-1280) — the runtime stays .mjs so the
// broker/execution-core .mjs daemons import it unchanged; this gives the TS
// consumers (orch-monitor/server.ts, otel-forward/index.ts) proper types.
export const DAEMON_HEARTBEAT_MSG: string;
export function logDaemonHeartbeat(
  log: { info: (obj: unknown, msg: string) => void },
  component: string,
): void;
