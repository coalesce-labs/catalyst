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
// The eligible board-list query, split HEAD/TAIL so D1 (project/label filters)
// can inject extra WHERE clauses before the ORDER BY without a second SELECT.
const ELIGIBLE_SELECT_HEAD = `SELECT i.identifier, i.title, i.state, i.priority, i.estimate, i.updated_at, i.created_at, i.parent_identifier, i.delegate_id, i.delegate_name, p.name AS project_name FROM issues i LEFT JOIN projects p ON p.id = i.project_id WHERE i.identifier LIKE ? AND i.state = ? AND i.removed_at IS NULL`;
const ELIGIBLE_SELECT_TAIL = ` ORDER BY i.updated_at DESC LIMIT ?`;
const ELIGIBLE_LIMIT = 200;

// buildEligibleSelect — assemble the eligible SELECT with optional D1 project/label
// filters. project → `AND p.name = ?` (the LEFT JOIN projects.name already in HEAD);
// label → an EXISTS over issue_labels⋈labels keyed by the issue's own PK id, matching
// the label NAME (issue_labels(issue_id,label_id) + labels(id,name); the identifier→id
// resolution the cloud schema needs). Bind order MUST mirror the appended clauses:
// [likePattern, status, (project?), (label?), LIMIT].
function buildEligibleSelect({ project, label } = {}) {
  let sql = ELIGIBLE_SELECT_HEAD;
  if (project != null) sql += ` AND p.name = ?`;
  if (label != null)
    sql += ` AND EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id = i.id AND l.name = ?)`;
  return sql + ELIGIBLE_SELECT_TAIL;
}

// ownership(id) — the per-ticket claim-gate reader (Stage 0 / A0). One index-backed
// row-read of the assignee + delegate the CTL-1174 gate needs, so the daemon can
// decide human/tool ownership Linear-free. Gated (in ownership() below) by the SAME
// freshness + seed-cursor gate as eligible() — a gate-fail/miss/unreadable returns
// undefined so the caller HOLDs / falls through to the live confirm and NEVER claims
// on unknown. There is deliberately NO per-ticket currency gate here: file mtime
// proves the writer is LIVE, not that THIS ticket's delegate change was applied, so
// a caller must never TRUST a null delegate from the replica — fetchTicketAssignee
// live-confirms every null delegate and trusts only a non-null (actor-set) one,
// matching the gateway path (see linear-query.mjs).
const OWNERSHIP_SELECT = `SELECT assignee_id, delegate_id, delegate_name FROM issues WHERE identifier = ? AND removed_at IS NULL LIMIT 1`;
// Relation enrichment, mirroring normalizeDetail in linear-cli.mjs. forward:
// edges this issue OWNS (relatedIssue is the target); inverse: edges that point
// AT this issue (the blocked-by edge the scheduler gates on).
const RELATIONS_FORWARD_SELECT = `SELECT type, related_identifier FROM relations WHERE issue_identifier = ?`;
const RELATIONS_INVERSE_SELECT = `SELECT type, issue_identifier FROM relations WHERE related_identifier = ?`;

// labels(identifier) SELECTs (CTL-1481 — the worker-label visibility projection's
// replica-backed read). issue_labels keys off the issue's internal PK, not its
// display identifier, so this resolves identifier → id first (same resolution
// buildEligibleSelect's label-EXISTS join needs, just materialized as a row
// instead of tested for existence).
const LABELS_ISSUE_ID_SELECT = `SELECT id FROM issues WHERE identifier = ? AND removed_at IS NULL LIMIT 1`;
// labels.removed_at IS filtered here — a deliberate NEW decision for this
// accessor. No existing SELECT in this file filters labels.removed_at (the
// EXISTS join in buildEligibleSelect only tests `l.name = ?`, tombstone-blind),
// but a caller LISTING a ticket's labels must never see a removed one: a
// tombstoned label name can be recycled/reused by a later live label, so
// surfacing it here would misreport what's actually attached today.
const LABELS_SELECT = `SELECT l.id, l.name FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id = ? AND l.removed_at IS NULL ORDER BY l.name`;

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

