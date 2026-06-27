// validate-catalyst-config.mjs — pure, no-I/O validation for the Layer-1
// .catalyst/config.json (CTL-1214).
//
// `.catalyst/config.json` is committed per-repo and must carry ONLY
// project-identity fields. Three other categories historically leaked into it:
//   - the project roster (monitor.linear.teams[])  → relocates to the CLUSTER
//     scope (catalyst-cluster/cluster.json → projects[]);
//   - repo display colors (monitor.github.repoColors), the orchestration.*,
//     feedback.*, and sweep.* stanzas → relocate to the NODE scope
//     (~/.config/catalyst/config.json).
//
// This module is the single source of truth for that leak-category list
// (RELOCATED_LAYER1_KEYS) and a pure validator (validateLayer1Config) that both
// the Phase-1 schema tests and the Phase-5 `catalyst doctor` scope-leak check
// reuse. It performs NO I/O so it stays trivially testable and importable from
// any context (tests, doctor, CLI).

/**
 * The categories of keys that no longer belong in Layer-1 `.catalyst/config.json`.
 * Each entry is a dotted path *within the `catalyst` namespace* (i.e. relative to
 * `obj.catalyst`), plus the scope it relocates to and the concrete destination.
 *
 * Note: monitor.linear.botUserId and monitor.suppressVersionWarning are NOT
 * relocated — they are genuinely Layer-1 (the daemon reads botUserId flat from
 * Layer-1, see docs/architecture.md) — so they are deliberately absent here.
 *
 * @type {ReadonlyArray<{path: string, scope: "cluster"|"node", destination: string}>}
 */
export const RELOCATED_LAYER1_KEYS = Object.freeze([
  {
    path: "monitor.linear.teams",
    scope: "cluster",
    destination: "catalyst-cluster/cluster.json → projects[]",
  },
  {
    path: "monitor.github.repoColors",
    scope: "node",
    destination: "~/.config/catalyst/config.json → catalyst.monitor.github.repoColors",
  },
  {
    path: "orchestration",
    scope: "node",
    destination: "~/.config/catalyst/config.json → catalyst.orchestration.*",
  },
  {
    path: "feedback",
    scope: "node",
    destination: "~/.config/catalyst/config.json → catalyst.feedback.*",
  },
  {
    path: "sweep",
    scope: "node",
    destination: "~/.config/catalyst/config.json → catalyst.sweep.*",
  },
]);

/**
 * Read a dotted path out of an object without throwing on missing intermediate
 * nodes. Returns `undefined` when any segment is absent or a non-object is
 * encountered mid-walk.
 * @param {unknown} obj
 * @param {string} dottedPath
 */
function getPath(obj, dottedPath) {
  let cur = obj;
  for (const segment of dottedPath.split(".")) {
    if (cur == null || typeof cur !== "object" || Array.isArray(cur) || !(segment in cur)) {
      return undefined;
    }
    cur = cur[segment];
  }
  return cur;
}

/**
 * Validate a parsed Layer-1 `.catalyst/config.json` object.
 *
 * This is intentionally lenient about the relocated stanzas: their presence does
 * NOT make the config invalid (back-compat migration window) — it only populates
 * `deprecatedKeys`. The only hard requirement enforced here is the new
 * `catalyst.schemaVersion` (integer >= 1).
 *
 * @param {unknown} obj - the parsed config object, expected shape `{ catalyst: {...} }`.
 * @returns {{ valid: boolean, deprecatedKeys: string[], errors: string[] }}
 *   - `valid`: true when there are no hard errors (deprecated keys do not affect this);
 *   - `deprecatedKeys`: dotted paths (relative to `catalyst.`) that have relocated;
 *   - `errors`: human-readable hard-validation failures.
 */
export function validateLayer1Config(obj) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const deprecatedKeys = [];

  const root = obj != null && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  const catalyst = root.catalyst;

  if (catalyst == null || typeof catalyst !== "object" || Array.isArray(catalyst)) {
    errors.push("missing top-level `catalyst` object");
    return { valid: false, deprecatedKeys, errors };
  }

  // Hard requirement: catalyst.schemaVersion is an integer >= 1.
  const schemaVersion = catalyst.schemaVersion;
  if (schemaVersion === undefined || schemaVersion === null) {
    errors.push("catalyst.schemaVersion is required (integer >= 1)");
  } else if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    errors.push(
      `catalyst.schemaVersion must be an integer >= 1 (got ${JSON.stringify(schemaVersion)})`,
    );
  }

  // Soft: scope-leak detection. Presence of a relocated key is deprecated, not invalid.
  for (const entry of RELOCATED_LAYER1_KEYS) {
    if (getPath(catalyst, entry.path) !== undefined) {
      deprecatedKeys.push(entry.path);
    }
  }

  return { valid: errors.length === 0, deprecatedKeys, errors };
}
