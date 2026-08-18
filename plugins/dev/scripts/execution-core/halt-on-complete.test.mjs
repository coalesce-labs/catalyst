// halt-on-complete.test.mjs — CTL-778 Step 2A: every terminating phase skill
// must self-stop after emitting complete so workers don't sit idle for ~7h.
//
// Run: cd plugins/dev/scripts/execution-core && bun test halt-on-complete.test.mjs

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
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

// CTL-1998: a skill is SKILL.md **plus its references/**, not SKILL.md alone.
// This guard used to read only SKILL.md. When #3654 moved _phase-agent-template's
// end block into references/end-block.md — where the `claude stop` line still
// lives, verbatim — the guard reported the invariant BROKEN on a skill that
// satisfies it. Progressive disclosure is the repo's documented direction
// (CTL-1993, CTL-1998), so a per-skill scan pinned to one file will keep
// mis-reporting as more skills split, and the natural way to "fix" a red build
// would be to move the end block back — defeating the refactor.
//
// Reading the whole skill also STRENGTHENS the negative case below: a self-stop
// smuggled into a long-running monitor's references/ was previously invisible to
// that assertion. Both directions now scan the same surface.
function readSkillBody(skill) {
  const dir = join(DEV_ROOT, "skills", skill);
  const parts = [readFileSync(join(dir, "SKILL.md"), "utf8")];
  let refs = [];
  try {
    refs = readdirSync(join(dir, "references"))
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    /* no references/ dir — SKILL.md is the whole skill */
  }
  for (const f of refs) parts.push(readFileSync(join(dir, "references", f), "utf8"));
  return parts.join("\n");
}

describe("CTL-778 Step 2A: self-stop in every terminating phase skill", () => {
  for (const skill of SKILLS) {
    test(`${skill} self-stops after emit-complete`, () => {
      const body = readSkillBody(skill);
      // Must read its own bg_job_id from the signal file and call `claude stop`.
      expect(body).toContain('claude stop "${_SELF_BG:0:8}"');
      expect(body).toMatch(/bg_job_id \/\/ empty/);
    });
  }

  test("long-running monitors are NOT given self-stop", () => {
    for (const skill of ["phase-monitor-merge", "phase-monitor-deploy"]) {
      const body = readSkillBody(skill);
      expect(body).not.toContain('claude stop "${_SELF_BG:0:8}"');
    }
  });
});
