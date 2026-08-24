// codex.mjs — the Codex target emitter (CTL-1463 Phase 4).
//
// Emits `.codex-plugin/plugin.json` per plugin (same portable field set as
// the Claude plugin.json, minus the Claude-only `agents` subagent list) and
// the root `.agents/plugins/marketplace.json` catalog — version-free,
// inheriting the Claude marketplace.json precedent verbatim (docs/releases.md
// "plugin.json silently overrides marketplace.json").
//
// No claim beyond well-formedness (CTL-1465 owns the install/discovery
// probe) — so, unlike claude.mjs, there is no existing committed file to
// byte-match here. Two decisions with no real precedent to preserve, made
// explicit here rather than left implicit:
//   - The catalog reuses `identity.description` (the plugin's OWN
//     description), not `distribution.claude.marketplace.description` — that
//     field is documented as Claude-specific hand-tuned prose, independently
//     maintained from plugin.json's. pack.json's `distribution.codex` block
//     carries no marketplace sub-object of its own (see the pack.json shape
//     in the plan), so there is nothing Codex-specific to prefer.
//   - `category`/`keywords` DO reuse the Claude marketplace block's values —
//     those are taxonomy tags, not vendor prose, and pack.json defines them
//     nowhere else.
//   - The catalog author is each plugin's own `identity.author` (unlike
//     Claude's marketplace.json, which — per the byte-exact round-trip in
//     claude-emitter.test.mjs — carries a constant catalog-level author
//     independent of each plugin's own. That is preserved history in an
//     existing file; this is a new file with no such history to inherit).

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { formatJson, orderedObject } from "../core/json-format.mjs";

/**
 * resolveCodexVersion({ repoRoot, pluginRelPath, claudeVersion }) → the
 * version to write. On CREATE (no existing .codex-plugin/plugin.json), seeds
 * from claudeVersion (the single source of truth). On REGENERATE, preserves
 * the existing value and THROWS if it disagrees with claudeVersion — a
 * disagreement is real drift, and "repairing" it here would make that drift
 * invisible instead of surfacing it.
 */
export function resolveCodexVersion({ repoRoot, pluginRelPath, claudeVersion }) {
  const codexPath = resolve(repoRoot, pluginRelPath, ".codex-plugin/plugin.json");
  if (!existsSync(codexPath)) {
    return claudeVersion;
  }
  const existing = JSON.parse(readFileSync(codexPath, "utf8"));
  if (existing.version !== claudeVersion) {
    throw new Error(
      `codex emitter: ${pluginRelPath} version disagreement — .codex-plugin/plugin.json=${existing.version} vs .claude-plugin/plugin.json=${claudeVersion}. Never silently repaired; fix the drift and re-render.`
    );
  }
  return existing.version;
}

/** buildCodexPluginJson(packManifest, version) → the ordered .codex-plugin/plugin.json object. */
export function buildCodexPluginJson(packManifest, version) {
  const identity = packManifest.identity;
  return orderedObject([
    ["name", packManifest.packId],
    ["version", version],
    ["description", identity.description],
    ["author", identity.author],
    ["homepage", identity.homepage],
    ["repository", identity.repository],
    ["keywords", identity.keywords],
    ["license", identity.license],
    ["dependencies", identity.dependencies],
  ]);
}

export function renderCodexPluginJson(packManifest, version) {
  return formatJson(buildCodexPluginJson(packManifest, version), { escapeNonAscii: false });
}

/**
 * buildCodexCatalog(entries) → the ordered .agents/plugins/marketplace.json
 * object. `entries` is [{ packManifest, pluginRelPath }, ...] in the desired
 * output order. Deliberately carries NO version field anywhere, at any depth
 * — inherited from the Claude marketplace.json rationale verbatim (Check 7 /
 * Check 11).
 */
export function buildCodexCatalog(entries) {
  const plugins = entries.map(({ packManifest, pluginRelPath }) => {
    const identity = packManifest.identity;
    const claudeMarketplace = packManifest.distribution.claude?.marketplace;
    return orderedObject([
      ["name", packManifest.packId],
      ["source", `./${pluginRelPath}`],
      ["description", identity.description],
      ["author", orderedObject([["name", identity.author.name], ["email", identity.author.email]])],
      ["homepage", identity.homepage],
      ["repository", identity.repository],
      ["license", identity.license],
      ["category", claudeMarketplace?.category],
      ["keywords", claudeMarketplace?.keywords ?? identity.keywords],
    ]);
  });

  return orderedObject([
    ["name", "catalyst"],
    [
      "description",
      "Research-driven development workflow with Linear integration, PM tools, and infrastructure research agents — Codex plugin catalog.",
    ],
    ["owner", orderedObject([["name", "Coalesce Labs"], ["email", "hello@coalesce.dev"]])],
    ["plugins", plugins],
  ]);
}

export function renderCodexCatalog(entries) {
  return formatJson(buildCodexCatalog(entries), { escapeNonAscii: false });
}
