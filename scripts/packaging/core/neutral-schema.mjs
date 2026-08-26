// neutral-schema.mjs — the closed-vocabulary schema for a skill's neutral
// (cross-vendor) classification (CTL-1461 Phase 1).
//
// ZERO-IMPORT LEAF — same precedent as contract.mjs: a bare-node caller must
// be able to validate a sidecar (agents/portability.yaml) without pulling in
// the rest of the packaging module graph.
//
// The shape is exactly what pack.json's per-skill `skills` block carried
// before this ticket relocated it — effects, invocation, exposure — not a
// new schema. Every rule fails CLOSED and every error names the file, the
// key, and the accepted set: an unrecognized value is a hard error, never a
// silent typo pass-through (the same discipline splitFrontmatterKeys already
// applies to frontmatter keys).

export const EFFECTS = Object.freeze(["file-read", "file-write", "shell-exec", "network"]);

// The pair that drives the invocation-parity rule (Phase 2): a mutating
// effect requires explicit-only invocation in both vendor vocabularies.
// `network` is deliberately excluded — a read-only fetch is not a mutation.
export const MUTATING_EFFECTS = Object.freeze(["file-write", "shell-exec"]);

export const EXPOSURES = Object.freeze(["catalog", "internal"]);
export const INVOCATIONS = Object.freeze(["explicit", "auto"]);

const EFFECTS_SET = new Set(EFFECTS);
const EXPOSURES_SET = new Set(EXPOSURES);
const INVOCATIONS_SET = new Set(INVOCATIONS);
const KNOWN_KEYS = new Set(["effects", "invocation", "exposure"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * validateNeutralDeclaration(decl, label) → throws on the first violation
 * found, naming `label` (typically the sidecar file path), the offending
 * key/value, and the accepted set. Returns undefined on success.
 */
export function validateNeutralDeclaration(decl, label) {
  if (!isPlainObject(decl)) {
    throw new Error(`${label}: neutral declaration must be an object`);
  }

  const extra = Object.keys(decl).filter((key) => !KNOWN_KEYS.has(key));
  if (extra.length > 0) {
    throw new Error(
      `${label}: unknown key(s) ${JSON.stringify(extra)} — accepted keys are ${JSON.stringify([...KNOWN_KEYS])}`
    );
  }

  if (!Array.isArray(decl.effects)) {
    throw new Error(`${label}: "effects" is missing or not an array`);
  }
  for (const effect of decl.effects) {
    if (!EFFECTS_SET.has(effect)) {
      throw new Error(
        `${label}: "effects" contains ${JSON.stringify(effect)}, not in the accepted set ${JSON.stringify(EFFECTS)}`
      );
    }
  }

  if (typeof decl.invocation !== "string" || !INVOCATIONS_SET.has(decl.invocation)) {
    throw new Error(`${label}: "invocation" is missing or invalid — must be one of ${JSON.stringify(INVOCATIONS)}`);
  }

  if (!Array.isArray(decl.exposure) || decl.exposure.length === 0) {
    throw new Error(`${label}: "exposure" is missing or empty — must be a non-empty array`);
  }
  for (const exposure of decl.exposure) {
    if (!EXPOSURES_SET.has(exposure)) {
      throw new Error(
        `${label}: "exposure" contains ${JSON.stringify(exposure)}, not in the accepted set ${JSON.stringify(EXPOSURES)}`
      );
    }
  }
}
