// linear-feed-parity.mjs — CTL-1847, the shadow-window parity harness.
//
// Compares what SMEE delivered (the unified event log, which the webhook receiver
// already writes durably) against what the CLOUD FEED produced (the diff producer's
// shadow file). The shadow window exits on this reporting zero UNEXPLAINED diffs
// with every required coverage cell observed.
//
// ── ⚠️ JOIN ON (ticket, changed-fields), NEVER ON EVENT NAME ────────────────
// The webhook's `issueTopic` is a FIRST-MATCH ladder — state > priority > assignee >
// delegate > generic — so one Linear update carrying several changed fields becomes
// exactly ONE smee event, named for the highest-priority field, while its payload
// still lists them all. The diff producer reports every changed field. Joining on
// name would therefore report a difference on every multi-field update, which is
// noise, and noise on the first minute trains everyone to ignore the harness.
//
// ── ⛔ THE EXPLAINED ASYMMETRIES ARE DATA, NOT PROSE ────────────────────────
// Each is a predicate below, so "explained" is a decision the code makes and can be
// audited, rather than a paragraph a reviewer is trusted to remember. An
// asymmetry NOT matched by one of these is UNEXPLAINED and fails the window — the
// default is suspicion, not tolerance.

/** Event names the daemon actually acts on. Anything else is out of scope. */
export const DISPATCH_NAMES = Object.freeze([
  "linear.issue.state_changed",
  "linear.issue.updated",
  "linear.comment.created",
]);

/**
 * Smee names produced by the topic ladder that NO handler consumes today
 * (measured: 0 references in monitor.mjs). The diff producer reports these changes
 * as `updated:<field>` cells, so it is deliberately MORE complete than smee here.
 * A feed-only edge whose fields are exactly these is EXPLAINED, not a defect —
 * "fixing" it would mean reproducing smee's blind spot in its replacement.
 */
export const SMEE_UNHANDLED_NAMES = Object.freeze([
  "linear.issue.priority_changed",
  "linear.issue.assignee_changed",
  "linear.issue.delegate_changed",
  "linear.issue.created",
  "linear.issue.removed",
]);


/**
 * Fields smee reports in `updatedFrom` that the diff source deliberately does NOT
 * track, each with the reason it is not an edge. Widening the edge source to cover
 * these would make the producer emit on every touch — the exact noise the diff
 * design exists to avoid.
 *
 * ⚠️ The test that mattered was not "does anything READ this field" but "does
 * anything need an EVENT when it changes". `completed_at`/`canceled_at` are read by
 * the scheduler's hot terminal check — but that check reads the replica DIRECTLY on
 * its own tick (`replica-read.mjs`: "the scheduler's hot per-signal terminal checks
 * read terminal-ness from this sub-ms local DB"), so it never waits on our stream.
 * And completion moves `state`, which IS tracked, so the transition is captured
 * anyway and the timestamp is its companion.
 */
export const UNTRACKED_SMEE_FIELDS = Object.freeze({
  updatedAt: "bookkeeping — moves on every mirror rewrite, would make every touch an edge",
  sortOrder: "board position — changes on any drag, no dispatch consumer",
  addedToCycleAt: "companion timestamp of cycleId, which IS tracked",
  completedAt: "companion of the state transition, which IS tracked; its consumer reads the replica directly",
  canceledAt: "companion of the state transition, which IS tracked; its consumer reads the replica directly",
  startedAt: "companion of the state transition, which IS tracked",
  archivedAt: "archival bookkeeping, no dispatch consumer",
  snoozedUntilAt: "snooze bookkeeping, no dispatch consumer",
  boardOrder: "board position, no dispatch consumer",
  subIssueSortOrder: "board position, no dispatch consumer",
  trashed: "soft-delete bookkeeping, no dispatch consumer",
});


/**
 * Smee reports Linear's RAW field names; the diff producer reports its own
 * vocabulary. Normalising here — in the comparison, not in the producer — keeps the
 * producer's payload semantic rather than making it adopt Linear's wire spelling.
 *
 * Found by running the harness on live data: `CTC-587|completedAt,sortOrder,stateId,
 * updatedAt` never matched a feed edge because `stateId` and `state` are the same
 * change under two names.
 */
export const SMEE_FIELD_ALIASES = Object.freeze({
  stateId: "state",
  assigneeId: "assigneeId",
  projectId: "projectId",
  cycleId: "cycleId",
  parentId: "parentId",
  teamId: "teamId",
  delegateId: "delegateId",
  dueDate: "dueDate",
});

/**
 * The fields that actually participate in the join: aliased into the feed's
 * vocabulary, with bookkeeping fields dropped.
 *
 * ⭐ Dropping the untracked fields is what makes the join WORK. Live evidence: one
 * real change produced `smee CTL-1894|estimate,updatedAt` and `feed CTL-1894|estimate`
 * — the same edit, reported as two different keys, counted as two one-sided diffs.
 * `updatedAt` rides along on every smee payload, so leaving it in the key would make
 * almost nothing ever match.
 */
export function joinFields(keys) {
  const out = [];
  for (const k of Array.isArray(keys) ? keys : []) {
    if (k in UNTRACKED_SMEE_FIELDS) continue;
    out.push(SMEE_FIELD_ALIASES[k] ?? k);
  }
  return [...new Set(out)].sort();
}

