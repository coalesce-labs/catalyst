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
  // ⭐ Comparable since CTC-691 (schema 0.1.17). ⛔ `mergeCommitSha` is compared and
  // must never move to OBSERVED_ONLY: it is the JOIN KEY the deploy chain matches on
  // (`setFilterStateMerged` → `github.deployment.created`'s
  // `WHERE merge_commit_sha = ?`). A ledger that read `clean` while the two producers
  // disagreed on it would be certifying the exact failure this name exists to prevent.
  //
  // ⚠️ `mergedAt` IS compared, and it is the field most likely to diverge first: the
  // feed reads `pull_requests.merged_at` and renders ISO-8601, while the webhook
  // copies GitHub's own string. Both are UTC ISO — asserted rather than assumed, and
  // if it ever diverges the ledger should say so loudly rather than have it excluded
  // here in advance.
  "github.pr.merged": {
    key: (e) => `${e.attributes?.["vcs.repository.name"]}#${e.attributes?.["vcs.pr.number"]}`,
    // ⚠️ `vcs.revision` is deliberately NOT compared and NOT emitted — the webhook
    // does not set it on this name. It was in both for one round; the ledger caught it.
    attrs: ["vcs.repository.name", "vcs.pr.number", "event.entity", "event.action", "event.label", "event.stream_class"],
    payload: ["action", "merged", "mergedAt", "mergeCommitSha", "draft", "mergeable"],
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
  // ⭐ CTC-712 (schema 0.1.18).
  //
  // ⛔ `body.payload.prNumbers` IS THE ROUTE and is compared. `router.mjs:1497` reaches
  // an interest through `eventPrs.find(...)` over `detail.prNumbers`, and
  // `getEventPayload` resolves that to `body.payload` — never to the attributes. A
  // suite event whose payload association disagrees with the webhook's wakes the wrong
  // waiter or none, while every count still reads "emitted". That is the failure
  // CTC-712 exists to close, so the ledger must be able to see it.
  //
  // ⚠️ `attributes["vcs.pr.number"]` is NOT compared, and an earlier version of this
  // comment asserted the opposite — that it "IS the route and must never move to
  // OBSERVED_ONLY". **That was wrong**, and reading the router rather than repeating
  // the claim is what corrected it: the attribute is bridged only into `getEventScope`,
  // and this name's branch never reads `scope`. It is display and observability.
  //
  // It is excluded because the two producers fill it from sources that cannot be made
  // to agree, on a measured population. When GitHub sends an empty `pull_requests`
  // array — **983 of 3,654 live suite events since 2026-08-17, 26.9%** — the webhook
  // falls back to an in-memory SHA→PR cache (CTL-396) and resolves **355** of them.
  // That cache is a HISTORICAL sha→PR map; the replica's `pull_requests` is a
  // LAST-STATE projection that forgets a PR's earlier heads, so only 18 of 88 such
  // suites still match a current head. The producer therefore reproduces the exact
  // subset it can read exactly — `refs/pull/<N>/head`, measured 66 agreements and 0
  // disagreements — and leaves the attribute absent otherwise, as the webhook does for
  // a `main`-branch suite (56 of those 88).
  //
  // ⛔ Comparing it anyway would leave ~27% of the smee side permanently unjoinable and
  // the ledger unable to reach CLEAN for a difference that changes no dispatch. That is
  // a false BLOCKER, the same shape as the repo-scoping one #3551 fixed — and excluding
  // a field that DID route would be the false-clean in the other direction, which is
  // why the routing question was settled in the router's source before this line moved.
  //
  // ⚠️ THE KEY IS COARSE, AND DELIBERATELY SO. Neither side carries `check_suite_id`
  // (the webhook payload has no suite id in the envelope), and one head sha carried
  // **10 distinct suite ids** on mini-2 — so no exact per-suite key is constructible
  // from what both producers emit. The tuple below can therefore bucket several real
  // suites together. That is safe ONLY because the index compares by MULTIPLICITY:
  // N feed events under a key must meet N smee events under it, so a dropped or
  // duplicated suite still surfaces as an unjoined count rather than being absorbed.
  // With a single-value index this key would be a false-clean generator.
  "github.check_suite.completed": {
    // ⛔ THE KEY CANNOT USE `vcs.pr.number` EITHER. It is exactly the field the two
    // producers may legitimately differ on, so keying with it would split an agreeing
    // pair into two unjoined singletons — a divergence reported as an ABSENCE, which is
    // the harder failure to diagnose. Keyed on what both sides derive identically.
    key: (e) =>
      `cs:${e.attributes?.["vcs.repository.name"]}|${e.attributes?.["vcs.revision"] ?? ""}` +
      `|${e.attributes?.["cicd.pipeline.run.conclusion"] ?? ""}` +
      `|${JSON.stringify(e.body?.payload?.prNumbers ?? [])}`,
    attrs: [
      // ⚠️ `vcs.pr.number` and `event.label` are absent BY DESIGN — see above. The label
      // is `PR #<n>` built from the same value, so comparing it would re-introduce the
      // divergence through the back door.
      "vcs.repository.name", "vcs.revision",
      "cicd.pipeline.run.status", "cicd.pipeline.run.conclusion",
      "event.entity", "event.action", "event.stream_class",
    ],
    // `prNumbers` is compared as a whole array, not just its head: the attribute
    // carries only `[0]`, so a disagreement in the tail would otherwise be invisible.
    payload: ["conclusion", "status", "prNumbers"],
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
  // ⭐ `github.pr.merged` LEFT THIS TABLE when CTC-691 landed (schema 0.1.17), and
  // that removal is the point of the ticket rather than a side effect. While it was
  // here the ledger EXCUSED its absence — so the one name whose loss silently kills
  // the merge→deploy chain was precisely the one this instrument was configured not
  // to notice. A ledger that cannot fail on a name is not measuring it.
  //
  // ⭐ `github.check_suite.completed` LEFT THIS TABLE when CTC-712 landed (schema
  // 0.1.18, migration `0028_burly_nemesis`), and — exactly as with `pr.merged` before
  // it — the removal IS the point rather than a side effect. While it sat here the
  // ledger EXCUSED its absence, so the last name still keeping the smee tunnel alive
  // was the one name the instrument was configured not to be able to fail on. A
  // ledger that cannot fail on a name is not measuring it.
  //
  // ⚠️ THE TABLE IS NOW EMPTY, AND THAT IS LOAD-BEARING, not tidiness. `unexplained
  // Absent` is computed as `absent − KNOWN_ABSENT`, so every consumed name that goes
  // missing from the feed now blocks CLEAN. Adding an entry here is therefore a
  // deliberate act of blinding the instrument, and should be argued for on those
  // terms.
});

