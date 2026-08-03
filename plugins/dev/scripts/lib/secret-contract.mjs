// secret-contract.mjs — CTL-1616: the canonical secret registry + resolution engine.
//
// WHY THIS FILE EXISTS. The 2026-08-02 fleet 401 outage was four divergent hand-written
// copies of one secret-resolution chain (CTL-1612 fixed the github-token/webhook-secret
// instance). Every OTHER secret in the fleet inventory is still the pre-CTL-1612 failure
// class today: 9 files/12 sites hand-roll `LINEAR_API_TOKEN ?? LINEAR_API_KEY`, 3 divergent
// Linear OAuth-mint Layer-2 fallback chains, 2 divergent CATALYST_CLOUD_TOKEN name
// resolvers, 2 divergent GROQ_API_KEY ladders, 6 divergent Layer-2-path resolvers. This
// module is the ONE named secret contract every one of those call sites will eventually
// fold onto: a frozen registry of per-secret FACTS (§2 of the design), walked by a small
// closed provider-type ENGINE (~7 delivery-type cases whose bash/JS parity cost is fixed,
// not per-secret).
//
// THIS PR IS THE FIRST ISOLATION SLICE — ZERO CONSUMERS. Nothing outside this file's own
// tests imports it yet. cluster-sync.mjs's ENV_BACKED_SECRET_EXACT/isEnvBackedSecretFile,
// catalyst-secret-env.sh's catalyst_project_github_token/_webhook_secret, and
// github-auth-preflight.mjs's githubTokenFileCandidates/rearmGithubTokenFromFile are ALL
// left untouched here — re-pointing them onto this registry is later-PR work (CTL-1616
// design §9, PR1 proper). This file exists in isolation, exactly the way
// lib/deployment-mode.mjs (CTL-1617 PR1) landed before any consumer moved onto it.
//
// REGISTRY IS CODE, NOT JSON (design §2, judge-mandated). A runtime-jq-parsed
// secret-contract.json on the boot-critical path would convert six independently-divergent
// resolution chains into one CORRELATED single point of failure, and would reimport the
// bash-JSON fragility class the CTL-1617 parity work spent an entire remediation round
// documenting (a bare `// empty` swallows JSON `false`; NUL bytes die at the $() boundary;
// [[:space:]] is locale data; multi-document/BOM files parse differently per language).
// SECRET_REGISTRY is a frozen in-module data constant that both this file's engine AND
// lib/catalyst-secret-contract.sh's independently-maintained bash mirror encode — two
// physical copies, one logical source, held honest by the row-id-set-equality assertion in
// __tests__/secret-contract-parity.test.sh.
//
// ZERO-IMPORT LEAF (node:fs / node:os / node:path only) — same rationale as
// lib/deployment-mode.mjs: doctor.mjs runs under bare Node and must import this without
// pulling execution-core/config.mjs's bun:sqlite-reaching module graph. This also means the
// real rearm/mint IMPLEMENTATIONS (rearmGithubTokenFromFile, the linear-remint.mjs
// reminters) can never be baked into this leaf's static row data — they are registered
// AGAINST rows from execution-core, in a later PR, via registerRearmHook() below (design §3:
// "the mint action and rearm hooks stay in their execution-core homes ... and are registered
// against rows"). See the "REARM-HOOK SEAM" comment on registerRearmHook for how PR1 proves
// that seam works before any real hook exists.
//
// NAMING RULE, mirrored from lib/deployment-mode.mjs: every WARN/log/comment in this file
// says "deployment mode" fully qualified where it discusses CTL-1617's resolution object —
// never bare "mode" (this codebase already has 3 unrelated "mode" concepts).

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";

// ─── The closed enums ───────────────────────────────────────────────────────

// SECRET_DELIVERY — the ~7 provider TYPES the engine dispatches on. Design §3's own stated
// goal is that parity cost scales per TYPE, not per row — every one of the 11 seed rows maps
// onto exactly one of these.
export const SECRET_DELIVERY = Object.freeze([
  "bare-file", // a single standalone secret file (github-token, webhook-secret)
  "bare-file-family", // an open-ended prefix family of files (linear-webhook-secret-<team>)
  "env-file", // a whole env file SOURCED at boot, not a scalar value (claude-accounts.env)
  "env-alias", // a pure process.env alias ladder, no file at all (linear-api-token)
  "config-json", // env alias (if any) then a dotted path inside the resolved Layer-2 JSON
  "platform-env", // a platform-injected env var whose NAME is itself resolved (cloud-token)
  "local-only", // presence-checked only, value never fetched (age-key)
]);

