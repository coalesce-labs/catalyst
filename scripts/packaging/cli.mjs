#!/usr/bin/env bun
// cli.mjs — the packaging pipeline entrypoint (CTL-1463).
//
// The ONE file outside providers/local.mjs itself that may import it —
// enforced by packaging-seam.test.mjs's countProviderImporters() check.
// Subcommands grow phase by phase: Phase 2 ships `render --dry-run` (a census,
// no writes); Phase 3 adds loss reporting; Phase 4 adds `--target`/`--write`;
// Phase 6 adds `extraction-readiness`.

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { validateRenderedPack } from "./core/contract.mjs";
import { readPackManifest } from "./core/pack-manifest.mjs";
import { renderPluginPack, listPluginRelPaths } from "./providers/local.mjs";
import { buildLossReport, hasUnacknowledgedLosses, lossCounts, renderLossReportMarkdown } from "./core/loss.mjs";
import { checkInvocationParity } from "./core/safety-gate.mjs";
import { renderPluginJson, renderMarketplaceJson, readExistingVersion } from "./emitters/claude.mjs";
import {
  resolveCodexVersion,
  renderCodexPluginJson,
  renderCodexCatalog,
  renderCodexGeneratedMarker,
  GENERATED_MARKER_FILENAME as CODEX_GENERATED_MARKER_FILENAME,
} from "./emitters/codex.mjs";
import { planAgentsSkillsBundle, GENERATED_MARKER_FILENAME } from "./emitters/agents-skills.mjs";
import { checkExtractionReadiness } from "./core/extraction-readiness.mjs";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const NON_CLAUDE_TARGETS = ["codex", "agentsSkills"];

function readPackId(repoRootPath, pluginRelPath) {
  const plugin = JSON.parse(
    readFileSync(resolve(repoRootPath, pluginRelPath, ".claude-plugin/plugin.json"), "utf8")
  );
  return plugin.name;
}

/** readConfigPackageOrder(repoRootPath) → plugin rel-paths in release-please-config.json's declared order. */
export function readConfigPackageOrder(repoRootPath) {
  const config = JSON.parse(readFileSync(resolve(repoRootPath, "release-please-config.json"), "utf8"));
  return Object.keys(config.packages);
}

/**
 * renderAllPacks(repoRootPath) → [{ pluginRelPath, packId, pack, packManifest, validation }]
 *
 * Renders every real plugin directory through the real provider and
 * validates each against the contract. Never writes anything to disk.
 *
 * The invocation-parity check runs here, unconditionally, for every skill in
 * every pack — it is a hard error at render time (throws), never a warning:
 * the whole point of the rule is that the neutral and Claude vocabularies
 * must not be allowed to disagree about whether a mutating skill is
 * explicit-invocation-only.
 */
export function renderAllPacks(repoRootPath = repoRoot) {
  return listPluginRelPaths(repoRootPath).map((pluginRelPath) => {
    const packId = readPackId(repoRootPath, pluginRelPath);
    const pack = renderPluginPack({ repoRoot: repoRootPath, pluginRelPath, packId });
    for (const skill of pack.skills) {
      checkInvocationParity(skill, `${packId}/${skill.id}`);
    }
    return {
      pluginRelPath,
      packId,
      pack,
      packManifest: readPackManifest(repoRootPath, pluginRelPath),
      validation: validateRenderedPack(pack),
    };
  });
}

/** computeLossReport(results, renderedAt) → the loss report across both non-Claude targets. */
export function computeLossReport(results, renderedAt) {
  const packs = results.map(({ packId, pack }) => ({ packId, pack }));
  return buildLossReport({ packs, targetNames: NON_CLAUDE_TARGETS, renderedAt });
}