const nameOf = (e) => e?.attributes?.["event.name"];
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Compare a feed stream against a webhook stream.
 *
 * Both arrays are the events already filtered to one window by the caller — the
 * windowing is deliberately not done here so the comparator stays pure and testable.
 */
export const repoOf = (e) => e?.attributes?.["vcs.repository.name"] ?? null;

/**
 * The repos BOTH producers can see — the only population over which "did the feed
 * miss this?" is a meaningful question.
 *
 * ⛔ WHY THIS EXISTS. The two producers do not cover the same repositories, and the
 * asymmetry is not a bug on either side: the webhook subscription covers a repo set
 * an operator configured, while the mirror ingests whatever the cloud is told to
 * ingest. Measured on mini-2 over one live window:
 *
 *   smee delivers : catalyst · catalyst-cloud · ryanrozich/personal-os
 *   feed produces : catalyst · catalyst-cloud · catalyst-cloud-sdk · thoughts
 *
 * ⭐ So the feed is BROADER, and retiring the tunnel EXTENDS coverage rather than
 * shrinking it — backend's own SDK PR #26, part of tonight's 0.1.17 cascade, was
 * visible to the feed and never to the tunnel.
 *
 * ⛔ But before this scoping, the ledger counted every such event as
 * `feed-events-without-a-twin`, which forces INCONCLUSIVE. **The cutover gate was
 * therefore unmeetable for a reason that was not a fault** — 6 unjoined events over
 * 55 minutes, every one of them from a repo smee cannot deliver. That is the exact
 * mirror image of the false-clean corrected in CTL-48: the same instrument, wrong in
 * the other direction, and just as capable of driving a wrong decision.
 *
 * ⚠️ The scoping is deliberately derived from the SMEE side only. Taking the
 * intersection of both would also drop a repo the feed *should* cover and silently
 * does not — which is a real defect and must keep failing. Feed events outside the
 * smee repo set are reported as `feedOnlyRepos`, never dropped.
 */
export function smeeRepos(smeeEvents) {
  const repos = new Set();
  for (const e of smeeEvents) {
    const r = repoOf(e);
    if (typeof r === "string" && r !== "") repos.add(r);
  }
  return repos;
}

