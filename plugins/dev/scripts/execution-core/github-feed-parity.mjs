// github-feed-parity.mjs — CTL-1929 ask (3). The field-level ledger that decides
// whether the GitHub feed may replace the smee tunnel.
//
// Twin of `linear-feed-parity.mjs`, and it exists as a SHIPPED MODULE rather than a
// session scratch script for the reason CTL-1916 was filed: the verification tool
// kept being re-derived, so no two cutover decisions were made on the same
// instrument. The record this produced on 2026-08-18 (151 events joined, 150
// agreeing on every compared field) is reproducible by running it again.
//
// ── ⛔ COUNTS ARE NOT PARITY ────────────────────────────────────────────────
// Two streams can agree exactly on volume and disagree on every value. The join is
// therefore on a STABLE PER-NAME KEY and the comparison is FIELD BY FIELD, over the
// fields `broker/router.mjs` actually destructures — not over the whole envelope.
// Comparing whole envelopes would report a permanent, meaningless diff: the feed
// copy legitimately differs in `id`, `ts`, `traceId`, `event.channel`, and the
// `body.payload.source` stamp that is the entire point of being distinguishable.
// Those are listed in EXPECTED_DIVERGENCES so they are excluded BY NAME, and a field
// that starts diverging cannot hide inside a blanket exclusion.
//
// ── ⚠️ AND EQUAL FIELDS ARE NOT NECESSARILY A FAITHFUL REPLAY ──────────────
// The replica's mutable columns hold the value NOW, not the value at the edge, so a
// field can agree today and diverge whenever the row is later updated. `draft` and
// `mergeable` are exactly that; the ledger records them as OBSERVED-ONLY so a clean
// run cannot be read as a guarantee about them.
//
// ── THE VERDICT IS THREE-VALUED ────────────────────────────────────────────
// clean / diverged / INCONCLUSIVE. A window in which one side is empty, or in which
// a name produced nothing on either side, is INCONCLUSIVE — never clean. `[].every()`
// is `true`, and a ledger that reports agreement because it compared nothing is the
// exact false-clean this repo keeps re-learning.

/** Fields that MUST differ between the two producers. Excluded by name, never by prefix. */
export const EXPECTED_DIVERGENCES = Object.freeze([
  "id", "ts", "observedTs", "traceId", "spanId",
  "attributes.event.channel",
  "attributes.webhook.delivery.id",
  "body.payload.source",
  "body.payload.feedAuthority",
]);

/**
 * Fields whose equality is OBSERVED but NOT GUARANTEED, because the replica stores
 * current state rather than the value at the edge. Reported separately so a clean
 * ledger cannot be read as a claim about them.
 */
export const OBSERVED_ONLY_FIELDS = Object.freeze([
  "body.payload.draft",
  "body.payload.mergeable",
]);

/**
 * The join key per name, and the fields compared for it.
 *
 * A name absent from this table is not compared and is counted as `unkeyable` — it
 * is never silently treated as agreeing.
 */
const COMPARE_SPEC_DRAFT = {
  "github.pr.opened": {
    key: (e) => `${e.attributes?.["vcs.repository.name"]}#${e.attributes?.["vcs.pr.number"]}`,
    attrs: ["vcs.repository.name", "vcs.pr.number", "event.entity", "event.action", "event.label", "event.stream_class"],
    payload: ["action", "merged", "mergedAt", "draft", "mergeable"],
  },
  "github.pr.closed": {
    key: (e) => `${e.attributes?.["vcs.repository.name"]}#${e.attributes?.["vcs.pr.number"]}`,
    attrs: ["vcs.repository.name", "vcs.pr.number", "event.entity", "event.action", "event.label", "event.stream_class"],
    payload: ["action", "merged", "draft"],
  },
  "github.pr_review.submitted": {
    // `reviews.review_id` is not on the webhook side, so the key is the tuple the
    // consumer itself keys on plus the reviewer — coarser, and honest about it.
    key: (e) => `${e.attributes?.["vcs.repository.name"]}#${e.attributes?.["vcs.pr.number"]}|${e.body?.payload?.reviewer}|${e.body?.payload?.state}`,
    attrs: ["vcs.repository.name", "vcs.pr.number", "event.entity", "event.action"],
    payload: ["state", "reviewer", "author"],
  },
  "github.pr_review_comment.created": {
    key: (e) => `c:${e.body?.payload?.commentId}`,
    attrs: ["vcs.repository.name", "vcs.pr.number", "event.entity", "event.action", "event.label", "event.stream_class"],
    payload: ["commentId", "body", "htmlUrl", "author"],
  },
  "github.pr_review_thread.resolved": {
    key: (e) => `${e.attributes?.["vcs.repository.name"]}#${e.attributes?.["vcs.pr.number"]}`,
    attrs: ["vcs.repository.name", "vcs.pr.number", "event.entity", "event.action"],
    payload: ["threadId"],
  },
  "github.deployment.created": {
    key: (e) => `d:${e.body?.payload?.deploymentId}`,
    attrs: ["vcs.repository.name", "vcs.revision", "vcs.ref.name", "deployment.environment", "deployment.id", "event.label"],
    payload: ["deploymentId"],
  },
  "github.push": {
    key: (e) => `p:${e.attributes?.["vcs.repository.name"]}|${e.attributes?.["vcs.ref.name"]}|${e.body?.payload?.headSha}`,
    attrs: ["vcs.repository.name", "vcs.ref.name", "vcs.revision", "event.entity", "event.action", "event.label"],
    payload: ["baseSha", "headSha"],
  },
};

