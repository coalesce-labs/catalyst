// local.mjs — the real render interface (CTL-1461 Phase 1).
//
// The CTL-1461 adapter seam. Nothing outside cli.mjs may import this module —
// enforced by scripts/packaging/__tests__/packaging-seam.test.mjs's
// countProviderImporters() check. This is the ONE module CTL-1461 replaces
// (it was providers/local-provisional.mjs); everything downstream (core/,
// emitters/) only ever sees the RenderedPack this returns, never plugins/*/
// directly.
//
// Real YAML, not a regex. The ratified design names "YAML structures are
// flattened or corrupted" as a risk whose mitigation IS a real parser —
// Bun.YAML.parse (bun@1.3.5, no new dependency) — so a regex frontmatter
// reader would reproduce the exact defect this module exists to avoid.
//
// Any frontmatter key this reader does not recognize is a hard error naming
// the file and the key — not a silent pass-through. `model:`/`color:` on a
// SKILL.md are already real drift from docs/frontmatter-standard.md; an
// unknown-key error is what surfaces the NEXT drift instead of laundering it.
//
// The one thing that changed from the provisional adapter: `neutral` is read
// from `<skillDir>/agents/portability.yaml`, not from an injected
// `skillNeutralOverrides` parameter (pack.json's now-deleted `skills` block).
// Everything else is carried over verbatim — this is a pure relocation, not a
// schema change (see the plan's "relocation-identity" test).

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";

import { SUPPORTED_CONTRACT_VERSION } from "../core/contract.mjs";
import { validateNeutralDeclaration } from "../core/neutral-schema.mjs";

// NOTE on `version`: the RenderedPack contract has no per-skill/per-agent
// version slot — the plugin's own version is owned exclusively by
// release-please via plugin.json (see docs/releases.md). A SKILL.md/agent
// `version: 1.0.0` field is decorative per-file metadata, not a portable
// identity field, so it is classified Claude-only here (and the loss table
// drops it as cosmetic, same bucket as `model`/`color`) rather than added to
// the contract as a second, competing version source.
const SKILL_PORTABLE_KEYS = new Set(["name", "description"]);
const SKILL_CLAUDE_ONLY_KEYS = new Set([
  "allowed-tools",
  "disable-model-invocation",
  "user-invocable",
  "argument-hint",
  "modifies-workspace",
  "version",
]);

const AGENT_PORTABLE_KEYS = new Set(["name", "description"]);
const AGENT_CLAUDE_ONLY_KEYS = new Set(["tools", "model", "color", "version"]);

