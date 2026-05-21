// abort-worker.mjs — kill-on-drag-out (CTL-565 Part B, deliverable 4).
//
// When a human drags an in-flight ticket out of {Triage, Ready}, the monitor
// leave-path calls abortWorker. The deterministic guarantee is filesystem-level:
// every non-terminal phase signal is rewritten status:"aborted", which
// isTicketInFlight (scheduler.mjs) treats as slot-freeing — the scheduler stops
// advancing the ticket on its next tick. The bg kill and the worktree teardown
// are best-effort, behind the injectable killJob / teardownWorktree seams (D9).

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, basename } from "node:path";

// Signal statuses that mean a phase no longer holds a live worker — left as-is.
//
// CROSS-REFERENCE (CTL-565 Refactor note): this set and the
// failed/stalled/aborted set in scheduler.mjs:isTicketInFlight describe the
// same lifecycle from two angles but are deliberately NOT the same set and
// must not be collapsed into one shared constant. A phase mid-advance with
// `done` is settled-as-a-signal (abort-worker leaves it untouched), but the
// *ticket* is still in-flight (isTicketInFlight returns true on a non-terminal
// `done`). The divergence is intentional.
const SETTLED_STATUSES = new Set(["done", "failed", "stalled", "aborted"]);

// defaultKillJob — best-effort terminate a `claude --bg` job by bg_job_id.
//
// IMPLEMENT-TIME VERIFICATION (CTL-565 Assumptions §5): the live `claude` CLI
// (claude --help) exposes NO bg-job kill subcommand — there is no `claude jobs
// kill`, and `claude agents` only lists/manages the agent view (`--json`
// lists live sessions, but offers no kill verb). Per the plan's documented
// fallback, defaultKillJob is therefore a best-effort no-op that returns false.
// This is acceptable: the signal-marking in abortWorker already froze
// scheduler advancement, which is the deterministic guarantee regardless of
// whether the bg process is reaped. Never throws.
export function defaultKillJob(bgJobId) {
  if (!bgJobId) return false;
  // No `claude` bg-job kill subcommand exists — see the comment above. A future
  // `claude` release that adds one (or a cloud executor with a real kill API)
  // swaps this seam via the injectable killJob option.
  return false;
}

// defaultTeardownWorktree — `git worktree remove --force` the worker's worktree.
// Path convention: ~/catalyst/wt/<projectKey>/<orchId>-<ticket>
// (phase-agent-dispatch). Runs with `-C <repoRoot>` so it works regardless of
// the daemon's cwd. Never throws.
export function defaultTeardownWorktree({ projectKey, orchId, ticket, repoRoot }) {
  if (!projectKey || !orchId || !ticket || !repoRoot) return false;
  const wt = join(process.env.HOME ?? "", "catalyst", "wt", projectKey, `${orchId}-${ticket}`);
  const res = spawnSync("git", ["-C", repoRoot, "worktree", "remove", "--force", wt], {
    encoding: "utf8",
  });
  return !res.error && (res.status ?? 1) === 0;
}

// abortWorker — abort an in-flight ticket dragged out of {Triage, Ready}.
// Returns { aborted, signalsMarked, jobsKilled, worktreeRemoved }. A ticket
// that was never dispatched (no worker dir) or has only settled signals is a
// clean no-op — no kill, no teardown.
export function abortWorker(
  orchDir,
  ticket,
  {
    projectKey,
    repoRoot,
    killJob = defaultKillJob,
    teardownWorktree = defaultTeardownWorktree,
  } = {},
) {
  const empty = { aborted: false, signalsMarked: [], jobsKilled: [], worktreeRemoved: false };
  const dir = join(orchDir, "workers", ticket);
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return empty; // no worker dir — never dispatched — no-op
  }

  const signalsMarked = [];
  const jobIds = new Set();
  for (const f of files) {
    const m = /^phase-(.+)\.json$/.exec(f);
    if (!m) continue;
    let signal;
    try {
      signal = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue; // unreadable / malformed signal — skip
    }
    if (SETTLED_STATUSES.has(signal?.status)) continue; // already settled — leave it
    if (signal?.bg_job_id) jobIds.add(signal.bg_job_id);
    const updated = { ...signal, status: "aborted", abortedAt: new Date().toISOString() };
    try {
      const tmp = join(dir, `${f}.tmp.${process.pid}`);
      writeFileSync(tmp, `${JSON.stringify(updated, null, 2)}\n`);
      renameSync(tmp, join(dir, f)); // atomic — the signal is the source of truth
      signalsMarked.push(m[1]);
    } catch {
      /* unwritable signal — skip; other signals still mark */
    }
  }
  if (signalsMarked.length === 0) return empty; // nothing in-flight — no-op

  const jobsKilled = [];
  for (const id of jobIds) {
    try {
      if (killJob(id)) jobsKilled.push(id);
    } catch {
      /* best-effort */
    }
  }

  let worktreeRemoved = false;
  try {
    worktreeRemoved =
      teardownWorktree({ projectKey, orchId: basename(orchDir), ticket, repoRoot }) === true;
  } catch {
    /* best-effort */
  }

  return { aborted: true, signalsMarked, jobsKilled, worktreeRemoved };
}
