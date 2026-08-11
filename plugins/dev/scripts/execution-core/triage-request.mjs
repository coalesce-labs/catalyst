import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export const TRIAGE_REQUEST_DIR = ".triage-requests";
export const TRIAGE_REQUEST_TTL_MS =
  Number(process.env.CATALYST_TRIAGE_REQUEST_TTL_MS) || 24 * 3600_000;
export const TRIAGE_REQUEST_ESCALATE_MS =
  Number(process.env.CATALYST_TRIAGE_REQUEST_ESCALATE_MS) || 45 * 60_000;
export const TRIAGE_REQUEST_ESCALATE_MODE = process.env.CATALYST_TRIAGE_REQUEST_ESCALATE || "shadow";
export const TRIAGE_DECLINE_REASONS = Object.freeze({
  NO_ORCH_DIR: "no-orch-dir",
  DRAIN_ACTIVE: "drain-active",
  NOT_OWNED_HRW: "not-owned-hrw",
  CAP_DEFERRED_IN_FLIGHT: "cap-deferred-in-flight",
  TRIAGE_DISPATCH_CAP: "triage-dispatch-cap",
  NO_FREE_SLOTS: "no-free-slots",
  DELEGATE_UNREADABLE: "delegate-unreadable-ctl1174",
  DELEGATE_PENDING: "delegate-pending-ctl1174",
  DELEGATED_OTHER_ACTOR: "delegated-other-actor",
  TRIAGE_STATE_REVALIDATION: "triage-state-revalidation",
  LOST_CROSS_HOST_CLAIM: "lost-cross-host-claim",
  STALE_SIGNAL_RETIRE_FAILED: "stale-signal-retire-failed",
  SPAWN_FAILED: "spawn-failed",
});

const workerPath = (orchDir, ticket, file) => join(orchDir, "workers", ticket, file);
const requestPath = (orchDir, ticket) => join(orchDir, TRIAGE_REQUEST_DIR, `${ticket}.json`);
// The scheduler's statSync probe intentionally remains independent of this monitor-shared leaf.
export const hasTriageArtifact = (orchDir, ticket) => existsSync(workerPath(orchDir, ticket, "triage.json"));
export function readTriageSignalStatus(orchDir, ticket) {
  try {
    const value = JSON.parse(
      readFileSync(workerPath(orchDir, ticket, "phase-triage.json"), "utf8"),
    );
    return typeof value?.status === "string" ? value.status : null;
  } catch {
    return null;
  }
}
export const isTriageInFlight = (status) => status === "dispatched" || status === "running" || status === "pending";
export function classifyTriageHold(orchDir, ticket) {
  if (hasTriageArtifact(orchDir, ticket)) return null;
  const status = readTriageSignalStatus(orchDir, ticket);
  if (isTriageInFlight(status)) return null;
  if (status === "done") return "stale-done";
  return status === null ? "untriaged" : "settled-no-artifact";
}
export function readTriageRequest(orchDir, ticket) {
  try {
    const request = JSON.parse(readFileSync(requestPath(orchDir, ticket), "utf8"));
    if (!request || request.ticket !== ticket) return null;
    return {
      ...request,
      team: typeof request.team === "string" && request.team.trim() ? request.team : null,
    };
  } catch {
    return null;
  }
}
function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
export function recordTriageRequest(
  orchDir,
  ticket,
  { team = null, class: holdClass, reason, holdStreak },
  { now = Date.now(), hostName = hostname() } = {},
) {
  const prior = readTriageRequest(orchDir, ticket);
  const record = {
    ticket,
    team: typeof team === "string" && team.trim() ? team : null,
    class: holdClass,
    reason,
    firstRequestedAt: prior?.firstRequestedAt ?? now,
    lastRequestedAt: now,
    holdStreak,
    requestedByHost: hostName,
    lastDecline: prior?.lastDecline ?? null,
    shadowEscalatedAt: prior?.shadowEscalatedAt ?? null,
    escalatedAt: prior?.escalatedAt ?? null,
  };
  atomicWrite(requestPath(orchDir, ticket), record);
  return record;
}
export function recordTriageDecline(
  orchDir,
  ticket,
  reason,
  { now = Date.now(), hostName = hostname() } = {},
) {
  const prior = readTriageRequest(orchDir, ticket);
  if (!prior || prior.lastDecline?.reason === reason) return { changed: false };
  atomicWrite(requestPath(orchDir, ticket), {
    ...prior,
    lastDecline: { reason, at: now, host: hostName },
  });
  return { changed: true };
}
export function markTriageRequestEscalated(
  orchDir,
  ticket,
  { now = Date.now(), shadow = false } = {},
) {
  const prior = readTriageRequest(orchDir, ticket);
  if (!prior) return false;
  atomicWrite(requestPath(orchDir, ticket), {
    ...prior,
    [shadow ? "shadowEscalatedAt" : "escalatedAt"]: now,
  });
  return true;
}
export function clearTriageRequest(orchDir, ticket) {
  const existed = existsSync(requestPath(orchDir, ticket));
  rmSync(requestPath(orchDir, ticket), { force: true });
  return existed;
}
export function listTriageRequests(orchDir) {
  try {
    return readdirSync(join(orchDir, TRIAGE_REQUEST_DIR))
      .filter((name) => name.endsWith(".json"))
      .map((name) => readTriageRequest(orchDir, name.slice(0, -5)))
      .filter(Boolean);
  } catch {
    return [];
  }
}
export function reapStaleTriageRequests(
  orchDir,
  { ttlMs = TRIAGE_REQUEST_TTL_MS, now = Date.now() } = {},
) {
  const ids = [];
  for (const request of listTriageRequests(orchDir)) {
    if (
      (!Number.isFinite(request.lastRequestedAt) || now - request.lastRequestedAt > ttlMs) &&
      clearTriageRequest(orchDir, request.ticket)
    ) {
      ids.push(request.ticket);
    }
  }
  return ids;
}
export function shouldEscalateTriageRequest(
  record,
  { now = Date.now(), escalateMs = TRIAGE_REQUEST_ESCALATE_MS, shadow = false } = {},
) {
  const reason = record?.lastDecline?.reason ?? "never-considered";
  const latch = shadow ? record?.shadowEscalatedAt : record?.escalatedAt;
  return {
    escalate: Boolean(record && !latch && now - record.firstRequestedAt >= escalateMs),
    reason,
  };
}
