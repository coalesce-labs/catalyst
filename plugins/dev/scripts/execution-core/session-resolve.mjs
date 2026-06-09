// session-resolve.mjs — resolves a short bg_job_id to a full session UUID.
// Extracted from recovery.mjs:87-109 (CTL-729) so transcript-silence.mjs can
// import it without pulling in recovery.mjs's heavy dependency graph.
// recovery.mjs re-exports for its existing callers; scheduler.mjs alias import
// updated to point here directly.

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// resolvePhaseSessionId — JS port of orchestrate-revive's resolve_phase_session_id
// (SKILL.md bash impl). Given an 8-char short bg_job_id, returns the full session
// UUID from a dead worker's bg_job_id by reading the job's state.json.
// Returns null on any miss (no bgJobId, no state.json, no session field).
//
// Two schemas supported:
//   Claude Code ≥2.x schema: state.json contains `resumeSessionId` directly.
//   Claude Code <2.x schema: state.json contains `linkScanPath` (path to .jsonl);
//   the basename minus `.jsonl` is the session UUID. Still supported as fallback.
export function resolvePhaseSessionId(
  bgJobId,
  { jobsDir = process.env.CATALYST_REVIVE_JOBS_DIR || join(homedir(), ".claude", "jobs") } = {},
) {
  if (!bgJobId) return null;
  const stateFile = join(jobsDir, bgJobId, "state.json");
  if (!existsSync(stateFile)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
  // New schema (Claude Code ≥2.x): resumeSessionId stored directly.
  if (typeof parsed?.resumeSessionId === "string" && parsed.resumeSessionId) {
    return parsed.resumeSessionId;
  }
  // Legacy schema: derive UUID from linkScanPath basename.
  const linkPath = parsed?.linkScanPath;
  if (typeof linkPath !== "string" || !linkPath.endsWith(".jsonl")) return null;
  const sid = basename(linkPath, ".jsonl");
  return sid || null;
}
