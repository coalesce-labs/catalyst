// contract.mjs — the RenderedPack contract (CTL-1463 Phase 1).
//
// ZERO-IMPORT LEAF — no `node:` imports even, so a bare-node CI step or a future
// non-bun runtime can load it without pulling in the rest of the packaging
// module graph. This is the ONE shape every emitter and every source provider
// (the CTL-1461 adapter seam) must agree on. See docs/architecture.md's
// "Secret Contract" / "Deployment Mode" zero-import-leaf precedent for why this
// matters: doctor-style bare-node callers must be able to import validation
// logic without dragging in a heavier module graph.
//
// Fails CLOSED throughout: an unrecognized contractVersion, a half-declared
// `neutral` classification, or an unknown top-level/skill/agent key is a hard
// error naming what was found — never a best-effort partial read, never a
// silently dropped field. A provider that returns a pack the core
// half-understands is the "success and failure byte-identical to the caller"
// shape this repo has shipped before (see AGENTS.md's verification-discipline
// memory); this module exists to make that shape structurally impossible here.

export const SUPPORTED_CONTRACT_VERSION = 1;

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "contractVersion",
  "packId",
  "sourceRoot",
  "skills",
  "agents",
  "hooks",
  "mcpServers",
]);

const KNOWN_SKILL_KEYS = new Set([
  "id",
  "name",
  "description",
  "body",
  "files",
  "neutral",
  "claudeOnly",
]);

const KNOWN_AGENT_KEYS = new Set(["id", "name", "description", "body", "claudeOnly"]);
const KNOWN_FILE_KEYS = new Set(["relPath", "bytesRef", "content"]);
const PORTABLE_FILE_DIRS = new Set(["scripts", "references", "assets"]);

const KNOWN_NEUTRAL_KEYS = new Set(["effects", "invocation", "exposure"]);

const VALID_INVOCATIONS = new Set(["explicit", "auto"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(obj, knownSet) {
  return Object.keys(obj).filter((key) => !knownSet.has(key));
}

function requireString(obj, field, label, errors) {
  if (typeof obj[field] !== "string" || obj[field].length === 0) {
    errors.push(`${label}: "${field}" must be a non-empty string`);
  }
}

function isPortableFileRelPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.includes("\\")) return false;
  if (relPath === "SKILL.md") return true;
  if (relPath.startsWith("/") || relPath.endsWith("/")) return false;
  const parts = relPath.split("/");
  if (!PORTABLE_FILE_DIRS.has(parts[0]) || parts.length < 2) return false;
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function validateFiles(files, skillLabel, errors) {
  const seen = new Set();
  files.forEach((file, index) => {
    const label = `${skillLabel}.files[${index}]`;
    if (!isPlainObject(file)) {
      errors.push(`${label}: must be an object`);
      return;
    }
    const extra = unknownKeys(file, KNOWN_FILE_KEYS);
    if (extra.length > 0) {
      errors.push(`${label}: unknown key(s) ${JSON.stringify(extra)} — every file field must be declared in the contract`);
    }
    if (!isPortableFileRelPath(file.relPath)) {
      errors.push(`${label}: ${JSON.stringify(file.relPath)} is not a portable skill file path (expected SKILL.md or a contained scripts/, references/, or assets/ path)`);
    } else if (seen.has(file.relPath)) {
      errors.push(`${label}: duplicate relPath ${JSON.stringify(file.relPath)}`);
    } else {
      seen.add(file.relPath);
    }
    if (typeof file.bytesRef !== "string" || !/^sha256:[0-9a-f]{64}$/.test(file.bytesRef)) {
      errors.push(`${label}: "bytesRef" must be a sha256:<64 lowercase hex characters> string`);
    }
    if (typeof file.content !== "string" || file.content.length === 0) {
      errors.push(`${label}: "content" must be a non-empty base64 string so emitters never re-read the source tree`);
    } else if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) {
      errors.push(`${label}: "content" must be valid canonical base64`);
    }
  });
}