function writeLossReportArtifacts(repoRootPath, report) {
  const distDir = resolve(repoRootPath, "scripts/packaging/dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(resolve(distDir, "loss-report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(resolve(distDir, "LOSSES.md"), renderLossReportMarkdown(report) + "\n");
}

function writeFileEnsuringDir(absPath, contents) {
  mkdirSync(resolve(absPath, ".."), { recursive: true });
  writeFileSync(absPath, contents);
}

/**
 * assertPluginInventoryAgreement(order, diskRelPaths) — CTL-1461 Phase 7,
 * fixing defect 6. Throws a NAMED, actionable error the instant
 * release-please-config.json's declared plugin set and the on-disk plugin
 * set disagree, in EITHER direction — never a bare TypeError from a missing
 * map entry (a config entry with no plugin on disk), and never a silent skip
 * that drops a plugin from a catalog with no signal (a plugin on disk with
 * no config entry). This is exactly the fragility a CTL-2218 plugin deletion
 * would hit on its first commit if the config and the deletion land in
 * separate commits.
 */
export function assertPluginInventoryAgreement(order, diskRelPaths) {
  const diskSet = new Set(diskRelPaths);
  const orderSet = new Set(order);

  for (const pluginRelPath of order) {
    if (!diskSet.has(pluginRelPath)) {
      throw new Error(
        `packaging: release-please-config.json lists "${pluginRelPath}" but no plugin exists there — delete the entry or restore the plugin.`
      );
    }
  }
  for (const pluginRelPath of diskRelPaths) {
    if (!orderSet.has(pluginRelPath)) {
      throw new Error(
        `packaging: "${pluginRelPath}" has a pack.json but no release-please-config.json entry — it will be absent from both marketplace catalogs and unversioned by Release Please.`
      );
    }
  }
}

/** writeClaudeTarget(repoRootPath, results, { write }) → { pluginJsonPaths, marketplacePath } */
function writeClaudeTarget(repoRootPath, results, { write }) {
  const order = readConfigPackageOrder(repoRootPath);
  assertPluginInventoryAgreement(order, results.map((r) => r.pluginRelPath));
  const byRelPath = new Map(results.map((r) => [r.pluginRelPath, r]));
  const pluginJsonPaths = [];

  for (const pluginRelPath of order) {
    const r = byRelPath.get(pluginRelPath);
    const existingVersion = readExistingVersion(repoRootPath, pluginRelPath);
    const text = renderPluginJson(r.packManifest, existingVersion) + "\n";
    const absPath = resolve(repoRootPath, pluginRelPath, ".claude-plugin/plugin.json");
    if (write) writeFileEnsuringDir(absPath, text);
    pluginJsonPaths.push(absPath);
  }

  const entries = order.map((pluginRelPath) => ({ pluginRelPath, packManifest: byRelPath.get(pluginRelPath).packManifest }));
  const marketplaceText = renderMarketplaceJson(entries) + "\n";
  const marketplacePath = resolve(repoRootPath, ".claude-plugin/marketplace.json");
  if (write) writeFileEnsuringDir(marketplacePath, marketplaceText);

  return { pluginJsonPaths, marketplacePath };
}

/**
 * listPluginDirCandidates(repoRootPath) → every directory shaped like a
 * plugin location (`plugins/<name>` and `plugins/playground/<name>`),
 * regardless of whether it still carries a `.claude-plugin/plugin.json`.
 *
 * Deliberately NOT `listPluginRelPaths` (which requires that file to exist):
 * a plugin deleted down to a bare `.codex-plugin/` remnant (e.g. a partial
 * manual deletion, or the CTL-2218 cut landing one file at a time) must still
 * be visited by the stale-prune sweep below, or its orphan `.codex-plugin/`
 * tree lingers forever and then fails the drift gate.
 */
function listPluginDirCandidates(repoRootPath) {
  const roots = [];
  const topDir = resolve(repoRootPath, "plugins");
  if (!existsSync(topDir)) return roots;
  for (const name of readdirSync(topDir)) {
    const abs = resolve(topDir, name);
    if (!statSync(abs).isDirectory()) continue;
    if (name === "playground") {
      for (const sub of readdirSync(abs)) {
        const subAbs = resolve(abs, sub);
        if (statSync(subAbs).isDirectory()) roots.push(`plugins/playground/${sub}`);
      }
    } else {
      roots.push(`plugins/${name}`);
    }
  }
  return roots;
}

/**
 * pruneStaleCodexPluginDirs(repoRootPath, emittedPluginRelPaths) → the plugin
 * rel-paths whose `.codex-plugin/` dir was actually removed.
 *
 * Same shape as pruneStaleAgentsSkillsDirs: only removes a `.codex-plugin/`
 * dir that is BOTH absent from this render's emit plan AND carries this
 * pipeline's own GENERATED_MARKER_FILENAME — never touches a directory
 * without that marker.
 */
export function pruneStaleCodexPluginDirs(repoRootPath, emittedPluginRelPaths) {
  const emitted = new Set(emittedPluginRelPaths);
  const pruned = [];
  for (const pluginRelPath of listPluginDirCandidates(repoRootPath)) {
    if (emitted.has(pluginRelPath)) continue;
    const codexDir = resolve(repoRootPath, pluginRelPath, ".codex-plugin");
    if (!existsSync(codexDir)) continue;
    if (!existsSync(resolve(codexDir, CODEX_GENERATED_MARKER_FILENAME))) continue;
    rmSync(codexDir, { recursive: true, force: true });
    pruned.push(pluginRelPath);
  }
  return pruned;
}

/** writeCodexTarget(repoRootPath, results, { write }) → { pluginJsonPaths, catalogPath, prunedPluginRelPaths } */
function writeCodexTarget(repoRootPath, results, { write }) {
  const order = readConfigPackageOrder(repoRootPath);
  assertPluginInventoryAgreement(order, results.map((r) => r.pluginRelPath));
  const byRelPath = new Map(results.map((r) => [r.pluginRelPath, r]));
  const pluginJsonPaths = [];
  const codexEntries = [];
  const emittedPluginRelPaths = [];

  for (const pluginRelPath of order) {
    const r = byRelPath.get(pluginRelPath);
    if (r.packManifest.distribution.codex?.enabled !== true) continue;
    const claudeVersion = readExistingVersion(repoRootPath, pluginRelPath);
    const version = resolveCodexVersion({ repoRoot: repoRootPath, pluginRelPath, claudeVersion });
    const text = renderCodexPluginJson(r.packManifest, version) + "\n";
    const absPath = resolve(repoRootPath, pluginRelPath, ".codex-plugin/plugin.json");
    if (write) writeFileEnsuringDir(absPath, text);
    pluginJsonPaths.push(absPath);
    codexEntries.push({ pluginRelPath, packManifest: r.packManifest });
    emittedPluginRelPaths.push(pluginRelPath);

    const markerPath = resolve(repoRootPath, pluginRelPath, `.codex-plugin/${CODEX_GENERATED_MARKER_FILENAME}`);
    if (write) writeFileEnsuringDir(markerPath, renderCodexGeneratedMarker(r.packManifest, version) + "\n");
  }

  const catalogText = renderCodexCatalog(codexEntries) + "\n";
  const catalogPath = resolve(repoRootPath, ".agents/plugins/marketplace.json");
  if (write) writeFileEnsuringDir(catalogPath, catalogText);

  let prunedPluginRelPaths = [];
  if (write) {
    prunedPluginRelPaths = pruneStaleCodexPluginDirs(repoRootPath, emittedPluginRelPaths);
  }

  return { pluginJsonPaths, catalogPath, prunedPluginRelPaths };
}

/**
 * pruneStaleAgentsSkillsDirs(agentsSkillsRoot, emittedFlatNames) → the flat
 * names actually removed.
 *
 * A regeneration only ADDS/OVERWRITES files (the loop in
 * writeAgentsSkillsTarget below) — a skill that was removed, renamed, lost
 * its neutral opt-in, or whose pack gained a safety hook no longer appears in
 * `emittedFlatNames`, but its old directory would otherwise sit there
 * forever, out of sync with the current classification (Codex #3978 P1: the
 * coordinator hit exactly this by hand with catalyst-dev-linearis).
 *
 * Only removes a directory that BOTH (a) is absent from the current emit
 * plan and (b) carries this pipeline's own GENERATED_MARKER_FILENAME — never
 * touches a directory without that marker, so nothing hand-placed under
 * .agents/skills/ is ever at risk of this sweep.
 */
export function pruneStaleAgentsSkillsDirs(agentsSkillsRoot, emittedFlatNames) {
  if (!existsSync(agentsSkillsRoot)) return [];
  const emitted = new Set(emittedFlatNames);
  const pruned = [];
  for (const name of readdirSync(agentsSkillsRoot)) {
    const dirPath = resolve(agentsSkillsRoot, name);
    if (!statSync(dirPath).isDirectory()) continue;
    if (emitted.has(name)) continue;
    if (!existsSync(resolve(dirPath, GENERATED_MARKER_FILENAME))) continue;
    rmSync(dirPath, { recursive: true, force: true });
    pruned.push(name);
  }
  return pruned;
}

/** writeAgentsSkillsTarget(repoRootPath, results, { write }) → { emittedFlatNames, fileCount, prunedNames } */
export function writeAgentsSkillsTarget(repoRootPath, results, { write }) {
  const eligible = results.filter((r) => r.packManifest.distribution.agentsSkills?.enabled === true);
  const entries = eligible.map((r) => ({ packId: r.packId, pack: r.pack }));
  const { files, emittedFlatNames } = planAgentsSkillsBundle(entries);
  const agentsSkillsRoot = resolve(repoRootPath, ".agents/skills");

  let prunedNames = [];
  if (write) {
    prunedNames = pruneStaleAgentsSkillsDirs(agentsSkillsRoot, emittedFlatNames);
    for (const f of files) {
      const absPath = resolve(agentsSkillsRoot, f.relPath);
      const contents = f.text !== undefined ? f.text : Buffer.from(f.base64, "base64");
      writeFileEnsuringDir(absPath, contents);
    }
  }

  return { emittedFlatNames, fileCount: files.length, prunedNames };
}

const TARGET_WRITERS = {
  claude: writeClaudeTarget,
  codex: writeCodexTarget,
  agentsSkills: writeAgentsSkillsTarget,
};

function cmdRender(args) {
  const dryRun = args.includes("--dry-run");
  const allowLosses = args.includes("--allow-losses");
  const write = args.includes("--write");
  const targetIdx = args.indexOf("--target");
  const target = targetIdx >= 0 ? args[targetIdx + 1] : null;
  const results = renderAllPacks(repoRoot);

  let totalSkills = 0;
  let totalAgents = 0;
  let invalid = 0;

  for (const { pluginRelPath, packId, pack, validation } of results) {
    totalSkills += pack.skills.length;
    totalAgents += pack.agents.length;
    const status = validation.ok ? "OK" : "INVALID";
    if (!validation.ok) invalid += 1;
    console.log(
      `${status}  ${packId}  (${pluginRelPath})  skills=${pack.skills.length}  agents=${pack.agents.length}  hooks=${pack.hooks.present ? pack.hooks.entryCount : 0}`
    );
    for (const err of validation.errors) {
      console.log(`       ERROR: ${err}`);
    }
  }

  console.log("");
  console.log(`TOTAL  plugins=${results.length}  skills=${totalSkills}  agents=${totalAgents}`);

  if (invalid > 0) {
    console.log(`FAILED: ${invalid} plugin(s) failed contract validation`);
    if (!dryRun) process.exit(1);
  }

  const renderedAt = new Date().toISOString();
  const report = computeLossReport(results, renderedAt);
  const counts = lossCounts(report);
  console.log("");
  for (const [targetName, c] of Object.entries(counts)) {
    console.log(`LOSSES ${targetName}: omitted=${c.omitted} degraded=${c.degraded} warnings=${c.warnings}`);
  }

  if (write) {
    writeLossReportArtifacts(repoRoot, report);
    console.log(`wrote scripts/packaging/dist/loss-report.json and LOSSES.md`);
  }

  // The Claude target has no losses by construction (classifyPackLosses
  // returns empty for it) — a `--target claude` invocation is the byte-exact
  // round-trip check and must not be gated on codex/agentsSkills losses that
  // this invocation isn't even touching.
  const unacknowledged = hasUnacknowledgedLosses(report);
  if (unacknowledged && !allowLosses && !dryRun && target !== "claude") {
    console.log("FAILED: unacknowledged losses (omitted/degraded entries) — pass --allow-losses to proceed anyway");
    process.exit(1);
  }

  let targetOutcome = null;
  if (target) {
    const writer = TARGET_WRITERS[target];
    if (!writer) {
      console.log(`FAILED: unknown --target "${target}" (expected claude, codex, or agentsSkills)`);
      process.exit(1);
    }
    targetOutcome = writer(repoRoot, results, { write });
    console.log("");
    console.log(`TARGET ${target}: ${write ? "wrote" : "planned (pass --write to persist)"}`);
    if (targetOutcome.prunedNames?.length > 0) {
      console.log(`  pruned stale generated dir(s): ${targetOutcome.prunedNames.join(", ")}`);
    }
    if (targetOutcome.prunedPluginRelPaths?.length > 0) {
      console.log(`  pruned stale generated dir(s): ${targetOutcome.prunedPluginRelPaths.join(", ")}`);
    }
  } else if (write) {
    targetOutcome = {};
    for (const [name, writer] of Object.entries(TARGET_WRITERS)) {
      targetOutcome[name] = writer(repoRoot, results, { write });
      console.log(`TARGET ${name}: wrote output`);
      if (targetOutcome[name].prunedNames?.length > 0) {
        console.log(`  pruned stale generated dir(s): ${targetOutcome[name].prunedNames.join(", ")}`);
      }
      if (targetOutcome[name].prunedPluginRelPaths?.length > 0) {
        console.log(`  pruned stale generated dir(s): ${targetOutcome[name].prunedPluginRelPaths.join(", ")}`);
      }
    }
  }

  return { results, totalSkills, totalAgents, invalid, report, targetOutcome };
}

function cmdExtractionReadiness() {
  const result = checkExtractionReadiness({ repoRoot });
  console.log(`${result.verdict}: ${result.reason}`);
  // Informational only — this is a decision-record input (Phase 6's spec
  // says "no extraction happens in this ticket"), never a gate. It always
  // exits 0 so CI can print the verdict without blocking a build on it.
  return result;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "render":
      cmdRender(args);
      break;
    case "extraction-readiness":
      cmdExtractionReadiness();
      break;
    default:
      console.error(
        `Unknown command: ${command ?? "(none)"}. Usage: cli.mjs render [--dry-run] [--allow-losses] [--write] [--target <claude|codex|agentsSkills>] | cli.mjs extraction-readiness`
      );
      process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
