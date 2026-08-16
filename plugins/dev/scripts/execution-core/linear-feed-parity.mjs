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
import { getEventName } from "../lib/event-name.mjs";

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
/**
 * Fields whose change can genuinely cancel inside one producer tick, leaving the
 * feed with no net edge to emit. Only these are ELIGIBLE for the round-trip
 * explanation — and eligibility still requires corroboration.
 * `state` is deliberately absent: a state round trip could hide a
 * dispatch-relevant transition and must stay visible.
 */
export const REVERSIBLE_FIELDS = Object.freeze(["cycleId", "projectId", "parentId", "assigneeId"]);

export const FEED_BLIND_FIELDS = Object.freeze(["actorId", "actorName"]);

// CTL-1834: the ONE event-name boundary. This file used to hand-roll
// `attributes["event.name"] ?? event ?? name`, which differs from the canonical
// resolver twice over: the key ORDER, and — the one that actually bites — `??`
// only falls through on null/undefined, so an event carrying an EMPTY-STRING
// attribute resolved to "" here while getEventName correctly falls through to
// the next key ("first non-empty string wins"). In a parity harness that
// mis-tallies BOTH sides, which is the instrument, not the subject.
const nameOf = (e) => getEventName(e) || null;
const ticketOf = (e) =>
  e?.attributes?.["linear.issue.identifier"] ?? e?.body?.payload?.ticket ?? null;
const keysOf = (e) => {
  const k = e?.body?.payload?.updatedFromKeys;
  return Array.isArray(k) ? [...k].sort() : [];
};

