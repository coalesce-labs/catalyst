// service-health-emitter.ts — the debounced outage AUDIT trail (CTL-1050 §3.1).
// Watches service-health registry transitions and appends a canonical
// `catalyst.service.health` envelope on enter-down / sustained-recovery. The
// PURE transition-decision logic (transitionsForTick) is unit-testable; the thin
// CanonicalEventWriter adapter does the append.
//
// THE INBOX renders from LIVE state (the snapshot decoration, §3.2) — this event
// log is the HISTORY record (audit trail + the future uptime-history ticket). The
// two channels share the same registry; neither reads the other back.
//
// DEBOUNCE (no alert storms, CTL-1050 Gherkin):
//   • Enter down is the ONLY red transition — and `down` already requires 3
//     consecutive failures, so a single blip never reaches here.
//   • Recovery (down→up) emits only after up has been SUSTAINED for
//     RECOVERY_HOLD_MS (≥2 clean probes) — a down→up→down flap inside the hold
//     emits nothing.
//   • A per-service minimum re-emit interval REEMIT_HOLDDOWN_MS caps a flapping
//     service at one down/recovered pair per holddown.

import type { ServiceSeverity, ServiceStatus } from "./service-health";

export const RECOVERY_HOLD_MS = 60_000;
export const REEMIT_HOLDDOWN_MS = 10 * 60_000;

/** One outage envelope the emitter should append. */
export interface ServiceHealthTransition {
  serviceId: string;
  label: string;
  action: "down" | "recovered";
  severityText: "ERROR" | "INFO";
  /** The human body, e.g. "Loki is unreachable since 14:32 — telemetry views degraded". */
  body: string;
  /** epoch ms the down began (for the since-time copy). */
  downSince: number | null;
  detail: string | null;
}

/** Per-service consequence clause for the body — names what the outage breaks. */
const CONSEQUENCE: Record<string, string> = {
  loki: "telemetry views degraded",
  prometheus: "metrics charts degraded",
  grafana: "dashboards unavailable",
  "otel-collector": "telemetry ingest interrupted",
  broker: "event intake / dispatch stalled",
  "execution-core": "dispatch stalled",
  webhook: "GitHub/Linear event intake interrupted",
  monitor: "monitor degraded",
};

function consequence(serviceId: string): string {
  return CONSEQUENCE[serviceId] ?? "service degraded";
}

/** Format an epoch-ms instant as local HH:MM. */
export function hhmm(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** The down body — "Loki is unreachable since 14:32 — telemetry views degraded". */
export function downBody(label: string, serviceId: string, downSince: number | null): string {
  const since = downSince !== null ? ` since ${hhmm(downSince)}` : "";
  return `${label} is unreachable${since} — ${consequence(serviceId)}`;
}

/** The recovery body — "Loki recovered at 14:40 — telemetry views restored". */
export function recoveredBody(label: string, serviceId: string, at: number): string {
  return `${label} recovered at ${hhmm(at)} — ${consequence(serviceId).replace("degraded", "restored").replace("stalled", "resumed").replace("interrupted", "restored").replace("unavailable", "restored")}`;
}

/** Per-service bookkeeping the emitter holds across ticks. */
interface EmitterState {
  /** The last severity we SAW for this service. */
  lastSeverity: ServiceSeverity;
  /** Whether a `down` has been emitted and not yet recovered. */
  downEmitted: boolean;
  /** When the service entered `up` while a down was outstanding (recovery hold). */
  upHoldSince: number | null;
  /** When the current outstanding `down` envelope was appended (null until a real
   *  down is emitted). The holddown that suppresses a NEW down measures from here. */
  downEmittedAt: number | null;
  /** When the last `recovered` envelope was appended. The holddown that suppresses
   *  a NEW down also measures from a recent recovered (one pair per holddown). */
  recoveredAt: number | null;
}

export interface ServiceHealthEmitterDeps {
  /** Append one canonical-shaped event. Thin adapter over CanonicalEventWriter. */
  append: (t: ServiceHealthTransition) => void;
  now?: () => number;
}

export interface ServiceHealthEmitter {
  /** Feed the current registry statuses; appends any due transitions. */
  observe(services: ServiceStatus[]): void;
  /** Pure decision (exported for tests via createServiceHealthEmitter().decide). */
  decide(services: ServiceStatus[], now: number): ServiceHealthTransition[];
}

export function createServiceHealthEmitter(
  deps: ServiceHealthEmitterDeps,
): ServiceHealthEmitter {
  const now = deps.now ?? (() => Date.now());
  const state = new Map<string, EmitterState>();

  function getState(s: ServiceStatus): EmitterState {
    let st = state.get(s.id);
    if (!st) {
      st = {
        lastSeverity: s.severity,
        downEmitted: false,
        upHoldSince: null,
        downEmittedAt: null,
        recoveredAt: null,
      };
      state.set(s.id, st);
    }
    return st;
  }

  function decide(services: ServiceStatus[], t: number): ServiceHealthTransition[] {
    const out: ServiceHealthTransition[] = [];
    for (const s of services) {
      // Unconfigured / unknown services never emit outage events.
      if (s.severity === "unknown") {
        const st = getState(s);
        st.lastSeverity = "unknown";
        continue;
      }
      const st = getState(s);

      // Enter down — the only red transition. `down` already implies 3 failures.
      if (s.severity === "down" && !st.downEmitted) {
        // Flap guard: a NEW down is suppressed for REEMIT_HOLDDOWN_MS after the
        // last recovered (a service oscillating across the boundary appends at
        // most one down/recovered pair per holddown).
        const holddownOk =
          st.recoveredAt === null || t - st.recoveredAt >= REEMIT_HOLDDOWN_MS;
        if (holddownOk) {
          out.push({
            serviceId: s.id,
            label: s.label,
            action: "down",
            severityText: "ERROR",
            body: downBody(s.label, s.id, s.downSince),
            downSince: s.downSince,
            detail: s.detail,
          });
          st.downEmittedAt = t;
        }
        st.downEmitted = true;
        st.upHoldSince = null;
      } else if (s.severity === "down" && st.downEmitted) {
        // Still down (or flapped back to down inside the hold) — reset any pending
        // recovery hold; no emit.
        st.upHoldSince = null;
      } else if (st.downEmitted && (s.severity === "up" || s.severity === "degraded")) {
        // Recovering. Only count `up` toward the sustained-recovery hold; a
        // `degraded` reading keeps the outage open (it is not yet healthy) but
        // does NOT reset the hold to null (degraded-while-recovering is benign).
        if (s.severity === "up") {
          if (st.upHoldSince === null) st.upHoldSince = t;
          if (t - st.upHoldSince >= RECOVERY_HOLD_MS) {
            // The recovery that CLOSES the current open outage always emits — it
            // pairs with the down already on the log (the holddown caps a NEW
            // down/recovered pair, not the matching recovery). We only emit the
            // recovered when its own down was actually appended (downEmittedAt set).
            if (st.downEmittedAt !== null) {
              out.push({
                serviceId: s.id,
                label: s.label,
                action: "recovered",
                severityText: "INFO",
                body: recoveredBody(s.label, s.id, t),
                downSince: null,
                detail: s.detail,
              });
              st.recoveredAt = t;
            }
            st.downEmitted = false;
            st.downEmittedAt = null;
            st.upHoldSince = null;
          }
        }
      }

      st.lastSeverity = s.severity;
    }
    return out;
  }

  return {
    decide,
    observe(services: ServiceStatus[]) {
      const t = now();
      for (const tr of decide(services, t)) deps.append(tr);
    },
  };
}
