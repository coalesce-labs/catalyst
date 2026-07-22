// pr-block-probe.mjs — read-only "why is this PR blocked?" probe (CTL-1496).
//
// Exports defaultProbePrBlock(ticket, { gh, repo }) — injectable seam so the
// classifier (recovery-reasoning.mjs) stays pure and testable.  The real gh
// default wraps spawnSync; tests inject a fake routed by argv shape.

import { spawnSync } from "node:child_process";

// Paginated: `after:$after` (nullable String → first page passes it unbound =
// null = start from the beginning). pageInfo lets the caller walk every page so
// a review thread beyond the first 100 is never silently dropped (CTL-1496 P2).
export const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$pr:Int!,$after:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$pr){
    reviewThreads(first:100, after:$after){
      pageInfo { hasNextPage endCursor }
      nodes { id isResolved
      comments(first:1){ nodes { body path line author { login __typename } } } } } } } }`;

// This probe runs SYNCHRONOUSLY from reasoningRecoveryPass on the scheduler
// tick, so an unbounded `gh` (hung network / auth / keychain prompt) would
// wedge the whole daemon event loop. Bound every spawn; a timeout surfaces as
// r.error (ETIMEDOUT) → throw → classifyPrNotMerged defers to the next tick
// (CTL-1496 P1).
const GH_PROBE_TIMEOUT_MS = Number(process.env.CATALYST_GH_PROBE_TIMEOUT_MS || 20000);

// Hard cap on review-thread pages walked (100 threads/page). Far above any real
// PR; hitting it means something is wrong, so we refuse rather than proceed on a
// partial set (CTL-1496 P2).
const MAX_THREAD_PAGES = 25;

// opts.cwd lets the caller resolve `gh repo view` against the TICKET's worktree
// so the probe targets the ticket's repository, not the daemon's checkout
// (CTL-1496 P1).
function realGh(args, { cwd } = {}) {
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: GH_PROBE_TIMEOUT_MS, cwd });
  // A timeout (or spawn failure) sets r.error and leaves status null — surface
  // it as a throw so the caller treats it as transient rather than the daemon
  // hanging on a wedged child.
  if (r.error) {
    const timedOut = r.error.code === "ETIMEDOUT" || r.signal === "SIGTERM";
    throw new Error(
      `gh ${args.join(" ")} ${timedOut ? `timed out after ${GH_PROBE_TIMEOUT_MS}ms` : `errored: ${r.error.message}`}`,
    );
  }
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${r.stderr || r.status}`);
  return r.stdout;
}

export function isFailingState(s) {
  return [
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "CANCELLED",
    // ACTION_REQUIRED / STARTUP_FAILURE are genuine CI failure states the
    // existing orchestrate-auto-fixup classifier already treats as failing;
    // omitting them here regressed the autonomous remediation path to a human
    // escalation for those conclusions (CTL-1496 P2).
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
  ].includes(s);
}

