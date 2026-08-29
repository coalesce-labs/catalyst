#!/usr/bin/env node
// scripts/merge-queue-watchdog.mjs — CTL-2285. Port of catalyst-cloud's CTC-1218 watchdog
// (scripts/merge-queue-watchdog.ts), the automated replacement for a human's manual
// `@Mergifyio queue` nudge (AGENTS.md: "infra fixes must be codified", house rule).
//
// WHY: Mergify does not re-evaluate a PR whose queue attempt failed, and label-event
// evaluation can lag or be missed entirely. Measured incident: catalyst PR #4066 entered the
// queue 2026-08-29T04:02:45Z and was DEQUEUED at 04:09Z because the required check
// `execution-core-unit-tests` had simply not reported a conclusion yet (started 04:11:30Z);
// every other check on the head SHA was already green. This watchdog runs on a schedule
// (.github/workflows/merge-queue-watchdog.yml) and, for every open PR carrying `queue:ready`
// against `main`, decides whether to nudge, alert, or stay quiet.
//
// SHAPE: a pure decision core (`decideAction` — data in, action out, no I/O, table-driven
// unit-tested in merge-queue-watchdog.test.mjs) plus a thin GitHub client whose I/O is
// injectable (`GithubClient` + `makeGithubClient`) — same shape as the cloud source.
//
// THE ONE REAL GENERALIZATION vs. cloud: cloud's `requiredCheckContext` is a single string
// because cloud's branch protection has exactly one required context (`Check`). This repo's
// protection is a repository RULESET (id 13503799) requiring SIX contexts — docs-gate,
// gitleaks, agents-md-gate, audit-references, check-versions, execution-core-unit-tests —
// each satisfied in the skip-tolerant three-way form (success OR neutral OR skipped),
// exactly as .mergify.yml's own queue_conditions already spell it (see that file's header: a
// bare success-only test would be STRICTER than the ruleset and would deadlock on a
// legitimately-skipped job). `requiredCheckContexts` is therefore a list, and
// `requiredChecksConclusion` aggregates every context's own three-way state. `.mergify.yml`
// also gates three NON-required-but-always-evaluated checks the same three-way way
// (packaging-gate, skills-gate, check-plugin-manifest-parity) and one in a NEGATIVE
// active-only form (`quality`, path-filtered and therefore absent on most PRs) — the watchdog
// must mirror every gate Mergify actually evaluates, not just the ruleset-required subset, or
// it can declare a PR eligible that Mergify is certain to refuse (Codex P2, this ticket's own
// PR). `combinedCheckConclusion` folds both forms into one verdict.
//
// PATH EXCLUSIONS ARE READ, NEVER DUPLICATED. This script parses the live `-files~=<pattern>`
// conditions straight out of `.mergify.yml` at runtime — a small line-oriented extractor, not
// a YAML library (this repo's top-level scripts/ has no hoisted `yaml` dep). If .mergify.yml's
// exclusions ever change, this script picks them up automatically; it cannot drift from the
// file it reads. (.mergify.yml also carries a `-head~=^release-please--` branch-name
// exclusion — that is not a `-files~=` line and is out of scope for this extractor, which
// only ever covered file-content exclusions.)
//
// SCOPE ADDENDUM (carried from cloud): a PR whose changed files match a path exclusion will
// NEVER queue, no matter how many nudges — nudging it is a lie about automation that will
// never come. For those PRs: alert instead, and (default on) swap `queue:ready` for
// `hold:hand-steps` so the label stops re-triggering both this watchdog and Mergify's own
// `pull_request_rules` enqueue rule.
//
// SURFACING: every decision is logged to the workflow's own job log AND appended to
// $GITHUB_STEP_SUMMARY when set. A refusal or path-exclusion is ALSO posted as a PR comment.
//
// "ALREADY QUEUED" / "REFUSED" DETECTION deliberately reads PR comments rather than shelling
// out to a Mergify CLI/API: a `# Merge Queue Status` comment is a reliable positive signal,
// and any other `mergify[bot]` reply after our own nudge is the only other reply shape a
// `queue` command produces — so it is read as the refusal explanation.
//
// Usage (live, needs GITHUB_TOKEN + network): node scripts/merge-queue-watchdog.mjs
// Invoked by .github/workflows/merge-queue-watchdog.yml on a schedule + workflow_dispatch.
//
// ⛔ THIS SCRIPT NEEDS THE NETWORK — it stays OUT of the required test gate. Only its OFFLINE
// spec (merge-queue-watchdog.test.mjs, fetchImpl injected) is wired into CI, as a step in
// .github/workflows/execution-core-tests.yml (there is no glob test runner in this repo — a
// test file merely present in __tests__/ never runs in CI unless explicitly registered there).

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Config ──────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} WatchdogConfig
 * @property {string} owner
 * @property {string} repo
 * @property {string} baseRef
 * @property {string} readyLabel
 * @property {string} holdLabel
 * @property {readonly string[]} requiredCheckContexts
 * @property {readonly string[]} negativeGateContexts
 * @property {number} eligibleMinutes
 * @property {number} renudgeCooldownMinutes
 * @property {boolean} swapToHoldLabel
 */

