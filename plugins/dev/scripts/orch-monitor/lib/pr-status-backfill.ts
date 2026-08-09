// pr-status-backfill.ts — CTL-1606 (Codex #2878 P1): seed pr_status_cache on upgrade.
//
// The per-PR status store is populated only by the pull_request webhook write in
// webhook-handler.ts. On a fleet that upgrades INTO this feature the table starts
// empty, and startup recovery replays only the last hour of deliveries
// (server.ts). A PR that merged before that window emits no further webhook — a
// merged PR is terminal and quiet — so its row is never created, getAllPrStatuses()
// returns nothing for it, and the phantom-merged invariant stays blind to exactly
// the pre-existing stuck tickets this ticket targets.
//
// This closes that gap once, at startup, by asking GitHub for the current state of
// each watched repo's recent PRs. Properties that matter:
//   • ONE-SHOT: skipped entirely when the table already has rows, so it costs
//     nothing on every subsequent boot — it is a migration step, not a poll.
//   • BEST-EFFORT: never throws and never blocks startup. A missing `gh`, an auth
//     failure, or a rate limit leaves the table as it was; the webhook path still
//     populates it going forward, which is the pre-existing behavior.
//   • TERMINAL-SAFE: writes through the same putStatus as the webhook path, whose
//     `merged` latch means a backfill can never walk back a live-observed merge.

import type { PrCacheLike } from "./pr-cache";

export interface BackfillRunner {
  (argv: string[]): Promise<{ ok: boolean; stdout: string }>;
}

export interface BackfillDeps {
  cache: PrCacheLike;
  repos: string[];
  runner: BackfillRunner;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  /** How many recent PRs per repo to seed. */
  limit?: number;
}

// GitHub's `state` is OPEN | CLOSED | MERGED. board-health.mjs expects the
// lowercase "open" | "closed" | "merged" triple, and treats a merged PR as
// terminal — so map MERGED first and never infer it from `closed` alone.
export function normalizePrState(state: unknown, mergedAt: unknown): string | null {
  // `state` is typed `unknown` (it comes straight off parsed gh JSON), so it can
  // be an object — and `String(someObject)` yields "[object Object]", which is
  // both meaningless here and a lint error (no-base-to-string). Only a string is
  // ever a real GitHub state; anything else falls through to the `null` return
  // below, which is the documented "unrecognized → skip rather than guess" path.
  const s = typeof state === "string" ? state.toUpperCase() : "";
  if (s === "MERGED" || (mergedAt != null && mergedAt !== "")) return "merged";
  if (s === "CLOSED") return "closed";
  if (s === "OPEN") return "open";
  return null; // unrecognized → skip rather than guess a lifecycle state
}

export async function backfillPrStatuses(deps: BackfillDeps): Promise<number> {
  const { cache, repos, runner, logger, limit = 200 } = deps;
  try {
    // One-shot guard: only a genuinely empty store is a fresh migration.
    if (cache.getAllStatuses().length > 0) return 0;
  } catch (err) {
    logger?.warn?.(
      `[pr-status-backfill] cannot read existing statuses; skipping: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
  }

  let seeded = 0;
  for (const repo of repos) {
    if (!repo) continue;
    let res: { ok: boolean; stdout: string };
    try {
      res = await runner([
        "gh",
        "pr",
        "list",
        "-R",
        repo,
        "--state",
        "all",
        "--limit",
        String(limit),
        "--json",
        "number,state,mergedAt",
      ]);
    } catch (err) {
      logger?.warn?.(
        `[pr-status-backfill] ${repo}: gh invocation failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    if (!res?.ok) {
      logger?.warn?.(`[pr-status-backfill] ${repo}: gh pr list failed; leaving unseeded`);
      continue;
    }
    let rows: unknown;
    try {
      rows = JSON.parse(res.stdout);
    } catch {
      logger?.warn?.(`[pr-status-backfill] ${repo}: unparseable gh output; leaving unseeded`);
      continue;
    }
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Array<Record<string, unknown>>) {
      const number = Number(row?.number);
      if (!Number.isInteger(number) || number <= 0) continue;
      const status = normalizePrState(row?.state, row?.mergedAt);
      if (!status) continue;
      try {
        cache.putStatus(repo, number, status);
        seeded += 1;
      } catch (err) {
        // A single bad row must not abort the whole backfill.
        logger?.warn?.(
          `[pr-status-backfill] ${repo}#${number}: putStatus failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
  if (seeded > 0) {
    logger?.info?.(
      `[pr-status-backfill] seeded ${seeded} PR statuses across ${repos.length} repo(s) on first upgrade`,
    );
  }
  return seeded;
}
