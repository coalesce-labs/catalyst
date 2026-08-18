// github-feed-event.mjs — CTL-1929. Zero-I/O leaf: classify one replica row into an
// emit/decline verdict, and build the v2 envelope for it.
//
// Twin of `linear-feed-event.mjs`. The envelope it produces must be readable by the
// SAME consumer that reads the smee copy today (`broker/router.mjs`), so this file's
// contract is not "a reasonable GitHub event" — it is **the exact fields that
// consumer destructures**, reproduced from the replica.
//
// ── ⛔ THE THREE FIELDS THAT ARE JOIN KEYS, NOT DISPLAY TEXT ────────────────
// Getting these wrong breaks a downstream chain while every event still routes:
//   `attributes["vcs.revision"]` on `deployment.created`   -> filter_state.merge_commit_sha
//   `body.payload.deploymentId`  on `deployment_status.*`  -> filter_state.deployment_id
//   `attributes["vcs.ref.name"]` on `push`                 -> the base-branch match
// The replica stores `deployments.id` / `deployment_statuses.deployment_id` as TEXT
// and the webhook envelope carries a NUMBER (its parser's `getNum`), so both are
// coerced here. A string 5936592703 does not match an integer 5936592703 in the
// broker's `WHERE deployment_id = ?`, and nothing would report the miss.
//
// ── ⛔ TWO FIELDS DELIBERATELY NOT EMITTED, AND ONE DELIBERATELY WRONG ──────
// 1. `github.pr.*` payloads carry NO `title` / `body` / `headRef`. The replica row
//    has all three and including them is the natural thing to do — but
//    `tryTicketLifecycleRoute` (`router.mjs:1856`) scrapes exactly those three for
//    ticket ids, and that path is DORMANT: measured 1,208/1,208 live `github.pr.*`
//    payloads contain none of them, so `prBodyTickets` is always `[]` and
//    `_autoPrLifecycleFromTicket` never fires. Emitting them would SWITCH ON a
//    dormant fleet-wide code path — a behavioural change wearing the costume of
//    better parity. The webhook parser reads them and drops them; so do we.
// 2. `pr_review_thread.resolved` emits `threadId: 0`, not the real id. Measured
//    202/202 live events carry `0`, because GitHub's thread object has no numeric
//    `id` and the parser's `getNum` returns its default. Our replica HAS a real
//    thread id and emitting it would be strictly nicer — and would break the
//    field-level parity that is the instrument this cutover is judged by. An
//    instrument that changes shape at the moment of cutover cannot judge the
//    cutover. The improvement is filed separately, to land after.
//
// ── ⚠️ ONLY IMMUTABLE-AFTER-THE-EDGE FIELDS REPLAY FAITHFULLY ──────────────
// The row's mutable columns hold the value NOW; the webhook held the value AT the
// moment of the edge. Measured against 3 h of real traffic (151 events joined on a
// stable key, 150 agreeing on every compared field), the single divergence was
// exactly this: one `pr.opened` carried `draft: false` from the replica where smee
// had said `draft: true` — a PR opened as a draft and later marked ready.
//
// `draft` and `mergeable` are therefore NOT faithfully replayable, and no field with
// that property should be added here without the same note. They are kept rather
// than dropped because removing them would itself be a payload-shape divergence, and
// because nothing reads them: `router.mjs` has no `pr.opened` branch at all, and
// `summarizeEvent`'s PAYLOAD_EXCERPT_KEYS are state/stateType/conclusion/title/
// merged/action. Everything else this file emits is written once and never moves.
//
// ── ⚠️ THE ONE VALUE THAT NEEDS NORMALISING ────────────────────────────────
// `reviews.state` is stored UPPERCASE (`COMMENTED`), the webhook emits GitHub's
// REST lowercase (`commented`), and the consumer compares with `===` against
// `"changes_requested"` / `"approved"` (`router.mjs:1539-1553`). Passing the stored
// value through would match NEITHER branch and the review gate would go quiet.
// ⚠️ BOUND, stated because it limits what this file can claim: **no `APPROVED` or
// `CHANGES_REQUESTED` row has ever been observed on this fleet** — 6,630/6,630
// replica rows and 3,093/3,093 live webhook events are `commented`. So the
// lowercase mapping is verified by content for `commented` ONLY; the other two are
// a documented convention, not a measurement, and the router branches they feed are
// themselves untested in production here.
//
// ── PROVENANCE ─────────────────────────────────────────────────────────────
// `body.payload.source = "cloud-feed"` is stamped POSITIVELY, and it is the whole
// reason the gate can tell our copy from smee's. `cloud-feed-gate.sourceOf` reads
// exactly that key; a producer that omits it classifies as SOURCE_OTHER and
// inherits no authority — deliberate, so an unknown third producer cannot acquire
// authority by default. `event.channel` is `"cloud-feed"` rather than `"webhook"`
// for the same reason (and because `webhook.delivery.id`, which is how `sourceOf`
// recognises smee NEGATIVELY, must NOT be stamped here).
//
// ⛔ `resource["service.name"]` stays `catalyst.github` — NOT `catalyst.execution-core`.
// `router.mjs`'s `recordLastSeen` folds that value into the CTL-1122 ingestion-recency
// map, whose `RECENCY_SOURCES` watches `catalyst.github`. Stamping our own service
// name would leave the github ingestion-SILENCE detector believing github had gone
// quiet at the exact moment we became its only producer.

