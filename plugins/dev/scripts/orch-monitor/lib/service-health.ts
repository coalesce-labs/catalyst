// service-health.ts — the PURE, React-free service-health registry + the ONE
// shared severity model behind BOTH the Fleet Ops health strip (CTL-1050) and
// the proportional telemetry severity (CTL-1039). Same pattern as hero-state.ts
// / fleetops-kit.ts: no React, no jotai, no fs side-effects in the transition
// logic — so the orch-monitor `bun test` suite can unit it directly.
//
// There is exactly ONE severity model. `lib/otel-health.ts` reuses this module's
// tracker so its binary `reachable` consumer surface and CTL-1039's
// banner/headline both read the same `up|degraded|down|unknown` severity, with
// the same N-consecutive-failure → red rule (no single blip ever paints red).
//
// THE THREE PROBE KINDS
// ---------------------
//   • probe-url     — an HTTP probe (Loki /ready, Prom buildinfo, Grafana
//     /api/health, the collector health_check extension). The probe url + timeout
//     mechanics live in otel-health.ts (`probe()`); this module owns the
//     consecutive-failure → severity transition.
//   • event-recency — liveness inferred from the age of a real emission in the
//     unified event log (broker / execution-core heartbeat, collector ingest
//     fallback). NEVER "process exists" — the daemon's recent emission IS the
//     evidence, so we never restart broker/exec-core to test (CTL-1050 Gherkin
//     "Daemon liveness uses real signals").
//   • self          — this process answers ⇒ up (monitor); a config-gated
//     in-process check (webhook). Config absent ⇒ unknown, never red.

/** The eight stack services this registry tracks. */
export type ServiceId =
  | "monitor"
  | "broker"
  | "execution-core"
  | "webhook"
  | "otel-collector"
  | "loki"
  | "prometheus"
  | "grafana";

export type ProbeKind = "probe-url" | "event-recency" | "self";

/** The shared four-level severity. `unknown` (grey) is for an unconfigured or
 *  not-yet-probed service — NEVER red. */
export type ServiceSeverity = "up" | "degraded" | "down" | "unknown";

export interface ServiceDescriptor {
  id: ServiceId;
  /** Display label — "Loki", "Broker", … */
  label: string;
  kind: ProbeKind;
  /** Resolved probe URL (probe-url) or recency-source description (event-recency).
   *  null ⇒ unconfigured → severity "unknown" (grey), never red. */
  target: string | null;
  /** Where `target` came from, for the hover ("otel.lokiUrl", "event-log
   *  service.name=broker"). */
  configSource: string;
  /** Probe cadence (probe-url) / re-evaluation cadence (event-recency, self). */
  intervalMs: number;
  /** probe-url only; default DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** probe ok but latency > slowMs ⇒ degraded (default DEFAULT_SLOW_MS). */
  slowMs?: number;
  /** probe-url: failures before red (default DEFAULT_DOWN_AFTER_CONSECUTIVE). */
  downAfterConsecutive?: number;
  /** event-recency: emission age (ms) ⇒ yellow. */
  degradedAfterMs?: number;
  /** event-recency: emission age (ms) ⇒ red. */
  downAfterMs?: number;
}

/** The live tracked status of one service — the shared shape the strip, the
 *  outage emitter, the inbox decoration, and the otel-health rewire all read. */
export interface ServiceStatus {
  id: ServiceId;
  label: string;
  severity: ServiceSeverity;
  /** epoch ms of the last probe/eval, or null before the first result. */
  lastCheckedAt: number | null;
  /** epoch ms of the last `up` result, or null if never up. */
  lastOkAt: number | null;
  consecutiveFailures: number;
  latencyMs: number | null;
  /** latest failure detail / recency age, for the hover. */
  detail: string | null;
  target: string | null;
  configSource: string;
  /** epoch ms when the service ENTERED `down` (the 1↦down transition); drives the
   *  "down since HH:MM" copy. Cleared on recovery. */
  downSince: number | null;
}

/** The result of one probe/eval, fed to applyProbeResult. */
export interface ProbeResult {
  kind: ProbeKind;
  /** probe-url / self: the probe outcome. */
  ok?: boolean;
  /** probe-url: measured latency in ms (for the slow→degraded check). */
  latencyMs?: number | null;
  /** event-recency: age (ms) of the newest backing emission, or null when no
   *  emission was found in the window. */
  ageMs?: number | null;
  /** Override severity directly (unconfigured target:null ⇒ "unknown"; the
   *  collector recency fallback ⇒ "unknown" when Loki itself is down — no
   *  cascade). When set, it wins and counters reset. */
  forcedSeverity?: ServiceSeverity;
  /** A failure/recency detail string for the hover. */
  detail?: string | null;
}

export const DEFAULT_TIMEOUT_MS = 2000;
export const DEFAULT_SLOW_MS = 1500;
export const DEFAULT_DOWN_AFTER_CONSECUTIVE = 3;

/** A fresh, never-probed status — `unknown` (grey), so we NEVER flash red on the
 *  first paint (mirrors heroState's `lokiReachable === null` optimism). */
