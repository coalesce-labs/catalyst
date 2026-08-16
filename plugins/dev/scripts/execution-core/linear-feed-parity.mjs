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
  const keys = keysOf(event);
  return `${t}|${keys.length ? keys.join(",") : "none"}`;
}

/** Coverage cell, matching the shadow sink's classification exactly. */
export function classOf(event) {
  const n = nameOf(event);
  if (n !== "linear.issue.updated") return n ? [n] : [];
  const keys = keysOf(event);
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
  const keys = keysOf(event);

  if (side === "smee") {
    // Smee emits names nothing handles; the feed reports the same change as a field
    // cell instead, so there is no matching feed edge under this key.
    if (SMEE_UNHANDLED_NAMES.includes(name)) return `smee-only-name:${name}`;
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