import { buildCanonicalEvent } from "./lib/canonical-event.mjs";
import { STREAM_BY_KEY } from "./github-feed-source.mjs";
import {
  GITHUB_CONSUMED_NAMES,
  GITHUB_UNCOVERED_NAMES as LEAF_UNCOVERED_NAMES,
} from "../lib/github-feed-names.mjs";

/** The service identity every `github.*` event must carry. See the header. */
export const GITHUB_SERVICE_NAME = "catalyst.github";

/** Positive provenance stamp, read by `cloud-feed-gate.sourceOf`. */
export const SOURCE_CLOUD_FEED = "cloud-feed";

/**
 * The `github.*` names this producer can emit today.
 *
 * ⛔ `github.pr.merged` and `github.check_suite.completed` are consumed by the
 * orchestrator and are NOT here, each for a measured reason:
 *   `pr.merged`            — `pull_requests` has no `merge_commit_sha` (CTC-691).
 *                            The sha is a join key for the whole deploy chain, so a
 *                            twin without it routes and wakes while silently
 *                            breaking `monitor-deploy`. A named gap beats that.
 *   `check_suite.completed`— the mirror stores no suite row (CTC-667 item 4), and
 *                            `check_runs` cannot stand in: one head sha carried 10
 *                            distinct suite ids, several incomplete, so "every run
 *                            I can see finished" fires early and GREEN on the merge
 *                            gate.
 * Exported so the parity ledger accounts for them as EXPECTED absences rather than
 * as unexplained diffs, and so nothing can claim coverage this producer lacks.
 */
export const GITHUB_DISPATCH_CLASS_NAMES = Object.freeze(
  GITHUB_CONSUMED_NAMES.filter((n) => !LEAF_UNCOVERED_NAMES.includes(n)),
);

/**
 * ⛔ RE-EXPORTED FROM `lib/github-feed-names.mjs`, NOT DECLARED HERE.
 *
 * These lists used to live in this file, which was right while the producer and the
 * gate were the only readers. `catalyst doctor` became a third reader (it must name
 * which github.* events a declared-cloud node cannot see) and runs under bare Node,
 * which cannot load this module at all — so the lists moved to a zero-import leaf.
 *
 * ⚠️ CI CAUGHT THE HALF-DONE VERSION OF EXACTLY THIS. The move (#3540) pointed the
 * GATE at the leaf but left this file's own copies in place, and the next change
 * (#3544, removing `pr.merged` on CTC-691) edited the copy the gate no longer reads.
 * Locally both passed, because that branch predated the move; on main the two lists
 * disagreed and the gate kept excluding a name the producer had started emitting.
 * One source or it drifts — this file now derives.
 */
