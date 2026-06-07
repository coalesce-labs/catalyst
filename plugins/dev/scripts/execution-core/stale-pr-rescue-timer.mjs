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
  mkdirSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jobLifecycle } from "./recovery.mjs";
import { labelOnce } from "./label-guard.mjs";
import { appendFileSync } from "node:fs";
import { log, getEventLogPath } from "./config.mjs";
import { DEFAULTS, classifyMergeTree, decideRescue } from "./stale-pr-rescue.mjs";

const ORCHESTRATE_REBASE_BIN = fileURLToPath(
  new URL("../orchestrate-rebase", import.meta.url)
);
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
// Returns { number, url, slug, worktreePath } or null if no PR info.
function readTicketPr(orchDir, ticket) {
  const dir = join(orchDir, "workers", ticket);
  let prInfo = null;
  let worktreePath = null;

  for (const fname of ["phase-pr.json", "phase-monitor-merge.json"]) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, fname), "utf8"));
      if (raw?.pr?.number && !prInfo) prInfo = raw.pr;
      if (raw?.worktreePath && !worktreePath) worktreePath = raw.worktreePath;
    } catch { /* absent or unreadable */ }
  }

  if (!prInfo?.number) return null;
  return {
    number: prInfo.number,
    url: prInfo.url,
    slug: parseRepoSlug(prInfo.url),
    worktreePath,
  };
}

// anyPhaseJobAlive — true if any phase-*.json in the ticket dir has a
// non-terminal bg_job_id that jobLifecycle() declares alive.
function anyPhaseJobAlive(orchDir, ticket, jobLifecycleFn) {
  const dir = join(orchDir, "workers", ticket);
  let names;
  try {
    names = readdirSync(dir);
  } catch { return false; }

  for (const name of names) {
    if (!name.startsWith("phase-") || !name.endsWith(".json")) continue;
    if (name.includes("-yield-")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (raw?.bg_job_id && jobLifecycleFn(raw.bg_job_id) === "alive") return true;
    } catch { /* skip */ }
  }
  return false;
}

// readRescueState — read workers/<T>/rescue.json. Returns {} on miss.
function readRescueState(orchDir, ticket) {
  try {
    return JSON.parse(readFileSync(join(orchDir, "workers", ticket, "rescue.json"), "utf8"));
  } catch { return {}; }
}

// writeRescueState — atomic write to workers/<T>/rescue.json.
function writeRescueState(orchDir, ticket, state) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "rescue.json.tmp");
  writeFileSync(tmp, JSON.stringify(state));
  // rename is not available without node:fs/promises; use writeFileSync directly
  writeFileSync(join(dir, "rescue.json"), JSON.stringify(state));
}

// defaultPrView — call gh REST to get PR state, mergeStateStatus, and refs.
async function defaultPrView(slug, prNumber) {
  const res = spawnSync(
    "gh",
    ["pr", "view", String(prNumber), "--repo", slug,
      "--json", "state,mergeStateStatus,baseRefName,headRefName"],
    { encoding: "utf8", timeout: 15_000 }
  );
  if (res.status !== 0) throw new Error(res.stderr || "gh pr view failed");
  return JSON.parse(res.stdout);
}

// defaultCompareBehind — gh REST compare to count commits behind.
async function defaultCompareBehind(slug, base, head) {
  const res = spawnSync(
    "gh",
    ["api", `repos/${slug}/compare/${base}...${head}`, "--jq", ".behind_by"],
    { encoding: "utf8", timeout: 15_000 }
  );
  if (res.status !== 0) return 0;
  return parseInt(res.stdout.trim(), 10) || 0;
}

// defaultMergeTree — run git merge-tree --write-tree in the worktree.
async function defaultMergeTree(worktreePath, base, head) {
  const res = spawnSync(
    "git",
    ["-C", worktreePath, "merge-tree", "--write-tree", `origin/${base}`, head],
    { encoding: "utf8", timeout: 30_000 }
  );
  return { exitCode: res.status ?? 128, output: res.stdout ?? "" };
}

// defaultWorktreeExists — check if the worktree dir is present.
function defaultWorktreeExists(worktreePath) {
  return !!worktreePath && existsSync(worktreePath);
}

// defaultDispatchRescue — invoke orchestrate-rebase --dispatch with rescue flags.
function defaultDispatchRescue(ticket, { prNumber, orchId, orchDir, worktreePath, base, signalFile }) {
  const res = spawnSync(
    "bash",
    [
      ORCHESTRATE_REBASE_BIN,
      ticket,
      "--pr", String(prNumber),
      "--orch", orchId,
      "--orch-dir", orchDir,
      "--worker-dir", worktreePath,
      "--base-branch", base,
      "--signal-file", signalFile,
      "--prompt-template", RESCUE_PROMPT_TEMPLATE,
      "--dispatch",
    ],
    { encoding: "utf8", timeout: 30_000 }
  );
  if (res.status !== 0) {
    log.warn({ ticket, stderr: res.stderr }, "stale-pr-rescue: dispatch failed");
  }
}

