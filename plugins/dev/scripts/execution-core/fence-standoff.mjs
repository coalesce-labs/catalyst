// fence-standoff.mjs — bounded escape from a mutual multi-host fencing standoff (CAT-173).
//
// This module changes no fence decision. It records repeated suppressions so a
// caller can eventually surface the condition out-of-band, without a Linear
// write or a fence dependency. Every I/O helper is fail-open and never throws.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";
import { recordDurableEscalation } from "./durable-escalation.mjs";

export const FENCE_STANDOFF_CAP_DEFAULT = 4;
export const FENCE_STANDOFF_MIN_AGE_MS_DEFAULT = 45 * 60_000;
export const FENCE_STANDOFF_COOLDOWN_MS_DEFAULT = 6 * 60 * 60_000;
// How many consecutive FAILED deliveries may bypass the caller's ordinary
// suppression cooldown before the retry falls back to that cooldown's cadence.
// A transient disk/event blip is retried immediately; a PERSISTENT one must not
// re-run the caller's per-tick probe forever (the CTL-1329 quota burn).
export const FENCE_STANDOFF_DELIVERY_RETRY_MAX_DEFAULT = 5;
export const FENCE_STANDOFF_EVENT = "escalation.fence-standoff.CTL-1";

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveStandoffCap(env = process.env) {
  return positiveNumber(env?.CATALYST_FENCE_STANDOFF_CAP, FENCE_STANDOFF_CAP_DEFAULT);
}

export function resolveStandoffMinAgeMs(env = process.env) {
  return positiveNumber(env?.CATALYST_FENCE_STANDOFF_MIN_AGE_MS, FENCE_STANDOFF_MIN_AGE_MS_DEFAULT);
}

export function resolveStandoffCooldownMs(env = process.env) {
  return positiveNumber(env?.CATALYST_FENCE_STANDOFF_COOLDOWN_MS, FENCE_STANDOFF_COOLDOWN_MS_DEFAULT);
}

export function resolveStandoffDeliveryRetryMax(env = process.env) {
  return positiveNumber(
    env?.CATALYST_FENCE_STANDOFF_DELIVERY_RETRY_MAX,
    FENCE_STANDOFF_DELIVERY_RETRY_MAX_DEFAULT,
  );
}

function standoffDir(orchDir) {
  return join(orchDir, ".fence-standoff");
}

function standoffPath(orchDir, ticket) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(ticket ?? ""))) {
    throw new Error("fence-standoff: invalid ticket identifier");
  }
  return join(standoffDir(orchDir), `${ticket}.json`);
}

export function readFenceStandoff(orchDir, ticket) {
  try {
    const path = standoffPath(orchDir, ticket);
    if (!existsSync(path)) return null;
    const rec = JSON.parse(readFileSync(path, "utf8"));
    return rec && typeof rec === "object" ? rec : null;
  } catch {
    return null;
  }
}

function writeRecord(orchDir, ticket, rec) {
  const dir = standoffDir(orchDir);
  mkdirSync(dir, { recursive: true });
  const path = standoffPath(orchDir, ticket);
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2));
  renameSync(tmp, path);
  return rec;
}

export function recordFenceSuppression({ orchDir, ticket, site, reason, now }) {
  const prior = readFenceStandoff(orchDir, ticket);
  const rec = {
    ticket,
    site,
    reason,
    firstSuppressedAt: Number.isFinite(prior?.firstSuppressedAt) ? prior.firstSuppressedAt : now,
    lastSuppressedAt: now,
    count: Number.isFinite(prior?.count) ? prior.count + 1 : 1,
    breakGlassAt: Number.isFinite(prior?.breakGlassAt) ? prior.breakGlassAt : null,
    // Consecutive failed break-glass deliveries. Preserved across suppression
    // ticks so a persistent failure can be bounded; reset only by
    // clearFenceStandoff (the episode ending).
    deliveryAttempts: Number.isFinite(prior?.deliveryAttempts) ? prior.deliveryAttempts : 0,
  };
  try {
    return writeRecord(orchDir, ticket, rec);
  } catch {
    return rec;
  }
}

export function markBreakGlass({ orchDir, ticket, now }) {
  const prior = readFenceStandoff(orchDir, ticket);
  if (!prior) return null;
  const rec = {
    ...prior,
    breakGlassAt: Number.isFinite(prior.breakGlassAt) ? prior.breakGlassAt : now,
  };
  try {
    return writeRecord(orchDir, ticket, rec);
  } catch {
    return rec;
  }
}

// markDeliveryAttempt — count one FAILED break-glass delivery and return the new
// running total. Fail-open: an unwritable record still reports the incremented
// count so the caller's bound is applied to this tick rather than skipped.
export function markDeliveryAttempt({ orchDir, ticket, record }) {
  const prior = Number.isFinite(record?.deliveryAttempts) ? record.deliveryAttempts : 0;
  const attempts = prior + 1;
  try {
    writeRecord(orchDir, ticket, { ...record, deliveryAttempts: attempts });
  } catch {
    // Fail open: bookkeeping must never interrupt a scheduler tick.
  }
  return attempts;
}

export function clearFenceStandoff(orchDir, ticket) {
  try {
    const path = standoffPath(orchDir, ticket);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Fail open: bookkeeping must never interrupt a scheduler tick.
  }
}

