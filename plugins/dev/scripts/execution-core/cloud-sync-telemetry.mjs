// cloud-sync-telemetry.mjs — CTL-1395. Pure helpers for the catalyst-cloud-sync writer's
// freshness telemetry, factored out of the (script-shaped) cloud-sync.mjs so the staleness
// math + field shape are unit-testable without running the writer.

// freshnessFields — build the structured log fields for one `cloud-sync: freshness` line.
// Semconv-conformant dotted keys (the OTEL logs→metrics connector keys on these). NAME-only
// data — no secrets. `maxUpdatedMs` is the newest mirrored issue `updated_at` (epoch-ms) or
// null; staleness is whole seconds since then (null when unknown — never a bogus number).
export function freshnessFields({ rows = null, maxUpdatedMs = null, status = null, cursor = null, hostName = null, now = Date.now() } = {}) {
  const mx = Number(maxUpdatedMs);
  const staleness =
    Number.isFinite(mx) && mx > 0 ? Math.max(0, Math.round((now - mx) / 1000)) : null;
  return {
    "catalyst.linear.replica.staleness": staleness,
    "catalyst.linear.replica.rows": rows == null ? null : Number(rows) || 0,
    "catalyst.linear.replica.status": status ?? null,
    "catalyst.linear.replica.cursor": cursor ?? null,
    "host.name": hostName ?? null,
  };
}

// The LiveSyncStatus values the SDK surfaces (live-sync-client.d.ts:
// "connecting" | "live" | "reconnecting" | "resyncing" | "error" | "stopped") that mean
// the TRANSPORT is not healthy — an INDEPENDENT liveness failure derived from the
// WebSocket lifecycle (onopen/onclose/onerror/reconnect), NOT from cursor-advance. A
// stuck-reconnecting / errored / stopped socket is a genuine liveness failure; "live",
// "connecting", and "resyncing" are healthy/transient-healthy tailing states.
export const UNHEALTHY_SDK_STATUSES = new Set(["reconnecting", "error", "stopped"]);

// classifyStall — decide the cloud-sync writer's stall posture from cursor-advance AND
// the SDK connection status. Cursor-silence ALONE is AMBIGUOUS: a healthy QUIET feed (no
// Linear changes for the window) and a dead/half-open socket BOTH freeze `replica.cursor`
// — replica-read.mjs:102-118 documents exactly this (the `-wal`/apply cadence goes stale
// on a quiet feed, which is why writer liveness keys on the `.writer.lock` heartbeat, not
// cursor movement). So we must NEVER page or self-heal (restart) on cursor-silence alone:
// that false-kills a perfectly current idle node every quiet window (Codex P1/P2) and
// re-seeds/pages needlessly. The SDK (0.4.0) exposes no per-frame keepalive/last-frame
// timestamp, so we gate the destructive action on an ADDITIONAL independent liveness
// failure the cursor can't fake — the SDK's own connection status:
//   • cursor advanced within the window                 → healthy (no alert, no restart)
//   • cursor stalled, SDK status healthy ("live"/…)     → AMBIGUOUS quiet feed → NO alert,
//        NO restart (surface the cursor-stall only as observational freshness telemetry)
//   • cursor stalled AND SDK status unhealthy           → GENUINE stall (independent
//        confirmation) → loud ERROR alert + self-heal restart
export function classifyStall({ rows = null, stalledMs = 0, stallMs = 600_000, status = null } = {}) {
  const cursorStalled = (rows ?? 0) > 0 && stalledMs >= stallMs;
  const sdkUnhealthy = UNHEALTHY_SDK_STATUSES.has(String(status));
  // A GENUINE stall needs BOTH signals — cursor-silence is only actionable when the SDK
  // independently reports the transport is not healthy.
  const genuine = cursorStalled && sdkUnhealthy;
  return {
    cursorStalled,
    sdkUnhealthy,
    genuine,
    alert: genuine, // page ONLY on a genuine stall — never on a quiet-but-healthy feed
    restart: genuine, // self-heal ONLY on a genuine stall — never false-kill an idle node
    // The freshness-line status: surface a genuine stall loudly; otherwise reflect the
    // SDK's own status (a quiet feed keeps reporting its real "live"/… status honestly).
    displayStatus: genuine ? "stalled" : status ?? "live",
  };
}

// readReplicaCounts — run the single freshness query against a read-model SqlExecutor
// (`replica.sql`). Returns { rows, maxUpdatedMs }, both null on any failure (fail-open:
// a locked / mid-apply DB must never throw out of the writer's telemetry timer).
export function readReplicaCounts(sql) {
  try {
    const row = sql.exec("SELECT COUNT(*) AS n, MAX(updated_at) AS mx FROM issues").toArray()[0];
    const rows = Number(row?.n) || 0;
    // row.mx is null on an empty table; Number(null) === 0 (a finite-but-bogus epoch), so
    // guard the null BEFORE Number() — an empty replica must report maxUpdatedMs null.
    const mxRaw = row?.mx;
    const mx = mxRaw == null ? NaN : Number(mxRaw);
    return { rows, maxUpdatedMs: Number.isFinite(mx) ? mx : null };
  } catch {
    return { rows: null, maxUpdatedMs: null };
  }
}
