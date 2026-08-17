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
// ── ⚠️ LABEL NAMES ARE NOT UNIQUE WORKSPACE-WIDE ──
// Measured on the live replica: `types`, `schema`, `mobile`, `infra`, `etl`, `dbt` and
// `api` each resolve to FOUR label rows (same name, different teams) — `labels` carries
// no team_id to disambiguate with. The four labels this increment actually writes
// (`needs-human`, `needs-input`, `blocked`, `queued` — the CTL-1481 worker-status group)
// are each unique TODAY (measured n=1), but a resolver that relies on that is one new
// team-scoped label away from applying another team's label to a ticket. So an
// ambiguous name is REFUSED by name (`label-ambiguous`), never resolved to a first hit.

import { Database } from "bun:sqlite";
import { getReplicaDbPath } from "./config.mjs";

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

/**
 * createProxyResolver — identifier/name → Linear UUID, off the local replica.
 *
 * The handle is opened lazily and DROPPED on any throw, so a later call re-opens
 * against a database the replica writer may have re-seeded or migrated underneath us
 * (same handle discipline as replica-read.mjs — only the verdict differs).
 */
export function createProxyResolver({ dbPath = null } = {}) {
  let db = null;

  const open = () => {
    if (db) return db;
    db = new Database(dbPath ?? getReplicaDbPath(), { readonly: true });
    db.run("PRAGMA busy_timeout = 250");
    return db;
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
    let rows;
    try {
      rows = open().prepare(sql).all(...params);
    } catch (err) {
      drop();
      return miss("replica-unreadable", String(err?.message ?? err).slice(0, 200));
    }
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

    close: drop,
  };
}
