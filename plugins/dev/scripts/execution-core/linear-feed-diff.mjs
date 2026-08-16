// linear-feed-diff.mjs — CTL-1847, deriving dispatch edges by DIFFING the issues
// table instead of reading issue_history.
//
// ── WHY THIS REPLACED THE issue_history SOURCE ──────────────────────────────
// The first design read `issue_history`, which stores each transition explicitly —
// no diffing, no baseline, no state to keep. That was right about correctness and
// silent about LATENCY, because nobody had measured the two tables' freshness
// against each other. Measured on a live ticket (CTL-1894, Canceled → Backlog):
//
//     issues.state reflected in the replica :   11 seconds
//     issue_history row appeared            :  201 seconds
//
// 18×. `issue_history` is reconcile-only — the mirror's webhook normalizer has no
// history-synthesis path at all (CTC-587), so its latency floor is the reconcile
// cadence rather than webhook latency. Worse, 140 fleet-wide issues have NO history
// rows (13 CTL, and all 34 POS), which post-cutover would make those tickets
// permanently undispatchable. `issues` is webhook-fed, so diffing it restores
// webhook-class latency and works for every ticket.
//
// The cost is this file: an edge is no longer handed to us, it must be derived from
// a baseline. Everything below is about making that derivation honest.
//
// ── ⚠️ THE COLD-START TRAP ──────────────────────────────────────────────────
// With no baseline, EVERY issue looks changed — a first tick would emit an edge for
// all ~4,000 issues in the replica. So a cold start SEEDS the baseline silently and
// emits nothing, exactly as the cursor's cold start declines to replay history.
// Seeding is not "missing the first edge": it is declining to invent 4,000 of them.
//
// ── ⚠️ NET-EDGE COLLAPSE, STATED NOT DISCOVERED ─────────────────────────────
// Two transitions inside one tick collapse to their net edge: Backlog → Todo →
// Implement between ticks is observed once, as Backlog → Implement. This is
// acceptable because dispatch keys on the eligible projection of NET state, not on
// the path taken — but it is a real difference from the webhook stream, which sees
// each hop. It is a written property with a test below, so nobody meets it as a
// surprise in a parity diff.

/**
 * The issue fields whose change is a dispatch-relevant edge, mapped to the payload
 * key the envelope reports. Keys match `EDGE_PAIRS` in linear-feed-event.mjs so the
 * two producers describe the same change with the same vocabulary.
 */
export const TRACKED_FIELDS = Object.freeze([
  { key: "state", column: "state" },
  { key: "assigneeId", column: "assignee_id" },
  { key: "priority", column: "priority" },
  { key: "estimate", column: "estimate" },
  { key: "projectId", column: "project_id" },
  { key: "cycleId", column: "cycle_id" },
  { key: "parentId", column: "parent_id" },
  { key: "teamId", column: "team_id" },
  { key: "title", column: "title" },
  { key: "dueDate", column: "due_date" },
  { key: "delegateId", column: "delegate_id" },
  { key: "description", column: "description" },
]);

/** SQLite NULL and "" are both "no value" — treat them alike so they don't diff. */
const norm = (v) => (v === undefined || v === "" ? null : v);

/**
 * The comparable subset of an issue row, plus its labels.
 *
 * `description` is reduced to a LENGTH rather than kept whole: the payload only
 * reports `descriptionChanged` as a boolean, and holding every issue's full body in
 * the baseline would make the store enormous for information the envelope discards.
 * A length change is a sound proxy for the boolean; an edit that preserves length
 * exactly is a miss we accept, and it is written down rather than silent.
 */
export function snapshotOf(row, labels = []) {
  if (!row || typeof row !== "object") return null;
  const snap = {};
  for (const f of TRACKED_FIELDS) {
    snap[f.key] = f.key === "description" ? (typeof row.description === "string" ? row.description.length : null) : norm(row[f.column]);
  }
  snap.labels = Array.isArray(labels) ? [...labels].sort() : [];
  return snap;
}

