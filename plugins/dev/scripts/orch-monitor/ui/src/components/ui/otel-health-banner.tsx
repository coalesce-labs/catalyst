// otel-health-banner.tsx — CTL-1039: the telemetry-source banner now speaks
// PROPORTIONALLY. It shows ONLY on a sustained `severity === "down"` (≥3
// consecutive probe failures) — a single blip / degraded reads as a muted
// "reconnecting…" hint, never the amber banner. Recovery clears it instantly
// (the registry's success resets state) — the 2026-06-11 stale-failure-needing-
// restart incident becomes impossible because every success resets the model.

import { cn } from "@/lib/utils";
import type { OtelHealth } from "@/lib/types";
import { AlertCircle, Info } from "lucide-react";

interface OtelHealthBannerProps {
  health: OtelHealth | null;
  className?: string;
}

/** Local HH:MM for the "since" copy. */
function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** An endpoint is BANNER-worthy only when its shared severity is "down". The
 *  binary `reachable` is the fallback for a checker with no registry severity
 *  (severity undefined) — but a `degraded` severity must NOT raise the banner. */
function isDown(ep: { url: string | null; reachable: boolean; severity?: string }): boolean {
  if (ep.url === null) return false;
  if (ep.severity !== undefined) return ep.severity === "down";
  return !ep.reachable;
}

export function OtelHealthBanner({ health, className }: OtelHealthBannerProps) {
  if (!health) return null;

  const promDown = isDown(health.prometheus);
  const lokiDown = isDown(health.loki);
  const anyDown = promDown || lokiDown;

  // Configured + nothing DOWN → no banner (a degraded source renders the quiet
  // reconnecting hint elsewhere, not here).
  if (health.configured && !anyDown) return null;

  const unconfigured = !health.configured;

  const unreachableDetail = (() => {
    if (unconfigured) return null;
    const parts: string[] = [];
    if (promDown) parts.push(`Prometheus (${health.prometheus.url})`);
    if (lokiDown) parts.push(`Loki (${health.loki.url})`);
    return parts.length > 0 ? parts.join(" and ") : null;
  })();

  const since = ` since ${hhmm(Date.now())}`;

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-4 py-2 text-[13px]",
        unconfigured
          ? "border-accent/20 bg-accent/10 text-accent"
          : "border-yellow/20 bg-yellow/10 text-yellow",
        className,
      )}
    >
      {unconfigured ? (
        <Info className="mt-[2px] h-4 w-4 shrink-0" />
      ) : (
        <AlertCircle className="mt-[2px] h-4 w-4 shrink-0" />
      )}
      <div className="min-w-0">
        {unconfigured ? (
          <span>
            Metrics unavailable. Run{" "}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px]">
              /catalyst-dev:setup-catalyst
            </code>{" "}
            to enable observability (Prometheus + Loki).
          </span>
        ) : unreachableDetail ? (
          <span>
            Metrics source unreachable — {unreachableDetail}
            {since}. Check that Prometheus/Loki are running.
          </span>
        ) : (
          <span>Metrics source unreachable{since} — check Prometheus/Loki.</span>
        )}
      </div>
    </div>
  );
}
