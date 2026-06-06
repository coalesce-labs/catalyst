// ratelimit-event.mjs — CTL-787. Account-level Claude rate-limit usage event
// builder + best-effort appender. Mirrors memory-event.mjs's shape (OTel
// envelope, appendFileSync, never throws) so orch-monitor/HUD parsers treat
// these events identically.
//
// One event name:
//   account.ratelimit.sampled — INFO, emitted every poll tick with the live
//   account-level utilization snapshot from GET /api/oauth/usage.
//
// CRITICAL DIFFERENCE FROM memory-event: the numeric/string values are placed
// as LOG-RECORD attributes in DOT form (account.email, ratelimit.five_hour_pct,
// …) so the catalyst-otel collector can rename dot→underscore and Loki promotes
// them to labels — exactly how OTL-2 panels 50/51 consume them. A body.payload
// mirror of the same fields is kept for human readability.

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getEventLogPath, log } from "./config.mjs";

export const RATELIMIT_EVENT_SAMPLED = "account.ratelimit.sampled";

/**
 * buildRatelimitEnvelope — assemble the canonical OTel envelope for an account
 * rate-limit event. Pure (modulo random ids + timestamp); no I/O.
 *
 * @param {string} name   RATELIMIT_EVENT_SAMPLED
 * @param {object} payload
 * @param {object} [opts]
 * @param {Function} [opts.now]  injectable timestamp fn (returns ISO string)
 * @returns {object} the envelope object
 */
export function buildRatelimitEnvelope(name, payload = {}, { now } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const severityText = "INFO";
  const severityNumber = 9;
  const {
    email = null,
    fiveHourPct = null,
    sevenDayPct = null,
    fiveHourResetsAt = null,
    sevenDayResetsAt = null,
    opusPct = null,
    sonnetPct = null,
    subscriptionType = null,
    rateLimitTier = null,
  } = payload;
  const action = name.replace(/^account\./, "");

  // Only include a DOT-form attribute when its value is non-null/defined so the
  // collector never promotes an empty label.
  const attributes = {
    "event.name": name,
    "event.entity": "account",
    "event.action": action,
    "event.label": email ?? "unknown",
  };
  const put = (key, value) => {
    if (value !== null && value !== undefined) attributes[key] = value;
  };
  put("account.email", email);
  put("ratelimit.five_hour_pct", fiveHourPct);
  put("ratelimit.seven_day_pct", sevenDayPct);
  put("ratelimit.five_hour_resets_at", fiveHourResetsAt);
  put("ratelimit.seven_day_resets_at", sevenDayResetsAt);
  put("ratelimit.seven_day_opus_pct", opusPct);
  put("ratelimit.seven_day_sonnet_pct", sonnetPct);
  put("subscription.type", subscriptionType);
  put("rate_limit.tier", rateLimitTier);

  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText,
    severityNumber,
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    resource: {
      "service.name": "catalyst.execution-core",
      "service.namespace": "catalyst",
    },
    attributes,
    body: {
      payload: {
        email,
        fiveHourPct,
        sevenDayPct,
        fiveHourResetsAt,
        sevenDayResetsAt,
        opusPct,
        sonnetPct,
        subscriptionType,
        rateLimitTier,
      },
    },
  };
}

/**
 * emitRatelimitEvent — build + append one envelope line to the event log.
 * Returns true on success, false on any failure (best-effort; never throws).
 * `logPath` is injectable for tests; `now` is an optional injectable timestamp
 * fn forwarded into buildRatelimitEnvelope (defaults to real time).
 */
export function emitRatelimitEvent(name, payload, { logPath = getEventLogPath(), now } = {}) {
  const line = `${JSON.stringify(buildRatelimitEnvelope(name, payload, { now }))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message, name }, "ratelimit-event: event append failed");
    return false;
  }
}
