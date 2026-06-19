// daemon-heartbeat.mjs — CTL-1280. The single source of the daemon-liveness
// heartbeat marker. Every long-running daemon logs this line on its periodic loop
// to its .log file (broker.log / execution-core/daemon.log / otel-forward.log /
// monitor.log), which Alloy ships to Loki. A liveness check counts this EXACT line
// per service_name × catalyst_node_name over a short window — so the marker must
// stay in lockstep across all daemons AND the Loki query. Defining it once here
// prevents drift (a renamed marker on one daemon would silently read as "down").
export const DAEMON_HEARTBEAT_MSG = "daemon heartbeat";

// logDaemonHeartbeat — emit the heartbeat via a pino-style logger (broker,
// execution-core, otel-forward). The monitor writes to a plain console stream, so
// it uses DAEMON_HEARTBEAT_MSG directly instead of this helper.
export function logDaemonHeartbeat(log, component) {
  log.info({ hb: true, component }, DAEMON_HEARTBEAT_MSG);
}
