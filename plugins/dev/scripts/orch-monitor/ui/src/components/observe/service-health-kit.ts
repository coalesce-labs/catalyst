// service-health-kit.ts — the PURE kit behind the Fleet Ops SERVICES strip
// (CTL-1050 §2). React-free severity→token mapping, the catalyst-plane-first
// ordering, and the last-checked label — unit-testable in isolation so the strip
// component owns no branching logic. Mirrors fleetops-kit.ts / hero-state.ts.

/** The four shared severities (kept in lock-step with lib/service-health.ts —
 *  this is a UI mirror so the ui/ module graph stays self-contained). */
export type ServiceSeverity = "up" | "degraded" | "down" | "unknown";

/** The wire shape /api/health/services returns per service (the fields the strip
 *  + its hover read). A structural subset of the server ServiceStatus. */
export interface ServiceStatusView {
  id: string;
  label: string;
  severity: ServiceSeverity;
  lastCheckedAt: number | null;
  lastOkAt: number | null;
  consecutiveFailures: number;
  latencyMs: number | null;
  detail: string | null;
  target: string | null;
  configSource: string;
  downSince: number | null;
}

export interface ServiceHealthSnapshotView {
  generatedAt: number;
  services: ServiceStatusView[];
}

/** The order the strip renders in: catalyst plane first, telemetry plane second
 *  (SPEC §2). Kept identical to lib/service-health.ts SERVICE_ORDER. */
export const STRIP_ORDER: readonly string[] = [
  "monitor",
  "broker",
  "execution-core",
  "webhook",
  "otel-collector",
  "loki",
  "prometheus",
  "grafana",
] as const;

/**
 * The dot color (a CSS var) for each severity — the EXACT HostMatrix vocabulary
 * (host-matrix.tsx): --chart-2 up / --chart-3 degraded / --chart-4 down. Unknown
 * is the muted-foreground at 50% (a quiet grey, not a status color). NOT a
 * Tailwind bg-* class.
 */
export function severityDotColor(severity: ServiceSeverity): string {
  switch (severity) {
    case "up":
      return "var(--chart-2)";
    case "degraded":
      return "var(--chart-3)";
    case "down":
      return "var(--chart-4)";
    case "unknown":
      return "var(--muted-foreground)";
  }
}

/** The dot glow — present ONLY when up (the HostMatrix live-dot pattern). Returns
 *  the boxShadow string, or undefined for every non-up state (steady, no strobe). */
export function severityDotGlow(severity: ServiceSeverity): string | undefined {
  return severity === "up" ? `0 0 6px ${severityDotColor("up")}` : undefined;
}

/** The dot opacity — unknown reads at 50% so an unconfigured service is visibly
 *  quiet (grey, half-strength), every tracked state at full strength. */
export function severityDotOpacity(severity: ServiceSeverity): number {
  return severity === "unknown" ? 0.5 : 1;
}

/** Whether the service label renders muted (unknown only) vs normal foreground. */
export function isLabelMuted(severity: ServiceSeverity): boolean {
  return severity === "unknown";
}

/** Order a service list by the catalyst-plane-first STRIP_ORDER. Unknown ids
 *  (forward-compat) sort to the end in their wire order. PURE — returns a new
 *  array, never mutates. */
export function orderServices<T extends { id: string }>(services: readonly T[]): T[] {
  const rank = (id: string): number => {
    const i = STRIP_ORDER.indexOf(id);
    return i === -1 ? STRIP_ORDER.length : i;
  };
  return [...services].sort((a, b) => rank(a.id) - rank(b.id));
}

/** The muted last-checked label: "12s" / "3m" / "—" when never checked. Mirrors
 *  the freshnessLabel idiom (seconds → minutes → hours), but BARE (no "ago") so
 *  it reads as the calm "· 12s" suffix. */
export function lastCheckedLabel(lastCheckedAt: number | null, now: number): string {
  if (lastCheckedAt === null || !Number.isFinite(lastCheckedAt)) return "—";
  const s = Math.max(0, Math.round((now - lastCheckedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

/** Format an epoch-ms instant as local HH:MM (the "down since 14:32" hover copy). */
export function hhmm(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** The hover (tooltip / title=) text for one service entry — target + config
 *  source, last-ok, consecutive failures, the latest detail, and "down since
 *  HH:MM" for a down service. PURE so the strip's title= is unit-testable. */
export function hoverText(s: ServiceStatusView): string {
  const lines: string[] = [];
  lines.push(s.target ?? "not configured");
  lines.push(`source: ${s.configSource}`);
  if (s.severity === "down" && s.downSince !== null) {
    lines.push(`down since ${hhmm(s.downSince)}`);
  }
  if (s.lastOkAt !== null) {
    lines.push(`last ok ${hhmm(s.lastOkAt)}`);
  } else {
    lines.push("last ok —");
  }
  if (s.consecutiveFailures > 0) {
    lines.push(`${s.consecutiveFailures} consecutive failure${s.consecutiveFailures === 1 ? "" : "s"}`);
  }
  if (s.detail) lines.push(s.detail);
  return lines.join("\n");
}