/**
 * requiredCheckContexts covers every `.mergify.yml` queue_conditions entry gated in the
 * `or: [check-success=X, check-neutral=X, check-skipped=X]` three-way form — the six
 * ruleset-required contexts PLUS the three non-required-but-always-gating ones
 * (packaging-gate, skills-gate, check-plugin-manifest-parity). Nudging while any of these
 * nine is unsatisfied would send a `@Mergifyio queue` command Mergify is certain to refuse
 * (Codex P2 on this ticket's own PR: the watchdog must mirror EVERY gate `.mergify.yml`
 * actually evaluates, not just the ruleset-required subset, or it declares a PR eligible
 * that Mergify will not embark).
 */
/** @type {WatchdogConfig} */
export const DEFAULT_CONFIG = {
  owner: "coalesce-labs",
  repo: "catalyst",
  baseRef: "main",
  readyLabel: "queue:ready",
  holdLabel: "hold:hand-steps",
  requiredCheckContexts: [
    "docs-gate",
    "gitleaks",
    "agents-md-gate",
    "audit-references",
    "check-versions",
    "execution-core-unit-tests",
    "packaging-gate",
    "skills-gate",
    "check-plugin-manifest-parity",
  ],
  // `quality` is path-filtered at its own `on:` trigger, so on most PRs it never runs at
  // all — `.mergify.yml` deliberately gates it with `-check-failure=quality` /
  // `-check-pending=quality` (block only while ACTIVE and unsatisfied) rather than the
  // three-way success/neutral/skipped form, because an absent check satisfies none of
  // those and would deadlock every PR that doesn't trigger it. See negativeGateConclusion.
  negativeGateContexts: ["quality"],
  eligibleMinutes: 10,
  renudgeCooldownMinutes: 20,
  swapToHoldLabel: true,
};

// ── Markers (idempotency, no external state store — GitHub IS the state) ────────────────────

export const NUDGE_MARKER = "<!-- catalyst:merge-queue-watchdog:nudge -->";
export const PATH_EXCLUDED_MARKER = "<!-- catalyst:merge-queue-watchdog:path-excluded -->";
export const QUEUE_STATUS_HEADING = "Merge Queue Status";
export const MERGIFY_BOT_LOGIN = "mergify[bot]";

function refusalMarker(commentId) {
  return `<!-- catalyst:merge-queue-watchdog:refusal-surfaced:${commentId} -->`;
}

// ── .mergify.yml path-exclusion extraction (line-oriented, not a YAML parse — see header) ───

const FILES_EXCLUDE_LINE = /^\s*-\s*-files~=(.+?)\s*$/;

export function parsePathExclusionPatterns(mergifyYamlText) {
  const patterns = [];
  for (const line of mergifyYamlText.split("\n")) {
    const m = FILES_EXCLUDE_LINE.exec(line);
    if (m && m[1]) patterns.push(new RegExp(m[1]));
  }
  return patterns;
}

export function isPathExcluded(files, patterns) {
  return patterns.length > 0 && files.some((f) => patterns.some((p) => p.test(f)));
}

// ── Label timeline → "when did queue:ready last become active" ──────────────────────────────