/** Fields the diff source cannot observe, so their absence on the feed side is expected. */
export const FEED_BLIND_FIELDS = Object.freeze(["actorId", "actorName"]);

const nameOf = (e) => e?.attributes?.["event.name"] ?? e?.event ?? e?.name ?? null;
const ticketOf = (e) =>
  e?.attributes?.["linear.issue.identifier"] ?? e?.body?.payload?.ticket ?? null;
const keysOf = (e) => {
  const k = e?.body?.payload?.updatedFromKeys;
  return Array.isArray(k) ? [...k].sort() : [];
};

/** The join key: a ticket plus the set of fields the event says changed. */
export function edgeKey(event) {
  const t = ticketOf(event);
  if (!t) return null;
  const n = nameOf(event);
  if (n === "linear.comment.created") return `${t}|comment`;
  const keys = joinFields(keysOf(event));
  return `${t}|${keys.length ? keys.join(",") : "none"}`;
}

/** Coverage cell, matching the shadow sink's classification exactly. */
export function classOf(event) {
  const n = nameOf(event);
  if (n !== "linear.issue.updated") return n ? [n] : [];
  const keys = joinFields(keysOf(event));
  return keys.length ? keys.map((k) => `linear.issue.updated:${k}`) : ["linear.issue.updated:none"];
}

const tally = (events) => {
  const byKey = new Map();
  const byClass = {};
  for (const e of events ?? []) {
    const k = edgeKey(e);
    if (k) byKey.set(k, (byKey.get(k) ?? 0) + 1);
    for (const c of classOf(e)) byClass[c] = (byClass[c] ?? 0) + 1;
  }
  return { byKey, byClass };
};

/**
 * Classify a one-sided edge. Returns an explanation string when the asymmetry is
 * expected, or null when it is a genuine unexplained diff.
 */
export function explain(side, key, event) {
  const name = nameOf(event);
  const raw = keysOf(event);
  const keys = joinFields(raw);

  if (side === "smee") {
    // Smee emits names nothing handles; the feed reports the same change as a field
    // cell instead, so there is no matching feed edge under this key.
    if (SMEE_UNHANDLED_NAMES.includes(name)) return `smee-only-name:${name}`;
    // Every field smee reported is one the diff source deliberately does not treat
    // as an edge, so there is no feed counterpart BY DESIGN.
    if (raw.length > 0 && keys.length === 0) {
      return `smee-only-fields:${raw.map((k) => `${k}(${UNTRACKED_SMEE_FIELDS[k] ?? "untracked"})`).join("; ")}`;
    }
    // A mixed edge — some tracked, some not — is NOT explained away wholesale. The
    // tracked part should have a feed counterpart, and its absence is a real diff.
  }

  if (side === "feed") {
    // The mirror image: the feed reports fields whose smee event was named by the
    // ladder and therefore keyed differently.
    if (keys.length > 0 && keys.every((k) => ["priority", "assigneeId", "delegateId"].includes(k))) {
      return "feed-more-complete:ladder-named-differently";
    }
    // Net-edge collapse — two transitions inside one tick appear once as the net
    // edge, so the intermediate hop smee saw has no feed counterpart.
    if (keys.includes("state")) return "net-edge-collapse-candidate";
  }
  return null;
}

/**
 * Compare the two streams.
 *
 * `unexplained` is what gates the window. Everything else is reported for context —
 * counts, coverage, and the explanations applied — so a reader can audit WHY a
 * difference was tolerated rather than taking the verdict on trust.
 */
export function compareStreams({ smee = [], feed = [], since = null, until = null } = {}) {
  const inWindow = (e) => {
    if (!since && !until) return true;
    const ts = Date.parse(e?.ts ?? "");
    if (!Number.isFinite(ts)) return false;
    if (since && ts < since) return false;
    if (until && ts > until) return false;
    return true;
  };
  const smeeIn = smee.filter((e) => inWindow(e) && DISPATCH_NAMES.concat(SMEE_UNHANDLED_NAMES).includes(nameOf(e)));
  const feedIn = feed.filter(inWindow);

  const S = tally(smeeIn);
  const F = tally(feedIn);

  const explained = [];
  const unexplained = [];
  const byKeyEvent = (events, key) => events.find((e) => edgeKey(e) === key) ?? null;

  for (const [key, n] of S.byKey) {
    if (F.byKey.has(key)) continue;
    const why = explain("smee", key, byKeyEvent(smeeIn, key));
    (why ? explained : unexplained).push({ side: "smee-only", key, count: n, why: why ?? null });
  }
  for (const [key, n] of F.byKey) {
    if (S.byKey.has(key)) continue;
    const why = explain("feed", key, byKeyEvent(feedIn, key));
    (why ? explained : unexplained).push({ side: "feed-only", key, count: n, why: why ?? null });
  }

  return {
    counts: { smee: smeeIn.length, feed: feedIn.length },
    classes: { smee: S.byClass, feed: F.byClass },
    matchedKeys: [...S.byKey.keys()].filter((k) => F.byKey.has(k)).length,
    explained,
    unexplained,
    // The window's gate. Deliberately NOT "explained.length === 0" — explained
    // asymmetries are expected and permanent.
    clean: unexplained.length === 0,
  };
}
