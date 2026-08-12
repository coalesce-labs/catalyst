function finiteOr(value, fallback) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const REPLICA_COMPLETENESS_DEFAULTS = {
  lockStaleMs: finiteOr(process.env.CATALYST_REPLICA_LOCK_STALE_MS, 60_000),
  stalenessMs: finiteOr(process.env.CATALYST_BH_REPLICA_STALE_MS, 15 * 60_000),
};
export const REQUIRED_REPLICA_TABLES = ["issues", "sync_meta"];

function unknown(fields = {}) {
  return { state: "unknown", issueRows: null, teamCount: null, teamCoveragePct: null,
    missingTeams: [], cursorPresent: null, lockAgeMs: null, sizeBytes: null,
    ageMs: null, stale: false, ...fields };
}

export function evaluateReplicaCompleteness(snapshot, thresholds = {}, nowMs) {
  if (!snapshot || typeof snapshot !== "object" || !Number.isFinite(nowMs)) return unknown();
  const sampledMs = Date.parse(snapshot.sampledAt ?? "");
  if (!Number.isFinite(sampledMs)) return unknown();
  const ageMs = Math.max(0, nowMs - sampledMs);
  const stalenessMs = finiteOr(thresholds.stalenessMs, REPLICA_COMPLETENESS_DEFAULTS.stalenessMs);
  if (ageMs > stalenessMs) return unknown({ ageMs, stale: true });
  const lockAgeMs = Number.isFinite(snapshot.lockMtimeMs) ? Math.max(0, nowMs - snapshot.lockMtimeMs) : null;
  const base = {
    issueRows: Number.isFinite(snapshot.issueRows) ? snapshot.issueRows : null,
    teamCount: Array.isArray(snapshot.teams) ? snapshot.teams.length : null,
    cursorPresent: typeof snapshot.cursor === "string" && snapshot.cursor !== "",
    lockAgeMs, sizeBytes: Number.isFinite(snapshot.sizeBytes) ? snapshot.sizeBytes : null,
    ageMs, stale: false, teamCoveragePct: null, missingTeams: [],
  };
  if (snapshot.dbPresent === false) return { ...unknown(), ...base, issueRows: null, state: "absent" };
  const tables = Array.isArray(snapshot.tables) ? snapshot.tables : null;
  const missingTables = tables ? REQUIRED_REPLICA_TABLES.filter((table) => !tables.includes(table)) : [];
  if (base.sizeBytes === 0 || snapshot.isSqlite === false || missingTables.length > 0) return { ...base, state: "no-schema", missingTables };
  if (tables === null || base.issueRows === null) return unknown({ ...base, issueRows: base.issueRows });
  if (base.issueRows === 0) return { ...base, state: "empty" };
  const lockStaleMs = finiteOr(thresholds.lockStaleMs, REPLICA_COMPLETENESS_DEFAULTS.lockStaleMs);
  if (lockAgeMs !== null && lockAgeMs > lockStaleMs) return { ...base, state: "stale" };
  const registered = Array.isArray(snapshot.registeredTeams) ? snapshot.registeredTeams : [];
  if (registered.length > 0) {
    const present = new Set(Array.isArray(snapshot.teams) ? snapshot.teams : []);
    const missingTeams = registered.filter((team) => !present.has(team));
    const teamCoveragePct = ((registered.length - missingTeams.length) / registered.length) * 100;
    if (missingTeams.length > 0) return { ...base, state: "partial", missingTeams, teamCoveragePct };
    return { ...base, state: "ok", teamCoveragePct };
  }
  return { ...base, state: "ok" };
}

export function describeReplicaState(q) {
  switch (q?.state) {
    case "absent": return "replica db absent — every read falls through to live Linear";
    case "no-schema": return `replica db has no usable schema${q.missingTables?.length ? ` (missing: ${q.missingTables.join(", ")})` : ""} — every read misses`;
    case "empty": return "replica db has 0 issue rows — seeded schema, no data; every read misses";
    case "stale": return `replica writer heartbeat stale (${Math.round((q.lockAgeMs ?? 0) / 1000)}s) — writer is down, data is frozen`;
    case "partial": return `replica missing ${q.missingTeams.length} registered team(s): ${q.missingTeams.join(", ")} — reads for those teams always miss`;
    case "ok": return `replica populated (${q.issueRows} issues, ${q.teamCount} team(s))`;
    default: return q?.stale ? "replica snapshot stale" : "no replica snapshot";
  }
}