/**
 * Latest time `labelName` became active, per the issue timeline. `null` if never applied in
 * the fetched window, or if the most recent labeled/unlabeled event for it is an `unlabeled`.
 */
export function latestLabelAddedAt(events, labelName) {
  let latest = null;
  for (const e of events) {
    if (e.label?.name !== labelName) continue;
    if (e.event !== "labeled" && e.event !== "unlabeled") continue;
    const at = Date.parse(e.created_at);
    if (Number.isNaN(at)) continue;
    if (!latest || at >= latest.at) latest = { at, applied: e.event === "labeled" };
  }
  return latest && latest.applied ? new Date(latest.at) : null;
}

// ── Comments → nudge history / queue status / refusal / prior alerts ────────────────────────

export function latestNudgeAt(comments) {
  let latest = null;
  for (const c of comments) {
    if (!c.body.includes(NUDGE_MARKER)) continue;
    const at = Date.parse(c.created_at);
    if (!Number.isNaN(at) && (latest === null || at > latest)) latest = at;
  }
  return latest === null ? null : new Date(latest);
}

export function isAlreadyQueued(comments) {
  return comments.some(
    (c) => c.user?.login === MERGIFY_BOT_LOGIN && c.body.includes(QUEUE_STATUS_HEADING)
  );
}

export function hasPathExcludedAlert(comments) {
  return comments.some((c) => c.body.includes(PATH_EXCLUDED_MARKER));
}

/**
 * A `mergify[bot]` reply posted after our own last nudge that is NOT the queue-status heading
 * is read as a refusal/explanation. Already surfaced refusals (a prior comment naming this
 * comment id in a refusalMarker) are excluded, so surfacing stays idempotent without a second
 * external state store.
 */
export function findUnsurfacedRefusal(comments, afterNudgeAt) {
  if (!afterNudgeAt) return null;
  const surfacedIds = new Set();
  for (const c of comments) {
    const m = /catalyst:merge-queue-watchdog:refusal-surfaced:(\d+)/.exec(c.body);
    if (m) surfacedIds.add(Number(m[1]));
  }
  const candidates = comments.filter(
    (c) =>
      c.user?.login === MERGIFY_BOT_LOGIN &&
      !c.body.includes(QUEUE_STATUS_HEADING) &&
      Date.parse(c.created_at) > afterNudgeAt.getTime() &&
      !surfacedIds.has(c.id)
  );
  if (candidates.length === 0) return null;
  const earliest = candidates.reduce((a, b) =>
    Date.parse(a.created_at) <= Date.parse(b.created_at) ? a : b
  );
  return {
    commentId: earliest.id,
    body: earliest.body,
    createdAt: new Date(Date.parse(earliest.created_at)),
  };
}

// ── Check runs → each required context's state, then the aggregate across all of them ───────

/** Conclusions the ruleset itself treats as satisfying a required context (skip-tolerant). */
export const SATISFYING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Per-context state: "missing" (never ran), "pending" (not yet completed), "success"
 * (completed with a satisfying conclusion), or "failure" (completed, unsatisfying).
 * GitHub returns check-runs newest-first, so `find` picks the most recent run for this name.
 */
export function checkStateForContext(runs, contextName) {
  const run = runs.find((r) => r.name === contextName);
  if (!run) return "missing";
  if (run.status !== "completed") return "pending";
  return SATISFYING_CONCLUSIONS.has(run.conclusion) ? "success" : "failure";
}

/**
 * Aggregates every required context's state with priority failure > pending > missing >
 * success, and names which context(s) drove a non-success verdict — so a refusal reason (or
 * the step summary) can say exactly "execution-core-unit-tests is still pending" instead of a
 * bare "not ready".
 */
export function requiredChecksConclusion(runs, contextNames) {
  const states = contextNames.map((name) => ({ name, state: checkStateForContext(runs, name) }));
  const failing = states.filter((s) => s.state === "failure").map((s) => s.name);
  if (failing.length > 0) return { conclusion: "failure", detail: failing.join(", ") };
  const pending = states.filter((s) => s.state === "pending").map((s) => s.name);
  if (pending.length > 0) return { conclusion: "pending", detail: pending.join(", ") };
  const missing = states.filter((s) => s.state === "missing").map((s) => s.name);
  if (missing.length > 0) return { conclusion: "missing", detail: missing.join(", ") };
  return { conclusion: "success", detail: "" };
}