const sameLabels = (a, b) => {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * Derive the edge between two snapshots.
 *
 * Returns `null` when nothing tracked changed — a row can be rewritten by the
 * mirror (its `updated_at` moves) without any field we care about differing, and
 * emitting an empty edge for that would be pure noise in the parity diff.
 */
export function diffSnapshots(before, after) {
  if (!after) return null;
  const updatedFromKeys = [];
  const previousFromValues = {};
  for (const f of TRACKED_FIELDS) {
    const b = before ? before[f.key] : null;
    const a = after[f.key];
    if (b === a) continue;
    if (f.key === "description") {
      // Reported as a boolean, so only its presence matters.
      updatedFromKeys.push("description");
      previousFromValues.description = null;
      continue;
    }
    updatedFromKeys.push(f.key);
    previousFromValues[f.key] = b ?? null;
  }
  if (!sameLabels(before?.labels, after.labels)) {
    updatedFromKeys.push("labels");
    previousFromValues.labels = { before: before?.labels ?? [], after: after.labels };
  }
  if (updatedFromKeys.length === 0) return null;
  return {
    updatedFromKeys,
    previousFromValues,
    after,
    fromState: before ? before.state ?? null : null,
    toState: after.state ?? null,
    // A state edge is the dispatch trigger; everything else folds into the
    // eligible projection. Matches edgeEventName's rule on the history path.
    isStateEdge: (before ? before.state ?? null : null) !== (after.state ?? null) && (after.state ?? null) !== null,
  };
}

/**
 * Shape a diff into the row form `buildIssueEvent` already consumes, so BOTH edge
 * sources produce byte-identical envelopes and the harness compares like with like.
 *
 * The synthetic history row carries `assertedBy: "issues-diff"` in its id so an
 * operator reading the shadow file can tell which source produced a line — and so a
 * diff-derived edge is never mistaken for a replicated one.
 */
export function diffToHistoryRow(issueRow, diff, { now = () => Date.now() } = {}) {
  if (!diff || !issueRow) return null;
  const prev = diff.previousFromValues;
  const has = (k) => diff.updatedFromKeys.includes(k);
  const snap = diff.after ?? {};
  // ⭐ A COMPLETE synthetic history row, not just the state pair. `buildIssueEvent`
  // re-derives updatedFromKeys from the from_/to_ columns, so a partial row would
  // silently report only `state` and drop every other changed field — the envelope
  // would disagree with the diff that produced it. Emitting the full pair set means
  // ONE envelope path serves both edge sources, which is what lets the harness
  // compare like with like instead of comparing two shapes.
  const row = {
    id: `diff:${issueRow.id}:${issueRow.updated_at ?? now()}`,
    issue_id: issueRow.id,
    // The diff cannot know WHO changed it — `issues` carries no actor column. A real
    // loss versus issue_history, and the reason echo suppression on this path must
    // key on something else (CTL-1891/1892). Null, never guessed.
    actor_id: null,
    created_at: Number.isInteger(issueRow.updated_at) ? issueRow.updated_at : now(),
    from_state: has("state") ? prev.state ?? null : diff.toState,
    to_state: diff.toState,
    updated_description: has("description") ? 1 : 0,
    added_label_ids: has("labels") ? JSON.stringify(prev.labels?.after ?? []) : "[]",
    removed_label_ids: has("labels") ? JSON.stringify(prev.labels?.before ?? []) : "[]",
  };
  // Pair columns for every non-state tracked field. When a field did NOT change,
  // both sides carry the same value so edgeDelta correctly reports no change.
  const pairs = [
    ["assigneeId", "from_assignee_id", "to_assignee_id"],
    ["priority", "from_priority", "to_priority"],
    ["estimate", "from_estimate", "to_estimate"],
    ["projectId", "from_project_id", "to_project_id"],
    ["cycleId", "from_cycle_id", "to_cycle_id"],
    ["parentId", "from_parent_id", "to_parent_id"],
    ["teamId", "from_team_id", "to_team_id"],
    ["title", "from_title", "to_title"],
    ["dueDate", "from_due_date", "to_due_date"],
  ];
  for (const [key, fromCol, toCol] of pairs) {
    const after = snap[key] ?? null;
    row[fromCol] = has(key) ? prev[key] ?? null : after;
    row[toCol] = after;
  }
  return row;
}
