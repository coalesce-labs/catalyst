// lib/catalyst-runtime-root.mjs — CTL-1628 Phase A2: the JS twin of
// lib/catalyst-runtime-root.sh, answering the same three resolver questions
// for .mjs/.ts consumers that cannot `source` a bash lib:
//
//   Q1. Where is the catalyst-dev `scripts/` dir?  → catalystDevScripts
//   Q3. What is the enclosing plugin's root dir?    → catalystPluginRoot
//   —   What kind of install is this process in?    → catalystRuntimeLayout
//
// ZERO-IMPORT LEAF (node:fs / node:os / node:path only) — same rationale as
// lib/deployment-mode.mjs and lib/secret-contract.mjs: doctor.mjs and other
// bare-Node callers must be able to import this without pulling a heavier
// module graph, and — the reason THIS file exists at all — a consumer in a
// DIFFERENT plugin (e.g. catalyst-pm's score-tickets.ts) must be able to
// `await import()` it LAZILY, on demand, without an eager top-level import
// that would crash every unrelated code path the moment catalyst-dev
// happens not to be co-located (the exact score-tickets.ts loadResolveSecret
// constraint this twin is designed to be folded onto — see that file's own
// CTL-1616 PR3 comment for the fuller rationale). Concretely: never import
// this module at another package's top level; always `await import(path)`
// after first locating `path` (which is circular for THIS file specifically
// — see catalystDevScripts's own doc comment for how callers break that
// circularity in practice).
//
// catalystRuntimeLayout's source-checkout detection intentionally does NOT
// reuse lib/plugin-dirs.sh's git-subprocess-based plugin_checkout_root (the
// bash twin sources that file for exactly this) — shelling out to `git`
// would break the zero-import-leaf contract above. Instead it walks parent
// directories looking for a bare `.git` entry (dir or linked-worktree file),
// which answers "is this inside SOME git checkout" without a subprocess.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";

const DEV_SCRIPTS_SENTINEL = "check-project-setup.sh";

function isValidDevScriptsDir(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  try {
    return statSync(path).isDirectory() && existsSync(join(path, DEV_SCRIPTS_SENTINEL));
  } catch {
    return false;
  }
}

// versionCompare — mirrors `sort -V`'s ordering closely enough for this
// module's two glob call sites (marketplace repo names, cache version
// dirs): splits each string into alternating digit/non-digit runs and
// compares digit runs numerically, everything else lexically.
function versionCompare(a, b) {
  const re = /(\d+|\D+)/g;
  const as = a.match(re) ?? [a];
  const bs = b.match(re) ?? [b];
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const av = as[i] ?? "";
    const bv = bs[i] ?? "";
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) {
      const diff = Number(av) - Number(bv);
      if (diff !== 0) return diff;
      continue;
    }
    return av < bv ? -1 : 1;
  }
  return 0;
}

// expandStarGlob(pattern) — supports exactly one-directory-level `*`
// wildcards in an absolute, `/`-separated path (the only shape this
// module's two call sites need: `.../marketplaces/*/plugins/dev/scripts`
// and `.../cache/*/catalyst-dev/*/scripts`). Deliberately readdirSync-based
// rather than fs.globSync — globSync's Node/Bun version-support surface
// (and its ENOENT-on-absent-root throw, worked around in score-tickets.ts's
// loadResolveSecret) is exactly the fragility this dependency-light
// reimplementation avoids. Returns every path that currently exists,
// unsorted, silently skipping unreadable intermediate directories (an
// absent optional layout root, e.g. no marketplaces/ dir at all, is not an
// error here — same "skip, don't abort" contract score-tickets.ts's
// per-glob try/catch documents for the same reason).
function expandStarGlob(pattern) {
  const segments = pattern.split("/").filter((s) => s.length > 0);
  let current = [pattern.startsWith("/") ? "/" : ""];
  for (const seg of segments) {
    const next = [];
    for (const dir of current) {
      if (seg === "*") {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue; // absent/unreadable optional layout root — skip, don't abort
        }
        for (const e of entries) {
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            next.push(full);
          } else if (e.isSymbolicLink()) {
            // CTL-1628 A2 post-merge fix: Dirent.isDirectory() is false for
            // a symlink (it reports the dirent's OWN type, not its target),
            // so a symlinked marketplace/cache install used to be silently
            // dropped here while the bash twin's `ls -d` glob (which follows
            // symlinks) accepted it — a same-inputs, different-output
            // divergence between the twins. statSync follows the link;
            // stat-through a broken symlink throws, so skip it like any
            // other unreadable entry.
            try {
              if (statSync(full).isDirectory()) next.push(full);
            } catch {
              continue; // broken symlink — skip, don't abort
            }
          }
        }
      } else {
        next.push(join(dir, seg));
      }
    }
    current = next;
  }
  return current.filter((p) => existsSync(p));
}

