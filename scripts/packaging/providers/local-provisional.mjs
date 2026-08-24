// local-provisional.mjs — PROVISIONAL. The CTL-1463 adapter seam.
//
// Replaced wholesale by CTL-1461's render interface. Nothing outside cli.mjs
// may import this module — enforced by
// scripts/packaging/__tests__/packaging-seam.test.mjs's
// countProviderImporters() check. This is the ONE module CTL-1461 swaps out;
// everything downstream (core/, emitters/) only ever sees the RenderedPack
// this returns, never plugins/*/ directly.
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

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";

import { SUPPORTED_CONTRACT_VERSION } from "../core/contract.mjs";

// NOTE on `version`: the RenderedPack contract (Phase 1, already shipped) has
// no per-skill/per-agent version slot — the plugin's own version is owned
// exclusively by release-please via plugin.json (see docs/releases.md). A
// SKILL.md/agent `version: 1.0.0` field is decorative per-file metadata, not
// a portable identity field, so it is classified Claude-only here (and
// Phase 3's loss table drops it as cosmetic, same bucket as `model`/`color`)
// rather than added to the contract as a second, competing version source.
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
// scripts/references/assets — never the whole skill directory. A skill's own
// `__tests__/` fixtures (e.g. plugins/foundry/skills/setup-catalyst/__tests__/)
// are Claude-repo-internal test tooling, not distributable skill content;
// including them silently would ship test scripts into a non-Claude target's
// bundle.
const PORTABLE_FILE_DIRS = new Set(["scripts", "references", "assets"]);

function isPortableSkillFile(relPath) {
  if (relPath === "SKILL.md") return true;
  const topDir = relPath.split("/")[0];
  return PORTABLE_FILE_DIRS.has(topDir);
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
        `local-provisional: ${fileLabel} has an unrecognized frontmatter key "${key}" — every key must be classified as portable or Claude-only, never silently passed through`
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

function renderSkill(pluginAbsPath, skillDirName, neutralOverride) {
  const skillDir = join(pluginAbsPath, "skills", skillDirName);
  const skillMdPath = join(skillDir, "SKILL.md");
  const contents = readFileSync(skillMdPath, "utf8");
  const split = splitFrontmatter(contents);
  if (!split) {
    throw new Error(`local-provisional: ${skillMdPath} has no frontmatter block`);
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
    neutral: neutralOverride ?? null,
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
 * renderPluginPack({ repoRoot, pluginRelPath, packId, skillNeutralOverrides }) → RenderedPack
 *
 * `skillNeutralOverrides` is the pack manifest's per-skill opt-in block
 * (Phase 3's `pack.json` "skills" object, keyed by skill directory name) —
 * the ONE field whose SOURCE moves when CTL-1461 lands (to
 * agents/portability.yaml sidecars). Everything else here is read straight
 * off disk.
 */
export function renderPluginPack({ repoRoot, pluginRelPath, packId, skillNeutralOverrides = {} }) {
  const pluginAbsPath = join(repoRoot, pluginRelPath);

  const skills = listSkillDirNames(pluginAbsPath).map((name) =>
    renderSkill(pluginAbsPath, name, skillNeutralOverrides[name] ?? null)
  );
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

/** listPluginRelPaths(repoRoot) → the 10 plugin directories (provenance helper, not part of the contract). */
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
