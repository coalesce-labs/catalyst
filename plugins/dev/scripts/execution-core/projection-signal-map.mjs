// projection-signal-map.mjs — CTL-1489: PURE mapping from a durable
// `worker_state` row (⨝ its latest `ticket_state_transitions` row) to the
// canonical WorkerSignal shape produced by signal-reader.mjs parseSignal.
//
// This module has NO bun:sqlite / broker-state import, so BOTH the daemon-side
// reader (execution-core/projection-reader.mjs, static broker import) and the
// vite-safe orch-monitor reader (orch-monitor/lib/projection-reader.mjs,
// computed-specifier broker import) can static-import it and stay in lock-step
// without either dragging bun:sqlite into the vite config graph (CTL-1372).

// Statuses that mean a run is held awaiting an operator — parity with
// respond-ticket.mjs findHeldRun ("needs-input" | "stalled").
export const HELD_STATUSES = new Set(["needs-input", "stalled"]);

export function isHeldStatus(status) {
  return HELD_STATUSES.has(status);
}

// Codex P1 (CTL-1489 round 2): `worker_state.status` is NEVER actually
// "needs-input" in the execution-core architecture — the only two event paths
// capable of writing worker_state.status are phase.<name>.<status>
// (WORKER_PHASE_EVENT_PATTERN in broker/projection.mjs matches ONLY
// complete|failed|turn-cap-exhausted — there is no `phase.*.park` event; see
// execution-core/codex-run-phase-agent.mjs's own "D5: no phase.*.park event"
// note) and worker.state_changed (a legacy wave-orchestration event that
// router.mjs explicitly no-ops today: `if (name === "worker.state_changed")
// return;`). So isHeldStatus(row.status) alone can never gate true on a
// normal park — the durable read path would silently never find a held run
// for the single most common held case.
//
// The Axis-2 disposition change (queued/blocked/needs-input/needs-human) IS
// reliably captured durably, via the scheduler's recordTransition chokepoint
// emitting worker.transition.<TICKET> → sink-5 ticket_state_transitions
// (to_disposition). "needs-input" is spelled identically on both axes, so
// deriving held-ness from the latest transition's to_disposition == "needs-input"
// closes the gap with no ambiguity and without touching worker_state.status
// itself (preserving the deliberate single-writer-per-axis boundary documented
// on upsertWorkerState). Deliberately scoped to ONLY "needs-input" here:
// local disk's "stalled" status has no unambiguous Axis-2 disposition
// counterpart (the nearest analog, "needs-human", is a DIFFERENT sticky
// escalation concept — see the Two-axis worker state docs) — that gap is
// tracked separately (CTL-1690) rather than guessed at here.
export function resolveHeldDisposition(row, latest = null) {
  if (isHeldStatus(row?.status)) return row.status;
  return latest?.to_disposition === "needs-input" ? "needs-input" : null;
}

// workerStateRowToSignal — reconstruct the WorkerSignal shape from a durable
// row with NO local-dir dependency. `latest` is the ticket's latest
// ticket_state_transitions row (or null); it supplies the handoff/artifact
// pointer when worker_state has none yet, AND (Codex P1 above) the held
// disposition when worker_state.status never captured it.
//
// Divergences from a local parseSignal that the shadow-diff harness normalizes
// out of the comparison (OQ4): `layout`/`signalPath` are synthetic markers, and
// `host` is null (worker_state carries no host column today).
export function workerStateRowToSignal(row, latest = null) {
  if (!row || typeof row !== "object") return null;
  const bgJobId = row.bg_job_id ?? null;
  const worktreePath = row.worktree_path ?? null;
  const generation = row.generation ?? null;
  const artifact = row.artifact_path ?? latest?.artifact_path ?? null;
  const handoffPath = row.handoff_path ?? latest?.handoff_path ?? null;
  const pr = row.pr_number ?? null;
  // Only fall back to the disposition-derived status when the status column
  // is genuinely empty — a real (even non-held) status column value always
  // wins, so this never masks a legitimate "done"/"phase-complete" status.
  const status = row.status ?? resolveHeldDisposition(row, latest) ?? "";
  return {
    ticket: row.ticket ?? null,
    // synthetic — flags this signal as projection-derived, not disk-read.
    layout: "projection",
    signalPath: "<projection>",
    phase: row.phase ?? null,
    status,
    // liveness derived from bg_job_id presence (the projection has no pid).
    liveness: bgJobId ? { kind: "bg", value: bgJobId } : { kind: "pid", value: null },
    updatedAt: row.last_event_ts ?? row.updated_at ?? null,
    pr,
    worktreePath,
    // OQ4: no host column on worker_state → null (normalized out of drift diff).
    host: null,
    // reconstructed raw carries the widened durable fields consumers read.
    raw: {
      ticket: row.ticket ?? null,
      phase: row.phase ?? null,
      status: row.status ?? null,
      bg_job_id: bgJobId,
      generation,
      artifact,
      worktreePath,
      handoffPath,
      pr,
    },
  };
}
