// webhook-replica-writer.mjs — CAT-152. Webhook-fed alternative to
// cloud-sync.mjs's CatalystReplica writer: same primitives (claimWriterLock,
// applyMigrations/MIRROR_TABLE_META, applyDelta), driven by already-live
// Linear webhook events instead of the unprovisioned Catalyst Cloud feed.
// One instance per host, in-process inside orch-monitor/server.ts (wired via
// the webhook handler's onAccept hook).

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { claimWriterLock } from "@catalyst-cloud/sdk/node";
import { applyMigrations, MIRROR_MIGRATIONS } from "@catalyst-cloud/schema";
import { applyDelta, setCursor } from "@catalyst-cloud/replicate";
import { mapIssueChange, mapIssueLabels, mapCommentChange } from "./webhook-replica-mappers.mjs";

// BACKFILL_LIMIT — mirrors linear-query.mjs's DEFAULT_LIMIT: one bounded,
// single-page `linearis issues list` call, never a multi-page loop (no
// cursor-pagination helper exists for `issues list` in this codebase — see
// the CAT-152 research doc's Open Question / "What We're NOT Doing").
const BACKFILL_LIMIT = 200;

// defaultListIssues — spawns `linearis issues list --team <teamKey> --limit
// 200` directly (its own small wrapper, not linear-query.mjs's runEligibleQuery,
// which is tightly coupled to the daemon's eligibility/replica-fallback
// machinery — a poor fit for a writer whose whole job is POPULATING that same
// replica). `spawn` is injectable so tests never shell out for real.
export function defaultListIssues(teamKey, { spawn = spawnSync } = {}) {
  const res = spawn("linearis", ["issues", "list", "--team", teamKey, "--limit", String(BACKFILL_LIMIT)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!res || res.status !== 0 || typeof res.stdout !== "string") return [];
  try {
    return JSON.parse(res.stdout)?.nodes ?? [];
  } catch {
    return [];
  }
}

const SYNC_META_DDL = "CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT);";

// claimWriterLock (vendored @catalyst-cloud/sdk) invokes log as a plain
// (level, message, ...extra) => void function (see writer-lock.js's
// `log?.("info", ...)` / `log?.("warn", ...)` calls) — not console's
// per-level methods. Defaulting to `console` itself breaks the moment the
// writer needs to reclaim its own crashed predecessor's lock (a `TypeError:
// log is not a function`, since `console` isn't callable), which silently
// wedges every subsequent applyEvent/backfillTeam call behind a lock that
// never gets reclaimed.
function consoleLog(level, message, ...extra) {
  (console[level] ?? console.log)(message, ...extra);
}

function toBindable(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

export function createWebhookReplicaWriter({ dbPath, ownerKey, log = consoleLog } = {}) {
  const writerLock = claimWriterLock(dbPath, { ownerKey }, log);
  const sqlite = new Database(dbPath, { create: true });
  // applyMigrations wants MigrationDb ({exec, query: sql=>rows[]}); applyDelta/
  // getCursor/setCursor want ReplicaWriteDb ({run, get}) — two different shims
  // over the same underlying bun:sqlite handle.
  const migrationDb = {
    exec: (sql) => sqlite.exec(sql),
    query: (sql) => sqlite.query(sql).all(),
  };
  const writeDb = {
    run: (sql, ...b) => sqlite.run(sql, ...b).changes,
    get: (sql, ...b) => sqlite.query(sql).get(...b),
  };
  applyMigrations(migrationDb, MIRROR_MIGRATIONS);
  sqlite.run(SYNC_META_DDL);

  function applyOne(change) {
    applyDelta(writeDb, change, toBindable);
  }

  function applyEvent(event) {
    sqlite.transaction(() => {
      if (event.kind === "issue") {
        applyOne(mapIssueChange(event));
        if (event.action !== "remove") {
          const { labelDefs, issueLabelLinks } = mapIssueLabels(event);
          for (const c of labelDefs) applyOne(c);
          for (const c of issueLabelLinks) applyOne(c);
        }
      } else if (event.kind === "comment") {
        applyOne(mapCommentChange(event));
      }
      // Other kinds (cycle/reaction/project/issue_label) are out of scope for v1 — no-op.
    })();
  }

  async function backfillTeam(teamKey, { listIssues = defaultListIssues } = {}) {
    const rows = (await listIssues(teamKey)) ?? [];
    sqlite.transaction(() => {
      for (const issue of rows) {
        applyOne(mapIssueChange({ kind: "issue", action: "create", ticket: issue.identifier, issueId: issue.id, data: issue }));
      }
      setCursor(writeDb, `seeded:${teamKey}:${Date.now()}`, toBindable);
    })();
  }

  function close() {
    sqlite.close();
    writerLock?.release();
  }

  return { applyEvent, backfillTeam, close };
}
