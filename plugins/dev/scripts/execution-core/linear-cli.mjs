// linear-cli.mjs — CTL-1391: the `catalyst-linear` driver. The agent-facing
// REPLICA-FIRST Linear read command. Lets any agent (autonomous worker or
// interactive coding session) read Linear from the local Catalyst-Cloud SDK
// replica when one is present + fresh, and fall back to a direct `linearis`
// read otherwise — the executable half of the "Reading Linear" rule the
// `linearis` skill documents.
//
// CONTRACT
// --------
//   catalyst-linear read <ID>        single-issue detail   (replica-first)
//   catalyst-linear list [flags]     issue list            (linearis passthrough, v1)
//   catalyst-linear search <q> [..]  issue search          (linearis passthrough, v1)
//   <any write verb>                 REJECTED — replica is read-only; use linearis
//
// Output is JSON shaped to MATCH `linearis` so existing jq pipelines + skills are
// drop-in, plus an additive top-level `_meta` carrying the read source + replica
// freshness (the evidence-for-escalation signal). The CLI needs NO cloud token —
// it reads the local replica file; a separate supervised writer keeps it current.
//
// NODE-SAFE LOADABILITY (load-bearing): the replica path imports `bun:sqlite` +
// `@catalyst-cloud/read-model` (a `.ts` source-export). Those are bun-only — a
// STATIC import would make this whole module fail to load under node, killing the
// linearis-fallback and write-rejection paths. So every replica-side import is a
// guarded `await import(...)`; on node (or any import failure) we degrade to the
// linearis path. The fallback + write-rejection paths use only node built-ins.
//
// MODE: replica reads are OPT-IN. `CATALYST_LINEAR_REPLICA` (env) or Layer-2
// `catalyst.linearReplica.mode`; default OFF. A present/fresh file does not
// auto-enable — an operator must opt in (mirrors config.mjs readLinearReplica).
import { existsSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WRITE_VERBS = new Set([
  "create", "update", "move", "comment", "estimate", "label", "delete", "assign",
]);
const DEFAULT_STALE_MS = 300_000; // 5 min — generous; the push feed keeps the replica sub-second in normal operation.

// ── config seam (inlined, node-safe — deliberately NOT importing config.mjs so a
//    transitive bun-only import there can never break node load on the fallback path) ──
function catalystDir() {
  return process.env.CATALYST_DIR || resolve(homedir(), "catalyst");
}
function getReplicaDbPath() {
  return process.env.CATALYST_REPLICA_DB || resolve(catalystDir(), "catalyst-replica.db");
}
function staleThresholdMs() {
  const n = Number(process.env.CATALYST_LINEAR_REPLICA_STALE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_MS;
}
// env wins: "on"/"1" → on; "0"/"off"/any-other-nonempty → off; unset → Layer-2
// catalyst.linearReplica.mode ("on" only); default off. (Same precedence as
// config.mjs readLinearReplica, reimplemented inline + node-safe.)
export function resolveReplicaMode(env = process.env, cfgPathOverride) {
  const raw = env.CATALYST_LINEAR_REPLICA;
  if (raw != null && raw !== "") {
    return raw === "on" || raw === "1" ? "on" : "off";
  }
  try {
    const home = env.HOME || homedir();
    // Honor CATALYST_LAYER2_CONFIG_FILE for parity with config.mjs's
    // getLayer2ConfigPath() — a node launched with a non-default Layer-2 path
    // must resolve linearReplica.mode from THAT file, not the hardcoded default.
    const cfgPath =
      cfgPathOverride ||
      env.CATALYST_LAYER2_CONFIG_FILE ||
      resolve(home, ".config", "catalyst", "config.json");
    if (!existsSync(cfgPath)) return "off";
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    return cfg?.catalyst?.linearReplica?.mode === "on" ? "on" : "off";
  } catch {
    return "off"; // unreadable/malformed config never enables the replica
  }
}

// ── arg parsing: `<cmd> [positional] [--flag value | --flag=value]` ──
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) flags[body.slice(0, eq)] = body.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[body] = argv[++i];
      else flags[body] = "true";
    } else {
      positionals.push(a);
    }
  }
  return { cmd: positionals[0], positionals: positionals.slice(1), flags };
}

