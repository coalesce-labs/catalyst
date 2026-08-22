// alert-emit.mjs — CTL-1123. The broker's alert-POLICY layer: promote detector
// signals into a stable, operator-facing `catalyst.alert.*` topic and append it
// to the event log. The broker is the surviving process; otel-forward ships the
// log to the OTel collector which fans out to {Loki, dash0, …}, where a separate
// "brain" (alert rule → channel) does delivery. This module emits intent ONLY —
// no channels, no credentials.
//
// Pairs with broker/ingestion-recency.mjs (the CTL-1122 detector). system_down
// rides that detector's already-edge-triggered/holddown'd stale/recovered edges,
// so it needs NO new debounce. The CTL-2156 SYSTEM-trouble kinds are LEVEL
// signals (a distinct-key count from broker/system-trouble.mjs), so they share
// the pure threshold + persistence + cooldown machine at the bottom of this file.
//
// Envelope mirrors buildIngestionRecencyEnvelope (hand-built — the broker's
// buildCanonicalEnvelope can't carry event.entity/action/label).

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  generateEventId,
  severityNumber,
  buildCatalystResource,
} from "../orch-monitor/lib/canonical-event-shared.ts";
import { getEventLogPath, log } from "./config.mjs";

// The alert event names — a stable `catalyst.alert.*` namespace deliberately
// decoupled from the low-level detector event names (catalyst.ingestion.*) so the
// downstream alert contract survives detector refactors.
export const ALERT_RAISED = "catalyst.alert.raised";
export const ALERT_CLEARED = "catalyst.alert.cleared";

// Alert KINDS (event.label). Extend here as new policies are added.
export const ALERT_KIND_SYSTEM_DOWN = "system_down";

// CTL-2156 — the SYSTEM-trouble kinds. Each is fleet-scoped (ONE alert for the
// whole condition, however many tickets it touches) and AUTO-CLEARING (the
// condition ending emits `cleared` with no human action). Detector inputs live in
// broker/system-trouble.mjs; the wiring is router.mjs.
//
// These REPLACE the retired `needs_human_pileup` kind. That kind counted Linear
// `needs-human`/`needs-input` LABELS — i.e. it measured the per-ticket escalation
// artifact rather than the condition, so a single provider outage showed up as a
// pile-up of N human asks. Measured: of 86 items flagged as waiting on a human,
// 41 were the provider being overloaded and 3 genuinely needed a person. The
// label taxonomy (and its parity pin) moved out of the broker with it; the
// surviving copy is orch-monitor/lib/linear-cache-reader.mjs, pinned by its own
// parity test.
/** 429/529 exhaustion from the model provider. */
export const ALERT_KIND_PROVIDER_DEGRADED = "provider_degraded";
/** An account / Linear / GitHub budget is spent. */
export const ALERT_KIND_RATE_LIMIT_EXHAUSTED = "rate_limit_exhausted";
/** No free execution slots on a node (see system-trouble.mjs on executor death). */
export const ALERT_KIND_CAPACITY_UNAVAILABLE = "capacity_unavailable";

/**
 * buildAlertEnvelope — assemble the canonical OTel envelope for a
 * catalyst.alert.{raised,cleared} event. resource.service.name=catalyst.broker
 * (the surviving emitter). Pure (modulo the random id + timestamp); no I/O.
 *
 * @param {object} i
 * @param {"raised"|"cleared"} i.action
 * @param {string} i.kind        the alert KIND → event.label (system_down | provider_degraded | …)
 * @param {string} [i.reason]    short human-readable reason
 * @param {string|null} [i.source]   the silent/recovered source (system_down)
 * @param {number|null} [i.count]    the level count (the CTL-2156 LEVEL kinds)
 * @param {number|null} [i.threshold] the level threshold that was crossed
 * @param {number|null} [i.sinceMs]  ms the condition has held (raised) / lasted (cleared)
 * @param {string|null} [i.causedBy] forensic link (event id) → caused_by
 * @param {object} [opts]
 * @param {Function} [opts.now]   injectable ISO-timestamp fn (tests)
 * @returns {object} the envelope
 */
