// board-vocabulary.mjs — CTL-2300 Tier 1, the half CTL-2299 and lib/cloud-facts.mjs left.
//
// The WORDS a tenant's board uses: what its ask labels are called, what its release-a-false-
// positive label is called, and what it calls each pipeline stage. Read from the tenant's own
// config, defaulted from ONE committed contract file, and never spelled again anywhere else.
//
// ## What this replaces
//
// cloud-facts.mjs took WHERE the cloud is out of the plugin. This takes the remaining
// tenant-shaped literals, all of which were still baked in on 2026-09-09:
//
//   * **Ask label names.** `ask.mjs` froze `["catalyst-ask", "ask/decision"]` as a module
//     constant and `ask/references/creating.md` typed them into a `--labels` flag. On a tenant
//     that calls its decision label anything else, `resolveTeamLabelIds` returns
//     `label-not-on-team` and the ask does not file at all — loud, but only for the tenant, and
//     unfixable without editing our plugin.
//   * **`catalyst-not-an-ask`.** The label a human applies to release a false positive out of
//     the mirror's ask-shape hold (CTC-1534/CTC-1752) was assumed to exist by name.
//   * **Stage names.** `In Progress`, `In Review`, `Triage`, `Backlog` sat in `--status`
//     arguments inside shipped skill text — instructions an agent runs against the TENANT's
//     board. The platform addresses a stage by SLOT; CTC-1597 renamed Triage to Intake
//     mid-flight and CTC-1740/CTC-1885 are the fallout.
//
// ## Why a stage name REFUSES and a label name DEFAULTS
//
// The same split lib/cloud-facts.mjs documents, applied one layer up.
//
// A label name fails CLOSED and immediately: `resolveTeamLabelIds` asks Linear for that name on
// that team and gets nothing, so a wrong default is reported at the call site before anything is
// written. Defaulting it costs a tenant one clear error message.
//
// A stage name fails SILENTLY and late. `linearis issues list --status "In Progress"` against a
// board whose stage is called "Building" returns an EMPTY LIST, not an error — the briefing says
// nothing is in flight and reads exactly like a quiet morning. That is the shape AGENTS.md's
// positive-control rule exists to stop, so {@link resolveStateName} returns a NAMED failure for a
// tenant that declares a stateMap without the slot, and only bootstraps a repo that has declared
// no stateMap at all. It is the same rule, and deliberately the same wording, as
// linear-transition.sh's refusal — that script stays the single source of truth for the WRITE
// path; this is the read path's view of the same table, kept in lockstep by the suite.
//
// ## Zero-npm-import leaf
//
// node:fs / node:os / node:path only, for the same reason lib/tenant-identity.mjs and
// lib/cloud-facts.mjs state: `catalyst doctor` and the bare-Node agent tools import this class of
// module without a `bun install`, so it may never pull a package.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The committed contract file — the ONE place a canonical tenant literal is written down. */
export const CONTRACT_PATH = join(dirname(fileURLToPath(import.meta.url)), "tenant-contract.default.json");

/**
 * The canonical defaults, read from the contract at import.
 *
 * ⚠️ Read, never inlined. A hardcoded copy here would defeat the whole point: the deny-list scan
 * would then have two allowed sources and could not tell a drifted one from the contract.
 * A missing or malformed contract is a broken INSTALL, not a tenant condition, so it throws —
 * unlike every config read below, which treats absence as "try the next rung".
 */
export const CONTRACT = Object.freeze(JSON.parse(readFileSync(CONTRACT_PATH, "utf8")));

/**
 * The contract's ask labels as a plain frozen constant.
 *
 * ⭐ This is what a PURE consumer imports. `ask-wake.mjs` classifies an already-read detail record
 * with no IO and no process state, and `board-data.mjs`'s attention bucket is the same shape — both
 * kept their own frozen copy of this array precisely because importing `ask.mjs` would run its CLI
 * self-execution guard. A zero-npm leaf they CAN import collapses all three copies into one without
 * costing either of them its purity: the only IO is this module's own load-time contract read.
 * A caller that can afford IO should prefer {@link resolveAskLabelNames}, which is config-aware.
 */
export const CONTRACT_ASK_LABEL_NAMES = Object.freeze(CONTRACT.linear.askLabels.slice());

