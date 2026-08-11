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
      // Primary (NEW global) tier: catalyst.linear.bot.worker.
      configJsonPath: "catalyst.linear.bot.worker",
      // CTL-1616 PR4 (append-only row extension, design §8/§9): the row shipped in PR1/PR3
      // encoded only the primary tier — linear-comment-post.sh's OWN four-rung chain (an
      // env-credential-pair tier checked BEFORE any config read, then two MORE legacy
      // config-json tiers below the primary) is folded on here VERBATIM rather than left as
      // a parallel hand-rolled chain in that script. Deprecating the legacy tiers is an
      // explicit follow-up ticket (design §12 Q6) — every tier below is preserved exactly,
      // not collapsed.
      //
      // credentialEnvPair — CATALYST_LINEAR_AGENT_CLIENT_ID/_SECRET, checked FIRST (ahead of
      // even the primary configJsonPath tier), mirroring linear-comment-post.sh's own
      // precedence: an operator-set env pair always wins over every config file. Resolved as
      // a canonical {clientId, clientSecret} object (source "inherited"), the same shape a
      // config-json tier resolves to — see resolveConfigJson's ENV-PAIR TIER.
      credentialEnvPair: {
        clientId: "CATALYST_LINEAR_AGENT_CLIENT_ID",
        clientSecret: "CATALYST_LINEAR_AGENT_CLIENT_SECRET",
      },
      // requiredObjectFields — CTL-1616 PR4 remediation (B1 fix). The old linear-comment-post.sh
      // advanced to the NEXT tier whenever clientId OR clientSecret was empty after a tier's
      // read (`[[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]`); canonicalizeConfigJsonValue's
      // "any non-null value wins" rule (needed elsewhere so a legitimately-empty `{}` or a
      // credential-free object like {webhookSecret, botUserId} — a REALISTIC production
      // shape — still round-trips through the engine) let a tier holding exactly one of
      // those shapes capture resolution instead of falling through, so the caller then
      // hard-failed on the empty fields rather than reaching a deeper, fully-populated
      // tier. Declaring the row's required object fields HERE (a data fact any config-json
      // tier resolver can consult generically via meetsRequiredObjectFields, below — never a
      // hardcoded `row.id === "linear-worker-actor"` special case) restores the old
      // script's per-tier advance rule for every tier this row declares (env pair, primary,
      // and both legacy tiers) without changing behavior for any row that does NOT declare
      // this field (e.g. linear-orchestrator-actor, which has no fallback chain to advance
      // down in the first place).
      //
      // TWO CROSS-ENGINE CANON RULES (round-2 remediation, B3 fix — both empirically pinned
      // against `git show origin/main:.../linear-comment-post.sh` run in a hermetic fixture,
      // see __tests__/secret-contract-parity.test.sh's "string-shape" / "newline-only"
      // cells):
      //
      // 1. A bare STRING value at a gated tier's path ALWAYS falls through, even when that
      //    string's own CONTENT happens to parse as JSON holding every required field (e.g.
      //    the tier stores '"{\"clientId\":\"x\",\"clientSecret\":\"y\"}"' — a STRING, not an
      //    object). meetsRequiredObjectFields's `typeof raw !== "object"` guard already
      //    rejects this on the JS side (raw is the untouched parsed value — a string is never
      //    reinterpreted as JSON here). The bash mirror needed an explicit fix for this: its
      //    _csc_meets_required_object_fields pipes the ALREADY-DECODED value back into `jq`
      //    for the field check, and jq happily re-parses a string's own text as JSON —
      //    incorrectly treating object-shaped string CONTENT as a winning object. The fix
      //    (_csc_config_json_tag_accepted) gates on the `_csc_read_json_string` TAG itself
      //    (@OBJ64: vs @STR64:) — which losslessly records the ORIGINAL value's type — instead
      //    of re-deriving type from decoded text, so a tagged-@STR64 value can never reach the
      //    object field-check at all when the row declares requiredObjectFields. (Empirically,
      //    the actual PRE-FOLD script does NEITHER "win" NOR "cleanly fall through" for this
      //    exact shape: `jq -r '.clientId // empty'` errors trying to index a string, and under
      //    the script's own `set -euo pipefail` that CRASHES the whole process (verified: exit
      //    5) rather than advancing to the next tier. "Falls through" is the safer canon this
      //    contract picks for both engines — matching current JS and never crashing — since a
      //    hard abort is not a reproducible-in-both-engines behavior to mirror.)
      //
      // 2. A field is "empty" (fails the gate) using the SAME trailing-EOL-stripped emptiness
      //    stripEol() already applies to bare-file values — NOT raw `.length > 0`. Pinned
      //    empirically: the OLD script's `CLIENT_ID=$(jq -r '...clientId // empty' "$FILE")`
      //    command-substitution silently strips ALL trailing newline bytes from jq's captured
      //    output, so a field holding the single character "\n" captures as CLIENT_ID="" and
      //    `[[ -z "$CLIENT_ID" ]]` correctly advances to the next tier. A bare JS
      //    `raw[field].length > 0` check does NOT reproduce this (a lone "\n" has length 1 —
      //    JS previously WON a tier the old script would have advanced past). See
      //    meetsRequiredObjectFields below, which now runs each field through stripEol()
      //    before the length check.
      requiredObjectFields: ["clientId", "clientSecret"],
      // legacyConfigTiers — tried, in order, ONLY once credentialEnvPair AND the primary
      // configJsonPath tier both miss. "per-team-legacy" mirrors _find_layer2_config's
      // directory walk-up for a projectKey-keyed config-<key>.json (see
      // resolveLegacyPerTeamConfigPath); "global-legacy" reads the SAME global catalyst.linear
      // agent key from the canonical Layer-2 file the primary tier already reads.
      legacyConfigTiers: [
        { scope: "per-team-legacy", configJsonPath: "catalyst.linear.agent" },
        { scope: "global-legacy", configJsonPath: "catalyst.linear.agent" },
      ],
      // Boot-only (per-call mint) per the seed table — distinct from the orchestrator actor,
      // which is proactively re-armed on a timer-adjacent cooldown reminter.
      rotation: { class: "boot-only" },
      bootstrapFor: null,
    },
    {
      id: "linear-heartbeat-actor",
      envNames: [],
      delivery: "config-json",
      configJsonPath: "catalyst.linear.bot.heartbeat",
      // CAT-157: this is deliberately a separate OAuth application from the
      // orchestrator/worker actors so heartbeat traffic owns its quota bucket.
      rotation: { class: "re-armable", trigger: "on-401" },
      requiredObjectFields: ["clientId", "clientSecret"],
      bootstrapFor: null,
    },
    {
      id: "linear-heartbeat-api-token",
      envNames: ["CATALYST_HEARTBEAT_APP_ACTOR_TOKEN"],
      delivery: "env-alias",
      configJsonPath: null,
      rotation: { class: "re-armable", trigger: "on-401" },
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
  ].map((row) => deepFreeze(row)),
);

