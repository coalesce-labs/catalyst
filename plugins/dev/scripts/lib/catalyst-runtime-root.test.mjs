// catalyst-runtime-root.test.mjs — tests for the .mjs twin of
// catalyst-runtime-root.sh (CTL-1628 Phase A2): catalystDevScripts,
// catalystPluginRoot, catalystRuntimeLayout.
// Run: bun test plugins/dev/scripts/lib/catalyst-runtime-root.test.mjs
//
// Hermetic: every scenario passes explicit `env`/`cwd` options (or an
// explicit `dir`) into the functions rather than mutating process.env/cwd,
// so this suite never touches the real ~/.claude or the runner's own cwd.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalystDevScripts, catalystPluginRoot, catalystRuntimeLayout } from "./catalyst-runtime-root.mjs";

const scratchDirs = [];
function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "crr-test-")));
  scratchDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (scratchDirs.length) rmSync(scratchDirs.pop(), { recursive: true, force: true });
});

function makeDevScripts(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "check-project-setup.sh"), "");
}

describe("catalystDevScripts", () => {
  test("env override: uses env.CATALYST_DEV_SCRIPTS when valid", () => {
    const root = scratch();
    const dev = join(root, "somewhere", "scripts");
    makeDevScripts(dev);
    const result = catalystDevScripts(undefined, { env: { CATALYST_DEV_SCRIPTS: dev }, cwd: root });
    expect(result).toEqual({ path: dev, source: "env" });
  });

  test("sibling: resolves <requestingPlugin>/../dev/scripts", () => {
    const root = scratch();
    const plugin = join(root, "plugins", "foundry");
    const dev = join(root, "plugins", "dev", "scripts");
    mkdirSync(plugin, { recursive: true });
    makeDevScripts(dev);
    const result = catalystDevScripts(plugin, { env: {}, cwd: scratch() });
    expect(result).toEqual({ path: dev, source: "sibling" });
  });

  test("sibling: falls back to env.CLAUDE_PLUGIN_ROOT when requestingPlugin omitted", () => {
    const root = scratch();
    const plugin = join(root, "plugins", "legacy");
    const dev = join(root, "plugins", "dev", "scripts");
    mkdirSync(plugin, { recursive: true });
    makeDevScripts(dev);
    const result = catalystDevScripts(undefined, { env: { CLAUDE_PLUGIN_ROOT: plugin }, cwd: scratch() });
    expect(result).toEqual({ path: dev, source: "sibling" });
  });

  test("cwd: resolves <cwd>/plugins/dev/scripts", () => {
    const root = scratch();
    const dev = join(root, "plugins", "dev", "scripts");
    makeDevScripts(dev);
    const result = catalystDevScripts(undefined, { env: {}, cwd: root });
    expect(result).toEqual({ path: dev, source: "cwd" });
  });

  test("marketplace: picks the NEWEST version via numeric sort (v10 over v9)", () => {
    const home = scratch();
    makeDevScripts(join(home, ".claude/plugins/marketplaces/catalyst-old/plugins/dev/scripts"));
    makeDevScripts(join(home, ".claude/plugins/marketplaces/catalyst-v9/plugins/dev/scripts"));
    const newest = join(home, ".claude/plugins/marketplaces/catalyst-v10/plugins/dev/scripts");
    makeDevScripts(newest);
    const result = catalystDevScripts(undefined, { env: { HOME: home }, cwd: scratch() });
    expect(result).toEqual({ path: newest, source: "marketplace" });
  });

  test("cache: picks the NEWEST version via numeric sort (1.10.0 over 1.2.0)", () => {
    const home = scratch();
    makeDevScripts(join(home, ".claude/plugins/cache/catalyst/catalyst-dev/1.2.0/scripts"));
    const newest = join(home, ".claude/plugins/cache/catalyst/catalyst-dev/1.10.0/scripts");
    makeDevScripts(newest);
    const result = catalystDevScripts(undefined, { env: { HOME: home }, cwd: scratch() });
    expect(result).toEqual({ path: newest, source: "cache" });
  });

  test("cache: absent marketplaces/cache root does not throw (skip, don't abort)", () => {
    const home = scratch(); // exists but has no .claude/plugins/* at all
    expect(() => catalystDevScripts(undefined, { env: { HOME: home }, cwd: scratch() })).not.toThrow();
  });

  test("marketplace: skips a partial newest install, falls back to the newest VALID candidate", () => {
    // CTL-1628 A2 post-merge fix: the newest candidate (catalyst-v2, no
    // sentinel — a partial/broken install) must not sink the whole rung;
    // resolution should fall back to the next-newest valid candidate.
    const home = scratch();
    const valid = join(home, ".claude/plugins/marketplaces/catalyst-v1/plugins/dev/scripts");
    makeDevScripts(valid);
    mkdirSync(join(home, ".claude/plugins/marketplaces/catalyst-v2/plugins/dev/scripts"), {
      recursive: true,
    }); // no sentinel file — partial install
    const result = catalystDevScripts(undefined, { env: { HOME: home }, cwd: scratch() });
    expect(result).toEqual({ path: valid, source: "marketplace" });
  });

  test("cache: skips a partial newest install (2.0.0), falls back to valid 1.0.0", () => {
    const home = scratch();
    const valid = join(home, ".claude/plugins/cache/catalyst/catalyst-dev/1.0.0/scripts");
    makeDevScripts(valid);
    mkdirSync(join(home, ".claude/plugins/cache/catalyst/catalyst-dev/2.0.0/scripts"), {
      recursive: true,
    }); // no sentinel file — partial install
    const result = catalystDevScripts(undefined, { env: { HOME: home }, cwd: scratch() });
    expect(result).toEqual({ path: valid, source: "cache" });
  });

  test("marketplace: follows a symlinked installation directory (matches `ls -d` glob semantics)", () => {
    // CTL-1628 A2 post-merge fix: Dirent.isDirectory() is false for a
    // symlink entry, so a symlinked marketplace clone (e.g. a dev checkout
    // symlinked into ~/.claude/plugins/marketplaces/) used to be silently
    // dropped by the wildcard expansion, diverging from the bash twin's
    // `ls -d ...*/plugins/dev/scripts`, which follows symlinks.
    const home = scratch();
    const realTarget = scratch();
    makeDevScripts(join(realTarget, "plugins", "dev", "scripts"));
    mkdirSync(join(home, ".claude/plugins/marketplaces"), { recursive: true });
    symlinkSync(realTarget, join(home, ".claude/plugins/marketplaces", "catalyst-symlinked"), "dir");
    const result = catalystDevScripts(undefined, { env: { HOME: home }, cwd: scratch() });
    expect(result.source).toBe("marketplace");
    expect(result.path).toBe(join(home, ".claude/plugins/marketplaces/catalyst-symlinked/plugins/dev/scripts"));
  });

  test("cache: follows a symlinked version directory (second wildcard segment)", () => {
    // The symlink sits at the SECOND `*` in `cache/*/catalyst-dev/*/scripts`
    // (the version dir) — the wildcard position the Dirent.isDirectory()
    // bug actually affects, as opposed to a literal path segment which
    // reaches existsSync() unconditionally and was never at risk.
    const home = scratch();
    const realTarget = scratch();
    makeDevScripts(join(realTarget, "scripts"));
    mkdirSync(join(home, ".claude/plugins/cache/catalyst/catalyst-dev"), { recursive: true });
    symlinkSync(realTarget, join(home, ".claude/plugins/cache/catalyst/catalyst-dev", "1.0.0"), "dir");
    const result = catalystDevScripts(undefined, { env: { HOME: home }, cwd: scratch() });
    expect(result.source).toBe("cache");
    expect(result.path).toBe(
      join(home, ".claude/plugins/cache/catalyst/catalyst-dev/1.0.0/scripts"),
    );
  });

  test("total miss: returns null path/source and prints a LOUD stderr diagnostic", () => {
    const home = scratch();
    const originalError = console.error;
    let stderrOut = "";
    console.error = (msg) => {
      stderrOut += String(msg);
    };
    try {
      const result = catalystDevScripts(undefined, { env: { HOME: home }, cwd: scratch() });
      expect(result).toEqual({ path: null, source: null });
    } finally {
      console.error = originalError;
    }
    expect(stderrOut).toContain("requires the 'catalyst-dev' plugin");
    expect(stderrOut).toContain("CATALYST_DEV_SCRIPTS=");
  });
});