// A required check that is still queued/running is NOT a failure — the PR is
// simply not ready yet. The classifier must DEFER on these (retry next tick)
// rather than escalate a "no remediable cause" latch on a PR whose CI just
// hasn't finished (CTL-1496 P2). check-runs report progress via `.status`
// (QUEUED/IN_PROGRESS), legacy statuses via `.state` (PENDING/EXPECTED).
export function isPendingState(s) {
  return [
    "QUEUED",
    "IN_PROGRESS",
    "PENDING",
    "WAITING",
    "REQUESTED",
    "EXPECTED",
  ].includes(s);
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
    pendingChecks: [],
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
// PR. Scoped to owner/name with `-R` so the lookup targets the TICKET's repo —
// the same repo used for the GraphQL threads query below — not whatever repo the
// daemon's cwd points at (CTL-1496 P1: without `-R`/cwd it resolved the daemon
// repo → false "no open PR" escalation or an unrelated same-ticket PR).
// Returns the parsed PR object or null.
function resolveTicketPr(gh, ticket, branch, owner, name) {
  const selector = branch ? ["--head", branch] : ["--search", `${ticket} in:title`];
  const repoArgs = owner && name ? ["-R", `${owner}/${name}`] : [];
  const listRaw = gh([
    "pr",
    "list",
    ...repoArgs,
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

// Fetch all review threads across pages, accumulating nodes. Each page's
// partial/errored body is a probe failure (throw → caller defers) rather than a
// silently-empty set. Refuse past MAX_THREAD_PAGES with more pages remaining so
// a genuinely enormous (or looping) thread set never yields a partial view that
// hides an unresolved human thread (CTL-1496 P2).
function fetchAllReviewThreads(gh, owner, name, prNumber) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const args = [
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
      `pr=${prNumber}`,
    ];
    // First page leaves $after unbound (nullable → null → from the beginning).
    if (after) args.push("-f", `after=${after}`);
    const json = safeJson(gh(args));
    // `gh api graphql` can exit 0 with a partial/field-errored body (HTTP 200,
    // data.repository.pullRequest === null, or a top-level `errors` array).
    // Coercing that to [] would silently hide an unresolved HUMAN thread and
    // route a human-blocked PR to the autonomous fix path.
    if (json === null || json.errors || !json?.data?.repository?.pullRequest) {
      throw new Error(
        "review-threads GraphQL returned no usable data (partial/errored response)",
      );
    }
    const rt = json.data.repository.pullRequest.reviewThreads;
    for (const n of rt?.nodes || []) nodes.push(n);
    const pageInfo = rt?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo?.endCursor) return nodes;
    after = pageInfo.endCursor;
  }
  throw new Error(
    `review-threads exceeded ${MAX_THREAD_PAGES} pages; refusing partial thread set`,
  );
}

export function defaultProbePrBlock(ticket, { gh = realGh, repo, branch, worktreePath } = {}) {
  // Resolve owner/name: prefer an explicitly-threaded `repo`, else `gh repo
  // view` run IN THE TICKET'S WORKTREE (cwd) so it reports the ticket's repo,
  // not the daemon's checkout. Falls back to the daemon cwd only when neither is
  // available (CTL-1496 P1).
  const [owner, name] = (
    repo ||
    safeJson(
      gh(
        ["repo", "view", "--json", "nameWithOwner"],
        worktreePath ? { cwd: worktreePath } : undefined,
      ),
    )?.nameWithOwner ||
    "/"
  ).split("/");

  // Resolve the ticket's PR by head branch (when threaded) or ticket-in-title
  // search — independent of the daemon's cwd/current branch, scoped to the
  // resolved owner/name.
  const view = resolveTicketPr(gh, ticket, branch, owner, name);
  if (!view || !view.number) return emptyProbe();

  const rollup = view.statusCheckRollup || [];
  const failingChecks = rollup
    .filter((c) => isFailingState(c.state || c.conclusion))
    .map((c) => ({ name: c.name || c.context, detailsUrl: c.detailsUrl || null }));
  // Queued/in-progress required checks: not failing, not done. Surfaced so the
  // classifier can DEFER (retry next tick) instead of latching a "no remediable
  // cause" escalation on a PR whose CI simply hasn't finished (CTL-1496 P2). A
  // check that is both failing and (somehow) pending is counted as failing only.
  const pendingChecks = rollup
    .filter((c) => !isFailingState(c.state || c.conclusion))
    .filter((c) => isPendingState(c.status) || isPendingState(c.state))
    .map((c) => ({ name: c.name || c.context, detailsUrl: c.detailsUrl || null }));

  // Walk EVERY review-thread page. A single first:100 page silently omits later
  // threads; if an omitted one is an unresolved human conversation while
  // reviewDecision !== CHANGES_REQUESTED, the classifier would take the
  // autonomous fix/merge path despite an unresolved human review (CTL-1496 P2).
  const nodes = fetchAllReviewThreads(gh, owner, name, view.number);
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
    pendingChecks,
    unresolvedBotThreads,
    unresolvedHumanThreads,
    hasChangesRequested,
  };
}
