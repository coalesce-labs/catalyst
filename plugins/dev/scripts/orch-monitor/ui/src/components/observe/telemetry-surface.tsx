// telemetry-surface.tsx — the OBSERVE Telemetry shell (OBS-5, MINIMAL).
//
// This is the scaffold that proves the OBSERVE foundation end-to-end: surface
// routing (App.tsx → surfaceContentKind "telemetry"), the shared time-range atom
// (observe-store.ts), and the honesty-ladder ChartCard reading LIVE /api/health/otel.
// On the Mini (prom + loki reachable) the card renders its LIVE state; on a
// no-stack install it degrades honestly — without either, the foundation isn't proven.
//
// The real Telemetry hero (FLOWING/QUIET/ERRORING/DARK) + live tail + panels land
// in OBS-6/7/8. Keep this thin: routing + chart-card-live validation only.
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import type { OtelHealth } from "@/lib/types";
import {
  timeRangeAtom,
  TIME_RANGES,
  TIME_RANGE_LABEL,
} from "@/lib/observe-store";
import { ChartCard } from "@/components/observe/chart-card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export function TelemetrySurface() {
  const [range, setRange] = useAtom(timeRangeAtom);
  // Fetch the honesty-ladder health probe directly (10s-TTL real probe — the
  // ChartCard reads this OtelHealth to pick its live/unreachable/unconfigured state).
  const [health, setHealth] = useState<OtelHealth | null>(null);
  useEffect(() => {
    let alive = true;
    async function probe() {
      try {
        const resp = await fetch("/api/health/otel");
        if (!resp.ok || !alive) return;
        setHealth((await resp.json()) as OtelHealth);
      } catch {
        /* leave health null → ChartCard stays optimistic until the next probe */
      }
    }
    probe();
    const id = setInterval(probe, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-surface-0 p-5 text-fg">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Telemetry</h1>
          <p className="text-[12px] text-muted">
            Is work actually flowing right now?
          </p>
        </div>
        {/* Global time-range control — bound to the shared OBSERVE atom. */}
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={range}
          onValueChange={(v) => v && setRange(v as (typeof TIME_RANGES)[number])}
          aria-label="Time range"
        >
          {TIME_RANGES.map((r) => (
            <ToggleGroupItem key={r} value={r} className="text-[12px]">
              {TIME_RANGE_LABEL[r]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </header>

      <ChartCard title="Pipeline status" dataSource="[loki]" health={health}>
        <p className="text-[13px] text-muted">
          Live panels arrive in OBS-6/7/8.
        </p>
      </ChartCard>
    </div>
  );
}
