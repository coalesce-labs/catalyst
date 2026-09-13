// vendor.mjs — one source, generated copies (CTL-2306 Phase 2).
//
// A catalyst-dev skill must run from its own directory on any harness, so every
// script and subagent prompt it uses lives inside it. A file two skills share keeps
// ONE source under the plugin (scripts/…, agents/<name>.md) and each skill lists it
// in `agents/vendor.yaml`; `cli.mjs vendor --write` writes byte-identical copies and
// `render --write` runs that first, so packaging-gate.yml's regenerate-and-diff step
// fails when a copy drifts. The copy never wins: an edited copy is overwritten from
// its source.
//
// Pure: the provider reads the manifests and bytes, cli.mjs writes. Nothing here
// touches the filesystem.

const KNOWN_MANIFEST_KEYS = new Set(["files"]);

/**
 * vendorDestination(from) → the path the copy takes inside the skill directory.
 *   scripts/<path>      → scripts/<path>   (sibling `source`/import paths keep working)
 *   agents/<name>.md    → assets/agents/<name>.md
 * Anything else throws, naming the path.
 */
export function vendorDestination(from) {
  if (typeof from !== "string" || from.length === 0) {
    throw new Error(`vendor: source ${JSON.stringify(from)} must be a non-empty string`);
  }
  const parts = from.split("/");
  if (from.startsWith("/") || from.includes("\\") || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new Error(`vendor: source ${JSON.stringify(from)} must be a contained relative path (no "..", ".", empty or absolute segments)`);
  }
  if (parts[0] === "scripts" && parts.length >= 2) return from;
  if (parts[0] === "agents" && parts.length === 2 && parts[1].endsWith(".md")) return `assets/agents/${parts[1]}`;
  throw new Error(`vendor: source ${JSON.stringify(from)} is neither scripts/<path> nor agents/<name>.md`);
}

/** validateVendorManifest(parsed, label) → { files } or throws naming `label`. */
export function validateVendorManifest(parsed, label) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`vendor: ${label} must be a mapping with a "files" list`);
  }
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_MANIFEST_KEYS.has(key)) throw new Error(`vendor: ${label} has an unknown key "${key}" (accepted: files)`);
  }
  const { files } = parsed;
  if (!Array.isArray(files)) throw new Error(`vendor: ${label} "files" must be a list`);
  if (files.length === 0) throw new Error(`vendor: ${label} "files" is empty — delete the manifest instead`);
  const seen = new Set();
  for (const file of files) {
    if (typeof file !== "string") throw new Error(`vendor: ${label} "files" entry ${JSON.stringify(file)} must be a string`);
    vendorDestination(file);
    if (seen.has(file)) throw new Error(`vendor: ${label} lists a duplicate entry "${file}"`);
    seen.add(file);
  }
  return { files: [...files] };
}

/**
 * planVendoredCopies(entries) → { writes, drift, errors, skillCount }
 *
 * `entries`: [{ skillId, files, sources: { [from]: { base64, mode } | null }, current: { [to]: { base64 } } }]
 * - writes: every copy whose bytes are missing or differ from the source
 * - drift:  the same set, as the gate reports it (`missing` | `differs`)
 * - errors: a listed source that does not exist — never silently skipped
 */
export function planVendoredCopies(entries) {
  const writes = [];
  const drift = [];
  const errors = [];
  for (const { skillId, files, sources, current } of entries) {
    for (const from of files) {
      const to = vendorDestination(from);
      const source = sources[from];
      if (!source) {
        errors.push({ skillId, from, reason: "source-missing" });
        continue;
      }
      const existing = current[to];
      if (existing && existing.base64 === source.base64) continue;
      writes.push({ skillId, from, to, base64: source.base64, mode: source.mode });
      drift.push({ skillId, from, to, reason: existing ? "differs" : "missing" });
    }
  }
  return { writes, drift, errors, skillCount: entries.length };
}