export const GITHUB_UNCOVERED_NAMES = LEAF_UNCOVERED_NAMES;

/**
 * Streams the source can PAGE but this file cannot turn into a faithful event, keyed
 * to the reason and the ticket that closes it. Declining by name keeps the gap
 * counted rather than silent — see `classifyGithubRow`.
 *
 * `prMerged` is deliberately still a STREAM in `github-feed-source.mjs`: paging it
 * costs nothing, proves the keyset works for it, and means CTC-691 lands as a one-
 * line deletion here rather than as new read-layer code.
 */
export const UNCOVERED_STREAM_REASONS = Object.freeze({
  // ⭐ EMPTY SINCE CTC-691 LANDED (schema 0.1.17). `pull_requests.merge_commit_sha`
  // exists and is populated, so `prMerged` emits — the stream was deliberately kept
  // paging all along so this would be a deletion here rather than new read-layer code,
  // and it was.
  //
  // ⛔ A row whose `merge_commit_sha` is NULL still declines, but per ROW rather than
  // per STREAM — see `classifyGithubRow`. Pre-0.1.17 merges were never backfilled, so
  // those rows exist and must not emit a twin without the join key.
});

/**
 * `User` | `Bot`, derived from the login itself rather than from a join.
 *
 * ⭐ The join was the tempting answer and it is measurably worse. `users` carries a
 * GitHub `type` (`human`/`app`) but its coverage is INCOMPLETE: of 5 distinct review
 * authors on mini-2, only 4 had a `users` row — and the missing one,
 * `github:github-code-quality[bot]`, is a BOT. A left join would have yielded a null
 * type for it, `isBot` would read false, and a bot review would be handled as a
 * human's on the review gate.
 *
 * The `[bot]` suffix is GitHub's reserved marker for App accounts and it has 100%
 * coverage here by construction. Positive control on the rule: over all 12 GitHub
 * identities in `users`, `id LIKE '%[bot]'` agrees with `type = 'app'` **12/12, zero
 * disagreements**.
 *
 * ⚠️ Bound: that is a convention validated on 12 identities, not a guarantee from
 * GitHub's API. It is the best available signal from the data the replica carries.
 */
export function authorTypeOf(login) {
  return typeof login === "string" && login.endsWith("[bot]") ? "Bot" : "User";
}

/**
 * Replica actor ids are namespaced `github:<login>`; the envelope carries the bare
 * login. Returns `""` for anything unusable, matching the webhook parser's `getStr`,
 * which yields an empty string and never null.
 */
export function loginOf(actorId) {
  if (typeof actorId !== "string" || actorId === "") return "";
  return actorId.startsWith("github:") ? actorId.slice("github:".length) : actorId;
}

/** `{login, type}`, the shape `router.mjs` destructures for the bot check. */
export function authorOf(actorId) {
  const login = loginOf(actorId);
  return { login, type: authorTypeOf(login) };
}

/**
 * The stable identity of one edge.
 *
 * ⛔ This is load-bearing, not cosmetic. The producer re-reads the settle window
 * every tick (see `github-feed-source.mjs`), and the broker dedups on the
 * PER-EMISSION UUID `id` — so it will NOT suppress a re-emission for us. This id is
 * what the producer's own seen-set keys on, and it must therefore be derived only
 * from PRIMARY KEY columns plus the edge name: anything mutable would change between
 * reads and defeat the very dedup it exists to serve.
 */
export function githubEdgeId(streamKey, row) {
  const s = STREAM_BY_KEY[streamKey];
  if (!s || !row) return null;
  const id = row.__id;
  if (id === undefined || id === null || id === "") return null;
  // ⛔ A STREAM WHOSE ROW IS MUTATED IN PLACE HAS NO PER-EDGE PRIMARY KEY.
  // `pushes` is keyed `(repo_id, ref)` and rewritten on every push, so `__id` is the
  // same string for every push to a branch, forever. Keying the seen-set on it alone
  // suppressed the second and all later pushes to a ref as re-reads — `github.push`
  // dead after the first one, silently, taking rebase detection with it. Folding in
  // the row's own coordinate plus the sha it landed on restores a per-edge identity:
  // both change on a real push, and BOTH are stable across re-reads of the same push,
  // which is what the settle-window re-read requires.
  if (s.mutableRow) {
    const ts = Number.isInteger(row.__ts) ? row.__ts : "?";
    const at = typeof row.after === "string" && row.after !== "" ? row.after : "?";
    return `gh:${streamKey}:${String(id)}:${ts}:${at}`;
  }
  return `gh:${streamKey}:${String(id)}`;
}

