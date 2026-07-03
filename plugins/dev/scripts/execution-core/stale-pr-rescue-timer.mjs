// stale-pr-rescue-timer.mjs — CTL-782 periodic orphaned-PR rescue.
// Pattern-twin of worktree-refresh-timer.mjs: injectable seams, fake-clock
// tests, {stop} handle, unref'd interval, per-tick try/catch.
//
// On each tick the timer walks workers/*/phase-{pr,monitor-merge}.json to
// find tickets with an open PR but no live worker, then calls decideRescue
// and executes the action (wait → stamp; dispatch → rebase worker; escalate
// → labelOnce + event). Bookkeeping lives in workers/<T>/rescue.json;
// phase-*.json files are NEVER written by this timer.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jobLifecycle } from "./recovery.mjs";
import { labelNeedsHumanUnlessBeliefOwner } from "./label-guard.mjs";
import { fenceGuard } from "./fence-guard.mjs";
import { appendFileSync } from "node:fs";
import { log, getEventLogPath, getClusterHosts } from "./config.mjs";
import { DEFAULTS, classifyMergeTree, decideRescue } from "./stale-pr-rescue.mjs";
// Default Linear transport for the escalation path. The daemon does not thread
// a writer (scheduler.mjs threads its own), so without this default every
// escalation reason would silently degrade to a log line and the ticket would
// never reach the needs-human queue (verify finding, CTL-782).
import * as linearWriteDefault from "./linear-write.mjs";

// defaultLinearWrite — exported so tests can assert the module-level default
// is the real linear-write transport (not null).
export const defaultLinearWrite = linearWriteDefault;

const ORCHESTRATE_REBASE_BIN = fileURLToPath(new URL("../orchestrate-rebase", import.meta.url));
const RESCUE_PROMPT_TEMPLATE = fileURLToPath(
  new URL("../templates/rescue-rebase-prompt.md", import.meta.url)
);

// readStalePrRescueConfig — read catalyst.orchestration.stalePrRescue.*
// from .catalyst/config.json. Returns {} for missing/unreadable/absent key.
export function readStalePrRescueConfig(configPath) {
  if (!configPath) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn(
        { configPath, err: err.message },
        "stale-pr-rescue: config unreadable; using defaults"
      );
    }
    return {};
  }
  return parsed?.catalyst?.orchestration?.stalePrRescue ?? {};
}

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    now: () => Date.now(),
  };
}

// parseRepoSlug — extract "org/repo" from a GitHub PR URL.
// "https://github.com/org/repo/pull/N" → "org/repo"
function parseRepoSlug(url) {
  if (!url) return null;
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\/|\.git|$)/.exec(url);
  return m ? m[1].replace(/\.git$/, "") : null;
}

// readTicketPr — extract PR info from workers/<T>/ signal files.
// Prefers phase-pr.json .pr.url for the slug (monitorMergeProbe precedent).
// Also captures the signal's `.orchestrator` field — in execution-core the
// per-ticket orchestrator id (orchId === ticket convention; scheduler.mjs
// stamps it on every dispatch) — so dispatchRescue can pass a non-empty
// --orch to orchestrate-rebase (verify finding, CTL-782).
// Returns { number, url, slug, worktreePath, orchestrator } or null if no PR info.
function readTicketPr(orchDir, ticket) {
  const dir = join(orchDir, "workers", ticket);
  let prInfo = null;
  let worktreePath = null;
  let orchestrator = null;

  for (const fname of ["phase-pr.json", "phase-monitor-merge.json"]) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, fname), "utf8"));
      if (raw?.pr?.number && !prInfo) prInfo = raw.pr;
      if (raw?.worktreePath && !worktreePath) worktreePath = raw.worktreePath;
      if (raw?.orchestrator && !orchestrator) orchestrator = raw.orchestrator;
    } catch {
      /* absent or unreadable */
    }
  }

  if (!prInfo?.number) return null;
  return {
    number: prInfo.number,
    url: prInfo.url,
    slug: parseRepoSlug(prInfo.url),
    worktreePath,
    orchestrator,
  };
}