/**
 * The `-check-failure=X` / `-check-pending=X` negative-gate form `.mergify.yml` uses for a
 * path-filtered check like `quality`: it blocks the queue only while the check is ACTIVE and
 * unsatisfied (failure or still running), and — unlike requiredChecksConclusion — a context
 * that never ran at all (`missing`) is NOT blocking, since most PRs never trigger it at all.
 */
export function negativeGateConclusion(runs, contextNames) {
  const states = contextNames.map((name) => ({ name, state: checkStateForContext(runs, name) }));
  const failing = states.filter((s) => s.state === "failure").map((s) => s.name);
  if (failing.length > 0) return { conclusion: "failure", detail: failing.join(", ") };
  const pending = states.filter((s) => s.state === "pending").map((s) => s.name);
  if (pending.length > 0) return { conclusion: "pending", detail: pending.join(", ") };
  return { conclusion: "success", detail: "" };
}

const CONCLUSION_RANK = { failure: 0, pending: 1, missing: 2, success: 3 };

/**
 * Combines the three-way required-checks verdict with the negative-gate verdict into one
 * `CheckConclusion`, picking whichever is more blocking (lower rank). When both are
 * non-success at the same rank (e.g. both "pending"), their details are concatenated so
 * neither outstanding context is silently dropped from the reported reason.
 */
export function combinedCheckConclusion(runs, config) {
  const required = requiredChecksConclusion(runs, config.requiredCheckContexts);
  const negativeGate = negativeGateConclusion(runs, config.negativeGateContexts ?? []);
  if (CONCLUSION_RANK[negativeGate.conclusion] < CONCLUSION_RANK[required.conclusion]) {
    return negativeGate;
  }
  if (CONCLUSION_RANK[required.conclusion] < CONCLUSION_RANK[negativeGate.conclusion]) {
    return required;
  }
  if (required.conclusion === "success") return required;
  const detail = [required.detail, negativeGate.detail].filter(Boolean).join(", ");
  return { conclusion: required.conclusion, detail };
}

// ── Review threads ────────────────────────────────────────────────────────────────────────

export function countUnresolvedThreads(threads) {
  return threads.filter((t) => !t.isResolved).length;
}

// ── The decision core — pure, no I/O, no clock reads of its own ─────────────────────────────

/**
 * @typedef {object} PrEligibilityInput
 * @property {number} number
 * @property {string} baseRef
 * @property {boolean} isDraft
 * @property {readonly string[]} labels
 * @property {readonly string[]} changedFiles
 * @property {"success"|"failure"|"pending"|"missing"} checkConclusion
 * @property {string} checkDetail
 * @property {number} unresolvedThreadCount
 * @property {Date|null} labeledAt
 * @property {boolean} alreadyQueued
 * @property {Date|null} lastNudgeAt
 * @property {boolean} pathExcludedAlertAlreadyPosted
 * @property {{commentId:number, body:string, createdAt:Date}|null} refusal
 */