// ROTATION_CLASSES — generalizes cluster-sync.mjs's "CAPTURED AT PROCESS START" prose
// (design §6) into structured data. "n/a" exists only for local-only rows: age-key is never
// value-resolved, so "rotated" is not a question this contract can answer for it (doctor's
// assessMaterialization owns that signal instead — design §5/§7).
export const ROTATION_CLASSES = Object.freeze(["boot-only", "re-armable", "n/a"]);
export const ROTATION_TRIGGERS = Object.freeze(["timer", "on-401"]);

// ─── The registry ────────────────────────────────────────────────────────────
//
// Row shape (design §2): { id, envNames, delivery, configJsonPath, rotation, bootstrapFor }.
// `id` doubles as the SOPS bare-file basename for bare-file/bare-file-family/env-file rows.
// `familyPrefix` is present only on the one bare-file-family row. `defaultLocalPath` is
// present only on the one local-only row. All rows and the registry array itself are frozen
// — this is DATA, walked by the engine below, never mutated at runtime. (Per-row `rearmHook`
// state — which design §2's row-shape example shows as a field on the row — lives instead in
// the separate, explicitly-mutable `_rearmHooks` side table below the engine: a frozen row
// cannot itself hold a hook a later PR registers. See registerRearmHook's docstring.)
export const SECRET_REGISTRY = Object.freeze(
  [
    {
      id: "github-token",
      envNames: ["GH_TOKEN", "GITHUB_TOKEN"],
      delivery: "bare-file",
      configJsonPath: null,
      rotation: { class: "re-armable", trigger: "timer" },
      bootstrapFor: null,
    },
    {
      id: "webhook-secret",
      envNames: ["CATALYST_WEBHOOK_SECRET"],
      delivery: "bare-file",
      configJsonPath: null,
      // Boot-only per design §2: orch-monitor's loadWebhookConfig() captures this once at
      // boot (catalyst-secret-env.sh:226-230's own comment). Open Question 5 (design §12)
      // asks whether this should upgrade to timer-re-armable in a follow-up — left boot-only
      // here, matching the seed table.
      rotation: { class: "boot-only" },
      bootstrapFor: null,
    },
    {
      id: "linear-webhook-secret",
      envNames: [],
      delivery: "bare-file-family",
      // The per-team secrets are an open-ended FAMILY, not fixed names — absorbed from
      // cluster-sync.mjs's LINEAR_WEBHOOK_SECRET_PREFIX (":644") and isEnvBackedSecretFile
      // (":648-655"). Matched case-insensitively, requiring at least one character after the
      // dash, so the bare prefix "linear-webhook-secret-" and a run-on like
      // "linear-webhook-secretXXX" both stay OUT — see isSecretFamilyMember below, which
      // mirrors that predicate exactly (not wired to cluster-sync in THIS PR).
      familyPrefix: "linear-webhook-secret-",
      configJsonPath: null,
      rotation: { class: "boot-only" },
      bootstrapFor: null,
    },
    {
      id: "claude-accounts.env",
      envNames: [],
      delivery: "env-file",
      configJsonPath: null,
      // Sourced into the daemon's boot env by catalyst-execution-core; kept as a REGISTRY
      // ROW (design §2) — not a parallel hand-maintained Set — so cluster-sync's
      // rotation-report source is the registry once PR1-of-the-migration-plan re-points it.
      rotation: { class: "boot-only" },
      bootstrapFor: null,
    },
    {
      id: "execution-core.env",
      envNames: [],
      delivery: "env-file",
      configJsonPath: null,
      rotation: { class: "boot-only" },
      bootstrapFor: null,
    },
    {
      id: "linear-api-token",
      envNames: ["LINEAR_API_TOKEN", "LINEAR_API_KEY"],
      delivery: "env-alias",
      configJsonPath: null,
      // Folds the 9-file/12-site inline `LINEAR_API_TOKEN ?? LINEAR_API_KEY` read (design §8
      // PR3) — including the CTL-1619 alias-drop regression at linear-reconcile-cli.mjs:209.
      // Re-armable/on-401: a cooldown-guarded reminter, once registered (design PR4's
      // linear-remint.mjs), re-mints on an observed 401 — reactive, not a timer.
      rotation: { class: "re-armable", trigger: "on-401" },
      bootstrapFor: null,
    },
    {
      id: "linear-orchestrator-actor",
      envNames: [],
      delivery: "config-json",
      configJsonPath: "catalyst.linear.bot.orchestrator",
      // Deliberately a SEPARATE row from linear-worker-actor (judge-unanimous graft, design
      // §2) — they mint identically and differ only in this config path; collapsing them is
      // an easy wrong refactor a future PR must not make.
      rotation: { class: "re-armable", trigger: "on-401" },
      bootstrapFor: null,
    },
    {
      id: "linear-worker-actor",
      envNames: [],
      delivery: "config-json",
      // Primary tier only. linear-comment-post.sh's 3-tier chain (bot.worker → legacy
      // catalyst.linear.agent → legacy per-team) is preserved VERBATIM in its own file per
      // design §8 PR4 — this row's single configJsonPath is the primary tier; the legacy
      // tiers are a PR4 concern, not duplicated here (design explicitly defers their
      // deprecation to a follow-up ticket, design §6/§12 Q6).
      configJsonPath: "catalyst.linear.bot.worker",
      // Boot-only (per-call mint) per the seed table — distinct from the orchestrator actor,
      // which is proactively re-armed on a timer-adjacent cooldown reminter.
      rotation: { class: "boot-only" },
      bootstrapFor: null,
    },
    {
      id: "groq-api-key",
      envNames: ["GROQ_API_KEY"],
      delivery: "config-json",
      // Provider modeled on lib/api-key-health.mjs's resolveApiKey (env → config), the one
      // already-adopted ladder (broker/config.mjs:45-53) — config-json's generic
      // env-alias-then-json-path chain covers this without a dedicated 8th delivery type.
      configJsonPath: "groq.apiKey",
      rotation: { class: "boot-only" },
      bootstrapFor: null,
    },
    {
      id: "cloud-token",
      // The DEFAULT env-var name only — the actual var name is itself resolved (see
      // resolveCloudTokenName below), mirroring resolveNodeCloudTokenEnv's 3-tier ladder
      // (execution-core/config.mjs:1949-1957): env override → Layer-2 name override →
      // this default.
      envNames: ["CATALYST_CLOUD_TOKEN"],
      delivery: "platform-env",
      // Holds the NAME-OVERRIDE dotted path (catalyst.cloud.tokenEnv), not the secret value.
      configJsonPath: "catalyst.cloud.tokenEnv",
      rotation: { class: "boot-only" },
      bootstrapFor: "cloud",
    },
    {
      id: "age-key",
      // SOPS_AGE_KEY_FILE is the threaded override (cluster-sync.mjs:140); the row's
      // envNames holds that override name so resolveLocalOnlyPresence can honor it uniformly
      // with every other row's env-override convention, WITHOUT ever reading the file's
      // contents through it — see resolveLocalOnlyPresence.
      envNames: ["SOPS_AGE_KEY_FILE"],
      delivery: "local-only",
      configJsonPath: null,
      defaultLocalPath: [".config", "catalyst", "age.key"],
      // "n/a", not boot-only: this contract never fetches the KEY VALUE at all (presence-only
      // — the never-fetched local-only contract), so "did it rotate" is not a question this
      // engine can answer for it. assessMaterialization (cluster-sync.mjs:686) remains the
      // authoritative decrypt-health signal (design §5/§7 risk 5).
      rotation: { class: "n/a" },
      bootstrapFor: "cluster",
    },
  ].map((row) => Object.freeze(row)),
);

