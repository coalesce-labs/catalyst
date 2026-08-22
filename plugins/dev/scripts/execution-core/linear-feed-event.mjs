// linear-feed-event.mjs — CTL-1847, the pure core of the cloud-feed dispatch producer.
//
// ── WHAT THIS IS ────────────────────────────────────────────────────────────
// Today the ONLY transport that triggers dispatch is a smee tunnel: Linear →
// webhook → smee → orch-monitor `/api/webhook/linear` → `events/YYYY-MM.jsonl` →
// monitor/broker → dispatch. On 2026-08-14 that tunnel 401'd for ~8 hours and the
// entire fleet was undispatchable while every health surface stayed green.
//
// This module is the first half of replacing that transport with the cloud change
// feed, which stayed seconds-fresh throughout that same outage.
//
// ⛔ ONLY THE INBOUND PIPE MOVES (COORD-19). This is a PRODUCER of the events we
// already emit — same three names, same v2 envelope, same log file. Every
// downstream reader (broker, monitor, `catalyst-events wait-for`, HUD, reaper) is
// untouched, and the JSONL tail-and-trigger and phase advancement are untouched.
// The falsifiable form of that boundary, which is an acceptance criterion on the
// ticket: IF THIS WORK REQUIRES EDITING `monitor.mjs`'s HANDLERS, THE ENVELOPE IS
// WRONG.
//
// ── WHY `issue_history` AND NOT A DIFF OF `issues` ──────────────────────────
// The feed (`LiveSyncClient`, CHANGE_OPS `upsert`/`delete`) replicates 15 entities.
// `issue_history` stores each transition EXPLICITLY — `from_state`/`to_state`,
// `from_assignee_id`/`to_assignee_id`, `from_priority`/`to_priority`,
// `from_estimate`/`to_estimate`, `from_project_id`/`to_project_id`,
// `added_label_ids`/`removed_label_ids`, `updated_description`, `actor_id` — so the
// dispatch edge needs no diffing and no snapshot comparison. Measured on the live
// replica 2026-08-15: 30,985 history rows, 10,011 carrying a real state edge,
// newest row 4 minutes old.
//
// ── WHY THE PAYLOAD IS FAT ──────────────────────────────────────────────────
// `orch-monitor/lib/linear-webhook-handler.ts` does not emit a thin envelope, and
// that is deliberate: CTL-681's own comment says the pre-CTL-681 envelope "dropped
// these and forced a full poll per event". A producer that emits less would LOOK
// like a working cutover while costing one Linear API poll per event — a quota
// regression disguised as a success. So this builds the full CTL-681 payload, and
// every field of it is derivable from local replica joins with ZERO API calls.
//
// ── THE ONE HONEST ASYMMETRY ────────────────────────────────────────────────
// Edge fields describe the TRANSITION (from the history row); scoping fields
// describe CURRENT state (from the joined `issues` row). If two transitions land
// close together the joined row reflects the later one. For dispatch eligibility
// current state is arguably the better input, but `toState` must come from the
// history row or the event is not a faithful edge. Stated here so it is read, not
// discovered.
//
// This file is a zero-I/O leaf: no database, no filesystem, no clock of its own.
// The caller supplies rows and seams. That is what makes parity testable.

import { buildCanonicalEvent } from "./lib/canonical-event.mjs";

export const EVENT_STATE_CHANGED = "linear.issue.state_changed";
export const EVENT_ISSUE_UPDATED = "linear.issue.updated";
export const EVENT_COMMENT_CREATED = "linear.comment.created";

/**
 * The `from_`/`to_` column pairs `issue_history` carries, in the order the webhook
 * payload's `updatedFromKeys` names them. Keeping this as data (rather than a
 * hand-written if-ladder per field) is what lets `updatedFromKeys` and
 * `previousFromValues` be derived rather than enumerated at each call site.
 */
