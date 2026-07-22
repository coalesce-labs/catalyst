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

// workerStateRowToSignal — reconstruct the WorkerSignal shape from a durable
// row with NO local-dir dependency. `latest` is the ticket's latest
// ticket_state_transitions row (or null); it supplies the handoff/artifact
// pointer when worker_state has none yet.
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
  return {
    ticket: row.ticket ?? null,
    // synthetic — flags this signal as projection-derived, not disk-read.
    layout: "projection",
    signalPath: "<projection>",
    phase: row.phase ?? null,
    status: row.status ?? "",
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
