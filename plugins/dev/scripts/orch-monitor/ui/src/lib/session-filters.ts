import type { SessionState, SessionTimeFilter } from "./types";

const CUTOFFS: Record<SessionTimeFilter, number | null> = {
  active: 0,
  "1h": 3600,
  "24h": 86400,
  "48h": 172800,
  all: null,
};

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
