// validate-catalyst-config.mjs — pure, no-I/O validation for the Layer-1
// .catalyst/config.json (CTL-1214).
//
// `.catalyst/config.json` is committed per-repo and must carry ONLY
// project-identity fields. Three other categories historically leaked into it:
//   - the project roster (monitor.linear.teams[])  → relocates to the CLUSTER
//     scope (catalyst-cluster/cluster.json → projects[]);
//   - repo display colors (monitor.github.repoColors), the orchestration.*,
//     feedback.*, and sweep.* stanzas → relocate to the NODE scope
//     (~/.config/catalyst/node.json — CTL-1214 D1; readLayer2Merged already
//     composes config.json < node.json < cluster-secrets.json, and node.json is
//     the per-node file that is never mirrored across the cluster).
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
 * ⚠️ CTL-1214 D6 — `catalyst.orchestration` is NOT wholly machine-scoped, so the
 * blanket `orchestration` row this list used to carry is replaced by the FOUR
 * subpaths that actually relocate. config-dump.mjs heads that block
 * "orchestration (Layer-1 owned)", and the daemon reads at least these further
 * stanzas from Layer-1, every one of which stays:
 *   executor, executorByPhase, codex (the documented codexHome pin — see
 *   docs/architecture.md "The Codex account selector seam"), publishPreflight,
 *   fleetHealth, daemonWatchdog, orphanReaper.workerGc, stalePrRescue,
 *   orphanPrSweep, stalledPrSweep, draftPr, pluginDirs, phaseAgents.
 * The narrowing is what lets the Phase-5 promotion be a hard error without making
 * a documented, supported configuration fail doctor — and doctor's exit code
 * gates member activation in catalyst-join.sh, so a false FAIL there fail-closes
 * the fleet. This repo's committed config carries only the four, so the
 * "no orchestration stanza after migration" outcome is unchanged.
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
    destination: "~/.config/catalyst/node.json → catalyst.monitor.github.repoColors",
  },
  {
    path: "orchestration.dispatchMode",
    scope: "node",
    destination: "~/.config/catalyst/node.json → catalyst.orchestration.dispatchMode",
  },
  {
    path: "orchestration.executionCore",
    scope: "node",
    destination: "~/.config/catalyst/node.json → catalyst.orchestration.executionCore.*",
  },
  {
    path: "orchestration.worktreeRefresh",
    scope: "node",
    destination: "~/.config/catalyst/node.json → catalyst.orchestration.worktreeRefresh.*",
  },
  {
    path: "orchestration.reconcile",
    scope: "node",
    destination: "~/.config/catalyst/node.json → catalyst.orchestration.reconcile.*",
  },
  {
    path: "feedback",
    scope: "node",
    destination: "~/.config/catalyst/node.json → catalyst.feedback.*",
  },
  {
    path: "sweep",
    scope: "node",
    destination: "~/.config/catalyst/node.json → catalyst.sweep.*",
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
 * SELF-GATING STRICTNESS (CTL-1214 D3). `catalyst.schemaVersion` is the opt-in
 * switch, NOT a hard global requirement:
 *
 *   - schemaVersion ABSENT  → today's lenient behavior verbatim. Relocated keys
 *     are `deprecatedKeys` only, and the missing version is a `recommendation`.
 *     The in-tree comments used to say Phase 6 would "promote schemaVersion to
 *     required"; taken literally that flags every not-yet-migrated config in the
 *     fleet as invalid, in editors and validators, for no benefit.
 *   - schemaVersion >= 1    → this config has opted into the slimmed schema, so a
 *     NODE-scoped relocated key is a HARD ERROR. A repo therefore becomes strict
 *     exactly when it is slimmed, and a hand-edit or a rollback that re-adds a
 *     relocated stanza fails loudly instead of silently reverting knobs.
 *   - a PRESENT-but-malformed value (not an integer >= 1) is a hard error in its
 *     own right and does NOT count as opting in — if you bother to set it, set it
 *     correctly, and a bogus value must not be a back door into strict mode.
 *
 * CLUSTER-scoped leaks stay lenient in BOTH modes (D4). `monitor.linear.teams` is
 * explicitly out of scope for CTL-1214 — the roster move is CTL-1885 — so it
 * remains in slimmed configs and must not fail them. The gate keys off the
 * registry's existing `scope` field; no new field, no second list.
 *
 * ⚠️ Why the asymmetry matters operationally: `catalyst doctor`'s exit code is its
 * FAIL count, and catalyst-join.sh gates member activation on doctor exit 0. A
 * hard error here becomes a fail-closed join gate, so it may only fire on a config
 * that has DECLARED it is slimmed — never on a fleet member that simply has not
 * migrated yet.
 *
 * The only other hard requirement is a top-level `catalyst` object.
 *
 * @param {unknown} obj - the parsed config object, expected shape `{ catalyst: {...} }`.
 * @returns {{ valid: boolean, deprecatedKeys: string[], errors: string[], recommendations: string[] }}
 *   - `valid`: true when there are no hard errors (deprecated keys / missing schemaVersion do not affect this);
 *   - `deprecatedKeys`: dotted paths (relative to `catalyst.`) that have relocated;
 *   - `errors`: human-readable hard-validation failures;
 *   - `recommendations`: non-failing migration signals (e.g. a missing schemaVersion).
 */
export function validateLayer1Config(obj) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const deprecatedKeys = [];
  /** @type {string[]} */
  const recommendations = [];

  const root = obj != null && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  const catalyst = root.catalyst;

  if (catalyst == null || typeof catalyst !== "object" || Array.isArray(catalyst)) {
    errors.push("missing top-level `catalyst` object");
    return { valid: false, deprecatedKeys, errors, recommendations };
  }

  // Back-compat (CTL-1214): catalyst.schemaVersion is RECOMMENDED, not required.
  // A not-yet-slimmed config omits it — surface a migration recommendation rather
  // than fail. A present value must still be an integer >= 1 (hard error otherwise).
  const schemaVersion = catalyst.schemaVersion;
  if (schemaVersion === undefined || schemaVersion === null) {
    recommendations.push(
      "catalyst.schemaVersion is recommended (integer >= 1) — add it when slimming the config (CTL-1214 Phase 6).",
    );
  } else if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    errors.push(
      `catalyst.schemaVersion must be an integer >= 1 (got ${JSON.stringify(schemaVersion)})`,
    );
  }

  // Has this config OPTED IN to the strict contract? Only a well-formed integer
  // >= 1 counts — the malformed-value branch above already errored, and letting a
  // bogus value opt in would make garbage stricter than a blank.
  const optedIn = Number.isInteger(schemaVersion) && schemaVersion >= 1;

  // Scope-leak detection. Presence of a relocated key is always a deprecation;
  // under an opted-in config a NODE-scoped one is additionally a hard error.
  for (const entry of RELOCATED_LAYER1_KEYS) {
    if (getPath(catalyst, entry.path) === undefined) continue;
    deprecatedKeys.push(entry.path);
    if (optedIn && entry.scope === "node") {
      errors.push(
        `catalyst.${entry.path} is node-scoped and must not appear in a schemaVersion ` +
          `>= 1 Layer-1 config — relocate it to ${entry.destination} by running ` +
          `\`catalyst-config-migrate\``,
      );
    }
  }

  return { valid: errors.length === 0, deprecatedKeys, errors, recommendations };
}