// getSecretRow — the id → row lookup every engine function starts from. Returns undefined
// for an unknown id (never throws).
export function getSecretRow(id) {
  return SECRET_REGISTRY.find((r) => r.id === id);
}

// isSecretFamilyMember — the linear-webhook-secret family PREDICATE, absorbed verbatim from
// cluster-sync.mjs's isEnvBackedSecretFile/LINEAR_WEBHOOK_SECRET_PREFIX (":644-655") — NOT
// wired to cluster-sync in this PR (that re-point is later-migration-plan work), but the
// predicate itself is reproduced exactly so a later PR's before/after parity assertion
// (design §2's "same-commit derivation constraint") has a byte-for-byte reference to diff
// against. Case-insensitive on the whole filename; requires at least one character after the
// dash so the bare prefix "linear-webhook-secret-" and a run-on "linear-webhook-secretXXX"
// both stay OUT.
export function isSecretFamilyMember(filename) {
  if (typeof filename !== "string" || filename.length === 0) return false;
  const row = getSecretRow("linear-webhook-secret");
  const prefix = row?.familyPrefix ?? "linear-webhook-secret-";
  const name = filename.toLowerCase();
  return name.startsWith(prefix) && name.length > prefix.length;
}

// ─── Layer-2 path resolution — the §2 canonical chain ───────────────────────
//
// DELIBERATELY NOT lib/deployment-mode.mjs's resolveLayer2Path (design §2 flaw-resolution
// paragraph, verified): that function deliberately mirrors execution-core/config.mjs's
// non-XDG-aware getLayer2ConfigPath. This chain is the OTHER one — the one
// install-lifecycle.mjs's layer2Path(), lib/linear-app-actor.sh:30, linear-remint.mjs:43-51,
// and lib/plugin-dirs.sh:25 already use:
//   CATALYST_LAYER2_CONFIG_FILE > CATALYST_MACHINE_CONFIG > $XDG_CONFIG_HOME/catalyst/config.json
//   > ~/.config/catalyst/config.json
// Fully env-injectable (no direct process.env/homedir() reads outside the `env` param), so
// tests can redirect every input without touching the real filesystem — same isolation
// contract as githubTokenFileCandidates(env).
export function resolveLayer2Path(env = process.env) {
  const explicit = env?.CATALYST_LAYER2_CONFIG_FILE;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const machineConfig = env?.CATALYST_MACHINE_CONFIG;
  if (typeof machineConfig === "string" && machineConfig.length > 0) return machineConfig;
  const home = typeof env?.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
  const xdg = typeof env?.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(xdg, "catalyst", "config.json");
}

