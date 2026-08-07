// ticket-discussion-reader.mjs — a ticket's Linear DISCUSSION (comments +
// issue_history activity) read from the local replica (CTL-1574).
//
// The monitor already surfaces a ticket's Linear *metadata* (ticket-detail-reader
// over filter-state.db) and its *narrative* (use-linear-ticket over the cached
// /api/linear-ticket fetch). Neither carries the conversation: who said what, and
// which state/assignee/label transitions happened between the comments. That data
// already exists locally in the CTC replica (`catalyst-replica.db` — the SDK's
// Linear mirror, tables `comments` + `issue_history`), so this reader serves it
// without a single Linear API call.
//
// SHARED DATA LAYER, NOT A REIMPLEMENTATION: the SQL + the id→display-value
// resolution (actor/assignee → user names, label ids → {name,color}, project →
// name, cycle → number, parent → identifier) is the published
// `@catalyst-cloud/read-model` package's `buildIssueDetail`, run UNCHANGED here
// over a bun:sqlite executor. That is the same portability seam catalyst-cloud's
// host-sync daemon uses (ADR-0002); `bunSqlExecutor` below is a local mirror of
// `apps/host-sync/src/read-adapter.ts` in that repo. We subset buildIssueDetail's
// return to {identifier, title, comments, activity} — the rest of the detail view
// is already served by the readers named above.
//
// READ-ONLY + NEVER-THROW: the replica is opened READONLY (the cloud-sync writer
// owns it; WAL keeps this reader non-blocking), and every failure path — absent
// db, locked db, unknown ticket, malformed identifier — returns
// `{ available: false, comments: [], activity: [] }` so the route degrades to an
// honest empty section instead of a 500. `available` distinguishes "the replica
// could not be read" from "this ticket genuinely has no discussion", so the UI
// never claims "no comments" about a source it never reached.

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A Linear issue identifier: TEAMKEY-NUMBER. Validated BEFORE any SQL runs.
// buildIssueDetail binds the identifier as a parameter (no injection surface),
// but rejecting the malformed input up front keeps a junk path segment from
// reaching the DB layer at all, and lets the route answer without opening a
// handle.
const IDENTIFIER_RE = /^[A-Za-z0-9]+-[0-9]+$/;

// The CTC replica path, resolved PER CALL so a process configured via
// CATALYST_DIR (and the tests, which redirect it) is honored. Mirrors
// execution-core/config.mjs::getReplicaDbPath exactly — CATALYST_REPLICA_DB
// wins, else $CATALYST_DIR/catalyst-replica.db, else ~/catalyst/…. Resolving
// this at module load froze the wrong path for CATALYST_DIR-configured nodes
// once before (the CTL-1378 edge in linear-cache-reader.mjs); don't hoist it.
function defaultReplicaDbPath(catalystDir) {
  return (
    process.env.CATALYST_REPLICA_DB ||
    join(catalystDir || process.env.CATALYST_DIR || join(homedir(), "catalyst"), "catalyst-replica.db")
  );
}

// ── Freshness gate (CTL-1574 review) ─────────────────────────────────────────
// Mirrors execution-core/replica-read.mjs isReplicaFresh: the `<db>.writer.lock`
// heartbeat proves the cloud-sync writer is LIVE (the writer touches it every few
// seconds regardless of feed activity — never gate on the db/-wal mtime), and the
// `sync_meta` cursor row proves the seed is COMPLETE (the writer deletes it at
// re-seed start). A stale or mid-reseed replica reads as unavailable — an
// operator must never compose a reply against an outdated conversation that
// renders as current.
const SEED_COMPLETE_SELECT =
  "SELECT 1 FROM sync_meta WHERE key = 'cursor' AND value IS NOT NULL AND value <> '' LIMIT 1";

function isWriterFresh(dbPath) {
  const thresholdMs = Number(process.env.CATALYST_LINEAR_REPLICA_STALE_MS) || 300_000;
  try {
    return Date.now() - statSync(`${dbPath}.writer.lock`).mtimeMs < thresholdMs;
  } catch {
    return false; // no heartbeat file → writer not proven live → unavailable
  }
}

// toEpochMs — normalize a replica timestamp to ms epoch. The replica writers
// have stored both integer epochs and ISO-8601 strings across versions (the
// read-model's linear-cli path accepts either), and this payload's contract is
// numeric — a string leaking through breaks every duration/sort in the UI.
function toEpochMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

// Both specifiers below are COMPUTED, never string literals, and that is
// load-bearing rather than stylistic — the same CTL-883 / CTL-1561 trap
// documented at length in linear-cache-reader.mjs:46-66. `ui/vite.config.ts`
// statically imports server-side .mjs modules and Vite esbuild-bundles that
// config together with its relative import graph; esbuild follows dynamic
// imports too, but ONLY when the argument is a plain string literal. A literal
// `import("bun:sqlite")` reachable from that graph makes Node throw
// ERR_UNSUPPORTED_ESM_URL_SCHEME on the `bun:` scheme and breaks `vite build`
// (the monitor's deploy path). A computed specifier stays an opaque runtime
// `import()` esbuild cannot follow; under Bun it resolves identically.
// This module is not in the vite config graph TODAY, but the breakage would be
// silent-until-deploy the moment anything in that graph reached it.
// DO NOT inline either of these back to a literal.
const BUN_SQLITE_MODULE = ["bun", "sqlite"].join(":");
const READ_MODEL_MODULE = ["@catalyst-cloud", "read-model"].join("/");

