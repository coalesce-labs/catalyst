// useHudMetrics.ts — drives the CTL-435 status-line metric chips. Polls the
// same on-disk state used by the dashboard (worker signal files + per-orch
// state.json) every 5s — matching the cadence of the broker-state and
// dashboard refreshes elsewhere in the HUD.
//
// The pure `computePollMetrics` reduction is split out so the chip totals
// can be unit-tested without spinning up node:fs or fake timers.

import { useEffect, useState } from "react";
import { readWorkerSignals, type WorkerSignal } from "../lib/worker-signals-reader.ts";
import { readOrchStates, type OrchState } from "../lib/orch-state-reader.ts";

export interface HudPollMetrics {
  activeWorkers: number;
  activeOrchestrators: number;
  openPRs: number;
}

const TERMINAL_STATUSES = new Set(["done", "failed", "stalled", "deploy-failed"]);

export function computePollMetrics(
  workers: WorkerSignal[],
  orchs: OrchState[],
): HudPollMetrics {
  return {
    activeWorkers: workers.filter((w) => !TERMINAL_STATUSES.has(w.status)).length,
    activeOrchestrators: orchs.filter((o) => o.workersCount.active > 0).length,
    openPRs: workers.filter((w) => w.pr !== null && !w.pr.mergedAt).length,
  };
}

export function useHudMetrics(): HudPollMetrics {
  const [metrics, setMetrics] = useState<HudPollMetrics>({
    activeWorkers: 0,
    activeOrchestrators: 0,
    openPRs: 0,
  });
  useEffect(() => {
    const refresh = () => setMetrics(computePollMetrics(readWorkerSignals(), readOrchStates()));
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);
  return metrics;
}