/**
 * Suite conclusions the MIRROR does not store, so the producer cannot emit them.
 *
 * ⛔ MEASURED, AND IT IS A REAL GAP — CTC-719, not a quirk. The replica's
 * `check_suites` holds only `success` / `cancelled` / `failure`; it has never held a
 * `neutral` or `skipped` one. Live counts (deduped by webhook delivery id, since
 * 2026-08-17): smee `success 3298 · neutral 245 · failure 114 · cancelled 84 ·
 * skipped 3` against a replica of `success 858 · cancelled 13 · failure 3`.
 * **248 of 3,748 (6.6%)** are structurally invisible. The control that makes it a
 * `check_suites` bug rather than a replica limitation is `check_runs` in the SAME
 * database, which stores `neutral 2366` and `skipped 1152` happily.
 *
 * ⚠️ Excluded here so the retirement gate is reachable, NOT because the gap is
 * closed. `router.mjs:1497` treats `neutral` as non-failing, so those events DO wake
 * a waiter today. Measured blast radius: 234 of the 245 carry a PR, across 62 PRs —
 * but **0 of 227 PRs had ONLY neutral conclusions**, so every one of them also got a
 * replicable suite and no PR would actually hang. That is a statistical property of
 * this fleet's CI configuration, not a structural guarantee, and it is why CTC-719 is
 * open rather than closed-as-acceptable.
 */
export const MIRROR_UNSTORED_SUITE_CONCLUSIONS = Object.freeze(["neutral", "skipped"]);

const suiteConclusionOf = (e) => e?.attributes?.["cicd.pipeline.run.conclusion"] ?? null;

/**
 * Is this a smee event the mirror provably cannot carry?
 *
 * ⭐ SELF-RETIRING, and that is the design's whole point. The exclusion applies only
 * while the FEED side produced none of these conclusions. The moment CTC-719 lands and
 * the producer emits its first `neutral` suite, this returns false for every event and
 * the two sides are compared normally again — with no line for anyone to remember to
 * delete, and no window in which a fixed mirror is still being excused. An exclusion
 * that cannot switch itself off is the shape of every stale `KNOWN_ABSENT` entry this
 * file has had to remove.
 */
function mirrorCannotCarry(e, feedHasThoseConclusions) {
  if (feedHasThoseConclusions) return false;
  if (nameOf(e) !== "github.check_suite.completed") return false;
  return MIRROR_UNSTORED_SUITE_CONCLUSIONS.includes(suiteConclusionOf(e));
}

export function compareGithubStreams(feedEvents, smeeEvents) {
  const feed = Array.isArray(feedEvents) ? feedEvents : [];
  const smee = Array.isArray(smeeEvents) ? smeeEvents : [];

  const inconclusive = [];
  if (feed.length === 0) inconclusive.push("feed-side-empty");
  if (smee.length === 0) inconclusive.push("smee-side-empty");

  // Partition the feed side by whether smee could have produced a twin at all.
  const comparableRepos = smeeRepos(smee);
  const feedOnly = [];
  const feedComparable = [];
  for (const e of feed) {
    // ⚠️ An event with NO repo attribute stays COMPARABLE. Treating it as feed-only
    // would let a malformed envelope excuse itself out of the comparison, which is
    // the shape of every false-clean in this file's history.
    const r = repoOf(e);
    if (typeof r === "string" && r !== "" && !comparableRepos.has(r)) feedOnly.push(e);
    else feedComparable.push(e);
  }
  const feedOnlyRepos = {};
  for (const e of feedOnly) {
    const r = repoOf(e);
    feedOnlyRepos[r] = (feedOnlyRepos[r] ?? 0) + 1;
  }

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
  // ⛔ NARROW, ENUMERATED, AND REPORTED — never a silent drop. See `mirrorCannotCarry`.
  const feedHasThoseConclusions = feed.some(
    (e) => nameOf(e) === "github.check_suite.completed"
      && MIRROR_UNSTORED_SUITE_CONCLUSIONS.includes(suiteConclusionOf(e)),
  );
  const mirrorUnstorable = {};
  const smeeComparable = [];
  for (const e of smee) {
    if (mirrorCannotCarry(e, feedHasThoseConclusions)) {
      const c = suiteConclusionOf(e);
      mirrorUnstorable[c] = (mirrorUnstorable[c] ?? 0) + 1;
      continue;
    }
    smeeComparable.push(e);
  }

  const index = new Map();
  for (const e of smeeComparable) {
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
  for (const e of feedComparable) {
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
    // ⭐ Reported, never dropped: an operator reading a clean verdict must still see
    // that the feed covered repos the tunnel did not, because that is a REASON TO
    // RETIRE rather than a caveat on retiring.
    feedOnlyRepos,
    // ⭐ Reported on every run, never dropped: an operator reading a clean verdict must
    // see that a measured slice of the webhook side was set aside, and which ticket
    // closes it. Symmetric with `feedOnlyRepos` — the count that explains itself.
    mirrorUnstorable,
    comparableRepos: [...comparableRepos].sort(),
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
