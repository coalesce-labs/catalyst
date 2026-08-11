// triage-sweep-health.mjs — per-team sustained held-sweep escalation (CAT-82).
// SIBLINGS: replica-health.mjs and reconcile-health.mjs deliberately remain
// separate because their degraded predicates and latch semantics differ.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getTriageSweepHealthDir,
  TRIAGE_SWEEP_HELD_ALERT_THRESHOLD,
  log,
} from "./config.mjs";
import {
  appendTriageSweepHealthEvent as defaultAppendEvent,
  TRIAGE_HELD_ACTION,
  TRIAGE_RECOVERED_ACTION,
} from "./triage-sweep-health-event.mjs";

const health = new Map();

function healthPath(team) {
  return join(getTriageSweepHealthDir(), `${team}.json`);
}

function defaultReadMarker(team) {
  try {
    const parsed = JSON.parse(readFileSync(healthPath(team), "utf8"));
    return {
      consecutiveHeld: typeof parsed.consecutiveHeld === "number" ? parsed.consecutiveHeld : 0,
      alerting: parsed.alerting === true,
    };
  } catch {
    return null;
  }
}

function ensureEntry(team, readMarker) {
  let entry = health.get(team);
  if (!entry) {
    entry = readMarker(team) ?? { consecutiveHeld: 0, alerting: false };
    health.set(team, entry);
  }
  return entry;
}

function defaultWriteMarker(team, state) {
  const dir = getTriageSweepHealthDir();
  mkdirSync(dir, { recursive: true });
  const path = healthPath(team);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ team, ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  renameSync(tmp, path);
}

export function recordTriageSweep(team, { considered = 0, heldDelegateUnreadable = 0 } = {}, {
  appendEvent = defaultAppendEvent,
  readMarker = defaultReadMarker,
  writeMarker = defaultWriteMarker,
  threshold = TRIAGE_SWEEP_HELD_ALERT_THRESHOLD,
} = {}) {
  try {
    const entry = ensureEntry(team, readMarker);
    // CAT-82 (review R1): a sweep with NO candidates is absence of evidence, not
    // evidence of recovery. Falling into the healthy branch here cleared a latched
    // outage the moment the queue emptied for an unrelated reason (every candidate
    // parked at TRIAGE_DISPATCH_CAP, or filtered by hasTriageArtifact) — emitting a
    // spurious monitor.triage.recovered.<team> mid-outage and deleting the team from
    // board-health's triageSweepHeld ring, which is the corroboration
    // checkTriageProduction depends on. Leave the streak and the latch untouched.
    if (considered === 0) return;
    const fullyHeld = heldDelegateUnreadable === considered;
    if (fullyHeld) {
      entry.consecutiveHeld += 1;
      if (entry.consecutiveHeld >= threshold && !entry.alerting) {
        const appended = appendEvent({ team, action: TRIAGE_HELD_ACTION, consecutiveHeld: entry.consecutiveHeld, considered, heldDelegateUnreadable });
        if (appended !== false) entry.alerting = true;
      }
    } else {
      entry.consecutiveHeld = 0;
      if (entry.alerting) {
        const appended = appendEvent({ team, action: TRIAGE_RECOVERED_ACTION, consecutiveHeld: 0, considered, heldDelegateUnreadable });
        if (appended !== false) entry.alerting = false;
      }
    }
    writeMarker(team, entry);
  } catch (err) {
    log.warn({ team, err: err.message }, "triage-sweep-health: update failed");
  }
}

export function resetTriageSweepHealth() {
  health.clear();
}
