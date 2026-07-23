// daemon-watchdog-probe.mjs — CTL-1502. The stuck-but-alive daemon watchdog
// probe. A structural clone of startFleetHealthProbe (fleet-health-probe.mjs):
// injected IO, safeAsync() non-crossing sentinels, per-target hysteresis,
// off/shadow/enforce gating, restart-with-cooldown, a post-restart verify window,
// and escalation. Returns { stop, tick }.
//
// Per-target state machine (one episode = one contiguous stuck period):
//   healthy tick        → clear (if raised) + reset the episode (restartedAt KEPT
//                         so the cooldown spans episodes); re-arm.
//   stuck, < sustained  → hysteresis: count, do nothing.
//   stuck, sustained,   → restart ONCE (enforce) / log would-restart (shadow),
//     not yet restarted   respecting the cooldown from the previous episode.
//   stuck, restarted    → verify window: after verifyTicks still stuck → escalate
//                         ONCE (latched, non-clearing); never a 2nd restart this
//                         episode.
//
// shadow is a faithful dry-run: it advances the SAME state machine and logs
// would-restart / would-clear / would-escalate, but calls NONE of restart/alert.*
// (mutates nothing). enforce performs the real side effects. off is a no-op.
//
// Every side effect is injected and every reader is wrapped in safeAsync so a
// throw yields a non-crossing sentinel — the tick can never wedge the daemon
// (CTL-988 "a tap must never be load-bearing").

import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readDlqBytes as defaultReadDlqBytes,
  readLagStuck as defaultReadLagStuck,
  classifyDaemonStuck,
  DAEMON_WATCHDOG_TARGETS,
} from "./daemon-watchdog-predicates.mjs";
import {
  raiseAlert as defaultRaiseAlert,
  clearAlert as defaultClearAlert,
  escalate as defaultEscalate,
  getWatchdogDir,
} from "./daemon-watchdog-alert.mjs";
import { readDaemonWatchdogConfig, getEventLogPath, log as defaultLog } from "./config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MONITOR_SCRIPT = join(__dirname, "..", "catalyst-monitor.sh");

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

// safeAsync() — await a reader, returning its value or the sentinel on any error.
async function safeAsync(fn, sentinel) {
  try {
    const v = await fn();
    return v === undefined || v === null ? sentinel : v;
  } catch {
    return sentinel;
  }
}

// defaultRestart — shell catalyst-monitor.sh <restartArgs> (Phase 1's atomic
// forward-restart). Rejects on non-zero exit so the caller's try/catch can log it.
function defaultRestart(target) {
  return new Promise((resolve, reject) => {
    execFile(MONITOR_SCRIPT, target.restartArgs ?? [], (err) => (err ? reject(err) : resolve()));
  });
}

function initState() {
  return {
    sustained: 0, // consecutive stuck ticks this episode
    firstBreachAt: null, // ms of the first stuck tick this episode
    restarted: false, // already restarted (or would-restart in shadow) this episode
    restartedAt: null, // ms of the last restart — PERSISTS across episodes (cooldown)
    verifyCount: 0, // ticks counted in the post-restart verify window
    escalated: false, // escalation already fired this episode
    raised: false, // alert currently raised (real in enforce; internal flag in shadow)
  };
}

// resetEpisode — a healthy tick ends the episode. Clears everything EXCEPT
// restartedAt, so the cooldown gate spans the gap between episodes.
function resetEpisode(s) {
  s.sustained = 0;
  s.firstBreachAt = null;
  s.restarted = false;
  s.verifyCount = 0;
  s.escalated = false;
  // s.raised is cleared by the caller after emitting the clear; s.restartedAt kept.
}

