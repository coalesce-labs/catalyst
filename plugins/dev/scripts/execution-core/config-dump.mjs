// config-dump.mjs — CTL-1793. A diffable, per-key PROVENANCE view of this host's
// effective Catalyst configuration.
//
// WHY THIS EXISTS
// ---------------
// There is no single merged config object anywhere in Catalyst. Layer-1 has six
// competing path resolvers, Layer-2 has four, and each knob family has its own
// precedence ladder (Layer-1-only, Layer-2-only, or a genuine two-layer merge),
// with an env var able to win over any of them. The consequence measured on the
// live fleet: two worker hosts read STRUCTURALLY DIFFERENT Layer-1 files (one
// pinned via CATALYST_CONFIG_FILE, one falling back to the daemon's launch cwd),
// and four enforcement subsystems run `enforce` on one host and at the code
// default on the other — invisible to every existing surface. See CTL-1793.
//
// WHAT THIS IS — AND IS NOT
// -------------------------
// This module is a DESCRIPTION of the resolution ladders, not a second resolver.
// It never feeds a gate, a dispatch decision, or a write. Nothing in the daemon
// imports it. Two structural guards keep the description honest:
//
//   1. The precedence DECISION for the two families that already have a shared
//      pure helper is delegated to that helper verbatim — `resolveModeSource` and
//      `resolveBeliefsFlag`, imported from config.mjs (exported there by CTL-1793
//      purely for this purpose). The dump therefore cannot disagree with the
//      daemon about which layer won for a mode or a beliefs flag.
//   2. Every env-var name and every dotted config key in CONFIG_KEYS is pinned to
//      the real source by a drift test (config-dump.test.mjs): a rename in a
//      reader breaks this module's test rather than silently drifting the dump.
//
// CORE IS PURE. `dumpConfig()` performs NO ambient I/O — every file body, the env,
// and the host name are injected. `collectConfigDump()` is the thin I/O shell.
//
// SECRETS. Rows marked `secret: true` report PRESENCE only ("set" / "unset") and
// never a value, in either renderer. Secret rows carry no config-file key at all,
// so there is no path by which a credential body can reach the output.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

import {
  BELIEFS_FLAGS,
  COORDINATION_MODES,
  DEAD_DOC_WORKER_MODES,
  LINEAR_WRITE_PROXY_MODES, // CTL-1889
  STALL_JANITOR_MODES,
  UNSTUCK_SWEEP_MODES,
  WATCHDOG_MODES,
  resolveBeliefsFlag,
  resolveModeSource,
} from "./config.mjs";

export const DUMP_SCHEMA = "catalyst.config.dump/1";

// Provenance vocabulary. Deliberately the SAME three strings readGovernanceSources
// already emits ("env-override" | "config" | "default") so the dump, the boot
// self-report, and `catalyst-stack status` speak one language. `config` is
// qualified by the row's `layer` field ("layer1" | "layer2" | "merged").
export const PROVENANCE = Object.freeze({
  ENV: "env-override",
  CONFIG: "config",
  DEFAULT: "default",
});

// ─── env-file parsing ────────────────────────────────────────────────────────

// parseEnvFileEntries — every `[export ]KEY=value` assignment in an env-file body,
// as `{ key, value, exported }` records. Quotes are stripped; `#` comment lines and
// blanks are skipped. Never throws.
//
// `exported` is load-bearing, not decoration. The launcher plain-`source`s
// ~/.config/catalyst/execution-core.env with NO `set -a`
// (catalyst-execution-core:214), and a child process inherits only EXPORTED
// variables. So a bare `CATALYST_STALL_JANITOR=enforce` becomes a variable of the
// launcher shell that the nohup'd daemon never sees — a fact the launcher itself
// already documents at :134 ("A bare shell var satisfies ${!key} but is NOT
// inherited by the nohup'd daemon child"), which is why it explicitly re-`export`s
// the OTEL keys at :151. Reporting a bare assignment as in-force would be this
// tool asserting exactly what the reader would NOT produce.
//
// This is the whole-file generalization of doctor.mjs's per-key parseEnvFileFlag /
// overlayDaemonDrainEnv idiom — a line scan, so it needs no dynamic RegExp.
export function parseEnvFileEntries(text) {
  const out = [];
  if (typeof text !== "string" || text === "") return out;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const exported = line.startsWith("export ");
    const body = exported ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    // Strip ONE matched pair of surrounding quotes (the shape `source` would see).
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out.push({ key, value, exported });
  }
  return out;
}

