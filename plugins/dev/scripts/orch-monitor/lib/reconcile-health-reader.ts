// reconcile-health-reader.ts — read the execution-core per-team reconcile-health
// markers so /api/snapshot can surface each team's "last successful eligible
// refresh age" (CTL-867).
//
// The execution-core monitor writes one marker per team at
//   ${CATALYST_DIR}/execution-core/reconcile-health/<team>.json
// on every reconcile (success or failure). The marker's `lastSuccessTs` is the
// truthful staleness signal — unlike the eligible projection's content-keyed
// `updatedAt`, which is skipped when the eligible set is unchanged, so it can
// look fresh while no poll has actually succeeded in hours. A team whose
// `alerting` flag is set has crossed the consecutive-failure threshold and is
// silently starving (its eligible projection is frozen stale).
//
// This reader never throws: a missing dir, an unreadable/malformed marker, or an
// absent field degrades to an empty/partial result so the dashboard stays up.

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

export interface TeamReconcileHealth {
  team: string;
  /** ISO timestamp of the last successful eligible-set refresh, or null. */
  lastSuccessTs: string | null;
  /** Milliseconds since the last successful refresh, or null when never succeeded. */
  ageMs: number | null;
  /** Consecutive reconcile-poll failures for this team. */
  consecutiveFailures: number;
  /** True once the consecutive-failure threshold is crossed — the team is starving. */
  alerting: boolean;
  /** ISO timestamp the marker was last written (every reconcile). */
  updatedAt: string | null;
}

function asString(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 ? x : null;
}

function asNumber(x: unknown, fallback: number): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}

/**
 * readReconcileHealth — read every per-team reconcile-health marker under
 * `${catalystDir}/execution-core/reconcile-health/`. Returns a map keyed by team.
 * `now` is injectable for deterministic age computation in tests.
 */
export function readReconcileHealth(
  catalystDir: string,
  { now = Date.now }: { now?: () => number } = {},
): Record<string, TeamReconcileHealth> {
  const out: Record<string, TeamReconcileHealth> = {};
  const dir = join(catalystDir, "execution-core", "reconcile-health");
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out; // dir absent — no team has been reconciled yet
  }
  for (const f of files) {
    if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
    const team = f.slice(0, -".json".length);
    const file = join(dir, f);
    try {
      statSync(file); // skip phantom dirents
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const lastSuccessTs = asString(parsed.lastSuccessTs);
      let ageMs: number | null = null;
      if (lastSuccessTs) {
        const t = Date.parse(lastSuccessTs);
        if (Number.isFinite(t)) ageMs = Math.max(0, now() - t);
      }
      out[team] = {
        team,
        lastSuccessTs,
        ageMs,
        consecutiveFailures: asNumber(parsed.consecutiveFailures, 0),
        alerting: parsed.alerting === true,
        updatedAt: asString(parsed.updatedAt),
      };
    } catch {
      // unreadable / malformed marker — skip this team, keep the rest
    }
  }
  return out;
}