// anyPhaseJobAlive — true if any phase-*.json in the ticket dir has a
// non-terminal bg_job_id that jobLifecycle() declares alive.
function anyPhaseJobAlive(orchDir, ticket, jobLifecycleFn) {
  const dir = join(orchDir, "workers", ticket);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }

  for (const name of names) {
    if (!name.startsWith("phase-") || !name.endsWith(".json")) continue;
    if (name.includes("-yield-")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (raw?.bg_job_id && jobLifecycleFn(raw.bg_job_id) === "alive") return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

// readRescueState — read workers/<T>/rescue.json.
// Returns {} when the file is absent (ENOENT — first sighting), but null when
// the file exists and is corrupt/torn (parse error). Conflating the two would
// silently reset rescueAttempts to 0 on a torn read — a budget bypass that
// re-dispatches past maxAttempts (verify finding, CTL-782). Callers must skip
// the ticket this tick on null.
function readRescueState(orchDir, ticket) {
  const path = join(orchDir, "workers", ticket, "rescue.json");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  } // ENOENT (or unreadable): treat as no prior state
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.warn(
      { ticket, path, err: err.message },
      "stale-pr-rescue: rescue.json corrupt/torn — skipping ticket this tick"
    );
    return null;
  }
}

// writeRescueState — atomic write to workers/<T>/rescue.json via
// writeFileSync(tmp) + renameSync(tmp, final). rename(2) is atomic on POSIX,
// so the concurrent rescue worker (which rewrites the same file) can never
// observe a torn write from this timer.
function writeRescueState(orchDir, ticket, state) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `rescue.json.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, join(dir, "rescue.json"));
}

// defaultPrView — call gh REST to get PR state, mergeStateStatus, and refs.
async function defaultPrView(slug, prNumber) {
  const res = spawnSync(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      "--repo",
      slug,
      "--json",
      "state,mergeStateStatus,baseRefName,headRefName",
    ],
    { encoding: "utf8", timeout: 15_000 }
  );
  if (res.status !== 0) throw new Error(res.stderr || "gh pr view failed");
  return JSON.parse(res.stdout);
}

// defaultCompareBehind — gh REST compare to count commits behind.
// Throws on non-zero gh exit (consistent with defaultPrView; the per-ticket
// catch logs it and retries next tick) — a transient gh failure must not
// masquerade as "not behind" and silently suppress a legitimate rescue.
async function defaultCompareBehind(slug, base, head) {
  const res = spawnSync(
    "gh",
    ["api", `repos/${slug}/compare/${base}...${head}`, "--jq", ".behind_by"],
    { encoding: "utf8", timeout: 15_000 }
  );
  if (res.status !== 0) {
    throw new Error(res.stderr || `gh api compare failed (exit ${res.status})`);
  }
  const behind = parseInt(res.stdout.trim(), 10);
  if (Number.isNaN(behind)) {
    log.warn(
      { slug, base, head, stdout: res.stdout },
      "stale-pr-rescue: unparsable behind_by — treating as 0"
    );
    return 0;
  }
  return behind;
}

// defaultMergeTree — fetch origin/<base> + origin/<head> then run
// `git merge-tree --write-tree origin/<base> origin/<head>` in the worktree.
// base/head are BRANCH NAMES (the call site passes view.baseRefName /
// view.headRefName) — comparing origin/<base> against the fetched PR head is
// the whole point; the pre-fix code compared origin/<base> against itself,
// which is always clean (verify finding, CTL-782). The fetch lives inside
// this seam (not at the call site) so tests that inject mergeTree never spawn
// git, and the fetch failure path is owned here: a failed fetch throws (the
// per-ticket catch logs + retries next tick) instead of silently classifying
// against a stale origin/<base>.
// Exported for the real-git integration test.
export async function defaultMergeTree(worktreePath, base, head) {
  const fetchRes = spawnSync("git", ["-C", worktreePath, "fetch", "origin", base, head], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (fetchRes.status !== 0) {
    throw new Error(
      `git fetch origin ${base} ${head} failed (exit ${fetchRes.status}): ${fetchRes.stderr ?? ""}`
    );
  }
  const res = spawnSync(
    "git",
    ["-C", worktreePath, "merge-tree", "--write-tree", `origin/${base}`, `origin/${head}`],
    { encoding: "utf8", timeout: 30_000 }
  );
  return { exitCode: res.status ?? 128, output: res.stdout ?? "" };
}

// defaultWorktreeExists — check if the worktree dir is present.
function defaultWorktreeExists(worktreePath) {
  return !!worktreePath && existsSync(worktreePath);
}

// buildRescueDispatchArgs — pure argv builder for the orchestrate-rebase
// dispatch. Exported so a unit test can assert the arg vector carries a
// non-empty --orch (orchestrate-rebase hard-exits on an empty one) without
// spawning anything (verify finding, CTL-782).
export function buildRescueDispatchArgs(
  ticket,
  { prNumber, orchId, orchDir, worktreePath, base, signalFile, headRef }
) {
  const args = [
    ORCHESTRATE_REBASE_BIN,
    ticket,
    "--pr",
    String(prNumber),
    "--orch",
    orchId,
    "--orch-dir",
    orchDir,
    "--worker-dir",
    worktreePath,
    "--base-branch",
    base,
    "--signal-file",
    signalFile,
    "--prompt-template",
    RESCUE_PROMPT_TEMPLATE,
  ];
  // PR head branch: execution-core branches are just <TICKET>, while
  // orchestrate-rebase's legacy default is <orch>-<TICKET> — without this
  // override every rendered fetch/checkout/force-push targets a branch that
  // does not exist (review finding, CTL-782).
  if (headRef) args.push("--branch", headRef);
  args.push("--dispatch");
  return args;
}

// defaultDispatchRescue — invoke orchestrate-rebase --dispatch with rescue flags.
// Returns { ok } so the call site can refuse to burn a rescueAttempt on a
// dispatch that never spawned (verify finding, CTL-782). Guards the empty
// orchId here too: orchestrate-rebase exits 1 on `--orch ""`, so spawning
// would be a guaranteed-failing dispatch.
function defaultDispatchRescue(ticket, opts) {
  if (!opts.orchId) {
    log.warn({ ticket }, "stale-pr-rescue: refusing dispatch with empty orchId");
    return { ok: false, error: "empty_orch_id" };
  }
  const res = spawnSync("bash", buildRescueDispatchArgs(ticket, opts), {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (res.status !== 0) {
    log.warn({ ticket, stderr: res.stderr }, "stale-pr-rescue: dispatch failed");
    return { ok: false, error: res.stderr || `exit ${res.status}` };
  }
  return { ok: true };
}

// defaultEscalate — apply needs-human label once + emit event.
// linearWrite defaults to the real linear-write module at the
// startStalePrRescueTimer boundary; a null here means a caller explicitly
// opted out, which leaves the ticket invisible to humans — say so loudly.
export function defaultEscalate(
  ticket,
  detail,
  { orchDir, linearWrite, multiHost = false, gateway = undefined, self = undefined, env = process.env } = {}
) {
  if (linearWrite) {
    // This is an ESCALATION write (needs-human), so it fails OPEN on a MISSING
    // generation (proceedOnMissingGeneration): a zombie-guard that can't read a
    // generation must LOUDLY proceed with the label rather than silently drop a
    // human escalation. A genuine supersession (readable generation, fresh
    // foreign owner / authoritative read says not-current) still suppresses.
    if (fenceGuard({ ticket, orchDir, multiHost, gateway, self }, { proceedOnMissingGeneration: true })) {
      labelNeedsHumanUnlessBeliefOwner(orchDir, ticket, linearWrite, {
        env,
        site: "stale-pr-rescue",
        log,
      });
    } else {
      log.warn(
        { ticket },
        "ctl-863: stale fence — suppressing stale-pr-rescue labelOnce write (zombie guard)"
      );
    }
  } else {
    log.warn(
      { ticket },
      "stale-pr-rescue: no linearWrite transport — needs-human label NOT applied (log-only escalation)"
    );
  }
  log.warn({ ticket, ...detail }, "stale-pr-rescue: escalating to needs-human");
}

// defaultEmit — append a bare event envelope to the event log.
// Best-effort: never throws.
function defaultEmit(name, payload) {
  try {
    const line = JSON.stringify({ name, ...payload, ts: new Date().toISOString() });
    appendFileSync(getEventLogPath(), line + "\n");
  } catch {
    /* best-effort */
  }
}

/**
 * startStalePrRescueTimer — start the periodic stale/conflicting-PR rescue timer.
 * Returns a { stop } handle.
 */
export function startStalePrRescueTimer({
  enabled = true,
  intervalSeconds = DEFAULTS.intervalSeconds,
  orchDir,
  orchId = "",
  config = {},
  // Real Linear transport by default — the daemon call site passes nothing,
  // and a null default made every escalation a silent no-op (verify finding).
  linearWrite = linearWriteDefault,
  // CTL-863: resolve the cluster-size gate LIVE per tick (below), not once at
  // daemon boot. A boot-time snapshot froze `multiHost=false` for the daemon's
  // whole lifetime when the roster grew 1→2 without an exec-core restart (the
  // config.mjs:590 "honored on the next tick, no restart" contract), leaving the
  // fence zombie-guard permanently disarmed on this timer. `undefined` here means
  // "not injected" → resolve fresh each tick; a test may still pass an explicit
  // boolean to pin it. Matches the per-tick `getClusterHosts()` in scheduler/monitor.
  multiHost = undefined,
  // injectable seams
  jobLifecycle: jobLifecycleFn = jobLifecycle,
  prView = defaultPrView,
  compareBehind = defaultCompareBehind,
  mergeTree = defaultMergeTree,
  worktreeExists = defaultWorktreeExists,
  dispatchRescue = defaultDispatchRescue,
  escalate = defaultEscalate,
  emit = defaultEmit,
  clock = realClock(),
} = {}) {
  if (!enabled || !orchDir) return { stop: () => {} };

  const ms = Math.max(1, intervalSeconds) * 1_000;
  const cfg = {
    stableSeconds: config.stableSeconds ?? DEFAULTS.stableSeconds,
    behindThreshold: config.behindThreshold ?? DEFAULTS.behindThreshold,
    maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
    maxConflictFiles: config.maxConflictFiles ?? DEFAULTS.maxConflictFiles,
  };

  const handle = clock.setInterval(async () => {
    try {
      // CTL-863: live per-tick cluster-size gate. Re-read the roster each tick so
      // a 1→2 roster growth arms the fence zombie-guard on the very next tick with
      // no daemon restart. An explicitly-injected `multiHost` (tests) is honored.
      const tickMultiHost =
        multiHost === undefined ? getClusterHosts().length > 1 : multiHost;
      await runTick({
        orchDir,
        orchId,
        cfg,
        linearWrite,
        multiHost: tickMultiHost,
        jobLifecycleFn,
        prView,
        compareBehind,
        mergeTree,
        worktreeExists,
        dispatchRescue,
        escalate,
        emit,
        nowMs: clock.now(),
      });
    } catch (err) {
      log.warn({ err }, "stale-pr-rescue: tick error");
    }
  }, ms);

  if (typeof handle?.unref === "function") handle.unref();
  return { stop: () => clock.clearInterval(handle) };
}

async function runTick({
  orchDir,
  orchId,
  cfg,
  linearWrite,
  multiHost,
  jobLifecycleFn,
  prView,
  compareBehind,
  mergeTree,
  worktreeExists,
  dispatchRescue,
  escalate,
  emit,
  nowMs,
}) {
  let ticketDirs;
  try {
    ticketDirs = readdirSync(join(orchDir, "workers"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return;
  }

  for (const ticket of ticketDirs) {
    try {
      await processTicket({
        ticket,
        orchDir,
        orchId,
        cfg,
        linearWrite,
        multiHost,
        nowMs,
        jobLifecycleFn,
        prView,
        compareBehind,
        mergeTree,
        worktreeExists,
        dispatchRescue,
        escalate,
        emit,
      });
    } catch (err) {
      log.warn({ ticket, err: err.message }, "stale-pr-rescue: per-ticket error, continuing");
    }
  }
}

async function processTicket({
  ticket,
  orchDir,
  orchId,
  cfg,
  linearWrite,
  multiHost,
  nowMs,
  jobLifecycleFn,
  prView,
  compareBehind,
  mergeTree,
  worktreeExists,
  dispatchRescue,
  escalate,
  emit,
}) {
  // 1. Cheap skip: no PR info → nothing to rescue.
  const prInfo = readTicketPr(orchDir, ticket);
  if (!prInfo) return;

  // 2. Cheap skip: any phase job alive → don't interfere.
  if (anyPhaseJobAlive(orchDir, ticket, jobLifecycleFn)) return;

  const rescueState = readRescueState(orchDir, ticket);
  // Corrupt/torn rescue.json (null sentinel): skip the ticket this tick rather
  // than treating it as empty state — that would reset rescueAttempts and
  // bypass the budget gate. readRescueState already logged the warn.
  if (rescueState === null) return;

  // Per-ticket orchestrator id for dispatch/escalate context. In
  // execution-core orchId === ticket (the scheduler stamps `.orchestrator`
  // on every phase signal); the timer-level orchId param and finally the
  // ticket itself are fallbacks — never empty, because orchestrate-rebase
  // hard-exits on `--orch ""` (verify finding, CTL-782).
  const effectiveOrchId = prInfo.orchestrator || orchId || ticket;

  const { slug } = prInfo;

  // 3. Check if rescue worker itself previously stalled. Re-check the PR
  //    state first when possible: a stalled rescue whose PR has since
  //    merged/closed externally needs no human (verify finding). If the
  //    re-check itself fails (gh down), escalate anyway — fail-safe.
  if (rescueState.status === "rescue-stalled") {
    if (slug) {
      let externalState = null;
      try {
        externalState = (await prView(slug, prInfo.number))?.state ?? null;
      } catch {
        /* re-check unavailable — fall through to escalate */
      }
      if (externalState === "MERGED" || externalState === "CLOSED") {
        log.info(
          { ticket, prState: externalState },
          "stale-pr-rescue: stalled rescue's PR resolved externally — not escalating"
        );
        writeRescueState(orchDir, ticket, {
          ...rescueState,
          status: "rescue-stalled-resolved",
          stalledResolvedAt: new Date(nowMs).toISOString(),
        });
        return;
      }
    }
    escalate(
      ticket,
      { reason: "rescue_worker_stalled", ...rescueState },
      { orchDir, orchId: effectiveOrchId, linearWrite, multiHost }
    );
    writeRescueState(orchDir, ticket, {
      ...rescueState,
      escalatedAt: new Date(nowMs).toISOString(),
    });
    emit(`phase.rescue.escalated.${ticket}`, { ticket, reason: "rescue_worker_stalled" });
    return;
  }

  // 4. Fetch PR view (may throw — caught by per-ticket wrapper).
  if (!slug) return;
  const view = await prView(slug, prInfo.number);

  // BEHIND/DIRTY work below needs the PR head ref. defaultPrView always
  // populates it; a missing one means we cannot compare or classify —
  // substituting the base ref would compare base...base (always clean /
  // 0 behind) and silently suppress the rescue (verify finding). Skip the
  // tick loudly instead.
  const needsHead = view.mergeStateStatus === "BEHIND" || view.mergeStateStatus === "DIRTY";
  if (needsHead && !view.headRefName) {
    log.warn(
      { ticket, mergeStateStatus: view.mergeStateStatus },
      "stale-pr-rescue: PR view missing headRefName — skipping ticket this tick"
    );
    return;
  }

  // 5. Get behindBy if BEHIND.
  let behindBy = 0;
  if (view.mergeStateStatus === "BEHIND") {
    behindBy = await compareBehind(slug, view.baseRefName, view.headRefName);
  }

  // 6. Run merge-tree classification only for stable DIRTY. The seam fetches
  //    origin/<base> + origin/<head> itself and compares base against the PR
  //    HEAD — the pre-fix call site passed origin/<base> as the head, a self-
  //    compare that classified every conflict as resolvable (verify finding).
  let classification = null;
  if (view.mergeStateStatus === "DIRTY" && rescueState.firstSeenAt) {
    const seenMs = new Date(rescueState.firstSeenAt).getTime();
    const elapsedMs = nowMs - seenMs;
    if (elapsedMs >= cfg.stableSeconds * 1_000) {
      const wt = prInfo.worktreePath;
      if (wt && worktreeExists(wt)) {
        const mt = await mergeTree(wt, view.baseRefName ?? "main", view.headRefName);
        classification = classifyMergeTree(mt, { maxConflictFiles: cfg.maxConflictFiles });
      }
    }
  }

  // 7. Decide what to do.
  const decision = decideRescue({
    ticket,
    pr: { number: prInfo.number, url: prInfo.url },
    prState: view.state,
    mergeStateStatus: view.mergeStateStatus,
    behindBy,
    anyJobAlive: false, // already checked above
    worktreeExists: worktreeExists(prInfo.worktreePath),
    rescueState,
    nowMs,
    config: cfg,
    classification,
  });

  // 8. Execute the decision.
  switch (decision.action) {
    case "skip":
      return;

    case "wait": {
      if (decision.detail?.stampFirstSeen) {
        writeRescueState(orchDir, ticket, {
          ...rescueState,
          firstSeenAt: new Date(nowMs).toISOString(),
        });
      }
      return;
    }

    case "dispatch": {
      const signalFile = join(orchDir, "workers", ticket, "rescue.json");
      // Dispatch FIRST, count after: a failed spawn must not burn the
      // single-attempt budget on a rescue that never ran (verify finding,
      // CTL-782). Seam contract: undefined (test stubs / legacy fakes) is
      // success; only an explicit { ok: false } is a failed dispatch.
      const result = await dispatchRescue(ticket, {
        prNumber: prInfo.number,
        orchId: effectiveOrchId,
        orchDir,
        worktreePath: prInfo.worktreePath,
        base: view.baseRefName ?? "main",
        signalFile,
        // The PR's real head branch — execution-core branches are <TICKET>,
        // not orchestrate-rebase's legacy <orch>-<TICKET> default (review
        // finding, CTL-782).
        headRef: view.headRefName,
      });
      if (result?.ok === false) {
        writeRescueState(orchDir, ticket, {
          ...rescueState,
          lastDispatchAt: new Date(nowMs).toISOString(),
          lastDispatchError: result.error ?? "dispatch failed",
        });
        emit(`phase.rescue.dispatch-failed.${ticket}`, {
          ticket,
          error: result.error ?? "dispatch failed",
        });
        return;
      }
      const newAttempts = (rescueState.rescueAttempts ?? 0) + 1;
      writeRescueState(orchDir, ticket, {
        ...rescueState,
        rescueAttempts: newAttempts,
        lastDispatchAt: new Date(nowMs).toISOString(),
        lastDispatchError: undefined,
      });
      emit(`phase.rescue.dispatched.${ticket}`, { ticket, attempt: newAttempts });
      return;
    }

    case "escalate": {
      escalate(ticket, decision.detail ?? {}, {
        orchDir,
        orchId: effectiveOrchId,
        linearWrite,
        multiHost,
      });
      writeRescueState(orchDir, ticket, {
        ...rescueState,
        escalatedAt: new Date(nowMs).toISOString(),
        escalateReason: decision.reason,
      });
      emit(`phase.rescue.escalated.${ticket}`, { ticket, reason: decision.reason });
      return;
    }
  }
}
