// dispatch-alert.mjs — Stage 0 of "dispatch severed from live Linear"
// (2026-07-02-dispatch-no-live-linear.md). One one-shot, best-effort
// `catalyst.alert.*` emitter for the Stage-0 dispatch-hardening signal:
//
//   catalyst.alert.eligible_source_unavailable (WARN) — linear-query.mjs
//     runEligibleQuery(): the eligible poll MISSED the replica AND the CTL-679
//     breaker is OPEN, so we preserve the prior set WITHOUT spawning linearis into
//     the open breaker (D2). The genuine no-source residual (fresh boot, no replica,
//     no prior set) is now LOUD instead of a silent whole-window freeze.
//
// Emit path mirrors fleet-freeze-alert.mjs (the execution-core alert precedent):
// buildCatalystResource envelope + appendFileSync to the canonical event log,
// NEVER throws. Distinct event.name per signal (these are fire-and-forget
// one-shots, not latched raised/cleared pairs), event.entity=alert so the same
// catalyst.alert.* consumer picks them up. A per-kind time throttle keeps a
// per-tick hot-path emit from spamming the log.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";
import { buildCanonicalEventLine } from "./lib/canonical-event.mjs"; // CTL-2133: v3 bare-name gate events

export const ALERT_ELIGIBLE_SOURCE_UNAVAILABLE = "catalyst.alert.eligible_source_unavailable";

export const ALERT_KIND_ELIGIBLE_SOURCE_UNAVAILABLE = "eligible_source_unavailable";

// CTL-1436 (A4): a terminal-probe / GC-census ticket-state read MISSED the replica
// and its LIVE `linearis issues read` fallback FAILED (429 / timeout / unparseable).
// This is the "reads-via-replica must be LOUD on fail-open" signal — the silent
// MISS→live fallthrough is now visible, and the negative cache backs the ticket off
// so the breaker stops flapping. Throttled per-kind (one line/window) since the
// negative cache already rate-limits the underlying reads.
export const ALERT_TICKET_STATE_LIVE_FALLBACK = "catalyst.alert.ticket_state_live_fallback";

export const ALERT_KIND_TICKET_STATE_LIVE_FALLBACK = "ticket_state_live_fallback";

// CTL-1443 (P1-loop-3): a boot-resume approval gate has sat unapproved past its
// TTL. The gate itself is invisible by design (a marker file under workers/),
// so without this alert + the Needs-You surfacing a gated ticket waits forever
// (OTL-41 sat 4+ days). One line per window per kind — the per-ticket dedupe is
// the marker's surfacedAt field.
export const ALERT_BOOT_RESUME_PENDING = "catalyst.alert.boot_resume_pending";

export const ALERT_KIND_BOOT_RESUME_PENDING = "boot_resume_pending";

// CTL-1612: the daemon's GitHub credential is DEFINITIVELY unusable (a 401 from the
// API, not a timeout or a network blip). Before this alert existed, a daemon that
// booted holding a revoked credential simply 401'd every sweep forever — 102 failures
// across two hosts went unreported for 5+ hours on 2026-08-02, visible only as a
// repeated warning line buried in daemon.log. Emitted ONLY on a proven-unauthorized
// probe: a transient/unknown failure must stay silent so a DNS blip or a GitHub 5xx
// cannot page the fleet.
export const ALERT_GITHUB_AUTH_UNUSABLE = "catalyst.alert.github_auth_unusable";

export const ALERT_KIND_GITHUB_AUTH_UNUSABLE = "github_auth_unusable";

export const ALERT_BOOT_DEPENDENCY_UNUSABLE = "catalyst.alert.boot_dependency_unusable";
export const ALERT_KIND_BOOT_DEPENDENCY_UNUSABLE = "boot_dependency_unusable";

// Per-kind throttle so a per-tick hot path (runEligibleQuery inside the reconcile
// timer) cannot spam the event log during a sustained storm. The alert is a LOUD
// "something is wrong"
// signal, not per-ticket accounting — one line per window per kind is enough.
const DEFAULT_THROTTLE_MS = 60_000;
const _lastEmitAt = new Map();

// __resetDispatchAlertThrottle — test seam so throttle state never leaks across tests.
export function __resetDispatchAlertThrottle() {
  _lastEmitAt.clear();
}

// defaultAppend — write a JSONL line to the canonical monthly event log (same
// path/shape every other execution-core emitter appends to).
function defaultAppend(line) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
}

// buildDispatchAlertEvent — canonical OTel-shaped JSONL line (string + "\n") for a
// one-shot dispatch alert. WARN severity; event.action "raised"; event.label is the
// stable KIND; body.payload carries the reason + any structured detail.
export function buildDispatchAlertEvent({ eventName, kind, reason = null, detail = {} } = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    JSON.stringify({
      ts,
      id: randomBytes(8).toString("hex"),
      observedTs: ts,
      severityText: "WARN",
      severityNumber: 13,
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
      attributes: {
        "event.name": eventName,
        "event.entity": "alert",
        "event.action": "raised",
        "event.label": kind,
      },
      body: {
        payload: {
          kind,
          reason,
          source: "catalyst.execution-core",
          ...detail,
        },
      },
    }) + "\n"
  );
}

