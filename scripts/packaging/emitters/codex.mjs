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
import { createHash } from "node:crypto";

import { formatJson, orderedObject } from "../core/json-format.mjs";

/** GENERATED_MARKER_FILENAME — the drift-gate marker cli.mjs's stale-prune pass keys off of (CTL-1461 Phase 3). A SIBLING of plugin.json, never a key inside it — the installed Codex plugin validator whitelists an exact top-level key set and rejects anything outside it. */
export const GENERATED_MARKER_FILENAME = ".generated-by-catalyst-packaging";

/**
 * buildCodexGeneratedMarker(packManifest) → { generatedBy, pack, sourceHash }.
 * `sourceHash` covers `packManifest` ONLY (read fresh off disk every render)
 * — deliberately NOT the resolved version. Version is externally owned by
 * Release Please and bumped on every release, independent of any packaging-
 * relevant source change; that content is already visible and diffed
 * directly in plugin.json itself. Folding it into this hash too (Codex #4015
 * P1) would invalidate every committed marker on every routine release PR —
 * a real, recurring failure, not hypothetical: it reproduced on this PR's
 * own first CI run, when an unrelated release-please bump landed on `main`
 * between branch and merge-check.
 *
 * Hashed as an EXPLICIT UTF-8 Buffer, never a bare string handed to
 * `Hash.update()` — several real plugin descriptions contain literal non-ASCII
 * bytes (e.g. catalyst-dev's `→`), and relying on a string's implicit default
 * encoding is exactly the kind of ambiguity a byte-for-byte hash must not
 * depend on.
 */
export function buildCodexGeneratedMarker(packManifest) {
  const payload = Buffer.from(JSON.stringify(packManifest), "utf8");
  const sourceHash = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
  return orderedObject([
    ["generatedBy", "catalyst-packaging"],
    ["pack", packManifest.packId],
    ["sourceHash", sourceHash],
  ]);
}

export function renderCodexGeneratedMarker(packManifest) {
  return formatJson(buildCodexGeneratedMarker(packManifest), { escapeNonAscii: false });
}

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

// The installed Codex plugin validator (plugin-creator/scripts/validate_plugin.py
// validate_manifest_shape) whitelists an exact top-level key set that does NOT
// include `dependencies` — unlike Claude's plugin.json, which accepts it
// (claude.mjs's buildPluginJson). Emitting it here would fail Codex's
// "field `dependencies` is not accepted by plugin validation" check for
// every pack whose identity.dependencies is set (catalyst-foundry today),
// so it is deliberately never read in this file.

function firstSentence(text) {
  const match = text.match(/^[^.!?]*[.!?]/);
  return (match ? match[0] : text).trim();
}

function truncate(text, maxLength) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function titleCase(text) {
  return text.replace(/[-_]+/g, " ").replace(/\S+/g, (word) => word[0].toUpperCase() + word.slice(1));
}

/**
 * buildCodexInterface(packManifest) → the `interface` object
 * plugin-creator/references/plugin-json-spec.md's validator requires
 * (require_object(manifest, "interface", errors) plus its required
 * displayName/shortDescription/longDescription/developerName/category/
 * capabilities/defaultPrompt fields). pack.json carries no dedicated
 * interface block of its own (unlike distribution.claude.marketplace) — every
 * field here is DERIVED from identity/distribution.claude.marketplace rather
 * than duplicated into pack.json, per AGENTS.md's "Single source of truth"
 * principle. `capabilities` is a fixed, true-for-every-pack value (every
 * catalyst plugin is an interactive, file-writing Claude Code skill pack) —
 * not marketing copy, so a constant is honest here rather than fabricated.
 */
export function buildCodexInterface(packManifest) {
  const identity = packManifest.identity;
  const claudeMarketplace = packManifest.distribution.claude?.marketplace;
  const shortDescription = truncate(firstSentence(identity.description), 128);
  return orderedObject([
    ["displayName", titleCase(packManifest.packId)],
    ["shortDescription", shortDescription],
    ["longDescription", identity.description],
    ["developerName", identity.author.name],
    ["category", titleCase(claudeMarketplace?.category ?? "development")],
    ["capabilities", ["Interactive", "Write"]],
    ["defaultPrompt", [shortDescription]],
  ]);
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
    ["interface", buildCodexInterface(packManifest)],
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
      // Marketplace field guide: `source` must be an object
      // ({source:"local", path:"./plugins/..."}), not the bare path string
      // this used to emit — a string here made every catalog entry
      // incompatible with the marketplace ingestion schema.
      ["source", orderedObject([["source", "local"], ["path", `./${pluginRelPath}`]])],
      // "policy" block: "Always include it" (marketplace generation rules).
      // AVAILABLE/ON_INSTALL are the field guide's documented defaults for
      // new entries — no per-pack signal exists to differentiate them yet.
      ["policy", orderedObject([["installation", "AVAILABLE"], ["authentication", "ON_INSTALL"]])],
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
