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
function defaultReplicaDbPath() {
  return (
    process.env.CATALYST_REPLICA_DB ||
    join(process.env.CATALYST_DIR || join(homedir(), "catalyst"), "catalyst-replica.db")
  );
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
export async function readTicketDiscussion(identifier, { dbPath, openDb } = {}) {
  if (typeof identifier !== "string" || !IDENTIFIER_RE.test(identifier)) return unavailable();
  let db = null;
  try {
    let open = openDb;
    if (!open) {
      const { Database } = await import(BUN_SQLITE_MODULE);
      open = (p) => new Database(p, { readonly: true });
    }
    const { buildIssueDetail } = await import(READ_MODEL_MODULE);
    db = open(dbPath ?? defaultReplicaDbPath());
    const detail = buildIssueDetail(bunSqlExecutor(db), identifier);
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
      createdAt: typeof detail.created_at === "number" ? detail.created_at : null,
      comments: Array.isArray(detail.comments) ? detail.comments : [],
      activity: Array.isArray(detail.activity) ? detail.activity : [],
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
