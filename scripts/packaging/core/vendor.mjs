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
 *   references/<name>.md → assets/references/<name>.md (a skill's own references/ is held to
 *                          skill-shape.test.sh's budget; a shared plugin reference is not its prose)
 *   templates/<name>     → assets/templates/<name>
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
  if (parts[0] === "references" && parts.length === 2 && parts[1].endsWith(".md")) return `assets/references/${parts[1]}`;
  if (parts[0] === "templates" && parts.length === 2) return `assets/templates/${parts[1]}`;
  throw new Error(`vendor: source ${JSON.stringify(from)} is not scripts/<path>, agents/<name>.md, references/<name>.md or templates/<name>`);
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
 * planVendoredCopies(entries) → { writes, drift, errors, prunes, locks, skillCount }
 *
 * `entries`: [{ skillId, files, sources: { [from]: { base64, mode } | null },
 *               current: { [to]: { base64, mode } }, lock: string[] | null }]
 * `lock` is the skill's `agents/vendor.lock.json` file list — the copies this tool wrote last
 * time — so a copy whose entry left the manifest can be told apart from a file the skill owns.
 * - writes: every copy whose bytes or mode differ from the source, or that is missing
 * - prunes: a recorded copy the manifest no longer lists (deleted on write)
 * - locks:  a skill whose lock does not equal its declared copies (rewritten; [] deletes it)
 * - drift:  all of the above as the gate reports it — `missing` | `differs` | `mode-differs` |
 *           `undeclared` | `lock-stale`
 * - errors: a listed source that does not exist — never silently skipped
 */
export function planVendoredCopies(entries) {
  const writes = [];
  const drift = [];
  const errors = [];
  const prunes = [];
  const locks = [];
  for (const { skillId, files, sources, current, lock } of entries) {
    const declared = files.map((from) => vendorDestination(from));
    for (const from of files) {
      const to = vendorDestination(from);
      const source = sources[from];
      if (!source) {
        errors.push({ skillId, from, reason: "source-missing" });
        continue;
      }
      const existing = current[to];
      if (existing && existing.base64 === source.base64 && existing.mode === source.mode) continue;
      writes.push({ skillId, from, to, base64: source.base64, mode: source.mode });
      const reason = !existing ? "missing" : existing.base64 !== source.base64 ? "differs" : "mode-differs";
      drift.push({ skillId, from, to, reason });
    }
    for (const to of lock ?? []) {
      if (declared.includes(to)) continue;
      if (current[to]) {
        prunes.push({ skillId, to });
        drift.push({ skillId, from: null, to, reason: "undeclared" });
      }
    }
    const wanted = [...declared].sort();
    const recorded = lock ? [...lock].sort() : null;
    if (recorded === null ? wanted.length > 0 : recorded.join("\n") !== wanted.join("\n")) {
      locks.push({ skillId, files: wanted });
      if (!drift.some((d) => d.skillId === skillId)) drift.push({ skillId, from: null, to: "agents/vendor.lock.json", reason: "lock-stale" });
    }
  }
  return { writes, drift, errors, prunes, locks, skillCount: entries.length };
}
