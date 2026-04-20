import type {
  OrchestratorState,
  SessionState,
  SessionTimeFilter,
} from "./types";
import { isWorkerDone } from "./types";

const CUTOFFS: Record<SessionTimeFilter, number | null> = {
  active: 0,
  "1h": 3600,
  "24h": 86400,
  "48h": 172800,
  all: null,
};

export const RECENT_WINDOW_SECONDS = 7 * 86400;

export function filterSessions(
  sessions: SessionState[],
  filter: SessionTimeFilter,
): { active: SessionState[]; dead: SessionState[] } {
  const active = sessions.filter((s) => s.alive || s.status === "running");

  if (filter === "active") {
    return { active, dead: [] };
  }

  const cutoff = CUTOFFS[filter];
  const dead = sessions.filter((s) => {
    if (s.alive || s.status === "running") return false;
    if (cutoff === null) return true;
    return s.timeSinceUpdate < cutoff;
  });

  return { active, dead };
}

export function filterOrchestrators(
  orchestrators: OrchestratorState[],
  filter: SessionTimeFilter,
): { visible: OrchestratorState[]; recent: OrchestratorState[] } {
  if (filter === "all") {
    return { visible: orchestrators.slice(), recent: [] };
  }

  const cutoff = CUTOFFS[filter];
  const visible: OrchestratorState[] = [];
  const recent: OrchestratorState[] = [];

  for (const orch of orchestrators) {
    const workers = Object.values(orch.workers);

    if (workers.length === 0) {
      visible.push(orch);
      continue;
    }

    const hasActiveWorker = workers.some((w) => !isWorkerDone(w.status));
    if (hasActiveWorker) {
      visible.push(orch);
      continue;
    }

    const mostRecent = Math.min(...workers.map((w) => w.timeSinceUpdate));

    if (cutoff !== null && cutoff > 0 && mostRecent < cutoff) {
      visible.push(orch);
      continue;
    }

    if (mostRecent < RECENT_WINDOW_SECONDS) {
      recent.push(orch);
    }
  }

  return { visible, recent };
}
