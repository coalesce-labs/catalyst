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
export const GITHUB_DISPATCH_CLASS_NAMES = Object.freeze([
  "github.pr.opened",
  "github.pr.closed",
  "github.pr_review.submitted",
  "github.pr_review_comment.created",
  "github.pr_review_thread.resolved",
  "github.deployment.created",
  "github.deployment_status.success",
  "github.deployment_status.failure",
  "github.deployment_status.error",
  "github.push",
]);

/** Names the orchestrator consumes that this producer cannot yet emit. */
export const GITHUB_UNCOVERED_NAMES = Object.freeze([
  "github.pr.merged",
  "github.check_suite.completed",
]);

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
  prMerged: "uncovered:no-merge-commit-sha:CTC-691",
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
    "prOpened", "prClosed", "reviewSubmitted", "reviewCommentCreated", "threadResolved",
  ]);
  if (prScoped.has(streamKey)) {
    const n = streamKey === "prOpened" || streamKey === "prClosed" ? row.number : row.pr_number;
    if (!Number.isInteger(n) || n <= 0) return { emit: false, reason: "no-pr-number" };
  }
  if (streamKey === "deploymentStatus" && (typeof row.state !== "string" || row.state === "")) {
    return { emit: false, reason: "no-deployment-state" };
  }
  if (streamKey === "push" && (typeof row.ref !== "string" || row.ref === "")) {
    return { emit: false, reason: "no-ref" };
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
          // ⚠️ Always empty. The replica stores one row per ref and no commit list,
          // so the commits array cannot be reconstructed. No consumer reads it
          // (`router.mjs:1582` reads only `vcs.ref.name`), which is the measured
          // reason this stream is shippable despite being lossy.
          commits: [],
        },
      }, seams);
    }

    default:
      return null;
  }
}