export function decideAction(input, config, pathExclusionPatterns, now) {
  if (input.baseRef !== config.baseRef) {
    return { type: "none", reason: `base is ${input.baseRef}, not ${config.baseRef}` };
  }
  if (input.isDraft) return { type: "none", reason: "PR is a draft" };
  if (!input.labels.includes(config.readyLabel)) {
    return { type: "none", reason: `missing ${config.readyLabel} label` };
  }

  if (isPathExcluded(input.changedFiles, pathExclusionPatterns)) {
    if (input.labels.includes(config.holdLabel) || input.pathExcludedAlertAlreadyPosted) {
      return { type: "none", reason: "path-excluded; already alerted" };
    }
    return {
      type: "alert-path-excluded",
      reason: "changed files match a merge-queue path exclusion — this PR will never queue",
    };
  }

  if (input.labels.includes(config.holdLabel)) {
    return { type: "none", reason: `${config.holdLabel} present — manual protocol` };
  }

  if (input.alreadyQueued) {
    return { type: "none", reason: "already queued (Merge Queue Status comment present)" };
  }

  if (input.refusal) {
    return {
      type: "surface-refusal",
      reason: "Mergify replied to our nudge without queuing",
      refusal: input.refusal,
    };
  }

  if (input.checkConclusion !== "success") {
    return {
      type: "none",
      reason: `required check(s) not satisfied (${input.checkConclusion}): ${input.checkDetail}`,
    };
  }

  if (input.unresolvedThreadCount > 0) {
    return { type: "none", reason: `${input.unresolvedThreadCount} unresolved review thread(s)` };
  }

  if (!input.labeledAt) {
    return {
      type: "none",
      reason: `could not determine when ${config.readyLabel} was applied`,
    };
  }

  const eligibleMs = now.getTime() - input.labeledAt.getTime();
  const eligibleThresholdMs = config.eligibleMinutes * 60_000;
  if (eligibleMs < eligibleThresholdMs) {
    return {
      type: "none",
      reason: `eligible for ${Math.floor(eligibleMs / 60_000)}m, waiting for ${config.eligibleMinutes}m`,
    };
  }

  if (input.lastNudgeAt) {
    const sinceNudgeMs = now.getTime() - input.lastNudgeAt.getTime();
    const cooldownMs = config.renudgeCooldownMinutes * 60_000;
    if (sinceNudgeMs < cooldownMs) {
      return {
        type: "none",
        reason: `nudged ${Math.floor(sinceNudgeMs / 60_000)}m ago, cooldown is ${config.renudgeCooldownMinutes}m`,
      };
    }
  }

  return {
    type: "nudge",
    reason: `eligible for ${Math.floor(eligibleMs / 60_000)}m without entering the queue`,
  };
}

// ── The GitHub client — injectable I/O ───────────────────────────────────────────────────────

const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";
const ACCEPT = "application/vnd.github+json";
const USER_AGENT = "catalyst-merge-queue-watchdog";

async function githubJson(fetchImpl, token, path, init) {
  const res = await fetchImpl(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: ACCEPT,
      "User-Agent": USER_AGENT,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `github ${init?.method ?? "GET"} ${path} failed (${res.status}): ${detail.slice(0, 300)}`
    );
  }
  if (res.status === 204) return undefined;
  return res.json();
}

const PAGE_SIZE = 100;

/**
 * Follows `page=`/`per_page=` pagination to exhaustion — a short last page (< PAGE_SIZE) ends
 * the walk. `pathWithPage1` must already carry `per_page=100` and no `page` param. Every call
 * site that decides eligibility from "the full set of X" (changed files, comments) needs
 * this: a first-page-only read silently under-reports on anything larger than one page.
 */
async function githubJsonAllPages(fetchImpl, token, pathWithPage1) {
  const out = [];
  for (let page = 1; ; page++) {
    const pageItems = await githubJson(fetchImpl, token, `${pathWithPage1}&page=${page}`);
    out.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) break;
  }
  return out;
}

