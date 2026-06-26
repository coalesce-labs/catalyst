// alert-emit.mjs — CTL-1123. The broker's alert-POLICY layer: promote detector
// signals into a stable, operator-facing `catalyst.alert.*` topic and append it
// to the event log. The broker is the surviving process; otel-forward ships the
// log to the OTel collector which fans out to {Loki, dash0, …}, where a separate
// "brain" (alert rule → channel) does delivery. This module emits intent ONLY —
// no channels, no credentials.
//
// Pairs with broker/ingestion-recency.mjs (the CTL-1122 detector). system_down
// rides that detector's already-edge-triggered/holddown'd stale/recovered edges,
// so it needs NO new debounce. needs_human_pileup is a LEVEL signal (a count),
// so it has its own pure threshold + persistence + cooldown machine here.
//
// Envelope mirrors buildIngestionRecencyEnvelope (hand-built — the broker's
// buildCanonicalEnvelope can't carry event.entity/action/label).

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  generateEventId,
  severityNumber,
  hostName,
  hostId,
} from "../orch-monitor/lib/canonical-event-shared.ts";
import { getEventLogPath, log } from "./config.mjs";

// The alert event names — a stable `catalyst.alert.*` namespace deliberately
// decoupled from the low-level detector event names (catalyst.ingestion.*) so the
// downstream alert contract survives detector refactors.
export const ALERT_RAISED = "catalyst.alert.raised";
export const ALERT_CLEARED = "catalyst.alert.cleared";

// Alert KINDS (event.label). Extend here as new policies are added.
export const ALERT_KIND_SYSTEM_DOWN = "system_down";
export const ALERT_KIND_NEEDS_HUMAN_PILEUP = "needs_human_pileup";

// The needs-human label taxonomy. Canonical source is board-data.mjs
// (ATTENTION_LABEL_NEEDS_HUMAN/NEEDS_INPUT) — but that is a monitor-tree module
// that pulls linear-cache-reader/estimate-fallback, so importing it into the
// surviving broker at runtime would couple the broker to monitor code (and erode
// dashboard-independence). We define the strings locally and pin them to the
// canonical source with a parity test (alert-emit.test.mjs) so a taxonomy rename
// (CTL-995) cannot silently drift the broker's pile-up count.
export const NEEDS_HUMAN_LABELS = ["needs-human", "needs-input"];

/**
 * buildAlertEnvelope — assemble the canonical OTel envelope for a
 * catalyst.alert.{raised,cleared} event. resource.service.name=catalyst.broker
 * (the surviving emitter). Pure (modulo the random id + timestamp); no I/O.
 *
 * @param {object} i
 * @param {"raised"|"cleared"} i.action
 * @param {string} i.kind        the alert KIND → event.label (system_down | needs_human_pileup)
 * @param {string} [i.reason]    short human-readable reason
 * @param {string|null} [i.source]   the silent/recovered source (system_down)
 * @param {number|null} [i.count]    the pile-up count (needs_human_pileup)
 * @param {number|null} [i.threshold] the pile-up threshold that was crossed
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
    resource: {
      // the broker is the emitter — the surviving process that raised the alert.
      "service.name": "catalyst.broker",
      "service.namespace": "catalyst",
      "host.name": hostName(),
      "host.id": hostId(),
    },
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
 * initialPileupState — per-kind level-alarm state for the needs_human_pileup
 * count. `raised` latches a fired-and-not-yet-cleared pile-up; `aboveSince` is
 * the persistence clock; `clearedAt` arms the post-clear cooldown.
 */
export function initialPileupState() {
  return { raised: false, raisedAt: null, aboveSince: null, clearedAt: null };
}

/**
 * nextPileupAlarmState — PURE threshold + persistence + cooldown machine for a
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
 * @param {object} prev  prior state (initialPileupState shape)
 * @param {object} i
 * @param {number} i.count
 * @param {number} i.threshold
 * @param {number} i.nowMs
 * @param {number} [i.persistenceMs]  ms the count must stay >= threshold before raising
 * @param {number} [i.cooldownMs]     min ms between a clear and the next raise (flap guard)
 * @returns {{state: object, emit: "raised"|"cleared"|null}}
 */
export function nextPileupAlarmState(
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
      // the moment the cooldown expires (a sustained pile-up is never masked).
    }
  } else {
    // below threshold → reset the persistence clock; clear any open pile-up.
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
