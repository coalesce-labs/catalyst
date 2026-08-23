// migrate-layer1-config.mjs — CTL-1214 Phase 2. Move a repo's relocated Layer-1
// keys into the node-scoped ~/.config/catalyst/node.json and stamp
// schemaVersion on what remains.
//
// Split in two on purpose:
//   planLayer1Migration()  — PURE. No I/O. Returns the whole decision
//                            (moves / kept / dropped / slimmedLayer1 / nodePatch),
//                            so the decision table is unit-testable outright.
//   applyLayer1Migration() — the two atomic writes, in the one safe order.
//
// It imports RELOCATED_LAYER1_KEYS from lib/validate-catalyst-config.mjs rather
// than re-listing anything, so there remains exactly ONE definition of what leaks.

import { readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, existsSync } from "node:fs";
import { RELOCATED_LAYER1_KEYS } from "./validate-catalyst-config.mjs";

/** The relocated dotted paths, for the bash side to consume via the CLI's
 *  --paths mode instead of re-typing them (the ASSERTED_BY mirror discipline). */
export const RELOCATED_PATHS = Object.freeze(RELOCATED_LAYER1_KEYS.map((e) => e.path));

/**
 * DEAD_LAYER1_PATHS — relocated-adjacent keys that are DROPPED, not moved.
 *
 * orchestration.executionCore.eligibleQuery is dead config: the runtime value
 * comes from execution-core/registry.json via resolveEligibleQuery, and the
 * registry entry is written from a hardcoded literal in
 * setup-execution-core-states.sh — never from Layer-1. readExecutionCoreConcurrency
 * returns the whole executionCore object, but no call site dereferences
 * .eligibleQuery on that result. Relocating it would carry a value nothing reads
 * into a new home and imply it still does something.
 */
export const DEAD_LAYER1_PATHS = Object.freeze([
  {
    path: "orchestration.executionCore.eligibleQuery",
    reason:
      "dead config — the runtime eligibleQuery comes from execution-core/registry.json " +
      "(resolveEligibleQuery), written from a hardcoded literal in setup-execution-core-states.sh; " +
      "no reader dereferences it on the Layer-1 object",
  },
]);

/**
 * AUTOTUNER_MIRROR_LEAF / AUTOTUNER_SETPOINT_LEAF — CTL-1214 remediation.
 *
 * `orchestration.executionCore.maxParallel` is the ONE relocated leaf that must
 * NOT be written to node.json, and whose Layer-1 value must NOT simply be
 * dropped either. Both halves are load-bearing:
 *
 *  - It must not LAND in node.json. The autotuner's runtime mirror is written by
 *    writeLayer2MaxParallel (autotune.mjs:432) into the LEGACY Layer-2
 *    `config.json`, and node.json OUTRANKS that file in readLayer2MergedFrom. A
 *    maxParallel in node.json would therefore permanently shadow every value the
 *    tuner writes — freezing host capacity at whatever the migration happened to
 *    copy, with the tuner still logging adjustments nothing reads.
 *
 *  - Its VALUE must survive. In Layer-1 that number is the operator's committed
 *    seek-to target: it is what CTL-750's `readLayer1Concurrency` feeds to RULE 7
 *    (recovery-to-layer1) and what CTL-770's `resolveTargetSetpoint` falls back
 *    to for the RULE 2 / RULE 9 setpoint branches. Slimming it away with no
 *    destination measured setpoint 4 -> undefined and layer1Max 4 -> null, which
 *    silently no-ops four control-law branches.
 *
 * `targetParallel` is the key CTL-770 created for exactly this value ("the
 * autotuner's seek-to setpoint, separate from maxParallel, which the autotuner
 * clobbers every tick as its live runtime mirror"). It is never tuner-written, so
 * re-homing the committed target there preserves the setpoint AND leaves the live
 * mirror alone. This is the shape the plan's own Layer-2 target model describes
 * (`{maxParallel, minParallel, maxParallelCeiling, targetParallel}`).
 */
