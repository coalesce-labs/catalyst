// replica-read.mjs — CTL-1340: the daemon's READ client for the local
// Catalyst-Cloud SQLite replica (~/catalyst/catalyst-replica.db, seeded from the
// cloud change-feed). The flag-gated "replica tier" of fetchTicketState: when the
// CATALYST_LINEAR_REPLICA flag is ON, the scheduler's hot per-signal terminal
// checks read terminal-ness from this sub-ms local DB instead of the
// rate-limited per-tick `linearis` exec.
//
// Sibling of gateway-read.mjs (CTL-823) and built to the SAME contract:
//   - Deliberately NOT an HTTP client — the scheduler tick is synchronous, so an
//     HTTP hop would mean another per-call subprocess (the exact cost this tier
//     removes). SQLite WAL exists for this shape: the replica daemon stays the
//     single WRITER; this module opens the same file strictly READONLY.
//   - LIGHT single-row read (NOT the cloud's full buildIssueDetail, which runs
//     7+ queries): one index-backed SELECT of exactly the three terminal columns.
//   - Fail-open contract: ANY failure (file absent, schema mismatch, lock
//     contention, corrupt row, absent ticket) returns `undefined` — and
//     fetchTicketState FALLS THROUGH to today's gateway+live read path. The
//     replica is a HIT-only accelerator, NEVER the source of truth; a MISS must
//     never let the terminal sweep re-flag a finished ticket needs-human.
//
// Terminal mapping (robust against team-specific state names): on a HIT we
// synthesize the canonical Linear category name from the timestamp columns —
// canceled_at != null → "Canceled", else completed_at != null → "Done" — so
// isLinearTerminal (terminal-state.mjs: {Done, Canceled}) recognizes terminality
// even if a team's terminal workflow state carries a custom display name. A
// non-terminal HIT returns the row's actual `state` name (or null).
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { getReplicaDbPath } from "./config.mjs";

// The light terminal SELECT. Index-backed by idx_issues_identifier (confirmed).
// removed_at IS NULL excludes tombstoned rows (a removed ticket is a MISS → the
// caller falls through to the live read, never a stale terminal verdict).
const TERMINAL_SELECT = `SELECT state, completed_at, canceled_at FROM issues WHERE identifier = ? AND removed_at IS NULL LIMIT 1`;

// CTL-1366: the cheap freshness probe. One aggregate scan of the replica's
// `issues` table → the newest mirror timestamp + the row count. Drives the
// catalyst.linear.replica.staleness gauge (now − maxUpdatedAtMs). Deliberately
// unindexed/whole-table — it runs on a low cadence (once alongside cache.stats),
// not in the hot per-signal path.
const FRESHNESS_SELECT = `SELECT MAX(updated_at) AS maxUpdated, COUNT(*) AS n FROM issues`;

// CTL-1372: the BATCHED title reader the orch-monitor board sources display
// titles from. filter-state.db ticket_state has NO title column, and a PARKED
// ticket (worker dir torn down, no eligible row) has no other durable title
// source — so its board card otherwise renders as the bare id. The replica's
// `issues.title` is the complete Linear title for every mirrored ticket, so one
// index-backed IN-query resolves the whole board at once. Chunked under SQLite's
// bound-parameter ceiling; removed_at IS NULL drops tombstones (a removed ticket
// is a MISS → the caller falls through to its existing chain, never a stale
// title). Built to the SAME fail-open contract as lookup()/freshness().
const TITLES_CHUNK = 400; // stay well under SQLite's bound-parameter ceiling (999)
function titlesSelect(n) {
  return `SELECT identifier, title FROM issues WHERE identifier IN (${Array(n)
    .fill("?")
    .join(",")}) AND removed_at IS NULL`;
}

// coerce a replica `updated_at` cell to epoch-ms. Accepts an epoch-ms integer
// (the cloud change-feed shape) OR an ISO-8601 string (Date.parse fallback).
// Anything that resolves to neither (null, NaN, garbage) → undefined → the
// caller fails open (no gauge emitted) rather than reporting a bogus staleness.
function coerceMs(v) {
  if (v == null) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n; // epoch-ms integer
  const p = Date.parse(v); // ISO-8601 text
  return Number.isFinite(p) ? p : undefined;
}