// ── replica executor adapter (inlined; never import host-sync — different workspace) ──
function bunSqlExecutor(db) {
  return {
    exec: (query, ...bindings) => ({
      toArray: () =>
        db.query(query).all(...bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v))),
    }),
  };
}

// Coerce a replica cell to epoch-ms — integer epoch-ms (the change-feed shape) OR
// an ISO-8601 string. Anything else → undefined (caller fails open).
function coerceMs(v) {
  if (v == null) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const p = Date.parse(String(v));
  return Number.isFinite(p) ? p : undefined;
}

// Newest mirror timestamp + row count — observability + a per-read sanity check
// that the DB has rows. (The freshness GATE is the file mtime — see openFreshReplica.)
function probeFreshness(db) {
  try {
    const row = db.query("SELECT MAX(updated_at) AS maxUpdated, COUNT(*) AS n FROM issues").get();
    if (!row) return undefined;
    const ms = coerceMs(row.maxUpdated);
    return { maxUpdatedAtMs: ms, rowCount: Number(row.n) || 0 };
  } catch {
    return undefined;
  }
}

// ── read-source resolver. Returns an open replica handle when mode=on AND a
//    fresh replica file is usable, else null (→ caller uses linearis). FAIL-OPEN:
//    any doubt returns null so a read can never be wrong, only un-accelerated. ──
async function openFreshReplica() {
  const mode = resolveReplicaMode();
  if (mode === "off") return { skip: "mode-off" };
  const dbPath = getReplicaDbPath();
  if (!existsSync(dbPath)) return { skip: "replica-absent" };

  // Freshness GATE = file mtime (writer-liveness proxy): a dead writer stops
  // touching the file → stale mtime → fall back to live. A live writer on the
  // push feed touches it as deltas land. A truly-quiet-but-alive feed may
  // false-stale → linearis (correct answer, just un-cached) — fail-safe by design.
  let mtimeAgeMs;
  try {
    // WAL mode: the writer's appends land in the `-wal` sidecar; the main DB file's
    // mtime only advances on checkpoint. Take the freshest of the DB + its `-wal`.
    //
    // Spoof-resistance (Codex P2): a read-only consumer that merely OPENS a
    // checkpointed DB can create fresh, EMPTY `-wal`/`-shm` sidecars, which would
    // make a long-dead replica look fresh. So we (a) drop `-shm` entirely — it is a
    // reader-touched shared-memory index, never a writer-liveness signal — and (b)
    // only trust `-wal` when it is NON-EMPTY: a writer's active WAL carries frames,
    // while a reader artifact is zero-length. Right after a checkpoint+truncate the
    // WAL is briefly empty, but the checkpoint just WROTE the main DB file, so its
    // mtime is fresh in that window — no false-stale.
    let newest = statSync(dbPath).mtimeMs;
    try {
      const wal = statSync(dbPath + "-wal");
      if (wal.size > 0) newest = Math.max(newest, wal.mtimeMs);
    } catch { /* -wal absent → main DB mtime only */ }
    mtimeAgeMs = Date.now() - newest;
  } catch {
    return { skip: "stat-failed" };
  }
  if (mtimeAgeMs > staleThresholdMs()) return { skip: "stale", mtimeAgeMs };

  let Database, build;
  try {
    ({ Database } = await import("bun:sqlite"));
  } catch {
    return { skip: "no-bun-sqlite" }; // node (no bun) → linearis
  }
  try {
    build = await import("@catalyst-cloud/read-model");
  } catch {
    return { skip: "no-read-model" }; // bun host but read-model not resolvable → linearis
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    db.run("PRAGMA busy_timeout = 250");
  } catch {
    return { skip: "open-failed" };
  }
  const fresh = probeFreshness(db);
  if (!fresh || fresh.maxUpdatedAtMs === undefined) {
    db.close();
    return { skip: "freshness-undefined" };
  }
  return { db, sql: bunSqlExecutor(db), build, fresh, mtimeAgeMs };
}