// emitThrottled — the shared best-effort, throttled append. Returns true when a
// line was written this call, false when throttled/failed. Never throws.
function emitThrottled({
  eventName,
  kind,
  reason,
  detail = {},
  append = defaultAppend,
  now = Date.now,
  throttleMs = DEFAULT_THROTTLE_MS,
}) {
  try {
    const t = now();
    const last = _lastEmitAt.get(kind) ?? 0;
    if (t - last < throttleMs) return false; // throttled — a recent line already fired
    _lastEmitAt.set(kind, t);
    append(buildDispatchAlertEvent({ eventName, kind, reason, detail }));
    return true;
  } catch (err) {
    // Never throw out of a read/dispatch hot path on an alert failure.
    log?.error?.({ err: err?.message }, "dispatch-alert emit failed (continuing)");
    return false;
  }
}

// emitEligibleSourceUnavailable — runEligibleQuery replica-miss + breaker-open alert.
export function emitEligibleSourceUnavailable({ team = null, append, now, throttleMs, reason } = {}) {
  return emitThrottled({
    eventName: ALERT_ELIGIBLE_SOURCE_UNAVAILABLE,
    kind: ALERT_KIND_ELIGIBLE_SOURCE_UNAVAILABLE,
    reason:
      reason ??
      "eligible discovery missed the replica AND the Linear breaker is OPEN — preserved the prior eligible set without spawning linearis (no bucket consumed)",
    detail: team ? { "linear.team.key": team } : {},
    append,
    now,
    throttleMs,
  });
}

// emitTicketStateLiveFallback — CTL-1436 (A4). A probeBackoff terminal-state read
// missed the replica and its live linearis fallback failed; the ticket is now
// negative-cached (backed off). `identifier` rides in the payload; `reason` is the
// failure mode (timeout | error | unparseable).
export function emitBootResumePending({ identifier = null, phase = null, ageHours = null, reason = null, append, now, throttleMs } = {}) {
  return emitThrottled({
    eventName: ALERT_BOOT_RESUME_PENDING,
    kind: ALERT_KIND_BOOT_RESUME_PENDING,
    reason:
      reason ??
      "a boot-resume approval gate exceeded its TTL with no operator response — surfaced to Needs-You (approve with boot-resume-approve.mjs)",
    detail: {
      ...(identifier ? { "linear.ticket": identifier } : {}),
      ...(phase ? { "catalyst.phase": phase } : {}),
      ...(ageHours != null ? { "catalyst.gate_age_hours": ageHours } : {}),
    },
    append,
    now,
    throttleMs,
  });
}

export function emitTicketStateLiveFallback({ identifier = null, reason = null, append, now, throttleMs } = {}) {
  return emitThrottled({
    eventName: ALERT_TICKET_STATE_LIVE_FALLBACK,
    kind: ALERT_KIND_TICKET_STATE_LIVE_FALLBACK,
    reason:
      reason ??
      "a terminal-probe ticket-state read missed the replica and its live linearis fallback failed — backed off (breaker-flap mitigation)",
    detail: identifier ? { "linear.ticket": identifier } : {},
    append,
    now,
    throttleMs,
  });
}

// emitGithubAuthUnusable — CTL-1612 boot-preflight alert. Call ONLY when the probe
// proved a 401; transient/unknown outcomes must not reach here.
//
// The detail key is NAMESPACED on purpose. buildDispatchAlertEvent writes its own
// `source: "catalyst.execution-core"` into body.payload and THEN spreads `...detail`,
// so a bare `source` key here would silently overwrite the service identifier that
// every existing catalyst.alert.* consumer reads.
export function emitGithubAuthUnusable({ tokenSource = null, reason = null, append, now, throttleMs } = {}) {
  return emitThrottled({
    eventName: ALERT_GITHUB_AUTH_UNUSABLE,
    kind: ALERT_KIND_GITHUB_AUTH_UNUSABLE,
    reason:
      reason ??
      "the daemon's GitHub credential was rejected (HTTP 401) at boot — every gh API call from this daemon and the workers it dispatches will fail until it is replaced and the daemon restarted",
    detail: tokenSource ? { "catalyst.github_token_source": tokenSource } : {},
    append,
    now,
    throttleMs,
  });
}

// ─── CTL-2133: boot-resume GATE observability (v3 bare-name, UNTHROTTLED) ────
//
// Distinct from ALERT_BOOT_RESUME_PENDING above: that is the throttled 48h loud
// alert (one line/window/kind, the escalation tier). These three are per-GATE
// observability events whose dedupe is the MARKER itself — the pending gate's
// `softSurfacedAt` stamp (emitted once, on first surfacing) and the retire's
// rename-aside (a discrete, rare act). There is deliberately NO time throttle:
// each distinct gate must emit exactly once, and a per-kind throttle would
// collapse three simultaneous fresh gates into one line (the silent-pen failure
// mode this ticket closes). v3 bare-name (`catalyst.boot_resume.*`) resolved by
// lib/event-name.mjs via attributes["event.name"]; the `catalyst.boot_resume.`
// prefix is UNPROTECTED under the CTL-1142 namespace contract (it routes through
// shouldSkipEvent normally — no isBrokerProtectedName collision), asserted in
// broker/namespace-parity.test.mjs.
export const EVENT_BOOT_RESUME_PENDING = "catalyst.boot_resume.pending";
export const EVENT_BOOT_RESUME_RETIRED = "catalyst.boot_resume.retired";
export const EVENT_BOOT_RESUME_WOULD_RETIRE = "catalyst.boot_resume.would-retire";

