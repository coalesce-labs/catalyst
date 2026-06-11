// plugin-dirs-health.test.mjs — tests for the plugin_source_health bash
// function in lib/plugin-dirs.sh (CTL-992): offline, read-only structural
// health check of a pluginDirs checkout.
// Run from plugins/dev/scripts/broker: bun test ../lib/plugin-dirs-health.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "plugin-dirs.sh");

// git, configured for hermetic commits (no signing, fixed identity, main default).
function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c", "user.email=t@t",
      "-c", "user.name=t",
      "-c", "commit.gpgsign=false",
      "-c", "init.defaultBranch=main",
      "-C", cwd,
      ...args,
    ],
    { encoding: "utf8" },
  );
}

// Run `plugin_source_health <dir>` via bash and capture stdout + exit code.
function health(pd) {
  try {
    const out = execFileSync(
      "bash",
      ["-c", `source "${LIB}"; plugin_source_health "${pd}"`],
      { encoding: "utf8" },
    );
    return { out, code: 0 };
  } catch (e) {
    return { out: (e.stdout || "").toString(), code: e.status ?? 1 };
  }
}

// Build a clean checkout on main with a plugins/dev manifest committed.
function makeCheckout(root) {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  const pd = join(root, "plugins", "dev", ".claude-plugin");
  mkdirSync(pd, { recursive: true });
  writeFileSync(
    join(pd, "plugin.json"),
    JSON.stringify({ name: "catalyst-dev", version: "1.0.0" }),
  );
  writeFileSync(join(root, "plugins", "dev", "marker.txt"), "v1\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "initial");
}

describe("plugin_source_health", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pdh-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("clean main checkout → no lines, exit 0", () => {
    const root = join(tmp, "checkout");
    makeCheckout(root);
    const { out, code } = health(join(root, "plugins", "dev"));
    expect(out.trim()).toBe("");
    expect(code).toBe(0);
  });

  test("off-main checkout → OFF_MAIN line, nonzero", () => {
    const root = join(tmp, "checkout");
    makeCheckout(root);
    git(root, "checkout", "-q", "-b", "feature");
    const { out, code } = health(join(root, "plugins", "dev"));
    expect(out).toContain("OFF_MAIN");
    expect(out).toContain("feature");
    expect(code).not.toBe(0);
  });

  test("dirty working tree → DIRTY line, nonzero", () => {
    const root = join(tmp, "checkout");
    makeCheckout(root);
    writeFileSync(join(root, "plugins", "dev", "marker.txt"), "edit\n");
    const { out, code } = health(join(root, "plugins", "dev"));
    expect(out).toContain("DIRTY");
    expect(code).not.toBe(0);
  });

  test("missing dir → MISSING line, nonzero", () => {
    const { out, code } = health(join(tmp, "does-not-exist", "plugins", "dev"));
    expect(out).toContain("MISSING");
    expect(code).not.toBe(0);
  });

  test("non-git dir → NOT_A_CHECKOUT line, nonzero", () => {
    const pd = join(tmp, "plain", "plugins", "dev");
    mkdirSync(pd, { recursive: true });
    const { out, code } = health(pd);
    expect(out).toContain("NOT_A_CHECKOUT");
    expect(code).not.toBe(0);
  });

  test("linked worktree → LINKED_WORKTREE line, nonzero", () => {
    const root = join(tmp, "primary");
    makeCheckout(root);
    // main is occupied by the primary; park it on a throwaway branch so the
    // linked worktree can itself sit on main (isolating LINKED_WORKTREE from
    // OFF_MAIN).
    git(root, "checkout", "-q", "-b", "parking");
    const linked = join(tmp, "linked");
    git(root, "worktree", "add", "-q", linked, "main");
    const { out, code } = health(join(linked, "plugins", "dev"));
    expect(out).toContain("LINKED_WORKTREE");
    expect(code).not.toBe(0);
  });
});