// readJsonField — pull a dotted-path value out of a JSON file EXACTLY as written (whatever
// JSON type), or undefined for absent/malformed/unreadable/null (the readLayer2NodeClass
// contract, deployment-mode.mjs's identical convention). PARITY GUARD: a STRING value
// carrying an embedded NUL escape (e.g. `"c\u0000loud"` — valid JSON, jq accepts it fine
// too) is treated as undefined here — NOT because JSON.parse can't hold it (it can, the
// full string round-trips through readFileSync/JSON.parse intact), but because both callers
// of this function (resolveConfigJson, resolveCloudTokenName) return that value through this
// module's own resolveSecret/probe boundary via `printf`/console output in the bash mirror
// and this file's own test/parity harnesses, which — like every `$(...)` command
// substitution in bash — silently DROP a NUL byte on capture (verified: bash prints "ignored
// null byte in input" and truncates). Without this guard, this file would return the FULL
// NUL-containing string as a "resolved" value while the bash mirror's
// _csc_read_json_string tags the identical input @NONSTR — a real parity divergence, caught
// by __tests__/secret-contract-parity.test.sh's hostile NUL-escape-in-JSON-string probe.
// Rejecting it HERE (not just at the transport boundary) means a NUL-containing config-json
// value degrades to "not found" identically in both languages, exactly like a non-string
// value already does. Reuses the same containsNul() helper readFirstNonBlankFile uses
// below (function declarations hoist, so the later definition is available here) rather
// than a second copy.
function readJsonField(filePath, dottedPath) {
  if (!dottedPath) return undefined;
  try {
    const doc = JSON.parse(readFileSync(filePath, "utf8"));
    let cur = doc;
    for (const part of dottedPath.split(".")) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[part];
    }
    if (typeof cur === "string" && containsNul(cur)) return undefined;
    return cur;
  } catch {
    return undefined;
  }
}

// ─── Bare-file candidate search — generalizes githubTokenFileCandidates ─────

