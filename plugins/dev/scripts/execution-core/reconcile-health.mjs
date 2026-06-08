// reconcile-health.mjs — per-team reconcile-health tracking + escalation (CTL-867).
//
// The bug: when a team's eligibleQuery errors every reconcile poll (e.g. its
// status references a removed Linear state → `linearis issues list --team X
// --status Ready` exits 1), reconcileProject's catch preserves the prior
// eligible set and logs `reconcile poll failed — preserving prior eligible set`.
// That is correct for a transient blip, but a PERSISTENT failure freezes the
// team's eligible projection stale for hours: no new Todo tickets ever become
// eligible, the daemon looks healthy, and the whole team starves invisibly.
//
// This module is the visibility fix. It tracks per-team reconcile health on the
// monitor (consecutive-failure count + last-successful-refresh timestamp),
// escalates a canonical `monitor.reconcile.failing.<TEAM>` event to the unified
// event log after N consecutive failures (so the orch-monitor dashboard surfaces
// the failing team), and clears the alert (emitting `monitor.reconcile.recovered
// .<TEAM>`) when a poll succeeds again. It also persists a per-team health marker
// file the orch-monitor server reads to render each team's "last successful
// eligible refresh age".

import { writeFileSync, readFileSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  getReconcileHealthDir,
  RECONCILE_FAILURE_ALERT_THRESHOLD,
  log,
} from "./config.mjs";
import {
  appendReconcileHealthEvent as defaultAppendEvent,
  RECONCILE_FAILING_ACTION,
  RECONCILE_RECOVERED_ACTION,
} from "./reconcile-health-event.mjs";

// team -> { consecutiveFailures, lastSuccessTs, alerting }
const health = new Map();

function healthPath(team) {
  return join(getReconcileHealthDir(), `${team}.json`);
}

// writeHealthMarker — atomically persist a team's health marker. Best-effort: a
// disk fault must never crash the reconcile timer, so a write failure is logged
// and swallowed (the in-memory state remains authoritative; the next reconcile
// retries the marker write).
function writeHealthMarker(team, state) {
  const body = JSON.stringify(
    {
      team,
      lastSuccessTs: state.lastSuccessTs,
      consecutiveFailures: state.consecutiveFailures,
      alerting: state.alerting,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  );
  try {
    mkdirSync(getReconcileHealthDir(), { recursive: true });
    const file = healthPath(team);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, file);
  } catch (err) {
    log.warn({ team, err: err.message }, "reconcile-health: marker write failed");
  }
}

// ensureEntry — return the in-memory health entry for `team`, creating it lazily.
//
// CTL-867 cross-restart fix: the in-memory `health` Map is empty on every process
// start, so the first call after a daemon restart would otherwise seed a FRESH
// {consecutiveFailures:0, lastSuccessTs:null, alerting:false}. For a team that has
// been failing for hours, the very next failure would then writeHealthMarker over
// the truthful disk marker — resetting consecutiveFailures to 1, dropping the real
// lastSuccessTs to null, and clearing the alerting latch. That defeats the exact
// cross-restart starvation scenario this module targets. So on first touch we
// HYDRATE the seed from the persisted per-team marker; only an absent/malformed
// marker falls back to fresh defaults.
function ensureEntry(team) {
  let entry = health.get(team);
  if (!entry) {
    entry = hydrateEntry(team) ?? {
      consecutiveFailures: 0,
      lastSuccessTs: null,
      alerting: false,
    };
    health.set(team, entry);
  }
  return entry;
}

// hydrateEntry — read a team's persisted health marker and project it into a
// fresh in-memory entry, preserving consecutiveFailures / lastSuccessTs / alerting
// across a process restart. Returns null when the marker is absent or unreadable
// (caller falls back to fresh defaults). Never throws — a disk fault must never
// crash the reconcile timer. Reuses readReconcileHealthMarkers' parse/coercion so
// the hydrated shape matches the marker schema exactly.
function hydrateEntry(team) {
  try {
    const markers = readReconcileHealthMarkers();
    const marker = markers[team];
    if (!marker) return null;
    return {
      consecutiveFailures:
        typeof marker.consecutiveFailures === "number" ? marker.consecutiveFailures : 0,
      lastSuccessTs: marker.lastSuccessTs ?? null,
      alerting: marker.alerting === true,
    };
  } catch {
    return null; // best-effort: any read/parse fault → fresh defaults
  }
}