/**
 * Decide whether a row is emittable, and say why when it is not.
 *
 * The decline/fail split follows the Linear leg's rule verbatim, because readiness
 * is computed from it: **would un-arming the producer repair this?** A single
 * malformed row is a DECLINE (un-arming fixes nothing and would hand dispatch back
 * to a tunnel we are trying to retire). A condition that would make EVERY row
 * unemittable is a FAILURE and is marked `fatal`.
 */
export function classifyGithubRow(streamKey, row) {
  const s = STREAM_BY_KEY[streamKey];
  if (!s) return { emit: false, reason: "unknown-stream", fatal: true };
  // ⛔ A stream whose rows we can READ but whose EVENT we cannot build faithfully
  // declines HERE, with a reason, rather than falling through to a `null` envelope.
  // A silent null is the "success and failure are byte-identical to the caller"
  // shape: the sweep would count neither an emit nor a decline and the gap would be
  // invisible in the very counts readiness is computed from. Declining instead makes
  // it appear in `byReason` every tick, named after the ticket that closes it.
  const uncovered = UNCOVERED_STREAM_REASONS[streamKey];
  if (uncovered) return { emit: false, reason: uncovered };
  if (!row || typeof row !== "object") return { emit: false, reason: "row-not-an-object" };
  if (typeof row.repo_id !== "string" || row.repo_id === "") {
    return { emit: false, reason: "no-repo" };
  }
  if (!Number.isInteger(row.__ts)) return { emit: false, reason: "no-edge-timestamp" };
  if (githubEdgeId(streamKey, row) === null) return { emit: false, reason: "no-edge-id" };

  // PR-scoped streams are useless to the consumer without a PR number: every one of
  // their router branches gates on `prList.includes(scope.pr)` first.
  const prScoped = new Set([
    "prOpened", "prClosed", "prMerged", "reviewSubmitted", "reviewCommentCreated", "threadResolved",
  ]);
  if (prScoped.has(streamKey)) {
    const n = streamKey === "prOpened" || streamKey === "prClosed" || streamKey === "prMerged"
      ? row.number
      : row.pr_number;
    if (!Number.isInteger(n) || n <= 0) return { emit: false, reason: "no-pr-number" };
  }
  // ⛔ `mergeCommitSha` IS THE JOIN KEY, and a merged twin without it is worse than no
  // twin at all. `router.mjs:1513` writes it via `setFilterStateMerged` and
  // `github.deployment.created` later matches `WHERE merge_commit_sha = ?`. An event
  // missing it still routes and still wakes `monitor-merge` normally, so it LOOKS
  // like success — while `monitor-deploy` stops firing for that PR, permanently,
  // with no smee copy under `enforce`.
  //
  // ⚠️ These rows are real, not hypothetical: CTC-691 added the column without a
  // backfill (COORD-124 names the 4,230 pre-existing PR rows), so every merge that
  // predates the 0.1.17 pin has it NULL. They decline, visibly, in `byReason` —
  // exactly the posture `deploymentCreated` takes for its own sha below.
  if (streamKey === "prMerged" && (typeof row.merge_commit_sha !== "string" || row.merge_commit_sha === "")) {
    return { emit: false, reason: "no-merge-commit-sha:not-backfilled" };
  }
  if (streamKey === "pushEvent" && (typeof row.ref !== "string" || row.ref === "")) {
    return { emit: false, reason: "no-ref" };
  }
  if (streamKey === "deploymentStatus" && (typeof row.state !== "string" || row.state === "")) {
    return { emit: false, reason: "no-deployment-state" };
  }
  if (streamKey === "push" && (typeof row.ref !== "string" || row.ref === "")) {
    return { emit: false, reason: "no-ref" };
  }
  // ⛔ `vcs.revision` on this name is the JOIN KEY `setFilterStateDeploying` matches
  // against `filter_state.merge_commit_sha`. Emitting `""` produces an event that is
  // counted as emitted, routes to no interest, and leaves the deployment lifecycle
  // parked forever — an unroutable event is worse than a declined row, because the
  // decline is visible in `byReason` and the emission looks like success.
  if (streamKey === "deploymentCreated" && (typeof row.sha !== "string" || row.sha === "")) {
    return { emit: false, reason: "no-deployment-sha" };
  }
  return { emit: true, reason: null };
}