describe("catalystPluginRoot", () => {
  test("walks up to the first ancestor with both version.txt and .claude-plugin/plugin.json", () => {
    const root = scratch();
    const plugin = join(root, "plugins", "dev");
    const deep = join(plugin, "scripts", "lib");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(plugin, "version.txt"), "1.0.0\n");
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), "{}");
    expect(catalystPluginRoot(deep)).toBe(plugin);
  });

  test("returns null when no ancestor qualifies", () => {
    const lone = scratch();
    const deep = join(lone, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    expect(catalystPluginRoot(deep)).toBeNull();
  });

  test("defaults startDir to process.cwd() and never throws on a bogus dir", () => {
    expect(() => catalystPluginRoot("/nonexistent-" + Date.now())).not.toThrow();
  });

  test("rejects a nonexistent startDir even when nested beneath a valid plugin root", () => {
    // CTL-1628 A2 post-merge fix: the bash twin's `cd "$dir" 2>/dev/null`
    // fails outright on a nonexistent startDir (immediate miss, no ancestor
    // walk). resolvePath() alone never touches the filesystem, so a stale/
    // mistyped startDir under a real plugin used to walk UP from the
    // nonexistent path and return the valid ancestor instead of null.
    const root = scratch();
    const plugin = join(root, "plugins", "dev");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, "version.txt"), "1.0.0\n");
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), "{}");
    const stale = join(plugin, "scripts", "does-not-exist");
    expect(catalystPluginRoot(stale)).toBeNull();
  });

  test("rejects a startDir that resolves to a file, not a directory", () => {
    const root = scratch();
    const plugin = join(root, "plugins", "dev");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, "version.txt"), "1.0.0\n");
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), "{}");
    const notADir = join(plugin, "version.txt");
    expect(catalystPluginRoot(notADir)).toBeNull();
  });
});

