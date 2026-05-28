// CTL-643: boot-time GC pass over the broker interests Map. Mirrors the bulk
// pattern at handleOrchestratorTerminated (router.mjs:395-422) — one log line
// per pruned entry, one saveInterests + persistBrokerState after the loop,
// one audit event capturing the summary. Wired into broker/index.mjs main()
// between loadExistingRegistrations() and maybeEmitProseDisabled() so it has
// no race against live filter.register ingestion (the tailer's fs.watch is
// not registered until after this).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { isOrchestratorActive, isSessionAlive } from "./gc-liveness.mjs";

const PR_LIFECYCLE = "pr_lifecycle";

export function gcStaleInterests({
  interests,
  log,
  saveInterests,
  persistBrokerState,
  deleteFilterState,
  appendEvent,
  execCoreOrchDir,
  runsRoot,
  statJob,
}) {
  const beforeCount = interests.size;
  if (beforeCount === 0) {
    return { pruned: 0, byReason: {}, beforeCount: 0, afterCount: 0 };
  }

  const toDelete = [];
  for (const [id, reg] of interests) {
    const reason = classifyForGc(reg, { execCoreOrchDir, runsRoot, statJob });
    if (reason) toDelete.push({ id, reg, reason });
  }

  if (toDelete.length === 0) {
    return { pruned: 0, byReason: {}, beforeCount, afterCount: beforeCount };
  }

  const byReason = {};
  for (const { id, reg, reason } of toDelete) {
    interests.delete(id);
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    log.info(
      {
        interestId: id,
        orchestrator: reg.orchestrator ?? null,
        sessionId: reg.session_id ?? null,
        reason,
      },
      "gc: removed stale interest",
    );
    if (reg.interest_type === PR_LIFECYCLE) {
      try {
        deleteFilterState(id);
      } catch (err) {
        log.warn(
          { interestId: id, err: err?.message },
          "gc: deleteFilterState failed (continuing)",
        );
      }
    }
  }

  saveInterests();
  persistBrokerState();

  const afterCount = interests.size;
  appendEvent({
    event: "broker.daemon.gc",
    orchestrator: null,
    worker: null,
    detail: { pruned: toDelete.length, byReason, beforeCount, afterCount },
  });

  return { pruned: toDelete.length, byReason, beforeCount, afterCount };
}

function classifyForGc(reg, { execCoreOrchDir, runsRoot, statJob }) {
  if (reg.orchestrator) {
    if (isOrchestratorActive(reg.orchestrator, { execCoreOrchDir, runsRoot })) {
      return null;
    }
    // Distinguish terminal-known from pure-orphan for telemetry. An
    // orchestrator that has *some* dir under either root but no live signal
    // counts as orchestrator_terminal; absence of the dir is orchestrator_orphan.
    const haveDir =
      (execCoreOrchDir &&
        existsSync(join(execCoreOrchDir, "workers", reg.orchestrator))) ||
      (runsRoot && existsSync(join(runsRoot, reg.orchestrator)));
    return haveDir ? "orchestrator_terminal" : "orchestrator_orphan";
  }
  if (reg.session_id && !isSessionAlive(reg.session_id, { statJob })) {
    return "session_dead";
  }
  return null;
}