// `deployment_status` is one name per state, so the rows are generated rather than
// typed out — and the object is frozen only AFTER they are added. Freezing the
// literal first would silently drop them in a sloppy runtime and throw in a strict
// one; both are worse than never comparing the name at all, which is what a missing
// spec quietly does.
for (const state of ["success", "failure", "error", "in_progress", "pending", "queued", "inactive"]) {
  COMPARE_SPEC_DRAFT[`github.deployment_status.${state}`] = {
    key: (e) => `ds:${e.body?.payload?.deploymentId}|${e.body?.payload?.state}`,
    attrs: ["vcs.repository.name", "deployment.environment", "deployment.id", "event.entity", "event.action"],
    payload: ["deploymentId", "state", "targetUrl", "environmentUrl"],
  };
}

/** The join key per name, and the fields compared for it. Frozen once complete. */
export const COMPARE_SPEC = Object.freeze(COMPARE_SPEC_DRAFT);

/**
 * Names the orchestrator consumes that the producer cannot emit yet. Their absence
 * from the feed side is EXPECTED and is reported as such — not as a divergence, and
 * not silently ignored either.
 */
export const KNOWN_ABSENT = Object.freeze({
  "github.pr.merged": "CTC-691: pull_requests has no merge_commit_sha",
  "github.check_suite.completed": "CTC-667 item 4: the mirror stores no suite row",
});

const nameOf = (e) => e?.attributes?.["event.name"];
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Compare a feed stream against a webhook stream.
 *
 * Both arrays are the events already filtered to one window by the caller — the
 * windowing is deliberately not done here so the comparator stays pure and testable.
 */