describe("catalystRuntimeLayout", () => {
  test("classifies marketplaces/*/plugins/dev/scripts as marketplace", () => {
    const home = scratch();
    const dir = join(home, ".claude/plugins/marketplaces/catalyst/plugins/dev/scripts");
    mkdirSync(dir, { recursive: true });
    expect(catalystRuntimeLayout(dir, { env: { HOME: home } })).toBe("marketplace");
  });

  test("classifies cache/*/catalyst-dev/*/scripts as cache", () => {
    const home = scratch();
    const dir = join(home, ".claude/plugins/cache/catalyst/catalyst-dev/1.0.0/scripts");
    mkdirSync(dir, { recursive: true });
    expect(catalystRuntimeLayout(dir, { env: { HOME: home } })).toBe("cache");
  });

  test("classifies a dir with a .git ancestor as source-checkout", () => {
    const root = scratch();
    mkdirSync(join(root, ".git"), { recursive: true });
    const dir = join(root, "plugins", "dev", "scripts");
    mkdirSync(dir, { recursive: true });
    expect(catalystRuntimeLayout(dir, { env: { HOME: scratch() } })).toBe("source-checkout");
  });

  test("classifies an arbitrary non-catalyst, non-git dir as unknown", () => {
    const dir = scratch();
    expect(catalystRuntimeLayout(dir, { env: { HOME: scratch() } })).toBe("unknown");
  });

  test("classifies an absent dir as unknown, never throws", () => {
    expect(catalystRuntimeLayout("/nonexistent-" + Date.now(), { env: {} })).toBe("unknown");
  });

  test("classifies undefined/empty dir as unknown", () => {
    expect(catalystRuntimeLayout(undefined, { env: {} })).toBe("unknown");
    expect(catalystRuntimeLayout("", { env: {} })).toBe("unknown");
  });
});
