// triage-state-health.mjs — per-team structural triage-state fault latch (CAT-140).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTriageStateHealthDir, TRIAGE_STATE_REPROBE_MS, log } from "./config.mjs";
import { TRANSITION_STATE_ABSENT } from "./linear-write.mjs";
import {
  appendTriageStateHealthEvent as defaultAppendEvent,
  TRIAGE_STATE_MISSING_ACTION,
  TRIAGE_STATE_RECOVERED_ACTION,
} from "./triage-state-health-event.mjs";

const health = new Map();

function healthPath(team) { return join(getTriageStateHealthDir(), `${team}.json`); }

function cleanEntry() {
  return { expectedState: null, faulted: false, alerting: false, consecutiveStructural: 0, firstSeenTs: null, lastProbeAt: null };
}

function defaultReadMarker(team) {
  try {
    const p = JSON.parse(readFileSync(healthPath(team), "utf8"));
    if (!p || typeof p !== "object") return null;
    return {
      expectedState: typeof p.expectedState === "string" ? p.expectedState : null,
      faulted: p.faulted === true,
      alerting: p.alerting === true,
      consecutiveStructural: Number.isFinite(p.consecutiveStructural) ? p.consecutiveStructural : 0,
      firstSeenTs: typeof p.firstSeenTs === "string" ? p.firstSeenTs : null,
      lastProbeAt: typeof p.lastProbeAt === "number" ? p.lastProbeAt : null,
    };
  } catch { return null; }
}

function ensureEntry(team, readMarker) {
  let entry = health.get(team);
  if (!entry) {
    const hydrated = readMarker(team);
    entry = hydrated && typeof hydrated === "object" ? { ...cleanEntry(), ...hydrated } : cleanEntry();
    health.set(team, entry);
  }
  return entry;
}

function defaultWriteMarker(team, state) {
  const dir = getTriageStateHealthDir();
  mkdirSync(dir, { recursive: true });
  const path = healthPath(team);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ team, ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  renameSync(tmp, path);
}

export function recordTriageStateWrite(team, { reason, verified, expectedState } = {}, {
  appendEvent = defaultAppendEvent, readMarker = defaultReadMarker, writeMarker = defaultWriteMarker,
  nowMs = Date.now(),
} = {}) {
  if (!team) return;
  try {
    const entry = ensureEntry(team, readMarker);
    if (reason === TRANSITION_STATE_ABSENT) {
      entry.expectedState = expectedState ?? entry.expectedState;
      entry.faulted = true;
      entry.consecutiveStructural += 1;
      entry.firstSeenTs ??= new Date(nowMs).toISOString();
      entry.lastProbeAt = nowMs;
      if (!entry.alerting) {
        const appended = appendEvent({ team, action: TRIAGE_STATE_MISSING_ACTION, expectedState: entry.expectedState, ticketsAffected: entry.consecutiveStructural });
        if (appended !== false) entry.alerting = true;
      }
    } else if (verified === true) {
      entry.faulted = false;
      entry.consecutiveStructural = 0;
      entry.firstSeenTs = null;
      if (expectedState != null) entry.expectedState = expectedState;
      if (entry.alerting) {
        const appended = appendEvent({ team, action: TRIAGE_STATE_RECOVERED_ACTION, expectedState: entry.expectedState, ticketsAffected: 0 });
        if (appended !== false) entry.alerting = false;
      }
    } else return;
    writeMarker(team, entry);
  } catch (err) {
    log.warn({ team, reason, err: err.message }, "triage-state-health: update failed");
  }
}

export function isTriageStateFaulted(team, { readMarker = defaultReadMarker } = {}) {
  if (!team) return false;
  try { return ensureEntry(team, readMarker).faulted === true; }
  catch (err) { log.warn({ team, err: err.message }, "triage-state-health: read failed"); return false; }
}

export function shouldProbeTriageState(team, { nowMs = Date.now(), reprobeMs = TRIAGE_STATE_REPROBE_MS } = {}, { readMarker = defaultReadMarker } = {}) {
  if (!team) return true;
  try {
    const entry = ensureEntry(team, readMarker);
    if (!entry.faulted) return true;
    return entry.lastProbeAt == null || nowMs - entry.lastProbeAt >= reprobeMs;
  } catch (err) { log.warn({ team, err: err.message }, "triage-state-health: probe read failed"); return true; }
}

export function markTriageStateProbe(team, { readMarker = defaultReadMarker, writeMarker = defaultWriteMarker, nowMs = Date.now() } = {}) {
  if (!team) return;
  try { const entry = ensureEntry(team, readMarker); entry.lastProbeAt = nowMs; writeMarker(team, entry); }
  catch (err) { log.warn({ team, err: err.message }, "triage-state-health: probe update failed"); }
}

export function resetTriageStateHealth() { health.clear(); }
