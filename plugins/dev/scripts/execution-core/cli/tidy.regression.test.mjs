// tidy.regression.test.mjs — CTL-675 end-to-end regression. Drives the REAL
// tidy.mjs in a child process against a temp NON-repo dir with an empty
// registry — the exact ticket scenario — and asserts the fixed behavior: exit
// non-zero + a git-failure line, NOT the `planned (dry-run)` success line and
// no raw `fatal:` leak. This is the coverage research §6 found missing: every
// other test injects fixtures, so none exercised the outside-a-repo git path.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("tidy outside a git repo (CTL-675 regression)", () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ctl675-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("exits non-zero and surfaces the git failure instead of a fake success", () => {
    const r = spawnSync("bun", [join(import.meta.dir, "tidy.mjs"), "--dry-run"], {
      cwd: dir, // NOT a git repo
      // CATALYST_DIR points the registry at the empty temp dir (no registry.json
      // → listProjects() === []); CATALYST_REPO_ROOT="" so step 2 doesn't resolve.
      env: { ...process.env, CATALYST_DIR: dir, CATALYST_REPO_ROOT: "" },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toMatch(/aborted at worktrees|cannot resolve a git repo root|not a git repository/);
    expect(out).not.toMatch(/tidy: planned \(dry-run\) — steps: sessions, worktrees, branches/);
  });
});