export function makeGithubClient(token, owner, repo, fetchImpl = fetch) {
  return {
    async listOpenPrsWithLabel(label) {
      // Paginated (Codex P2): a repo with more than one page of open PRs would otherwise
      // silently miss a `queue:ready` PR on a later page and report zero ready PRs.
      const raw = await githubJsonAllPages(
        fetchImpl,
        token,
        `/repos/${owner}/${repo}/pulls?state=open&per_page=${PAGE_SIZE}`
      );
      return raw
        .filter((pr) => pr.labels.some((l) => l.name === label))
        .map((pr) => ({
          number: pr.number,
          baseRef: pr.base.ref,
          isDraft: pr.draft,
          labels: pr.labels.map((l) => l.name),
          headSha: pr.head.sha,
        }));
    },

    async listChangedFiles(number) {
      const raw = await githubJsonAllPages(
        fetchImpl,
        token,
        `/repos/${owner}/${repo}/pulls/${number}/files?per_page=${PAGE_SIZE}`
      );
      return raw.map((f) => f.filename);
    },

    async listCheckRuns(sha) {
      const raw = await githubJson(
        fetchImpl,
        token,
        `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`
      );
      return raw.check_runs;
    },

    async listUnresolvedThreadCount(number) {
      const query = `query($owner:String!,$repo:String!,$num:Int!,$after:String){ repository(owner:$owner,name:$repo){ pullRequest(number:$num){ reviewThreads(first:100,after:$after){ nodes{ isResolved } pageInfo{ hasNextPage endCursor } } } } }`;
      const allNodes = [];
      let after = null;
      for (;;) {
        const res = await fetchImpl(GITHUB_GRAPHQL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify({ query, variables: { owner, repo, num: number, after } }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`github graphql failed (${res.status}): ${detail.slice(0, 300)}`);
        }
        const json = await res.json();
        if (json.errors?.length)
          throw new Error(`github graphql errors: ${JSON.stringify(json.errors)}`);
        const reviewThreads = json.data?.repository.pullRequest.reviewThreads;
        allNodes.push(...(reviewThreads?.nodes ?? []));
        if (!reviewThreads?.pageInfo.hasNextPage) break;
        after = reviewThreads.pageInfo.endCursor;
      }
      return countUnresolvedThreads(allNodes);
    },

    async listLabelTimeline(number) {
      // Paginated (Codex P2): a PR with more than one page of timeline events would
      // otherwise miss a `queue:ready` labeled event on a later page, and
      // latestLabelAddedAt would return null or a stale label state — decideAction then
      // permanently skips an otherwise-eligible PR because it can never determine when the
      // label was applied.
      const raw = await githubJsonAllPages(
        fetchImpl,
        token,
        `/repos/${owner}/${repo}/issues/${number}/timeline?per_page=${PAGE_SIZE}`
      );
      return raw
        .filter((e) => e.event === "labeled" || e.event === "unlabeled")
        .map((e) => ({ event: e.event, label: e.label, created_at: e.created_at }));
    },

    async listComments(number) {
      return githubJsonAllPages(
        fetchImpl,
        token,
        `/repos/${owner}/${repo}/issues/${number}/comments?per_page=${PAGE_SIZE}`
      );
    },

    async postComment(number, body) {
      await githubJson(fetchImpl, token, `/repos/${owner}/${repo}/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    },

    async swapLabels(number, removeLabel, addLabel) {
      // Add BEFORE remove — idempotent (adding an already-present label is a no-op) — so a
      // run that dies between the two calls leaves `removeLabel` in place. A future run then
      // still lists this PR (the query filters on `removeLabel`) and retries the swap,
      // instead of the PR falling through with neither label after a partial failure.
      await githubJson(fetchImpl, token, `/repos/${owner}/${repo}/issues/${number}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels: [addLabel] }),
      });
      const res = await fetchImpl(
        `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(removeLabel)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT, "User-Agent": USER_AGENT },
        }
      );
      // A label already gone (race with a human) is not an error worth aborting the run over.
      if (!res.ok && res.status !== 404) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `github DELETE label ${removeLabel} failed (${res.status}): ${detail.slice(0, 300)}`
        );
      }
    },
  };
}

// ── Orchestration ─────────────────────────────────────────────────────────────────────────

export async function gatherPrInput(client, pr, config) {
  const [changedFiles, checkRuns, unresolvedThreadCount, timeline, comments] = await Promise.all([
    client.listChangedFiles(pr.number),
    client.listCheckRuns(pr.headSha),
    client.listUnresolvedThreadCount(pr.number),
    client.listLabelTimeline(pr.number),
    client.listComments(pr.number),
  ]);
  const lastNudgeAt = latestNudgeAt(comments);
  const checks = combinedCheckConclusion(checkRuns, config);
  return {
    number: pr.number,
    baseRef: pr.baseRef,
    isDraft: pr.isDraft,
    labels: pr.labels,
    changedFiles,
    checkConclusion: checks.conclusion,
    checkDetail: checks.detail,
    unresolvedThreadCount,
    labeledAt: latestLabelAddedAt(timeline, config.readyLabel),
    alreadyQueued: isAlreadyQueued(comments),
    lastNudgeAt,
    pathExcludedAlertAlreadyPosted: hasPathExcludedAlert(comments),
    refusal: findUnsurfacedRefusal(comments, lastNudgeAt),
  };
}

export async function runOnce(client, config, mergifyYamlText, now, log) {
  const patterns = parsePathExclusionPatterns(mergifyYamlText);
  const prs = await client.listOpenPrsWithLabel(config.readyLabel);
  log(`merge-queue-watchdog: ${prs.length} open PR(s) carry ${config.readyLabel}`);

  let nudged = 0;
  let alertedPathExcluded = 0;
  let refusalsSurfaced = 0;
  let errors = 0;

  for (const pr of prs) {
    try {
      const input = await gatherPrInput(client, pr, config);
      const action = decideAction(input, config, patterns, now);
      log(`  #${pr.number}: ${action.type} — ${action.reason}`);

      if (action.type === "nudge") {
        await client.postComment(pr.number, `@Mergifyio queue\n\n${NUDGE_MARKER}`);
        nudged++;
      } else if (action.type === "alert-path-excluded") {
        // Labels BEFORE the marker comment: if the swap throws, the marker never gets
        // recorded, so a PR left in a half-swapped state (or not swapped at all) is retried
        // on the next scheduled run instead of being silently treated as "already alerted".
        if (config.swapToHoldLabel) {
          await client.swapLabels(pr.number, config.readyLabel, config.holdLabel);
        }
        const swapNote = config.swapToHoldLabel ? ` Swapping to \`${config.holdLabel}\`.` : "";
        await client.postComment(
          pr.number,
          `⚠️ \`${config.readyLabel}\` is set but this PR's changed files match a merge-queue ` +
            `path exclusion — it will never enter the queue automatically. Follow the manual ` +
            `merge protocol.${swapNote}\n\n${PATH_EXCLUDED_MARKER}`
        );
        alertedPathExcluded++;
      } else if (action.type === "surface-refusal") {
        const quoted = action.refusal.body
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n");
        await client.postComment(
          pr.number,
          `⚠️ Mergify replied to the automated \`@Mergifyio queue\` nudge without queuing ` +
            `this PR:\n\n${quoted}\n\n${refusalMarker(action.refusal.commentId)}`
        );
        refusalsSurfaced++;
      }
    } catch (err) {
      errors++;
      log(`  #${pr.number}: ERROR — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { processed: prs.length, nudged, alertedPathExcluded, refusalsSurfaced, errors };
}

// ── main — the whole CLI, minus process.exit, so tests drive it offline ─────────────────────

export async function main(_argv, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? new Date();

  const token = env.GITHUB_TOKEN;
  if (!token) {
    log("merge-queue-watchdog: GITHUB_TOKEN is not set");
    return { exitCode: 1 };
  }

  const config = DEFAULT_CONFIG;
  const readMergifyYaml =
    deps.readMergifyYaml ?? (() => readFileSync(join(ROOT, ".mergify.yml"), "utf8"));

  let mergifyYamlText;
  try {
    mergifyYamlText = readMergifyYaml();
  } catch (err) {
    log(
      `merge-queue-watchdog: could not read .mergify.yml — ${err instanceof Error ? err.message : String(err)}`
    );
    return { exitCode: 1 };
  }

  const client = makeGithubClient(token, config.owner, config.repo, fetchImpl);

  let summary;
  try {
    summary = await runOnce(client, config, mergifyYamlText, now, log);
  } catch (err) {
    log(`merge-queue-watchdog: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1 };
  }

  log(
    `merge-queue-watchdog: processed=${summary.processed} nudged=${summary.nudged} ` +
      `path-excluded=${summary.alertedPathExcluded} refusals-surfaced=${summary.refusalsSurfaced} ` +
      `errors=${summary.errors}`
  );

  const stepSummaryPath = env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    const writeStepSummary =
      deps.writeStepSummary ?? ((text) => appendFileSync(stepSummaryPath, text));
    writeStepSummary(
      `### Merge queue watchdog\n\n` +
        `- Open PRs with \`${config.readyLabel}\`: ${summary.processed}\n` +
        `- Nudged: ${summary.nudged}\n` +
        `- Path-excluded alerts: ${summary.alertedPathExcluded}\n` +
        `- Refusals surfaced: ${summary.refusalsSurfaced}\n` +
        `- Errors: ${summary.errors}\n`
    );
  }

  return { exitCode: summary.errors > 0 ? 1 : 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((result) => {
    process.exitCode = result.exitCode;
  });
}
