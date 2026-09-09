// tenant-identity.mjs — CTL-2299. WHO the human is, WHICH team their asks are filed on,
// and WHAT the status doc calls them — all read from the tenant's own config instead of
// baked into the tools.
//
// ## What this replaces
//
// Three Ryan-shaped literals sat in the machinery and the skill text, so a customer who
// installed the plugin bundle and joined their own tenant still ran a fleet-owner's
// workspace:
//
//   * `ask.mjs`'s assignee default and `replica-comment-read.mjs`'s DEFAULT_ASK_HUMAN_ID
//     were both the string `c2a8cc92-…` — one specific Linear user in one workspace;
//   * `ask/references/creating.md` hard-coded that id AND `--team CTL`;
//   * `steward/references/status-doc.md` templated a `Needs from <one person's name>`
//     heading, so every tenant's status doc asked its own human for the fleet owner.
//
// A default that names a person is not a default: on any other tenant it resolves to a
// user who does not exist there. The ask is then assigned to nobody, the "latest human
// comment" query filters on an author id that authored nothing, and the ONLY symptom is
// silence — the exact shape of failure AGENTS.md's positive-control rule exists to stop.
// So this module has NO person-shaped fallback at all: it resolves from config or it
// returns a NAMED failure the caller can print.
//
// ## The ladder
//
//   humanId:  env.ASK_HUMAN_ID  →  layer1 catalyst.human.linearUserId
//                               →  layer2 catalyst.human.linearUserId  →  named failure
//   team:     explicit arg      →  env.ASK_TEAM
//                               →  layer1 catalyst.linear.teamKey      →  named failure
//   name:     env.ASK_HUMAN_NAME →  layer1/layer2 catalyst.human.name  →  null
//
// Layer 1 is the committed, per-repo `.catalyst/config.json` (override:
// `CATALYST_CONFIG_FILE`); Layer 2 is the per-machine `~/.config/catalyst/config.json`
// (override: `CATALYST_LAYER2_CONFIG_FILE`). Both path resolvers are deliberate
// near-verbatim mirrors of lib/deployment-mode.mjs and lib/entitlement.mjs — the same two
// layers, resolved the same way, so an operator who has learned one config ladder has
// learned all of them. Layer 2 is consulted for the human because a host runs agent tools
// from MANY checkouts (catalyst, catalyst-cloud, a customer repo) and the human answering
// for that host is a property of the host, not of whichever directory the tool was
// launched in.
//
// ## Why a display name is allowed to be absent but an id is not
//
// The id is load-bearing — a wrong or missing one silently mis-files the ask. The name is
// only prose, so `statusDocHumanHeading()` falls back to "the human", which is correct on
// every tenant and reads as deliberate rather than as a placeholder someone forgot.
//
// ## Zero-npm-import leaf
//
// node:fs / node:os / node:path only, for the same reason lib/deployment-mode.mjs states:
// `catalyst doctor` and the bare-Node agent tools import this class of module without a
// `bun install`, so it may never pull a package.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The config key that carries the human, in both layers. */
export const HUMAN_CONFIG_PATH = "catalyst.human.linearUserId";

/** What a status doc calls the human when the tenant has not named one. */
export const UNNAMED_HUMAN = "the human";

// resolveLayer1Path / resolveLayer2Path — mirrors of lib/deployment-mode.mjs's pair.
// Reads the INJECTED env (never process.env directly) so resolution stays pure and a test
// can hand in a whole fixture home.
//
// ⚠️ The Layer-1 rung WALKS UP from cwd, where deployment-mode.mjs only checks cwd itself.
// That is deliberate and it is the same walk lib/secret-contract.mjs's
// resolveLegacyPerTeamConfigPath and linear-comment-post.sh's `_find_layer2_config` already
// do: these identities are read by agent TOOLS, which run from wherever the agent happens
// to be — a package subdirectory, a `__tests__` folder, a worktree's `plugins/dev/scripts`.
// A cwd-only check would refuse for a repo that is plainly configured, one directory down.
// The walk stops at the FIRST ancestor carrying a `.catalyst/config.json`, so a nested
// checkout never reads its parent's tenant.
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
  // Nothing found: return the cwd-relative path anyway, so the refusal message names the
  // file the operator would create rather than a path that only exists in this function.
  return resolve(cwd, ".catalyst", "config.json");
}