export function evaluateStandoff(rec, { now, cap, minAgeMs }) {
  if (!rec || !Number.isFinite(rec.count) || !Number.isFinite(rec.firstSuppressedAt)) {
    return { breakGlass: false, firstBreakGlass: false, ageMs: 0 };
  }
  const ageMs = now - rec.firstSuppressedAt;
  const breakGlass = rec.count >= cap && ageMs >= minAgeMs;
  return { breakGlass, firstBreakGlass: breakGlass && !Number.isFinite(rec.breakGlassAt), ageMs };
}

function defaultAppend(line) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
}

export function buildFenceStandoffEvent(
  { ticket, site, reason, count, ageMs } = {},
  {
    now = () => new Date(),
    newId = () => randomBytes(8).toString("hex"),
    newTrace = () => randomBytes(16).toString("hex"),
    newSpan = () => randomBytes(8).toString("hex"),
  } = {},
) {
  if (!ticket) throw new Error("buildFenceStandoffEvent: ticket is required");
  const ts = now().toISOString().replace(/\.\d{3}Z$/, "Z");
  return JSON.stringify({
    ts,
    id: newId(),
    observedTs: ts,
    severityText: "WARN",
    severityNumber: 13,
    traceId: newTrace(),
    spanId: newSpan(),
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      "event.name": `escalation.fence-standoff.${ticket}`,
      "event.entity": "escalation",
      "event.action": "fence-standoff",
      "event.label": ticket,
      "linear.issue.identifier": ticket,
    },
    body: { payload: { ticket, site, reason, count, ageMs } },
  }) + "\n";
}

export function appendFenceStandoffEvent(payload, { append = defaultAppend, build = buildFenceStandoffEvent } = {}) {
  try {
    append(build(payload));
    return true;
  } catch (err) {
    log.error({ err: err?.message, ticket: payload?.ticket }, "fence-standoff: append failed");
    return false;
  }
}

// maybeBreakGlass — shared best-effort suppression accounting for every
// escalation site. The caller still owns its fence decision; this helper only
// records a durable, out-of-band human signal once the count+age bound is met.
export function maybeBreakGlass({
  orchDir,
  ticket,
  site,
  verdict,
  phase = site,
  now,
  env = process.env,
  appendEvent = appendFenceStandoffEvent,
  recordEscalation = recordDurableEscalation,
  logger = log,
  detail = "",
}) {
  try {
    standoffPath(orchDir, ticket); // validate containment before any sink path is built
    const rec = recordFenceSuppression({
      orchDir,
      ticket,
      site,
      reason: verdict?.reason ?? "unknown",
      now,
    });
    const evaluation = evaluateStandoff(rec, {
      now,
      cap: resolveStandoffCap(env),
      minAgeMs: resolveStandoffMinAgeMs(env),
    });
    if (evaluation.firstBreakGlass) {
      const durableResult = recordEscalation({
        orchDir,
        ticket,
        phase,
        reason:
          `fence-standoff (${rec.reason}) at ${site}: ${ticket} is stuck but the ` +
          `fence suppressed every needs-human write${detail ? `; ${detail}` : ""}. ` +
          "Check cluster-generation.json divergence across hosts.",
        labelConfirmed: false,
        source: "fence-standoff",
        now: new Date(now).toISOString(),
      });
      let persistedDurable = null;
      try {
        persistedDurable = JSON.parse(readFileSync(
          join(orchDir, ".escalations", `${ticket}.json`),
          "utf8",
        ));
      } catch {
        persistedDurable = null;
      }
      const durableConfirmed = durableResult?.source === "fence-standoff"
        && persistedDurable?.source === "fence-standoff"
        && persistedDurable?.lastTs === new Date(now).toISOString();
      const eventConfirmed = durableConfirmed && appendEvent({
        ticket,
        site,
        reason: rec.reason,
        count: rec.count,
        ageMs: evaluation.ageMs,
      });
      // Persist the once-per-episode latch only after BOTH human-facing outputs
      // confirm. A transient disk/event failure stays retryable next tick.
      if (durableConfirmed && eventConfirmed === true) {
        markBreakGlass({ orchDir, ticket, now });
      } else {
        // Delivery failed. Report it as retryable ONLY while the consecutive-failure
        // count is under the bound: the caller drops its own suppression cooldown to
        // retry next tick, and an unbounded version of that re-runs the caller's
        // per-tick terminal probe + fence check forever on a PERSISTENTLY failing
        // sink — the CTL-1329 burn that froze fleet dispatch. Past the bound the
        // caller keeps its ordinary cooldown, so delivery still retries, just on the
        // ordinary cadence instead of every tick.
        const deliveryAttempts = markDeliveryAttempt({ orchDir, ticket, record: rec });
        return {
          ...evaluation,
          firstBreakGlass: true,
          record: rec,
          deliveryPending: true,
          deliveryAttempts,
          deliveryRetryable: deliveryAttempts <= resolveStandoffDeliveryRetryMax(env),
        };
      }
      logger?.warn?.(
        { ticket, site, reason: rec.reason, count: rec.count, ageMs: evaluation.ageMs },
        "cat-173: FENCE STANDOFF — wrote a durable escalation without a Linear label",
      );
    }
    return { ...evaluation, record: rec };
  } catch (err) {
    logger?.warn?.(
      { ticket, site, err: err?.message },
      "cat-173: standoff bookkeeping failed — continuing",
    );
    return { breakGlass: false, firstBreakGlass: false, ageMs: 0, record: null };
  }
}
