// version.test.ts — tests for the HUD's plugin-version helper (CTL-390).
// Run from plugins/dev/scripts/orch-monitor: bun test cli/lib/version.test.ts

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  readPluginVersion,
  buildDisplay,
  formatVersionBlock,
} from "./version.ts";

const gitAvailable = (() => {
  const r = spawnSync("git", ["--version"], { encoding: "utf8" });
  return r.status === 0;
})();

// Build a fake plugin tree at $root with the given version.txt + commit.txt.
// Returns the script directory the HUD would start from.
function seedFakePlugin(
  root: string,
  opts: { version?: string; commit?: string; gitInit?: boolean },
): string {
  const plugin = join(root, "plugins", "dev");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plugin, "scripts", "orch-monitor", "cli", "lib"), { recursive: true });
  writeFileSync(
    join(plugin, ".claude-plugin", "plugin.json"),
    '{"name":"catalyst-dev","version":"x"}',
  );
  if (opts.version !== undefined) {
    writeFileSync(join(plugin, "version.txt"), `${opts.version}\n`);
  }
  if (opts.commit !== undefined) {
    writeFileSync(join(plugin, "commit.txt"), `${opts.commit}\n`);
  }
  if (opts.gitInit === true) {
    spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
    spawnSync("git", ["-C", root, "config", "user.email", "t@t"], { encoding: "utf8" });
    spawnSync("git", ["-C", root, "config", "user.name", "t"], { encoding: "utf8" });
    spawnSync("git", ["-C", root, "checkout", "-B", "test-branch", "--quiet"], {
      encoding: "utf8",
    });
    writeFileSync(join(root, "seed"), "x");
    spawnSync("git", ["-C", root, "add", "seed"], { encoding: "utf8" });
    spawnSync("git", ["-C", root, "commit", "--quiet", "-m", "seed"], { encoding: "utf8" });
  }
  return join(plugin, "scripts", "orch-monitor", "cli", "lib");
}

describe("readPluginVersion", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "ctl390-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("returns embedded version + commit when no .git ancestor", () => {
    const start = seedFakePlugin(tmp, { version: "9.2.0", commit: "abc123def" });
    const info = readPluginVersion(start);
    expect(info.version).toBe("9.2.0");
    expect(info.commit).toBe("abc123def");
    expect(info.isLocal).toBe(false);
    expect(info.worktreeBranch).toBeNull();
    expect(info.sourcePath).toBe(join(tmp, "plugins", "dev"));
  });

  test("commit defaults to 'unknown' when commit.txt missing", () => {
    const start = seedFakePlugin(tmp, { version: "9.2.0" });
    const info = readPluginVersion(start);
    expect(info.commit).toBe("unknown");
  });

  test("version defaults to 'unknown' when version.txt missing", () => {
    const start = seedFakePlugin(tmp, { commit: "abc123" });
    const info = readPluginVersion(start);
    expect(info.version).toBe("unknown");
  });

  test.skipIf(!gitAvailable)(".git ancestor wins, prefixing commit with local:", () => {
    const start = seedFakePlugin(tmp, { version: "9.2.0", commit: "release-sha", gitInit: true });
    const info = readPluginVersion(start);
    expect(info.isLocal).toBe(true);
    expect(info.commit.startsWith("local:")).toBe(true);
    // The embedded commit.txt is ignored when .git is present.
    expect(info.commit).not.toBe("release-sha");
    expect(info.worktreeBranch).toBe("test-branch");
    expect(info.sourcePath).toBe(start);
  });

  test("trims whitespace from version.txt and commit.txt", () => {
    const start = seedFakePlugin(tmp, { version: "  9.2.0\n", commit: "  abc\t" });
    const info = readPluginVersion(start);
    expect(info.version).toBe("9.2.0");
    expect(info.commit).toBe("abc");
  });
});

describe("buildDisplay", () => {
  test("plain release", () => {
    expect(buildDisplay("9.2.0", "0e4e26774742396c9acea7056b1989a4e74a8be2", false))
      .toBe("v9.2.0 · 0e4e267");
  });
  test("local source", () => {
    expect(buildDisplay("9.2.0", "local:523b6feef68496136446a51020256e4aed327185", true))
      .toBe("v9.2.0 · local:523b6fe");
  });
  test("unknown commit drops the dot separator", () => {
    expect(buildDisplay("9.2.0", "unknown", false)).toBe("v9.2.0");
  });
});

describe("formatVersionBlock", () => {
  test("renders the three-line shape the bash helper prints", () => {
    const block = formatVersionBlock("catalyst-hud", {
      version: "9.2.0",
      commit: "local:523b6fe",
      isLocal: true,
      worktreeBranch: "feat/branch",
      sourcePath: "/p",
      display: "v9.2.0 · local:523b6fe",
    });
    expect(block).toBe(
      "catalyst-hud 9.2.0\n" +
      "commit: local:523b6fe (worktree: feat/branch)\n" +
      "source: /p",
    );
  });
  test("omits worktree note when branch is null", () => {
    const block = formatVersionBlock("catalyst-hud", {
      version: "9.2.0",
      commit: "abc",
      isLocal: false,
      worktreeBranch: null,
      sourcePath: "/p",
      display: "v9.2.0 · abc",
    });
    expect(block).toBe("catalyst-hud 9.2.0\ncommit: abc\nsource: /p");
  });
});