function resolveLayer2Path(env, layer2ConfigPath) {
  if (typeof layer2ConfigPath === "string" && layer2ConfigPath.length > 0) return layer2ConfigPath;
  const override = env?.CATALYST_LAYER2_CONFIG_FILE;
  if (typeof override === "string" && override.length > 0) return override;
  const home = typeof env?.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
  return resolve(home, ".config", "catalyst", "config.json");
}

// readConfigField — pull a dotted path out of a JSON config file. An absent, unreadable or
// malformed file and an absent key are the SAME answer here — "nothing at this layer, try
// the next one" — which is the readLayer2NodeClass contract the other resolvers share.
// Never throws.
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
 * resolveAskHuman — the Linear user id an ask is assigned to and whose comments count as
 * "the human's" on this tenant.
 *
 * @param {{env?: Record<string, string|undefined>, layer1ConfigPath?: string,
 *          layer2ConfigPath?: string}} [opts]
 * @returns {{ok: true, humanId: string, name: string|null,
 *            source: "env"|"layer1"|"layer2"}
 *          | {ok: false, reason: "human-not-configured", message: string}}
 */
export function resolveAskHuman({ env = process.env, layer1ConfigPath, layer2ConfigPath } = {}) {
  const layer1 = resolveLayer1Path(env, layer1ConfigPath);
  const layer2 = resolveLayer2Path(env, layer2ConfigPath);

  const name =
    declared(env?.ASK_HUMAN_NAME) ??
    declared(readConfigField(layer1, "catalyst.human.name")) ??
    declared(readConfigField(layer2, "catalyst.human.name"));

  const fromEnv = declared(env?.ASK_HUMAN_ID);
  if (fromEnv) return { ok: true, humanId: fromEnv, name, source: "env" };

  const fromLayer1 = declared(readConfigField(layer1, HUMAN_CONFIG_PATH));
  if (fromLayer1) return { ok: true, humanId: fromLayer1, name, source: "layer1" };

  const fromLayer2 = declared(readConfigField(layer2, HUMAN_CONFIG_PATH));
  if (fromLayer2) return { ok: true, humanId: fromLayer2, name, source: "layer2" };

  return {
    ok: false,
    reason: "human-not-configured",
    message:
      `no human is configured for this tenant. Set ${HUMAN_CONFIG_PATH} in ${layer1} ` +
      `(committed, per-repo) or ${layer2} (per-machine), or export ASK_HUMAN_ID. ` +
      "This resolver will not guess a person on your behalf — an ask assigned to a user " +
      "who does not exist on your workspace fails silently.",
  };
}

/**
 * resolveAskTeam — the Linear team key an ask is filed on. An explicit `team` (a `--team`
 * flag) always wins: a decision may belong to a team other than the repo's own.
 *
 * @param {{team?: unknown, env?: Record<string, string|undefined>,
 *          layer1ConfigPath?: string}} [opts]
 * @returns {{ok: true, team: string, source: "explicit"|"env"|"layer1"}
 *          | {ok: false, reason: "team-not-configured", message: string}}
 */
export function resolveAskTeam({ team, env = process.env, layer1ConfigPath } = {}) {
  const explicit = declared(team);
  if (explicit) return { ok: true, team: explicit, source: "explicit" };

  const fromEnv = declared(env?.ASK_TEAM);
  if (fromEnv) return { ok: true, team: fromEnv, source: "env" };

  const layer1 = resolveLayer1Path(env, layer1ConfigPath);
  const fromLayer1 = declared(readConfigField(layer1, "catalyst.linear.teamKey"));
  if (fromLayer1) return { ok: true, team: fromLayer1, source: "layer1" };

  return {
    ok: false,
    reason: "team-not-configured",
    message:
      `no ask team resolved. Pass --team, or set catalyst.linear.teamKey in ${layer1}. ` +
      "Filing on a guessed team puts the ask on a board nobody is watching.",
  };
}

/**
 * statusDocHumanHeading — the status doc's second heading, named for whoever this tenant's
 * human is. Takes the resolver's own result so a caller cannot accidentally pass an id
 * where a display name belongs.
 *
 * @param {ReturnType<typeof resolveAskHuman>|{name?: unknown}} [human]
 * @returns {string}
 */
export function statusDocHumanHeading(human) {
  return `## Needs from ${declared(human?.name) ?? UNNAMED_HUMAN}`;
}
