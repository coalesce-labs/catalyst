#!/usr/bin/env bun
// cli.mjs — the packaging pipeline entrypoint (CTL-1463).
//
// The ONE file outside providers/local-provisional.mjs itself that may import
// it — enforced by packaging-seam.test.mjs's countProviderImporters() check.
// Subcommands grow phase by phase: Phase 2 ships `render --dry-run` (a census,
// no writes); Phase 3 adds loss reporting; Phase 4 adds `--target`/`--write`;
// Phase 6 adds `extraction-readiness`.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { validateRenderedPack } from "./core/contract.mjs";
import { readPackManifest } from "./core/pack-manifest.mjs";
import { renderPluginPack, listPluginRelPaths } from "./providers/local-provisional.mjs";
import { buildLossReport, hasUnacknowledgedLosses, lossCounts, renderLossReportMarkdown } from "./core/loss.mjs";
import { renderPluginJson, renderMarketplaceJson, readExistingVersion } from "./emitters/claude.mjs";
import { resolveCodexVersion, renderCodexPluginJson, renderCodexCatalog } from "./emitters/codex.mjs";
import { planAgentsSkillsBundle } from "./emitters/agents-skills.mjs";
import { checkExtractionReadiness } from "./core/extraction-readiness.mjs";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const NON_CLAUDE_TARGETS = ["codex", "agentsSkills"];

function readPackId(repoRootPath, pluginRelPath) {
  const plugin = JSON.parse(
    readFileSync(resolve(repoRootPath, pluginRelPath, ".claude-plugin/plugin.json"), "utf8")
  );
  return plugin.name;
}

function readSkillNeutralOverrides(repoRootPath, pluginRelPath) {
  const packJsonPath = resolve(repoRootPath, pluginRelPath, "pack.json");
  if (!existsSync(packJsonPath)) return {};
  const pack = JSON.parse(readFileSync(packJsonPath, "utf8"));
  return pack.skills ?? {};
}

/** readConfigPackageOrder(repoRootPath) → plugin rel-paths in release-please-config.json's declared order. */
export function readConfigPackageOrder(repoRootPath) {
  const config = JSON.parse(readFileSync(resolve(repoRootPath, "release-please-config.json"), "utf8"));
  return Object.keys(config.packages);
}

/**
 * renderAllPacks(repoRootPath) → [{ pluginRelPath, packId, pack, packManifest, validation }]
 *
 * Renders every real plugin directory through the provisional provider and
 * validates each against the contract. Never writes anything to disk.
 */
export function renderAllPacks(repoRootPath = repoRoot) {
  return listPluginRelPaths(repoRootPath).map((pluginRelPath) => {
    const packId = readPackId(repoRootPath, pluginRelPath);
    const pack = renderPluginPack({
      repoRoot: repoRootPath,
      pluginRelPath,
      packId,
      skillNeutralOverrides: readSkillNeutralOverrides(repoRootPath, pluginRelPath),
    });
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

/** writeClaudeTarget(repoRootPath, results, { write }) → { pluginJsonPaths, marketplacePath } */
function writeClaudeTarget(repoRootPath, results, { write }) {
  const order = readConfigPackageOrder(repoRootPath);
  const byRelPath = new Map(results.map((r) => [r.pluginRelPath, r]));
  const pluginJsonPaths = [];

  for (const pluginRelPath of order) {
    const r = byRelPath.get(pluginRelPath);
    if (!r) continue;
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

/** writeCodexTarget(repoRootPath, results, { write }) → { pluginJsonPaths, catalogPath } */
function writeCodexTarget(repoRootPath, results, { write }) {
  const order = readConfigPackageOrder(repoRootPath);
  const byRelPath = new Map(results.map((r) => [r.pluginRelPath, r]));
  const pluginJsonPaths = [];
  const codexEntries = [];

  for (const pluginRelPath of order) {
    const r = byRelPath.get(pluginRelPath);
    if (!r || r.packManifest.distribution.codex?.enabled !== true) continue;
    const claudeVersion = readExistingVersion(repoRootPath, pluginRelPath);
    const version = resolveCodexVersion({ repoRoot: repoRootPath, pluginRelPath, claudeVersion });
    const text = renderCodexPluginJson(r.packManifest, version) + "\n";
    const absPath = resolve(repoRootPath, pluginRelPath, ".codex-plugin/plugin.json");
    if (write) writeFileEnsuringDir(absPath, text);
    pluginJsonPaths.push(absPath);
    codexEntries.push({ pluginRelPath, packManifest: r.packManifest });
  }

  const catalogText = renderCodexCatalog(codexEntries) + "\n";
  const catalogPath = resolve(repoRootPath, ".agents/plugins/marketplace.json");
  if (write) writeFileEnsuringDir(catalogPath, catalogText);

  return { pluginJsonPaths, catalogPath };
}

/** writeAgentsSkillsTarget(repoRootPath, results, { write }) → { emittedFlatNames, fileCount } */
function writeAgentsSkillsTarget(repoRootPath, results, { write }) {
  const eligible = results.filter((r) => r.packManifest.distribution.agentsSkills?.enabled === true);
  const entries = eligible.map((r) => ({ packId: r.packId, pack: r.pack }));
  const { files, emittedFlatNames } = planAgentsSkillsBundle(entries);

  if (write) {
    for (const f of files) {
      const absPath = resolve(repoRootPath, ".agents/skills", f.relPath);
      const contents = f.text !== undefined ? f.text : Buffer.from(f.base64, "base64");
      writeFileEnsuringDir(absPath, contents);
    }
  }

  return { emittedFlatNames, fileCount: files.length };
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
  } else if (write) {
    targetOutcome = {};
    for (const [name, writer] of Object.entries(TARGET_WRITERS)) {
      targetOutcome[name] = writer(repoRoot, results, { write });
      console.log(`TARGET ${name}: wrote output`);
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