// explicitFileOverrideEnvName — the per-row explicit-override env var, e.g. "github-token" →
// CATALYST_GITHUB_TOKEN_FILE (matching the existing CATALYST_GITHUB_TOKEN_FILE /
// CATALYST_WEBHOOK_SECRET_FILE convention exactly).
export function explicitFileOverrideEnvName(id) {
  return `CATALYST_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_FILE`;
}

// secretFileCandidates(id, env) — the resolution CHAIN, in priority order, generalizing
// execution-core/github-auth-preflight.mjs's githubTokenFileCandidates (":84-99") to any
// bare-file row's basename. Explicit override → CATALYST_CONFIG_DIR → cluster-sync's own
// destination dir (dirname(resolveLayer2Path)) → XDG dir. Never throws.
export function secretFileCandidates(id, env = process.env) {
  const override = env?.[explicitFileOverrideEnvName(id)];
  if (typeof override === "string" && override.length > 0) return [override];
  if (typeof env?.CATALYST_CONFIG_DIR === "string" && env.CATALYST_CONFIG_DIR.length > 0) {
    return [join(env.CATALYST_CONFIG_DIR, id)];
  }
  const home = typeof env?.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
  const layer2 = typeof env?.CATALYST_LAYER2_CONFIG_FILE === "string" && env.CATALYST_LAYER2_CONFIG_FILE.length > 0
    ? env.CATALYST_LAYER2_CONFIG_FILE
    : join(home, ".config", "catalyst", "config.json");
  const out = [join(dirname(layer2), id)];
  const xdgBase = typeof env?.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(home, ".config");
  const xdg = join(xdgBase, "catalyst", id);
  if (!out.includes(xdg)) out.push(xdg);
  return out;
}

// stripEol — mirrors _catalyst_strip_eol (lib/catalyst-secret-env.sh) and the identical
// regex in github-auth-preflight.mjs's rearmGithubTokenFromFile: strip ONLY trailing line
// terminators, preserve every other byte (a signing secret may legitimately begin/end with a
// significant space).
function stripEol(raw) {
  return String(raw ?? "").replace(/[\r\n]+$/, "");
}

function isBlank(value) {
  return value.replace(/[ \t\n\r\f\v]/g, "").length === 0;
}

// containsNul — PARITY GUARD (CTL-1617 hard-won lesson, generalized from JSON to raw file
// bytes): a bash `$(cat "$file")` command substitution silently TRUNCATES at the first NUL
// byte — bash variables cannot represent one. readFileSync has no such limitation and would
// see the full value, including the embedded NUL, which JS would then treat as a genuine
// (if odd) credential while bash would see only a truncated PREFIX and treat THAT as the
// credential — two different values for the same file. Reject any candidate carrying a NUL
// on BOTH sides (this file, and the bash mirror's analogous file-candidate loop) so a
// NUL-containing file falls through to the next candidate identically everywhere, rather
// than silently disagreeing on the resolved value.
function containsNul(value) {
  return value.includes("\u0000");
}

function readFirstNonBlankFile(candidates) {
  for (const file of candidates) {
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (containsNul(raw)) continue;
    const val = stripEol(raw);
    if (!isBlank(val)) return { value: val, filePath: file };
  }
  return null;
}

// ─── Per-delivery-type resolvers (the ~7 engine cases, §3) ──────────────────

function resolveEnvAliasOnly(row, env) {
  for (const name of row.envNames ?? []) {
    const v = env?.[name];
    if (typeof v === "string" && v.length > 0) {
      return { value: v, source: "inherited", provider: row.delivery, rotation: row.rotation, envName: name };
    }
  }
  return { value: null, source: "none", provider: row.delivery, rotation: row.rotation };
}

function resolveBareFile(row, env) {
  const candidates = secretFileCandidates(row.id, env);
  const explicitOverride = env?.[explicitFileOverrideEnvName(row.id)];
  const hit = readFirstNonBlankFile(candidates);
  if (hit) {
    const source = typeof explicitOverride === "string" && explicitOverride.length > 0 ? "operator-override" : "shared-file";
    return { value: hit.value, source, provider: row.delivery, rotation: row.rotation, filePath: hit.filePath };
  }
  // No shared file anywhere — fall back to whatever alias is already inherited (matches
  // catalyst_project_github_token's "elif GH_TOKEN inherited" rung).
  const inherited = resolveEnvAliasOnly(row, env);
  if (inherited.value != null) return inherited;
  return { value: null, source: "none", provider: row.delivery, rotation: row.rotation };
}