// CTL-1397: the replica-backed board-list / eligible discovery query. The
// daemon's per-tick reconcile runs this INSTEAD of `linearis issues list --team
// X --status Y` — the linearis discovery query burns the shared Linear quota and
// trips the CTL-679 circuit breaker, freezing board discovery fleet-wide. Reading
// the local sub-ms replica makes discovery immune to the breaker/quota.
//
// The `issues` table has team_id (UUID) but NO team_key column, so we filter by
// the Linear identifier prefix: identifiers are `<teamKey>-<number>`, so
// `identifier LIKE 'CTL-%'` selects exactly team CTL (the hyphen disambiguates
// CTL- from CTC-). state is the workflow-state NAME string (matches query.status).
// removed_at IS NULL drops tombstones. LIMIT 200 matches linear-query DEFAULT_LIMIT.
const ELIGIBLE_SELECT = `SELECT i.identifier, i.title, i.state, i.priority, i.estimate, i.updated_at, i.created_at, i.parent_identifier, i.delegate_id, i.delegate_name, p.name AS project_name FROM issues i LEFT JOIN projects p ON p.id = i.project_id WHERE i.identifier LIKE ? AND i.state = ? AND i.removed_at IS NULL ORDER BY i.updated_at DESC LIMIT ?`;
const ELIGIBLE_LIMIT = 200;
// Relation enrichment, mirroring normalizeDetail in linear-cli.mjs. forward:
// edges this issue OWNS (relatedIssue is the target); inverse: edges that point
// AT this issue (the blocked-by edge the scheduler gates on).
const RELATIONS_FORWARD_SELECT = `SELECT type, related_identifier FROM relations WHERE issue_identifier = ?`;
const RELATIONS_INVERSE_SELECT = `SELECT type, issue_identifier FROM relations WHERE related_identifier = ?`;

// CTL-1397 (P1 fix) — the SEED-COMPLETENESS gate. The mtime gate
// (isReplicaFresh) proves the cloud-sync writer is LIVE; it does NOT prove the
// seed is COMPLETE. The writer's forced re-seed (the exact quota/outage-recovery
// path this feature exists to survive) TRUNCATES + batch-repopulates the `issues`
// table while the file mtime stays fresh, so a read landing mid-reseed sees either
// an EMPTY table (→ would zero the board) or a PARTIAL table (→ a trusted
// incomplete set). The writer DELETES the `sync_meta` cursor row at re-seed start
// and re-writes it only on completion (@catalyst-cloud/sdk: catalyst-replica.ts +
// replicate.ts), so a present, non-empty cursor IS the seed-completeness signal:
// cursor-present = seed complete; cursor-absent/empty = mid-reseed → don't serve.
const SEED_COMPLETE_SELECT = `SELECT 1 FROM sync_meta WHERE key = 'cursor' AND value IS NOT NULL AND value <> '' LIMIT 1`;

// The eligible freshness GATE — a writer-LIVENESS proxy. A dead writer must stop
// the replica from serving discovery, so we fall through to linearis (correct
// answer, just un-accelerated).
//
// CTL-1397 (4/n): gate on the cloud-sync writer's HEARTBEAT file
// `<db>.writer.lock`, NOT the db/`-wal` mtime. The `-wal` mtime only advances on
// an actual APPLY, so during a QUIET Linear feed (live writer, no issue updates)
// it goes stale within the threshold even though the replica is perfectly current
// — and gating discovery on that false-falls-through to `linearis issues list`
// exactly when the board is UNCHANGED, burning the shared quota + tripping the
// CTL-679 breaker (the residual board-freeze this closes; observed live: mini
// `-wal` 520s stale while `.writer.lock` heartbeated 5s ago). The writer touches
// `.writer.lock` every few seconds regardless of data changes, so its mtime
// tracks the WRITER being alive. Fall back to the db/`-wal` mtime only when the
// lock is absent (bootstrap / an older writer without the heartbeat file).
// Threshold = CATALYST_LINEAR_REPLICA_STALE_MS (default 5 min). Returns true when
// fresh, false when absent/stale/unstattable.
function isReplicaFresh(dbPath) {
  const thresholdMs = Number(process.env.CATALYST_LINEAR_REPLICA_STALE_MS) || 300_000;
  // Preferred signal: the writer's heartbeat lock (advances on liveness, not on
  // data changes). Present → it is authoritative (a present-but-stale lock means
  // the writer died, so we do NOT serve even if a recent apply left `-wal` fresh).
  try {
    const lock = statSync(dbPath + ".writer.lock");
    return Date.now() - lock.mtimeMs <= thresholdMs;
  } catch {
    /* lock absent → fall back to the db/-wal mtime liveness proxy below */
  }
  let newest;
  try {
    newest = statSync(dbPath).mtimeMs; // throws if the file is absent → not fresh
  } catch {
    return false;
  }
  try {
    const wal = statSync(dbPath + "-wal");
    if (wal.size > 0) newest = Math.max(newest, wal.mtimeMs);
  } catch {
    /* -wal absent → main DB mtime only */
  }
  return Date.now() - newest <= thresholdMs;
}