// deepFreeze — Object.freeze only makes the OUTER object immutable; a row's nested
// envNames/defaultLocalPath arrays and rotation object were previously left mutable, so
// `getSecretRow("linear-api-token").envNames.push("EVIL")` or
// `resolveSecret(id).rotation.class = "boot-only"` would silently corrupt shared registry
// state for the rest of the process (every later resolution, hook registration, and arm
// call reads the SAME frozen-row object) — exactly the "frozen registry" contract this
// module's own header promises but didn't fully deliver. Recursively freezes every
// object/array reachable from a row so a mutation attempt THROWS (strict-mode ESM) instead
// of silently succeeding, for every accessor that returns a piece of registry data by
// reference (getSecretRow, resolveSecret's `rotation` field, etc.) — "frozen" satisfies the
// design's "return frozen or cloned structures" requirement without needing a clone on
// every call.
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

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

// resolveLegacyPerTeamConfigPath — CTL-1616 PR4. Mirrors linear-comment-post.sh's
// _find_layer2_config VERBATIM: walk `cwd` upward looking for a `.catalyst/config.json`,
// read its `.catalyst.projectKey` (nested) or bare top-level `.projectKey` (legacy layout),
// and build the sibling per-team file name `config-<key>.json`. The ONE deliberate
// generalization (matching every other row's dirname(layer2)-relative-to-canonical-chain
// convention, e.g. secretFileCandidates): the sibling file lives next to the CANONICAL
// resolveLayer2Path(env) directory, not a hardcoded `${HOME}/.config/catalyst` literal — this
// row's own PRIMARY tier already reads through resolveLayer2Path (a decision that predates
// this PR), so the per-team legacy file tracks the same directory rather than reintroducing a
// second, independently-hardcoded location.
//
// Falls back to resolveLayer2Path(env) itself when no projectKey is found anywhere in the
// ancestry (matching the script's own "falls back to the global path" behavior) — this
// function stays silent (zero-import-leaf convention: no console output from this file); the
// LOUD stderr warning the pre-fold script emits on that fallback is the CALLER's
// responsibility (lib/catalyst-secret-contract.sh's mirror keeps it, since it is what
// linear-comment-post.sh's test suite asserts against).
export function resolveLegacyPerTeamConfigPath(env = process.env, cwd = process.cwd()) {
  let dir = cwd;
  for (;;) {
    const cfg = join(dir, ".catalyst", "config.json");
    if (existsSync(cfg)) {
      try {
        const parsed = JSON.parse(readFileSync(cfg, "utf8"));
        const key = parsed?.catalyst?.projectKey ?? parsed?.projectKey;
        if (typeof key === "string" && key.length > 0) {
          return join(dirname(resolveLayer2Path(env)), `config-${key}.json`);
        }
      } catch {
        /* malformed ancestor config — keep walking, matches the script's `|| true` swallow */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return resolveLayer2Path(env);
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
// hasLiveLoneHighSurrogateEscape — CTL-1617 JSON-acceptance-normalization lesson, mirroring
// jq 1.7.1's OWN acceptance rule exactly rather than the earlier (over-rejecting) regex
// guard this replaces. Verified against real jq 1.7.1 (`jq --version` ⇒ jq-1.7.1-apple):
//   - a lone HIGH surrogate escape (\uD800-\uDBFF, unpaired) ⇒ jq exits 5, rejects the WHOLE
//     document.
//   - a lone LOW surrogate escape (\uDC00-\uDFFF, unpaired) ⇒ jq exits 0 and substitutes
//     U+FFFD for it — ACCEPTED, not rejected.
//   - a valid HIGH+LOW pair ⇒ accepted, forms the intended astral character.
// So only a live, unpaired HIGH escape must reject the document; a live lone LOW is fine
// (handled at the value-extraction boundary below, via toWellFormed()).
//
// "Live" is the key subtlety the old regex guard got wrong (E6): a backslash run of ODD
// length immediately before a `u` means the LAST backslash actually escapes that `u` (every
// preceding pair of backslashes is itself one escaped literal backslash) — a genuine
// \uXXXX escape. An EVEN-length run means every backslash pairs off as a literal backslash
// and the following "uXXXX" is ordinary LITERAL TEXT, not an escape at all — e.g. the JSON
// string source `"literal \\ud800 text"` (an escaped backslash followed by the 5 literal
// characters "ud800") parses to the harmless string `literal \ud800 text` and must NOT
// reject the document, even though the old regex — which only looked for a bare `\uXXXX`
// substring, blind to what preceded the backslash — matched it and killed the whole read.
//
// Scans the RAW file text (before JSON.parse), matching jq's whole-document rejection
// semantics: a live unpaired HIGH escape ANYWHERE in the document — even outside the field
// being read — is what makes jq unable to produce ANY value from the file at all.
function hasLiveLoneHighSurrogateEscape(text) {
  const re = /(\\+)u([0-9a-fA-F]{4})/g;
  const liveMatches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const isLive = m[1].length % 2 === 1;
    if (!isLive) continue;
    liveMatches.push({ index: m.index, end: m.index + m[0].length, code: parseInt(m[2], 16) });
  }
  for (let i = 0; i < liveMatches.length; i++) {
    const cur = liveMatches[i];
    if (cur.code < 0xd800 || cur.code > 0xdbff) continue; // not a HIGH surrogate
    const next = liveMatches[i + 1];
    const isPaired = next != null && next.index === cur.end && next.code >= 0xdc00 && next.code <= 0xdfff;
    if (!isPaired) return true;
  }
  return false;
}

// toWellFormedString — normalizes a JS string so any lone (unpaired) surrogate code unit is
// replaced with U+FFFD, mirroring what jq 1.7.1 already did AT PARSE TIME for a live lone LOW
// surrogate escape (verified above). JSON.parse itself performs no such normalization — a
// parsed JS string can carry a raw lone-low code unit straight through — so this is applied
// explicitly at the value-extraction boundary (readJsonField's string-typed return), not
// inside JSON.parse itself, so every OTHER caller of a parsed document (e.g. object/array
// traversal above) still sees the untouched string. Uses the native
// String.prototype.toWellFormed() where available (Node/bun both support it); falls back to
// a manual code-unit walk on a runtime that lacks it.
function toWellFormedString(str) {
  if (typeof str.toWellFormed === "function") return str.toWellFormed();
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += str[i] + str[i + 1];
        i++;
      } else {
        out += "�";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "�";
    } else {
      out += str[i];
    }
  }
  return out;
}

function readJsonField(filePath, dottedPath) {
  if (!dottedPath) return undefined;
  try {
    const text = readFileSync(filePath, "utf8");
    // NOTE: a leading UTF-8 BOM and multi-document content are NOT special-cased here —
    // JSON.parse already rejects both natively (verified: a leading U+FEFF and any
    // non-whitespace trailing a complete top-level value both throw SyntaxError), matching
    // jq's own BOM-tolerant-but-multi-doc-tolerant behavior once the bash mirror's
    // BOM-sniff + --slurp length check (design §5) settle those two cases to @ABSENT. Only
    // the unpaired-HIGH-surrogate-escape direction needs an explicit JS-side guard (above) —
    // a lone LOW escape is accepted by both engines (see hasLiveLoneHighSurrogateEscape).
    if (hasLiveLoneHighSurrogateEscape(text)) return undefined;
    const doc = JSON.parse(text);
    let cur = doc;
    for (const part of dottedPath.split(".")) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[part];
    }
    if (typeof cur === "string") {
      if (containsNul(cur)) return undefined;
      // WELL-FORMED NORMALIZATION (mirrors jq's own lone-LOW-surrogate replacement, done at
      // parse time on the bash side) — applied ONLY here, at the value-extraction boundary,
      // per-value, not to the whole parsed document.
      return toWellFormedString(cur);
    }
    return cur;
  } catch {
    return undefined;
  }
}

