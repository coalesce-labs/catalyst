#!/usr/bin/env bun
// sweep-stale-recovery-intents.mjs — CTL-1431 one-time operator hygiene tool.
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
// nothing depends on it running.
//
// Usage:
//   bun sweep-stale-recovery-intents.mjs [--execute] [--orch-dir <path>] [--ttl-days <n>]
//
// Selector: entry.escalated === true AND (now - last) >= ttlMs, where
//   last = typeof lastTs === "number" ? lastTs : ts   (mirrors defaultShouldSkipItem)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  RECOVERY_TERMINAL_INTENT_TTL_MS,
  defaultForgetIntent,
} from "./recovery-reasoning.mjs";

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

// CLI entrypoint when run directly.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const orchIdx = args.indexOf("--orch-dir");
  const orchDir =
    orchIdx !== -1
      ? args[orchIdx + 1]
      : process.env.CATALYST_ORCHESTRATOR_DIR ?? join(homedir(), "catalyst", "execution-core");
  const ttlIdx = args.indexOf("--ttl-days");
  const ttlMs = ttlIdx !== -1 ? Number(args[ttlIdx + 1]) * 864e5 : RECOVERY_TERMINAL_INTENT_TTL_MS;

  console.log(`orch dir: ${orchDir}`);
  console.log(`ttl: ${(ttlMs / 864e5).toFixed(1)}d`);
  console.log(execute ? "mode: EXECUTE" : "mode: dry-run (pass --execute to delete)");
  console.log("");

  const { swept, skipped } = sweepStaleRecoveryIntents({ orchDir, ttlMs, execute });

  console.log(`\nSummary: ${swept.length} ${execute ? "swept" : "would-sweep"}, ${skipped.length} skipped`);
  if (!execute && swept.length > 0) {
    console.log("Re-run with --execute to delete these stale terminal intents.");
  }
}