// parseEnvFileAssignments — ALL assignments, bare and exported alike, as a plain
// object. This is the LAUNCHER SHELL's view: `source` sets both kinds as shell
// variables, so both satisfy the launcher's own `[[ -z "${VAR:-}" ]]` guards.
// It is NOT the daemon's view — use parseEnvFileExports for that.
export function parseEnvFileAssignments(text) {
  const out = {};
  for (const { key, value } of parseEnvFileEntries(text)) out[key] = value;
  return out;
}

// parseEnvFileExports — only the `export`ed assignments: the subset the nohup'd
// daemon child actually inherits.
export function parseEnvFileExports(text) {
  const out = {};
  for (const { key, value, exported } of parseEnvFileEntries(text)) {
    if (exported) out[key] = value;
  }
  return out;
}

// overlayEnvFile — the daemon's effective env: ambient env with the env-file's
// EXPORTED assignments layered ON TOP. File wins, matching `source` semantics (the
// launcher sources the file AFTER inheriting the ambient env). Bare assignments are
// deliberately excluded — see parseEnvFileEntries.
export function overlayEnvFile(env = {}, envFileText = "") {
  return { ...env, ...parseEnvFileExports(envFileText) };
}

// ─── daemon-visible Layer-1 resolution ───────────────────────────────────────

// resolveDaemonLayer1Path — the Layer-1 file the RUNNING (or next-launched) daemon
// actually reads, reconstructed from the launcher's ladder rather than doctor's own.
// Mirrors, in order:
//   1. catalyst-execution-core cmd_start: `source`s execution-core.env (file wins
//      over ambient), then pins CATALYST_CONFIG_FILE to
//      "$CATALYST_DIR/.catalyst/config.json" ONLY when the var is still unset AND
//      that file exists;
//   2. daemon.mjs main(): `CATALYST_CONFIG_FILE || resolve(cwd, ".catalyst", "config.json")`.
//
// Step 2's cwd is the DAEMON's launch cwd, which is not knowable from a doctor
// process — so when the ladder falls through, this returns `{ path: null,
// source: "daemon-cwd", pinned: false }`. That "unpinned" answer IS the finding:
// it is exactly the state in which host `mini` reads a different Layer-1 file than
// its own checkout. Never throws.
export function resolveDaemonLayer1Path({
  env = {},
  execCoreEnvText = "",
  catalystDir = null,
  exists = () => false,
} = {}) {
  const effective = overlayEnvFile(env, execCoreEnvText);
  const pin = effective.CATALYST_CONFIG_FILE;
  if (typeof pin === "string" && pin !== "") {
    const fromFile = Object.hasOwn(parseEnvFileExports(execCoreEnvText), "CATALYST_CONFIG_FILE");
    return { path: pin, source: fromFile ? "exec-core-env-file" : "env", pinned: true };
  }

  // A BARE `CATALYST_CONFIG_FILE=...` in the env file is the worst of both worlds,
  // and silent. The launcher's auto-pin is guarded by
  // `[[ -z "${CATALYST_CONFIG_FILE:-}" ]]` (:341), which a bare assignment
  // SATISFIES AS SET — so the launcher skips pinning — while the nohup'd daemon
  // child never inherits it. The daemon therefore falls all the way through to its
  // own cwd-relative resolution, reading a Layer-1 file the operator believes they
  // pinned away. Report that state distinctly rather than folding it into the
  // ordinary unpinned case.
  const bareAssignments = parseEnvFileAssignments(execCoreEnvText);
  const barePin = Object.hasOwn(bareAssignments, "CATALYST_CONFIG_FILE")
    ? bareAssignments.CATALYST_CONFIG_FILE
    : null;
  if (typeof barePin === "string" && barePin !== "") {
    return {
      path: null,
      source: "daemon-cwd",
      pinned: false,
      barePinSuppressed: barePin,
    };
  }

  if (typeof catalystDir === "string" && catalystDir !== "") {
    const candidate = resolve(catalystDir, ".catalyst", "config.json");
    if (exists(candidate)) return { path: candidate, source: "catalyst-dir", pinned: true };
  }
  return { path: null, source: "daemon-cwd", pinned: false };
}

