// ingestion-recency.mjs — CTL-1122 (PR1). The broker-side half of the
// out-of-process ingestion-silence detector: build the
// catalyst.ingestion.{stale,recovered} alarm envelopes and run the
// edge-trigger / holddown state machine that decides WHEN to emit them.
//
// Pairs with the pure classifier in ../lib/ingestion-recency.mjs (recencyAgeMs /
// classifyRecency / evaluateSource) — this module does NOT duplicate that logic;
// it consumes the severity the classifier produces.
//
// WHY this lives in the broker: the orch-monitor cannot observe its own death —
// its kind:"self" service-health probe reports `up` iff the monitor process
// answers (the exact SPOF behind the 2026-06-14 11h silent outage). The broker
// already tails every event, so it is the surviving process that can judge the
// monitor's liveness from the log via the catalyst.monitor heartbeat's recency.
//
// Emit-only: the broker takes NO corrective action — it only surfaces the
// silence as a disk-readable cross-process signal that CTL-1123 consumes.
//
// Structural templates: the envelope mirrors
// execution-core/fleet-health-event.mjs (OTel envelope + best-effort
// appendFileSync that NEVER throws); the holddown machine mirrors
// orch-monitor/lib/service-health-emitter.ts (one `down` per transition, paired
// `recovered`, flap suppression) — see nextRecencyAlarmState for the one
// deliberate divergence (a holddown-suppressed death is DEFERRED, not dropped).

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  generateEventId,
  severityNumber,
  hostName,
  hostId,
} from "../orch-monitor/lib/canonical-event-shared.ts";
import { getEventLogPath, log } from "./config.mjs";

// The service identity of the monitor's periodic heartbeat (emitted by
// orch-monitor server.ts onTick; service.name=catalyst.monitor). The broker
// keys its recency check on THIS name — the monitor's other emissions use
// service.name="monitor" and fire on transitions, not a fixed cadence, so they
// are not a calibratable freshness signal.
export const MONITOR_SERVICE_NAME = "catalyst.monitor";

// The alarm event names. New namespace `catalyst.ingestion.*` (the documented
// CTL-1123 contract). stale = ingestion has gone silent past threshold;
// recovered = a fresh event has been observed again.
export const INGESTION_STALE = "catalyst.ingestion.stale";
export const INGESTION_RECOVERED = "catalyst.ingestion.recovered";

/**
 * buildIngestionRecencyEnvelope — assemble the canonical OTel envelope for a
 * catalyst.ingestion.{stale,recovered} event. Modeled on
 * buildFleetHealthEnvelope: host in `resource`, the stale source in
 * `event.label`, ages in `body.payload`. Adds a real `caused_by` (the id of the
 * last-seen event from the silent source) — the forensic link CTL-1135
 * introduced; buildFleetHealthEnvelope has no such field. Pure (modulo the
 * random id + timestamp); no I/O.
 *
 * @param {object} i
 * @param {"stale"|"recovered"} i.action
 * @param {string} i.sourceName     the silent/recovered service identity (event.label)
 * @param {number|null} [i.ageMs]   age of the last-seen event at decision time
 * @param {number|null} [i.thresholdMs] the down threshold that was crossed
 * @param {string|null} [i.lastSeenAt] ISO ts of the last-seen event
 * @param {string|null} [i.causedBy] id of the last-seen event → caused_by
 * @param {object} [opts]
 * @param {Function} [opts.now] injectable ISO-timestamp fn (tests)
 * @returns {object} the envelope
 */
export function buildIngestionRecencyEnvelope(
  { action, sourceName, ageMs = null, thresholdMs = null, lastSeenAt = null, causedBy = null } = {},
  { now } = {},
) {
  const ts = now ? now() : new Date().toISOString();
  const stale = action === "stale";
  const eventName = stale ? INGESTION_STALE : INGESTION_RECOVERED;
  // stale is an operator-actionable failure (ERROR); recovered is INFO.
  const severity = stale ? "ERROR" : "INFO";
  return {
    ts,
    id: generateEventId(),
    observedTs: ts,
    severityText: severity,
    severityNumber: severityNumber(severity),
    traceId: null,
    spanId: null,
    // CTL-1135: forensic link to the last event we DID see from the source
    // (for stale, the final heartbeat before silence; for recovered, the fresh
    // beat that cleared it). null when the source was never observed.
    caused_by: causedBy ?? null,
    resource: {
      // The broker is the emitter — the host that OBSERVED the silence. Matches
      // every other broker emission so the monitor composes the per-host stream
      // identically.
      "service.name": "catalyst.broker",
      "service.namespace": "catalyst",
      "host.name": hostName(),
      "host.id": hostId(),
    },
    attributes: {
      "event.name": eventName,
      "event.entity": "ingestion",
      "event.action": action,
      // the SILENT source (not the broker) — what went quiet.
      "event.label": sourceName,
    },
    body: {
      payload: {
        source: sourceName,
        ageMs,
        thresholdMs,
        lastSeenAt,
      },
    },
  };
}

