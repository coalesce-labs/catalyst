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
import { runSweep } from "./linear-feed-sweep.mjs";

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
    cursorPath: join(orchDir, `linear-feed-cursor-${account}.json`),
    shadowPath: join(orchDir, "shadow", `linear-feed-${account}.jsonl`),
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
  sweep = runSweep,
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
    try {
      source = makeSource(plan);
      const sink = makeSink(plan);
      const result = sweep({
        source,
        cursorPath: plan.cursorPath,
        teams: plan.teams,
        botUserIds,
        emit: sink.emit,
        now,
      });
      reports.push({
        account: plan.account,
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
    }
  }
  return reports;
}