// newestDevScriptsDir — CTL-1628 A2 post-merge fix: mirrors the bash twin's
// rung semantics exactly. lib/catalyst-runtime-root.sh's catalyst_dev_scripts
// walks candidates newest-to-oldest (`sort -rV`) and returns the first one
// that sentinel-validates, rather than validating ONLY the single newest
// candidate. A partial/broken newest install (sentinel missing) used to fail
// the WHOLE rung even when an older, fully-valid install sat right next to
// it — register-thought.sh's workflow-context.sh lookup hit exactly this: it
// validates a DIFFERENT file than catalyst_dev_scripts' own sentinel, so a
// newest cache dir that passes THIS sentinel but happens to be missing
// workflow-context.sh specifically shadowed an older cache dir that had it.
// (An earlier "verify-round-2" pass here intentionally matched a STRICTER
// newest-then-validate-only bash behavior; this pass changes BOTH twins
// together to the more robust validate-then-accept walk, so the twins stay
// in parity either way.)
function newestDevScriptsDir(paths) {
  if (paths.length === 0) return null;
  const sorted = [...paths].sort(versionCompare).reverse();
  for (const candidate of sorted) {
    if (isValidDevScriptsDir(candidate)) return candidate;
  }
  return null;
}

// catalystDevScripts([requestingPlugin], [opts]) — Q1. Resolves the shared
// catalyst-dev `scripts/` dir. Returns `{ path, source }` — `path` is the
// resolved directory or `null` on a miss, `source` is one of "env" |
// "sibling" | "cwd" | "marketplace" | "cache" | null. NEVER throws (matches
// this codebase's resolveSecret/resolveDeploymentMode convention); prints
// the same actionable LOUD message require-catalyst-dev.sh's bash resolver
// prints to stderr when every rung misses, so a caller that doesn't itself
// re-message the failure still gets a diagnosable stderr line.
//
// Resolution order (first dir containing the sentinel wins) — identical to
// lib/catalyst-runtime-root.sh's catalyst_dev_scripts:
//   1. env.CATALYST_DEV_SCRIPTS if already valid
//   2. sibling in a source checkout:  <requestingPlugin>/../dev/scripts
//   3. repo-root cwd:                 <cwd>/plugins/dev/scripts
//   4. installed marketplace clone:   ~/.claude/plugins/marketplaces/*/plugins/dev/scripts
//   5. installed versioned cache:     ~/.claude/plugins/cache/*/catalyst-dev/*/scripts
//
// CIRCULARITY NOTE for callers that want to import a DIFFERENT catalyst-dev
// .mjs module lazily (the score-tickets.ts use case): this function itself
// cannot be the thing you dynamically `import()` to find itself. Callers in
// that position mirror this file's OWN resolution order inline against a
// known sibling filename (see score-tickets.ts's loadResolveSecret for the
// existing worked example) rather than importing this module first.
export function catalystDevScripts(requestingPlugin, { env = process.env, cwd = process.cwd() } = {}) {
  const home = typeof env.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();

  if (isValidDevScriptsDir(env.CATALYST_DEV_SCRIPTS)) {
    return { path: env.CATALYST_DEV_SCRIPTS, source: "env" };
  }

  const rp = requestingPlugin ?? env.CLAUDE_PLUGIN_ROOT;
  if (typeof rp === "string" && rp.length > 0) {
    const sibling = resolvePath(rp, "../dev/scripts");
    if (isValidDevScriptsDir(sibling)) return { path: sibling, source: "sibling" };
  }

  const cwdRoot = resolvePath(cwd, "plugins/dev/scripts");
  if (isValidDevScriptsDir(cwdRoot)) return { path: cwdRoot, source: "cwd" };

  const marketplace = newestDevScriptsDir(
    expandStarGlob(join(home, ".claude/plugins/marketplaces/*/plugins/dev/scripts")),
  );
  if (marketplace) return { path: marketplace, source: "marketplace" };

  const cache = newestDevScriptsDir(
    expandStarGlob(join(home, ".claude/plugins/cache/*/catalyst-dev/*/scripts")),
  );
  if (cache) return { path: cache, source: "cache" };

  // eslint-disable-next-line no-console -- deliberate LOUD-on-miss stderr line, mirrors require-catalyst-dev.sh
  console.error(
    "ERROR: this skill requires the 'catalyst-dev' plugin (the shared framework core).\n" +
      "       catalyst-dev provides the backing scripts this skill calls; it was not found.\n" +
      "       Fix: install/enable catalyst-dev —  claude plugin install catalyst-dev@catalyst\n" +
      "       (or export CATALYST_DEV_SCRIPTS=/path/to/catalyst-dev/scripts)",
  );
  return { path: null, source: null };
}