// defaultEscalate — apply needs-human label once + emit event.
function defaultEscalate(ticket, detail, { orchDir, orchId, linearWrite }) {
  if (linearWrite) {
    labelOnce(orchDir, ticket, "needs-human", linearWrite);
  }
  log.warn(
    { ticket, ...detail },
    "stale-pr-rescue: escalating to needs-human"
  );
}

// defaultEmit — append a bare event envelope to the event log.
// Best-effort: never throws.
function defaultEmit(name, payload) {
  try {
    const line = JSON.stringify({ name, ...payload, ts: new Date().toISOString() });
    appendFileSync(getEventLogPath(), line + "\n");
  } catch { /* best-effort */ }
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
  linearWrite = null,
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
      await runTick({
        orchDir, orchId, cfg, linearWrite,
        jobLifecycleFn, prView, compareBehind, mergeTree,
        worktreeExists, dispatchRescue, escalate, emit,
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
  orchDir, orchId, cfg, linearWrite,
  jobLifecycleFn, prView, compareBehind, mergeTree,
  worktreeExists, dispatchRescue, escalate, emit, nowMs,
}) {
  let ticketDirs;
  try {
    ticketDirs = readdirSync(join(orchDir, "workers"), { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { return; }

  for (const ticket of ticketDirs) {
    try {
      await processTicket({
        ticket, orchDir, orchId, cfg, linearWrite, nowMs,
        jobLifecycleFn, prView, compareBehind, mergeTree,
        worktreeExists, dispatchRescue, escalate, emit,
      });
    } catch (err) {
      log.warn({ ticket, err: err.message }, "stale-pr-rescue: per-ticket error, continuing");
    }
  }
}

async function processTicket({
  ticket, orchDir, orchId, cfg, linearWrite, nowMs,
  jobLifecycleFn, prView, compareBehind, mergeTree,
  worktreeExists, dispatchRescue, escalate, emit,
}) {
  // 1. Cheap skip: no PR info → nothing to rescue.
  const prInfo = readTicketPr(orchDir, ticket);
  if (!prInfo) return;

  // 2. Cheap skip: any phase job alive → don't interfere.
  if (anyPhaseJobAlive(orchDir, ticket, jobLifecycleFn)) return;

  const rescueState = readRescueState(orchDir, ticket);

  // 3. Check if rescue worker itself previously stalled.
  if (rescueState.status === "rescue-stalled") {
    escalate(ticket, { reason: "rescue_worker_stalled", ...rescueState }, { orchDir, orchId, linearWrite });
    writeRescueState(orchDir, ticket, { ...rescueState, escalatedAt: new Date(nowMs).toISOString() });
    emit(`phase.rescue.escalated.${ticket}`, { ticket, reason: "rescue_worker_stalled" });
    return;
  }

  // 4. Fetch PR view (may throw — caught by per-ticket wrapper).
  const { slug } = prInfo;
  if (!slug) return;
  const view = await prView(slug, prInfo.number);

  // 5. Get behindBy if BEHIND.
  let behindBy = 0;
  if (view.mergeStateStatus === "BEHIND") {
    behindBy = await compareBehind(slug, view.baseRefName, view.headRefName ?? `origin/${view.baseRefName}`);
  }

  // 6. Run merge-tree classification only for stable DIRTY.
  let classification = null;
  if (view.mergeStateStatus === "DIRTY" && rescueState.firstSeenAt) {
    const seenMs = new Date(rescueState.firstSeenAt).getTime();
    const elapsedMs = nowMs - seenMs;
    if (elapsedMs >= cfg.stableSeconds * 1_000) {
      const wt = prInfo.worktreePath;
      if (wt && worktreeExists(wt)) {
        try {
          // fetch origin before merge-tree to get current base
          spawnSync("git", ["-C", wt, "fetch", "origin", view.baseRefName ?? "main"],
            { timeout: 30_000 });
        } catch { /* best-effort */ }
        const mt = await mergeTree(wt, view.baseRefName ?? "main", `origin/${view.baseRefName ?? "main"}`);
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
      const newAttempts = (rescueState.rescueAttempts ?? 0) + 1;
      writeRescueState(orchDir, ticket, {
        ...rescueState,
        rescueAttempts: newAttempts,
        lastDispatchAt: new Date(nowMs).toISOString(),
      });
      dispatchRescue(ticket, {
        prNumber: prInfo.number,
        orchId,
        orchDir,
        worktreePath: prInfo.worktreePath,
        base: view.baseRefName ?? "main",
        signalFile,
      });
      emit(`phase.rescue.dispatched.${ticket}`, { ticket, attempt: newAttempts });
      return;
    }

    case "escalate": {
      escalate(ticket, decision.detail ?? {}, { orchDir, orchId, linearWrite });
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