export function createReplicaReader({ dbPath = getReplicaDbPath() } = {}) {
  let db = null;

  const open = () => {
    if (db) return db;
    db = new Database(dbPath, { readonly: true });
    // Readonly + WAL: writers never block readers, but a checkpoint can hold the
    // lock briefly — wait a beat instead of failing the read.
    db.run("PRAGMA busy_timeout = 250");
    return db;
  };

  const dropHandle = () => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    db = null;
  };

  // lookup(identifier) → { terminal, state } | undefined
  //   HIT canceled_at != null  → { terminal: true,  state: "Canceled" }
  //   HIT completed_at != null → { terminal: true,  state: "Done" }
  //   HIT otherwise            → { terminal: false, state: row.state || null }
  //   no row / no db / any throw → undefined  (fail-open; caller falls through)
  const lookup = (identifier) => {
    if (!identifier) return undefined;
    try {
      const row = open().prepare(TERMINAL_SELECT).get(identifier);
      if (!row) return undefined; // absent / removed → MISS, fall through to live
      if (row.canceled_at != null) return { terminal: true, state: "Canceled" };
      if (row.completed_at != null) return { terminal: true, state: "Done" };
      return { terminal: false, state: row.state || null };
    } catch {
      // Drop the handle so a later call re-opens fresh — the DB may be
      // created/migrated/re-seeded by the replica daemon between calls.
      dropHandle();
      return undefined;
    }
  };

  // freshness() → { maxUpdatedAtMs, rowCount } | undefined  (CTL-1366)
  //   HIT (≥1 row, parseable MAX(updated_at)) → { maxUpdatedAtMs, rowCount }
  //   no db / no rows / null MAX / unparseable / any throw → undefined
  // Fail-open, mirroring lookup(): a freshness failure must NEVER throw out of
  // the scheduler tick — the gauge is simply skipped that tick.
  const freshness = () => {
    try {
      const row = open().prepare(FRESHNESS_SELECT).get();
      if (!row) return undefined;
      const maxUpdatedAtMs = coerceMs(row.maxUpdated);
      if (maxUpdatedAtMs === undefined) return undefined; // empty table / unparseable
      return { maxUpdatedAtMs, rowCount: Number(row.n) || 0 };
    } catch {
      // Drop the handle so a later call re-opens fresh (DB may be re-seeded).
      dropHandle();
      return undefined;
    }
  };

  // titles(identifiers) → { [identifier]: title }  (CTL-1372)
  //   HIT (non-removed row with a non-empty title) → entry in the map.
  //   absent / removed / null-or-empty title → OMITTED (the caller falls through
  //     to its existing title chain — never a fabricated title).
  //   empty input / no db / any throw → {}  (fail-open, mirroring lookup()).
  // Batched + chunked under SQLite's bound-parameter ceiling so a whole board
  // resolves in one (or a few) index-backed reads rather than N per-ticket calls.
  const titles = (identifiers) => {
    if (!Array.isArray(identifiers) || identifiers.length === 0) return {};
    const wanted = [
      ...new Set(identifiers.filter((id) => typeof id === "string" && id.length > 0)),
    ];
    if (wanted.length === 0) return {};
    const out = {};
    try {
      const handle = open();
      for (let i = 0; i < wanted.length; i += TITLES_CHUNK) {
        const slice = wanted.slice(i, i + TITLES_CHUNK);
        const rows = handle.prepare(titlesSelect(slice.length)).all(...slice);
        for (const row of rows) {
          if (
            row &&
            typeof row.identifier === "string" &&
            typeof row.title === "string" &&
            row.title.length > 0
          ) {
            out[row.identifier] = row.title;
          }
        }
      }
      return out;
    } catch {
      // Drop the handle so a later call re-opens fresh (DB may be re-seeded).
      dropHandle();
      return {};
    }
  };

  // eligible(query) → { nodes: [...] } | undefined  (CTL-1397)
  //   A VALID answer is { nodes: [...] } — even { nodes: [] } (a fresh replica
  //   with genuinely zero eligible tickets is a REAL answer, NOT a miss; the
  //   caller must NOT fall through and re-run linearis for it).
  //   undefined = "fall through to linearis" — returned when:
  //     - the query is missing team or status (can't build the filter), OR
  //     - query.project or query.label is set (v1 scope: filtered queries stay
  //       on linearis — the replica filter is team+state only), OR
  //     - the replica file is absent OR STALE by mtime (writer-liveness gate), OR
  //     - any throw (→ dropHandle + undefined).
  //   Fail-open everywhere: this tier can only ACCELERATE; any doubt falls
  //   through to today's linearis behavior, never makes discovery WORSE.
  const eligible = (query) => {
    // Guard: need both filter dimensions, and v1 does NOT serve project/label
    // filtered queries (the SQL filters team+state only — a project/label query
    // would silently over-return, so fall through to linearis instead).
    if (!query || !query.team || !query.status) return undefined;
    if (query.project != null || query.label != null) return undefined;
    // Freshness GATE (writer-liveness proxy) — a stale/absent replica falls
    // through so a dead writer can never freeze discovery on a stale board.
    if (!isReplicaFresh(dbPath)) return undefined;
    try {
      const handle = open();
      // CTL-1397 (P1 fix #2, Codex review) — read the SEED-COMPLETENESS cursor
      // AND the board/relation rows inside ONE deferred read transaction, so the
      // whole answer comes from a single consistent snapshot. As separate
      // autocommit reads (the prior shape), the cursor check and the data SELECTs
      // could straddle a forced re-seed: the writer DELETEs the cursor +
      // TRUNCATEs `issues` + batch-repopulates, so the gate would pass on the
      // pre-reseed cursor, then the SELECTs would observe a partially-repopulated
      // table — the exact partial board the gate exists to reject, which
      // runEligibleQuery would then trust (it serves any non-empty replica
      // result). A deferred read transaction pins one snapshot across the cursor,
      // issues, and relation reads, so within it cursor-present ⟺ a complete seed.
      // bun:sqlite's transaction() defaults to BEGIN DEFERRED (read-only — never
      // attempts a write lock, so it is safe on the readonly handle) and
      // COMMIT/ROLLBACKs automatically; a throw inside rolls back + rethrows into
      // the outer catch → dropHandle + undefined (fail-open). Holds in WAL (prod)
      // and rollback-journal (test fixture) alike.
      const readSnapshot = handle.transaction(() => {
        // SEED-COMPLETENESS gate (see SEED_COMPLETE_SELECT): cursor present = seed
        // complete; absent/empty = mid-reseed → don't serve. Now read in the SAME
        // snapshot as the board below so a re-seed can't slip between the two.
        // undefined here = gate failed → fall through to linearis.
        if (!handle.prepare(SEED_COMPLETE_SELECT).get()) return undefined;
        const rows = handle
          .prepare(ELIGIBLE_SELECT)
          .all(`${query.team}-%`, query.status, ELIGIBLE_LIMIT);
        const fwdStmt = handle.prepare(RELATIONS_FORWARD_SELECT);
        const invStmt = handle.prepare(RELATIONS_INVERSE_SELECT);
        return rows.map((row) => {
          // forward relations this issue owns; linearis's forward `relations`
          // nodes carry `relatedIssue` (live consumers read relatedIssue.identifier).
          const relations = {
            nodes: fwdStmt.all(row.identifier).map((r) => ({
              type: r.type,
              relatedIssue: { identifier: r.related_identifier },
            })),
          };
          // inverse relations (the blocked-by edge the scheduler gates on);
          // linearis's inverseRelations nodes carry `issue` (issue.identifier).
          const inverseRelations = {
            nodes: invStmt.all(row.identifier).map((r) => ({
              type: r.type,
              issue: { identifier: r.issue_identifier },
            })),
          };
          // epoch-ms → ISO-8601 (the scheduler tie-break compares these as the
          // linearis path emits them); uncoercible → null.
          const updMs = coerceMs(row.updated_at);
          const creMs = coerceMs(row.created_at);
          return {
            identifier: row.identifier,
            title: row.title,
            state: row.state,
            priority: row.priority,
            estimate: row.estimate,
            updatedAt: updMs === undefined ? null : new Date(updMs).toISOString(),
            createdAt: creMs === undefined ? null : new Date(creMs).toISOString(),
            project: row.project_name ?? null,
            parent: row.parent_identifier ?? null,
            relations,
            inverseRelations,
            // delegate is already populated by the replica, so the linear-query
            // replica tier skips the GraphQL delegate batch entirely.
            delegate: row.delegate_id != null ? { id: row.delegate_id, name: row.delegate_name ?? null } : null,
          };
        });
      });
      const nodes = readSnapshot();
      // undefined = the seed-completeness gate failed inside the snapshot → fall
      // through to linearis (never serve an empty/partial board on a re-seed).
      return nodes === undefined ? undefined : { nodes };
    } catch {
      // Drop the handle so a later call re-opens fresh (DB may be re-seeded).
      dropHandle();
      return undefined;
    }
  };

  return { lookup, freshness, titles, eligible, close: dropHandle };
}