export function initialStatus(d: ServiceDescriptor): ServiceStatus {
  return {
    id: d.id,
    label: d.label,
    // An unconfigured service is unknown forever; everything else boots unknown.
    severity: "unknown",
    lastCheckedAt: null,
    lastOkAt: null,
    consecutiveFailures: 0,
    latencyMs: null,
    detail: d.target === null ? "not configured" : null,
    target: d.target,
    configSource: d.configSource,
    downSince: null,
  };
}

function downAfter(d: ServiceDescriptor): number {
  return d.downAfterConsecutive ?? DEFAULT_DOWN_AFTER_CONSECUTIVE;
}

function slowMs(d: ServiceDescriptor): number {
  return d.slowMs ?? DEFAULT_SLOW_MS;
}

/**
 * THE single transition function (pure, unit-testable). Given the previous
 * status, the descriptor (thresholds), a probe/eval result, and `now`, returns
 * the next status. The ONLY place severity changes.
 *
 * Rules (SPEC §1.3):
 *   1. forcedSeverity (target:null ⇒ unknown; collector-no-cascade ⇒ unknown)
 *      wins, resets counters.
 *   2. probe-url / self SUCCESS: counter→0, severity→up IMMEDIATELY (CTL-1039
 *      self-clearing). latency > slowMs ⇒ degraded ("slow probe (Xms)").
 *   3. probe-url / self FAILURE: counter++. < downAfter ⇒ degraded; >= ⇒ down,
 *      stamp downSince on the 1↦down transition only.
 *   4. event-recency: severity purely from ageMs vs degradedAfterMs/downAfterMs
 *      (sustained by construction — no counter). downSince = lastOkAt + downAfterMs.
 */
export function applyProbeResult(
  prev: ServiceStatus,
  d: ServiceDescriptor,
  result: ProbeResult,
  now: number,
): ServiceStatus {
  const next: ServiceStatus = {
    ...prev,
    lastCheckedAt: now,
    // target/configSource may have been re-resolved on the descriptor.
    target: d.target,
    configSource: d.configSource,
  };

  // Rule 1 — a forced severity (unconfigured / no-cascade) short-circuits.
  if (result.forcedSeverity !== undefined) {
    next.severity = result.forcedSeverity;
    next.consecutiveFailures = 0;
    next.latencyMs = null;
    next.detail = result.detail ?? prev.detail;
    if (result.forcedSeverity === "up") next.lastOkAt = now;
    if (result.forcedSeverity !== "down") next.downSince = null;
    return next;
  }

  if (result.kind === "event-recency") {
    return applyRecency(prev, next, d, result, now);
  }

  // probe-url / self.
  const ok = result.ok === true;
  if (ok) {
    next.consecutiveFailures = 0;
    next.lastOkAt = now;
    next.latencyMs = result.latencyMs ?? null;
    next.downSince = null;
    const latency = result.latencyMs ?? null;
    if (latency !== null && latency > slowMs(d)) {
      next.severity = "degraded";
      next.detail = `slow probe (${Math.round(latency)}ms)`;
    } else {
      next.severity = "up";
      next.detail = null;
    }
    return next;
  }

  // Failure.
  next.consecutiveFailures = prev.consecutiveFailures + 1;
  next.latencyMs = null;
  next.detail = result.detail ?? "probe failed";
  if (next.consecutiveFailures >= downAfter(d)) {
    next.severity = "down";
    // Stamp downSince only on the transition INTO down (preserve the original).
    next.downSince = prev.severity === "down" ? prev.downSince : now;
  } else {
    next.severity = "degraded";
    next.downSince = null;
  }
  return next;
}

/** Event-recency tiering: age vs degradedAfterMs / downAfterMs. */
function applyRecency(
  prev: ServiceStatus,
  next: ServiceStatus,
  d: ServiceDescriptor,
  result: ProbeResult,
  now: number,
): ServiceStatus {
  const degradedAfter = d.degradedAfterMs ?? Infinity;
  const downAfterMs = d.downAfterMs ?? Infinity;
  const age = result.ageMs ?? null;

  next.latencyMs = null;
  next.consecutiveFailures = 0;

  if (age === null) {
    // No backing emission found in the window. Treat as the most-degraded tier
    // (down) — the daemon has emitted nothing at all recently.
    next.severity = "down";
    next.detail = result.detail ?? "no recent emission";
    next.downSince = prev.severity === "down" ? prev.downSince : now;
    return next;
  }

  next.detail = result.detail ?? recencyDetail(age);

  if (age >= downAfterMs) {
    next.severity = "down";
    next.downSince = prev.severity === "down" ? prev.downSince : now - age + downAfterMs;
    return next;
  }
  if (age >= degradedAfter) {
    next.severity = "degraded";
    next.downSince = null;
    // Last-ok is roughly "now - age" — the emission's own timestamp.
    next.lastOkAt = now - age;
    return next;
  }
  next.severity = "up";
  next.downSince = null;
  next.lastOkAt = now - age;
  return next;
}