/** The event name for a row (the one per-row name is `deployment_status.<state>`). */
export function githubEventName(streamKey, row) {
  const s = STREAM_BY_KEY[streamKey];
  if (!s) return null;
  if (s.event) return s.event;
  if (streamKey === "deploymentStatus") return `github.deployment_status.${row?.state}`;
  return null;
}

// `event.stream_class` is stamped by orch-monitor's builder, not execution-core's,
// and every `github.*` name classifies the same way (the "github." prefix is in
// COORDINATION_PREFIXES). Stated as a constant so the feed copy does not silently
// lose a dimension the webhook copy carries into Loki.
const STREAM_CLASS = "coordination";

function envelope({ name, entity, action, label, attrs, payload, message, severityText = "INFO", severityNumber = 9 }, seams) {
  const built = buildCanonicalEvent(
    {
      name,
      serviceName: GITHUB_SERVICE_NAME,
      severityText,
      severityNumber,
      attributes: {
        ...attrs,
        "event.entity": entity,
        "event.action": action,
        "event.channel": SOURCE_CLOUD_FEED,
        ...(label !== undefined ? { "event.label": label } : {}),
        "event.stream_class": STREAM_CLASS,
      },
      payload: { ...payload, source: SOURCE_CLOUD_FEED },
    },
    seams,
  );
  // `buildCanonicalEvent` forces `body.message = name`; the webhook copy carries a
  // human sentence, and `summarizeEvent` puts `body.message.slice(0,200)` into every
  // wake an agent reads. Restoring it keeps that surface unchanged. Assigning an
  // existing key does not move it in JS insertion order, so the wire shape is intact.
  built.body.message = message;
  return built;
}

/**
 * Build the v2 envelope for one row. Returns `null` when the row is not emittable —
 * callers classify first and route the reason; this is the belt to that braces.
 */