// canonicalJsonStringify — deterministic (sorted-key, recursive) JSON serialization, used
// ONLY to canonicalize an object-shaped config-json value (see canonicalizeConfigJsonValue
// below). Sorting keys makes the output independent of source-file field order AND of any
// difference between JS's/jq's default object-iteration order, so the bash mirror's
// `walk(if type == "object" then to_entries | sort_by(.key) | from_entries else . end) |
// tojson` produces the BYTE-IDENTICAL string for the same input (verified at authoring
// time: `{"clientSecret":"s3cr3t","clientId":"abc123"}` canonicalizes to
// `{"clientId":"abc123","clientSecret":"s3cr3t"}` on both sides).
function canonicalJsonStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// canonicalizeConfigJsonValue — the config-json engine's value-acceptance rule (design §2
// finding fix: the AUTHORITATIVE Layer-2 schema stores catalyst.linear.bot.orchestrator/
// .worker as OBJECTS — {clientId, clientSecret, ...} — not strings; a resolver that only
// accepted strings made both actor rows permanently resolve to "none" for every valid
// production config, which the pre-fix test suite masked by fixturing a
// JSON-STRING-CONTAINING-JSON instead of a real object). Accepts a non-empty, NUL-free
// STRING as-is (the pre-existing groq-api-key/generic shape), or a plain OBJECT (not an
// array), canonicalized via canonicalJsonStringify so a future consumer can
// JSON.parse(resolved.value) and pull out clientId/clientSecret — the row's value
// semantics this finding asks for. Arrays/booleans/numbers stay rejected (unchanged
// BLOCKING-1 "never silently coerced" contract: a bare `false` at a config-json path is
// "none", not truthy). NOTE: this generic object-acceptance is scoped to config-json ROW
// resolution only — resolveCloudTokenName (below) deliberately keeps its OWN strict
// string-only check on the SAME underlying readJsonField call, since a NAME override can
// only ever be a plain env-var-name string.
function canonicalizeConfigJsonValue(raw) {
  if (typeof raw === "string") {
    return raw.length > 0 ? raw : null;
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const canon = canonicalJsonStringify(raw);
    return containsNul(canon) ? null : canon;
  }
  return null;
}