function resolveBareFileFamily(row) {
  // A family row has no single scalar value (design §2's own framing: it is a PREDICATE,
  // not a resolvable secret). Callers that need per-team membership use
  // isSecretFamilyMember(filename) directly.
  return { value: null, source: null, provider: row.delivery, rotation: row.rotation };
}

function resolveEnvFilePresence(row, env) {
  const candidates = secretFileCandidates(row.id, env);
  for (const file of candidates) {
    try {
      const st = statSync(file);
      if (st.isFile() && st.size > 0) {
        return { value: file, source: "shared-file", provider: row.delivery, rotation: row.rotation };
      }
    } catch {
      continue;
    }
  }
  return { value: null, source: "none", provider: row.delivery, rotation: row.rotation };
}

function resolveConfigJson(row, env) {
  if ((row.envNames ?? []).length > 0) {
    const viaEnv = resolveEnvAliasOnly(row, env);
    if (viaEnv.value != null) return viaEnv;
  }
  const path = resolveLayer2Path(env);
  const raw = readJsonField(path, row.configJsonPath);
  if (typeof raw === "string" && raw.length > 0) {
    return { value: raw, source: "config-json", provider: row.delivery, rotation: row.rotation, filePath: path };
  }
  return { value: null, source: "none", provider: row.delivery, rotation: row.rotation };
}

// resolveCloudTokenName — cloud-token's two-step resolution: first the env-var NAME (env
// override → Layer-2 catalyst.cloud.tokenEnv → default CATALYST_CLOUD_TOKEN, mirroring
// resolveNodeCloudTokenEnv, execution-core/config.mjs:1949-1957), THEN that variable's
// VALUE. Mode-independent: cloud-token is always platform-env delivery regardless of
// deployment mode, so this never touches a file.
function resolveCloudTokenName(row, env) {
  const nameOverride = env?.CATALYST_CLOUD_TOKEN_ENV;
  let envVar, envVarSource;
  if (typeof nameOverride === "string" && nameOverride.length > 0) {
    envVar = nameOverride;
    envVarSource = "env";
  } else {
    const l2Path = resolveLayer2Path(env);
    const l2Name = readJsonField(l2Path, row.configJsonPath);
    if (typeof l2Name === "string" && l2Name.length > 0) {
      envVar = l2Name;
      envVarSource = "layer2";
    } else {
      envVar = row.envNames[0];
      envVarSource = "default";
    }
  }
  const value = env?.[envVar];
  if (typeof value === "string" && value.length > 0) {
    return { value, source: "platform-env", provider: row.delivery, rotation: row.rotation, envVar, envVarSource };
  }
  return { value: null, source: "none", provider: row.delivery, rotation: row.rotation, envVar, envVarSource };
}

// resolveLocalOnlyPresence — age-key. PRESENCE-CHECKED, NEVER VALUE-RESOLVED (design §5's
// "never-fetched local-only contract" — fetching it here would be circular: the key that
// unlocks every other cluster secret cannot itself be delivered by the chain it unlocks).
// Uses statSync only — this function must never call readFileSync on the candidate path.
function resolveLocalOnlyPresence(row, env) {
  const override = env?.[row.envNames?.[0]];
  const home = typeof env?.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
  const path = typeof override === "string" && override.length > 0 ? override : resolvePath(home, ...(row.defaultLocalPath ?? []));
  let present = false;
  try {
    present = existsSync(path) && statSync(path).isFile();
  } catch {
    present = false;
  }
  return {
    value: present ? path : null,
    source: present ? "present" : "absent",
    provider: row.delivery,
    rotation: row.rotation,
  };
}

// ─── The public engine ───────────────────────────────────────────────────────