/** A human recency-age detail: "emitted 2m ago". */
export function recencyDetail(ageMs: number): string {
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 60) return `emitted ${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `emitted ${m}m ago`;
  const h = Math.round(m / 60);
  return `emitted ${h}h ago`;
}

// ── The eight registry entries (targets read FROM CONFIG, never hardcoded) ────

/** The config slice the registry needs to resolve probe targets. Read from
 *  loadOtelConfig (+ a webhook-configured flag) — NEVER hardcoded hosts. */
export interface ServiceHealthConfig {
  lokiUrl: string | null;
  prometheusUrl: string | null;
  grafanaUrl: string | null;
  collectorHealthUrl: string | null;
  /** True when loadWebhookConfig succeeded + the webhook routes are mounted. */
  webhookConfigured: boolean;
}

/** Probe cadence shared by every entry (SPEC: 30s). */
export const REGISTRY_INTERVAL_MS = 30_000;

/** Daemon recency thresholds (broker / exec-core): degraded > 3m, down > 10m. */
export const DAEMON_DEGRADED_MS = 3 * 60_000;
export const DAEMON_DOWN_MS = 10 * 60_000;

/** Collector recency fallback (WIDE): degraded > 15m, down > 60m. */
export const COLLECTOR_RECENCY_DEGRADED_MS = 15 * 60_000;
export const COLLECTOR_RECENCY_DOWN_MS = 60 * 60_000;

/**
 * Build the eight descriptors from config. Catalyst plane first, telemetry
 * plane second — the order the strip renders in:
 *   monitor · broker · execution-core · webhook · collector · Loki · Prom · Grafana
 */
export function buildRegistry(cfg: ServiceHealthConfig): ServiceDescriptor[] {
  const collectorIsProbe = cfg.collectorHealthUrl !== null;
  return [
    {
      id: "monitor",
      label: "Monitor",
      kind: "self",
      target: "self",
      configSource: "this process",
      intervalMs: REGISTRY_INTERVAL_MS,
    },
    {
      id: "broker",
      label: "Broker",
      kind: "event-recency",
      target: "event-log service.name=catalyst.broker",
      configSource: "event-log service.name=catalyst.broker (board-snapshot fallback)",
      intervalMs: REGISTRY_INTERVAL_MS,
      degradedAfterMs: DAEMON_DEGRADED_MS,
      downAfterMs: DAEMON_DOWN_MS,
    },
    {
      id: "execution-core",
      label: "Execution-core",
      kind: "event-recency",
      target: "event-log service.name=catalyst.execution-core",
      configSource: "event-log catalyst.execution-core heartbeat",
      intervalMs: REGISTRY_INTERVAL_MS,
      degradedAfterMs: DAEMON_DEGRADED_MS,
      downAfterMs: DAEMON_DOWN_MS,
    },
    {
      id: "webhook",
      label: "Webhook",
      kind: "self",
      target: cfg.webhookConfigured ? "webhook routes (in-process)" : null,
      configSource: "loadWebhookConfig",
      intervalMs: REGISTRY_INTERVAL_MS,
    },
    {
      id: "otel-collector",
      label: "Collector",
      kind: collectorIsProbe ? "probe-url" : "event-recency",
      target: collectorIsProbe
        ? cfg.collectorHealthUrl
        : cfg.lokiUrl !== null
          ? "inferred from telemetry ingest"
          : null,
      configSource: collectorIsProbe
        ? "otel.collectorHealthUrl"
        : "inferred from telemetry ingest (Loki freshness)",
      intervalMs: REGISTRY_INTERVAL_MS,
      ...(collectorIsProbe
        ? { downAfterConsecutive: DEFAULT_DOWN_AFTER_CONSECUTIVE }
        : {
            degradedAfterMs: COLLECTOR_RECENCY_DEGRADED_MS,
            downAfterMs: COLLECTOR_RECENCY_DOWN_MS,
          }),
    },
    {
      id: "loki",
      label: "Loki",
      kind: "probe-url",
      target: cfg.lokiUrl !== null ? `${cfg.lokiUrl}/ready` : null,
      configSource: "otel.lokiUrl",
      intervalMs: REGISTRY_INTERVAL_MS,
      downAfterConsecutive: DEFAULT_DOWN_AFTER_CONSECUTIVE,
    },
    {
      id: "prometheus",
      label: "Prometheus",
      kind: "probe-url",
      target:
        cfg.prometheusUrl !== null
          ? `${cfg.prometheusUrl}/api/v1/status/buildinfo`
          : null,
      configSource: "otel.prometheusUrl",
      intervalMs: REGISTRY_INTERVAL_MS,
      downAfterConsecutive: DEFAULT_DOWN_AFTER_CONSECUTIVE,
    },
    {
      id: "grafana",
      label: "Grafana",
      kind: "probe-url",
      target: cfg.grafanaUrl !== null ? `${cfg.grafanaUrl}/api/health` : null,
      configSource: "otel.grafanaUrl",
      intervalMs: REGISTRY_INTERVAL_MS,
      downAfterConsecutive: DEFAULT_DOWN_AFTER_CONSECUTIVE,
    },
  ];
}

/** The order services render in the strip (catalyst plane, then telemetry). */