export function buildGithubEvent(streamKey, row, seams) {
  if (!classifyGithubRow(streamKey, row).emit) return null;
  const repo = row.repo_id;
  const name = githubEventName(streamKey, row);
  if (!name) return null;

  switch (streamKey) {
    case "prOpened":
    case "prClosed": {
      const action = streamKey === "prOpened" ? "opened" : "closed";
      return envelope({
        name,
        entity: "pr",
        action,
        label: `PR #${row.number}`,
        attrs: { "vcs.repository.name": repo, "vcs.pr.number": row.number },
        message: `${name} for ${repo} PR #${row.number}`,
        payload: {
          action,
          // ⛔ `router.mjs:1525` tests `detail.merged === false` STRICTLY. A missing
          // or truthy-coerced value silently fails to match and the closed-without-
          // merging branch never fires.
          merged: false,
          mergedAt: null,
          // Not carried by the replica (CTC-691). Null rather than absent, matching
          // the webhook's `getOptStr`. Neither router branch for these two names
          // reads it — only `pr.merged` does, which is why `pr.merged` is withheld.
          mergeCommitSha: null,
          draft: row.draft === 1 || row.draft === true,
          mergeable: row.mergeable === null || row.mergeable === undefined
            ? null
            : row.mergeable === 1 || row.mergeable === true,
        },
      }, seams);
    }

    case "reviewSubmitted": {
      const author = authorOf(row.user_id);
      return envelope({
        name,
        entity: "pr_review",
        action: "submitted",
        label: `PR #${row.pr_number}`,
        attrs: { "vcs.repository.name": repo, "vcs.pr.number": row.pr_number },
        message: `${name} for ${repo} PR #${row.pr_number} by ${author.login}`,
        payload: {
          // See the header: stored UPPERCASE, compared lowercase by the consumer.
          state: typeof row.state === "string" ? row.state.toLowerCase() : "",
          // The webhook reads `reviewer` and `author.login` from the SAME source, so
          // they are always equal; reproduced rather than "improved".
          reviewer: author.login,
          body: typeof row.body === "string" ? row.body : "",
          author,
        },
      }, seams);
    }

    case "reviewCommentCreated": {
      const author = authorOf(row.author_id);
      const commentId = Number(row.id);
      return envelope({
        name,
        entity: "pr_review_comment",
        action: "created",
        label: `PR #${row.pr_number}`,
        attrs: { "vcs.repository.name": repo, "vcs.pr.number": row.pr_number },
        // ⚠️ "on", not "for" — the webhook's template differs for this one name.
        message: `${name} on ${repo} PR #${row.pr_number} by ${author.login}`,
        payload: {
          commentId: Number.isFinite(commentId) ? commentId : 0,
          body: typeof row.body === "string" ? row.body : "",
          // Not a stored column. Reconstructed from GitHub's stable permalink form
          // — the consumer puts this straight into the wake reason an agent reads,
          // so an empty string here degrades a human-facing surface.
          htmlUrl: `https://github.com/${repo}/pull/${row.pr_number}#discussion_r${row.id}`,
          author,
        },
      }, seams);
    }

    case "threadResolved": {
      return envelope({
        name,
        entity: "pr_review_thread",
        action: "resolved",
        label: `PR #${row.pr_number}`,
        attrs: { "vcs.repository.name": repo, "vcs.pr.number": row.pr_number },
        message: `${name} for ${repo} PR #${row.pr_number}`,
        // ⛔ Literal 0, deliberately — see the header. Not `row.id`.
        payload: { threadId: 0 },
      }, seams);
    }

    case "deploymentCreated": {
      const deploymentId = Number(row.id);
      const environment = typeof row.environment === "string" ? row.environment : "";
      return envelope({
        name,
        entity: "deployment",
        action: "created",
        label: environment,
        attrs: {
          "vcs.repository.name": repo,
          // ⛔ THE JOIN KEY against filter_state.merge_commit_sha.
          "vcs.revision": typeof row.sha === "string" ? row.sha : "",
          "vcs.ref.name": typeof row.ref === "string" ? row.ref : "",
          "deployment.environment": environment,
          "deployment.id": Number.isFinite(deploymentId) ? deploymentId : 0,
        },
        // ⚠️ "in", not "for".
        message: `${name} in ${repo} env ${environment}`,
        payload: {
          deploymentId: Number.isFinite(deploymentId) ? deploymentId : 0,
          // `deployment.payload_url` is not mirrored; the webhook's own value is
          // null in practice and no consumer reads it.
          payloadUrl: null,
        },
      }, seams);
    }

    case "deploymentStatus": {
      const deploymentId = Number(row.deployment_id);
      const environment = typeof row.environment === "string" ? row.environment : "";
      const failed = row.state === "failure" || row.state === "error";
      return envelope({
        name,
        entity: "deployment_status",
        action: row.state,
        label: environment,
        attrs: {
          "vcs.repository.name": repo,
          "deployment.environment": environment,
          "deployment.id": Number.isFinite(deploymentId) ? deploymentId : 0,
        },
        message: `${name} in ${repo} env ${environment}`,
        severityText: failed ? "ERROR" : "INFO",
        severityNumber: failed ? 17 : 9,
        payload: {
          // ⛔ THE JOIN KEY: filter-state matches `WHERE deployment_id = ?`. Coerced
          // to a number because the replica stores it as TEXT and the webhook copy
          // carries a number.
          deploymentId: Number.isFinite(deploymentId) ? deploymentId : 0,
          state: row.state,
          targetUrl: typeof row.target_url === "string" && row.target_url !== "" ? row.target_url : null,
          environmentUrl:
            typeof row.environment_url === "string" && row.environment_url !== "" ? row.environment_url : null,
        },
      }, seams);
    }

    // ⭐ CTC-704: identical envelope to `push`, from a per-DELIVERY row. Sharing the
    // case is deliberate — the two streams differ in WHICH ROWS they yield, never in
    // what an event looks like, and a second copy of this builder is how the feed
    // copy and its own replacement would drift apart on a field the consumer reads.
    case "pushEvent":
    case "push": {
      const headSha = typeof row.after === "string" ? row.after : "";
      return envelope({
        name,
        entity: "push",
        action: "pushed",
        label: headSha.slice(0, 7),
        attrs: {
          "vcs.repository.name": repo,
          // ⛔ The FULL ref (`refs/heads/x`), not a stripped branch — the consumer
          // strips it itself and a pre-stripped value would fail its comparison.
          "vcs.ref.name": row.ref,
          "vcs.revision": headSha,
        },
        message: `${name} to ${repo} ${row.ref} (${headSha.slice(0, 7)})`,
        payload: {
          baseSha: typeof row.before === "string" ? row.before : "",
          headSha,
          // ⚠️ Always empty, on BOTH streams. Neither `pushes` nor `push_events`
          // stores a commit list, so the array cannot be reconstructed. No consumer
          // reads it (`router.mjs:1582` reads only `vcs.ref.name`) — which is what
          // makes the absence survivable, and is measured rather than assumed.
          commits: [],
        },
      }, seams);
    }

    case "prMerged": {
      // ⭐ Unblocked by CTC-691 (schema 0.1.17). Deliberately NOT folded into the
      // prOpened/prClosed case: those two hard-code `merged: false` and
      // `mergeCommitSha: null` because `router.mjs:1525` tests `detail.merged === false`
      // STRICTLY, and this name is the exact inverse on both fields.
      return envelope({
        name,
        entity: "pr",
        action: "merged",
        label: `PR #${row.number}`,
        // ⛔ NO `vcs.revision`, THOUGH THE MERGE SHA IS RIGHT THERE. I added it — it is
        // the obvious attribute for a merge commit — and the parity ledger caught it
        // on the first live window: the WEBHOOK does not set it on this name, so the
        // feed's copy diverged on all 3 events. Reproduce the webhook, do not improve
        // it; the same rule that keeps `threadId: 0` on pr_review_thread.resolved.
        // The consumer reads `detail.mergeCommitSha` from the payload, which is
        // populated below.
        attrs: {
          "vcs.repository.name": repo,
          "vcs.pr.number": row.number,
        },
        message: `${name} for ${repo} PR #${row.number}`,
        payload: {
          action: "closed",
          // ⛔ GitHub sends `action: "closed"` with `merged: true` for a merge — the
          // action is NOT "merged". `tryPrLifecycleRoute` and the webhook builder both
          // read the pair, so inventing an action nobody emits would leave the
          // lifecycle branch unmatched while every count still read "emitted".
          merged: true,
          // ⛔ SECOND-PRECISION, NOT MILLISECOND. `toISOString()` always emits `.000Z`;
          // GitHub's own string omits milliseconds, so the naive form diverged on
          // every event (`08:07:22.000Z` vs `08:07:22Z`) — caught by the ledger on the
          // first live window, exactly where #3544's own PR body predicted it would go
          // first. Trimming is safe because the column is whole seconds from GitHub.
          mergedAt: typeof row.merged_at === "number"
            ? new Date(row.merged_at).toISOString().replace(/\.\d{3}Z$/, "Z")
            : null,
          // The join key. `classifyGithubRow` has already refused the row if it is
          // absent, so this is never null here — the guard is there, not here.
          mergeCommitSha: row.merge_commit_sha,
          draft: row.draft === 1 || row.draft === true,
          mergeable: row.mergeable === null || row.mergeable === undefined
            ? null
            : row.mergeable === 1 || row.mergeable === true,
        },
      }, seams);
    }

    default:
      return null;
  }
}
