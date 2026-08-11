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

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { startDaemonWatchdogProbe } from "./daemon-watchdog-probe.mjs";
import { readDaemonWatchdogConfig, log } from "./config.mjs";

// Codex P1: resolve the Layer-1 config path the SAME way daemon.mjs does
// (CATALYST_CONFIG_FILE, else <cwd>/.catalyst/config.json). Calling
// readDaemonWatchdogConfig() with no path makes readDaemonWatchdogConfigLayer1
// return {} unconditionally, so every documented Layer-1 knob —
// `daemonWatchdog.mode: "enforce"` / `"off"` and all thresholds — would be
// silently ignored here. On a monitor node this is the ONLY watchdog host, so
// that would strand its forwarder shadow-only while workers honored the very
// same config file.
// CAT-139: a third, explicit tier ahead of the two ambient ones lets direct
// callers select a config without inheriting the host's live config. Mirrors
// lib/deployment-mode.mjs resolveLayer1Path (explicit arg > env > cwd).
// Production passes no args and continues to pin CATALYST_CONFIG_FILE.
// Unknown argv is REJECTED rather than ignored. A near-miss invocation
// (`--conifg <path>`) that fell through to the ambient tier would start a LIVE
// watchdog on the host's own config — the exact silent leak this argument
// exists to prevent — and would do so while looking like it had honored the
// caller's file. Production passes no args, so nothing legitimate is rejected.
function resolveConfigPath(argv, env) {
  let value;
  let sawConfig = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      sawConfig = true;
      value = argv[i + 1];
      i += 1;
      continue;
    }
    // GNU `--config=<path>`. Split on the FIRST `=` only: a path may contain one.
    if (arg.startsWith("--config=")) {
      sawConfig = true;
      value = arg.slice("--config=".length);
      continue;
    }
    return { error: `unrecognized argument: ${arg}` };
  }
  if (sawConfig) {
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      return { error: "--config requires a path argument" };
    }
    const path = resolve(value);
    // An explicit path fails closed; falling through would recreate the host
    // config leak this argument exists to prevent.
    if (!existsSync(path)) return { error: `--config file not found: ${path}` };
    try {
      if (!statSync(path).isFile()) {
        return { error: `--config path is not a readable regular file: ${path}` };
      }
      JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      if (err instanceof SyntaxError) {
        return { error: `--config file is not valid JSON: ${path}` };
      }
      return { error: `--config path is not a readable regular file: ${path}` };
    }
    return { path, source: "argv" };
  }
  if (typeof env.CATALYST_CONFIG_FILE === "string" && env.CATALYST_CONFIG_FILE.length > 0) {
    return { path: env.CATALYST_CONFIG_FILE, source: "env" };
  }
  return { path: resolve(process.cwd(), ".catalyst", "config.json"), source: "cwd" };
}

const resolved = resolveConfigPath(process.argv.slice(2), process.env);
if (resolved.error) {
  log.error({ err: resolved.error }, "daemon-watchdog-run: bad arguments");
  process.exit(2);
}
const { path: configPath, source: configSource } = resolved;

const config = readDaemonWatchdogConfig(configPath);

if (!config.enabled) {
  // Not an error: the knob is off for this node. Exit 0 so a supervisor treats
  // it as a clean no-op rather than a crash to restart forever.
  log.info(
    { mode: config.mode, configPath, configSource },
    "daemon-watchdog-run: disabled by config — exiting",
  );
  process.exit(0);
}

log.info(
  { mode: config.mode, intervalMs: config.intervalMs, configPath, configSource },
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