// resolveSecret(id, { env, deploymentMode }) — never throws (deployment-mode contract,
// design §3). Returns { value, source, provider, rotation, ...delivery-type-specific extras
// } for a known row, or { value: null, source: null, provider: null, rotation: null } for an
// unknown id.
//
// CLOUD GUARD (design §4): the cloud branch activates ONLY when
// deploymentMode.mode === "cloud" AND deploymentMode.inferred === false — never on a guess.
// Because the guard lives HERE in the shared engine, every row gets it for free; no
// per-secret guard to forget (mirrors the CTL-1617 §8 mandate this registry consumes). When
// genuinely cloud, resolution short-circuits to a pure env-alias read of envNames — NO FILE
// SEARCH EVER, matching CTL-1617 §4's "a slot, honestly scoped" cloud provider. When NOT
// genuinely cloud (single-host, cluster, or an inferred/unrecognized cloud guess), the normal
// per-delivery-type file/config chain runs — this is the "never skips the file chain for
// single-host/cluster" invariant design §4/§9 mandates as an explicit test assertion.
//
// BOOTSTRAP SHORT-CIRCUIT (design §4 rule 2): in genuine cloud mode, if the cloud
// bootstrap-class row (cloud-token, bootstrapFor: "cloud") fails to resolve, every OTHER
// cloud-mode resolution returns { value: null, source: null } without probing further — a
// half-provisioned managed container fails loudly and coherently. The bootstrap row itself
// is exempt (it must resolve on its own terms) and resolveCloudTokenName never triggers this
// check (recursion terminates in one level: cloud-token's own resolution never consults
// `deploymentMode`).
export function resolveSecret(id, { env = process.env, deploymentMode } = {}) {
  const row = getSecretRow(id);
  if (!row) return { value: null, source: null, provider: null, rotation: null };

  const useCloud = deploymentMode?.mode === "cloud" && deploymentMode?.inferred === false;

  if (useCloud) {
    if (row.bootstrapFor !== "cloud") {
      const bootstrapRow = SECRET_REGISTRY.find((r) => r.bootstrapFor === "cloud");
      if (bootstrapRow) {
        const bootstrapResolved = resolveSecret(bootstrapRow.id, { env });
        if (bootstrapResolved.value == null) {
          return { value: null, source: null, provider: row.delivery, rotation: row.rotation };
        }
      }
    }
    return resolveEnvAliasOnly(row, env);
  }

  switch (row.delivery) {
    case "bare-file":
      return resolveBareFile(row, env);
    case "bare-file-family":
      return resolveBareFileFamily(row);
    case "env-file":
      return resolveEnvFilePresence(row, env);
    case "env-alias":
      return resolveEnvAliasOnly(row, env);
    case "config-json":
      return resolveConfigJson(row, env);
    case "platform-env":
      return resolveCloudTokenName(row, env);
    case "local-only":
      return resolveLocalOnlyPresence(row, env);
    default:
      // Unreachable for any row in SECRET_REGISTRY — defensive, never throws.
      return { value: null, source: null, provider: row.delivery, rotation: row.rotation };
  }
}

// ─── Rearm-hook seam + armSecret ─────────────────────────────────────────────
//
// REARM-HOOK SEAM (design §3/§6, Open Question 4). The row shape's `rearmHook` field in
// design §2's pseudocode cannot live ON the frozen row object in THIS leaf: the real
// implementations (rearmGithubTokenFromFile, the linear-remint.mjs cooldown reminters) live
// in execution-core and would violate the zero-import contract if baked in here, and PR1 is
// explicitly zero-consumer — nothing has registered a hook yet. So the seam is realized as a
// separate, explicitly MUTABLE side table (`_rearmHooks`), kept OUT of the frozen registry,
// that a later PR populates via registerRearmHook(id, fn) from execution-core — exactly where
// design §3 says the hook implementations belong ("registered against rows"). This table is
// EMPTY for every row in this PR; see armSecret's degrade behavior below for what that means
// in practice, and secret-contract.test.mjs's "registry validation (§6)" suite for the tests
// that prove both halves of the mechanism (hookless degrade, and hook-present pickup) work
// correctly before any real hook exists.
const _rearmHooks = new Map();

// registerRearmHook(id, fn) — attach an in-process rearm implementation to a row. Returns
// true on success, false (never throws) when: the id is unknown, the row's declared
// rotation.class is not "re-armable" (design §6 rule 2, the CAPABILITY-CEILING rule — a
// boot-only row's ceiling does not support an arm hook, registering one against it would be
// misleading), or fn is not a function.
export function registerRearmHook(id, fn) {
  const row = getSecretRow(id);
  if (!row || row.rotation?.class !== "re-armable" || typeof fn !== "function") return false;
  _rearmHooks.set(id, fn);
  return true;
}

