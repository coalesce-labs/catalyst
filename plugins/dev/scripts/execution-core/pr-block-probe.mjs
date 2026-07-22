// pr-block-probe.mjs — read-only "why is this PR blocked?" probe (CTL-1496).
//
// Exports defaultProbePrBlock(ticket, { gh, repo }) — injectable seam so the
// classifier (recovery-reasoning.mjs) stays pure and testable.  The real gh
// default wraps spawnSync; tests inject a fake routed by argv shape.

import { spawnSync } from "node:child_process";

export const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$pr:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$pr){
    reviewThreads(first:100){ nodes { id isResolved
      comments(first:1){ nodes { body path line author { login __typename } } } } } } } }`;

function realGh(args) {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${r.stderr || r.status}`);
  return r.stdout;
}

export function isFailingState(s) {
  return ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(s);
}

export function isBotAuthor(a) {
  return a?.__typename === "Bot" || /\[bot\]$/.test(a?.login || "");
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function pick(obj, keys) {
  if (!obj) return {};
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

function emptyProbe() {
  return {
    prNumber: null,
    state: null,
    mergeStateStatus: null,
    mergeable: null,
    failingChecks: [],
    unresolvedBotThreads: [],
    unresolvedHumanThreads: [],
    hasChangesRequested: false,
  };
}

// Fields the classifier reads off the resolved PR. `reviewDecision` is the
// aggregate GitHub verdict (latest review per required reviewer) — used instead
// of scanning the raw reviews history so a PR that was CHANGES_REQUESTED then
// re-APPROVED is not false-flagged by a stale entry (CTL-1496 verify finding).
const PR_VIEW_FIELDS =
  "number,state,mergeStateStatus,mergeable,statusCheckRollup,reviewDecision";

// Resolve the ticket's PR EXPLICITLY — never by the daemon's current branch.
// classifyPrNotMerged runs inside the daemon process (daemon cwd), so a bare
// `gh pr view` would resolve whatever branch the daemon happens to be on, not
// the ticket's PR (CTL-1496 verify finding: the probe was inert in production,
// always resolving the wrong PR → always escalating). We resolve by the ticket's
// head branch when the caller threads it, else by the ticket id in the PR title
// (draft_pr_title injects `<type>(<scope>): <TICKET> …`), taking the single open
// PR. Returns the parsed PR object or null.
function resolveTicketPr(gh, ticket, branch) {
  const selector = branch ? ["--head", branch] : ["--search", `${ticket} in:title`];
  const listRaw = gh([
    "pr",
    "list",
    ...selector,
    "--state",
    "open",
    "--json",
    PR_VIEW_FIELDS,
    "--limit",
    "1",
  ]);
  const list = safeJson(listRaw);
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[0];
}

export function defaultProbePrBlock(ticket, { gh = realGh, repo, branch } = {}) {
  const [owner, name] = (
    repo ||
    safeJson(gh(["repo", "view", "--json", "nameWithOwner"]))?.nameWithOwner ||
    "/"
  ).split("/");

  // Resolve the ticket's PR by head branch (when threaded) or ticket-in-title
  // search — independent of the daemon's cwd/current branch.
  const view = resolveTicketPr(gh, ticket, branch);
  if (!view || !view.number) return emptyProbe();

  const failingChecks = (view.statusCheckRollup || [])
    .filter((c) => isFailingState(c.state || c.conclusion))
    .map((c) => ({ name: c.name || c.context, detailsUrl: c.detailsUrl || null }));

  const threadsRaw = gh([
    "api",
    "graphql",
    "-f",
    `query=${REVIEW_THREADS_QUERY}`,
    // owner/name are String! — pass with -f (raw string) so a purely-numeric
    // owner or repo name is not coerced to an Int and rejected. pr is Int! → -F.
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `pr=${view.number}`,
  ]);
  const threadsJson = safeJson(threadsRaw);
  // `gh api graphql` can exit 0 with a partial/field-errored body (HTTP 200,
  // data.repository.pullRequest === null, or a top-level `errors` array). Coercing
  // that to [] would silently hide an unresolved HUMAN thread and route a
  // human-blocked PR to the autonomous fix path. Treat an unparseable or partial
  // response as a probe failure → classifyPrNotMerged defers (retry next tick).
  if (
    threadsJson === null ||
    threadsJson.errors ||
    !threadsJson?.data?.repository?.pullRequest
  ) {
    throw new Error(
      "review-threads GraphQL returned no usable data (partial/errored response)",
    );
  }
  const nodes =
    threadsJson.data.repository.pullRequest.reviewThreads?.nodes || [];
  // A thread with no first comment cannot be attributed to bot vs human; skip it
  // rather than defaulting it into unresolvedHumanThreads (spurious escalate).
  const unresolved = nodes.filter((n) => !n.isResolved && n.comments?.nodes?.[0]);
  const shape = (n) => ({
    id: n.id,
    ...pick(n.comments?.nodes?.[0], ["body", "path", "line"]),
  });
  const unresolvedBotThreads = unresolved
    .filter((n) => isBotAuthor(n.comments?.nodes?.[0]?.author))
    .map(shape);
  const unresolvedHumanThreads = unresolved
    .filter((n) => !isBotAuthor(n.comments?.nodes?.[0]?.author))
    .map(shape);

  // Aggregate verdict, not raw history: reviewDecision reflects the latest
  // review per required reviewer, so a re-APPROVED PR reads APPROVED (not the
  // stale CHANGES_REQUESTED it once carried). An un-required CHANGES_REQUESTED
  // that reviewDecision omits is still caught by unresolvedHumanThreads.
  const hasChangesRequested = view.reviewDecision === "CHANGES_REQUESTED";

  return {
    prNumber: view.number,
    state: view.state,
    mergeStateStatus: view.mergeStateStatus,
    mergeable: view.mergeable,
    failingChecks,
    unresolvedBotThreads,
    unresolvedHumanThreads,
    hasChangesRequested,
  };
}