/** Config keys, in both layers. */
export const ASK_LABELS_CONFIG_PATH = "catalyst.linear.askLabels";
export const NOT_AN_ASK_CONFIG_PATH = "catalyst.linear.notAnAskLabel";
export const STATE_MAP_CONFIG_PATH = "catalyst.linear.stateMap";

/** Env overrides, for a one-shot run that must not edit config. */
export const ASK_LABELS_ENV = "CATALYST_ASK_LABELS";
export const NOT_AN_ASK_ENV = "CATALYST_NOT_AN_ASK_LABEL";

// resolveLayer1Path / resolveLayer2Path — deliberate mirrors of lib/tenant-identity.mjs's and
// lib/cloud-facts.mjs's pairs. Reads the INJECTED env, never process.env directly, so resolution
// stays pure and a test can hand in a whole fixture home. Layer 1 WALKS UP from cwd because agent
// tools run from wherever the agent happens to be.
function resolveLayer1Path(env, layer1ConfigPath, cwd = process.cwd()) {
  if (typeof layer1ConfigPath === "string" && layer1ConfigPath.length > 0) return layer1ConfigPath;
  const override = env?.CATALYST_CONFIG_FILE;
  if (typeof override === "string" && override.length > 0) return override;
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, ".catalyst", "config.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return resolve(cwd, ".catalyst", "config.json");
}

function resolveLayer2Path(env, layer2ConfigPath) {
  if (typeof layer2ConfigPath === "string" && layer2ConfigPath.length > 0) return layer2ConfigPath;
  const override = env?.CATALYST_LAYER2_CONFIG_FILE;
  if (typeof override === "string" && override.length > 0) return override;
  const home = typeof env?.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
  return resolve(home, ".config", "catalyst", "config.json");
}

// readConfigField — an absent, unreadable or malformed file and an absent key are the SAME answer:
// "nothing at this layer, try the next one". Never throws.
function readConfigField(path, dotted) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  let node = parsed;
  for (const segment of dotted.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[segment];
  }
  return node;
}