export const EDGE_PAIRS = Object.freeze([
  { key: "state", from: "from_state", to: "to_state" },
  { key: "assigneeId", from: "from_assignee_id", to: "to_assignee_id" },
  { key: "priority", from: "from_priority", to: "to_priority" },
  { key: "estimate", from: "from_estimate", to: "to_estimate" },
  { key: "projectId", from: "from_project_id", to: "to_project_id" },
  { key: "cycleId", from: "from_cycle_id", to: "to_cycle_id" },
  { key: "parentId", from: "from_parent_id", to: "to_parent_id" },
  { key: "teamId", from: "from_team_id", to: "to_team_id" },
  { key: "title", from: "from_title", to: "to_title" },
  { key: "dueDate", from: "from_due_date", to: "to_due_date" },
]);

/** Treat SQLite NULL and the empty string alike — neither names a value. */
const present = (v) => v !== null && v !== undefined && v !== "";

/**
 * `added_label_ids` / `removed_label_ids` arrive as a JSON array in a TEXT column —
 * empty is `"[]"`, not NULL, so a truthiness check alone would call every row a
 * label change. Parses defensively: an unparseable value yields `[]` rather than
 * throwing, because one malformed history row must not stop a sweep.
 */
function parseIds(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const hasIds = (raw) => parseIds(raw).length > 0;

/**
 * A stable, replica-supplied identity for one edge.
 *
 * ⭐ `issue_history.id` is a PRIMARY KEY, so idempotency across boot-replay,
 * cursor overlap, and gap-reconciling sweeps comes for FREE — there is no
 * hand-built content hash to get wrong. Everything downstream of this producer
 * keys on it.
 *
 * ⚠️ Deliberately NOT the ticket. Dedup-by-ticket would collapse a fast
 * double-transition into one event and silently drop an edge; see
 * `docs`/the ticket's binding conditions. Two history rows must always produce two
 * events.
 */
// isoFromFeedTimestamp — normalize a feed timestamp to an ISO-8601 string.
//
// CTL-2111 (Codex #3824 round-4 P1): `issue_history.created_at` is stored and
// selected as an INTEGER of epoch milliseconds (see linear-feed-source.mjs, whose
// cursor compares `created_at > $sinceMs`), not a string. Copying it verbatim made
// the round-3 fix INERT in production: `parseStateChangedEvent` accepts
// `transitionedAt` only when it is a string, so every real event fell straight back
// to the delayed envelope `ts` and a pre-cap transition emitted later could still
// clear a newer cap. Normalizing at the producer keeps the wire shape one type, so
// no consumer has to know the storage representation.
//
// Accepts a number (epoch ms) or an already-ISO string; anything else, and any
// value that does not round-trip through Date, yields null — the conservative
// answer, since a null simply falls back to the envelope ts rather than asserting
// a wrong time.
export function isoFromFeedTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string" && value !== "") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

export function historyEventId(history) {
  const id = history?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * Which of the two issue events this edge is.
 *
 * A row whose `to_state` differs from `from_state` is the dispatch trigger
 * (`handleStateChangedEvent` → dispatchTriage); anything else folds into the
 * eligible projection (`handleIssueUpdatedEvent`).
 */
export function edgeEventName(history) {
  const from = history?.from_state ?? null;
  const to = history?.to_state ?? null;
  if (present(to) && to !== from) return EVENT_STATE_CHANGED;
  return EVENT_ISSUE_UPDATED;
}

/**
 * The keys this edge actually changed, and the values they held before.
 * Derived from the same table as the edge itself, so they cannot disagree with it.
 */
export function edgeDelta(history) {
  const updatedFromKeys = [];
  const previousFromValues = {};
  for (const pair of EDGE_PAIRS) {
    const before = history?.[pair.from] ?? null;
    const after = history?.[pair.to] ?? null;
    if (before === after) continue;
    // A pair where BOTH sides are absent is not a change; a pair where only one
    // side is absent is (set or cleared).
    if (!present(before) && !present(after)) continue;
    updatedFromKeys.push(pair.key);
    previousFromValues[pair.key] = before;
  }
  if (history?.updated_description) {
    updatedFromKeys.push("description");
  }
  // ⭐ Label changes are NOT a from_/to_ pair — `issue_history` records them as
  // `added_label_ids` / `removed_label_ids`. Omitting them was a real gap, caught by
  // running against the live replica rather than by a test: 90 of ~700 edges in a
  // two-day window reported `updatedFromKeys: []` (coverage class
  // `linear.issue.updated:none`) while actually carrying a label edit. Labels feed
  // the eligible projection, so a label change reading as "nothing changed" is a
  // dispatch-relevant edge that no coverage cell would ever name.
  if (hasIds(history?.added_label_ids) || hasIds(history?.removed_label_ids)) {
    updatedFromKeys.push("labels");
    previousFromValues.labels = {
      added: parseIds(history?.added_label_ids),
      removed: parseIds(history?.removed_label_ids),
    };
  }
  return { updatedFromKeys, previousFromValues };
}

/**
 * Decide whether an edge may be emitted into THIS host's log.
 *
 * Returns a NAMED reason rather than a boolean, so "nothing was emitted" is
 * diagnosable. A silent false is how a producer looks healthy while dropping every
 * event — the failure mode this repo keeps rediscovering.
 *
 * Two filters, both of which the webhook path already applies and neither of which
 * the raw feed applies for us:
 *
 *  - **Bot self-echo** (`botUserIds`). Without it the daemon wakes on its OWN
 *    writes: a feedback loop, the same class `shouldSkipEvent` exists to prevent on
 *    the broker side.
 *  - **Team scoping.** The replica is genuinely MULTI-TENANT — measured state-edge
 *    counts on 2026-08-15: CTL 4,993 · ADV 3,859 · CTC 851 · EVR 158 · OTL 114. An
 *    unfiltered producer would emit other tenants' transitions into this host's log
 *    and dispatch on them. `teams` comes from tenant config (the host's registered
 *    teams), never a hardcoded list.
 */
export function classifyEdge({ history, issue } = {}, { teams, botUserIds } = {}) {
  if (!history || typeof history !== "object") {
    return { emit: false, reason: "no-history-row" };
  }
  if (historyEventId(history) === null) {
    // No stable id means no idempotency key; emitting would risk duplicates on
    // every replay. Fail closed.
    return { emit: false, reason: "history-row-has-no-id" };
  }
  if (!issue || typeof issue !== "object") {
    return { emit: false, reason: "unjoinable-issue" };
  }
  const ticket = issue.identifier;
  if (!present(ticket)) return { emit: false, reason: "issue-has-no-identifier" };

  const teamKey = issue.team_key ?? null;
  if (!present(teamKey)) return { emit: false, reason: "issue-has-no-team-key" };
  // `teams` absent is NOT "allow everything" — an unconfigured producer must emit
  // nothing rather than every tenant's edges.
  if (!teams || typeof teams.has !== "function") {
    // ⛔ `fatal` (CTL-1909): this is the one non-emitting verdict whose cause is
    // the PRODUCER, not the row. Every other verdict here declines one row and
    // the next may still emit; this one declines all of them forever. Since the
    // readiness split treats an ordinary decline as healthy, a scopeless
    // producer would otherwise ARM enforce while emitting nothing at all —
    // smee suppressed, feed silent. Marked at the point the distinction is
    // known so the sweep needs no list of reason strings to tell them apart.
    return { emit: false, reason: "no-team-scope-configured", fatal: true };
  }
  if (!teams.has(teamKey)) return { emit: false, reason: "foreign-team" };

  const actorId = history.actor_id ?? null;
  if (present(actorId) && botUserIds && typeof botUserIds.has === "function" && botUserIds.has(actorId)) {
    return { emit: false, reason: "bot-authored" };
  }

  return { emit: true, reason: "ok" };
}

/**
 * Build the v2 envelope for one issue edge.
 *
 * `joins` carries the locally-resolved scoping rows — no network, no Linear API.
 * Shape mirrors `orch-monitor/lib/linear-webhook-handler.ts`'s `case "issue"` so
 * the two producers are diffable field-by-field during shadow parity.
 */
export function buildIssueEvent({ history, issue, actor, assignee, project, labels } = {}, seams = undefined) {
  const name = edgeEventName(history);
  const { updatedFromKeys, previousFromValues } = edgeDelta(history);
  const ticket = issue?.identifier ?? null;
  const teamKey = issue?.team_key ?? null;
  const issueId = history?.issue_id ?? issue?.id ?? null;
  const actorId = history?.actor_id ?? null;

  const attributes = {};
  if (present(ticket)) attributes["linear.issue.identifier"] = ticket;
  if (present(teamKey)) attributes["linear.team.key"] = teamKey;
  if (present(actorId)) attributes["linear.actor.id"] = actorId;
  if (present(issueId)) attributes["linear.issue.id"] = issueId;
  if (present(issue?.repo)) attributes["vcs.repository.name"] = issue.repo;

  return buildCanonicalEvent(
    {
      name,
      attributes,
      payload: {
        action: name === EVENT_STATE_CHANGED ? "state_changed" : "update",
        ticket,
        teamKey,
        issueId,
        updatedFromKeys,
        actorId,
        actorName: actor?.name ?? null,
        toState: history?.to_state ?? null,
        toPriority: history?.to_priority ?? null,
        toAssigneeId: history?.to_assignee_id ?? null,
        toAssigneeName: assignee?.name ?? null,
        // Scoping fields — CURRENT state, per the asymmetry noted in the header.
        toLabels: Array.isArray(labels) ? labels : [],
        toProject: project?.name ?? null,
        toProjectId: history?.to_project_id ?? issue?.project_id ?? null,
        previousFromValues,
        description: issue?.description ?? null,
        descriptionChanged: Boolean(history?.updated_description),
        toEstimate: history?.to_estimate ?? issue?.estimate ?? null,
        toDelegateId: issue?.delegate_id ?? null,
        // Provenance — so a shadow-parity diff can tell which producer wrote a
        // line, and so an operator reading the log later can too.
        source: "cloud-feed",
        historyId: historyEventId(history),
        // CTL-2111 (Codex #3824 round-3 P1): the SOURCE transition time, carried so
        // consumers can order against when Linear actually recorded the change
        // rather than when this feed emitted the envelope. `buildCanonicalEvent`
        // stamps `ts` with now() AND truncates milliseconds, so the envelope time
        // is both delayed (by sweep latency) and coarser than the timestamps it is
        // compared against. The triage-cap re-arm gate is the first consumer that
        // needs the real edge time: judged on `ts`, a delayed PRE-cap transition can
        // look newer than a cap it actually preceded and wrongly clear it.
        transitionedAt: isoFromFeedTimestamp(history?.created_at),
      },
    },
    seams,
  );
}

/**
 * Build the v2 envelope for one comment row. A `comments` upsert IS
 * comment-created; there is no separate edge table for it.
 */
export function buildCommentEvent({ comment, issue, author } = {}, seams = undefined) {
  const ticket = issue?.identifier ?? null;
  const teamKey = issue?.team_key ?? null;
  const authorId = comment?.user_id ?? comment?.author_id ?? null;

  const attributes = {};
  if (present(ticket)) attributes["linear.issue.identifier"] = ticket;
  if (present(authorId)) attributes["linear.actor.id"] = authorId;
  if (present(teamKey)) attributes["linear.team.key"] = teamKey;
  if (present(issue?.repo)) attributes["vcs.repository.name"] = issue.repo;

  return buildCanonicalEvent(
    {
      name: EVENT_COMMENT_CREATED,
      attributes,
      payload: {
        action: "create",
        ticket,
        teamKey,
        issueId: comment?.issue_id ?? issue?.id ?? null,
        commentId: comment?.id ?? null,
        actorId: authorId,
        actorName: author?.name ?? null,
        body: comment?.body ?? null,
        // Carried so the parity harness can recognise the bot-authored comments that
        // smee's receiver filters and the feed deliberately does not (CTL-1891).
        isBot: comment?.is_bot === 1 || comment?.is_bot === true,
        source: "cloud-feed",
      },
    },
    seams,
  );
}