// The empty/unavailable answer. A single frozen-shape factory so every failure
// path returns the identical contract (the route JSON-serializes it as-is).
function unavailable() {
  return {
    available: false,
    identifier: null,
    title: null,
    createdAt: null,
    comments: [],
    activity: [],
  };
}

/**
 * Wrap a bun:sqlite `Database` as the read-model's portable `SqlExecutor`.
 *
 * A local mirror of catalyst-cloud's `apps/host-sync/src/read-adapter.ts`
 * (`bunSqlExecutor`), duplicated rather than imported because that adapter lives
 * in an app, not the published package. The read-model emits parameterized SQL +
 * scalar bindings via `exec(query, ...bindings).toArray()`, and bun:sqlite's
 * `db.query(sql).all(...bindings)` is the exact inverse. The `ArrayBuffer` →
 * `Uint8Array` coercion is defensive: the read-model's `SqlValue` union permits
 * ArrayBuffer, though the read builders only ever bind string/number/null.
 */
function bunSqlExecutor(db) {
  return {
    exec: (query, ...bindings) => ({
      toArray: () =>
        db.query(query).all(...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v))),
    }),
  };
}

/**
 * readTicketDiscussion — the route-facing reader. Returns the ticket's Linear
 * comments (oldest-first, by `updated_at`) and its issue_history activity events
 * (oldest-first, by `created_at`), both already resolved to display values by the
 * read-model. The UI interleaves them into one chronological timeline.
 *
 * `dbPath` and `openDb` are injection seams so the unit tests drive this against
 * a temp db (and can force an open failure) without touching the real replica.
 *
 * Returns: { available, identifier, title, comments[], activity[] }
 *   • available:false with empty arrays for EVERY failure — never throws into
 *     the route, never fabricates a comment or an event.
 */
export async function readTicketDiscussion(identifier, { dbPath, openDb, catalystDir } = {}) {
  if (typeof identifier !== "string" || !IDENTIFIER_RE.test(identifier)) return unavailable();
  let db = null;
  try {
    let open = openDb;
    if (!open) {
      const { Database } = await import(BUN_SQLITE_MODULE);
      open = (p) => new Database(p, { readonly: true });
    }
    const { buildIssueDetail } = await import(READ_MODEL_MODULE);
    const path = dbPath ?? defaultReplicaDbPath(catalystDir);
    if (!isWriterFresh(path)) return unavailable();
    db = open(path);
    // A checkpoint/schema lock can transiently SQLITE_BUSY the first query —
    // wait briefly instead of reporting the whole discussion unavailable
    // (same 250ms the linear-thread reader uses). Optional-chained: the test
    // opener seam exposes only query/close.
    try {
      db.run?.("PRAGMA busy_timeout = 250");
    } catch {
      /* pragma unsupported on this handle — proceed without the wait */
    }
    // Seed-completeness gate + ALL detail reads inside ONE deferred read
    // transaction (replica-read.mjs CTL-1397 P1 pattern): as separate autocommit
    // reads, a forced re-seed could slip between the cursor check and
    // buildIssueDetail's SELECTs (writer deletes the cursor + truncates +
    // repopulates) and a half-repopulated discussion would serve as
    // available:true — the exact state the gate exists to reject. bun:sqlite's
    // transaction() defaults to BEGIN DEFERRED (read-only-safe); the test
    // opener seam has no transaction() and runs autocommit, as before.
    // (A missing sync_meta table throws → outer catch → unavailable.)
    const readDetail = () => {
      if (db.query(SEED_COMPLETE_SELECT).all().length === 0) return undefined; // mid-reseed
      return buildIssueDetail(bunSqlExecutor(db), identifier);
    };
    const detail =
      typeof db.transaction === "function" ? db.transaction(readDetail)() : readDetail();
    if (detail === undefined) return unavailable();
    // Unknown / removed ticket → buildIssueDetail returns null. That is a
    // successful read of a ticket with no mirrored row, but we report it as
    // unavailable:false-with-nothing because the UI has nothing honest to show
    // either way, and claiming "no comments" about a ticket we never found would
    // be a fabrication.
    if (!detail) return unavailable();
    return {
      available: true,
      identifier: detail.identifier ?? identifier,
      title: detail.title ?? null,
      // Issue creation instant (ms epoch) — the UI's guard against labeling a
      // late bare history row "created this issue" (CTL-1574 review defect 2).
      createdAt: toEpochMs(detail.created_at),
      // Timestamps normalized to ms epoch (the payload contract is numeric; the
      // replica has stored both integers and ISO strings across writer versions).
      comments: (Array.isArray(detail.comments) ? detail.comments : []).map((c) => ({
        ...c,
        updated_at: toEpochMs(c.updated_at),
        ...(c.created_at != null ? { created_at: toEpochMs(c.created_at) } : {}),
      })),
      activity: (Array.isArray(detail.activity) ? detail.activity : []).map((e) => ({
        ...e,
        created_at: toEpochMs(e.created_at),
      })),
    };
  } catch {
    // Absent db file, locked db, a schema the read-model does not recognize, or a
    // non-Bun runtime with no bun:sqlite — all degrade to the honest empty.
    return unavailable();
  } finally {
    try {
      db?.close();
    } catch {
      /* a close failure on a read-only handle changes nothing we return */
    }
  }
}
