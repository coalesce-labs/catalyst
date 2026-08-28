// skill-authoring-doc.test.mjs — CTL-2215 PR #4060 review round 1 (Codex,
// 2026-08-27): docs/skill-authoring.md's hooks-veto section claimed "103
// skills across 9 plugins, exactly 2 reach the portable pack" — a snapshot
// that was already stale the day the doc was introduced (the real repo was
// 65 skills across 5 plugins at that commit; only the "2" figure was still
// correct). A reader trusting the stale total would validate a render
// against a baseline the pipeline can never reproduce.
//
// docs/skill-authoring.md is prose, not code, so nothing forces its numbers
// to track the packaging inventory. This test guards both halves of the fix:
// the doc must not re-embed a hardcoded "N skills across M plugins" total
// (those drift with every plugin/skill added or removed), and any skill
// COUNT it does still cite (the "exactly 2 reach the portable pack" claim)
// must agree with what the real pipeline computes right now.
//
// Run: bun test scripts/packaging/__tests__/skill-authoring-doc.test.mjs

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderAllPacks, computeLossReport, repoRoot } from "../cli.mjs";
import { hasUnacknowledgedLosses } from "../core/loss.mjs";

const DOC_PATH = resolve(repoRoot, "docs/skill-authoring.md");

// Same cost profile as cli-render.test.mjs's renderAllPacks call — see that
// file's comment for the measured timing history.
const RENDER_ALL_PACKS_TIMEOUT_MS = 20000;

function liveEmittedCount() {
  const results = renderAllPacks(repoRoot);
  const report = computeLossReport(results, "2026-01-01T00:00:00.000Z");
  expect(hasUnacknowledgedLosses(report)).toBe(true); // no silent caps
  const totalSkills = results.reduce((sum, r) => sum + r.pack.skills.length, 0);
  const omittedCount = report.targets.agentsSkills.omitted.length;
  return totalSkills - omittedCount;
}

describe("docs/skill-authoring.md's hooks-veto census does not embed a stale total", () => {
  const doc = readFileSync(DOC_PATH, "utf8");

  test("no hardcoded 'N skills across M plugins' total appears", () => {
    // This is the exact stale-total shape the review flagged — guard the
    // pattern generally, not just the literal "103"/"9" that was fixed,
    // since any hardcoded total would go stale the same way.
    expect(doc).not.toMatch(/\d+\s+skills\s+across\s+\d+\s+plugins?/i);
  });

  test(
    "the doc's 'reach the portable pack' skill count matches the live packaging inventory",
    () => {
      const match = doc.match(/exactly \*\*(\d+)\*\* skills? reach the portable pack/i);
      expect(match).not.toBeNull();
      const claimed = Number(match[1]);
      expect(claimed).toBe(liveEmittedCount());
    },
    RENDER_ALL_PACKS_TIMEOUT_MS,
  );
});
