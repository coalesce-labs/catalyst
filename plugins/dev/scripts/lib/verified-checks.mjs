#!/usr/bin/env node
// verified-checks.mjs — instruments that cannot report a clean result from a
// check that never actually ran (CTL-1801).
//
// THE DEFECT CLASS. Four verification checks reported a clean/negative result
// when the truth was the opposite. In every case the negative was produced by
// the INSTRUMENT failing, not by the world — and nothing in the output
// distinguished the two:
//
//   (1) unstructured match over structured data — `grep -c "phase.advance.applied"`
//       returned 4 by matching that string inside a commit message carried in a
//       GitHub event body. Real count: 0.
//   (2) malformed call returning a falsy sentinel — `ownedBy(ticket, host, roster)`
//       (wrong arity; the real signature is `ownedBy(ticketId, hosts, hostName)`)
//       makes `Array.isArray(hosts)` false, so `ownerForTicket` returns null and
//       `null === hostName` is false. Every one of 11 tickets read as "not owned".
//   (3) empty input set → vacuous loop → conclusion printed anyway — a `for` over
//       an empty capture never runs its body, and the trailing "no output means
//       unrelated" line prints regardless.
//   (4) right question, wrong surface — counting a bot's ISSUE comments returns 0
//       while an unresolved REVIEW THREAD is what actually blocks the merge.
//
// THE SHARED RULE (invariant I1, "an absence carries a reason", applied to our own
// tooling): a negative result is only evidence if you can state what a positive one
// would have looked like AND the instrument demonstrably produced one. So every
// helper here returns a VERDICT that is either conclusive or explicitly
// inconclusive — never a bare `0`/`false`/`undefined` that a caller can mistake for
// a measured answer. Malformed input THROWS rather than returning a falsy sentinel.
//
// Zero imports beyond node builtins and ./event-name.mjs (itself import-free), so
// `catalyst doctor`'s bare-Node runtime and the bash callers' `node -e` one-liners
// can both load this without a dependency graph.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { getEventName } from "./event-name.mjs"; // CTL-1834: THE shared event-name boundary (import-free leaf)

// VerificationError — thrown for malformed input. Distinct class so a caller can
// tell "you asked the question wrong" from "the question has no answer today".
export class VerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerificationError";
  }
}

// conclusive / inconclusive — the two verdict constructors. `value` is the
// measured answer; `evidence` always carries the positive control that licenses
// it, so a reader can audit WHY a zero counts as a zero.
function conclusive(value, evidence) {
  return { conclusive: true, value, evidence, reason: null };
}
function inconclusive(reason, evidence) {
  return { conclusive: false, value: null, evidence, reason };
}