const AUTOTUNER_MIRROR_LEAF = "orchestration.executionCore.maxParallel";
const AUTOTUNER_SETPOINT_LEAF = "orchestration.executionCore.targetParallel";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function getPath(obj, dotted) {
  let cur = obj;
  for (const seg of dotted.split(".")) {
    if (!isPlainObject(cur) || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setPath(obj, dotted, value) {
  const segs = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (!isPlainObject(cur[segs[i]])) cur[segs[i]] = {};
    cur = cur[segs[i]];
  }
  cur[segs[segs.length - 1]] = value;
}

// deletePath — remove a key and then every ancestor the removal left empty, so a
// fully-relocated `orchestration` stanza disappears rather than lingering as `{}`.
// An ancestor that still holds a NON-relocating sibling (orchestration.codex,
// monitor.linear) is kept — emptiness is the only trigger.
function deletePath(obj, dotted) {
  const segs = dotted.split(".");
  const chain = [];
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (!isPlainObject(cur[segs[i]])) return;
    chain.push([cur, segs[i]]);
    cur = cur[segs[i]];
  }
  delete cur[segs[segs.length - 1]];
  for (let i = chain.length - 1; i >= 0; i--) {
    const [parent, key] = chain[i];
    if (isPlainObject(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key];
  }
}

// A value is DEFINED in the merged Layer-2 when it is present and not null.
// `false` and `0` are real values — treating them as absent is the jq-falsy trap
// that would let a migration overwrite a deliberate `salvagePush: false`.
function definedInLayer2(mergedCatalyst, dotted) {
  const v = getPath(mergedCatalyst, dotted);
  return v !== undefined && v !== null;
}

// SCHEMA_KEY — an identifier-like key, i.e. one that names a FIELD OF A RECORD
// rather than a piece of DATA. This is the map-vs-record discriminator, and it is
// structural rather than a hand-maintained list.
const SCHEMA_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Expand a relocated entry into the paths the non-clobber check runs at. A record
// of independent knobs (`sweep`, `executionCore`) expands per FIELD, because
// all-or-nothing per stanza would either shadow an operator's single override
// (this host's machine-canonical maxParallel: 4) or strand three sibling keys
// because one of them already existed.
//
// ⚠️ Recursion STOPS at a map whose keys are data, not schema —
// monitor.github.repoColors is keyed by REPO NAME ("coalesce-labs/catalyst"), and
// its reader consumes the whole map. Two reasons it must move atomically:
// splitting it would make the non-clobber rule operate per repository, which is
// not a unit anyone configures; and this module addresses values by DOTTED PATH,
// so a repo name containing a "." (`a.b/c`) would be silently mis-nested into
// `{a: {b/c: ...}}` — a corruption no test of the happy path would catch.
function leafPaths(value, prefix, out) {
  if (!isPlainObject(value)) {
    out.push(prefix);
    return out;
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((k) => SCHEMA_KEY.test(k))) {
    out.push(prefix); // atomic: an empty object, or a data-keyed map
    return out;
  }
  for (const k of keys) leafPaths(value[k], `${prefix}.${k}`, out);
  return out;
}

/**
 * planLayer1Migration — decide the whole migration, with no I/O.
 *
 * @param {object} args
 * @param {object} args.layer1 - the parsed Layer-1 config ({ catalyst: {...} })
 * @param {object} args.mergedLayer2 - the merged Layer-2 view ({ catalyst: {...} })
 * @returns {{
 *   moves: Array<{path: string, value: unknown, scope: string}>,
 *   kept: Array<{path: string, existingValue: unknown, reason: string}>,
 *   dropped: Array<{path: string, reason: string}>,
 *   slimmedLayer1: object,
 *   nodePatch: object,
 *   changed: boolean,
 * }}
 * @throws when the Layer-1 config is not a `{ catalyst: {...} }` object — a
 *   malformed input must fail closed, never be silently treated as empty (which
 *   would "successfully" migrate nothing and report a clean run).
 */
export function planLayer1Migration({ layer1, mergedLayer2 } = {}) {
  if (!isPlainObject(layer1) || !isPlainObject(layer1.catalyst)) {
    throw new Error(
      "migrate-layer1-config: Layer-1 config must be an object with a `catalyst` object " +
        `(got ${JSON.stringify(layer1)?.slice(0, 80)})`,
    );
  }

  const slimmed = structuredClone(layer1);
  const mergedCatalyst = isPlainObject(mergedLayer2?.catalyst) ? mergedLayer2.catalyst : {};

  const moves = [];
  const kept = [];
  const dropped = [];
  const nodePatch = { catalyst: {} };

  // 1. Drop the dead keys first, so they can never be picked up as leaves below.
  for (const dead of DEAD_LAYER1_PATHS) {
    if (getPath(slimmed.catalyst, dead.path) !== undefined) {
      dropped.push({ path: dead.path, reason: dead.reason });
      deletePath(slimmed.catalyst, dead.path);
    }
  }

  // 2. Relocate the node-scoped entries, leaf by leaf.
  for (const entry of RELOCATED_LAYER1_KEYS) {
    // scope:"cluster" (monitor.linear.teams) is explicitly out of scope — the
    // roster move is CTL-1885. Leave it in place and untouched.
    if (entry.scope !== "node") continue;

    const present = getPath(slimmed.catalyst, entry.path);
    if (present === undefined) continue;

    for (const leaf of leafPaths(present, entry.path, [])) {
      const value = getPath(slimmed.catalyst, leaf);
      if (leaf === AUTOTUNER_MIRROR_LEAF) {
        // Re-home to targetParallel instead of moving in place — see the
        // AUTOTUNER_MIRROR_LEAF block above. Never falls through to the generic
        // arms below: writing maxParallel to node.json is the failure mode.
        if (definedInLayer2(mergedCatalyst, AUTOTUNER_SETPOINT_LEAF)) {
          kept.push({
            path: leaf,
            existingValue: getPath(mergedCatalyst, AUTOTUNER_SETPOINT_LEAF),
            reason:
              "the Layer-2 view already declares orchestration.executionCore.targetParallel — " +
              "that host setpoint wins; maxParallel is the autotuner's runtime mirror and is " +
              "never written to node.json",
          });
        } else {
          moves.push({
            path: AUTOTUNER_SETPOINT_LEAF,
            value,
            scope: entry.scope,
            from: leaf,
            reason:
              "maxParallel in node.json would shadow the autotuner's runtime mirror in the " +
              "legacy Layer-2 file; the committed target is re-homed to the CTL-770 " +
              "targetParallel setpoint key, which the autotuner never writes",
          });
          setPath(nodePatch.catalyst, AUTOTUNER_SETPOINT_LEAF, value);
        }
        deletePath(slimmed.catalyst, leaf);
        continue;
      }
      if (definedInLayer2(mergedCatalyst, leaf)) {
        // Non-clobber (D1): node.json OUTRANKS the legacy Layer-2 file in
        // readLayer2Merged, so writing this key would shadow a value that
        // already wins — e.g. this host's machine-canonical maxParallel: 4.
        kept.push({
          path: leaf,
          existingValue: getPath(mergedCatalyst, leaf),
          reason: "already defined in the merged Layer-2 view — writing it would shadow that value",
        });
      } else {
        moves.push({ path: leaf, value, scope: entry.scope });
        setPath(nodePatch.catalyst, leaf, value);
      }
      deletePath(slimmed.catalyst, leaf);
    }
  }

  // 3. schemaVersion opts this config into the strict contract (D3). Never
  //    lower an existing higher version.
  const existingVersion = slimmed.catalyst.schemaVersion;
  if (!Number.isInteger(existingVersion) || existingVersion < 1) {
    slimmed.catalyst.schemaVersion = 1;
  }

  const changed =
    moves.length > 0 ||
    dropped.length > 0 ||
    JSON.stringify(slimmed) !== JSON.stringify(layer1);

  return { moves, kept, dropped, slimmedLayer1: slimmed, nodePatch, changed };
}

function deepMerge(target, source) {
  const out = isPlainObject(target) ? { ...target } : {};
  for (const key of Object.keys(source)) {
    out[key] =
      isPlainObject(source[key]) && isPlainObject(out[key])
        ? deepMerge(out[key], source[key])
        : source[key];
  }
  return out;
}

// readJsonDestination — read the file we are about to DEEP-MERGE INTO.
//
// CTL-1214: this used to swallow every error to `{}`, so an existing but
// malformed or unreadable node.json was silently REPLACED by the migration's
// patch rather than refused — the exact asymmetry the plan set for a malformed
// Layer-1 INPUT (non-zero exit, no write) was missing on the destination side,
// where the cost is higher: the operator's other node-scoped keys are gone.
// ENOENT (and a missing-file ENOTDIR on a broken parent) means "start fresh" and
// stays a `{}`. Anything else — a parse error, EACCES, EISDIR — throws, matching
// catalyst-stack's "refusing to overwrite malformed config at <path>" posture.
// A file that parses to a non-object is malformed too, not empty.
function readJsonDestination(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return {};
    throw new Error(
      `migrate-layer1-config: refusing to overwrite unreadable config at ${path} (${err?.code ?? err?.message})`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `migrate-layer1-config: refusing to overwrite malformed config at ${path} (${err.message})`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `migrate-layer1-config: refusing to overwrite malformed config at ${path} (not a JSON object)`,
    );
  }
  return parsed;
}

// atomicWrite — tmp + rename in the SAME directory (rename is only atomic within
// a filesystem). mode is applied to the tmp file before the rename so the final
// file is never briefly world-readable.
function atomicWrite(path, contents, mode) {
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, contents, mode === undefined ? undefined : { mode });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort — never mask the original error */
    }
    throw err;
  }
}

