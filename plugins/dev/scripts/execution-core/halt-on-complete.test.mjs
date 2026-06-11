// halt-on-complete.test.mjs — CTL-778 Step 2A: every terminating phase skill
// must self-stop after emitting complete so workers don't sit idle for ~7h.
//
// Run: cd plugins/dev/scripts/execution-core && bun test halt-on-complete.test.mjs

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEV_ROOT = join(import.meta.dir, "..", "..");

const SKILLS = [
  "_phase-agent-template",
  "phase-triage",
  "phase-research",
  "phase-plan",
  "phase-implement",
  "phase-verify",
  "phase-review",
  "phase-pr",
];

describe("CTL-778 Step 2A: self-stop in every terminating phase skill", () => {
  for (const skill of SKILLS) {
    test(`${skill} self-stops after emit-complete`, () => {
      const body = readFileSync(
        join(DEV_ROOT, "skills", skill, "SKILL.md"),
        "utf8",
      );
      // Must read its own bg_job_id from the signal file and call `claude stop`.
      expect(body).toContain('claude stop "${_SELF_BG:0:8}"');
      expect(body).toMatch(/bg_job_id \/\/ empty/);
    });
  }

  test("long-running monitors are NOT given self-stop", () => {
    for (const skill of ["phase-monitor-merge", "phase-monitor-deploy"]) {
      const body = readFileSync(
        join(DEV_ROOT, "skills", skill, "SKILL.md"),
        "utf8",
      );
      expect(body).not.toContain('claude stop "${_SELF_BG:0:8}"');
    }
  });
});