// ── linearis fallback (direct read; input:"" == `</dev/null` so it never blocks on stdin) ──
function flagPairs(flags) {
  const out = [];
  for (const [k, v] of Object.entries(flags)) {
    if (k === "help") continue;
    out.push(`--${k}`);
    if (v !== "true") out.push(v);
  }
  return out;
}
// Throws a tagged error on failure (NOT process.exit — that would be untestable
// and kill any embedding process); main() catches `_linearis` and returns code 1.
//
// timeoutMs: the single-ticket `read` fallback caps a 429-stalled / hung linearis so
// the hot read can never block indefinitely (mirrors linear-query.mjs's
// CTL-1339/CTL-1364 8s cap); on timeout we fail safe → exit 1. Pass `timeoutMs: 0`
// (or any non-positive value) to leave the call UNCAPPED — the `list`/`search`
// passthrough must match direct `linearis`, where a broad `--limit 200` page or an
// expensive search legitimately exceeds 8s and must not be SIGKILLed into a failure.
function runLinearis(args, { timeoutMs } = {}) {
  // env: process.env is explicit (not just inherited) so the CURRENT PATH resolves
  // `linearis` — bun's spawnSync snapshots PATH for bare-command lookup otherwise.
  const cap =
    timeoutMs === undefined ? Number(process.env.CATALYST_LINEARIS_TIMEOUT_MS) || 8_000 : timeoutMs;
  const opts = {
    input: "",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
    killSignal: "SIGKILL",
  };
  if (cap > 0) opts.timeout = cap; // uncapped when cap <= 0 (list/search passthrough)
  const r = spawnSync("linearis", args, opts);
  const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL" || r.signal === "SIGTERM";
  if (r.error || r.status !== 0) {
    throw Object.assign(new Error(`linearis ${args.join(" ")} failed`), {
      _linearis: {
        error: `linearis ${args.join(" ")} failed`,
        status: r.status ?? null,
        timedOut,
        // Defense-in-depth: redact any Linear token shape from linearis's own stderr
        // before it lands in our error envelope (the replica/CLI never handles tokens,
        // but linearis carries LINEAR_API_TOKEN — never echo one through us).
        detail: (r.stderr || r.error?.message || "")
          .replace(/\blin_(?:api|oauth)_[A-Za-z0-9_-]+/g, "lin_***")
          .slice(0, 500),
      },
    });
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw Object.assign(new Error("linearis output was not valid JSON"), {
      _linearis: { error: "linearis output was not valid JSON" },
    });
  }
}

// ── normalizer: read-model IssueDetailView (snake_case) → the `linearis issues
//    read` object shape, so a consumer can't tell which backend served the read.
//    `sql` is passed for the two parity completions (inverseRelations, branchName)
//    the detail view does not carry. ──
function isoOrNull(v) {
  const ms = coerceMs(v);
  return ms === undefined ? null : new Date(ms).toISOString();
}
export function normalizeDetail(view, sql) {
  const id = view.identifier;
  // inverseRelations: who points AT this issue (the blocked-by edge the scheduler
  // gates on). Emitting [] here would be a silent correctness bug, so query it.
  let inverse = [];
  try {
    inverse = sql
      .exec("SELECT type, issue_identifier FROM relations WHERE related_identifier = ?", id)
      .toArray()
      // linearis's inverseRelations nodes use `issue` (forward `relations` use `relatedIssue`);
      // live consumers read inverseRelations.nodes[].issue.identifier (scheduler / eligible-set / beliefs).
      .map((r) => ({ type: r.type, issue: { identifier: r.issue_identifier } }));
  } catch { /* fail open — empty inverse rather than throw */ }
  // branchName: not in the detail view; one cheap lookup (issues carries removed_at).
  let branchName = null;
  try {
    const row = sql
      .exec("SELECT branch_name FROM issues WHERE identifier = ? AND removed_at IS NULL LIMIT 1", id)
      .toArray()[0];
    branchName = row?.branch_name ?? null;
  } catch { /* fail open */ }

  return {
    id: view.id,
    identifier: view.identifier,
    title: view.title,
    description: view.description ?? null,
    priority: view.priority ?? null,
    estimate: view.estimate ?? null,
    // dueDate: pass the YYYY-MM-DD string THROUGH — never Date.parse (a date-only
    // string would shift across timezones).
    dueDate: view.due_date ?? null,
    createdAt: isoOrNull(view.created_at),
    updatedAt: isoOrNull(view.updated_at),
    url: view.url ?? null,
    state: { name: view.state ?? null }, // no states table in the replica → no state.id
    assignee:
      view.assignee_id != null
        ? { id: view.assignee_id, name: view.assignee_name ?? view.assignee ?? null }
        : null,
    team: { id: view.team_id ?? null }, // no teams table → key/name absent (known gap)
    project: view.project_id != null ? { id: view.project_id, name: view.project_name ?? null } : null,
    cycle:
      view.cycle_id != null ? { id: view.cycle_id, name: null, number: view.cycle_number ?? null } : null,
    parent:
      view.parent_id != null
        ? { id: view.parent_id, identifier: view.parent_identifier ?? null, title: null }
        : null,
    // KNOWN GAPS (the replica schema lacks these; documented for drop-in callers):
    //   children.nodes — no children table in the replica → always []
    //   relations/inverseRelations nodes[].id + .issue/.relatedIssue.id — relations table has no UUID columns
    //   state.id, team.key/name, parent.title, cycle.name — no states/teams tables → not carried
    children: { nodes: [] },
    projectMilestone: null,
    labels: { nodes: (view.labels ?? []).map((l) => ({ id: l.id, name: l.name })) },
    relations: {
      nodes: (view.relations ?? []).map((r) => ({
        type: r.type,
        relatedIssue: { identifier: r.related_identifier },
      })),
    },
    inverseRelations: { nodes: inverse },
    comments: { nodes: (view.comments ?? []).map((c) => ({ id: c.id, body: c.body })) },
    branchName,
  };
}