// mustBeConclusive — unwrap a verdict or throw. Use at a call site that is about
// to ACT on the answer, so an inconclusive check can never be silently treated as
// a negative one.
export function mustBeConclusive(verdict, context = "check") {
  if (!verdict || typeof verdict !== "object" || typeof verdict.conclusive !== "boolean") {
    throw new VerificationError(`${context}: expected a verdict object, got ${typeof verdict}`);
  }
  if (!verdict.conclusive) {
    throw new VerificationError(`${context}: INCONCLUSIVE — ${verdict.reason}`);
  }
  return verdict.value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new VerificationError(
      `${name} must be a non-empty string, got ${value === null ? "null" : typeof value}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// (1) countEventsByName — count events by EXACT event.name, never by substring.
// ---------------------------------------------------------------------------
//
// Matches an event when its `attributes["event.name"]` equals `eventName` or is a
// dotted extension of it (`phase.advance.applied` matches
// `phase.advance.applied.PROJ-56`) — the repo's per-ticket event-name convention.
// Prose that merely MENTIONS the name (a commit message inside a GitHub event
// body) is structurally unreachable, because only the name FIELD is consulted.
//
// The positive control is `parsedEvents`: the number of lines that parsed as JSON
// AND carried a string event name. A zero count is conclusive only when the
// instrument demonstrably read at least one real event. If nothing parsed, the
// answer is INCONCLUSIVE — that is the case where "absent" and "could not look"
// are indistinguishable, and it is exactly the one the old grep silently collapsed.
export async function countEventsByName(eventName, { lines, logPath, maxBytes } = {}) {
  requireNonEmptyString(eventName, "eventName");
  if (lines === undefined && logPath === undefined) {
    throw new VerificationError("countEventsByName requires either `lines` or `logPath`");
  }
  if (lines !== undefined && !Array.isArray(lines)) {
    throw new VerificationError("`lines` must be an array of strings when provided");
  }

  let source;
  if (lines !== undefined) {
    source = lines;
  } else {
    requireNonEmptyString(logPath, "logPath");
    // A missing/unreadable log is NOT zero events — it is a failure to look.
    if (!existsSync(logPath)) {
      return inconclusive(`log not found: ${logPath}`, { parsedEvents: 0, matched: 0 });
    }
    if (maxBytes !== undefined) {
      const size = statSync(logPath).size;
      if (size > maxBytes) {
        return inconclusive(`log is ${size} bytes, above the ${maxBytes} cap`, {
          parsedEvents: 0,
          matched: 0,
        });
      }
    }
    source = null; // streamed below
  }

  let parsedEvents = 0;
  let parseFailures = 0;
  let matched = 0;
  const prefix = `${eventName}.`;

  const consume = (line) => {
    if (typeof line !== "string" || line.trim() === "") return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      parseFailures += 1;
      return;
    }
    // CTL-1834: resolve through the SHARED boundary. This helper is the repo's
    // own anti-false-clean instrument, and it read only the v2 key — so a v1-only
    // family (e.g. `phase.terminal.reap-requested`, 140,017 lines in 2026-08) came
    // back as a CONCLUSIVE zero with its own positive control asserting it could
    // look. That is mechanism (4) above — the right question asked of the wrong
    // surface — inside the tool written to prevent mechanisms (1)-(4).
    const name = getEventName(obj);
    if (name === "") return;
    parsedEvents += 1;
    if (name === eventName || name.startsWith(prefix)) matched += 1;
  };

  if (source !== null) {
    for (const line of source) consume(line);
  } else {
    // Stream: the live event log reaches multiple GB, and a whole-file read has
    // already stalled three daemons for ~115s in this repo's history.
    await new Promise((resolvePromise, rejectPromise) => {
      const stream = createReadStream(logPath, { encoding: "utf8" });
      stream.on("error", rejectPromise);
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", consume);
      rl.on("close", resolvePromise);
      rl.on("error", rejectPromise);
    });
  }

  const evidence = { parsedEvents, parseFailures, matched, eventName };
  if (parsedEvents === 0) {
    return inconclusive(
      "no parseable events carrying a resolvable event name were read — cannot distinguish " +
        "'this event never occurred' from 'the instrument could not look'",
      evidence,
    );
  }
  return conclusive(matched, evidence);
}

// ---------------------------------------------------------------------------
// (2) resolveOwnership — HRW ownership that cannot be called wrong.
// ---------------------------------------------------------------------------
//
// Takes NAMED options, not positional args: the transposition that produced 11
// false "NO"s is structurally unavailable, because the arguments no longer have
// an order. Malformed input throws instead of degrading to a falsy sentinel.
//
// The hash is a local re-implementation of hrw.mjs's `score` — deliberately, so
// this leaf keeps a zero-dependency import graph. `ownershipMatchesHrw` in the
// test suite pins the two together, so a drift in either fails CI.
function hrwScore(ticketId, host) {
  const digest = createHash("sha1").update(`${ticketId}|${host}`).digest("hex");
  return Number.parseInt(digest.slice(0, 12), 16);
}

export function hrwOwner(ticketId, roster) {
  let best = null;
  let bestScore = -1;
  for (const host of roster) {
    const s = hrwScore(ticketId, host);
    if (s > bestScore || (s === bestScore && best !== null && host < best)) {
      bestScore = s;
      best = host;
    }
  }
  return best;
}

function requireRoster(roster, name = "roster") {
  if (!Array.isArray(roster)) {
    throw new VerificationError(
      `${name} must be an array of host names, got ${typeof roster} — ` +
        "this is the arity bug that silently reported 11 tickets as unowned",
    );
  }
  if (roster.length === 0) {
    throw new VerificationError(`${name} must be non-empty — an empty roster has no owner to compare`);
  }
  for (const host of roster) requireNonEmptyString(host, `${name} entry`);
  return roster;
}

export function resolveOwnership({ ticketId, roster, hostName } = {}) {
  requireNonEmptyString(ticketId, "ticketId");
  requireRoster(roster);
  requireNonEmptyString(hostName, "hostName");
  const owner = hrwOwner(ticketId, roster);
  return conclusive(owner === hostName, { owner, roster: [...roster], ticketId, hostName });
}

// ownershipPreflight — the discipline this repo learned the hard way: a host that
// is DOWN is still rostered, and computing ownership under only the live roster
// produces a false negative that strands a ticket. Ask under EVERY candidate
// roster and only claim ownership when they all agree.
//
// `value` is true only when `hostName` owns the ticket under every roster given.
// `evidence.owners` names the owner under each, so a disagreement is legible
// rather than collapsing to a bare false.
export function ownershipPreflight({ ticketId, rosters, hostName } = {}) {
  requireNonEmptyString(ticketId, "ticketId");
  if (!Array.isArray(rosters) || rosters.length === 0) {
    throw new VerificationError("rosters must be a non-empty array of rosters");
  }
  requireNonEmptyString(hostName, "hostName");
  const owners = rosters.map((roster, i) => {
    requireRoster(roster, `rosters[${i}]`);
    return { roster: [...roster], owner: hrwOwner(ticketId, roster) };
  });
  const agree = owners.every((o) => o.owner === hostName);
  return conclusive(agree, { owners, ticketId, hostName });
}

// ---------------------------------------------------------------------------
// (3) verifyAll — a loop over an empty candidate set cannot print a verdict.
// ---------------------------------------------------------------------------
//
// The vacuous-truth guard. `[].every(p)` is `true`, and a shell `for` over an
// empty capture runs its body zero times while the trailing "all clear" line
// prints anyway. Both report success on the strength of having checked nothing.
// Here an empty candidate set is INCONCLUSIVE by construction.
export function verifyAll(items, predicate, { label = "candidates" } = {}) {
  if (!Array.isArray(items)) {
    throw new VerificationError(`verifyAll expects an array of ${label}, got ${typeof items}`);
  }
  if (typeof predicate !== "function") {
    throw new VerificationError("verifyAll expects a predicate function");
  }
  if (items.length === 0) {
    return inconclusive(`no ${label} found — inconclusive, nothing was actually checked`, {
      checked: 0,
      passed: 0,
      failed: [],
    });
  }
  const failed = [];
  for (const item of items) {
    let ok;
    try {
      ok = predicate(item);
    } catch (err) {
      // A predicate that threw did not observe the item — that is a failure to
      // look, not a pass.
      return inconclusive(`predicate threw on ${JSON.stringify(item)}: ${err.message}`, {
        checked: items.length,
        passed: 0,
        failed: [],
      });
    }
    if (!ok) failed.push(item);
  }
  return conclusive(failed.length === 0, {
    checked: items.length,
    passed: items.length - failed.length,
    failed,
  });
}

// ---------------------------------------------------------------------------
// (4) prMergeBlockers — consult EVERY surface that can block a merge.
// ---------------------------------------------------------------------------
//
// A pull request can be blocked from at least four distinct places, and this
// repo's automated reviewer deliberately uses two of them for opposite signals:
// findings arrive as REVIEW THREADS, while a clean pass arrives as an ISSUE
// COMMENT or a reaction. Counting one surface answers a different question than
// the one asked.
//
// If ANY surface query fails, the whole verdict is INCONCLUSIVE. A partial read
// must never be reported as "nothing is blocking" — that is defect (4) exactly.
//
// `runJson` is an injectable seam: (args: string[]) => parsed JSON. Production
// passes a `gh` wrapper; tests pass a fake.
// A merge state that GitHub itself calls not-ready. If we return an EMPTY blocker
// list while GitHub says one of these, our enumeration missed something (a merge
// conflict, REVIEW_REQUIRED, an ACTION_REQUIRED check, …) and the honest answer
// is "inconclusive", not "clean".
// Enumerated from GitHub's MergeStateStatus: the READY set is exactly
// { CLEAN, HAS_HOOKS }? — no: HAS_HOOKS still requires the hooks to pass, and
// BEHIND requires an update before merge. Both were missing from an earlier
// revision of this set and would have produced "no blockers" on a PR GitHub
// itself refuses to merge. Only CLEAN is unambiguously ready.
const NOT_READY_MERGE_STATES = new Set([
  "DIRTY",
  "BLOCKED",
  "UNSTABLE",
  "UNKNOWN",
  "DRAFT",
  "BEHIND",
  "HAS_HOOKS",
]);

// Check conclusions that are neither success nor neutral. ACTION_REQUIRED and
// STARTUP_FAILURE are blockers that an enumerate-the-bad-ones list forgets.
const FAILING_CHECK_STATES = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ERROR",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);
const PENDING_CHECK_STATES = new Set(["", "PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED"]);
const PASSING_CHECK_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

// CTL-2181 — the four-valued ROLLUP verdict over a statusCheckRollup array.
//
// `pr-block-probe.mjs`'s `isFailingState` returns false for a PENDING conclusion
// AND for an absent one, so `!isFailingState(...)` reads "no CI run at all" as
// "CI passed". Any detector whose negative control is a PR with no CI run is
// therefore unsatisfiable when built on that boolean — which is exactly the
// finished-draft classifier's case. NONE and PENDING are distinct from PASSING
// here, and an unrecognised conclusion is UNKNOWN rather than silently green.
export const CI_STATE = Object.freeze({
  PASSING: "passing", // >=1 check, all SUCCESS/NEUTRAL/SKIPPED
  PENDING: "pending", // >=1 not-yet-concluded check (incl. "" — PENDING_CHECK_STATES)
  FAILING: "failing", // >=1 FAILURE/TIMED_OUT/CANCELLED/ERROR/ACTION_REQUIRED/STARTUP_FAILURE/STALE
  NONE: "none", // zero checks — NOT green
  UNKNOWN: "unknown", // a conclusion we have never seen — never silently passing
});

// classifyCheckRollup — pure. Precedence UNKNOWN > FAILING > PENDING > PASSING:
// an unrecognised conclusion dominates because "we could not classify it" must
// not be masked by a passing sibling — the same discipline `prMergeBlockers`
// applies with its `unclassifiedChecks` list, which reads the same three sets.
export function classifyCheckRollup(rollup) {
  const checks = Array.isArray(rollup) ? rollup : [];
  if (checks.length === 0) return CI_STATE.NONE;
  let sawFailing = false;
  let sawPending = false;
  let sawUnknown = false;
  for (const c of checks) {
    const raw = c?.conclusion ?? c?.state ?? null;
    const state = raw === null ? "" : String(raw).toUpperCase();
    if (FAILING_CHECK_STATES.has(state)) sawFailing = true;
    else if (PENDING_CHECK_STATES.has(state)) sawPending = true;
    else if (!PASSING_CHECK_STATES.has(state)) sawUnknown = true;
  }
  if (sawUnknown) return CI_STATE.UNKNOWN;
  if (sawFailing) return CI_STATE.FAILING;
  if (sawPending) return CI_STATE.PENDING;
  return CI_STATE.PASSING;
}

// isAutomatedReviewer — the bot whose review gates a merge here.
function isAutomatedReviewer(login) {
  return typeof login === "string" && /codex/i.test(login);
}

export async function prMergeBlockers({ prNumber, repo, runJson, reviewerPattern } = {}) {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new VerificationError(`prNumber must be a positive integer, got ${prNumber}`);
  }
  if (typeof runJson !== "function") {
    throw new VerificationError("prMergeBlockers requires a `runJson` seam");
  }
  const isReviewer =
    reviewerPattern instanceof RegExp
      ? (login) => typeof login === "string" && reviewerPattern.test(login)
      : isAutomatedReviewer;

  const surfaces = {};
  const failures = [];

  const ask = async (name, args) => {
    try {
      surfaces[name] = await runJson(args);
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
      surfaces[name] = null;
    }
  };

  const repoArgs = repo ? ["--repo", repo] : [];
  await ask("pr", [
    "pr",
    "view",
    String(prNumber),
    ...repoArgs,
    "--json",
    // reviewDecision is the AGGREGATE verdict. Raw `reviews` history keeps a
    // superseded CHANGES_REQUESTED forever, so a reviewer who later approved
    // would block this PR indefinitely.
    "mergeStateStatus,statusCheckRollup,reviews,reviewDecision,isDraft",
  ]);
  await ask("threads", ["__reviewThreads__", String(prNumber), ...repoArgs]);
  await ask("comments", ["__issueComments__", String(prNumber), ...repoArgs]);
  // The automated reviewer signals a clean pass with a REACTION as often as with
  // a comment. Counting comments alone cannot see a reaction-only clean pass —
  // which is defect (4) of this module's own preamble, one level up.
  await ask("reactions", ["__reactions__", String(prNumber), ...repoArgs]);

  if (failures.length > 0) {
    return inconclusive(
      `could not read ${failures.length} of 4 merge-blocking surfaces: ${failures.join("; ")} — ` +
        "a partial read cannot report 'nothing is blocking'",
      { surfaces, failures },
    );
  }

  const blockers = [];
  const pr = surfaces.pr ?? {};

  if (pr.isDraft === true) blockers.push({ surface: "pr", kind: "draft" });

  const unclassifiedChecks = [];
  for (const check of Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []) {
    const name = check?.name ?? check?.context ?? "unnamed-check";
    const raw = check?.conclusion ?? check?.state ?? null;
    const state = raw === null ? "" : String(raw).toUpperCase();
    if (FAILING_CHECK_STATES.has(state)) {
      blockers.push({ surface: "checks", kind: "failing", name, state });
    } else if (PENDING_CHECK_STATES.has(state)) {
      blockers.push({ surface: "checks", kind: "pending", name, state });
    } else if (!PASSING_CHECK_STATES.has(state)) {
      // A conclusion we have never seen. Do NOT silently treat it as passing.
      unclassifiedChecks.push({ name, state });
    }
  }

  // Aggregate decision, not raw history.
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    blockers.push({ surface: "reviews", kind: "changes-requested", decision: pr.reviewDecision });
  }

  const threads = Array.isArray(surfaces.threads) ? surfaces.threads : [];
  for (const thread of threads) {
    if (thread?.isResolved === false) {
      blockers.push({
        surface: "reviewThreads",
        kind: "unresolved-thread",
        id: thread?.id ?? null,
        path: thread?.path ?? null,
      });
    }
  }

  // Has the automated reviewer responded AT ALL? Green checks with no review yet
  // is not a clean PR — it is an unreviewed one, and reporting "no blockers"
  // there is exactly the "absence read as approval" this module exists to refuse.
  const comments = Array.isArray(surfaces.comments) ? surfaces.comments : [];
  const reactions = Array.isArray(surfaces.reactions) ? surfaces.reactions : [];
  const reviewerComments = comments.filter((c) => isReviewer(c?.user?.login ?? c?.author?.login));
  const reviewerReactions = reactions.filter((r) => isReviewer(r?.user?.login ?? r?.author?.login));
  const reviewerThreads = threads.length > 0;
  const reviewerResponded =
    reviewerComments.length > 0 ||
    reviewerReactions.length > 0 ||
    reviewerThreads ||
    typeof pr.reviewDecision === "string";
  if (!reviewerResponded) {
    blockers.push({ surface: "review", kind: "awaiting-automated-review" });
  }

  const evidence = {
    blockerCount: blockers.length,
    mergeStateStatus: pr.mergeStateStatus ?? null,
    reviewDecision: pr.reviewDecision ?? null,
    surfacesRead: Object.keys(surfaces),
    threadsSeen: threads.length,
    commentsSeen: comments.length,
    reactionsSeen: reactions.length,
    reviewerSignals: reviewerComments.length + reviewerReactions.length,
    unclassifiedChecks,
  };

  // Reconcile against GitHub's own aggregate before licensing a clean answer.
  const mergeState = typeof pr.mergeStateStatus === "string" ? pr.mergeStateStatus.toUpperCase() : null;
  if (blockers.length === 0 && unclassifiedChecks.length > 0) {
    return inconclusive(
      `every enumerated surface is clean but ${unclassifiedChecks.length} check(s) reported a ` +
        `conclusion this tool does not classify (${unclassifiedChecks
          .map((c) => `${c.name}=${c.state}`)
          .join(", ")}) — cannot license a clean verdict`,
      evidence,
    );
  }
  if (blockers.length === 0 && mergeState !== null && NOT_READY_MERGE_STATES.has(mergeState)) {
    return inconclusive(
      `every enumerated surface is clean, but GitHub reports mergeStateStatus=${mergeState} — ` +
        "something is blocking this merge that this tool did not enumerate (a merge conflict, " +
        "REVIEW_REQUIRED, a branch-protection rule); refusing to contradict GitHub's own status",
      evidence,
    );
  }

  return conclusive(blockers, evidence);
}
