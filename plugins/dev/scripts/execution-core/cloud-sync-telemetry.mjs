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