// ─── the registry ────────────────────────────────────────────────────────────
//
// One row per operationally load-bearing knob. Rows are DESCRIPTIONS of an
// existing reader's ladder — `reader` names that reader so a human (and the drift
// test) can find it. Field meanings:
//
//   key      dotted display name (the dump's stable sort key)
//   kind     "mode"   → env ("0" kill-switch | valid member) > config mode > default
//            "flag"   → env "1"/"0" > config boolean > default
//            "value"  → env non-empty > config non-null > default
//            "merge"  → Layer-2 positive int wins per field over Layer-1
//            "secret" → PRESENCE of an env var only; never a value, no config key
//   layer1   dotted path inside the Layer-1 file, or null
//   layer2   dotted path inside the Layer-2 file, or null
//   env      env var names, highest precedence first
//   modes    the Set the reader validates against (shared, not copied)
//   fallback the code default when no layer supplies a value
//   reader   the function in the codebase that owns this ladder
export const CONFIG_KEYS = Object.freeze(
  [
    // ── identity / topology ──────────────────────────────────────────────────
    {
      key: "catalyst.node.class",
      kind: "value",
      layer2: "catalyst.node.class",
      env: ["CATALYST_NODE_CLASS"],
      fallback: "worker",
      reader: "resolveNodeClass",
    },
    {
      key: "catalyst.host.name",
      kind: "value",
      layer2: "catalyst.host.name",
      env: ["CATALYST_HOST_NAME"],
      fallback: null,
      reader: "getHostName",
    },
    {
      key: "catalyst.deployment.mode",
      kind: "value",
      layer1: "catalyst.deployment.mode",
      layer2: "catalyst.deployment.mode",
      env: ["CATALYST_DEPLOYMENT_MODE"],
      fallback: "single-host",
      reader: "resolveDeploymentMode",
    },

    // ── orchestration (Layer-1 owned) ────────────────────────────────────────
    {
      key: "catalyst.orchestration.dispatchMode",
      kind: "value",
      layer1: "catalyst.orchestration.dispatchMode",
      env: [],
      fallback: "oneshot-legacy",
      reader: "orchestrate-register-interests.sh",
    },
    {
      key: "catalyst.orchestration.executor",
      kind: "value",
      layer1: "catalyst.orchestration.executor",
      env: ["CATALYST_EXECUTOR"],
      fallback: null,
      reader: "resolveExecutor",
    },
    {
      key: "catalyst.orchestration.executorByPhase",
      kind: "value",
      layer1: "catalyst.orchestration.executorByPhase",
      env: ["CATALYST_EXECUTOR_BY_PHASE"],
      fallback: null,
      reader: "readExecutorByPhaseLayer1",
    },
    // CTL-2116: the fleet cluster-repo POLICY tier now sits ABOVE the row
    // above (readExecutorByPhaseLayer1's new first rung, executor-policy.mjs).
    // Its VALUE (cluster.json.executorPolicy.routes) is not representable here
    // — this module's inputs are Layer-1/Layer-2/env only, no cluster.json —
    // so these two rows document the escape-hatch and the budget-gate knobs an
    // operator can see in this host's effective env, not the routes themselves.
    // `catalyst cluster route show` is the introspection surface for the
    // policy's actual content.
    {
      key: "catalyst.orchestration.executorPolicy.disable",
      kind: "value",
      layer1: null,
      env: ["CATALYST_EXECUTOR_POLICY"],
      fallback: null,
      reader: "readExecutorByPhaseLayer1",
    },
    {
      key: "catalyst.orchestration.executorPolicy.codexBudgetFloorPercent",
      kind: "value",
      layer1: null,
      env: ["CATALYST_CODEX_BUDGET_FLOOR_PERCENT"],
      fallback: 20,
      reader: "resolveFloorPercent",
    },
    {
      key: "catalyst.orchestration.reconcile.mode",
      kind: "value",
      layer1: "catalyst.orchestration.reconcile.mode",
      layer2: "catalyst.orchestration.reconcile.mode",
      env: ["CATALYST_RECONCILE_MODE"],
      fallback: null,
      reader: "readLinearReconcileConfig",
    },
    {
      key: "catalyst.orchestration.executionCore.maxParallel",
      kind: "merge",
      layer1: "catalyst.orchestration.executionCore.maxParallel",
      layer2: "catalyst.orchestration.executionCore.maxParallel",
      env: [],
      fallback: null,
      reader: "mergeExecutionCoreConcurrency",
    },
    {
      key: "catalyst.orchestration.executionCore.minParallel",
      kind: "merge",
      layer1: "catalyst.orchestration.executionCore.minParallel",
      layer2: "catalyst.orchestration.executionCore.minParallel",
      env: [],
      fallback: null,
      reader: "mergeExecutionCoreConcurrency",
    },
    {
      key: "catalyst.orchestration.executionCore.maxParallelCeiling",
      kind: "merge",
      layer1: "catalyst.orchestration.executionCore.maxParallelCeiling",
      layer2: "catalyst.orchestration.executionCore.maxParallelCeiling",
      env: [],
      fallback: null,
      reader: "mergeExecutionCoreConcurrency",
    },
    {
      key: "catalyst.orchestration.executionCore.targetParallel",
      kind: "merge",
      layer1: "catalyst.orchestration.executionCore.targetParallel",
      layer2: "catalyst.orchestration.executionCore.targetParallel",
      env: [],
      fallback: null,
      reader: "resolveTargetSetpoint",
    },
    {
      key: "catalyst.orchestration.executionCore.eligibleQuery.status",
      kind: "value",
      layer1: "catalyst.orchestration.executionCore.eligibleQuery.status",
      env: [],
      fallback: null,
      reader: "readExecutionCoreConcurrency",
    },
    {
      key: "catalyst.orchestration.worktreeRefresh.enabled",
      kind: "value",
      layer1: "catalyst.orchestration.worktreeRefresh.enabled",
      env: [],
      fallback: null,
      reader: "readWorktreeRefreshConfig",
    },
    {
      key: "catalyst.orchestration.worktreeRefresh.intervalSeconds",
      kind: "value",
      layer1: "catalyst.orchestration.worktreeRefresh.intervalSeconds",
      env: [],
      fallback: null,
      reader: "readWorktreeRefreshConfig",
    },
    {
      key: "catalyst.orchestration.draftPr.enabled",
      kind: "value",
      layer1: "catalyst.orchestration.draftPr.enabled",
      env: [],
      fallback: true,
      reader: "lib/draft-pr.sh",
    },
    {
      key: "catalyst.orchestration.orphanReaper.workerGc.emptyDirGraceSeconds",
      kind: "value",
      layer1: "catalyst.orchestration.orphanReaper.workerGc.emptyDirGraceSeconds",
      env: ["CATALYST_EMPTY_WORKER_DIR_GRACE_MS"],
      fallback: 600,
      reader: "readEmptyWorkerDirGraceMs",
    },
    {
      key: "catalyst.orchestration.daemonWatchdog.mode",
      kind: "mode",
      layer1: "catalyst.orchestration.daemonWatchdog.mode",
      env: ["CATALYST_DAEMON_WATCHDOG", "EXECUTION_CORE_DAEMON_WATCHDOG_MODE"],
      modes: WATCHDOG_MODES,
      fallback: "shadow",
      reader: "readDaemonWatchdogConfig",
    },

    // ── governance / enforcement subsystems (Layer-2 owned) ──────────────────
    // These are the four that measurably diverged across the live worker hosts.
    {
      key: "catalyst.stallJanitor.mode",
      kind: "mode",
      layer2: "catalyst.stallJanitor.mode",
      env: ["CATALYST_STALL_JANITOR", "EXECUTION_CORE_STALL_JANITOR_MODE"],
      modes: STALL_JANITOR_MODES,
      fallback: "shadow",
      reader: "readStallJanitorConfig",
    },
    {
      key: "catalyst.unstuckSweep.mode",
      kind: "mode",
      layer2: "catalyst.unstuckSweep.mode",
      env: ["CATALYST_UNSTUCK_SWEEP", "EXECUTION_CORE_UNSTUCK_SWEEP_MODE"],
      modes: UNSTUCK_SWEEP_MODES,
      fallback: "off",
      reader: "readUnstuckSweepConfig",
    },
    {
      // CTL-1889: the Linear write-proxy transport. Layer-2 only — the `routes`
      // sibling is a URL-path map, which has no env precedent and no business in a
      // daemon env var.
      key: "catalyst.linearWriteProxy.mode",
      kind: "mode",
      layer2: "catalyst.linearWriteProxy.mode",
      env: ["CATALYST_LINEAR_WRITE_PROXY"],
      modes: LINEAR_WRITE_PROXY_MODES,
      fallback: "off",
      reader: "readLinearWriteProxyConfig",
    },
    {
      key: "catalyst.recovery.deadDocWorker.mode",
      kind: "mode",
      layer2: "catalyst.recovery.deadDocWorker.mode",
      env: ["CATALYST_DEAD_DOC_WORKER_RECLAIM"],
      modes: DEAD_DOC_WORKER_MODES,
      fallback: "off",
      reader: "readDeadDocWorkerConfig",
    },
    {
      key: "catalyst.watchdog.mode",
      kind: "mode",
      layer2: "catalyst.watchdog.mode",
      env: ["CATALYST_WATCHDOG", "EXECUTION_CORE_WATCHDOG_MODE"],
      modes: WATCHDOG_MODES,
      fallback: "shadow",
      reader: "readWatchdogConfig",
    },
    {
      key: "catalyst.coordination.mode",
      kind: "mode",
      layer2: "catalyst.coordination.mode",
      env: ["CATALYST_COORDINATION_MODE"],
      modes: COORDINATION_MODES,
      fallback: "off",
      reader: "readCoordinationConfig",
    },
    {
      key: "catalyst.costCap.mode",
      kind: "mode",
      layer2: "catalyst.costCap.mode",
      env: ["CATALYST_COST_CAP", "EXECUTION_CORE_COST_CAP_MODE"],
      modes: WATCHDOG_MODES,
      fallback: "shadow",
      reader: "readCostCapConfig",
    },
    {
      key: "catalyst.linearReplica.mode",
      kind: "value",
      layer2: "catalyst.linearReplica.mode",
      env: ["CATALYST_LINEAR_REPLICA"],
      fallback: "off",
      reader: "readLinearReplica",
    },

    // ── beliefs flags (Layer-2 booleans, env "1"/"0") ────────────────────────
    ...Object.entries(BELIEFS_FLAGS).map(([flag, envName]) => ({
      key: `catalyst.governance.${flag}`,
      kind: "flag",
      layer2: `catalyst.governance.${flag}`,
      env: [envName],
      fallback: false,
      reader: "readGovernanceConfig",
    })),

    // ── credential PRESENCE (never a value) ──────────────────────────────────
    // A missing token is a first-order divergence between hosts, and its presence
    // is not readable from any config file. Reported as "set"/"unset" only.
    { key: "secrets.LINEAR_API_TOKEN", kind: "secret", env: ["LINEAR_API_TOKEN"], reader: "secret-contract:linear-api-token" },
    { key: "secrets.CATALYST_WORKFLOW_GITHUB_TOKEN", kind: "secret", env: ["CATALYST_WORKFLOW_GITHUB_TOKEN"], reader: "secret-contract:github-token" },
    { key: "secrets.CATALYST_CLOUD_TOKEN", kind: "secret", env: ["CATALYST_CLOUD_TOKEN"], reader: "secret-contract:cloud-token" },
    { key: "secrets.GROQ_API_KEY", kind: "secret", env: ["GROQ_API_KEY"], reader: "secret-contract:groq-api-key" },
  ].map((r) =>
    Object.freeze({
      layer1: null,
      layer2: null,
      modes: null,
      fallback: null,
      secret: r.kind === "secret",
      ...r,
    }),
  ),
);

