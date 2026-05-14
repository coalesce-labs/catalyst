// version.ts — read plugin version + commit info for the HUD (CTL-390).
//
// Mirrors plugins/dev/scripts/lib/catalyst-version.sh:
//   - Walks ancestors of this file looking for the plugin root (version.txt +
//     .claude-plugin/plugin.json) and a .git ancestor.
//   - Local source wins: when a .git ancestor exists, prefix the SHA with
//     "local:" and use the script directory as the source path.
//   - Otherwise read commit.txt for the embedded release SHA.
//   - Falls back to "unknown" for missing values.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export interface PluginVersionInfo {
  /** Plugin version (e.g. "9.2.0") or "unknown". */
  version: string;
  /** Commit hash. Either a raw SHA, "local:<sha>", or "unknown". */
  commit: string;
  /** True when a .git ancestor was found (worktree / local source). */
  isLocal: boolean;
  /** Worktree branch when isLocal is true and the branch is not detached. */
  worktreeBranch: string | null;
  /** Plugin root if found, otherwise the start directory. */
  sourcePath: string;
  /**
   * Display label for the HUD chip:
   *   "v9.2.0"           — release / no commit detected
   *   "v9.2.0 · 523b6fe" — release with embedded SHA
   *   "v9.2.0 · local:523b6fe" — local source
   */
  display: string;
}

function readTrim(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    const txt = readFileSync(path, "utf8").trim();
    return txt.length > 0 ? txt : null;
  } catch {
    return null;
  }
}

/** Walk ancestors looking for the plugin root and a .git ancestor. */
function findRoots(start: string): { pluginRoot: string | null; gitRoot: string | null } {
  let pluginRoot: string | null = null;
  let gitRoot: string | null = null;
  let dir = start;
  // Loop until we hit the filesystem root.
  for (let i = 0; i < 32; i++) {
    if (
      pluginRoot === null
      && existsSync(resolve(dir, "version.txt"))
      && existsSync(resolve(dir, ".claude-plugin", "plugin.json"))
    ) {
      pluginRoot = dir;
    }
    if (gitRoot === null && existsSync(resolve(dir, ".git"))) {
      gitRoot = dir;
    }
    if (pluginRoot !== null && gitRoot !== null) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { pluginRoot, gitRoot };
}

function gitRevParse(root: string, args: string[]): string | null {
  try {
    const res = spawnSync("git", ["-C", root, "rev-parse", ...args], {
      encoding: "utf8",
      timeout: 1000,
    });
    if (res.status !== 0) return null;
    const out = (res.stdout ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Resolve plugin version info starting from `startPath`. Defaults to the
 * directory of this module so the HUD's call site can omit it.
 */
export function readPluginVersion(startPath?: string): PluginVersionInfo {
  const here = startPath ?? dirname(fileURLToPath(import.meta.url));
  const { pluginRoot, gitRoot } = findRoots(here);

  const version = pluginRoot
    ? (readTrim(resolve(pluginRoot, "version.txt")) ?? "unknown")
    : "unknown";

  let commit = "unknown";
  let isLocal = false;
  let worktreeBranch: string | null = null;
  let sourcePath: string = pluginRoot ?? here;

  if (gitRoot !== null) {
    const sha = gitRevParse(gitRoot, ["HEAD"]);
    if (sha !== null) {
      commit = `local:${sha}`;
      isLocal = true;
      sourcePath = here;
      const branch = gitRevParse(gitRoot, ["--abbrev-ref", "HEAD"]);
      if (branch !== null && branch !== "HEAD") {
        worktreeBranch = branch;
      }
    }
  }
  if (commit === "unknown" && pluginRoot !== null) {
    const embedded = readTrim(resolve(pluginRoot, "commit.txt"));
    if (embedded !== null) commit = embedded;
  }

  const display = buildDisplay(version, commit, isLocal);
  return { version, commit, isLocal, worktreeBranch, sourcePath, display };
}

/** Build the short display label for the HUD chip. */
export function buildDisplay(version: string, commit: string, isLocal: boolean): string {
  if (commit === "unknown") return `v${version}`;
  if (isLocal) {
    // commit is "local:<full-sha>" — abbreviate to 7 chars after the prefix.
    const sha = commit.startsWith("local:") ? commit.slice(6) : commit;
    return `v${version} · local:${sha.slice(0, 7)}`;
  }
  return `v${version} · ${commit.slice(0, 7)}`;
}

/** Format the three-line stdout block matching the bash helper's output. */
export function formatVersionBlock(cliName: string, info: PluginVersionInfo): string {
  const worktreeNote = info.worktreeBranch !== null
    ? ` (worktree: ${info.worktreeBranch})`
    : "";
  return [
    `${cliName} ${info.version}`,
    `commit: ${info.commit}${worktreeNote}`,
    `source: ${info.sourcePath}`,
  ].join("\n");
}