/**
 * emitIngestionRecencyEvent — build + append one envelope line to the event log.
 * Best-effort: returns true on success, false on any failure, and NEVER throws —
 * a telemetry append must never wedge the broker watchdog. `logPath` is
 * injectable for tests (the hermetic preload pins CATALYST_DIR, but an explicit
 * path keeps the unit test self-contained). Mirrors emitFleetHealthEvent.
 *
 * @param {object} input  buildIngestionRecencyEnvelope input
 * @param {object} [opts]
 * @param {string} [opts.logPath]
 * @param {Function} [opts.now]
 * @returns {boolean}
 */
export function emitIngestionRecencyEvent(input, { logPath = getEventLogPath(), now } = {}) {
  const line = `${JSON.stringify(buildIngestionRecencyEnvelope(input, { now }))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "ingestion-recency: event append failed");
    return false;
  }
}

/**
 * initialRecencyAlarmState — the per-source alarm state. `downEmitted` latches a
 * fired-and-not-yet-recovered outage; `recoveredAt` arms the flap holddown;
 * `upHoldSince` is the sustained-recovery clock.
 */
export function initialRecencyAlarmState() {
  return {
    downEmitted: false,
    downEmittedAt: null,
    recoveredAt: null,
    upHoldSince: null,
    lastSeverity: "unknown",
  };
}

/**
 * nextRecencyAlarmState — PURE edge-trigger + holddown. Given the current
 * severity (from classifyRecency: "up"|"degraded"|"down"|"unknown") and the
 * prior state, return { state, emit } where emit ∈ "stale" | "recovered" | null.
 *
 * Mirrors service-health-emitter's down/recovered machine with ONE deliberate
 * divergence: a `down` that is holddown-suppressed does NOT latch downEmitted —
 * it is DEFERRED and re-checked every tick, so a genuine sustained outage that
 * began within the flap window still alarms once the holddown expires (the
 * service-health machine would mask it permanently until a recovery — wrong for
 * a death detector). Holddown therefore rate-limits stale emissions to one per
 * `holddownMs` after a recovery, without ever dropping a real death.
 *
 * Fail-open: "unknown" (never-seen / read error) and "degraded" never emit and
 * never reset the recovery clock — only a sustained `down` alarms, only a clean
 * `up` clears.
 *
 * @param {object} prev  prior state (initialRecencyAlarmState shape)
 * @param {object} i
 * @param {"up"|"degraded"|"down"|"unknown"} i.severity
 * @param {number} i.nowMs
 * @param {number} [i.holddownMs]      min ms between a recovery and the next stale (flap guard)
 * @param {number} [i.recoveryHoldMs]  ms of sustained `up` required before recovered (anti-flap)
 * @returns {{state: object, emit: "stale"|"recovered"|null}}
 */
export function nextRecencyAlarmState(
  prev,
  { severity, nowMs, holddownMs = 600_000, recoveryHoldMs = 0 } = {},
) {
  const s = { ...prev };
  s.lastSeverity = severity;
  let emit = null;

  if (severity === "down") {
    if (!s.downEmitted) {
      // Flap guard: suppress a NEW stale within holddownMs of the last recovery.
      const holddownOk = s.recoveredAt === null || nowMs - s.recoveredAt >= holddownMs;
      if (holddownOk) {
        emit = "stale";
        s.downEmittedAt = nowMs;
        s.downEmitted = true; // latch only once the alarm actually fired
      }
      // else: DEFER — leave downEmitted false so the next tick re-checks and
      // emits the moment the holddown expires (a real death is never masked).
      s.upHoldSince = null;
    } else {
      // already alarming — hold; reset any pending recovery.
      s.upHoldSince = null;
    }
  } else if (severity === "up") {
    if (s.downEmitted) {
      if (s.upHoldSince === null) s.upHoldSince = nowMs;
      if (nowMs - s.upHoldSince >= recoveryHoldMs) {
        // Only pair a recovered with a stale that was actually appended.
        if (s.downEmittedAt !== null) {
          emit = "recovered";
          s.recoveredAt = nowMs;
        }
        s.downEmitted = false;
        s.downEmittedAt = null;
        s.upHoldSince = null;
      }
    }
    // not in an outage → nothing to do.
  }
  // "degraded" / "unknown": hold steady — no emit, do not advance/reset the
  // recovery clock (a brief degrade mid-recovery must not count as clean).

  return { state: s, emit };
}
