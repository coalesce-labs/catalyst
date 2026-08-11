#!/usr/bin/env bun
// sweep-stale-recovery-intents.mjs — CTL-1431 / CAT-124 operator hygiene tool.
//
// Lists (and, with --execute, DELETES) escalated recovery-intent ledger entries
// under <orchDir>/.recovery-intents/ that have aged past
// RECOVERY_TERMINAL_INTENT_TTL_MS. Dry-run by default; pass --execute to delete.
//
// This is HYGIENE, not a functional gate. Once the CTL-1431 age-gate in
// defaultShouldSkipItem ships, a June (>7-day-old) escalated intent auto-becomes
// non-terminal on the next scheduler tick — the ticket re-enters triage with the
// stale `.recovery-intents/<ticket>.json` still on disk. This tool just clears
// that leftover file so the ledger dir doesn't accumulate dead terminal markers;
// nothing depends on it running. The second marker family lives under
// .recovery-fix-failures/<ticket>-<fix_class>.json. Its newest lastTs or
// lastCommentTs is aged, then the exact file path is unlinked (clearFixFailures
// intentionally preserves comment hashes). The default TTL is at least twice
// the maximum fix-backoff window, so swept files cannot carry a live backoff.
//
// Usage:
//   bun sweep-stale-recovery-intents.mjs [--execute] [--orch-dir <path>]
//     [--family intents|fix-failures|all] [--ttl-days <n>] [--fix-ttl-days <n>]
//
// Selector: entry.escalated === true AND (now - last) >= ttlMs, where
//   last = typeof lastTs === "number" ? lastTs : ts   (mirrors defaultShouldSkipItem)

import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  RECOVERY_TERMINAL_INTENT_TTL_MS,
  defaultForgetIntent,
} from "./recovery-reasoning.mjs";
import {
  RECOVERY_FIX_BACKOFF_MAX_MS,
  RECOVERY_FIX_FAILURES_DIR,
} from "./recovery-fix-backoff.mjs";

/**
 * Scan <orchDir>/.recovery-intents/ and return the escalated entries older than
 * the TTL. Pure read: never mutates. Malformed / non-.json files are skipped.
 *
 * @param {{ orchDir: string, now?: () => number, ttlMs?: number }} opts
 * @returns {{ ticket: string, ageMs: number, last: number }[]}
 */
export function selectStaleRecoveryIntents({
  orchDir,
  now = () => Date.now(),
  ttlMs = RECOVERY_TERMINAL_INTENT_TTL_MS,
} = {}) {
  if (!orchDir) return [];
  // CTL-1431 Codex F1: a non-finite / non-positive ttl (e.g. a mistyped `--ttl-days
  // foo` → NaN) would make `ageMs < ttlMs` always false, marking EVERY escalated
  // intent stale and sweeping the whole ledger. Fail loud instead of silently deleting.
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`selectStaleRecoveryIntents: ttlMs must be a positive finite number (got ${ttlMs})`);
  }
  const dir = join(orchDir, ".recovery-intents");
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return []; // absent dir → nothing to sweep
  }

  const stale = [];
  const t = now();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let data;
    try {
      data = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue; // malformed → skip
    }
    if (data?.escalated !== true) continue;
    const last = typeof data?.lastTs === "number" ? data.lastTs : data?.ts;
    if (typeof last !== "number") continue; // no timestamp → cannot age it out
    const ageMs = t - last;
    if (ageMs < ttlMs) continue; // still within the terminal TTL
    // Derive the ticket from the filename so the delete path is guaranteed to
    // target this exact file (recoveryIntentPath joins ticket + ".json").
    stale.push({ ticket: f.replace(/\.json$/, ""), ageMs, last });
  }
  return stale;
}

export const RECOVERY_FIX_FAILURE_TTL_MS = Math.max(
  2 * RECOVERY_TERMINAL_INTENT_TTL_MS,
  2 * RECOVERY_FIX_BACKOFF_MAX_MS,
);

export function selectStaleFixFailures({
  orchDir,
  now = () => Date.now(),
  ttlMs = RECOVERY_FIX_FAILURE_TTL_MS,
} = {}) {
  if (!orchDir) return { stale: [], unagable: [] };
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`selectStaleFixFailures: ttlMs must be a positive finite number (got ${ttlMs})`);
  }
  const dir = join(orchDir, RECOVERY_FIX_FAILURES_DIR);
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return { stale: [], unagable: [] };
  }

  const stale = [];
  const unagable = [];
  const t = now();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    let data;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const anchors = [data?.lastTs, data?.lastCommentTs].filter(Number.isFinite);
    if (anchors.length === 0) {
      unagable.push({ file });
      continue;
    }
    const last = Math.max(...anchors);
    const ageMs = t - last;
    if (ageMs < ttlMs) continue;
    stale.push({ file, path, ageMs, last });
  }
  return { stale, unagable };
}

/**
 * Dry-run (execute=false): return the stale intents without deleting.
 * Execute (execute=true): defaultForgetIntent each stale entry.
 *
 * @param {{ orchDir: string, now?: () => number, ttlMs?: number, execute?: boolean,
 *           forgetIntent?: (ticket: string, opts: object) => boolean, quiet?: boolean }} opts
 * @returns {{ swept: string[], skipped: string[], stale: {ticket:string,ageMs:number}[] }}
 */
