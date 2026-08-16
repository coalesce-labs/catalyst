// linear-feed-run.mjs — CTL-1847, the per-tenant runner.
//
// Ties the four pieces together: for each tenant this host serves, read its replica
// (`linear-feed-source`), sweep new edges (`linear-feed-sweep`), and emit them to a
// shadow sink (`linear-feed-shadow`) that structurally cannot be the event log.
//
// ── ONE PRODUCER PER TENANT, EVEN THOUGH THERE IS ONE TENANT ────────────────
// The tenant list is length 1 today and the loop is therefore trivial — that is
// deliberate. Every per-tenant input (replica path, cursor path, team set) is a
// per-producer value rather than a module-level constant, so serving N tenants is a
// longer list rather than a rewrite.
//
// ⚠️ It is length 1 for a measured reason, not an assumption: `cloud-sync.mjs`
// resolves ONE account per process and then takes `getReplicaDbPath()`, which is a
// fixed path with no account dimension — so a second account on this host would
// target the same file behind the same writer lock. Per-account replica paths are
// CTL-1893; until that lands, a host serves one tenant and this loop runs once.
//
// ── A MISSING REPLICA IS NOT AN ERROR ───────────────────────────────────────
// A tenant with no replica on this host simply has no producer, and says so. That
// is the normal state for a host that serves a subset of the fleet's tenants —
// treating it as an error would make the common case look broken and train whoever
// reads the log to ignore it.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getReplicaDbPath } from "./config.mjs";
import { listProjects } from "./registry.mjs";
import { createFeedSource } from "./linear-feed-source.mjs";
import { createShadowSink } from "./linear-feed-shadow.mjs";
import { runDiffSweep, runSweep } from "./linear-feed-sweep.mjs";
import { createLastSeenStore } from "./linear-feed-lastseen.mjs";

/** Matches cloud-sync.mjs's own resolution, so the two cannot disagree about which account this host is. */
export const DEFAULT_ACCOUNT = "tenant-0";

/**
 * The tenants this host serves, each with everything its producer needs.
 *
 * Pure: every input is injected, so a test can describe a two-tenant host without
 * one existing. The cursor filename carries the account for the same reason the
 * list is a list — so N tenants need no new naming scheme later.
 */
export function planTenants({
  orchDir,
  // "diff" is the shipping edge source (issues-diff, webhook-fed, ~11s). "history"
  // is the superseded one, kept runnable so the two can be compared side by side
  // during the shadow window — separate cursor, shadow file and baseline, so neither
  // can contaminate the other's measurement.
  mode = "diff",
  account = process.env.CATALYST_CLOUD_ACCOUNT || DEFAULT_ACCOUNT,
  projects = listProjects(),
  replicaPathFor = () => getReplicaDbPath(),
  exists = existsSync,
} = {}) {
  const teams = new Set(
    (Array.isArray(projects) ? projects : []).map((p) => p?.team).filter((t) => typeof t === "string" && t !== ""),
  );
  const dbPath = replicaPathFor(account);
  const plan = {
    account,
    teams,
    dbPath,
    mode,
    cursorPath: join(orchDir, `linear-feed-cursor-${account}${mode === "diff" ? ".diff" : ""}.json`),
    shadowPath: join(orchDir, "shadow", `linear-feed-${account}${mode === "diff" ? ".diff" : ""}.jsonl`),
    lastSeenPath: join(orchDir, `linear-feed-lastseen-${account}.db`),
  };
  if (!exists(dbPath)) {
    return [{ ...plan, skip: "replica-absent" }];
  }
  if (teams.size === 0) {
    // Distinct from replica-absent: the replica is here but nothing tells us which
    // teams are ours, and an empty team set means the classifier refuses everything.
    // Naming it separately is the difference between "not this host's job" and
    // "misconfigured".
    return [{ ...plan, skip: "no-registered-teams" }];
  }
  return [{ ...plan, skip: null }];
}

/**
 * Run one sweep for every planned tenant.
 *
 * Returns a per-tenant report; logging is the caller's business. A tenant that
 * throws does not stop the others — on a multi-tenant host one bad replica must not
 * silence the rest.
 */
export function runOnce({
  orchDir,
  plans = planTenants({ orchDir }),
  makeSource = (p) => createFeedSource({ dbPath: p.dbPath }),
  makeSink = (p) => createShadowSink({ path: p.shadowPath }),
  makeStore = (p) => createLastSeenStore({ path: p.lastSeenPath }),
  sweep = null,
  botUserIds,
  now,
} = {}) {
  const reports = [];
  for (const plan of plans) {
    if (plan.skip) {
      reports.push({ account: plan.account, skipped: plan.skip });
      continue;
    }
    let source = null;
    let store = null;
    try {
      source = makeSource(plan);
      const sink = makeSink(plan);
      const args = { source, cursorPath: plan.cursorPath, teams: plan.teams, botUserIds, emit: sink.emit, now };
      let result;
      if (sweep) {
        result = sweep(args); // injected (tests)
      } else if (plan.mode === "diff") {
        store = makeStore(plan);
        result = runDiffSweep({ ...args, store });
      } else {
        result = runSweep(args);
      }
      reports.push({
        account: plan.account,
        mode: plan.mode,
        skipped: null,
        shadowPath: sink.path,
        sweep: result,
        coverage: sink.stats(),
      });
    } catch (err) {
      // Named, not swallowed: a tenant that cannot be swept is a reportable state,
      // and the shadow window's exit criterion must never be computed over a tenant
      // that silently produced nothing.
      reports.push({ account: plan.account, skipped: null, error: err?.message ?? String(err) });
    } finally {
      try {
        source?.close();
      } catch {
        /* already closed */
      }
      try {
        store?.close();
      } catch {
        /* already closed */
      }
    }
  }
  return reports;
}

/**
 * The coverage cells the shadow window must observe before it may exit. Three event
 * names the daemon acts on, with `issue.updated` fanned out per payload variant —
 * a single `updated` cell would let the window exit having exercised one mapping
 * while claiming them all.
 */
export const REQUIRED_CLASSES = Object.freeze([
  "linear.issue.state_changed",
  "linear.comment.created",
  "linear.issue.updated:state",
  "linear.issue.updated:assigneeId",
  "linear.issue.updated:priority",
  "linear.issue.updated:estimate",
  "linear.issue.updated:projectId",
  "linear.issue.updated:cycleId",
  "linear.issue.updated:parentId",
  "linear.issue.updated:teamId",
  "linear.issue.updated:title",
  "linear.issue.updated:dueDate",
  "linear.issue.updated:description",
  "linear.issue.updated:labels",
]);

/**
 * Merge per-tenant coverage and name the cells still short of `min`.
 *
 * Pure and exported so it is testable without running the script-shaped runner —
 * this logic already carried a real bug (an earlier cut computed it from an empty
 * plan list, reporting every class missing right after a successful sweep), which is
 * exactly the CTL-1659 lesson about extracting the pure part of a script.
 *
 * ⚠️ An empty report list yields EVERY class missing, not "complete". An all-clear
 * derived from having looked at nothing is the `[].every()` shape this repo keeps
 * finding.
 */
export function coverageGaps(reports, required = REQUIRED_CLASSES, min = 1) {
  const merged = {};
  for (const r of Array.isArray(reports) ? reports : []) {
    for (const [cls, n] of Object.entries(r?.coverage?.classes ?? {})) {
      merged[cls] = (merged[cls] ?? 0) + n;
    }
  }
  const missing = (required ?? []).filter((c) => (merged[c] ?? 0) < min);
  return { merged, missing, complete: missing.length === 0 };
}
