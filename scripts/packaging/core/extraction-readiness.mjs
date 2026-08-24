// extraction-readiness.mjs — the go/no-go check for lifting tools/agent-skills
// as a standalone @coalesce/agent-skills package (CTL-1463 Phase 6).
//
// The ratified extraction criterion: "only after Catalyst AND catalyst-cloud
// pass the shared fixture set (CTL-1461)". That shared fixture set does not
// exist in either repo yet, so this MUST return `inconclusive` today — a
// check that returns `ready` on an absent fixture suite is the "could not
// look, reported as clean" failure this repo has shipped before (AGENTS.md's
// verification-discipline memory). Three-valued, never a bare boolean.

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/** The conventional location CTL-1461 will populate once the shared fixture set ships. */
export const SHARED_FIXTURE_CONTRACT_REL_PATH = "scripts/packaging/fixtures/shared-contract";

/**
 * checkExtractionReadiness({ repoRoot, sharedFixtureContractRelPath }) →
 * { verdict: "inconclusive" | "ready" | "not-ready", reason }
 *
 * `ready` requires the shared fixture contract directory to exist AND be
 * non-empty (an empty directory is not a fixture set, it's a stray mkdir —
 * "could not look" must not be laundered into "looked and it's fine").
 */
export function checkExtractionReadiness({
  repoRoot,
  sharedFixtureContractRelPath = SHARED_FIXTURE_CONTRACT_REL_PATH,
} = {}) {
  const path = resolve(repoRoot, sharedFixtureContractRelPath);
  if (!existsSync(path)) {
    return {
      verdict: "inconclusive",
      reason: `shared fixture contract absent — CTL-1461 not landed (expected at ${sharedFixtureContractRelPath})`,
    };
  }

  let entries;
  try {
    entries = readdirSync(path);
  } catch (err) {
    return { verdict: "inconclusive", reason: `shared fixture contract path unreadable: ${err.message}` };
  }

  if (entries.length === 0) {
    return {
      verdict: "inconclusive",
      reason: `shared fixture contract directory exists but is empty at ${sharedFixtureContractRelPath} — an empty directory is not a fixture set`,
    };
  }

  return { verdict: "ready", reason: `shared fixture contract present (${entries.length} entr${entries.length === 1 ? "y" : "ies"}) — extraction may proceed pending a human decision` };
}
