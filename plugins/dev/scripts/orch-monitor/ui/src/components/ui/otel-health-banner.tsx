import { cn } from "@/lib/utils";
import type { OtelHealth } from "@/lib/types";
import { AlertCircle, Info } from "lucide-react";

interface OtelHealthBannerProps {
  health: OtelHealth | null;
  className?: string;
}

export function OtelHealthBanner({ health, className }: OtelHealthBannerProps) {
  if (!health) return null;

  const allReachable =
    (health.prometheus.url === null || health.prometheus.reachable) &&
    (health.loki.url === null || health.loki.reachable);

  if (health.configured && allReachable) return null;

  const unconfigured = !health.configured;

  const unreachableDetail = (() => {
    if (unconfigured) return null;
    const parts: string[] = [];
    if (health.prometheus.url && !health.prometheus.reachable) {
      parts.push(`Prometheus (${health.prometheus.url})`);
    }
    if (health.loki.url && !health.loki.reachable) {
      parts.push(`Loki (${health.loki.url})`);
    }
    return parts.length > 0 ? parts.join(" and ") : null;
  })();

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
            Metrics source unreachable — {unreachableDetail}. Check that Prometheus/Loki are running.
          </span>
        ) : (
          <span>Metrics source unreachable — check Prometheus/Loki.</span>
        )}
      </div>
    </div>
  );
}