// meetsRequiredObjectFields — CTL-1616 PR4 remediation (B1 fix; round-2 B3 fix below). A row
// that declares requiredObjectFields (currently only linear-worker-actor's {clientId,
// clientSecret} shape) must have EVERY named field present in the RAW parsed value as a
// non-empty (post-EOL-strip — see round-2 fix below) string before a config-json tier is
// allowed to WIN — mirrors linear-comment-post.sh's own
// `[[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]` per-tier advance check exactly. A row with
// no requiredObjectFields declared is unaffected (returns true unconditionally, matching
// today's behavior for every other config-json row).
//
// `typeof raw !== "object"` (below) is also what implements CANON RULE 1 from the
// requiredObjectFields row-field comment above: a bare STRING raw value (even one whose own
// text parses as a fully-populated credential object) is rejected here WITHOUT ever being
// reparsed as JSON — this function only ever inspects the type jq/JSON.parse already gave the
// value at the config path, never the string's own contents. Operates on the RAW value
// (before canonicalizeConfigJsonValue's string-serialization), so this gate composes cleanly
// with that function rather than re-parsing its output.
//
// ROUND-2 B3 FIX: each field's emptiness check now runs the value through stripEol() first —
// CANON RULE 2 above — instead of a bare `.length > 0`. A field holding only a trailing
// newline (e.g. "\n") now correctly fails the gate (falls through) exactly like the OLD
// script's command-substitution-stripped capture did, rather than winning on raw length.
function meetsRequiredObjectFields(row, raw) {
  if (!row.requiredObjectFields) return true;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  return row.requiredObjectFields.every((field) => typeof raw[field] === "string" && stripEol(raw[field]).length > 0);
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
//
// EXPORTED (with isValidUtf8RoundTrip below) as the CANONICAL malformed-file validators:
// execution-core's rearmGithubTokenFromFile applies the identical gates to its own
// re-read of the github-token file, and a private parallel copy there could drift and
// re-open the exact resolver-rejects/hook-installs split these guards exist to close.
// Still zero-import: exporting pure helpers adds no dependency to this leaf.
export function containsNul(value) {
  return value.includes("\u0000");
}

// isValidUtf8RoundTrip — PARITY GUARD (generalizes the NUL-byte/JSON-acceptance lessons
// above to raw file bytes): Node's readFileSync(file, "utf8") REPLACES any invalid UTF-8
// byte sequence with U+FFFD (the Unicode replacement character) rather than failing — a
// bare-file secret containing a stray non-UTF-8 byte (e.g. a leading 0xFF 0xFE) would
// silently decode to a MUTATED credential in JS, while the bash mirror's `cat` preserves
// the original bytes exactly. Neither behavior is safe to prefer over the other: a
// credential that cannot round-trip UTF-8 identically cannot be represented identically in
// both engines, so this file REJECTS the candidate on both sides (falls through to the
// next candidate, matching the NUL-byte candidate's degrade shape) rather than silently
// serving whichever language's mutated/unmutated view happens to run first. Detected via a
// byte round-trip: decode as UTF-8, re-encode, and compare against the original bytes —
// any invalid sequence fails to round-trip byte-for-byte.
// Exported alongside containsNul above — see that comment for why the two validators are
// the single canonical implementation shared with the rearm hook.
export function isValidUtf8RoundTrip(buf, decoded) {
  const reencoded = Buffer.from(decoded, "utf8");
  return reencoded.length === buf.length && reencoded.equals(buf);
}

function readFirstNonBlankFile(candidates) {
  for (const file of candidates) {
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      continue;
    }
    const raw = buf.toString("utf8");
    if (!isValidUtf8RoundTrip(buf, raw)) continue;
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

function resolveConfigJson(row, env, cwd) {
  // ENV-PAIR TIER (CTL-1616 PR4, linear-worker-actor only): checked BEFORE the primary
  // configJsonPath tier — mirrors linear-comment-post.sh's own precedence, where
  // CATALYST_LINEAR_AGENT_CLIENT_ID/_SECRET win over every config file. BOTH halves of the
  // pair must be present (an id with no secret, or vice versa, is not a usable credential —
  // matches the script's `[[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]` guard exactly).
  if (row.credentialEnvPair) {
    const idVal = env?.[row.credentialEnvPair.clientId];
    const secretVal = env?.[row.credentialEnvPair.clientSecret];
    if (
      typeof idVal === "string" && idVal.length > 0 &&
      typeof secretVal === "string" && secretVal.length > 0
    ) {
      const canon = canonicalJsonStringify({ clientId: idVal, clientSecret: secretVal });
      return { value: canon, source: "inherited", provider: row.delivery, rotation: row.rotation };
    }
  }
  if ((row.envNames ?? []).length > 0) {
    const viaEnv = resolveEnvAliasOnly(row, env);
    if (viaEnv.value != null) return viaEnv;
  }
  const path = resolveLayer2Path(env);
  const raw = readJsonField(path, row.configJsonPath);
  const resolved = canonicalizeConfigJsonValue(raw);
  if (resolved != null && meetsRequiredObjectFields(row, raw)) {
    return { value: resolved, source: "config-json", provider: row.delivery, rotation: row.rotation, filePath: path };
  }
  // LEGACY TIERS (CTL-1616 PR4, linear-worker-actor only): tried, in order, ONLY once the
  // primary tier misses — preserves linear-comment-post.sh's fallthrough exactly (design §8
  // PR4 / §9's "all three tiers preserved verbatim"). B1 fix: "misses" now means EITHER
  // absent OR (for a row declaring requiredObjectFields) present-but-incomplete — a lone
  // clientId, a credential-free object, or empty-string fields all continue the chain
  // instead of falsely capturing it.
  if (row.legacyConfigTiers) {
    for (const tier of row.legacyConfigTiers) {
      const tierPath = tier.scope === "per-team-legacy"
        ? resolveLegacyPerTeamConfigPath(env, cwd)
        : resolveLayer2Path(env);
      const tierRaw = readJsonField(tierPath, tier.configJsonPath);
      const tierResolved = canonicalizeConfigJsonValue(tierRaw);
      if (tierResolved != null && meetsRequiredObjectFields(row, tierRaw)) {
        return {
          value: tierResolved,
          source: "legacy-config-json",
          provider: row.delivery,
          rotation: row.rotation,
          filePath: tierPath,
          legacyScope: tier.scope,
        };
      }
    }
  }
  return { value: null, source: "none", provider: row.delivery, rotation: row.rotation };
}

// resolveCloudTokenName(env) — CTL-1616 PR5. NAME-ONLY resolution of the cloud-token row's
// env-var NAME: env override (CATALYST_CLOUD_TOKEN_ENV) → Layer-2 catalyst.cloud.tokenEnv →
// default CATALYST_CLOUD_TOKEN. NEVER reads process.env[envVar] (the secret VALUE) — safe to
// log the result. EXPORTED so execution-core/config.mjs's resolveNodeCloudTokenEnv can become
// a thin delegate onto this single implementation instead of hand-duplicating the ladder
// (design §8/§9 PR5) — this is now THE canonical NAME resolver both engines' "cloud-token
// reader" callers (config.mjs's bun path, health-responder.sh's bash-fallback ladder via
// lib/catalyst-secret-contract.sh's catalyst_secret_cloud_token_name) delegate to/mirror.
// Returns { envVar, source } where source ∈ "env" | "layer2" | "default" — the EXACT shape
// resolveNodeCloudTokenEnv has always returned (byte-compatible for its existing callers,
// including doctor.mjs's checkCloudSync `tokenEnv = resolveNodeCloudTokenEnv()` and
// checkCloudTokenEnv's shadow-diff).
export function resolveCloudTokenName(env = process.env) {
  const row = getSecretRow("cloud-token");
  const nameOverride = env?.CATALYST_CLOUD_TOKEN_ENV;
  if (typeof nameOverride === "string" && nameOverride.length > 0) {
    return { envVar: nameOverride, source: "env" };
  }
  const l2Path = resolveLayer2Path(env);
  const l2Name = readJsonField(l2Path, row?.configJsonPath);
  if (typeof l2Name === "string" && l2Name.length > 0) {
    return { envVar: l2Name, source: "layer2" };
  }
  return { envVar: row?.envNames?.[0] ?? "CATALYST_CLOUD_TOKEN", source: "default" };
}

// resolveCloudTokenValue(row, env) — cloud-token's two-step resolution used by the engine's
// resolveSecret: the NAME (via resolveCloudTokenName above — single implementation, not a
// second copy) THEN that variable's VALUE. Mode-independent: cloud-token is always
// platform-env delivery regardless of deployment mode, so this never touches a file.
function resolveCloudTokenValue(row, env) {
  const { envVar, source: envVarSource } = resolveCloudTokenName(env);
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
// CLOUD GUARD (design §4, belt-and-suspenders extension per design §12 Q3's operator-
// recommended answer): the cloud branch activates ONLY when deploymentMode.mode === "cloud"
// AND deploymentMode.inferred === false AND deploymentMode.recognized !== false — never on a
// guess. CTL-1617 §8 literally mandates only the `inferred === false` half; §12 Q3 asked
// whether to also refuse on `recognized === false` (an unrecognized EXPLICIT value) and
// recommended blocking on both, since "an unrecognized explicit value degrades to
// single-host anyway per the resolver" makes this a defense-in-depth belt-and-suspenders
// check, not a behavior change for any deploymentMode object produced by the real
// resolveDeploymentMode (which can never return mode:"cloud" with recognized:false — see
// classifyCandidate in lib/deployment-mode.mjs). It DOES matter for a hand-constructed or
// future-degraded deploymentMode object, which is exactly the scenario worth guarding.
// `!== false` (not `=== true`) is deliberate: every pre-existing caller/test that omits
// `recognized` entirely (undefined) must keep activating cloud exactly as before — this is
// an ADDITIVE guard against the one explicit negative signal, not a new required field.
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
// is exempt (it must resolve on its own terms) and resolveCloudTokenValue never triggers this
// check (recursion terminates in one level: cloud-token's own resolution never consults
// `deploymentMode`).
export function resolveSecret(id, { env = process.env, deploymentMode, cwd = process.cwd() } = {}) {
  const row = getSecretRow(id);
  if (!row) return { value: null, source: null, provider: null, rotation: null };

  const useCloud =
    deploymentMode?.mode === "cloud" && deploymentMode?.inferred === false && deploymentMode?.recognized !== false;

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
    // PLATFORM-ENV NAME OVERRIDE FIX: a bare resolveEnvAliasOnly(row, env) here only ever
    // checks row.envNames literally — for cloud-token that is JUST the hardcoded default
    // "CATALYST_CLOUD_TOKEN", so an operator-configured CATALYST_CLOUD_TOKEN_ENV or Layer-2
    // catalyst.cloud.tokenEnv override was silently ignored the moment genuine cloud mode
    // activated, even though that exact override IS honored one level up (the bootstrap
    // check above calls resolveSecret(bootstrapRow.id, { env }) WITHOUT deploymentMode,
    // which routes through the normal switch below to resolveCloudTokenValue). Dispatching
    // platform-env rows through resolveCloudTokenValue here — the SAME function, not a
    // second copy — closes that gap: cloud-token resolves its configured NAME identically
    // whether reached directly (this branch) or indirectly (the bootstrap check). Every
    // other cloud-mode row (bare-file/env-alias/config-json rows collapsing to their
    // envNames-only aliases) is unaffected — this is a targeted fix for the one
    // platform-env row, not a broadening of what "genuinely cloud" resolves.
    return row.delivery === "platform-env" ? resolveCloudTokenValue(row, env) : resolveEnvAliasOnly(row, env);
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
      return resolveConfigJson(row, env, cwd);
    case "platform-env":
      return resolveCloudTokenValue(row, env);
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

// armSecret(id, { env, deploymentMode }) — never throws. Returns { armed, rotated,
// restartRequired }. deploymentMode is the SAME optional CTL-1617 resolution object
// resolveSecret accepts, threaded straight through (design §8 finding fix) so a cloud-mode
// caller's arm baseline consults the identical provider chain its own direct resolveSecret
// calls use — see the DEPLOYMENT-MODE THREADING FIX comment on the hookless-degrade path
// below for the concrete failure this closes.
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
export function armSecret(id, { env = process.env, deploymentMode } = {}) {
  const row = getSecretRow(id);
  if (!row) return { armed: false, rotated: false, restartRequired: false };

  if (row.rotation?.class === "n/a") {
    return { armed: false, rotated: false, restartRequired: false };
  }

  const hook = _rearmHooks.get(id);
  if (row.rotation?.class === "re-armable" && typeof hook === "function") {
    let result;
    try {
      // Hooks receive the SAME context resolveSecret does (design §8 finding fix) — a
      // future file-rearm hook must be able to see genuine-cloud mode too, so it never
      // clobbers an injected platform token with a stale local file's contents.
      result = hook({ env, deploymentMode });
    } catch {
      return { armed: false, rotated: false, restartRequired: false };
    }
    const rotated = Boolean(result?.rearmed);
    return { armed: rotated, rotated, restartRequired: false };
  }

  // Hookless degrade path (covers boot-only rows AND hookless re-armable rows identically).
  // DEPLOYMENT-MODE THREADING FIX (design §8 finding fix): this MUST pass the same
  // deploymentMode a caller threads through to direct resolveSecret() calls — omitting it
  // used to make the arm baseline resolve through the non-cloud file/config chain even in
  // genuine cloud mode, while a sibling direct resolveSecret(id, { env, deploymentMode })
  // call correctly resolved via the cloud-only env-alias chain. In a cloud process with an
  // injected token AND a stale local file, that mismatch made a stale-file edit falsely
  // report restartRequired while a REAL token rotation went unnoticed — the literal
  // "arm baselines the wrong provider chain" bug this fix closes. Passing deploymentMode
  // straight through (default: undefined, identical to resolveSecret's own default) means a
  // caller that never passes it gets EXACTLY today's non-cloud behavior — this only changes
  // behavior for a caller that already threads deploymentMode into armSecret.
  const resolved = resolveSecret(id, { env, deploymentMode });
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