/** Splits `---\n<yaml>\n---\n<body>` into { yamlText, body }, or null if the file has no frontmatter block. */
export function splitFrontmatter(contents) {
  const lines = contents.split("\n");
  if (lines[0] !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  return {
    yamlText: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
}

function sha256(buf) {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

function listFilesRecursive(absDir) {
  const out = [];
  for (const entry of readdirSync(absDir)) {
    const full = join(absDir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

// The portable file surface named by the plan is exactly SKILL.md plus
// scripts/references/assets — never the whole skill directory, and
// deliberately never `agents/` (the sidecar directory this module reads
// portability.yaml from). A skill's own `__tests__/` fixtures (e.g.
// plugins/foundry/skills/setup-catalyst/__tests__/) are Claude-repo-internal
// test tooling, not distributable skill content; including them silently
// would ship test scripts into a non-Claude target's bundle. This exclusion
// set is asserted by a dedicated test (local-provider.test.mjs) with a
// mutation control that injects a widened set into `isPortableSkillFile`
// directly — it is load-bearing (a portability.yaml copied into a generated
// bundle alongside the emitter's own openai.yaml would be confusing at best)
// and one edit away from silently breaking.
export const PORTABLE_FILE_DIRS = new Set(["scripts", "references", "assets"]);

/** isPortableSkillFile(relPath, portableDirs?) — exported so a test can inject a mutated `portableDirs` and observe real behavior change, not just assert the constant's contents. */
export function isPortableSkillFile(relPath, portableDirs = PORTABLE_FILE_DIRS) {
  if (relPath === "SKILL.md") return true;
  const topDir = relPath.split("/")[0];
  return portableDirs.has(topDir);
}

function readFilesManifest(absSkillDir) {
  if (!existsSync(absSkillDir)) return [];
  return listFilesRecursive(absSkillDir)
    .filter((abs) => isPortableSkillFile(relative(absSkillDir, abs).split(sep).join("/")))
    .map((abs) => {
      const bytes = readFileSync(abs);
      return {
        relPath: relative(absSkillDir, abs).split(sep).join("/"),
        bytesRef: sha256(bytes),
        // Base64 content, not just the hash: emitters must never read
        // plugins/*/ directly (the seam guard), so a byte-copying emitter
        // (agents-skills.mjs) needs the actual bytes carried IN the
        // RenderedPack, not a pointer it would have to resolve by reading
        // the source tree again.
        content: bytes.toString("base64"),
      };
    })
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function splitFrontmatterKeys(parsed, portableKeys, claudeOnlyKeys, fileLabel) {
  const portable = {};
  const claudeOnly = {};
  for (const [key, value] of Object.entries(parsed ?? {})) {
    if (portableKeys.has(key)) {
      portable[key] = value;
    } else if (claudeOnlyKeys.has(key)) {
      claudeOnly[key] = value;
    } else {
      throw new Error(
        `local: ${fileLabel} has an unrecognized frontmatter key "${key}" — every key must be classified as portable or Claude-only, never silently passed through`
      );
    }
  }
  return { portable, claudeOnly };
}

function listSkillDirNames(pluginAbsPath) {
  const skillsDir = join(pluginAbsPath, "skills");
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((name) => statSync(join(skillsDir, name)).isDirectory())
    .filter((name) => existsSync(join(skillsDir, name, "SKILL.md")))
    .sort();
}

/**
 * readNeutralDeclaration(skillDir, skillMdPath) → the parsed, validated
 * `agents/portability.yaml` object, or null if the sidecar does not exist.
 * `neutral: null` is legal (the skill simply cannot reach a non-Claude
 * target); a PRESENT sidecar that is malformed YAML or fails schema
 * validation is a hard error naming the sidecar file.
 */
function readNeutralDeclaration(skillDir, skillMdPath) {
  const sidecarPath = join(skillDir, "agents", "portability.yaml");
  if (!existsSync(sidecarPath)) return null;

  const contents = readFileSync(sidecarPath, "utf8");
  let parsed;
  try {
    parsed = Bun.YAML.parse(contents);
  } catch (err) {
    throw new Error(`local: ${sidecarPath} (sidecar for ${skillMdPath}) is not valid YAML: ${err.message}`);
  }
  validateNeutralDeclaration(parsed, sidecarPath);
  return parsed;
}

function renderSkill(pluginAbsPath, skillDirName) {
  const skillDir = join(pluginAbsPath, "skills", skillDirName);
  const skillMdPath = join(skillDir, "SKILL.md");
  const contents = readFileSync(skillMdPath, "utf8");
  const split = splitFrontmatter(contents);
  if (!split) {
    throw new Error(`local: ${skillMdPath} has no frontmatter block`);
  }
  const parsed = Bun.YAML.parse(split.yamlText);
  const { portable, claudeOnly } = splitFrontmatterKeys(
    parsed,
    SKILL_PORTABLE_KEYS,
    SKILL_CLAUDE_ONLY_KEYS,
    skillMdPath
  );

  return {
    id: skillDirName,
    name: portable.name ?? skillDirName,
    description: portable.description ?? "",
    body: split.body,
    files: readFilesManifest(skillDir),
    neutral: readNeutralDeclaration(skillDir, skillMdPath),
    claudeOnly,
  };
}

function listAgentFileNames(pluginAbsPath) {
  const agentsDir = join(pluginAbsPath, "agents");
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => splitFrontmatter(readFileSync(join(agentsDir, name), "utf8")) !== null)
    .sort();
}

function renderAgent(pluginAbsPath, fileName) {
  const agentPath = join(pluginAbsPath, "agents", fileName);
  const contents = readFileSync(agentPath, "utf8");
  const split = splitFrontmatter(contents);
  const parsed = Bun.YAML.parse(split.yamlText);
  const { portable, claudeOnly } = splitFrontmatterKeys(
    parsed,
    AGENT_PORTABLE_KEYS,
    AGENT_CLAUDE_ONLY_KEYS,
    agentPath
  );
  const id = fileName.replace(/\.md$/, "");

  return {
    id,
    name: portable.name ?? id,
    description: portable.description ?? "",
    body: split.body,
    claudeOnly,
  };
}

function readHooksManifest(pluginAbsPath) {
  const hooksPath = join(pluginAbsPath, "hooks.toml");
  if (!existsSync(hooksPath)) {
    return { present: false, entryCount: 0 };
  }
  const contents = readFileSync(hooksPath, "utf8");
  const entryCount = (contents.match(/^\[\[hooks\]\]/gm) ?? []).length;
  return { present: true, entryCount };
}

function readMcpServers(pluginAbsPath) {
  const mcpPath = join(pluginAbsPath, ".mcp.json");
  if (!existsSync(mcpPath)) return null;
  return JSON.parse(readFileSync(mcpPath, "utf8"));
}

/**
 * renderPluginPack({ repoRoot, pluginRelPath, packId }) → RenderedPack
 *
 * Everything is read straight off disk — a skill's neutral classification
 * comes from its own `agents/portability.yaml` sidecar (or `null` if absent),
 * never from a caller-supplied override.
 */
export function renderPluginPack({ repoRoot, pluginRelPath, packId }) {
  const pluginAbsPath = join(repoRoot, pluginRelPath);

  const skills = listSkillDirNames(pluginAbsPath).map((name) => renderSkill(pluginAbsPath, name));
  const agents = listAgentFileNames(pluginAbsPath).map((name) => renderAgent(pluginAbsPath, name));

  return {
    contractVersion: SUPPORTED_CONTRACT_VERSION,
    packId,
    sourceRoot: pluginRelPath,
    skills,
    agents,
    hooks: readHooksManifest(pluginAbsPath),
    mcpServers: readMcpServers(pluginAbsPath),
  };
}

/** listPluginRelPaths(repoRoot) → the plugin directories (provenance helper, not part of the contract). */
export function listPluginRelPaths(repoRoot) {
  const roots = [];
  const topDir = join(repoRoot, "plugins");
  for (const name of readdirSync(topDir).sort()) {
    const abs = join(topDir, name);
    if (!statSync(abs).isDirectory()) continue;
    if (name === "playground") {
      const playgroundDir = abs;
      for (const sub of readdirSync(playgroundDir).sort()) {
        const subAbs = join(playgroundDir, sub);
        if (statSync(subAbs).isDirectory() && existsSync(join(subAbs, ".claude-plugin", "plugin.json"))) {
          roots.push(`plugins/playground/${sub}`);
        }
      }
    } else if (existsSync(join(abs, ".claude-plugin", "plugin.json"))) {
      roots.push(`plugins/${name}`);
    }
  }
  return roots.sort();
}
