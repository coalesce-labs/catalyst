// session-recency.mjs — "last activity" proxy for a claude session (CTL-649).
//
// `claude agents --json` only reports `startedAt`; `updatedAt`/`lastActiveAt`
// come back null. The session's transcript file
// (`~/.claude/projects/<project-slug>/<sessionId>.jsonl`) is appended to on
// every turn, so its mtime is the most reliable "last seen activity" signal.
// The reaper and the audit CLI use this to avoid reaping a session that was
// touched seconds ago, regardless of its idle/orphan classification.

import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function defaultProjectsDir() {
  return join(homedir(), ".claude", "projects");
}

// Locate the transcript JSONL for a full session UUID. The file is named
// `<sessionId>.jsonl` and lives one level under the projects dir (the
// intervening directory is the URL-encoded project cwd), so we scan the
// project dirs rather than doing a full recursive walk.
//
// CTL-650: exported so the wait-watcher can locate a session's transcript
// without duplicating the project-dir scan. Visibility-only change.
export function findTranscript(sessionId, projectsDir) {
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = join(projectsDir, e.name, `${sessionId}.jsonl`);
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // not in this project dir — keep scanning
    }
  }
  return null;
}

// Milliseconds since the session's transcript was last written, or null when no
// transcript is found (treat null as "unknown" — callers decide the policy).
export function lastSeenMsForSession(
  sessionId,
  { now = Date.now(), projectsDir = defaultProjectsDir() } = {},
) {
  if (!sessionId) return null;
  const file = findTranscript(sessionId, projectsDir);
  if (!file) return null;
  try {
    const { mtimeMs } = statSync(file);
    return Math.max(0, now - mtimeMs);
  } catch {
    return null;
  }
}