function validateSkill(skill, index, errors) {
  const label = `skills[${index}]`;
  if (!isPlainObject(skill)) {
    errors.push(`${label}: must be an object`);
    return;
  }

  const extra = unknownKeys(skill, KNOWN_SKILL_KEYS);
  if (extra.length > 0) {
    errors.push(`${label}: unknown key(s) ${JSON.stringify(extra)} — every skill field must be declared in the contract`);
  }

  requireString(skill, "id", label, errors);
  requireString(skill, "name", label, errors);
  requireString(skill, "description", label, errors);
  if (typeof skill.body !== "string") {
    errors.push(`${label}: "body" must be a string`);
  }
  if (!Array.isArray(skill.files)) {
    errors.push(`${label}: "files" must be an array`);
  } else {
    validateFiles(skill.files, label, errors);
  }

  const skillId = typeof skill.id === "string" ? skill.id : `#${index}`;

  if (skill.neutral !== null && skill.neutral !== undefined) {
    if (!isPlainObject(skill.neutral)) {
      errors.push(`${label} (${skillId}): "neutral" must be null or an object`);
    } else {
      const neutralExtra = unknownKeys(skill.neutral, KNOWN_NEUTRAL_KEYS);
      if (neutralExtra.length > 0) {
        errors.push(`${label} (${skillId}): neutral has unknown key(s) ${JSON.stringify(neutralExtra)}`);
      }
      // A skill with `neutral === null` is legal — it simply cannot reach a
      // non-Claude target. A `neutral` object missing effects OR invocation is
      // an ERROR: "missing classification is an error", and a half-declaration
      // is worse than none because it reads as classified.
      if (!Array.isArray(skill.neutral.effects)) {
        errors.push(`${label} (${skillId}): neutral classification is missing "effects" — a half-declared neutral block is an error, not a partial pass`);
      }
      if (typeof skill.neutral.invocation !== "string" || !VALID_INVOCATIONS.has(skill.neutral.invocation)) {
        errors.push(`${label} (${skillId}): neutral classification is missing or has an invalid "invocation" (must be "explicit" or "auto")`);
      }
    }
  } else if (skill.neutral === undefined) {
    errors.push(`${label} (${skillId}): "neutral" must be present (null is legal; the key itself is required)`);
  }

  if (skill.claudeOnly !== undefined && !isPlainObject(skill.claudeOnly)) {
    errors.push(`${label} (${skillId}): "claudeOnly" must be an object when present`);
  }
}

function validateAgent(agent, index, errors) {
  const label = `agents[${index}]`;
  if (!isPlainObject(agent)) {
    errors.push(`${label}: must be an object`);
    return;
  }

  const extra = unknownKeys(agent, KNOWN_AGENT_KEYS);
  if (extra.length > 0) {
    errors.push(`${label}: unknown key(s) ${JSON.stringify(extra)} — every agent field must be declared in the contract`);
  }

  requireString(agent, "id", label, errors);
  requireString(agent, "name", label, errors);
  requireString(agent, "description", label, errors);
  if (typeof agent.body !== "string") {
    errors.push(`${label}: "body" must be a string`);
  }
  if (agent.claudeOnly !== undefined && !isPlainObject(agent.claudeOnly)) {
    errors.push(`${label}: "claudeOnly" must be an object when present`);
  }
}

function validateHooks(hooks, errors) {
  if (!isPlainObject(hooks)) {
    errors.push('"hooks" must be an object');
    return;
  }
  if (typeof hooks.present !== "boolean") {
    errors.push('hooks: "present" must be a boolean');
  }
  if (typeof hooks.entryCount !== "number" || !Number.isInteger(hooks.entryCount) || hooks.entryCount < 0) {
    errors.push('hooks: "entryCount" must be a non-negative integer');
  }
  if (hooks.present === false && hooks.entryCount !== 0) {
    errors.push('hooks: "entryCount" must be 0 when "present" is false');
  }
}

/**
 * validateRenderedPack(pack) → { ok, errors }
 *
 * Every rule fails CLOSED: an unrecognized contractVersion, a half-declared
 * neutral classification, or an unknown key at any level is an error, never a
 * silently-ignored field. Errors accumulate (this does not short-circuit on
 * the first failure) so a caller sees every problem in one pass.
 */
export function validateRenderedPack(pack) {
  const errors = [];

  if (!isPlainObject(pack)) {
    return { ok: false, errors: ["RenderedPack must be a JSON object"] };
  }

  if (!("contractVersion" in pack)) {
    errors.push("contractVersion is missing (expected " + SUPPORTED_CONTRACT_VERSION + ")");
  } else if (pack.contractVersion !== SUPPORTED_CONTRACT_VERSION) {
    errors.push(
      `contractVersion ${JSON.stringify(pack.contractVersion)} is not supported (this core supports ${SUPPORTED_CONTRACT_VERSION}) — never a degraded partial read, this is a hard error`
    );
    // A wrong contract version makes every other field's meaning unknown —
    // stop here rather than reporting spurious downstream errors.
    return { ok: false, errors };
  }

  const extraTop = unknownKeys(pack, KNOWN_TOP_LEVEL_KEYS);
  if (extraTop.length > 0) {
    errors.push(`unknown top-level key(s) ${JSON.stringify(extraTop)} — this is how a provider swap silently drops data`);
  }

  requireString(pack, "packId", "pack", errors);
  requireString(pack, "sourceRoot", "pack", errors);

  if (!Array.isArray(pack.skills)) {
    errors.push('"skills" must be an array');
  } else {
    pack.skills.forEach((skill, index) => validateSkill(skill, index, errors));
  }

  if (!Array.isArray(pack.agents)) {
    errors.push('"agents" must be an array');
  } else {
    pack.agents.forEach((agent, index) => validateAgent(agent, index, errors));
  }

  validateHooks(pack.hooks, errors);

  if (!("mcpServers" in pack)) {
    errors.push('"mcpServers" must be present (null is legal; the key itself is required)');
  } else if (pack.mcpServers !== null && !isPlainObject(pack.mcpServers)) {
    errors.push('"mcpServers" must be null or an object');
  }

  return { ok: errors.length === 0, errors };
}