export function sweepStaleRecoveryIntents({
  orchDir,
  now = () => Date.now(),
  ttlMs = RECOVERY_TERMINAL_INTENT_TTL_MS,
  execute = false,
  forgetIntent = defaultForgetIntent,
  quiet = false,
} = {}) {
  const stale = selectStaleRecoveryIntents({ orchDir, now, ttlMs });
  const swept = [];
  const skipped = [];

  for (const { ticket, ageMs } of stale) {
    const ageDays = (ageMs / 864e5).toFixed(1);
    if (!execute) {
      if (!quiet) console.log(`[dry-run] would sweep ${ticket} (escalated, ${ageDays}d old)`);
      swept.push(ticket);
      continue;
    }
    if (forgetIntent(ticket, { orchDir })) {
      if (!quiet) console.log(`swept ${ticket} (escalated, ${ageDays}d old)`);
      swept.push(ticket);
    } else {
      if (!quiet) console.error(`failed to sweep ${ticket}`);
      skipped.push(ticket);
    }
  }
  return { swept, skipped, stale };
}

export function sweepStaleFixFailures({
  orchDir,
  now = () => Date.now(),
  ttlMs = RECOVERY_FIX_FAILURE_TTL_MS,
  execute = false,
  unlink = (path) => { unlinkSync(path); },
  quiet = false,
} = {}) {
  const { stale, unagable } = selectStaleFixFailures({ orchDir, now, ttlMs });
  const swept = [];
  const skipped = [];

  for (const { file } of unagable) {
    if (!quiet) console.log(`${file}: no lastTs/lastCommentTs — left in place`);
  }
  for (const { file, path, ageMs } of stale) {
    const ageDays = (ageMs / 864e5).toFixed(1);
    if (!execute) {
      if (!quiet) console.log(`[dry-run] would sweep ${file} (${ageDays}d old)`);
      swept.push(file);
      continue;
    }
    try {
      unlink(path);
      if (!quiet) console.log(`swept ${file} (${ageDays}d old)`);
      swept.push(file);
    } catch {
      if (!quiet) console.error(`failed to sweep ${file}`);
      skipped.push(file);
    }
  }
  return { swept, skipped, stale, unagable };
}

// CLI entrypoint when run directly.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const familyIdx = args.indexOf("--family");
  const family = familyIdx !== -1 ? args[familyIdx + 1] : "all";
  if (!["intents", "fix-failures", "all"].includes(family)) {
    console.error(`error: --family must be intents, fix-failures, or all (got: ${family ?? "<missing>"})`);
    process.exit(2);
  }
  const orchIdx = args.indexOf("--orch-dir");
  const orchDir =
    orchIdx !== -1
      ? args[orchIdx + 1]
      : process.env.CATALYST_ORCHESTRATOR_DIR ?? join(homedir(), "catalyst", "execution-core");
  const ttlIdx = args.indexOf("--ttl-days");
  let ttlMs = RECOVERY_TERMINAL_INTENT_TTL_MS;
  if (ttlIdx !== -1) {
    // CTL-1431 Codex F1: validate before it can reach the selector as NaN and sweep
    // the whole ledger. A mistyped/omitted value is a hard error, not a silent delete.
    const days = Number(args[ttlIdx + 1]);
    if (!Number.isFinite(days) || days <= 0) {
      console.error(`error: --ttl-days requires a positive number (got: ${args[ttlIdx + 1] ?? "<missing>"})`);
      process.exit(2);
    }
    ttlMs = days * 864e5;
  }
  const fixTtlIdx = args.indexOf("--fix-ttl-days");
  let fixTtlMs = RECOVERY_FIX_FAILURE_TTL_MS;
  if (fixTtlIdx !== -1) {
    const days = Number(args[fixTtlIdx + 1]);
    if (!Number.isFinite(days) || days <= 0) {
      console.error(`error: --fix-ttl-days requires a positive number (got: ${args[fixTtlIdx + 1] ?? "<missing>"})`);
      process.exit(2);
    }
    fixTtlMs = days * 864e5;
  }
  if ((family === "fix-failures" || family === "all") && fixTtlMs < RECOVERY_FIX_BACKOFF_MAX_MS) {
    console.warn("warning: fix-failure TTL is shorter than the max backoff window — may delete a live backoff latch");
  }

  console.log(`orch dir: ${orchDir}`);
  if (family === "intents" || family === "all") console.log(`intent ttl: ${(ttlMs / 864e5).toFixed(1)}d`);
  if (family === "fix-failures" || family === "all") console.log(`fix-failure ttl: ${(fixTtlMs / 864e5).toFixed(1)}d`);
  console.log(execute ? "mode: EXECUTE" : "mode: dry-run (pass --execute to delete)");
  console.log("");

  let wouldSweep = 0;
  if (family === "intents" || family === "all") {
    const { swept, skipped } = sweepStaleRecoveryIntents({ orchDir, ttlMs, execute });
    wouldSweep += swept.length;
    console.log(`\nIntents: ${swept.length} ${execute ? "swept" : "would-sweep"}, ${skipped.length} skipped`);
  }
  if (family === "fix-failures" || family === "all") {
    const { swept, skipped, unagable } = sweepStaleFixFailures({ orchDir, ttlMs: fixTtlMs, execute });
    wouldSweep += swept.length;
    console.log(`\nFix failures: ${swept.length} ${execute ? "swept" : "would-sweep"}, ${skipped.length} skipped, ${unagable.length} un-agable`);
  }
  if (!execute && wouldSweep > 0) {
    console.log("Re-run with --execute to delete these stale recovery markers.");
  }
}
