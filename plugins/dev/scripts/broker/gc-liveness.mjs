// CTL-643: liveness probes for the broker boot-time GC pass. Decide whether
// an interest's owning orchestrator/ticket or session is still active.
// Mirrors classifyWorker's signal-file authority (recovery.mjs:118) and
// isTicketInFlight (scheduler.mjs:123) so GC and the scheduler share one
// definition of "in-flight".

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readPhaseSignals, isTicketInFlight } from "../execution-core/scheduler.mjs";

// isOrchestratorActive — true when the orchestrator/ticket still has at least
// one non-terminal phase signal under execCoreOrchDir/workers/<id>/, OR a
// legacy run dir at runsRoot/<id>/. Pure-orphans (no dir anywhere) are
// inactive. Either root is optional; absence means "skip that branch".
export function isOrchestratorActive(orchId, { execCoreOrchDir, runsRoot } = {}) {
  if (!orchId) return false;

  if (execCoreOrchDir) {
    const workerDir = join(execCoreOrchDir, "workers", orchId);
    if (existsSync(workerDir)) {
      const phases = readPhaseSignals(execCoreOrchDir, orchId);
      if (Object.keys(phases).length > 0) {
        return isTicketInFlight(phases);
      }
      // dir present but no phase-*.json files — treat as inactive (orphan dir).
      return false;
    }
  }

  if (runsRoot) {
    if (existsSync(join(runsRoot, orchId))) return true;
  }

  return false;
}

// isSessionAlive — thin wrapper over the injected statJob probe. Mirrors the
// execution-core daemon's session liveness check (recovery.mjs defaultStatJob).
export function isSessionAlive(sessionId, { statJob } = {}) {
  if (!sessionId || typeof statJob !== "function") return false;
  return statJob(sessionId) != null;
}