// ── output ──
function emit(payload, meta) {
  process.stdout.write(JSON.stringify({ ...payload, _meta: meta }) + "\n");
}
function warnFallback(reason, id) {
  // Only warn when the operator OPTED IN (mode=on) but the replica didn't serve —
  // that is the surfacing signal. On a standard node (mode off) this is silent.
  if (resolveReplicaMode() !== "on") return;
  process.stderr.write(
    `[catalyst-linear] replica did not serve ${id ?? ""} (${reason}) — fell back to linearis\n`,
  );
}
function rejectWrite(verb) {
  process.stderr.write(
    JSON.stringify({
      error: `catalyst-linear is read-only — use: linearis issues ${verb} ...`,
      hint: "Writes always go through linearis; the Catalyst Cloud replica is read-only.",
    }) + "\n",
  );
  return 1;
}

function metaFor(source, replica, extra = {}) {
  const m = { source, replica_mode: resolveReplicaMode(), ...extra };
  if (replica?.fresh) {
    m.replica_staleness_ms =
      replica.fresh.maxUpdatedAtMs != null ? Date.now() - replica.fresh.maxUpdatedAtMs : null;
    m.replica_row_count = replica.fresh.rowCount;
    if (replica.mtimeAgeMs != null) m.replica_mtime_age_ms = replica.mtimeAgeMs;
  }
  return m;
}

// ── command handlers ──
async function cmdRead(id, replica, flags = {}) {
  if (!id) {
    process.stderr.write(JSON.stringify({ error: "read: missing <ID> (e.g. catalyst-linear read CTL-1)" }) + "\n");
    return 2;
  }
  // Preserve caller-passed `linearis issues read` flags (e.g. --with-attachments,
  // used by phase-research to fetch linked plan references). The replica serves only
  // the flagless normalized detail shape, so a flagged read CANNOT be honored by the
  // replica without silently returning a different, incomplete payload. When any read
  // flag is present we bypass the replica and passthrough to linearis so the caller
  // gets the EXACT requested payload (parity > acceleration).
  const flagArgs = flagPairs(flags);
  const readArgs = ["issues", "read", id, ...flagArgs];
  if (flagArgs.length > 0) {
    if (replica?.db) { try { replica.db.close(); } catch { /* already closed */ } }
    warnFallback("read-flags", id);
    emit(runLinearis(readArgs), metaFor("linearis", null, { replica_skip: "read-flags" }));
    return 0;
  }
  if (replica?.db) {
    let view = null;
    let threw = false;
    try {
      view = replica.build.buildIssueDetail(replica.sql, id);
    } catch {
      threw = true; // read-model error (schema mismatch / missing table) — distinct from a clean miss
    }
    if (view) {
      const payload = normalizeDetail(view, replica.sql);
      replica.db.close();
      emit(payload, metaFor("replica", replica));
      return 0;
    }
    // Absent id (miss) OR read-model threw (exception) → live read, with a DISTINCT
    // _meta.source so monitoring can tell a clean cache-miss from a broken replica.
    replica.db.close();
    warnFallback(threw ? "replica-exception" : "miss", id);
    emit(runLinearis(readArgs), metaFor(threw ? "linearis_exception" : "linearis_miss", replica));
    return 0;
  }
  // No usable replica: linearis is the direct path. warn only if the operator opted in.
  warnFallback(replica?.skip ?? "replica-absent", id);
  emit(runLinearis(readArgs), metaFor("linearis", null, { replica_skip: replica?.skip ?? null }));
  return 0;
}

