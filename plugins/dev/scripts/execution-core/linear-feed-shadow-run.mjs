#!/usr/bin/env bun
// linear-feed-shadow-run.mjs — CTL-1847, the standalone shadow-window runner.
//
// ── WHY STANDALONE RATHER THAN A DAEMON TIMER ───────────────────────────────
// The daemon already runs seven periodic timers and adding an eighth would be the
// obvious move. It is the wrong one FOR THE SHADOW WINDOW, for a deployment reason:
// a daemon timer means redeploying and restarting execution-core — the process that
// owns live dispatch — in order to run an experiment whose entire purpose is to find
// out whether the thing it hosts is correct. This script touches nothing the fleet
// depends on. It can start and stop while the fleet runs, and if it dies the fleet
// does not notice.
//
// The daemon timer is the right shape LATER, at cutover, when the producer's output
// is trusted and its lifecycle should match the dispatcher's. Precedent for the
// standalone form: `daemon-watchdog-run.mjs`, which hosts one probe on nodes whose
// class doesn't run the daemon.
//
// ⛔ SAFETY: this process writes ONLY to the shadow file. It never appends to
// `~/catalyst/events/YYYY-MM.jsonl`, never dispatches, never mutates Linear, and
// opens the replica read-only. The sink refuses an event-log path at construction,
// so "shadow" is enforced by the code rather than by this comment.
//
// Usage:
//   bun linear-feed-shadow-run.mjs [--once] [--interval-sec N] [--orch-dir DIR]
//
// `--once` runs a single sweep and exits — the form to use when driving coverage
// by hand against a scratch ticket.

import { getExecutionCoreDir } from "./config.mjs";
import { REQUIRED_CLASSES, coverageGaps, planTenants, runOnce } from "./linear-feed-run.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const ONCE = argv.includes("--once");
// --mode history runs the superseded producer for side-by-side comparison.
const MODE = flag("--mode", "diff");
const INTERVAL_SEC = Math.max(5, Number(flag("--interval-sec", "30")) || 30);
// ⚠️ SELF-LIMITING BY CONSTRUCTION. A shadow window is an experiment, and an
// experiment that outlives the person who started it is a leak. The deadline lives
// INSIDE the process so it dies on its own even if every external cleanup is broken
// — the AGENTS.md rule about background loops. Default 24h; --max-hours 0 disables
// it, which should be a deliberate, stated choice and not the default.
const MAX_HOURS = Number(flag("--max-hours", "24"));
const DEADLINE_MS = Number.isFinite(MAX_HOURS) && MAX_HOURS > 0 ? Date.now() + MAX_HOURS * 3600_000 : null;
const ORCH_DIR = flag("--orch-dir", null) ?? getExecutionCoreDir();


const TAG = "[linear-feed-shadow]";
const log = (msg, obj) => {
  const line = obj ? `${TAG} ${msg} ${JSON.stringify(obj)}` : `${TAG} ${msg}`;
  console.log(line);
};

let ticks = 0;
let stopping = false;

function tick() {
  if (stopping) return [];
  if (DEADLINE_MS !== null && Date.now() >= DEADLINE_MS) {
    log("deadline reached — stopping", { maxHours: MAX_HOURS, ticks });
    shutdown("deadline");
    return [];
  }
  ticks += 1;
  let reports;
  try {
    reports = runOnce({ orchDir: ORCH_DIR, plans });
  } catch (err) {
    // A throw here would kill the window silently under a supervisor that restarts
    // it; name it and keep ticking instead.
    log("tick failed", { tick: ticks, err: err?.message ?? String(err) });
    return [];
  }
  for (const r of reports) {
    if (r.skipped) {
      log("tenant skipped", { account: r.account, reason: r.skipped });
      continue;
    }
    if (r.error) {
      log("tenant errored", { account: r.account, err: r.error });
      continue;
    }
    const cov = r.coverage ?? { written: 0, classes: {} };
    log("swept", {
      account: r.account,
      mode: r.sweep?.mode,
      emitted: r.sweep?.edges?.emitted ?? 0,
      declined: r.sweep?.edges?.declined ?? 0,
      failed: r.sweep?.edges?.failed ?? 0,
      comments: r.sweep?.comments?.emitted ?? 0,
      written: cov.written,
    });
    if (r.sweep?.alarm) log("cursor alarm", r.sweep.alarm);
  }
  return reports;
}

function reportCoverage(reports) {
  const { merged, missing, complete } = coverageGaps(reports, REQUIRED_CLASSES);
  log("coverage", merged);
  if (!complete) {
    // Naming the gaps is the point: the window is DRIVEN to coverage on a scratch
    // ticket in hours, not waited out. At the measured CTL rate (~20 state edges/day)
    // several of these would never appear on their own inside 6h.
    log("coverage GAPS — manufacture these", { missing });
  } else {
    log("coverage COMPLETE — every required class observed");
  }
  return { merged, missing };
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log("shutting down", { signal, ticks });
  process.exit(0);
}

log("starting", { orchDir: ORCH_DIR, mode: MODE, once: ONCE, intervalSec: INTERVAL_SEC, maxHours: MAX_HOURS, deadline: DEADLINE_MS ? new Date(DEADLINE_MS).toISOString() : null });
const plans = planTenants({ orchDir: ORCH_DIR, mode: MODE });
for (const p of plans) {
  log("tenant", { account: p.account, teams: [...(p.teams ?? [])], skip: p.skip, shadow: p.shadowPath });
}

if (ONCE) {
  // ⚠️ Report coverage from the sweep we just RAN. An earlier cut called
  // runOnce({plans: []}) here, which sweeps nothing, returns [], and would have
  // reported every required class as missing immediately after a successful run —
  // the `[].every()` false-report shape: an all-clear (or in this case an
  // all-missing) derived from having looked at nothing.
  const { missing } = reportCoverage(tick());
  process.exit(missing.length > 0 ? 2 : 0);
} else {
  tick();
  const timer = setInterval(tick, INTERVAL_SEC * 1000);
  timer.unref?.();
  // Keep the process alive without a busy loop — the same keepAlive idiom
  // daemon-watchdog-run.mjs uses.
  const keepAlive = setInterval(() => {}, 1 << 30);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    clearInterval(keepAlive);
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    clearInterval(timer);
    clearInterval(keepAlive);
    shutdown("SIGINT");
  });
}