// NOTE (Stage 0): there is intentionally NO coarse "currency" guard on ownership().
// An earlier draft gated ownership() on the db/`-wal` mtimes being within a currency
// window, on the theory that a live-but-lagging writer could leave a just-delegated
// ticket reading `delegate=null` locally. But file mtime cannot detect PER-TICKET
// lag: it only proves SOME apply happened recently, not that THIS ticket's change
// was applied — so it gave false confidence in the dangerous direction (a fresh
// mtime with a stale row) while FALSELY tripping in the safe direction (a genuinely
// QUIET-but-current feed reads as "stale" and re-froze the claim gate on the exact
// `-wal`-staleness antipattern CTL-1397 removed — see isReplicaFresh's rationale
// above). The correct instrument lives at the trust boundary instead:
// fetchTicketAssignee live-confirms every NULL delegate and trusts only a NON-NULL
// (actor-set) delegate, so a stale null can never self-delegate + claim, and a quiet
// feed still serves the authoritative non-null case Linear-free.

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
  //     - the replica file is absent OR STALE by mtime (writer-liveness gate), OR
  //     - any throw (→ dropHandle + undefined).
  //   Fail-open everywhere: this tier can only ACCELERATE; any doubt falls
  //   through to today's linearis behavior, never makes discovery WORSE.
  const eligible = (query) => {
    // Guard: need both filter dimensions.
    // D1 (Stage 0): project/label filtered queries ARE now served from the replica
    // (the replica carries projects + issue_labels⋈labels), closing the permanent
    // every-tick fall-through to `linearis issues list` for project/label-scoped
    // teams — buildEligibleSelect appends the matching WHERE clauses below.
    if (!query || !query.team || !query.status) return undefined;
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
        // D1: bind order mirrors buildEligibleSelect's appended clauses —
        // [likePattern, status, (project?), (label?), LIMIT].
        const params = [`${query.team}-%`, query.status];
        if (query.project != null) params.push(query.project);
        if (query.label != null) params.push(query.label);
        params.push(ELIGIBLE_LIMIT);
        const rows = handle
          .prepare(buildEligibleSelect({ project: query.project, label: query.label }))
          .all(...params);
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

  // ownership(id) → { assignee, delegate } | undefined  (Stage 0 / A0, A1)
  //   The per-ticket claim-gate reader: the ticket's current assignee + delegate
  //   UUIDs (each null when unset), read Linear-free from the local replica.
  //   Gated IDENTICALLY to eligible() — writer LIVENESS (isReplicaFresh, on the
  //   `.writer.lock` heartbeat) + the seed-completeness cursor (inside the read
  //   snapshot). ANY gate-fail, a MISS (absent/removed row), or any throw →
  //   undefined, so the caller HOLDs / falls through to the live confirm and NEVER
  //   claims on unknown (L1-1 fail-safe). The per-ticket null-vs-non-null trust
  //   decision lives at the caller (fetchTicketAssignee): a null delegate is always
  //   live-confirmed, a non-null one is trusted — so ownership() needs no currency
  //   gate of its own (see the isReplicaCurrent removal note above).
  //
  //   Gate order:
  //     1. !isReplicaFresh   → undefined            (dead/stale writer)
  //     2. seed cursor absent → undefined            (mid-reseed)
  //     3. no row            → undefined            (absent/removed; MISS)
  //     4. HIT               → { assignee, delegate }
  const ownership = (identifier) => {
    if (!identifier) return undefined;
    // 1. LIVENESS — a dead/stale writer must never serve ownership.
    if (!isReplicaFresh(dbPath)) return undefined;
    try {
      const handle = open();
      // 2+3+4 in ONE deferred read snapshot (same shape as eligible()): the
      // seed-completeness cursor and the ownership row come from one consistent
      // snapshot so a forced re-seed can't slip between the gate and the read.
      const row = handle.transaction(() => {
        if (!handle.prepare(SEED_COMPLETE_SELECT).get()) return undefined; // mid-reseed
        return handle.prepare(OWNERSHIP_SELECT).get(identifier);
      })();
      if (!row) return undefined; // seed-gate fail / absent / removed → MISS (HOLD)
      return { assignee: row.assignee_id ?? null, delegate: row.delegate_id ?? null };
    } catch {
      // Drop the handle so a later call re-opens fresh (DB may be re-seeded).
      dropHandle();
      return undefined;
    }
  };

  // labels(id) → [{ id, name }] | undefined  (CTL-1481 — worker-label visibility
  // projection read). The replica-backed accessor a `worker:<host>` label reader
  // can consult instead of a live linearis label fetch. Gated IDENTICALLY to
  // eligible()/ownership(): writer LIVENESS (isReplicaFresh) + the seed-completeness
  // cursor, both resolved inside one deferred read snapshot. ANY gate-fail, a MISS
  // (absent/removed issue), or any throw → undefined — the caller falls through to
  // a live read, never trusts a stale/partial label list.
  //
  //   HIT (issue exists, ≥1 live label attached) → [{id, name}, ...], sorted by name.
  //   HIT (issue exists, zero labels attached)    → [] — a DEFINED, authoritative
  //     empty answer (not a miss); the caller must NOT treat it as "unknown".
  //   MISS/gate-fail/throw                        → undefined.
  //
  //   Gate order:
  //     1. !isReplicaFresh    → undefined  (dead/stale writer)
  //     2. seed cursor absent → undefined  (mid-reseed)
  //     3. no issue row       → undefined  (absent/removed; MISS)
  //     4. HIT                → [{id, name}] (possibly empty)
  const labels = (identifier) => {
    if (!identifier) return undefined;
    // 1. LIVENESS — a dead/stale writer must never serve a label list.
    if (!isReplicaFresh(dbPath)) return undefined;
    try {
      const handle = open();
      // 2+3+4 in ONE deferred read snapshot (same shape as ownership()): the
      // seed-completeness cursor, the identifier→id resolution, and the label
      // rows come from one consistent snapshot so a forced re-seed can't slip
      // between the gate and the reads.
      const rows = handle.transaction(() => {
        if (!handle.prepare(SEED_COMPLETE_SELECT).get()) return undefined; // mid-reseed
        const issue = handle.prepare(LABELS_ISSUE_ID_SELECT).get(identifier);
        if (!issue) return undefined; // absent/removed → MISS
        return handle.prepare(LABELS_SELECT).all(issue.id);
      })();
      if (!rows) return undefined; // seed-gate fail / absent / removed → MISS
      return rows.map((row) => ({ id: row.id, name: row.name }));
    } catch {
      // Drop the handle so a later call re-opens fresh (DB may be re-seeded).
      dropHandle();
      return undefined;
    }
  };

  return { lookup, freshness, titles, eligible, ownership, labels, close: dropHandle };
}