/** The join key: a ticket plus the set of fields the event says changed. */
export function edgeKey(event) {
  const t = ticketOf(event);
  // ⛔ An unkeyable dispatch-class event is DROPPED from the tallies, and a drop
  // that nothing counts is how a run reports CLEAN over a stream it did not
  // fully compare (Codex P1 round 7: one matched edge plus one ticketless feed
  // event gave feed count 2, matchedKeys 1, and no unexplained diffs).
  // compareStreams counts these separately and the runner treats any non-zero
  // count as INCONCLUSIVE.
  if (!t) return null;
  const n = nameOf(event);
  if (n === "linear.comment.created") {
    // ⛔ KEY ON THE COMMENT ID (Codex P1 round 2). A ticket-level `<t>|comment`
    // key made DIFFERENT comments cancel: smee carrying human comments A+B while
    // the feed carries A plus a deliberately feed-only bot comment C gives both
    // sides a count of 2 on the same key, so even the multiplicity comparison
    // reported clean — while inbox delivery of B was dropped. Both producers
    // stamp `body.payload.commentId`, so the identity is available and stable.
    //
    // A missing id degrades to the ticket-level key rather than dropping the
    // event from the comparison: coarser is a weaker check, but silently not
    // comparing an event at all is a hole. The degradation is visible because
    // the key has no third segment.
    const cid = event?.body?.payload?.commentId;
    return typeof cid === "string" && cid !== "" ? `${t}|comment|${cid}` : `${t}|comment`;
  }
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
export function explain(side, key, event, ctx = {}) {
  // ⛔ THIS NO LONGER EXPLAINS ANYTHING. It returns a HINT, and compareStreams
  // never uses it to move an asymmetry out of the unexplained bucket.
  //
  // Six review rounds killed every predicate that lived here, one at a time, and
  // round 6 killed all four survivors at once — each was an ASSERTION that a
  // real difference was benign, and each was wrong in a different way:
  //   • bot-comments      — premise false: the webhook receiver suppresses bot
  //                         `issue` events, NOT bot comments.
  //   • synthetic-creation — matched any state+3-field update with no observed
  //                         `linear.issue.created` to correlate against.
  //   • ladder-fields      — justified by "smee named it differently", but
  //                         `edgeKey` deliberately ignores names.
  //   • late-arrival       — corroborated on a ticket-only key, so an unrelated
  //                         earlier change made `priorSmeeTs` truthy.
  //
  // The pattern is the concept, not the four instances: an automatic
  // "this difference is fine" is a conclusion the harness is not in a position
  // to reach, because it sees two event streams and not the world that produced
  // them. So `clean` now means the two streams AGREE EXACTLY — a claim that can
  // be defended — and every asymmetry is surfaced with a resemblance hint for a
  // human to adjudicate against the replica.
  //
  // Keeping the hint is deliberate: the information was always useful, it was
  // the conclusion drawn from it that was not.
  const raw = keysOf(event);
  const keys = joinFields(raw);
  const name = nameOf(event);
  const hints = [];

  if (side === "smee") {
    if (SMEE_UNHANDLED_NAMES.includes(name)) hints.push(`smee-unhandled-name:${name}`);
    if (raw.length > 0 && keys.length === 0) {
      hints.push(`smee-untracked-fields:${raw.map((k) => `${k}(${UNTRACKED_SMEE_FIELDS[k] ?? "untracked"})`).join("; ")}`);
    }
    if (keys.length > 0 && keys.every((k) => REVERSIBLE_FIELDS.includes(k))) {
      hints.push("resembles:reversible-field-round-trip (VERIFY against the replica — the harness cannot)");
    }
  } else {
    if (event?.body?.payload?.isBot === true || event?.body?.payload?.authorIsBot === true) {
      hints.push("resembles:bot-authored-comment (CTL-1891 wants these on the feed; CONFIRM smee genuinely lacks it)");
    }
    if (keys.includes("state") && keys.length >= 4) {
      hints.push("resembles:issue-creation (CONFIRM a linear.issue.created exists for this ticket)");
    }
    if (keys.length > 0 && keys.every((k) => ["priority", "assigneeId", "delegateId"].includes(k))) {
      hints.push("resembles:ladder-named-field");
    }
    if (ctx?.priorSmeeTs) hints.push(`resembles:late-arrival (smee reported a same-key edge at ${ctx.priorSmeeTs})`);
  }
  return hints.length ? hints.join(" | ") : null;
}

/**
 * Default trailing-edge hold-back: replica write latency (~11 s measured) plus one
 * producer tick (30 s default), with margin.
 *
 * ⛔ This constant was DELETED by an over-wide edit while rewriting explain(), and
 * nothing caught it: every unit test passes `settleSec` explicitly so the default
 * parameter below never evaluated, and the only importer is a CLI that no test
 * EXECUTES — it was checked by grepping its source text. A source-level assertion
 * cannot fail on a module that does not load.
 */
export const DEFAULT_SETTLE_SEC = 120;

export function resolveWindow({
  nowMs,
  sinceMin = 60,
  seededAt = null,
  settleSec = DEFAULT_SETTLE_SEC,
} = {}) {
  const requested = nowMs - sinceMin * 60_000;
  // Leading edge: never reach back before the feed's baseline existed.
  const since = Number.isFinite(seededAt) && seededAt !== null ? Math.max(requested, seededAt) : requested;
  const clampedToFeedStart = Number.isFinite(seededAt) && seededAt !== null && seededAt > requested;
  // Trailing edge: never reach forward into the feed's own latency.
  const until = nowMs - settleSec * 1000;
  return { since, until, clampedToFeedStart, emptyWindow: until <= since };
}

export function compareStreams({ smee = [], feed = [], since = null, until = null } = {}) {
  const inWindow = (e) => {
    if (!since && !until) return true;
    const ts = Date.parse(e?.ts ?? "");
    if (!Number.isFinite(ts)) return false;
    if (since && ts < since) return false;
    if (until && ts > until) return false;
    return true;
  };
  // Dispatch-class events we could not key at all. Counted, never silently
  // dropped — see edgeKey.
  const unkeyable = { smee: 0, feed: 0 };
  const countUnkeyable = (evts, side) => {
    for (const e of evts) {
      if (!inWindow(e)) continue;
      if (!DISPATCH_NAMES.includes(nameOf(e))) continue;
      if (edgeKey(e) === null) unkeyable[side] += 1;
    }
  };

  const smeeIn = smee.filter((e) => inWindow(e) && DISPATCH_NAMES.concat(SMEE_UNHANDLED_NAMES).includes(nameOf(e)));
  // Corroboration index for the late-arrival predicate: the SAME edge key seen on the
  // smee side BEFORE the window. Deliberately not window-bounded — the whole point is
  // that the replica surfaced it late, so the proof lies outside the window.
  const priorSmee = new Map();
  for (const e of smee) {
    if (inWindow(e)) continue;
    if (since && Date.parse(e?.ts ?? "") >= since) continue;
    const k = edgeKey(e);
    if (!k) continue;
    if (!priorSmee.has(k)) priorSmee.set(k, e.ts);
  }
  const feedIn = feed.filter(inWindow);

  countUnkeyable(smee, "smee");
  countUnkeyable(feed, "feed");

  const S = tally(smeeIn);
  const F = tally(feedIn);

  // Per-(ticket, field) transition counts observed on the SMEE side within the
  // window. This is the corroboration the round-trip explanation now requires:
  // two observed transitions of a field is evidence it went and came back; one
  // is just an edge the feed did not match.
  const fieldHops = new Map();
  for (const e of smeeIn) {
    const t = ticketOf(e);
    if (!t) continue;
    for (const k of joinFields(keysOf(e))) {
      const kk = `${t}|${k}`;
      fieldHops.set(kk, (fieldHops.get(kk) ?? 0) + 1);
    }
  }

  // Always empty since round 6: the harness no longer concludes that any real
  // difference is benign. Retained so consumers reading `.explained` see [] rather
  // than undefined, and so `clean` cannot be computed from a stale notion of it.
  const explained = [];
  const unexplained = [];
  const byKeyEvent = (events, key) => events.find((e) => edgeKey(e) === key) ?? null;

  // ⛔ MULTIPLICITY, NOT PRESENCE (Codex P1, #3439).
  //
  // These loops used to `continue` whenever the other side merely HAD the key.
  // Every comment on a ticket maps to the same key `<ticket>|comment`, so two
  // smee comments against one feed comment satisfied "both sides have it" and
  // produced NO diff and `clean: true` — the parity gate would approve a feed
  // that dropped a dispatch-class event. Counts, not membership.
  for (const [key, n] of S.byKey) {
    const other = F.byKey.get(key) ?? 0;
    if (other >= n) continue;
    const missing = n - other;
    const why = explain("smee", key, byKeyEvent(smeeIn, key), { fieldHops });
    // The hint NEVER moves this out of `unexplained` — see explain().
    unexplained.push({
      side: "smee-only",
      key,
      count: missing,
      smeeCount: n,
      feedCount: other,
      hint: why ?? null,
      why: null,
    });
  }
  for (const [key, n] of F.byKey) {
    const other = S.byKey.get(key) ?? 0;
    if (other >= n) continue;
    const extra = n - other;
    const why = explain("feed", key, byKeyEvent(feedIn, key), {
      priorSmeeTs: priorSmee.get(key) ?? null,
      // The late-arrival predicate is only sound for a SINGLE unmatched
      // occurrence; a surplus of several is not one straggler.
      count: extra,
    });
    unexplained.push({
      side: "feed-only",
      key,
      count: extra,
      smeeCount: other,
      feedCount: n,
      hint: why ?? null,
      why: null,
    });
  }

  return {
    counts: { smee: smeeIn.length, feed: feedIn.length },
    unkeyable,
    classes: { smee: S.byClass, feed: F.byClass },
    // Keys present on both sides AT THE SAME COUNT. A key both sides carry but
    // in different quantities is a diff, so counting it as matched would report
    // the discrepancy as agreement.
    matchedKeys: [...S.byKey.keys()].filter((k) => (F.byKey.get(k) ?? 0) === S.byKey.get(k)).length,
    explained,
    unexplained,
    // The window's gate. Since round 6 there are no explained asymmetries at
    // all, so this is simply "the two streams agree exactly" — a claim the
    // harness is actually in a position to make.
    clean: unexplained.length === 0,
  };
}