/**
 * applyLayer1Migration — perform the two writes.
 *
 * ⚠️ ORDER IS LOAD-BEARING: node.json FIRST, the slimmed Layer-1 LAST. A failure
 * part-way must never leave a repo slimmed with its values nowhere — the
 * asymmetry is the whole safety property. The reverse order has a window in
 * which the config is stripped and the destination write then fails, silently
 * reverting every relocated knob to its code default on the next process start.
 *
 * @returns {{ wrote: string[], dryRun: boolean }}
 */
export function applyLayer1Migration({ plan, layer1Path, nodePath, dryRun = false } = {}) {
  if (!plan) throw new Error("migrate-layer1-config: a plan is required");
  if (!layer1Path || !nodePath) {
    throw new Error("migrate-layer1-config: layer1Path and nodePath are both required");
  }
  if (dryRun || !plan.changed) return { wrote: [], dryRun };

  const wrote = [];

  // 1. node.json — deep-merged into whatever is already there, never replaced.
  //    0600: it sits beside cluster-secrets.json in the machine-local config dir.
  if (plan.moves.length > 0) {
    const merged = deepMerge(readJsonDestination(nodePath), plan.nodePatch);
    atomicWrite(nodePath, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
    wrote.push(nodePath);
  }

  // 2. the slimmed Layer-1 — LAST, once its values are provably safe elsewhere.
  atomicWrite(layer1Path, `${JSON.stringify(plan.slimmedLayer1, null, 2)}\n`);
  wrote.push(layer1Path);

  return { wrote, dryRun: false };
}
