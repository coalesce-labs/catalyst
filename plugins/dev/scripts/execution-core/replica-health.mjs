// replica-health.mjs — per-team replica-read health escalation (CAT-35).
// SIBLING: reconcile-health.mjs — same shape, deliberately not shared (CAT-35).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getReplicaHealthDir, REPLICA_DEGRADED_ALERT_THRESHOLD, log } from "./config.mjs";
import { appendReplicaHealthEvent as defaultAppendEvent, REPLICA_DEGRADED_ACTION, REPLICA_RECOVERED_ACTION } from "./replica-health-event.mjs";

const DEGRADED_SOURCES = new Set(["no-replica", "replica-miss"]);
const health = new Map();

function healthPath(team) {
  return join(getReplicaHealthDir(), `${team}.json`);
}

function defaultReadMarker(team) {
  try {
    const parsed = JSON.parse(readFileSync(healthPath(team), "utf8"));
    return {
      consecutiveDegraded:
        typeof parsed.consecutiveDegraded === "number" ? parsed.consecutiveDegraded : 0,
      lastHealthyTs: parsed.lastHealthyTs ?? null,
      alerting: parsed.alerting === true,
    };
  } catch {
    return null;
  }
}

function ensureEntry(team, readMarker) {
  let entry = health.get(team);
  if (!entry) {
    entry = readMarker(team) ?? {
      consecutiveDegraded: 0,
      lastHealthyTs: null,
      alerting: false,
    };
    health.set(team, entry);
  }
  return entry;
}

function defaultWriteMarker(team, state) {
  const dir = getReplicaHealthDir();
  mkdirSync(dir, { recursive: true });
  const path = healthPath(team);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ team, ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  renameSync(tmp, path);
}

export function recordReplicaRead(team, source, {
  appendEvent = defaultAppendEvent,
  readMarker = defaultReadMarker,
  writeMarker = defaultWriteMarker,
  threshold = REPLICA_DEGRADED_ALERT_THRESHOLD,
} = {}) {
  try {
    if (!DEGRADED_SOURCES.has(source) && source !== "replica") return;
    const entry = ensureEntry(team, readMarker);
    if (DEGRADED_SOURCES.has(source)) {
      entry.consecutiveDegraded += 1;
      if (entry.consecutiveDegraded >= threshold && !entry.alerting) {
        const appended = appendEvent({ team, action: REPLICA_DEGRADED_ACTION, source, consecutiveDegraded: entry.consecutiveDegraded });
        if (appended !== false) entry.alerting = true;
      }
    } else if (source === "replica") {
      const wasAlerting = entry.alerting;
      entry.consecutiveDegraded = 0;
      entry.lastHealthyTs = new Date().toISOString();
      entry.alerting = false;
      if (wasAlerting) appendEvent({ team, action: REPLICA_RECOVERED_ACTION, source, consecutiveDegraded: 0 });
    }
    writeMarker(team, entry);
  } catch (err) {
    log.warn({ team, source, err: err.message }, "replica-health: update failed");
  }
}

export function resetReplicaHealth() { health.clear(); }
