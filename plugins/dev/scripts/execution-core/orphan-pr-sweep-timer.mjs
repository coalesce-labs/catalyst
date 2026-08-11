// orphan-pr-sweep-timer.mjs — CTL-1175 periodic orphan-PR detect+notify timer.
// Pattern-twin of stale-pr-rescue-timer.mjs: injectable seams, fake-clock tests,
// {stop} handle, unref'd interval, per-tick try/catch.
//
// On each tick: list every open PR in the repo, drop any that a pipeline worker
// is tracking, run the Phase-1 core per orphan, persist orphan-prs.json
// atomically (with pruning), emit phase.orphan-pr.detected.<n> for new notifiers.
// NOTIFY ONLY — never merge/adopt/rebase.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  mkdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { log, getEventLogPath, getClusterHosts, getHostName } from "./config.mjs";
import { DEFAULTS, decideOrphanNotify } from "./orphan-pr-sweep.mjs";
import { ownedBy } from "./hrw.mjs";

// readOrphanPrSweepConfig — read catalyst.orchestration.orphanPrSweep.*
// from .catalyst/config.json. Returns {} for missing/unreadable/absent key.
export function readOrphanPrSweepConfig(configPath) {
  if (!configPath) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn(
        { configPath, err: err.message },
        "orphan-pr-sweep: config unreadable; using defaults"
      );
    }
    return {};
  }
  return parsed?.catalyst?.orchestration?.orphanPrSweep ?? {};
}

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    now: () => Date.now(),
  };
}

// defaultPrList — call gh to list all open PRs in the repo.
// Throws on non-zero exit so a transient gh failure aborts the tick before
// any persist (never prunes live rows).
async function defaultPrList(repo) {
  const res = spawnSync(
    "gh",
    ["pr", "list", "--repo", repo, "--state", "open",
      "--json", "number,url,title,headRefName,mergeStateStatus,isDraft", "--limit", "100"],
    { encoding: "utf8", timeout: 15_000 }
  );
  if (res.status !== 0) throw new Error(res.stderr || "gh pr list failed");
  return JSON.parse(res.stdout);
}