export function buildAlertEnvelope(
  { action, kind, reason = null, source = null, count = null, threshold = null, sinceMs = null, causedBy = null } = {},
  { now } = {},
) {
  const ts = now ? now() : new Date().toISOString();
  const raised = action === "raised";
  const eventName = raised ? ALERT_RAISED : ALERT_CLEARED;
  // A raised alert is operator-actionable (ERROR); a cleared alert is INFO.
  const severity = raised ? "ERROR" : "INFO";
  return {
    ts,
    id: generateEventId(),
    observedTs: ts,
    severityText: severity,
    severityNumber: severityNumber(severity),
    traceId: null,
    spanId: null,
    caused_by: causedBy ?? null,
    // the broker is the emitter — the surviving process that raised the alert.
    resource: buildCatalystResource({ serviceName: "catalyst.broker" }),
    attributes: {
      "event.name": eventName,
      "event.entity": "alert",
      "event.action": action,
      // the alert KIND — what the downstream brain filters/routes on.
      "event.label": kind,
    },
    body: {
      payload: { kind, reason, source, count, threshold, sinceMs },
    },
  };
}

/**
 * emitAlertEvent — build + append one alert envelope to the event log.
 * Best-effort: returns true on success, false on any failure, NEVER throws — a
 * telemetry append must never wedge the broker watchdog. Mirrors
 * emitIngestionRecencyEvent.
 *
 * @param {object} input  buildAlertEnvelope input
 * @param {object} [opts]
 * @param {string} [opts.logPath]
 * @param {Function} [opts.now]
 * @returns {boolean}
 */
export function emitAlertEvent(input, { logPath = getEventLogPath(), now } = {}) {
  const line = `${JSON.stringify(buildAlertEnvelope(input, { now }))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "alert-emit: event append failed");
    return false;
  }
}

/**
 * initialAlarmState — per-kind level-alarm state. `raised` latches a
 * fired-and-not-yet-cleared condition; `aboveSince` is the persistence clock;
 * `clearedAt` arms the post-clear cooldown. One instance PER KIND — the router
 * keeps a kind→state map so provider_degraded and capacity_unavailable debounce
 * independently.
 */
export function initialAlarmState() {
  return { raised: false, raisedAt: null, aboveSince: null, clearedAt: null };
}

/**
 * nextLevelAlarmState — PURE threshold + persistence + cooldown machine for a
 * LEVEL signal (a count). Returns { state, emit } where emit ∈ "raised" |
 * "cleared" | null.
 *
 *  - count >= threshold sustained for >= persistenceMs  → emit "raised" (once),
 *    UNLESS within cooldownMs of the last clear (flap guard → deferred, re-checked).
 *  - count < threshold while raised                     → emit "cleared", arm cooldown.
 *
 * The persistence window stops a single-tick spike from paging; the cooldown
 * stops a flapping count from storming. Mirrors nextRecencyAlarmState's
 * pure-then-emit shape.
 *
 * @param {object} prev  prior state (initialAlarmState shape)
 * @param {object} i
 * @param {number} i.count
 * @param {number} i.threshold
 * @param {number} i.nowMs
 * @param {number} [i.persistenceMs]  ms the count must stay >= threshold before raising
 * @param {number} [i.cooldownMs]     min ms between a clear and the next raise (flap guard)
 * @returns {{state: object, emit: "raised"|"cleared"|null}}
 */
export function nextLevelAlarmState(
  prev,
  { count, threshold, nowMs, persistenceMs = 300_000, cooldownMs = 3_600_000 } = {},
) {
  const s = { ...prev };
  let emit = null;

  if (count >= threshold) {
    if (s.aboveSince === null) s.aboveSince = nowMs; // start the persistence clock
    if (!s.raised && nowMs - s.aboveSince >= persistenceMs) {
      // Flap guard: suppress a NEW raise within cooldownMs of the last clear.
      const cooldownOk = s.clearedAt === null || nowMs - s.clearedAt >= cooldownMs;
      if (cooldownOk) {
        emit = "raised";
        s.raised = true;
        s.raisedAt = nowMs;
      }
      // else: DEFER — leave raised false so the next tick re-checks and raises
      // the moment the cooldown expires (a sustained condition is never masked).
    }
  } else {
    // below threshold → reset the persistence clock; clear any open alarm. This
    // is the AUTO-CLEAR: no human action, no per-ticket artifact to unwind.
    s.aboveSince = null;
    if (s.raised) {
      emit = "cleared";
      s.raised = false;
      s.raisedAt = null;
      s.clearedAt = nowMs;
    }
  }

  return { state: s, emit };
}
