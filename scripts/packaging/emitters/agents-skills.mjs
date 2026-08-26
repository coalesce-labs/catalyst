// agents-skills.mjs — the .agents/skills bundle emitter (CTL-1463 Phase 4).
//
// Emits `.agents/skills/<pack>-<skill>/` for every skill whose pack.json
// declares a neutral classification (`skill.neutral !== null` — the safety
// gate from core/loss.mjs; an unclassified skill is never reached here, it
// was already omitted upstream). Per the CTL-1536 finding cited in the plan:
// Codex reads exactly `name` + `description` from SKILL.md frontmatter, so
// that is ALL this emitter writes — no Claude-only key ever reaches this
// target, by construction (it is never read from `skill.claudeOnly`).
//
// Flat-target naming is pack-qualified (`catalyst-dev-linearis`) per the
// ratified composition rules. A collision is a HARD ERROR naming both
// sources — never resolved by source order, because silently picking one
// would make the other vanish with no signal.
//
// Auxiliary files (scripts/, references/, assets/) are copied byte-for-byte
// from the RenderedPack's `files[]` entries (never re-read from plugins/*/ —
// the seam forbids that here; the provider already carried the bytes).
// SKILL.md itself is excluded from that copy — this emitter builds a FRESH
// SKILL.md from the portable `name`/`description`/`body` fields, since the
// original file's frontmatter carries Claude-only keys.
//
// CTL-1461 Phase 2: every emitted skill also gets a sibling
// `agents/openai.yaml` carrying ONLY `policy.allow_implicit_invocation`,
// derived from `neutral.invocation` — zero new authored data, the one field
// in catalyst-cloud's real per-skill sidecar that carries safety rather than
// presentation. `agents/` here is EMITTED output (this emitter's own
// namespace), distinct from the skill source directory's `agents/` sidecar
// (providers/local.mjs's portability.yaml, which Phase 1 keeps out of
// `files[]` entirely) — the two must not be conflated.

import { formatJson } from "../core/json-format.mjs";
import { classifySkillEmission } from "../core/safety-gate.mjs";
import { createHash } from "node:crypto";

const PORTABLE_AUX_DIRS = new Set(["scripts", "references", "assets"]);

/** GENERATED_MARKER_FILENAME — the per-skill marker cli.mjs's stale-prune pass keys off of; exported so both sides never drift on the literal. */
export const GENERATED_MARKER_FILENAME = ".generated-by-catalyst-packaging";

function assertSafeSegment(value, label) {
  if (typeof value !== "string" || value.length === 0 || value === "." || value === ".." || /[\\/]/.test(value)) {
    throw new Error(`agents-skills emitter: ${label} ${JSON.stringify(value)} is not a safe path segment`);
  }
}

function assertPortableAuxRelPath(relPath) {
  const parts = typeof relPath === "string" ? relPath.split("/") : [];
  const valid =
    parts.length >= 2 &&
    PORTABLE_AUX_DIRS.has(parts[0]) &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..") &&
    !relPath.includes("\\");
  if (!valid) {
    throw new Error(`agents-skills emitter: ${JSON.stringify(relPath)} is not a contained portable auxiliary path`);
  }
}

function sourceHash(skill) {
  const sourceIndex = [...skill.files]
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
    .map((file) => `${file.relPath}\0${file.bytesRef}`)
    .join("\n");
  return `sha256:${createHash("sha256").update(sourceIndex).digest("hex")}`;
}

export function flatSkillName(packId, skillId) {
  assertSafeSegment(packId, "packId");
  assertSafeSegment(skillId, "skillId");
  return `${packId}-${skillId}`;
}

function yamlDoubleQuote(str) {
  return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** buildSkillMd(skill) → the portable SKILL.md text: name + description frontmatter, prose body verbatim. */
export function buildSkillMd(skill) {
  const frontmatter = `---\nname: ${skill.name}\ndescription: ${yamlDoubleQuote(skill.description)}\n---\n`;
  return frontmatter + skill.body;
}

/** buildOpenaiYaml(skill) → the flat bundle's per-skill `agents/openai.yaml` — the one field that carries safety (not presentation), derived from `neutral.invocation`. Zero new authored data. */
export function buildOpenaiYaml(skill) {
  const allowImplicitInvocation = skill.neutral.invocation !== "explicit";
  return `---\npolicy:\n  allow_implicit_invocation: ${allowImplicitInvocation}\n`;
}

/**
 * planAgentsSkillsBundle(entries) → { files, collisions }
 *
 * `entries` is [{ packId, pack }, ...]. `files` is
 * [{ flatName, relPath, text? , base64? }] — `relPath` is relative to
 * `.agents/skills/`. Throws on any flat-name collision, naming both sources.
 *
 * Emit/omit is delegated to the SAME `classifySkillEmission` the loss report
 * uses (targetName "agentsSkills") — never a hand-rolled subset of that
 * decision — so this writer and the loss report can never disagree about
 * which skills actually land in the bundle.
 */
export function planAgentsSkillsBundle(entries) {
  const seen = new Map(); // flatName -> "packId/skillId"
  const files = [];

  for (const { packId, pack } of entries) {
    for (const skill of pack.skills) {
      if (!classifySkillEmission(skill, pack.hooks, "agentsSkills").emit) continue;

      const flatName = flatSkillName(packId, skill.id);
      const sourceLabel = `${packId}/${skill.id}`;
      if (seen.has(flatName)) {
        throw new Error(
          `agents-skills emitter: flat name collision "${flatName}" between ${seen.get(flatName)} and ${sourceLabel} — never resolved by source order, this must fail the build`
        );
      }
      seen.set(flatName, sourceLabel);

      files.push({ flatName, relPath: `${flatName}/SKILL.md`, text: buildSkillMd(skill) });
      files.push({ flatName, relPath: `${flatName}/agents/openai.yaml`, text: buildOpenaiYaml(skill) });

      for (const f of skill.files) {
        if (f.relPath === "SKILL.md") continue; // regenerated above, never copied verbatim
        assertPortableAuxRelPath(f.relPath);
        files.push({ flatName, relPath: `${flatName}/${f.relPath}`, base64: f.content, sourceRelPath: f.relPath });
      }

      files.push({
        flatName,
        relPath: `${flatName}/${GENERATED_MARKER_FILENAME}`,
        text:
          formatJson(
            {
              generatedBy: "catalyst-packaging",
              pack: packId,
              skill: skill.id,
              sourceFileCount: skill.files.length,
              sourceHash: sourceHash(skill),
            },
            { escapeNonAscii: false }
          ) + "\n",
      });
    }
  }

  return { files, emittedFlatNames: [...seen.keys()].sort() };
}