// ─── resolution ──────────────────────────────────────────────────────────────

// getPath — read a dotted key out of a parsed JSON object. Returns undefined for
// an absent key, a non-object ancestor, or a null root. Never throws.
export function getPath(obj, dotted) {
  if (!dotted) return undefined;
  let cur = obj;
  for (const part of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function firstEnvValue(env, names) {
  for (const name of names ?? []) {
    const v = env?.[name];
    if (typeof v === "string" && v !== "") return { value: v, envVar: name };
  }
  return { value: undefined, envVar: null };
}

// resolveRow — the effective value + provenance for one registry row, given the
// already-parsed layers and the daemon's effective env. Pure; never throws.
//
// `layer` names WHICH file supplied a `config`-provenance answer ("layer1" |
// "layer2"), so an operator diffing two hosts sees not just "config" but which
// file to go read.
export function resolveRow(row, { env = {}, layer1 = null, layer2 = null } = {}) {
  const { value: envValue, envVar } = firstEnvValue(env, row.env);

  if (row.kind === "secret") {
    return {
      key: row.key,
      value: envValue === undefined ? "unset" : "set",
      provenance: envValue === undefined ? PROVENANCE.DEFAULT : PROVENANCE.ENV,
      layer: null,
      envVar: envVar ?? (row.env?.[0] ?? null),
      secret: true,
      reader: row.reader,
    };
  }

  const l1 = getPath(layer1, row.layer1);
  const l2 = getPath(layer2, row.layer2);

  const base = { key: row.key, secret: false, reader: row.reader, envVar: envVar ?? (row.env?.[0] ?? null) };

  if (row.kind === "mode") {
    // Mode knobs are single-layer in every reader today (Layer-2 for the governance
    // family, Layer-1 for daemonWatchdog); whichever the row declares is "the" config
    // layer. The DECISION is resolveModeSource's, verbatim.
    const configMode = row.layer2 ? l2 : l1;
    const configLayer = row.layer2 ? "layer2" : "layer1";
    const provenance = resolveModeSource(envValue, configMode, row.modes);
    let value;
    if (provenance === PROVENANCE.ENV) value = envValue === "0" ? "off" : envValue;
    else if (provenance === PROVENANCE.CONFIG) value = configMode;
    else value = row.fallback;
    return { ...base, value, provenance, layer: provenance === PROVENANCE.CONFIG ? configLayer : null };
  }

  if (row.kind === "flag") {
    const r = resolveBeliefsFlag(envValue, l2);
    return { ...base, value: r.value, provenance: r.source, layer: r.source === PROVENANCE.CONFIG ? "layer2" : null };
  }

  if (row.kind === "merge") {
    // Layer-2 wins per field when it is a positive integer (mergeExecutionCoreConcurrency).
    if (Number.isInteger(l2) && l2 > 0) return { ...base, value: l2, provenance: PROVENANCE.CONFIG, layer: "layer2" };
    if (l1 !== undefined && l1 !== null) return { ...base, value: l1, provenance: PROVENANCE.CONFIG, layer: "layer1" };
    return { ...base, value: row.fallback, provenance: PROVENANCE.DEFAULT, layer: null };
  }

  // "value": env > layer2 > layer1 > default. Layer-2 is node scope and wins over
  // the committed Layer-1 seed wherever a row declares both (node.class/host.name
  // are Layer-2-only; reconcile.mode and deployment.mode are the two-layer rows).
  if (envValue !== undefined) return { ...base, value: envValue, provenance: PROVENANCE.ENV, layer: null };
  if (l2 !== undefined && l2 !== null) return { ...base, value: l2, provenance: PROVENANCE.CONFIG, layer: "layer2" };
  if (l1 !== undefined && l1 !== null) return { ...base, value: l1, provenance: PROVENANCE.CONFIG, layer: "layer1" };
  return { ...base, value: row.fallback, provenance: PROVENANCE.DEFAULT, layer: null };
}

// ─── fingerprint ─────────────────────────────────────────────────────────────

// stableValue — a canonical string for a row's value, so the fingerprint is
// insensitive to object key order and JSON whitespace but sensitive to content.
function stableValue(v) {
  if (v === undefined) return "\u0000undefined";
  if (v === null) return "\u0000null";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return `[${v.map(stableValue).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${k}:${stableValue(v[k])}`).join(",")}}`;
}

// fingerprintRows — sha256 over the canonical `key\0value\0provenance\0layer`
// stream, rows sorted by key. Two hosts with the same effective configuration
// produce the same fingerprint regardless of file formatting or key order; ANY
// value, provenance, or layer change alters it. Host-independent by construction
// (host name and timestamps are not part of the stream).
export function fingerprintRows(rows) {
  const h = createHash("sha256");
  for (const r of [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    h.update(`${r.key}\u0000${stableValue(r.value)}\u0000${r.provenance}\u0000${r.layer ?? ""}\n`);
  }
  return h.digest("hex");
}

// ─── the dump ────────────────────────────────────────────────────────────────

// parseOrNull — { parsed, ok }. `ok` is true only when the body parsed into a
// plain object; an absent (null) body and a malformed one are both `ok:false`
// with `parsed:null`, so every downstream layer probe simply misses. Mirrors the
// readLayer2*/readXConfigLayer1 family's "unreadable ⇒ try the next layer"
// contract. Never throws.
function parseOrNull(text) {
  if (typeof text !== "string" || text === "") return { parsed: null, ok: false };
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? { parsed: v, ok: true } : { parsed: null, ok: false };
  } catch {
    return { parsed: null, ok: false };
  }
}

// dumpConfig — the pure core. Everything is injected; there is NO ambient I/O.
//
//   env              the operator/process env (NOT yet overlaid with the env file)
//   layer1Text       raw Layer-1 body, or null when absent/unreadable
//   layer2Text       raw Layer-2 body, or null when absent/unreadable
//   execCoreEnvText  raw ~/.config/catalyst/execution-core.env body, or ""
//   daemonLayer1     result of resolveDaemonLayer1Path (or null when not computed)
export function dumpConfig({
  env = {},
  // `host` is an explicit override; when empty the dump labels itself with the
  // RESOLVED catalyst.host.name (the fleet identity every other surface keys on —
  // heartbeats, HRW, worker labels), falling back to `hostFallback` (the OS
  // hostname) only when nothing declares one. Labelling with the OS hostname while
  // the fleet knows the node as "mini" is exactly the kind of identity mismatch
  // that makes a cross-host diff unreadable.
  host = "",
  hostFallback = "",
  generatedAt = null,
  layer1Path = null,
  layer1Text = null,
  layer2Path = null,
  layer2Text = null,
  execCoreEnvPath = null,
  execCoreEnvText = "",
  daemonLayer1 = null,
  keys = CONFIG_KEYS,
} = {}) {
  const effectiveEnv = overlayEnvFile(env, execCoreEnvText);
  const l1 = parseOrNull(layer1Text);
  const l2 = parseOrNull(layer2Text);

  const rows = keys.map((row) => resolveRow(row, { env: effectiveEnv, layer1: l1.parsed, layer2: l2.parsed }));

  const envFileEntries = parseEnvFileEntries(execCoreEnvText);
  const envFileKeys = [...new Set(envFileEntries.map((e) => e.key))].sort();
  // Keys assigned WITHOUT `export`: present in the file, set in the launcher shell,
  // and never inherited by the daemon child. An operator reading the file sees them
  // as in-force; the daemon does not. Naming them is the whole point of this tool.
  const bareKeys = [
    ...new Set(envFileEntries.filter((e) => !e.exported).map((e) => e.key)),
  ]
    .filter((k) => !envFileEntries.some((e) => e.key === k && e.exported))
    .sort();

  const hostRow = rows.find((r) => r.key === "catalyst.host.name");
  const resolvedHost =
    host || (typeof hostRow?.value === "string" && hostRow.value !== "" ? hostRow.value : "") || hostFallback;

  return {
    schema: DUMP_SCHEMA,
    host: resolvedHost,
    generatedAt,
    layer1: {
      path: layer1Path,
      present: layer1Text !== null && layer1Text !== undefined,
      parsed: l1.ok,
      // The single most diagnostic Layer-1 fact: mini's daemon reads a file with NO
      // orchestration stanza at all, so every Layer-1-driven feature runs on defaults.
      hasOrchestration: getPath(l1.parsed, "catalyst.orchestration") !== undefined,
    },
    layer2: {
      path: layer2Path,
      present: layer2Text !== null && layer2Text !== undefined,
      parsed: l2.ok,
    },
    // The env file's KEY SET is itself a divergence signal — values are never emitted.
    execCoreEnv: { path: execCoreEnvPath, present: execCoreEnvText !== "", keys: envFileKeys, bareKeys },
    daemonLayer1,
    rows,
    fingerprint: fingerprintRows(rows),
  };
}

// ─── I/O shell ───────────────────────────────────────────────────────────────

function readOrNull(path) {
  if (!path) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// collectConfigDump — the thin ambient-I/O wrapper around dumpConfig. Read-only:
// it opens three files and never writes anything. Path resolution mirrors the
// daemon's (CATALYST_CONFIG_FILE > cwd) and the legacy Layer-2 chain
// (CATALYST_LAYER2_CONFIG_FILE > ~/.config/catalyst/config.json) — the same two
// ladders getCatalystRepoDir() and getLayer2ConfigPath() use.
export function collectConfigDump({ env = process.env, cwd = process.cwd(), now = new Date() } = {}) {
  const home = env.HOME || "";
  const layer2Path = env.CATALYST_LAYER2_CONFIG_FILE || resolve(home, ".config", "catalyst", "config.json");
  const execCoreEnvPath = env.CATALYST_EXECUTION_CORE_ENV || resolve(home, ".config", "catalyst", "execution-core.env");
  const execCoreEnvText = readOrNull(execCoreEnvPath) ?? "";
  const catalystDir = env.CATALYST_DIR || resolve(home, "catalyst");

  // Resolve the daemon's Layer-1 FIRST, then read THAT file. Order matters: the
  // env file is what carries a per-host `export CATALYST_CONFIG_FILE` pin, so a
  // Layer-1 path taken from the raw ambient env (or this process's cwd) can name a
  // different file than the daemon reads. Every Layer-1-derived row AND the
  // fingerprint come from the bytes read here, so resolving them from the caller's
  // cwd while REPORTING the daemon's path would make the dump disagree with itself
  // in precisely the per-host-pin scenario it exists to diagnose.
  const daemonLayer1 = resolveDaemonLayer1Path({
    env,
    execCoreEnvText,
    catalystDir,
    exists: (p) => readOrNull(p) !== null,
  });
  // When the daemon's ladder falls through to its own launch cwd (unknowable from
  // here), fall back to this process's cwd — the pre-existing behavior, and the
  // dump already labels that state `pinned: false` so the reader knows the Layer-1
  // shown is an inference rather than the daemon's own resolution.
  const layer1Path = daemonLayer1.pinned && daemonLayer1.path
    ? daemonLayer1.path
    : env.CATALYST_CONFIG_FILE || resolve(cwd, ".catalyst", "config.json");

  return dumpConfig({
    env,
    hostFallback: hostname(),
    generatedAt: now.toISOString(),
    layer1Path,
    layer1Text: readOrNull(layer1Path),
    layer2Path,
    layer2Text: readOrNull(layer2Path),
    execCoreEnvPath,
    execCoreEnvText,
    daemonLayer1,
  });
}

// ─── renderers ───────────────────────────────────────────────────────────────

export function renderJson(dump) {
  return JSON.stringify(dump, null, 2);
}

function fmtValue(row) {
  if (row.value === null || row.value === undefined) return "-";
  if (typeof row.value === "object") return JSON.stringify(row.value);
  return String(row.value);
}

export function renderHuman(dump) {
  const lines = [];
  lines.push(`catalyst config dump — ${dump.host || "(unknown host)"}   fingerprint=${dump.fingerprint.slice(0, 12)}`);
  lines.push("");
  lines.push(
    `  layer1  ${dump.layer1.path ?? "(unresolved)"}  ` +
      `[${dump.layer1.present ? (dump.layer1.parsed ? "ok" : "MALFORMED") : "ABSENT"}` +
      `${dump.layer1.present && dump.layer1.parsed ? (dump.layer1.hasOrchestration ? ", orchestration" : ", NO orchestration stanza") : ""}]`,
  );
  lines.push(
    `  layer2  ${dump.layer2.path ?? "(unresolved)"}  ` +
      `[${dump.layer2.present ? (dump.layer2.parsed ? "ok" : "MALFORMED") : "ABSENT"}]`,
  );
  if (dump.daemonLayer1) {
    lines.push(
      dump.daemonLayer1.pinned
        ? `  daemon  ${dump.daemonLayer1.path}  [pinned via ${dump.daemonLayer1.source}]`
        : `  daemon  (UNPINNED — resolves to the daemon's launch cwd; may differ from layer1 above)`,
    );
  }
  if (dump.execCoreEnv?.present) {
    lines.push(`  envfile ${dump.execCoreEnv.path}  [${dump.execCoreEnv.keys.length} keys: ${dump.execCoreEnv.keys.join(" ")}]`);
  }
  lines.push("");

  const keyW = Math.max(3, ...dump.rows.map((r) => r.key.length));
  const valW = Math.max(5, ...dump.rows.map((r) => fmtValue(r).length));
  lines.push(`  ${"KEY".padEnd(keyW)}  ${"VALUE".padEnd(valW)}  SOURCE`);
  for (const r of dump.rows) {
    const src =
      r.provenance === PROVENANCE.ENV
        ? `env-override (${r.envVar})`
        : r.provenance === PROVENANCE.CONFIG
          ? `config (${r.layer})`
          : "default";
    lines.push(`  ${r.key.padEnd(keyW)}  ${fmtValue(r).padEnd(valW)}  ${src}`);
  }
  lines.push("");
  lines.push(`  fingerprint=${dump.fingerprint}`);
  lines.push("  Diff two hosts:  diff <(ssh a catalyst config dump --json) <(ssh b catalyst config dump --json)");
  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export const USAGE = `catalyst-config — inspect this host's effective Catalyst configuration (read-only).

Usage: catalyst-config <command> [options]

Commands:
  dump            Per-key value + provenance, layer paths, fingerprint.

Options:
  --json          machine-readable output (stable key order; diffable)
  -h, --help      this help

\`dump\` reports, for every load-bearing knob, its effective value and WHERE that
value came from (env-override / config / default), plus the resolved Layer-1 and
Layer-2 paths, the Layer-1 file the DAEMON actually reads (which is not always
the one doctor grades), and a content fingerprint.

Compare two hosts:
  diff <(ssh a catalyst config dump --json) <(ssh b catalyst config dump --json)

This tool never writes anything and never prints a secret value — credential rows
report "set"/"unset" only.
`;

// runCli — injectable so the CLI contract is testable without spawning. Returns
// the process exit code; writes through the injected sinks only.
export function runCli(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), collect = collectConfigDump } = {}) {
  const args = argv ?? [];
  if (args.includes("-h") || args.includes("--help")) {
    out(USAGE);
    return 0;
  }
  const cmd = args.find((a) => !a.startsWith("-"));
  if (!cmd) {
    err("catalyst-config: a command is required\n\n" + USAGE);
    return 2;
  }
  if (cmd !== "dump") {
    err(`catalyst-config: unknown command: ${cmd}\n\n` + USAGE);
    return 2;
  }
  const d = collect();
  out((args.includes("--json") ? renderJson(d) : renderHuman(d)) + "\n");
  return 0;
}

// Cross-runtime main guard (mirrors doctor.mjs). Importing this module — which
// doctor.mjs does — never runs the CLI, because argv[1] is then the importer.
const isMain = process.argv[1] && process.argv[1].endsWith("config-dump.mjs");
if (isMain) process.exit(runCli(process.argv.slice(2)));