/** A trimmed non-empty string, or null. An empty/whitespace value is NOT a declaration. */
function declared(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * A declared list of label names: a JSON array of strings, or a comma-separated string (the env
 * form). Anything else — a number, an object, an array with a blank entry — is NOT a declaration
 * and falls through to the next rung rather than filing an ask under a label called "undefined".
 */
function declaredList(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;
  if (raw === null) return null;
  const names = raw.map((n) => declared(n)).filter((n) => n !== null);
  return names.length > 0 && names.length === raw.length ? names : null;
}

/**
 * resolveAskLabelNames — the labels every ask ticket carries on this tenant.
 *
 * @param {{env?: Record<string, string|undefined>, layer1ConfigPath?: string,
 *          layer2ConfigPath?: string}} [opts]
 * @returns {{names: string[], source: "env"|"layer1"|"layer2"|"contract"}}
 */
export function resolveAskLabelNames({ env = process.env, layer1ConfigPath, layer2ConfigPath } = {}) {
  const layer1 = resolveLayer1Path(env, layer1ConfigPath);
  const layer2 = resolveLayer2Path(env, layer2ConfigPath);

  const rungs = [
    ["env", declaredList(env?.[ASK_LABELS_ENV])],
    ["layer1", declaredList(readConfigField(layer1, ASK_LABELS_CONFIG_PATH))],
    ["layer2", declaredList(readConfigField(layer2, ASK_LABELS_CONFIG_PATH))],
    ["contract", CONTRACT.linear.askLabels.slice()],
  ];
  for (const [source, names] of rungs) {
    if (names == null) continue;
    return { names, source };
  }
  /* c8 ignore next — unreachable: the contract rung is never null. */
  return { names: CONTRACT.linear.askLabels.slice(), source: "contract" };
}

/**
 * resolveNotAnAskLabel — the label a human applies to release a false ask-shape hold (CTC-1752).
 *
 * @param {{env?: Record<string, string|undefined>, layer1ConfigPath?: string,
 *          layer2ConfigPath?: string}} [opts]
 * @returns {{name: string, source: "env"|"layer1"|"layer2"|"contract"}}
 */
export function resolveNotAnAskLabel({ env = process.env, layer1ConfigPath, layer2ConfigPath } = {}) {
  const layer1 = resolveLayer1Path(env, layer1ConfigPath);
  const layer2 = resolveLayer2Path(env, layer2ConfigPath);

  const rungs = [
    ["env", declared(env?.[NOT_AN_ASK_ENV])],
    ["layer1", declared(readConfigField(layer1, NOT_AN_ASK_CONFIG_PATH))],
    ["layer2", declared(readConfigField(layer2, NOT_AN_ASK_CONFIG_PATH))],
    ["contract", CONTRACT.linear.notAnAskLabel],
  ];
  for (const [source, name] of rungs) {
    if (name == null) continue;
    return { name, source };
  }
  /* c8 ignore next — unreachable: the contract rung is never null. */
  return { name: CONTRACT.linear.notAnAskLabel, source: "contract" };
}

/**
 * resolveStateName — what THIS tenant calls the stage in the given slot.
 *
 * Precedence mirrors linear-transition.sh exactly: a per-project stateMap for the team key, then
 * the global stateMap, then — only for a repo that has declared NO stateMap at all — the contract's
 * bootstrap name.
 *
 * ⛔ A tenant that declares a stateMap and omits the slot gets a NAMED REFUSAL, not our word for
 * its stage. "Declared" means EITHER map is non-empty, not "the first non-null one is": an empty
 * `stateMap: {}` on a matching project is still an object, so asking only the project's map reads a
 * populated GLOBAL map as "nothing declared" and falls through to the guess — the Codex P1 from
 * this ticket's first round, and precisely the tenant the guard exists for.
 *
 * @param {string} slot
 * @param {{team?: string, env?: Record<string, string|undefined>, layer1ConfigPath?: string}} [opts]
 * @returns {{ok: true, name: string, slot: string, source: "project"|"global"|"contract"}
 *          | {ok: false, reason: "unknown-slot"|"slot-not-mapped", slot: string, message: string}}
 */
export function resolveStateName(slot, { team, env = process.env, layer1ConfigPath } = {}) {
  const key = declared(slot);
  const bootstrap = key == null ? undefined : CONTRACT.linear.stateNames[key];
  if (bootstrap === undefined) {
    return {
      ok: false,
      reason: "unknown-slot",
      slot: String(slot),
      message:
        `'${slot}' is not a pipeline stage slot. Known slots: ` +
        `${Object.keys(CONTRACT.linear.stateNames).join(", ")}.`,
    };
  }

  const layer1 = resolveLayer1Path(env, layer1ConfigPath);
  const teamKey = declared(team) ?? declared(readConfigField(layer1, "catalyst.linear.teamKey"));

  const projects = readConfigField(layer1, "catalyst.projects");
  const project =
    Array.isArray(projects) && teamKey != null
      ? projects.find((p) => declared(p?.key)?.toUpperCase() === teamKey.toUpperCase())
      : undefined;
  const projectMap = project?.stateMap;
  const globalMap = readConfigField(layer1, STATE_MAP_CONFIG_PATH);

  const fromProject = declared(projectMap?.[key]);
  if (fromProject) return { ok: true, name: fromProject, slot: key, source: "project" };
  const fromGlobal = declared(globalMap?.[key]);
  if (fromGlobal) return { ok: true, name: fromGlobal, slot: key, source: "global" };

  const declaredCount = countKeys(projectMap) + countKeys(globalMap);
  if (declaredCount > 0) {
    return {
      ok: false,
      reason: "slot-not-mapped",
      slot: key,
      message:
        `no stage is mapped to '${key}'${teamKey ? ` for ${teamKey}` : ""} in ${layer1}. ` +
        "This tenant declares a stateMap, so its stage names are its own — refusing to substitute " +
        `this workspace's '${bootstrap}'. Add the '${key}' key to ${STATE_MAP_CONFIG_PATH} (or the ` +
        "project's own stateMap). A query against a stage name a board does not have returns an " +
        "EMPTY LIST, not an error.",
    };
  }
  return { ok: true, name: bootstrap, slot: key, source: "contract" };
}

function countKeys(node) {
  return node != null && typeof node === "object" && !Array.isArray(node) ? Object.keys(node).length : 0;
}
