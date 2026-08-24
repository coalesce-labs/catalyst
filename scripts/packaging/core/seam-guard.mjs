// seam-guard.mjs — the CTL-1461 adapter-seam source-scan guard (CTL-1463 Phase 1).
//
// Same idiom as the entitlement-caller ban (`getClusterHosts()`) and
// `event-name-read-guard.mjs` cited in docs/architecture.md: a structural
// invariant enforced by scanning source text, not by convention. The core
// (`core/`, `emitters/`) must never read `plugins/*/` directly and must never
// import a provider module — the ONLY module CTL-1461 replaces is
// `providers/local-provisional.mjs`, and the core has to stay ignorant of it
// for that swap to be mechanical.
//
// A scan over a directory that does not exist yet returns zero hits and reads
// as a pass — that is the exact false-clean shape this repo has been burned by
// before (see AGENTS.md's "Reporting a negative" rule). `scanForSeamViolations`
// therefore reports `filesScanned` alongside `violations`, and callers must
// assert `filesScanned > 0` before trusting an empty `violations` array.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Deliberately narrow to actual import/require statements, and to quoted
// (', ") string literals only — never backtick, since this codebase's prose
// comments routinely wrap paths in markdown-style backticks (`plugins/dev`)
// that are not code and must not trip the guard. A broader "any mention of
// the substring providers/" match would flag this very file's own comments
// explaining the seam.
const PROVIDERS_REFERENCE = /(?:\bfrom\s+|\brequire\(\s*)['"][^'"]*\bproviders\/[^'"]*['"]/;
const PLUGINS_PATH_LITERAL = /(['"])plugins\/[^'"]*\1/;

function listFilesRecursive(root) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listFilesRecursive(full));
    } else if (entry.endsWith(".mjs")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * scanForSeamViolations({ roots, repoRoot }) → { filesScanned, violations }
 *
 * `roots` are directories relative to `repoRoot` (e.g. ["scripts/packaging/core",
 * "scripts/packaging/emitters"]). A violation is either:
 *   - a `providers/` substring (a provider import), or
 *   - a quoted `plugins/...` path literal (reading the filesystem outside a
 *     passed-in root).
 */
export function scanForSeamViolations({ roots, repoRoot }) {
  const violations = [];
  let filesScanned = 0;

  for (const rel of roots) {
    const absRoot = join(repoRoot, rel);
    for (const file of listFilesRecursive(absRoot)) {
      filesScanned += 1;
      const contents = readFileSync(file, "utf8");
      const lines = contents.split("\n");
      lines.forEach((line, idx) => {
        if (PROVIDERS_REFERENCE.test(line)) {
          violations.push({ file, line: idx + 1, kind: "providers-import", text: line.trim() });
        }
        if (PLUGINS_PATH_LITERAL.test(line)) {
          violations.push({ file, line: idx + 1, kind: "plugins-path-literal", text: line.trim() });
        }
      });
    }
  }

  return { filesScanned, violations };
}

/**
 * countProviderImporters({ repoRoot, packagingRoot, providerRelPath }) → { count, files }
 *
 * Counts every `.mjs` file under `packagingRoot` (recursively, excluding the
 * provider file itself) whose source imports `providerRelPath`'s basename via a
 * `providers/` reference. Used to assert "imported by exactly one file
 * (cli.mjs)" — a provider a second file starts importing is the seam quietly
 * widening.
 */
export function countProviderImporters({ repoRoot, packagingRoot, providerBasename }) {
  const absRoot = join(repoRoot, packagingRoot);
  const files = listFilesRecursive(absRoot).filter((f) => !f.endsWith(`/${providerBasename}`));
  const importers = [];
  const pattern = new RegExp(`providers/${providerBasename.replace(/\./g, "\\.")}`);
  for (const file of files) {
    const contents = readFileSync(file, "utf8");
    if (pattern.test(contents)) {
      importers.push(file);
    }
  }
  return { count: importers.length, files: importers };
}