export const BOOT_RESUME_GATE_EVENT_NAMES = Object.freeze([
  EVENT_BOOT_RESUME_PENDING,
  EVENT_BOOT_RESUME_RETIRED,
  EVENT_BOOT_RESUME_WOULD_RETIRE,
]);

// _appendGateEvent — best-effort canonical v3 append (buildCanonicalEventLine
// guarantees body.message + attributes["event.name"], so the record can never map
// to an empty OTLP LogRecord). NEVER throws — a telemetry append must not break a
// scheduler tick. `append` is injectable so tests assert the built line without
// touching the real event log.
function _appendGateEvent(name, payload, attributes, append = defaultAppend) {
  try {
    append(buildCanonicalEventLine({ name, payload, attributes }));
    return true;
  } catch (err) {
    log?.error?.({ err: err?.message, name }, "boot-resume gate event append failed (continuing)");
    return false;
  }
}

// emitBootResumePendingGate — CTL-2133 Scenario 1. One per pending gate, the moment
// it is soft-surfaced (deduped by the marker's softSurfacedAt). Carries phase + age
// so an off-host consumer can render `ticket · phase · ageHours` without re-reading
// the marker. UNTHROTTLED — dedupe is the marker stamp, not a time window.
export function emitBootResumePendingGate({
  identifier = null,
  phase = null,
  ageMs = null,
  ageHours = null,
  append = defaultAppend,
} = {}) {
  return _appendGateEvent(
    EVENT_BOOT_RESUME_PENDING,
    {
      kind: "boot_resume_pending",
      identifier,
      phase,
      ageMs,
      ageHours,
      source: "catalyst.execution-core",
    },
    {
      ...(identifier ? { "linear.ticket": identifier } : {}),
      ...(phase ? { "catalyst.phase": phase } : {}),
      ...(ageHours != null ? { "catalyst.gate_age_hours": ageHours } : {}),
    },
    append,
  );
}

// emitBootResumeRetired — CTL-2133 Scenario 2 (enforce). One per gate archived
// because the ticket's Linear state moved strictly past the gated phase. A discrete,
// rare, auditable act — UNTHROTTLED. `from_state` is the Linear state name that made
// the gate moot.
export function emitBootResumeRetired({
  ticket = null,
  gated_phase = null,
  from_state = null,
  append = defaultAppend,
} = {}) {
  return _appendGateEvent(
    EVENT_BOOT_RESUME_RETIRED,
    {
      kind: "boot_resume_retired",
      ticket,
      gated_phase,
      from_state,
      source: "catalyst.execution-core",
    },
    {
      ...(ticket ? { "linear.ticket": ticket } : {}),
      ...(gated_phase ? { "catalyst.phase": gated_phase } : {}),
      ...(from_state ? { "linear.state": from_state } : {}),
    },
    append,
  );
}

// emitBootResumeWouldRetire — CTL-2133 Scenario 2 (shadow, the default). Same payload
// as `retired` but the marker is LEFT IN PLACE — the shadow-first observation event an
// operator watches for one restart-heavy evening before flipping to enforce.
export function emitBootResumeWouldRetire({
  ticket = null,
  gated_phase = null,
  from_state = null,
  append = defaultAppend,
} = {}) {
  return _appendGateEvent(
    EVENT_BOOT_RESUME_WOULD_RETIRE,
    {
      kind: "boot_resume_would_retire",
      ticket,
      gated_phase,
      from_state,
      source: "catalyst.execution-core",
    },
    {
      ...(ticket ? { "linear.ticket": ticket } : {}),
      ...(gated_phase ? { "catalyst.phase": gated_phase } : {}),
      ...(from_state ? { "linear.state": from_state } : {}),
    },
    append,
  );
}

// CAT-29: a daemon that cannot resolve its board/runtime dependencies stays
// alive and reports non-accepting state for observability. The shell launcher
// and worker dispatch gate enforce required-tool availability; this alert emits
// the concrete missing tools and effective PATH once for diagnosis.
export function emitBootDependencyUnusable({ missing = [], pathStr = null, reason = null, append, now, throttleMs } = {}) {
  return emitThrottled({
    eventName: ALERT_BOOT_DEPENDENCY_UNUSABLE,
    kind: ALERT_KIND_BOOT_DEPENDENCY_UNUSABLE,
    reason: reason ?? `boot dependencies unresolved: ${missing.join(", ")}`,
    detail: {
      "catalyst.missing_tools": missing.join(","),
      ...(pathStr != null ? { "process.path": pathStr } : {}),
    },
    append,
    now,
    throttleMs,
  });
}
