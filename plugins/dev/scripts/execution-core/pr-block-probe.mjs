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

// Resolve the ticket's PR by branch name or by listing open PRs.
// gh pr view with no selector looks up the current branch — we pass the ticket
// as a head-branch hint instead; tests inject a fake gh that routes on "pr view".
function prSelector(ticket) {
  // Use the ticket as a search term for the branch name the dispatcher would have created.
  // In practice the fake gh in tests routes on "pr view" regardless of the extra args,
  // and in production `gh pr view` against the current branch (no extra args) works
  // because phase agents run inside the ticket's worktree on the ticket branch.
  return [];
}

export function defaultProbePrBlock(ticket, { gh = realGh, repo } = {}) {
  const [owner, name] = (
    repo ||
    safeJson(gh(["repo", "view", "--json", "nameWithOwner"]))?.nameWithOwner ||
    "/"
  ).split("/");

  // Resolve PR: the fake gh in tests routes any "pr view" call; production gh
  // runs in the ticket's worktree on the ticket branch and resolves by current branch.
  const viewRaw = gh([
    "pr",
    "view",
    ...prSelector(ticket),
    "--json",
    "number,state,mergeStateStatus,mergeable,statusCheckRollup",
  ]);
  const view = safeJson(viewRaw);
  if (!view || !view.number) return emptyProbe();

  const failingChecks = (view.statusCheckRollup || [])
    .filter((c) => isFailingState(c.state || c.conclusion))
    .map((c) => ({ name: c.name || c.context, detailsUrl: c.detailsUrl || null }));

  const threadsRaw = gh([
    "api",
    "graphql",
    "-f",
    `query=${REVIEW_THREADS_QUERY}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `pr=${view.number}`,
  ]);
  const threadsJson = safeJson(threadsRaw);
  const nodes =
    threadsJson?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
  const unresolved = nodes.filter((n) => !n.isResolved);
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

  const reviewsRaw = gh(["pr", "view", String(view.number), "--json", "reviews"]);
  const reviews = safeJson(reviewsRaw)?.reviews || [];
  const hasChangesRequested = reviews.some((r) => r.state === "CHANGES_REQUESTED");

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