// recordReconcileSuccess — a reconcile poll succeeded for `team`. Resets the
// consecutive-failure counter, stamps lastSuccessTs, and — if the team was
// alerting — emits a recovery event and clears the alert. Best-effort throughout;
// the `appendEvent`/`now` seams are injectable for tests.
export function recordReconcileSuccess(
  team,
  { appendEvent = defaultAppendEvent, now = () => new Date().toISOString() } = {},
) {
  const entry = ensureEntry(team);
  const wasAlerting = entry.alerting;
  const priorFailures = entry.consecutiveFailures;
  entry.consecutiveFailures = 0;
  entry.lastSuccessTs = now();
  entry.alerting = false;
  if (wasAlerting) {
    log.info(
      { team, priorFailures },
      "reconcile-health: team recovered — eligible set refreshing again (CTL-867)",
    );
    appendEvent({
      team,
      action: RECONCILE_RECOVERED_ACTION,
      consecutiveFailures: 0,
      lastSuccessTs: entry.lastSuccessTs,
      reason: "reconcile-poll-succeeded",
    });
  }
  writeHealthMarker(team, entry);
}

// recordReconcileFailure — a reconcile poll threw for `team`. Increments the
// consecutive-failure counter; once it crosses RECONCILE_FAILURE_ALERT_THRESHOLD
// (and the team is not already alerting), escalates a single
// monitor.reconcile.failing.<TEAM> event so the failure surfaces on the
// dashboard instead of staying buried in a log.error. The alert is emitted ONCE
// per failing streak (the `alerting` latch) — a recovery clears it. Best-effort;
// `appendEvent`/`threshold` seams are injectable for tests.
export function recordReconcileFailure(
  team,
  reason,
  {
    appendEvent = defaultAppendEvent,
    threshold = RECONCILE_FAILURE_ALERT_THRESHOLD,
  } = {},
) {
  const entry = ensureEntry(team);
  entry.consecutiveFailures += 1;
  const staleMs = entry.lastSuccessTs
    ? Date.now() - Date.parse(entry.lastSuccessTs)
    : null;
  if (entry.consecutiveFailures >= threshold && !entry.alerting) {
    entry.alerting = true;
    log.error(
      { team, consecutiveFailures: entry.consecutiveFailures, lastSuccessTs: entry.lastSuccessTs },
      "reconcile-health: team reconcile failing persistently — escalating monitor.reconcile.failing (CTL-867)",
    );
    appendEvent({
      team,
      action: RECONCILE_FAILING_ACTION,
      consecutiveFailures: entry.consecutiveFailures,
      lastSuccessTs: entry.lastSuccessTs,
      staleMs,
      reason: reason ?? "reconcile-poll-failed",
    });
  }
  writeHealthMarker(team, entry);
}

// getReconcileHealth — a copy of a team's in-memory health state, or null when
// the team has never been reconciled this process. Test/inspection helper.
export function getReconcileHealth(team) {
  const entry = health.get(team);
  return entry ? { ...entry } : null;
}

// readReconcileHealthMarkers — read every persisted per-team health marker as a
// { [team]: marker } map. Used by the orch-monitor server to surface per-team
// "last successful eligible refresh age" in /api/snapshot. Never throws: a
// missing dir, an unreadable/malformed marker, or an absent field yields an
// empty/partial map. `dir` is injectable for tests.
export function readReconcileHealthMarkers({ dir = getReconcileHealthDir() } = {}) {
  const out = {};
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return out; // dir absent — no team has been reconciled yet
  }
  for (const f of files) {
    if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
    const team = f.slice(0, -".json".length);
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
      out[team] = {
        team,
        lastSuccessTs: parsed.lastSuccessTs ?? null,
        consecutiveFailures:
          typeof parsed.consecutiveFailures === "number" ? parsed.consecutiveFailures : 0,
        alerting: parsed.alerting === true,
        updatedAt: parsed.updatedAt ?? null,
      };
    } catch {
      // unreadable / malformed marker — skip this team, keep the rest
    }
  }
  return out;
}

// __resetReconcileHealthForTests — clear the in-memory health map between tests.
// Not part of the public contract.
export function __resetReconcileHealthForTests() {
  health.clear();
}
