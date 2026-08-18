// linear-write-proxy-resolve.mjs — CTL-1889 increment 1.
//
// The CTC-509 write routes speak Linear UUIDs, not the vocabulary the daemon
// carries. `POST /agent/issue-state` wants `{issueId, stateId}`; `/agent/issue-label`
// wants `{issueId, labelIds[]}`. The daemon holds a ticket IDENTIFIER ("CTL-1889"), a
// transition KEY ("inProgress") and a label NAME ("needs-human"). This module is the
// one place those become ids.
//
// ── ⛔ THIS RESOLVER FAILS CLOSED. THAT IS THE WHOLE POINT. ──
// Every other replica reader in this tree (replica-read.mjs's `lookup`, `titles`,
// `estimates`) is deliberately FAIL-OPEN: a miss returns undefined and the caller
// falls through to a live Linear read. Copying that posture here would be a defect,
// not a convenience — on the WRITE path "fall through to live" means "write to Linear
// with this host's own app-actor", which is the exact thing CTL-1889 retires. So every
// miss, ambiguity, malformed row and thrown error returns `{ok:false, reason:<named>}`
// and the caller REFUSES the write. A resolver that cannot fail is not a resolver.
//
// ── WHY THE REPLICA AND NOT LINEAR ──
// AGENTS.md's read rule: single-ticket reads go to the local replica, never a live
// `linearis` call against the shared fleet quota. Every id this module needs is already
// replicated (`issues.id`/`team_id`, `workflow_states.id`, `labels.id`), so resolution
// costs no API budget and works while Linear is rate-limited.
//
// ── ⛔ AND THEREFORE BEHIND THE SAME FRESHNESS GATE THE READ PATH USES ──
// "Read the replica" is only half the rule; the other half is the gate, and an ungated
// read is the failure this repo has already shipped once. Two conditions, matching
// `lib/linear-read-replica.sh`'s `replica_fresh` exactly:
//   1. the writer heartbeat (`<db>.writer.lock` mtime) is younger than
//      CATALYST_LINEAR_REPLICA_STALE_MS — a DEAD writer leaves a database full of rows
//      that look perfectly healthy, so an ungated read is a stale read that cannot
//      announce itself; and
//   2. `sync_meta.cursor` is non-empty — proof the seed is COMPLETE and not mid-reseed.
// (2) is asked inside the SAME read transaction as the resolution query, because during
// a cold reseed the entity tables repopulate in batches: a duplicated label can look
// unique while only one copy has been restored, and `label-ambiguous` — the guard that
// stops us sending the wrong UUID — is exactly a row-COUNT judgement. A gate checked
// outside the transaction can pass and be falsified before the count is taken.
// Where the bash gate falls back to `linearis`, this one REFUSES: see the fail-closed
// rule above. `replica-stale` and `replica-reseeding` are named separately from
// `replica-unreadable` so an operator can tell "the writer is dead" from "the file is
// broken" from "the ticket is not there".
//
// ── ⚠️ LABEL NAMES ARE NOT UNIQUE WORKSPACE-WIDE ──
// Measured on the live replica: `types`, `schema`, `mobile`, `infra`, `etl`, `dbt` and
// `api` each resolve to FOUR label rows (same name, different teams) — `labels` carries
// no team_id to disambiguate with. The four labels this increment actually writes
// (`needs-human`, `needs-input`, `blocked`, `queued` — the CTL-1481 worker-status group)
// are each unique TODAY (measured n=1), but a resolver that relies on that is one new
// team-scoped label away from applying another team's label to a ticket. So an
// ambiguous name is REFUSED by name (`label-ambiguous`), never resolved to a first hit.

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { getReplicaDbPath } from "./config.mjs";

/**
 * Writer-heartbeat staleness ceiling, same knob and same default (300 s) as
 * `lib/linear-read-replica.sh`'s `replica_fresh`. One contract, two languages — a
 * resolver that trusted the replica for longer than the read path does would be a second,
 * looser answer to "is this database safe to read".
 */
export const DEFAULT_REPLICA_STALE_MS = 300_000;