// defaultReadWorkerTrackedNumbers — scan worker phase signal files for PR numbers.
// Returns a Set of PR numbers that the pipeline is already tracking.
export function defaultReadWorkerTrackedNumbers(orchDir) {
  const tracked = new Set();
  let ticketDirs;
  try {
    ticketDirs = readdirSync(join(orchDir, "workers"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { return tracked; }

  for (const ticket of ticketDirs) {
    const sources = [
      ["phase-pr.json", (raw) => raw?.pr?.number],
      ["phase-monitor-merge.json", (raw) => raw?.pr?.number],
      ["phase-implement.json", (raw) => raw?.draftPr?.number],
    ];
    for (const [fname, pick] of sources) {
      try {
        const raw = JSON.parse(readFileSync(join(orchDir, "workers", ticket, fname), "utf8"));
        const number = pick(raw);
        if (number) tracked.add(number);
      } catch { /* absent or unreadable */ }
    }
  }
  return tracked;
}

// defaultDraftExpected — a draft PR is EXPECTED (not an orphan) while the pipeline is
// still pre-`pr` for its ticket. `.draftPr` is written only by phase-implement's End-block
// backstop, but implement-plan opens the draft at the FIRST plan-phase commit, so for the
// whole implement phase — far longer than stableSeconds — no signal file names the number
// and the number-based tracked set cannot see it. Fall back to the ticket: a worker dir
// that has not yet produced phase-pr.json is actively working a legitimately-draft PR.
// Once phase-pr has run (or the worker dir is gone), a still-draft PR IS the stuck case.
export function defaultDraftExpected(orchDir, headRefName) {
  const ticket = draftTicket(headRefName);
  if (!ticket || !orchDir) return false;
  try {
    // Worker dir present + no phase-pr.json → pre-PR pipeline, draft is expected.
    return (
      statSync(join(orchDir, "workers", ticket)).isDirectory() &&
      !existsSync(join(orchDir, "workers", ticket, "phase-pr.json"))
    );
  } catch { return false; } // no worker dir → nothing is tracking it → orphan candidate
}

// draftTicket — recover the Linear identifier from the PR branch name so draft
// notification can use the same fleet-wide HRW ownership boundary as dispatch.
// A branch without an identifier cannot be safely assigned to this host.
export function draftTicket(headRefName) {
  return typeof headRefName === "string"
    ? headRefName.match(/(?:^|\/)([A-Z][A-Z0-9]+-\d+)(?:$|[-_/])/i)?.[1]?.toUpperCase() ?? null
    : null;
}

// defaultResolveRepoSlug — determine the repo slug for gh pr list.
// Priority: config.repo → top-level .catalyst config repo/github → gh repo view.
// Returns null if none resolvable (fail-open → sweep is a no-op).
function defaultResolveRepoSlug(orchDir, config) {
  if (config?.repo) return config.repo;

  // Try .catalyst/config.json top-level repo or github fields.
  const catalystConfigPaths = [
    join(process.cwd(), ".catalyst", "config.json"),
  ];
  for (const p of catalystConfigPaths) {
    try {
      const c = JSON.parse(readFileSync(p, "utf8"));
      const slug = c?.catalyst?.repo || c?.repo || c?.github;
      if (slug && typeof slug === "string" && slug.includes("/")) return slug;
    } catch { /* absent or unreadable */ }
  }

  // Fall back to gh repo view.
  const res = spawnSync(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    { encoding: "utf8", timeout: 10_000 }
  );
  if (res.status === 0) {
    const slug = res.stdout.trim();
    if (slug && slug.includes("/")) return slug;
  }

  return null;
}

// defaultReadState — read ${orchDir}/orphan-prs.json.
// Returns {} on ENOENT (first run), null on parse error (torn file — caller skips tick).
function defaultReadState(orchDir) {
  const path = join(orchDir, "orphan-prs.json");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch { return {}; } // ENOENT: no prior state
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.warn(
      { path, err: err.message },
      "orphan-pr-sweep: orphan-prs.json corrupt/torn — skipping tick"
    );
    return null;
  }
}

// defaultPersist — atomic write to ${orchDir}/orphan-prs.json.
// writeFileSync(tmp) + renameSync is atomic on POSIX (mirroring writeRescueState).
function defaultPersist(orchDir, state) {
  const final = join(orchDir, "orphan-prs.json");
  const tmp = join(orchDir, `orphan-prs.json.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, final);
}

// defaultEmit — append a bare event envelope to the event log (best-effort).
function defaultEmit(name, payload) {
  try {
    const line = JSON.stringify({ name, ...payload, ts: new Date().toISOString() });
    appendFileSync(getEventLogPath(), line + "\n");
  } catch { /* best-effort */ }
}

/**
 * runOrphanSweep — the injectable core of one sweep tick.
 * All seams are injected; this function has no I/O of its own.
 * Exported for unit tests.
 */
export async function runOrphanSweep({ repo, nowMs, cfg, prList, readWorkerTrackedNumbers, ownsDraft = () => true, draftExpected = () => false, readState, persist, emit }) {
  if (!repo) return; // fail-open: no slug → no-op

  const prs = await prList(repo); // may throw → per-tick catch in the timer
  const tracked = readWorkerTrackedNumbers();
  const prior = readState();
  if (prior === null) return; // torn state file → skip this tick (never reset)

  const next = {}; // rebuilt each tick → prunes vanished/recovered PRs
  for (const pr of prs) {
    if (tracked.has(pr.number)) continue; // worker-tracked → not an orphan
    // Drafts legitimately remain open throughout implement→verify→review. Only
    // their HRW owner may classify one as orphaned; otherwise every peer lacks
    // the owner's local worker signal and emits a duplicate false escalation.
    if (pr.isDraft && !ownsDraft(pr)) continue;
    // A draft opened by implement-plan's early fence is not yet named by any signal
    // file, so the number-based tracked set above cannot see it. Resolve by ticket.
    if (pr.isDraft && draftExpected(pr)) continue;
    const key = `${repo}#${pr.number}`;
    const entry = prior[key] ?? null;
    const decision = decideOrphanNotify({
      mergeStateStatus: pr.mergeStateStatus, isDraft: pr.isDraft, entry, nowMs,
      stableSeconds: cfg.stableSeconds,
    });

    if (decision.action === "skip" && decision.reason === "not_blocked") {
      continue; // not a blocker / recovered → drop (prune)
    }
    const base = {
      repo, number: pr.number, url: pr.url, title: pr.title,
      headRefName: pr.headRefName, mergeStateStatus: pr.mergeStateStatus, isDraft: pr.isDraft,
    };

    if (decision.action === "stamp") {
      next[key] = { ...base, firstSeenAt: new Date(nowMs).toISOString() };
    } else if (decision.action === "wait") {
      next[key] = { ...base, firstSeenAt: entry.firstSeenAt }; // carry forward, refresh state
    } else if (decision.action === "notify") {
      next[key] = { ...base, firstSeenAt: entry.firstSeenAt, notifiedAt: new Date(nowMs).toISOString() };
      emit(`phase.orphan-pr.detected.${pr.number}`, {
        repo, number: pr.number, url: pr.url, mergeStateStatus: pr.mergeStateStatus,
        reason: decision.reason,
      });
    } else if (decision.action === "skip" && decision.reason === "already_notified") {
      // Keep the entry alive so the inbox row persists across ticks.
      next[key] = { ...base, firstSeenAt: entry.firstSeenAt, notifiedAt: entry.notifiedAt };
    }
  }

  persist(next);
}

/**
 * startOrphanPrSweepTimer — start the periodic orphan-PR sweep timer.
 * Returns a { stop } handle.
 */
export function startOrphanPrSweepTimer({
  enabled = true,
  intervalSeconds = DEFAULTS.intervalSeconds,
  orchDir,
  config = {},
  // injectable seams
  prList = defaultPrList,
  readWorkerTrackedNumbers: readWorkerTrackedNumbersFn = (od) => defaultReadWorkerTrackedNumbers(od),
  resolveRepoSlug = defaultResolveRepoSlug,
  readState: readStateFn = (od) => defaultReadState(od),
  persist: persistFn = (od, s) => defaultPersist(od, s),
  emit = defaultEmit,
  ownsDraft = (pr) => {
    const ticket = draftTicket(pr.headRefName);
    return ticket !== null && ownedBy(ticket, getClusterHosts(), getHostName());
  },
  draftExpected = (pr) => defaultDraftExpected(orchDir, pr.headRefName),
  clock = realClock(),
} = {}) {
  if (!enabled || !orchDir) return { stop: () => {} };

  const ms = Math.max(1, intervalSeconds) * 1_000;
  const cfg = {
    stableSeconds: config.stableSeconds ?? DEFAULTS.stableSeconds,
  };

  const handle = clock.setInterval(async () => {
    try {
      const repo = resolveRepoSlug(orchDir, config);
      await runOrphanSweep({
        repo,
        nowMs: clock.now(),
        cfg,
        prList,
        readWorkerTrackedNumbers: () => readWorkerTrackedNumbersFn(orchDir),
        ownsDraft,
        draftExpected,
        readState: () => readStateFn(orchDir),
        persist: (s) => persistFn(orchDir, s),
        emit,
      });
    } catch (err) {
      log.warn({ err }, "orphan-pr-sweep: tick error");
    }
  }, ms);

  if (typeof handle?.unref === "function") handle.unref();
  return { stop: () => clock.clearInterval(handle) };
}
