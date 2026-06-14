#!/usr/bin/env bun
// archive-stale-host-workers.mjs — operator tool for archiving terminal ghost
// worker dirs whose host is neither in the cluster roster nor heartbeating.
// Dry-run by default; pass --apply to move dirs. CTL-1093 Phase 3.
//
// Usage:
//   bun archive-stale-host-workers.mjs [--apply] [--orch-dir <path>] [--archive-root <path>]
//
// Selector criteria (all must hold):
//   1. Every phase-*.json in the dir has a terminal status (complete|failed|skipped)
//   2. The dir's host.name is neither in the cluster roster nor currently heartbeating

import {
  readdirSync,
  readFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const TERMINAL_STATUSES = new Set(["complete", "failed", "skipped"]);

/**
 * Derive the effective host name from a worker directory by reading the first
 * phase signal file that has a host.name field. Returns null if none found.
 */
function workerHostName(workerDir) {
  let files;
  try { files = readdirSync(workerDir); } catch { return null; }
  for (const f of files.filter((f) => f.startsWith("phase-") && f.endsWith(".json"))) {
    try {
      const sig = JSON.parse(readFileSync(join(workerDir, f), "utf8"));
      const name = sig?.host?.name;
      if (typeof name === "string" && name.length > 0) return name;
    } catch { /* malformed — skip */ }
  }
  return null;
}

/**
 * Returns true when every phase-*.json in the dir has a terminal status.
 * Returns false if any phase is non-terminal (running/dispatched/pending/etc.)
 * or if there are no phase signal files (not a worker dir).
 */
function allPhasesTerminal(workerDir) {
  let files;
  try { files = readdirSync(workerDir); } catch { return false; }
  const phaseFiles = files.filter((f) => f.startsWith("phase-") && f.endsWith(".json"));
  if (phaseFiles.length === 0) return false;
  for (const f of phaseFiles) {
    try {
      const sig = JSON.parse(readFileSync(join(workerDir, f), "utf8"));
      if (!TERMINAL_STATUSES.has(sig?.status)) return false;
    } catch { return false; }
  }
  return true;
}

/**
 * Walk <orchDir>/workers/ and return dirs that match the stale-host selector:
 * - all phases terminal
 * - host.name ∉ roster
 * - host.name ∉ liveHosts
 * Logs every skip and why (never silently truncates).
 *
 * @param {{ orchDir: string, roster: string[], liveHosts: Set<string>, quiet?: boolean }}
 * @returns {{ ticket: string, dir: string, hostName: string }[]}
 */
export function selectStaleHostWorkerDirs({ orchDir, roster, liveHosts, quiet = false }) {
  const workersDir = join(orchDir, "workers");
  let entries;
  try { entries = readdirSync(workersDir); } catch { return []; }

  const results = [];
  for (const ticket of entries) {
    const d = join(workersDir, ticket);
    try {
      if (!statSync(d).isDirectory()) continue;
    } catch { continue; }

    if (!allPhasesTerminal(d)) {
      if (!quiet) console.error(`skip ${ticket}: not all phases terminal`);
      continue;
    }
    const host = workerHostName(d);
    if (!host) {
      if (!quiet) console.error(`skip ${ticket}: no host.name found`);
      continue;
    }
    if (roster.includes(host)) {
      if (!quiet) console.error(`skip ${ticket}: host "${host}" is in roster`);
      continue;
    }
    if (liveHosts.has(host)) {
      if (!quiet) console.error(`skip ${ticket}: host "${host}" is currently live`);
      continue;
    }
    results.push({ ticket, dir: d, hostName: host });
  }
  return results;
}

/**
 * Dry-run (apply=false): return the stale dirs without moving them.
 * Apply (apply=true): move each stale dir to <archiveRoot>/<ticket>/.
 *
 * @param {{ orchDir: string, archiveRoot: string, roster: string[], liveHosts: Set<string>, apply?: boolean, quiet?: boolean }}
 * @returns {{ archived: string[], skipped: string[] }}
 */
export function archiveStaleHostWorkerDirs({
  orchDir,
  archiveRoot,
  roster,
  liveHosts,
  apply = false,
  quiet = false,
}) {
  const stale = selectStaleHostWorkerDirs({ orchDir, roster, liveHosts, quiet });
  const archived = [];
  const skipped = [];

  for (const { ticket, dir } of stale) {
    if (!apply) {
      if (!quiet) console.log(`[dry-run] would archive ${ticket} (${dir})`);
      archived.push(ticket);
      continue;
    }
    try {
      const dest = resolve(archiveRoot, ticket);
      mkdirSync(archiveRoot, { recursive: true });
      renameSync(dir, dest);
      if (!quiet) console.log(`archived ${ticket} → ${dest}`);
      archived.push(ticket);
    } catch (err) {
      if (!quiet) console.error(`failed to archive ${ticket}: ${err.message}`);
      skipped.push(ticket);
    }
  }
  return { archived, skipped };
}

// CLI entrypoint when run directly
if (import.meta.main) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const orchIdx = args.indexOf("--orch-dir");
  const orchDir = orchIdx !== -1 ? args[orchIdx + 1] : join(homedir(), "catalyst", "execution-core");
  const archIdx = args.indexOf("--archive-root");
  const archiveRoot = archIdx !== -1 ? args[archIdx + 1] : join(homedir(), "catalyst", "archives");

  // Import cluster config at runtime (not available during unit tests)
  const { getClusterHosts } = await import("./config.mjs");
  const { readClusterHeartbeats } = await import("./recovery.mjs");

  const roster = getClusterHosts();
  const heartbeats = readClusterHeartbeats();
  const HEARTBEAT_GRACE_MS = 10 * 60 * 1000; // 10 minutes
  const now = Date.now();
  const liveHosts = new Set(
    Object.entries(heartbeats)
      .filter(([, ts]) => now - new Date(ts).getTime() < HEARTBEAT_GRACE_MS)
      .map(([host]) => host),
  );

  console.log(`roster: [${roster.join(", ")}]`);
  console.log(`live hosts: [${[...liveHosts].join(", ")}]`);
  console.log(`orch dir: ${orchDir}`);
  console.log(`archive root: ${archiveRoot}`);
  console.log(apply ? "mode: APPLY" : "mode: dry-run (pass --apply to move dirs)");
  console.log("");

  const { archived, skipped } = archiveStaleHostWorkerDirs({
    orchDir,
    archiveRoot,
    roster,
    liveHosts,
    apply,
  });

  console.log(`\nSummary: ${archived.length} archived, ${skipped.length} skipped`);
  if (!apply && archived.length > 0) {
    console.log("Re-run with --apply to move these dirs.");
  }
}