function staleCeilingMs(env = process.env) {
  const raw = Number(env?.CATALYST_LINEAR_REPLICA_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REPLICA_STALE_MS;
}

/** A resolution failure, always NAMED — a bare null is not a diagnosis. */
function miss(reason, detail = null) {
  return detail === null ? { ok: false, reason } : { ok: false, reason, detail };
}

const ISSUE_SELECT = `
  SELECT id, team_id FROM issues
  WHERE identifier = ? AND removed_at IS NULL
  LIMIT 2
`;

const STATE_SELECT = `
  SELECT id FROM workflow_states
  WHERE team_id = ? AND name = ? AND archived_at IS NULL
  LIMIT 2
`;

const LABEL_SELECT = `
  SELECT id FROM labels
  WHERE name = ? AND removed_at IS NULL
  LIMIT 2
`;

// CTL-1933 — is this label currently ON this issue? The join table is keyed
// (issue_id, label_id), so this is one indexed primary-key lookup against ids the
// caller has ALREADY resolved on the same path — not a second resolution chain.
const ISSUE_LABEL_SELECT = `
  SELECT 1 AS present FROM issue_labels
  WHERE issue_id = ? AND label_id = ?
  LIMIT 1
`;

/**
 * createProxyResolver — identifier/name → Linear UUID, off the local replica.
 *
 * The handle is opened lazily and DROPPED on any throw, so a later call re-opens
 * against a database the replica writer may have re-seeded or migrated underneath us
 * (same handle discipline as replica-read.mjs — only the verdict differs).
 */
export function createProxyResolver({ dbPath = null, env = process.env, now = Date.now } = {}) {
  let db = null;
  const resolvedPath = () => dbPath ?? getReplicaDbPath();

  const open = () => {
    if (db) return db;
    db = new Database(resolvedPath(), { readonly: true });
    db.run("PRAGMA busy_timeout = 250");
    return db;
  };

  /**
   * writerAlive — the writer heartbeat half of the freshness gate.
   *
   * A dead writer leaves a database full of rows that LOOK fine, so an ungated read is a
   * stale read that cannot announce itself. Same lock file and same ceiling as
   * `replica_fresh`. Filesystem state, so it cannot live inside the SQLite transaction —
   * but it is a LIVENESS question, not a consistency one, and the consistency half below
   * is transactional.
   */
  const writerAlive = () => {
    try {
      const ageMs = now() - statSync(`${resolvedPath()}.writer.lock`).mtimeMs;
      return ageMs <= staleCeilingMs(env);
    } catch {
      return false; // absent lock = no writer = not safe to resolve a WRITE from
    }
  };

  const drop = () => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    db = null;
  };

  /**
   * one — run a `LIMIT 2` select and demand EXACTLY one row.
   *
   * The `LIMIT 2` is deliberate: it is what lets ambiguity be DETECTED rather than
   * silently resolved to whichever row the query planner returned first. Zero rows and
   * two rows are different failures and are named differently.
   */
  const one = (sql, params, { absent, ambiguous }) => {
    // ⛔ GATE FIRST — see the module header's freshness section. A dead writer is a
    // filesystem fact, so it is checked before the transaction opens.
    if (!writerAlive()) return miss("replica-stale");

    let rows;
    let seeded;
    try {
      const handle = open();
      // ⛔ SEED-COMPLETENESS AND THE RESOLUTION READ SHARE ONE SNAPSHOT (Codex P1 on
      // #3489). During a cold reseed the writer clears `sync_meta.cursor` and repopulates
      // the entity tables in batches, so a partly-restored table can make a DUPLICATED
      // label look unique — and `label-ambiguous`, the guard that stops us sending the
      // wrong UUID, is precisely a row-COUNT judgement. Checking the cursor outside the
      // transaction would leave the window where the gate passes and the reseed lands
      // before the count is taken. In WAL mode a read transaction pins one snapshot, so
      // asking both questions inside it means the cursor we trusted and the rows we
      // counted are the same instant of the database.
      handle.run("BEGIN");
      try {
        seeded = handle
          .prepare("SELECT 1 AS ok FROM sync_meta WHERE key='cursor' AND value<>'' LIMIT 1")
          .get();
        rows = seeded ? handle.prepare(sql).all(...params) : null;
      } finally {
        handle.run("COMMIT");
      }
    } catch (err) {
      drop();
      return miss("replica-unreadable", String(err?.message ?? err).slice(0, 200));
    }
    if (!seeded) return miss("replica-reseeding");
    if (!Array.isArray(rows) || rows.length === 0) return miss(absent);
    if (rows.length > 1) return miss(ambiguous);
    return { ok: true, row: rows[0] };
  };

  return {
    /**
     * issue(identifier) → {ok:true, issueId, teamId} | {ok:false, reason}
     * `teamId` comes back because state resolution is team-scoped and re-reading the
     * issue to get it would be a second query for a value this one already has.
     */
    issue(identifier) {
      if (typeof identifier !== "string" || identifier.trim() === "") {
        return miss("issue-identifier-invalid");
      }
      const r = one(ISSUE_SELECT, [identifier.trim()], {
        absent: "issue-not-in-replica",
        ambiguous: "issue-ambiguous",
      });
      if (!r.ok) return r;
      const issueId = r.row?.id;
      const teamId = r.row?.team_id;
      if (typeof issueId !== "string" || issueId === "") return miss("issue-id-missing");
      if (typeof teamId !== "string" || teamId === "") return miss("issue-team-missing");
      return { ok: true, issueId, teamId };
    },

    /** stateId(teamId, stateName) → {ok:true, stateId} | {ok:false, reason} */
    stateId(teamId, stateName) {
      if (typeof teamId !== "string" || teamId === "") return miss("state-team-invalid");
      if (typeof stateName !== "string" || stateName.trim() === "") {
        return miss("state-name-invalid");
      }
      const r = one(STATE_SELECT, [teamId, stateName.trim()], {
        absent: "state-not-in-replica",
        ambiguous: "state-ambiguous",
      });
      if (!r.ok) return r;
      const stateId = r.row?.id;
      if (typeof stateId !== "string" || stateId === "") return miss("state-id-missing");
      return { ok: true, stateId };
    },

    /**
     * labelIds(names) → {ok:true, labelIds} | {ok:false, reason, detail}
     * ALL-OR-NOTHING: one unresolvable name refuses the whole batch. A partial batch
     * would apply some of the caller's labels and silently drop the rest, which reads
     * as success at every call site.
     */
    labelIds(names) {
      if (!Array.isArray(names) || names.length === 0) return miss("label-names-empty");
      const out = [];
      for (const name of names) {
        if (typeof name !== "string" || name.trim() === "") return miss("label-name-invalid");
        const r = one(LABEL_SELECT, [name.trim()], {
          absent: "label-not-in-replica",
          ambiguous: "label-ambiguous",
        });
        if (!r.ok) return { ...r, detail: r.detail ?? name };
        const id = r.row?.id;
        if (typeof id !== "string" || id === "") return miss("label-id-missing", name);
        out.push(id);
      }
      return { ok: true, labelIds: out };
    },

    /**
     * hasLabel(issueId, labelId) → {ok:true, present:boolean} | {ok:false, reason}
     *
     * CTL-1933. The cloud's label `remove` is NOT idempotent — measured against the live
     * mirror on 2026-08-17 with the control firing first: `add` on an absent label 200s,
     * `remove` on a PRESENT label 200s, and `remove` on an ABSENT label returns
     * **400 `{"outcome":"failed"}`**. CTL-1889 inc 1 assumed the opposite in a code
     * comment and shipped it, so every already-absent clear on an enforce host burned
     * three cloud calls and then a CTL-1078 back-off, while reporting the label still
     * attached when Linear said it was gone.
     *
     * ⛔ THE ANSWER IS THREE-VALUED AND ONLY ONE VALUE MAY SUPPRESS A WRITE. A caller
     * may skip the removal on `{ok:true, present:false}` and on nothing else. Every
     * inability to answer — dead writer, mid-reseed, unreadable database, a throwing
     * query — comes back `{ok:false}` so the caller SENDS. Sending an unnecessary
     * removal costs one 400; silently skipping a real one re-creates the permanent
     * `needs-human` park that CTL-1889's own P1 existed to fix. The doubt has to fall
     * on the side of doing the work.
     *
     * Runs through the same `one`-style gate as every resolver above, so the freshness
     * check and the presence read share ONE snapshot: a mid-reseed `issue_labels` can be
     * legitimately empty, which would read as "already absent" and suppress a real
     * removal — the same class of trap the seed check was added for.
     */
    hasLabel(issueId, labelId) {
      if (typeof issueId !== "string" || issueId === "") return miss("issue-id-invalid");
      if (typeof labelId !== "string" || labelId === "") return miss("label-id-invalid");
      const r = one(ISSUE_LABEL_SELECT, [issueId, labelId], {
        // A zero-row answer here is a REAL answer, not a miss: the pair is simply not
        // in the join table. `one` reports zero rows as `absent`, so that verdict is
        // translated back into present:false rather than treated as a failure.
        absent: "issue-label-absent",
        ambiguous: "issue-label-ambiguous",
      });
      if (r.ok) return { ok: true, present: true };
      if (r.reason === "issue-label-absent") return { ok: true, present: false };
      return r;
    },

    close: drop,
  };
}