// catalystPluginRoot([startDir]) — Q3. Walks up from startDir (default
// process.cwd()) looking for the first ancestor containing BOTH
// `version.txt` AND `.claude-plugin/plugin.json` — the same test
// lib/catalyst-version.sh's catalyst_print_version (CTL-390) already proved
// out for the bash side. Returns the resolved absolute path, or `null` when
// no ancestor (up to and including the filesystem root) qualifies. Never
// throws.
export function catalystPluginRoot(startDir = process.cwd()) {
  let dir;
  try {
    dir = resolvePath(startDir);
  } catch {
    return null;
  }
  // CTL-1628 A2 post-merge fix: the bash twin's `cd "$__cpr_dir" 2>/dev/null`
  // fails outright on a nonexistent/non-directory startDir, producing an
  // immediate miss with no ancestor walk at all. resolvePath() only performs
  // lexical path resolution — it never touches the filesystem — so a
  // stale/mistyped startDir beneath a valid plugin used to walk UP from that
  // nonexistent path and return the valid ancestor's root, diverging from
  // the bash twin. Validate existence up front to match.
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  for (;;) {
    if (existsSync(join(dir, "version.txt")) && existsSync(join(dir, ".claude-plugin", "plugin.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// catalystRuntimeLayout([dir], [opts]) — classifies the kind of install a
// resolved catalyst-dev scripts dir (or any dir) lives in. Returns one of:
//   "source-checkout"   dir sits inside some git checkout (worktree or
//                        pristine clone) — detected via a `.git` ancestor,
//                        no `git` subprocess (zero-import-leaf contract)
//   "marketplace"        under ~/.claude/plugins/marketplaces/*/plugins/dev/scripts
//   "cache"               under ~/.claude/plugins/cache/*/catalyst-dev/*/scripts
//   "unknown"             none of the above, or dir absent/unreadable
// Always returns a string, never throws. Defaults `dir` to nothing resolved
// (callers typically pass the `.path` from a prior catalystDevScripts()
// call).
export function catalystRuntimeLayout(dir, { env = process.env } = {}) {
  if (typeof dir !== "string" || dir.length === 0) return "unknown";
  const home = typeof env.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();

  let real;
  try {
    real = statSync(dir).isDirectory() ? resolvePath(dir) : null;
  } catch {
    real = null;
  }
  if (!real) return "unknown";

  if (matchesGlobPattern(real, join(home, ".claude/plugins/marketplaces/*/plugins/dev/scripts"))) {
    return "marketplace";
  }
  if (matchesGlobPattern(real, join(home, ".claude/plugins/cache/*/catalyst-dev/*/scripts"))) {
    return "cache";
  }

  let d = real;
  for (;;) {
    if (existsSync(join(d, ".git"))) return "source-checkout";
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return "unknown";
}

// matchesGlobPattern — CTL-1628 A2 verify-round-2 parity fix: mirrors the
// bash twin's `case "$dir" in "$HOME"/.../*/plugins/dev/scripts) ... esac`
// classification exactly. Shell `case` pattern matching does NOT set
// FNM_PATHNAME, so a bare `*` matches any sequence of characters INCLUDING
// `/` — e.g. ".../marketplaces/a/b/plugins/dev/scripts" (a two-segment
// middle) classifies as "marketplace" in the bash lib. The prior
// implementation here (isUnderMarketplaceLayout/isUnderCacheLayout)
// enforced exactly one path segment per `*`, which is stricter than the
// bash lib and could classify the identical input differently across the
// twins. Translate the glob to a regex the same way, with `*` -> "any
// characters" (including `/`), so both twins agree on every input.
function matchesGlobPattern(str, pattern) {
  const escaped = pattern
    .split("*")
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(str);
}
