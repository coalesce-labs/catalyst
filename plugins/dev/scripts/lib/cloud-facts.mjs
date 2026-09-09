// cloud-facts.mjs — CTL-2300. WHERE the cloud is and WHAT it will let a host spend, read
// from the tenant's own config instead of baked into the tools.
//
// ## What this replaces
//
// CTL-2299 took the person-shaped literals out of the plugin (lib/tenant-identity.mjs).
// This is the same move for the two cloud-shaped ones that were measurably WRONG on
// 2026-09-09, both of them silent:
//
//   * **A retired host as the default.** `execution-core/linear-write-proxy.mjs` and
//     `execution-core/cloud-sync.mjs` both defaulted to
//     `https://api.catalyst-cloud.coalescelabs.ai/api/v1`, a host catalyst-cloud's own
//     AGENTS.md lists as legacy and being retired, while `relay-narrate.ts` in that repo
//     defaulted to `staging.catalystcloud.dev`. Two skill trees, two different hosts, and
//     the canonical domain is neither of the two spelled `catalyst-cloud.coalescelabs.ai`.
//     A customer who installs the bundle and exports nothing writes to a host that is not
//     theirs and is going away.
//   * **A budget an order of magnitude below the real one.** `linear-write-budget.mjs`
//     mirrored the cloud's daily host write cap as `300`. The cloud raised it to `3000`
//     in CTC-796 and the host copy never moved, so a host that is legitimately busy
//     announces "day exhausted" at a tenth of its actual allowance.
//
// ## The ladder
//
//   baseUrl:  env.CATALYST_CLOUD_BASE_URL  →  layer1 catalyst.cloud.baseUrl
//                                          →  layer2 catalyst.cloud.baseUrl
//                                          →  DEFAULT_CLOUD_BASE_URL
//   budget:   env.CATALYST_HOST_DAILY_WRITE_BUDGET  →  layer1 catalyst.cloud.hostDailyWriteBudget
//                                                   →  layer2 catalyst.cloud.hostDailyWriteBudget
//                                                   →  DEFAULT_HOST_DAILY_WRITE_BUDGET
//
// Layer 1 is the committed, per-repo `.catalyst/config.json` (override:
// `CATALYST_CONFIG_FILE`); Layer 2 is the per-machine `~/.config/catalyst/config.json`
// (override: `CATALYST_LAYER2_CONFIG_FILE`). Same two layers, resolved the same way, as
// lib/tenant-identity.mjs and lib/deployment-mode.mjs — an operator who has learned one
// config ladder has learned all of them.
//
// ## ⭐ WHY THIS ONE KEEPS A DEFAULT WHERE tenant-identity.mjs REFUSES
//
// tenant-identity.mjs has no fallback on purpose: a human id or a team key that is wrong
// is UNDETECTABLE, because the write lands somewhere plausible. The cloud host is the
// opposite — a wrong host fails closed at the first request (DNS, TLS or 401), loudly and
// immediately, and every fleet host today runs with `CATALYST_CLOUD_BASE_URL` provisioned.
// Refusing to start without config would break every one of them to prevent a failure the
// network already reports. So the ladder ends in the CANONICAL value, not in a refusal.
//
// ## ⛔ BUT A RETIRED HOST IS REFUSED FROM EVERY RUNG, INCLUDING env
//
// The one thing that must never resolve is the value this ticket exists to delete. A
// retired host reaching the wire is not a config choice, it is the drift — so
// `resolveCloudBaseUrl` returns a NAMED failure when any rung produces one, rather than
// passing it through because "the operator asked for it". That check is what makes
// deleting the literal from the two modules durable: re-adding it as an env default, a
// config value or a third module's constant fails the same way.
//
// ## Zero-npm-import leaf
//
// node:fs / node:os / node:path only, for the same reason lib/tenant-identity.mjs and
// lib/deployment-mode.mjs state: `catalyst doctor` and the bare-Node agent tools import
// this class of module without a `bun install`, so it may never pull a package.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The canonical Catalyst Cloud domain. `staging.` is the live host until the CTC-433 DNS cutover. */
export const CANONICAL_CLOUD_HOST = "staging.catalystcloud.dev";

/**
 * Hosts that must never resolve, from any rung.
 *
 * ⚠️ Matched as a SUBSTRING of the hostname, not by equality: the retired estate is a whole
 * zone (`*.catalyst-cloud.coalescelabs.ai`), and an equality check would pass a sibling
 * hostname on the same dying zone.
 */
export const RETIRED_CLOUD_HOST_SUFFIXES = Object.freeze(["catalyst-cloud.coalescelabs.ai"]);

/** Where a host writes when the tenant has not said otherwise. Ends in `/api/v1` by contract. */
export const DEFAULT_CLOUD_BASE_URL = `https://${CANONICAL_CLOUD_HOST}/api/v1`;

/**
 * The cloud's own per-host daily Linear write cap, mirrored for the exhaustion signal.
 *
 * ⛔ THIS NUMBER IS A MIRROR, NOT A POLICY. The cloud enforces it
 * (`apps/mirror/src/do/write-budget.ts`, `DEFAULT_HOST_DAILY_WRITE_BUDGET`); the host copy
 * only decides when to ANNOUNCE exhaustion. Setting it higher than the cloud's makes the
 * announcement late; setting it lower — which is what 300-versus-3000 did — makes a healthy
 * host stop announcing capacity it still has. Move it only when the cloud's moves.
 */