// clearRearmHook(id) — test/reset seam. Returns true iff a hook was registered and removed.
export function clearRearmHook(id) {
  return _rearmHooks.delete(id);
}

// _lastArmedValue — the boot-time/last-observed-value snapshot per row id, used by the
// hookless degrade path below to decide "did the provider-of-record value change since last
// arm". Module-level mutable state, same pattern as getDeploymentMode's _warnedDeploymentMode
// dedup Set (lib/deployment-mode.mjs) — deliberate: armSecret's whole contract is to observe
// change ACROSS repeated calls over a daemon's lifetime.
const _lastArmedValue = new Map();

// resetArmState(id) — test seam: clear the remembered baseline for one row (or every row when
// id is omitted), so a fresh armSecret call re-establishes the baseline instead of comparing
// against another test's leftover state.
export function resetArmState(id) {
  if (id === undefined) {
    _lastArmedValue.clear();
    return;
  }
  _lastArmedValue.delete(id);
}

// armSecret(id, { env }) — never throws. Returns { armed, rotated, restartRequired }.
//
// TWO PATHS, per design §6:
//
// 1. HOOK PATH — rotation.class === "re-armable" AND a hook is currently registered
//    (registerRearmHook): the hook performs the actual in-process rearm (e.g. re-read the
//    shared file and update process.env, as rearmGithubTokenFromFile will once PR-of-a-later-
//    migration-step registers it). A successful in-process rearm never requires a restart —
//    that is the whole point of "re-armable". restartRequired is always false on this path.
//
// 2. HOOKLESS-DEGRADE PATH — every other case (boot-only rows, "n/a" rows, AND — this is the
//    PR1-specific state — every re-armable row that has NOT had a hook registered against it
//    yet, since nothing has in this isolation slice). Design §6 rule 1 says a hookless
//    re-armable row is "structurally forced boot-only" by a registry-validation test failing;
//    THIS implementation realizes that as a RUNTIME degrade instead of a load-time assertion,
//    because the real hooks are execution-core-owned and do not exist inside this zero-import
//    leaf yet — asserting their presence at registry-load time in PR1 would be asserting
//    something that is honestly not yet true. The degrade itself is the same shape armSecret
//    would give an actual boot-only row: resolve fresh, diff against the last-observed value,
//    and report restartRequired: true iff it changed — the literal Gherkin-Scenario-2
//    mechanism (design §6), proven correct here before any real hook exists. See
//    secret-contract.test.mjs's registry-validation suite for the explicit assertion that
//    every SEED re-armable row currently has NO hook registered (self-documenting: this list
//    must shrink as later PRs call registerRearmHook, and the test will need updating then —
//    that is by design, not an oversight).
export function armSecret(id, { env = process.env } = {}) {
  const row = getSecretRow(id);
  if (!row) return { armed: false, rotated: false, restartRequired: false };

  if (row.rotation?.class === "n/a") {
    return { armed: false, rotated: false, restartRequired: false };
  }

  const hook = _rearmHooks.get(id);
  if (row.rotation?.class === "re-armable" && typeof hook === "function") {
    let result;
    try {
      result = hook({ env });
    } catch {
      return { armed: false, rotated: false, restartRequired: false };
    }
    const rotated = Boolean(result?.rearmed);
    return { armed: rotated, rotated, restartRequired: false };
  }

  // Hookless degrade path (covers boot-only rows AND hookless re-armable rows identically).
  const resolved = resolveSecret(id, { env });
  const current = resolved.value ?? null;
  const hadBaseline = _lastArmedValue.has(id);
  const previous = _lastArmedValue.get(id) ?? null;
  _lastArmedValue.set(id, current);

  if (!hadBaseline) {
    // First observation establishes the boot-time baseline — nothing has "rotated" relative
    // to a baseline that did not exist yet.
    return { armed: false, rotated: false, restartRequired: false };
  }
  // restartRequired mirrors `rotated` exactly on this path: reaching here already means
  // either a genuine boot-only row OR a hookless re-armable row, and design §6 rule 1's
  // honesty requirement is that BOTH degrade identically (a consumer that never wires the
  // arm path must not appear safer than one that never could).
  const rotated = current !== previous;
  return { armed: false, rotated, restartRequired: rotated };
}
