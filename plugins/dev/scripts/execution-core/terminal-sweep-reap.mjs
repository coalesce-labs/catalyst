import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { parseBranchForWorktree, parseWorktreeForBranch } from "./worktree.mjs";
import { TERMINAL_SWEEP_REAP_EVENT_TYPES } from "./terminal-sweep-reap-event-types.mjs";

export { TERMINAL_SWEEP_REAP_EVENT_TYPES };
export const TERMINAL_SWEEP_REAP_MODES = new Set(["off", "shadow", "enforce"]);
export const TERMINAL_SWEEP_REAP_MARKER = ".terminal-sweep-reap.applied";

export function classifyTerminalSweepReap(ctx = {}) {
  if (ctx.alreadyRequested) return { action: "skip", reason: "already-requested" };
  if (ctx.liveSessionInWorktree) return { action: "skip", reason: "live-session-in-worktree" };
  if (ctx.inFlight) return { action: "skip", reason: "in-flight" };
  if (ctx.terminal !== true) return { action: "skip", reason: "not-terminal" };
  const merged = ctx.terminalReason === "pr-merged" ||
    (ctx.terminalReason === "linear-terminal" && ctx.linearState === "Done");
  if (!merged) return { action: "skip", reason: "canceled-not-merged" };
  if (!ctx.worktreePath) return { action: "skip", reason: "no-worktree-target" };
  if (!ctx.worktreeOnDisk) return { action: "skip", reason: "no-worktree-on-disk" };
  if (!ctx.branch) return { action: "skip", reason: "no-branch" };
  return { action: "reap-request", reason: "terminal-sweep-out-of-band-merge" };
}

export function terminalSweepReapMarkerPath(orchDir, ticket) {
  if (typeof orchDir !== "string" || !orchDir) throw new TypeError("orchDir is required");
  if (typeof ticket !== "string" || !ticket) throw new TypeError("ticket is required");
  return join(orchDir, "workers", ticket, TERMINAL_SWEEP_REAP_MARKER);
}

export function hasRequestedTerminalSweepReap(orchDir, ticket) {
  try { return existsSync(terminalSweepReapMarkerPath(orchDir, ticket)); }
  catch { return true; }
}

export function markTerminalSweepReapRequested(orchDir, ticket) {
  try { writeFileSync(terminalSweepReapMarkerPath(orchDir, ticket), ""); return true; }
  catch { return false; }
}

function cwdUnder(cwd, root) {
  if (!cwd || !root) return false;
  const candidate = resolve(cwd);
  const base = resolve(root);
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

export function defaultResolveTerminalSweepReapTarget({
  orchDir, ticket, projects = [], agents = [], inFlight = false,
  readWorkerSignals = () => [],
  runGit = (args) => spawnSync("git", args, { encoding: "utf8" }),
} = {}) {
  const target = { worktreePath: null, branch: null, bgJobId: null,
    worktreeOnDisk: false, liveSessionInWorktree: false, inFlight: Boolean(inFlight) };
  let signals = [];
  try { signals = readWorkerSignals(orchDir) ?? []; } catch { signals = []; }
  target.worktreePath = signals.find((s) => s?.ticket === ticket && s.worktreePath)?.worktreePath ?? null;

  const lists = [];
  for (const project of projects) {
    if (!project?.repoRoot) continue;
    try {
      const result = runGit(["-C", project.repoRoot, "worktree", "list", "--porcelain"]);
      lists.push(result && (result.status ?? 1) === 0 ? (result.stdout ?? "") : "");
    } catch { lists.push(""); }
  }
  if (!target.worktreePath) {
    for (const porcelain of lists) {
      target.worktreePath = parseWorktreeForBranch(porcelain, ticket);
      if (target.worktreePath) break;
    }
  }
  if (target.worktreePath) {
    for (const porcelain of lists) {
      const branch = parseBranchForWorktree(porcelain, target.worktreePath);
      if (branch) { target.branch = branch; target.worktreeOnDisk = existsSync(target.worktreePath); break; }
    }
    target.liveSessionInWorktree = agents.some((agent) => cwdUnder(agent?.cwd, target.worktreePath));
  }

  try {
    const workerDir = join(orchDir, "workers", ticket);
    const files = readdirSync(workerDir).filter((name) => /^phase-.*\.json$/.test(name))
      .map((name) => ({ name, mtime: (() => { try { return readFileSync(join(workerDir, name), "utf8"); } catch { return null; } })() }));
    for (const file of files) {
      try { const id = JSON.parse(file.mtime)?.bg_job_id; if (id) target.bgJobId = id; } catch { /* malformed signal */ }
    }
  } catch { /* unreadable worker dir */ }
  return target;
}