export const DEFAULT_HOST_DAILY_WRITE_BUDGET = 3000;

/** The config key that carries the base URL, in both layers. */
export const BASE_URL_CONFIG_PATH = "catalyst.cloud.baseUrl";
/** The config key that carries the mirrored daily write budget, in both layers. */
export const WRITE_BUDGET_CONFIG_PATH = "catalyst.cloud.hostDailyWriteBudget";

// resolveLayer1Path / resolveLayer2Path — deliberate mirrors of lib/tenant-identity.mjs's
// pair (which mirrors lib/deployment-mode.mjs's). Reads the INJECTED env, never
// process.env directly, so resolution stays pure and a test can hand in a whole fixture
// home. Layer 1 WALKS UP from cwd for the reason tenant-identity.mjs records: agent tools
// run from wherever the agent happens to be, and a cwd-only check would refuse for a repo
// that is plainly configured one directory down.
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

// readConfigField — an absent, unreadable or malformed file and an absent key are the SAME
// answer: "nothing at this layer, try the next one". Never throws. Same contract as
// tenant-identity.mjs's copy.
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
 * isRetiredCloudHost — does this URL point at the retired estate?
 *
 * ⚠️ Parsed as a URL, then matched on the HOSTNAME. A substring test over the whole string
 * would also fire on a path or a query parameter that merely mentions the old host —
 * including this file's own documentation of it — which would make the guard unusable in
 * the one place it has to be correct. An unparseable string is not a retired host; it is a
 * malformed one, and {@link resolveCloudBaseUrl} reports that separately.
 */
export function isRetiredCloudHost(url) {
  let hostname;
  try {
    hostname = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return false;
  }
  return RETIRED_CLOUD_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

/**
 * resolveCloudBaseUrl — the base URL every host-side cloud call is built on.
 *
 * @param {{env?: Record<string, string|undefined>, layer1ConfigPath?: string,
 *          layer2ConfigPath?: string}} [opts]
 * @returns {{ok: true, baseUrl: string, source: "env"|"layer1"|"layer2"|"default"}
 *          | {ok: false, reason: "retired-host"|"malformed-url", source: string,
 *             value: string, message: string}}
 */
export function resolveCloudBaseUrl({ env = process.env, layer1ConfigPath, layer2ConfigPath } = {}) {
  const layer1 = resolveLayer1Path(env, layer1ConfigPath);
  const layer2 = resolveLayer2Path(env, layer2ConfigPath);

  const rungs = [
    ["env", declared(env?.CATALYST_CLOUD_BASE_URL)],
    ["layer1", declared(readConfigField(layer1, BASE_URL_CONFIG_PATH))],
    ["layer2", declared(readConfigField(layer2, BASE_URL_CONFIG_PATH))],
    ["default", DEFAULT_CLOUD_BASE_URL],
  ];

  for (const [source, value] of rungs) {
    if (value == null) continue;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return {
        ok: false,
        reason: "malformed-url",
        source,
        value,
        message:
          `the cloud base URL from ${source} is not a URL: ${value}. ` +
          `Expected an absolute https URL ending in /api/v1, e.g. ${DEFAULT_CLOUD_BASE_URL}.`,
      };
    }
    if (isRetiredCloudHost(parsed)) {
      return {
        ok: false,
        reason: "retired-host",
        source,
        value,
        message:
          `the cloud base URL from ${source} points at the RETIRED host ${parsed.hostname}: ` +
          `${value}. The canonical host is ${CANONICAL_CLOUD_HOST}. Set ` +
          `${BASE_URL_CONFIG_PATH} in ${layer1} or ${layer2}, or export ` +
          "CATALYST_CLOUD_BASE_URL. Writes to the retired estate are not this tenant's.",
      };
    }
    return { ok: true, baseUrl: value, source };
  }

  /* c8 ignore next — unreachable: the `default` rung is never null. */
  return { ok: true, baseUrl: DEFAULT_CLOUD_BASE_URL, source: "default" };
}

/**
 * resolveHostDailyWriteBudget — the cloud's daily per-host write cap, as this host believes
 * it. Display and exhaustion-signal only; the cloud enforces its own.
 *
 * ⚠️ A non-numeric, zero or negative configured value falls through to the next rung rather
 * than being honoured. A budget of `0` reads as "refuse every write", which is an outage a
 * typo should not be able to cause on a mirror of somebody else's number.
 *
 * @param {{env?: Record<string, string|undefined>, layer1ConfigPath?: string,
 *          layer2ConfigPath?: string}} [opts]
 * @returns {{budget: number, source: "env"|"layer1"|"layer2"|"default"}}
 */
export function resolveHostDailyWriteBudget({
  env = process.env,
  layer1ConfigPath,
  layer2ConfigPath,
} = {}) {
  const layer1 = resolveLayer1Path(env, layer1ConfigPath);
  const layer2 = resolveLayer2Path(env, layer2ConfigPath);

  const rungs = [
    ["env", env?.CATALYST_HOST_DAILY_WRITE_BUDGET],
    ["layer1", readConfigField(layer1, WRITE_BUDGET_CONFIG_PATH)],
    ["layer2", readConfigField(layer2, WRITE_BUDGET_CONFIG_PATH)],
  ];

  for (const [source, raw] of rungs) {
    if (raw == null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) continue;
    return { budget: n, source };
  }
  return { budget: DEFAULT_HOST_DAILY_WRITE_BUDGET, source: "default" };
}