export function startDaemonWatchdogProbe({
  clock = realClock(),
  config = readDaemonWatchdogConfig(),
  targets = DAEMON_WATCHDOG_TARGETS,
  readDlqBytes = defaultReadDlqBytes,
  readLagStuck = defaultReadLagStuck,
  restart = defaultRestart,
  alert = { raiseAlert: defaultRaiseAlert, clearAlert: defaultClearAlert, escalate: defaultEscalate },
  now = () => Date.now(),
  log = defaultLog,
  io = null,
} = {}) {
  const { mode, intervalMs, dlqMaxBytes, stalenessMs, cooldownMs, sustainedTicks, verifyTicks } = config;
  // Default io for the alert sinks (log line + marker + best-effort event log).
  const alertIo = io ?? {
    log,
    logPath: getEventLogPath(),
    markerDir: getWatchdogDir(),
    now: () => new Date().toISOString(),
  };
  const enforce = mode === "enforce";
  const state = new Map();

  function getState(name) {
    let s = state.get(name);
    if (!s) {
      s = initState();
      state.set(name, s);
    }
    return s;
  }

  async function tick() {
    if (mode === "off") return; // defensive — the daemon gates on enabled anyway
    for (const t of targets) {
      // A target with an unresolvable path can't be probed — skip it, keep going.
      if (!t?.dlqPath || !t?.checkpointPath) {
        log.warn?.({ daemon: t?.name }, "daemon-watchdog: target skipped (unresolvable path)");
        continue;
      }
      const nowMs = now();
      const dlqBytes = await safeAsync(() => readDlqBytes(t.dlqPath), 0);
      const lagStuck = await safeAsync(
        () =>
          readLagStuck({
            checkpointPath: t.checkpointPath,
            eventLogPath: alertIo.logPath ?? getEventLogPath(),
            stalenessMs,
            now: nowMs,
          }),
        false,
      );
      const { stuck, tripped } = classifyDaemonStuck({ dlqBytes, lagStuck }, { dlqMaxBytes });
      const s = getState(t.name);

      if (!stuck) {
        if (s.raised) {
          const sinceMs = s.firstBreachAt != null ? nowMs - s.firstBreachAt : 0;
          if (enforce) alert.clearAlert(t, { sinceMs }, alertIo);
          else log.info?.({ daemon: t.name }, "daemon-watchdog: would-clear (shadow)");
          s.raised = false;
        }
        resetEpisode(s);
        continue;
      }

      s.sustained += 1;
      if (s.firstBreachAt == null) s.firstBreachAt = nowMs;
      const sinceMs = nowMs - s.firstBreachAt;

      // Post-restart verify window: already restarted this episode → count ticks;
      // still stuck after verifyTicks → escalate ONCE (latched). Never restart again.
      if (s.restarted) {
        s.verifyCount += 1;
        if (s.verifyCount >= verifyTicks && !s.escalated) {
          if (enforce) alert.escalate(t, { tripped, sinceMs }, alertIo);
          else log.warn?.({ daemon: t.name, tripped }, "daemon-watchdog: would-escalate (shadow)");
          s.escalated = true;
          s.raised = true; // latched — the raised alert is NOT cleared on escalation
        }
        continue;
      }

      if (s.sustained < sustainedTicks) continue; // hysteresis — not yet sustained

      // Sustained breach, not yet restarted this episode. Respect the cooldown
      // carried over from a previous episode's restart.
      if (s.restartedAt != null && nowMs - s.restartedAt < cooldownMs) continue;

      if (enforce) {
        alert.raiseAlert(t, { tripped, sinceMs }, alertIo);
        s.raised = true;
        try {
          await restart(t);
        } catch (err) {
          log.warn?.({ daemon: t.name, err: err?.message }, "daemon-watchdog: restart failed");
        }
      } else {
        // shadow: advance the state machine + log, but perform NO side effect.
        log.warn?.({ daemon: t.name, tripped }, "daemon-watchdog: would-restart (shadow)");
        s.raised = true; // internal "would-be-raised" flag so the verify window runs
      }
      s.restarted = true;
      s.restartedAt = nowMs;
    }
  }

  const handle = clock.setInterval(() => {
    tick().catch(() => {});
  }, intervalMs);
  if (typeof handle?.unref === "function") handle.unref();
  return { stop: () => clock.clearInterval(handle), tick };
}
