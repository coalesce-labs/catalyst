// claude.mjs — the Claude target emitter (CTL-1463 Phase 4).
//
// Written and proven FIRST: if regeneration cannot reproduce today's
// committed files byte-for-byte, nothing downstream is trustworthy. Reads
// ONLY from a pack.json's `identity`/`distribution.claude` blocks plus (for
// version) the EXISTING target file — never `plugins/*/` (enforced by the
// seam guard) and never anything else.
//
// Version handling is READ-ONLY: this emitter copies `$.version` from the
// existing target file verbatim. It never computes, bumps, or defaults a
// version. If the target file is absent, it refuses — seeding a version here
// would create a second version authority, which is exactly what
// release-please's extra-files mechanism exists to prevent (docs/releases.md).

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { formatJson, orderedObject } from "../core/json-format.mjs";

const MARKETPLACE_ROOT = {
  $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
  name: "catalyst",
  description:
    "Research-driven development workflow with Linear integration, PM tools, and infrastructure research agents",
  owner: { name: "Coalesce Labs", email: "hello@coalesce.dev" },
};

/**
 * readExistingVersion(repoRoot, pluginRelPath) → the current
 * `.claude-plugin/plugin.json`'s `$.version`, or throws if the file (or the
 * field) is absent — refusing to seed a version is the point.
 */
export function readExistingVersion(repoRoot, pluginRelPath) {
  const path = resolve(repoRoot, pluginRelPath, ".claude-plugin/plugin.json");
  if (!existsSync(path)) {
    throw new Error(
      `claude emitter: ${pluginRelPath}/.claude-plugin/plugin.json does not exist — refusing to seed a version. Version is release-please's alone to set.`
    );
  }
  const existing = JSON.parse(readFileSync(path, "utf8"));
  if (typeof existing.version !== "string" || existing.version.length === 0) {
    throw new Error(`claude emitter: ${pluginRelPath}/.claude-plugin/plugin.json has no $.version`);
  }
  return existing.version;
}

/**
 * buildPluginJson(packManifest, existingVersion) → the ordered plugin.json object.
 *
 * Field order is a fixed, explicit list (never Object.keys of a merged
 * object) matching every one of the 10 committed files: dependencies (when
 * present) sits BEFORE license; agents (when present) sits AFTER license —
 * verified against the real tree, not assumed.
 */
export function buildPluginJson(packManifest, existingVersion) {
  const identity = packManifest.identity;
  return orderedObject([
    ["name", packManifest.packId],
    ["version", existingVersion],
    ["description", identity.description],
    ["author", identity.author],
    ["homepage", identity.homepage],
    ["repository", identity.repository],
    ["keywords", identity.keywords],
    ["dependencies", identity.dependencies],
    ["license", identity.license],
    ["agents", identity.agents],
  ]);
}

/** renderPluginJson(packManifest, existingVersion) → formatted text (no trailing newline). Plugin.json uses LITERAL UTF-8 — confirmed against all committed files, zero \u escapes. */
export function renderPluginJson(packManifest, existingVersion) {
  return formatJson(buildPluginJson(packManifest, existingVersion), { escapeNonAscii: false });
}

/**
 * buildMarketplaceJson(entries) → the ordered root marketplace.json object.
 * `entries` is [{ packManifest, pluginRelPath }, ...] in the desired output
 * order (the committed file's plugin order — callers pass it explicitly,
 * this function does not re-sort).
 */
export function buildMarketplaceJson(entries) {
  const plugins = entries.map(({ packManifest, pluginRelPath }) => {
    const identity = packManifest.identity;
    const marketplace = packManifest.distribution.claude.marketplace;
    return orderedObject([
      ["name", packManifest.packId],
      ["source", `./${pluginRelPath}`],
      ["description", marketplace.description],
      // NOT identity.author: verified against the committed file, every one
      // of the 10 entries carries the catalog-level {name, email} — even for
      // plugins whose OWN plugin.json author.email differs (dev/foundry/
      // legacy say hello@coalesce-labs.com; every marketplace.json entry
      // says hello@coalesce.dev). Real, pre-existing inconsistency in the
      // source data, not a bug — reproduced faithfully, not "fixed".
      ["author", orderedObject([["name", MARKETPLACE_ROOT.owner.name], ["email", MARKETPLACE_ROOT.owner.email]])],
      ["homepage", identity.homepage],
      ["repository", identity.repository],
      ["license", identity.license],
      ["category", marketplace.category],
      ["keywords", marketplace.keywords],
    ]);
  });

  return orderedObject([
    ["$schema", MARKETPLACE_ROOT.$schema],
    ["name", MARKETPLACE_ROOT.name],
    ["description", MARKETPLACE_ROOT.description],
    ["owner", orderedObject([["name", MARKETPLACE_ROOT.owner.name], ["email", MARKETPLACE_ROOT.owner.email]])],
    ["plugins", plugins],
  ]);
}

/** renderMarketplaceJson(entries) → formatted text (no trailing newline). marketplace.json ESCAPES non-ASCII — confirmed against the committed file's `→`. */
export function renderMarketplaceJson(entries) {
  return formatJson(buildMarketplaceJson(entries), { escapeNonAscii: true });
}
