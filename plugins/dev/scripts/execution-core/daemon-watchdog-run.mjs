#!/usr/bin/env bun
// daemon-watchdog-run.mjs — CTL-1502 (Codex P1: "run the forwarder watchdog on
// monitor nodes"). A standalone host for startDaemonWatchdogProbe.
//
// WHY THIS EXISTS. The watchdog is normally armed from startDaemon(), but
// `catalyst-stack` starts otel-forward on BOTH worker and monitor nodes while
// starting execution-core on worker nodes ONLY (a monitor node is observation
// substrate — broker + monitor + forward + event-mirror, no execution layer).
// A monitor node's forwarder was therefore supervised by pid-liveness alone and
// never got the stuck detection this ticket adds — precisely the gap the
// watchdog exists to close, on the nodes whose whole job is observation.
//
// Rather than start an execution layer on observation nodes (which would
// contradict the node-class design), this runs ONLY the probe: the same
// startDaemonWatchdogProbe, the same config resolution, the same targets.
// On a worker node the probe stays owned by the daemon, so exactly one process
// supervises the forwarder in either topology.
//
// Lifecycle: `catalyst-monitor watchdog-start|watchdog-stop|watchdog-status`
// supervises this with a pid file, mirroring the forward-* commands.

import { startDaemonWatchdogProbe } from "./daemon-watchdog-probe.mjs";
import { readDaemonWatchdogConfig, log } from "./config.mjs";

const config = readDaemonWatchdogConfig();

if (!config.enabled) {
  // Not an error: the knob is off for this node. Exit 0 so a supervisor treats
  // it as a clean no-op rather than a crash to restart forever.
  log.info({ mode: config.mode }, "daemon-watchdog-run: disabled by config — exiting");
  process.exit(0);
}

log.info(
  { mode: config.mode, intervalMs: config.intervalMs },
  "daemon-watchdog-run: standalone watchdog started (observation node)",
);

const probe = startDaemonWatchdogProbe({ config });

// The probe unrefs its interval so it cannot by itself hold the loop open; this
// ref keeps the STANDALONE process alive (in-daemon there is always other work).
const keepAlive = setInterval(() => {}, 1 << 30);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return; // a second signal must not re-enter
  shuttingDown = true;
  log.info({ signal }, "daemon-watchdog-run: shutting down");
  clearInterval(keepAlive);
  // stop() aborts an in-flight restart and returns the settled transaction, so
  // we never exit while a forward-restart child is still mid-stop/start.
  Promise.resolve(probe.stop())
    .catch(() => {})
    .finally(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
