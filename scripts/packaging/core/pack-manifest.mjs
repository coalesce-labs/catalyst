// pack-manifest.mjs — reads and validates plugins/<name>/pack.json (CTL-1463 Phase 3).
//
// pack.json carries everything about a plugin EXCEPT its version. Release
// Please owns the version exclusively via plugin.json's `extra-files` jsonpath
// (see docs/releases.md's "Version Source of Truth" table); a `version` key
// here would be a third source of truth and would reproduce exactly the drift
// `validate-release-config.sh` Check 7 exists to prevent for marketplace.json.
// So `version` is not merely unrecognized here — it gets its own named
// rejection pointing at the real owner, because "unknown key" alone would read
// as a typo rather than a deliberate design constraint.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const KNOWN_TOP_LEVEL_KEYS = new Set(["packId", "identity", "distribution", "skills"]);
const KNOWN_IDENTITY_KEYS = new Set([
  "description",
  "author",
  "homepage",
  "repository",
  "keywords",
  "license",
  "dependencies",
  "agents",
]);
const KNOWN_DISTRIBUTION_KEYS = new Set(["claude", "codex", "agentsSkills"]);
const KNOWN_CLAUDE_DIST_KEYS = new Set(["enabled", "marketplace"]);
const KNOWN_MARKETPLACE_KEYS = new Set(["description", "category", "keywords"]);
const KNOWN_TARGET_DIST_KEYS = new Set(["enabled"]);
const KNOWN_SKILL_OVERRIDE_KEYS = new Set(["effects", "invocation", "exposure"]);
const VALID_INVOCATIONS = new Set(["explicit", "auto"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(obj, known) {
  return Object.keys(obj).filter((k) => !known.has(k));
}

/** validatePackManifest(pack) → { ok, errors } */
export function validatePackManifest(pack) {
  const errors = [];

  if (!isPlainObject(pack)) {
    return { ok: false, errors: ["pack.json must be a JSON object"] };
  }

  if ("version" in pack) {
    errors.push(
      'pack.json must not carry a "version" field — release-please is the sole version owner, via plugin.json\'s extra-files jsonpath. See docs/releases.md.'
    );
  }

  const extraTop = unknownKeys(pack, KNOWN_TOP_LEVEL_KEYS).filter((k) => k !== "version");
  if (extraTop.length > 0) {
    errors.push(`pack.json: unknown top-level key(s) ${JSON.stringify(extraTop)}`);
  }

  if (typeof pack.packId !== "string" || pack.packId.length === 0) {
    errors.push('pack.json: "packId" must be a non-empty string');
  }

  if (!isPlainObject(pack.identity)) {
    errors.push('pack.json: "identity" must be an object');
  } else {
    const extra = unknownKeys(pack.identity, KNOWN_IDENTITY_KEYS);
    if (extra.length > 0) {
      errors.push(`pack.json identity: unknown key(s) ${JSON.stringify(extra)}`);
    }
    if (typeof pack.identity.description !== "string") {
      errors.push('pack.json identity: "description" must be a string');
    }
    if (!isPlainObject(pack.identity.author)) {
      errors.push('pack.json identity: "author" must be an object');
    }
    if (typeof pack.identity.license !== "string") {
      errors.push('pack.json identity: "license" must be a string');
    }
    if (!Array.isArray(pack.identity.keywords)) {
      errors.push('pack.json identity: "keywords" must be an array');
    }
  }

  if (!isPlainObject(pack.distribution)) {
    errors.push('pack.json: "distribution" must be an object');
  } else {
    const extra = unknownKeys(pack.distribution, KNOWN_DISTRIBUTION_KEYS);
    if (extra.length > 0) {
      errors.push(`pack.json distribution: unknown key(s) ${JSON.stringify(extra)}`);
    }

    if (!isPlainObject(pack.distribution.claude)) {
      errors.push('pack.json distribution.claude: must be an object');
    } else {
      const claudeExtra = unknownKeys(pack.distribution.claude, KNOWN_CLAUDE_DIST_KEYS);
      if (claudeExtra.length > 0) {
        errors.push(`pack.json distribution.claude: unknown key(s) ${JSON.stringify(claudeExtra)}`);
      }
      if (typeof pack.distribution.claude.enabled !== "boolean") {
        errors.push('pack.json distribution.claude: "enabled" must be a boolean');
      }
      if (pack.distribution.claude.marketplace !== undefined) {
        const mp = pack.distribution.claude.marketplace;
        if (!isPlainObject(mp)) {
          errors.push('pack.json distribution.claude.marketplace: must be an object');
        } else {
          const mpExtra = unknownKeys(mp, KNOWN_MARKETPLACE_KEYS);
          if (mpExtra.length > 0) {
            errors.push(`pack.json distribution.claude.marketplace: unknown key(s) ${JSON.stringify(mpExtra)}`);
          }
        }
      }
    }

    for (const target of ["codex", "agentsSkills"]) {
      if (pack.distribution[target] === undefined) continue;
      if (!isPlainObject(pack.distribution[target])) {
        errors.push(`pack.json distribution.${target}: must be an object`);
        continue;
      }
      const extraT = unknownKeys(pack.distribution[target], KNOWN_TARGET_DIST_KEYS);
      if (extraT.length > 0) {
        errors.push(`pack.json distribution.${target}: unknown key(s) ${JSON.stringify(extraT)}`);
      }
      if (typeof pack.distribution[target].enabled !== "boolean") {
        errors.push(`pack.json distribution.${target}: "enabled" must be a boolean`);
      }
    }
  }

  if (!isPlainObject(pack.skills)) {
    errors.push('pack.json: "skills" must be an object (possibly empty)');
  } else {
    for (const [skillId, override] of Object.entries(pack.skills)) {
      const label = `pack.json skills["${skillId}"]`;
      if (!isPlainObject(override)) {
        errors.push(`${label}: must be an object`);
        continue;
      }
      const extra = unknownKeys(override, KNOWN_SKILL_OVERRIDE_KEYS);
      if (extra.length > 0) {
        errors.push(`${label}: unknown key(s) ${JSON.stringify(extra)}`);
      }
      if (!Array.isArray(override.effects)) {
        errors.push(`${label}: "effects" must be an array`);
      }
      if (typeof override.invocation !== "string" || !VALID_INVOCATIONS.has(override.invocation)) {
        errors.push(`${label}: "invocation" must be "explicit" or "auto"`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** readPackManifest(repoRoot, pluginRelPath) → parsed pack.json, or null if absent. */
export function readPackManifest(repoRoot, pluginRelPath) {
  const path = resolve(repoRoot, pluginRelPath, "pack.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}
