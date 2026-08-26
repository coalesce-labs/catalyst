// inventory-guard.mjs — CTL-1461 Phase 7: the deletion-order-independence
// source-scan guard.
//
// Same idiom as seam-guard.mjs (and the entitlement-caller ban /
// event-name-read-guard.mjs cited in docs/architecture.md): a structural
// invariant enforced by scanning source TEXT, not by convention. Production
// packaging code, the CI gate, and this ticket's docs must never assume
// Catalyst's specific inventory — a hardcoded plugin count, plugin list, or
// real skill identifier is exactly what the CTL-2218 cut (114 → 38 skills,
// 10 → 4 plugins) would falsify the moment it lands.
//
// Deliberately EXCLUDES __tests__/: existing tests illustrate real behavior
// against real skills on purpose (e.g. one packaging test asserts that a
// specific catalyst-dev skill is omitted because its pack has hooks) — a
// test failing loudly when the skill it names is deleted is a normal,
// VISIBLE maintenance cost someone fixes, not the silent-breakage failure
// mode this guard exists to catch in code nothing exercises until a real
// deletion happens for real.
//
// A scan over a directory/file that does not exist returns zero hits and
// reads as a pass — the false-clean shape AGENTS.md's verification-discipline
// rule warns about — so callers must assert filesScanned > 0 before trusting
// an empty violations array.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

/** The only skill identifiers this ticket's own code may name — the three sidecar-bearing skills, all REWRITE-keep in the CTL-2218 audit. */
export const ALLOWLISTED_SKILL_IDENTIFIERS = Object.freeze([
  "catalyst-dev/linearis",
  "catalyst-foundry/setup-catalyst",
  "catalyst-meta/validate-frontmatter",
]);

const REAL_PLUGIN_IDS = Object.freeze([
  "catalyst-dev",
  "catalyst-foundry",
  "catalyst-legacy",
  "catalyst-meta",
  "catalyst-pm-ops",
]);

const SKILL_IDENTIFIER_PATTERN = /\bcatalyst-[a-z-]+\/[a-z][a-z0-9-]*\b/g;
const HARDCODED_SKILL_COUNT_PATTERN = /\b114\s+skills?\b|\btotal ?skills[=:]\s*114\b|\bskills[=:]\s*114\b/i;
const HARDCODED_PLUGIN_COUNT_PATTERN = /\b10\s+plugins?\b|\bplugins[=:]\s*10\b/i;

const DEFAULT_SCANNABLE_EXTENSIONS = new Set([".mjs", ".yml", ".yaml", ".md"]);

function listScannableFiles(root, excludeDirNames) {
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
      if (!excludeDirNames.has(entry)) files.push(...listScannableFiles(full, excludeDirNames));
    } else if (DEFAULT_SCANNABLE_EXTENSIONS.has(extname(entry))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * scanForInventoryAssumptions({ paths, repoRoot, excludeDirNames }) →
 * { filesScanned, violations }
 *
 * `paths` are file or directory paths relative to `repoRoot` (files are
 * scanned directly; directories are walked recursively, skipping
 * `excludeDirNames`). A violation is one of:
 *   - `hardcoded-skill-count`  — a literal total-skill-count, N immediately
 *     adjacent to the word "skill(s)" (see HARDCODED_SKILL_COUNT_PATTERN)
 *   - `hardcoded-plugin-count` — the same shape for a plugin count
 *   - `hardcoded-plugin-list`  — 3+ distinct real plugin ids on one line
 *   - `real-skill-identifier`  — a pack-qualified skill id outside the allowlist
 */
export function scanForInventoryAssumptions({ paths, repoRoot, excludeDirNames = ["__tests__", "dist", "fixtures"] }) {
  const violations = [];
  let filesScanned = 0;
  const excludeSet = new Set(excludeDirNames);

  const files = [];
  for (const rel of paths) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      files.push(...listScannableFiles(abs, excludeSet));
    } else {
      files.push(abs);
    }
  }

  for (const file of files) {
    filesScanned += 1;
    const contents = readFileSync(file, "utf8");
    const lines = contents.split("\n");
    lines.forEach((line, idx) => {
      if (HARDCODED_SKILL_COUNT_PATTERN.test(line)) {
        violations.push({ file, line: idx + 1, kind: "hardcoded-skill-count", text: line.trim() });
      }
      if (HARDCODED_PLUGIN_COUNT_PATTERN.test(line)) {
        violations.push({ file, line: idx + 1, kind: "hardcoded-plugin-count", text: line.trim() });
      }

      const pluginHits = new Set(REAL_PLUGIN_IDS.filter((id) => line.includes(id)));
      if (pluginHits.size >= 3) {
        violations.push({ file, line: idx + 1, kind: "hardcoded-plugin-list", text: line.trim() });
      }

      for (const match of line.matchAll(SKILL_IDENTIFIER_PATTERN)) {
        if (!ALLOWLISTED_SKILL_IDENTIFIERS.includes(match[0])) {
          violations.push({ file, line: idx + 1, kind: "real-skill-identifier", text: match[0] });
        }
      }
    });
  }

  return { filesScanned, violations };
}