// list/search are v1 LINEARIS PASSTHROUGH — the replica-backed list view requires
// a full-shape bulk query + pagination parity (tracked as a follow-up). Passthrough
// preserves linearis's exact shape and just annotates _meta, so they are correct
// today on every node; they simply aren't replica-accelerated yet.
function cmdList(flags) {
  // timeoutMs: 0 — uncapped, matching direct `linearis issues list` (broad pages can exceed 8s).
  emit(runLinearis(["issues", "list", ...flagPairs(flags)], { timeoutMs: 0 }), metaFor("linearis", null, { list_replica: "pending" }));
  return 0;
}
function cmdSearch(query, flags) {
  if (!query) {
    process.stderr.write(JSON.stringify({ error: 'search: missing <query> (e.g. catalyst-linear search "auth bug")' }) + "\n");
    return 2;
  }
  // timeoutMs: 0 — uncapped, matching direct `linearis issues search` (expensive searches can exceed 8s).
  emit(runLinearis(["issues", "search", query, ...flagPairs(flags)], { timeoutMs: 0 }), metaFor("linearis", null, { search_replica: "pending" }));
  return 0;
}

const USAGE = `catalyst-linear — replica-first Linear READ (falls back to linearis)

Usage:
  catalyst-linear read <ID>           Single-issue detail (replica-first; linearis fallback).
  catalyst-linear list [flags]        Issue list (linearis passthrough today).
  catalyst-linear search <q> [flags]  Issue search (linearis passthrough today).

Reads only. WRITES (create/update/move/comment/estimate/label/delete/assign) are
rejected — the replica is read-only; use \`linearis\` for writes.

Output matches \`linearis\` JSON + an additive \`_meta\` {source, replica_mode,
replica_staleness_ms, ...}. The replica is used only when opted in
(CATALYST_LINEAR_REPLICA=on or Layer-2 catalyst.linearReplica.mode) AND a fresh
local replica is present; otherwise reads go directly to linearis.`;

export async function main(argv) {
  const { cmd, positionals, flags } = parseArgs(argv);

  if (cmd == null || cmd === "help" || flags.help === "true") {
    process.stdout.write(USAGE + "\n");
    return cmd == null && flags.help !== "true" ? 1 : 0;
  }
  // Write verbs rejected FIRST — before opening anything (node-safe path).
  if (WRITE_VERBS.has(cmd)) return rejectWrite(cmd);

  if (cmd !== "read" && cmd !== "list" && cmd !== "search") {
    process.stderr.write(`error: unknown command ${JSON.stringify(cmd)}\n\n${USAGE}\n`);
    return 2;
  }

  // Only `read` consults the replica; list/search are linearis passthrough (v1), so
  // they never pay the open. The single try/catch maps a linearis failure (tagged
  // _linearis) → stderr envelope + exit 1 for every command.
  let replica = null;
  try {
    if (cmd === "read") {
      replica = await openFreshReplica();
      return await cmdRead(positionals[0], replica, flags);
    }
    if (cmd === "list") return cmdList(flags);
    return cmdSearch(positionals[0], flags);
  } catch (err) {
    // A linearis failure → stderr envelope + exit 1 (no stdout written, so a caller
    // never sees a half-emitted payload).
    if (err && err._linearis) {
      process.stderr.write(JSON.stringify(err._linearis) + "\n");
      return 1;
    }
    throw err;
  } finally {
    // Defensive: ensure the handle is closed if a read handler returned without closing.
    try { if (replica?.db) replica.db.close(); } catch { /* already closed */ }
  }
}

// Entrypoint guard: run only when invoked directly (not when imported by a test).
const isMain =
  import.meta.main === true ||
  (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]));
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code ?? 0; })
    .catch((err) => {
      process.stderr.write(JSON.stringify({ error: "catalyst-linear fatal", detail: String(err?.message ?? err) }) + "\n");
      process.exitCode = 1;
    });
}