export function compareGithubStreams(feedEvents, smeeEvents) {
  const feed = Array.isArray(feedEvents) ? feedEvents : [];
  const smee = Array.isArray(smeeEvents) ? smeeEvents : [];

  const inconclusive = [];
  if (feed.length === 0) inconclusive.push("feed-side-empty");
  if (smee.length === 0) inconclusive.push("smee-side-empty");

  // ⛔ MULTIPLICITY, NOT PRESENCE — a single-value map is a false-clean generator.
  // Some join keys are deliberately COARSE (a review keys on repo/pr/reviewer/state
  // because `review_id` is not on the webhook side), so repeats under one key are
  // expected, not pathological. With a `Map<key, event>` a second webhook event
  // OVERWRITES the first and every feed event under that key re-uses the one
  // surviving twin — so 2 feed vs 1 smee, and 1 feed vs 2 smee, both report agreement.
  // That is the ledger licensing a cutover across dropped or duplicated dispatches,
  // which is the single worst thing this file could do. `linear-feed-parity.mjs`
  // already compares by multiplicity for exactly this reason; that lesson is carried
  // here rather than re-learned.
  const index = new Map();
  for (const e of smee) {
    const n = nameOf(e);
    const spec = COMPARE_SPEC[n];
    if (!spec) continue;
    const k = `${n}|${spec.key(e)}`;
    const bucket = index.get(k);
    if (bucket) bucket.push(e);
    else index.set(k, [e]);
  }

  const byName = {};
  let unkeyable = 0;
  for (const e of feed) {
    const n = nameOf(e);
    const spec = COMPARE_SPEC[n];
    if (!spec) {
      unkeyable += 1;
      continue;
    }
    const row = (byName[n] ??= { joined: 0, unjoined: 0, agree: 0, diffs: {}, observedOnly: {} });
    const bucket = index.get(`${n}|${spec.key(e)}`);
    // CONSUMED, so one twin can serve exactly one feed event.
    const twin = bucket && bucket.length > 0 ? bucket.shift() : null;
    if (!twin) {
      // Ambiguous rather than disagreeing: it may be a window-skew artefact, or it may
      // be a spurious dispatch. ⛔ It is NOT evidence of parity either way, so it
      // forces INCONCLUSIVE below — never a silent pass. It is counted here and
      // deliberately never folded into `agree`.
      row.unjoined += 1;
      continue;
    }
    row.joined += 1;
    let ok = true;
    for (const f of spec.attrs) {
      if (eq(e.attributes?.[f], twin.attributes?.[f])) continue;
      ok = false;
      (row.diffs[`attributes.${f}`] ??= []).push({ feed: e.attributes?.[f], smee: twin.attributes?.[f] });
    }
    for (const f of spec.payload) {
      if (eq(e.body?.payload?.[f], twin.body?.payload?.[f])) continue;
      const path = `body.payload.${f}`;
      if (OBSERVED_ONLY_FIELDS.includes(path)) {
        // Divergence here is EXPECTED whenever the row was mutated after its edge.
        // Recorded, and deliberately not counted against cleanliness.
        (row.observedOnly[path] ??= []).push({ feed: e.body?.payload?.[f], smee: twin.body?.payload?.[f] });
        continue;
      }
      ok = false;
      (row.diffs[path] ??= []).push({ feed: e.body?.payload?.[f], smee: twin.body?.payload?.[f] });
    }
    if (ok) row.agree += 1;
  }

  // A name present on the smee side and wholly absent from the feed side is either a
  // declared gap or a real hole — and the two must never look alike.
  const absent = {};
  for (const e of smee) {
    const n = nameOf(e);
    if (byName[n]) continue;
    absent[n] = (absent[n] ?? 0) + 1;
  }
  const unexplainedAbsent = Object.fromEntries(
    Object.entries(absent).filter(([n]) => !(n in KNOWN_ABSENT) && n in COMPARE_SPEC),
  );

  // Twins nobody consumed: a webhook event the feed produced no counterpart for.
  // Symmetric to `unjoined` and equally not-evidence — an unconsumed twin is either
  // window skew or a MISSING dispatch, and a ledger that ignores it certifies a feed
  // that silently drops events.
  let smeeUnjoined = 0;
  for (const bucket of index.values()) smeeUnjoined += bucket.length;

  const totals = Object.values(byName).reduce(
    (a, r) => ({ joined: a.joined + r.joined, agree: a.agree + r.agree, unjoined: a.unjoined + r.unjoined }),
    { joined: 0, agree: 0, unjoined: 0 },
  );
  totals.smeeUnjoined = smeeUnjoined;
  if (totals.joined === 0) inconclusive.push("no-events-joined");
  if (unkeyable > 0) inconclusive.push(`feed-unkeyable-events:${unkeyable}`);
  // ⛔ Both directions force INCONCLUSIVE. `[1,2]` vs `[1]` used to return clean:true
  // because the predicate only looked at `joined - agree`; the extra event may be a
  // duplicate or a spurious dispatch, and "I cannot tell" is not "they match".
  if (totals.unjoined > 0) inconclusive.push(`feed-events-without-a-twin:${totals.unjoined}`);
  if (smeeUnjoined > 0) inconclusive.push(`smee-events-without-a-twin:${smeeUnjoined}`);

  const diverged = totals.joined - totals.agree;
  return {
    totals,
    byName,
    unkeyable,
    smeeUnjoined,
    expectedAbsent: Object.fromEntries(Object.entries(absent).filter(([n]) => n in KNOWN_ABSENT)),
    unexplainedAbsent,
    inconclusive,
    // ⛔ Clean requires POSITIVE evidence: something was actually joined, nothing was
    // inconclusive, nothing diverged, and no consumed name went silently missing.
    clean:
      inconclusive.length === 0 &&
      totals.joined > 0 &&
      diverged === 0 &&
      Object.keys(unexplainedAbsent).length === 0,
  };
}

/** 0 clean · 2 diverged · 3 inconclusive. Same contract as the Linear leg's runner. */
export function parityExitCode(report) {
  if (!report) return 3;
  if (report.inconclusive.length > 0) return 3;
  return report.clean ? 0 : 2;
}
