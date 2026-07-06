// linear-ratelimit-event.mjs — CTL-1430 (WS-A A1). Durable open/close event for
// the CTL-679 Linear rate-limit circuit breaker.
//
// Mirrors drain-event.mjs: OTel envelope, appendFileSync, never throws.
// One event type, two states:
//   linear.ratelimit.breaker (state:"open")   — a Linear call tripped the breaker
//   linear.ratelimit.breaker (state:"closed") — a clean call closed it again
//
// The OPEN event carries WHY (`reason`: "429" | "timeout") and WHO (`caller`: a
// compact tag derived from the linearis argv or passed explicitly), so the
// steadily-flapping breaker (CTL-1430 diagnosis: 12–22 opens/hr on mini, trigger
// invisible in logs) becomes attributable from the unified event log — and
// board-health invariant #2 can consume it (`deriveRing`) so Linear degradation
// is `observable:true` instead of Anthropic-only.
//
// `linear.*` is NOT a broker-protected namespace (FORBIDDEN_PREFIXES = filter.,
// broker.daemon; PROTECTED_EXACT = session.heartbeat — see
// broker/namespace-contract.mjs), so emitting it from execution-core is safe and
// the broker will not self-filter or route it.

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getEventLogPath, getHostName, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const LINEAR_BREAKER_EVENT = "linear.ratelimit.breaker";

/**
 * buildLinearBreakerEnvelope — pure OTel envelope for a breaker state change.
 * `state` is "open" (a trip) or "closed" (recovery). OPEN carries reason+caller;
 * CLOSED carries recoveredAfter (the consecutive-failure count that preceded it).
 */
export function buildLinearBreakerEnvelope({
  state,
  reason = null,
  caller = null,
  cooldownMs = 0,
  consecutive = 0,
  recoveredAfter = 0,
  now,
} = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const host = getHostName();
  const open = state === "open";
  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: open ? "WARN" : "INFO",
    severityNumber: open ? 13 : 9,
    traceId: null,
    spanId: null,
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      "event.name": LINEAR_BREAKER_EVENT,
      "event.entity": "linear",
      "event.action": open ? "ratelimit.breaker.open" : "ratelimit.breaker.closed",
      "event.label": host,
    },
    body: {
      payload: {
        "host.name": host,
        state: open ? "open" : "closed",
        reason: open ? reason : null,
        caller: open ? caller : null,
        cooldownMs: open ? cooldownMs : 0,
        consecutive: open ? consecutive : 0,
        recoveredAfter: open ? 0 : recoveredAfter,
      },
    },
  };
}

/**
 * emitLinearBreakerEvent — append one linear.ratelimit.breaker envelope line.
 * Returns true on success, false on any failure (best-effort; never throws — a
 * telemetry hiccup must never perturb the breaker's control flow).
 */
export function emitLinearBreakerEvent({
  state,
  reason = null,
  caller = null,
  cooldownMs = 0,
  consecutive = 0,
  recoveredAfter = 0,
  logPath = getEventLogPath(),
  now,
} = {}) {
  const line = `${JSON.stringify(
    buildLinearBreakerEnvelope({ state, reason, caller, cooldownMs, consecutive, recoveredAfter, now }),
  )}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "linear-ratelimit-event: event append failed");
    return false;
  }
}
