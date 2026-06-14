// transcript-silence.mjs — synchronous transcript-silence primitive (CTL-729).
// Returns the age (ms) of the most recent transcript write for a running worker,
// folding in subagent transcripts so a worker mid fan-out is never killed while
// its subagents are active (Gherkin scenario 3).
//
// SYNC by design: schedulerTick is synchronous; feeding an async Promise into
// its predicate would make `Promise <= silenceMs` always false → every worker
// would look silent. Uses statSync (not stat) and is fully injectable for tests.
//
// Returns null on ANY miss (no bg_job_id, no state.json, no transcript file) —
// "can't measure" is treated as NOT-silent and the predicate spares the worker.

import { statSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { resolvePhaseSessionId } from "./session-resolve.mjs";

const PROJECTS_ROOT = () => join(homedir(), ".claude", "projects");

// slugFor — fast-path slug from a worktree path.
// ~/.claude/projects uses the worktree path with all slashes and dots replaced
// by dashes, which lets us skip a readdirSync scan on the common case.
export const slugFor = (wt) => (wt ? wt.replace(/[/.]/g, "-") : null);

// resolveTranscriptPath — find <projectsRoot>/<slug>/<sessionId>.jsonl.
// Fast path: derive slug from worktreePath and check directly.
// Fallback: scan all project dirs (handles unusual setups).
export function resolveTranscriptPath(
  sessionId,
  { projectsRoot = PROJECTS_ROOT(), worktreePath = null } = {},
) {
  if (!sessionId) return null;
  const slug = slugFor(worktreePath);
  if (slug) {
    const d = join(projectsRoot, slug, `${sessionId}.jsonl`);
    if (existsSync(d)) return d;
  }
  let entries;
  try {
    entries = readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const cand = join(projectsRoot, e.name, `${sessionId}.jsonl`);
    if (existsSync(cand)) return cand;
  }
  return null;
}

const mtimeMs = (p, stat) => {
  try {
    return stat(p).mtimeMs;
  } catch {
    return 0;
  }
};

// transcriptAgeMs — age (ms) of the most recent transcript activity for a worker.
// Accepts a signal-like object (plain {bgJobId} or a parsed signal with raw.bg_job_id).
// Returns null on any miss so the watchdog predicate fails safe.
export function transcriptAgeMs(
  signalLike,
  {
    now = Date.now(),
    projectsRoot = PROJECTS_ROOT(),
    stat = statSync,
    readdir = readdirSync,
    resolveSession = resolvePhaseSessionId,
  } = {},
) {
  // Accept both the flat test shape {bgJobId} and the parsed signal shape {raw.bg_job_id}.
  const bgJobId =
    signalLike?.raw?.bg_job_id ??
    signalLike?.bgJobId ??
    (signalLike?.liveness?.kind === "bg" ? signalLike.liveness.value : null);
  if (!bgJobId) return null;
  const sessionId = resolveSession(bgJobId);
  if (!sessionId) return null;
  const worktreePath = signalLike?.raw?.worktreePath ?? signalLike?.worktreePath ?? null;
  const file = resolveTranscriptPath(sessionId, { projectsRoot, worktreePath });
  if (!file) return null;
  let newest = mtimeMs(file, stat);
  const subDir = join(dirname(file), sessionId, "subagents");
  try {
    for (const f of readdir(subDir)) {
      if (f.endsWith(".jsonl")) newest = Math.max(newest, mtimeMs(join(subDir, f), stat));
    }
  } catch {
    // no subagents dir — parent-only age is fine
  }
  return newest ? Math.max(0, now - newest) : null;
}
