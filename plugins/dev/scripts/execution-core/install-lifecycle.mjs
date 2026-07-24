// install-lifecycle.mjs — CTL-1369 PR3: the `catalyst install | uninstall | reinstall`
// per-class lifecycle driver (run via the thin `catalyst-install` bash launcher).
//
// It is a THIN ORCHESTRATOR, not a re-implementation of provisioning. It (a) composes the
// existing setup scripts per node class and (b) drives the PR1 `InstallRun` telemetry contract
// so each lifecycle run is an observable trace + a `catalyst.install.*` event stream.
//
// The composition surface (each step shells out; every path is an env-override SEAM so tests
// stub them — mirrors catalyst-join.sh's CATALYST_JOIN_*_SCRIPT pattern):
//   - setup-plugin-source.sh   (acquire)      clone/update the plugin checkout + register pluginDirs
//   - catalyst-backup backup   (backup)       snapshot restorable state BEFORE any overwrite
//   - catalyst class <x>       (write-config)  set Layer-2 node.class
//   - setup-catalyst.sh        (write-config)  Layer-1 config + Layer-2 secrets
//   - install-cli.sh           (install-agents) install the catalyst-* symlinks
//   - catalyst-stack install-services | adopt-updater (install-agents) — THE PER-CLASS SPLIT
//   - catalyst-stack start | catalyst drain  (start-daemons)
//   - catalyst-stack verify-node (healthcheck) class-aware health (NON-fatal)
//
// THE PER-CLASS INVARIANT (the heart of correctness, enforced by tests):
//   * worker     → runs `install-services` (broker/exec-core/monitor); NEVER `adopt-updater`
//                  (the broker is the plugin-pull owner).
//   * developer  → runs `adopt-updater` (5th updater agent, sole pull owner) + boot-drain;
//                  NEVER `install-services` (a developer node must not run broker/exec-core).
//   * monitor    → enum-slot stub: developer-shaped (updater + drain), no work stack (design §10).
//
// Phase enums are LOCKED with OTEL (it sized dashboards on {operation, phase}). install uses the
// PR1 INSTALL_PHASES; uninstall/reinstall finalized here. Telemetry is best-effort throughout —
// it must never break a lifecycle run. Provisioning failures roll back from the backup bundle.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { InstallRun, makeInstallEmitFn, INSTALL_SERVICE_NAME } from "./lib/install-telemetry.mjs";
import { initTracing, shutdownTracing } from "./tracing.mjs";
import { NODE_CLASSES } from "./config.mjs";

// ── phase enums ───────────────────────────────────────────────────────────────
// install: the PR1 locked set (acquire → backup → write-config → install-agents →
// start-daemons → healthcheck) imported from install-telemetry.
// uninstall: finalized here — reverse of install, backup-first.
export const UNINSTALL_PHASES = Object.freeze([
  "backup",
  "stop-daemons",
  "remove-agents",
  "remove-config",
  "verify-clean",
]);
// reinstall = uninstall's teardown (one backup at the top) THEN install's provisioning, under
// ONE root span (operation=reinstall). No second backup — the top-of-run snapshot covers both.
export const REINSTALL_PHASES = Object.freeze([
  "backup",
  "stop-daemons",
  "remove-agents",
  "remove-config",
  "acquire",
  "write-config",
  "install-agents",
  "start-daemons",
  "healthcheck",
]);

export const LIFECYCLE_OPERATIONS = Object.freeze(["install", "uninstall", "reinstall"]);

// Layer-2 machine-config keys the install lifecycle OWNS — set on install, stripped on uninstall.
// SECRETS (per-project config-<key>.json) are deliberately NOT in this list: uninstall preserves
// the node's secret identity (it is also captured in the backup), so a reinstall does not have to
// re-prompt for tokens. A future --purge can extend teardown to the secrets.
export const INSTALL_MANAGED_KEYS = Object.freeze([
  "catalyst.node.class",
  "catalyst.orchestration.pluginPullOwner",
  "catalyst.readReplica.baseUrl",
]);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url)); // …/plugins/dev/scripts/execution-core
const SCRIPTS_DIR = resolve(SCRIPT_DIR, ".."); // …/plugins/dev/scripts
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..", ".."); // repo root (setup-catalyst.sh lives here)

/**
 * resolveScripts — the composition seams. Each path is `env override > computed default` so the
 * bash setup steps can be stubbed in tests (CATALYST_INSTALL_*_SCRIPT) without touching the real
 * toolchain. Defaults are derived from THIS module's location (works in a checkout; install is a
 * checkout-context operation, not a bare-cache one).
 */
export function resolveScripts(env = process.env) {
  return {
    pluginSrc: env.CATALYST_INSTALL_PLUGIN_SRC_SCRIPT || join(SCRIPTS_DIR, "setup-plugin-source.sh"),
    backup: env.CATALYST_INSTALL_BACKUP_BIN || join(SCRIPTS_DIR, "catalyst-backup"),
    catalyst: env.CATALYST_INSTALL_CATALYST_BIN || join(SCRIPTS_DIR, "catalyst"),
    setup: env.CATALYST_INSTALL_SETUP_SCRIPT || join(REPO_ROOT, "setup-catalyst.sh"),
    installCli: env.CATALYST_INSTALL_CLI_SCRIPT || join(SCRIPTS_DIR, "install-cli.sh"),
    stack: env.CATALYST_INSTALL_STACK_BIN || join(SCRIPTS_DIR, "catalyst-stack"),
    // CTL-1369 PR4: the class-aware doctor, run as the install's pre-state observation + post-install
    // verification (catalyst-doctor --profile install). Env-override seam for tests.
    doctor: env.CATALYST_INSTALL_DOCTOR_BIN || join(SCRIPTS_DIR, "catalyst-doctor"),
    // CTL-1401: the exec-core launcher — used to restart exec-core after an additive `install --executor`
    // changed the lever (a live daemon won't pick up a new CATALYST_EXECUTOR without a restart).
    execCore: env.CATALYST_INSTALL_EXECCORE_BIN || join(SCRIPTS_DIR, "catalyst-execution-core"),
  };
}

/**
 * layer2Path — the Layer-2 machine config, resolved the way the WHOLE toolchain resolves it so the
 * driver and every child tool agree on one file: CATALYST_LAYER2_CONFIG_FILE (config.mjs runtime) >
 * CATALYST_MACHINE_CONFIG (setup-plugin-source / lib/plugin-dirs.sh / catalyst-stack pluginPullOwner)
 * > XDG_CONFIG_HOME/catalyst/config.json > ~/.config/catalyst/config.json. Honoring CATALYST_MACHINE_CONFIG
 * here is what keeps a caller that set ONLY that var from having the run silently target ~/.config.
 */
export function layer2Path(env = process.env) {
  return (
    env.CATALYST_LAYER2_CONFIG_FILE ||
    env.CATALYST_MACHINE_CONFIG ||
    join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "catalyst", "config.json")
  );
}

// CTL-1401: valid executor levers (mirrors config.mjs's EXECUTORS — bg | sdk | oneshot-legacy |
// codex-exec). The install's `--executor` flag provisions one of these into execution-core.env so
// the node's executor is install-set, not dependent on a hand-edit surviving. Keep in sync with
// config.mjs:EXECUTORS (a separate literal, not an import).
export const VALID_EXECUTORS = Object.freeze(["bg", "sdk", "oneshot-legacy", "codex-exec"]);

/**
 * execCoreEnvPath — the daemon env file the execution-core launcher sources on EVERY start, and from
 * which CTL-1398's token-arm reads `CATALYST_EXECUTOR`. Resolved EXACTLY the way the launcher
 * (catalyst-execution-core) and doctor (defaultExecCoreEnvPath) resolve it: the
 * `CATALYST_EXECUTION_CORE_ENV` override, else `~/.config/catalyst/execution-core.env`. NB: the
 * launcher does NOT honor `XDG_CONFIG_HOME` for this file — it hard-codes `${HOME}/.config` — so we
 * must NOT either, or `--executor` would write a lever the restarted daemon never reads (Codex P2).
 * This file is not a Layer-2 key and is never stripped by remove-config, so a value written here
 * survives a reinstall — write-config (re)asserts it so the executor lever is install-provisioned.
 */
export function execCoreEnvPath(env = process.env) {
  return env.CATALYST_EXECUTION_CORE_ENV || join(homedir(), ".config", "catalyst", "execution-core.env");
}

/** readNodeClassRaw — the raw catalyst.node.class string stored in a Layer-2 file (or null). */
export function readNodeClassRaw(layer2) {
  try {
    const v = readLayer2(layer2)?.catalyst?.node?.class;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * resolveRequestedClass — the class this lifecycle run targets. Precedence:
 *   explicit --class > CATALYST_NODE_CLASS env > the class IN THE SELECTED Layer-2 file.
 * The config fallback reads the SAME file the driver resolved (`layer2`) — NOT getNodeClass(),
 * which only honors CATALYST_LAYER2_CONFIG_FILE/~/.config and would mis-resolve a developer config
 * supplied via CATALYST_MACHINE_CONFIG/XDG as worker. An explicit-but-UNRECOGNIZED class (from
 * --class, env, OR the config) is a hard error (the §3 footgun — never silently fall back to worker
 * on a typo'd developer node); an ABSENT config class ⇒ worker (the zero-config default).
 * Returns { nodeClass, source }. (A test may inject `currentFn` to stub the config read.)
 */
export function resolveRequestedClass({ optsClass, env = process.env, layer2, currentFn } = {}) {
  if (optsClass != null && optsClass !== "") {
    const normalized = String(optsClass).trim().toLowerCase();
    if (!NODE_CLASSES.includes(normalized)) {
      throw new Error(`unrecognized node class: '${optsClass}' (valid: ${NODE_CLASSES.join(", ")})`);
    }
    return { nodeClass: normalized, source: "--class" };
  }
  if (env.CATALYST_NODE_CLASS) {
    const normalized = String(env.CATALYST_NODE_CLASS).trim().toLowerCase();
    if (!NODE_CLASSES.includes(normalized)) {
      throw new Error(`unrecognized CATALYST_NODE_CLASS: '${env.CATALYST_NODE_CLASS}' (valid: ${NODE_CLASSES.join(", ")})`);
    }
    return { nodeClass: normalized, source: "env" };
  }
  if (typeof currentFn === "function") return { nodeClass: currentFn(), source: "config" };
  // Read the config DIRECTLY (not readNodeClassRaw, which swallows errors) so a MALFORMED config
  // FAILS CLOSED — refusing before any side effect — rather than reading as absent ⇒ worker and then
  // running the worker path on a developer/monitor node.
  let cfg;
  try {
    cfg = readLayer2(layer2);
  } catch (e) {
    throw new Error(`Layer-2 config at ${layer2} is unreadable/malformed (${e.message}) — fix it or pass --class`);
  }
  const raw = cfg?.catalyst?.node?.class;
  if (raw == null) return { nodeClass: "worker", source: "config-default" };
  // A present-but-non-string class (e.g. [] / ["developer"] / 0 from a malformed config) must FAIL
  // CLOSED, not be String()-coerced into "" (→ worker) or a bogus class.
  if (typeof raw !== "string") {
    throw new Error(`malformed node class in ${layer2}: expected a string, got ${JSON.stringify(raw)} — fix it or pass --class`);
  }
  if (raw.trim() === "") return { nodeClass: "worker", source: "config-default" };
  const normalized = raw.trim().toLowerCase();
  if (!NODE_CLASSES.includes(normalized)) {
    throw new Error(`unrecognized node class in ${layer2}: '${raw}' (valid: ${NODE_CLASSES.join(", ")}) — pass --class to override`);
  }
  return { nodeClass: normalized, source: "config" };
}

/**
 * resolveReadReplica — the read-replica endpoint for this run, with the SAME default-to-current
 * precedence as the node class: explicit --read-replica > CATALYST_MONITOR_URL env > the value
 * already in Layer-2. Defaulting to the current value is what keeps `reinstall` (whose teardown
 * strips the key) from silently dropping a developer/monitor node's configured read source.
 * Returns the url or null. (Worker installs ignore it — a worker reads its own local replica.)
 */
export function resolveReadReplica({ flag = null, env = process.env, layer2 } = {}) {
  if (flag) return flag;
  if (env.CATALYST_MONITOR_URL) return env.CATALYST_MONITOR_URL;
  try {
    const v = readLayer2(layer2)?.catalyst?.readReplica?.baseUrl;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

// A worker is the only class that runs the full work stack (broker/exec-core/monitor); every
// other class is daemonless-with-updater. Centralized so the plan and the tests agree.
function isWorker(nodeClass) {
  return nodeClass === "worker";
}

/**
 * planPhases — PURE. Returns the ordered [{phase, steps}] plan for an operation+class. This is
 * both what `--dry-run` prints and what the per-class-correctness tests assert on (no execution).
 * Each step is data: { label, kind, argv?, key?, value?, keys?, optional?, fatalOnHealth? }.
 *   kind: "run" (shell argv) | "backup" (run + capture bundle) | "healthcheck" (run, non-fatal) |
 *         "setkey" | "removeconfig" | "verify-clean" (mjs-internal).
 */
export function planPhases({ operation, nodeClass, scripts, opts = {} }) {
  const worker = isWorker(nodeClass);

  // acquire registers the pluginDirs checkout, which writes catalyst.orchestration.pluginDirs into
  // Layer-2 BEFORE the (OTEL-locked) backup phase. This is an INTENTIONAL exemption from
  // backup-before-overwrite: the plugin-source checkout is git-reconstructable infra outside the
  // lifecycle's restore contract (hence pluginDirs is not in INSTALL_MANAGED_KEYS), and on a fresh
  // node the write is a first-time set, on an already-canonical node it is a no-op. reinstall is
  // unaffected (its backup is phase 1). Everything the lifecycle actually overwrites (node.class,
  // readReplica, secrets, launchd agents, catalyst.db) is written AFTER backup and so is restorable.
  const acquire = () => ({
    phase: "acquire",
    // --no-interactive-wrapper: the acquire step runs pre-backup and non-interactively,
    // so it does only the git-reconstructable work — the pluginDirs config write + the
    // reversible ~/.claude/skills symlinks. It SKIPS the stateful cutover (shell-rc
    // wrapper removal + `catalyst` marketplace/enablement retirement), which the backup
    // phase does not capture and a rollback could not restore; both are no-ops on a
    // fresh node anyway. The full cutover runs via the join stage / the documented
    // manual `bash setup-plugin-source.sh` run.
    steps: [{ label: "plugin-source", kind: "run", argv: [scripts.pluginSrc, "--no-interactive-wrapper"] }],
  });

  const backup = (label) => ({
    phase: "backup",
    steps: [{ label: "backup", kind: "backup", argv: [scripts.backup, "backup", "--label", label] }],
  });

  const writeConfig = () => {
    // NB: setup-catalyst.sh writes per-project secrets to the DEFAULT ~/.config/catalyst/config-<key>.json
    // path regardless of a CATALYST_LAYER2_CONFIG_FILE / CATALYST_MACHINE_CONFIG redirect (it does not
    // honor a config-dir override). On a real node the selected scope IS ~/.config/catalyst, so there is
    // no split; the split is only possible under a non-default config scope (a test/sandbox seam), where
    // those secrets land outside the backup/restore scope. A scoped-secrets override belongs in
    // setup-catalyst.sh, not here. set-class / pluginPullOwner / readReplica all stay under the selected scope.
    const steps = [
      { label: "set-class", kind: "run", argv: [scripts.catalyst, "class", nodeClass] },
      { label: "setup-catalyst", kind: "run", argv: [scripts.setup, "--non-interactive"] },
    ];
    if (worker) {
      // The worker path never runs adopt-updater (the broker is the puller), and install-services
      // doesn't touch pluginPullOwner — so a node promoted from developer would keep
      // pluginPullOwner=updater and the broker would defer pulls to a now-absent updater. Reset it to
      // broker so the worker's broker owns plugin freshness.
      steps.push({ label: "pull-owner", kind: "setkey", key: "catalyst.orchestration.pluginPullOwner", value: "broker" });
    } else if (opts.readReplica) {
      // A developer/monitor node reads a worker's monitor over HTTP — bind it when given. (Worker
      // reads its own local replica, so the key is meaningless there.) A missing endpoint is
      // surfaced by the developer verify-node rubric, not a hard install failure.
      steps.push({ label: "read-replica", kind: "setkey", key: "catalyst.readReplica.baseUrl", value: opts.readReplica });
    }
    // CTL-1401: when an executor is requested, durably provision the lever into execution-core.env —
    // the file the launcher sources on every start and whose CATALYST_EXECUTOR value arms CTL-1398's
    // SDK token path. execution-core.env is never stripped by remove-config, so this both survives a
    // reinstall AND makes the executor install-set rather than dependent on a fragile hand-edit. No
    // flag ⇒ no step ⇒ the node's existing executor (or the bg default) is preserved untouched.
    if (opts.executor) {
      steps.push({
        label: "set-executor",
        kind: "setenv",
        file: opts.execCoreEnv || execCoreEnvPath(),
        key: "CATALYST_EXECUTOR",
        value: opts.executor,
      });
    }
    return { phase: "write-config", steps };
  };

  const installAgents = () => ({
    phase: "install-agents",
    steps: [
      { label: "install-cli", kind: "run", argv: [scripts.installCli] },
      worker
        ? // worker: the full work stack (and its 4 launchd agents). NEVER adopt-updater.
          { label: "install-services", kind: "run", argv: [scripts.stack, "install-services"] }
        : // developer/monitor: the 5th updater agent as sole pull owner. NEVER install-services.
          { label: "adopt-updater", kind: "run", argv: [scripts.stack, "adopt-updater"] },
      // CTL-1401: the per-host cloud-sync replica writer runs on EVERY class (adopt-cloud-sync has no
      // node-class guard — workers read the replica from the scheduler hot path, dev/monitor via
      // catalyst-linear). Teardown's uninstall-services boots it OUT, so a reinstall MUST re-adopt it
      // or the node loses its local Linear replica and the 429 read-block returns. Idempotent (boots
      // out any existing agent first) and best-effort (optional): macOS-only launchd, and a tokenless
      // node installs the plist + idles cleanly. Ordered AFTER the class step so install-services has
      // already laid down the log-shipper that adopt-cloud-sync kickstarts for the 6th Loki stream.
      { label: "adopt-cloud-sync", kind: "run", argv: [scripts.stack, "adopt-cloud-sync"], optional: true },
    ],
  });

  const startDaemons = () => {
    const steps = [
      worker
        ? { label: "start-stack", kind: "run", argv: [scripts.stack, "start", "--yes"] }
        : // developer/monitor: boot-drain so a mis-rostered node still admits 0 work. Best-effort
          // (CTL-1352 auto-boot-drain is unbuilt) — verify-node confirms it took.
          { label: "drain", kind: "run", argv: [scripts.catalyst, "drain"], optional: true },
    ];
    // CTL-1401 (Codex P2): on an ADDITIVE worker install with --executor, `catalyst-stack start --yes`
    // is idempotent and won't restart an already-live exec-core, so the daemon keeps the OLD executor
    // until a manual restart — the install would report the lever set while new work runs on the old
    // executor. Restart exec-core to apply it (no-op at runtime if the lever didn't actually change).
    // A REINSTALL doesn't need this: its teardown already stopped exec-core, so start-stack brings up a
    // fresh daemon that sources the new env.
    if (worker && operation === "install" && opts.executor) {
      steps.push({ label: "restart-execcore", kind: "restart-execcore", argv: [scripts.execCore, "restart"] });
    }
    return { phase: "start-daemons", steps };
  };

  const healthcheck = () => ({
    phase: "healthcheck",
    steps: [
      { label: "verify-node", kind: "healthcheck", argv: [scripts.stack, "verify-node"] },
      // CTL-1369 PR4: the class-aware post-install verification — node-class + correct launchd agent
      // SET + sane pluginPullOwner for the class (catalyst-doctor --profile install). Complements
      // verify-node (daemon liveness + plugins-fresh). NON-fatal for rollback, but its verdict folds
      // into healthOk → the command exit code, so a mis-provisioned node (wrong agents/owner) fails.
      { label: "doctor", kind: "doctor", argv: [scripts.doctor, "--profile", "install", "--json"] },
    ],
  });

  const stopDaemons = () => ({
    phase: "stop-daemons",
    steps: [{ label: "stop-stack", kind: "run", argv: [scripts.stack, "stop"] }],
  });

  const removeAgents = () => ({
    phase: "remove-agents",
    steps: [
      // uninstall-services removes ALL launchd agents including the updater + reconciles the
      // pull-owner back to broker (CTL-1348). It removes the log-shipper plist but deliberately
      // leaves Alloy RUNNING; a `stop` now (plist gone) reaps the now-unmanaged Alloy so verify-clean
      // passes. Best-effort.
      { label: "uninstall-services", kind: "run", argv: [scripts.stack, "uninstall-services"] },
      { label: "reap-shipper", kind: "run", argv: [scripts.stack, "stop"], optional: true },
      { label: "uninstall-cli", kind: "run", argv: [scripts.installCli, "--uninstall"] },
    ],
  });

  const removeConfig = () => ({
    phase: "remove-config",
    steps: [{ label: "remove-keys", kind: "removeconfig", keys: [...INSTALL_MANAGED_KEYS] }],
  });

  const verifyClean = () => ({
    phase: "verify-clean",
    steps: [{ label: "verify-clean", kind: "verify-clean" }],
  });

  switch (operation) {
    case "install":
      return [acquire(), backup(`install-${nodeClass}`), writeConfig(), installAgents(), startDaemons(), healthcheck()];
    case "uninstall":
      return [backup(`uninstall-${nodeClass}`), stopDaemons(), removeAgents(), removeConfig(), verifyClean()];
    case "reinstall":
      // One backup at the top covers the whole reinstall; teardown then fresh provisioning.
      return [
        backup(`reinstall-${nodeClass}`),
        stopDaemons(),
        removeAgents(),
        removeConfig(),
        acquire(),
        writeConfig(),
        installAgents(),
        startDaemons(),
        healthcheck(),
      ];
    default:
      throw new Error(`unknown operation: ${operation} (valid: ${LIFECYCLE_OPERATIONS.join(", ")})`);
  }
}

// ── Layer-2 surgical edits (mjs-internal, jq-free, atomic) ──────────────────────
function readLayer2(path) {
  if (!path || !existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw); // a malformed config is a real error — let it throw (fail closed)
}

function writeLayer2Atomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// upsertEnvFile — CTL-1401. Idempotently set `export KEY=value` in a shell env file (execution-core.env,
// which the daemon launcher `source`s on every start). Replaces an existing KEY= line (with or without a
// leading `export`), otherwise appends; preserves all other lines and comments. Atomic (tmp + rename) and
// 0600 (the file can hold secrets). Matches the `export KEY=val` form the launcher + doctor parser expect.
export function upsertEnvFile(file, key, value) {
  let content = "";
  try {
    content = readFileSync(file, "utf8");
  } catch {
    /* missing → create fresh */
  }
  // Match optional leading whitespace too: bash applies an INDENTED `  KEY=…` line when it sources
  // the file, so an indented stale duplicate must also be replaced/dropped or it would win (Codex P2).
  const re = new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=`);
  const lines = content.length ? content.split("\n") : [];
  // Drop a single trailing empty line (from a prior terminal newline) so we re-add exactly one.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const newLine = `export ${key}=${value}`;
  // Replace the FIRST existing assignment in place and DROP every later duplicate. The launcher
  // `source`s the whole file, so a stale trailing `KEY=…` from a prior hand-edit would otherwise
  // win — leaving exactly one occurrence is what makes the lever deterministic (Codex P2).
  const out = [];
  let placed = false;
  for (const l of lines) {
    if (re.test(l)) {
      if (!placed) {
        out.push(newLine);
        placed = true;
      }
      // else: a duplicate assignment — drop it
    } else {
      out.push(l);
    }
  }
  if (!placed) out.push(newLine);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, `${out.join("\n")}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// revertEnvUndos — CTL-1401 rollback support. Restores each env file mutated by a `setenv` step to the
// pre-image captured before the write: re-writes the prior content, or deletes the file if it did not
// exist. Best-effort + atomic; applied in REVERSE so the earliest pre-image wins if a file was touched
// twice. Used only on the rollback path so a failed install/reinstall is a true reversal.
export function revertEnvUndos(undos, log = () => {}) {
  for (const { file, priorContent } of [...(undos || [])].reverse()) {
    try {
      if (priorContent === null) {
        rmSync(file, { force: true });
      } else {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
        writeFileSync(tmp, priorContent, { mode: 0o600 });
        renameSync(tmp, file);
      }
    } catch (e) {
      log(`catalyst-install: rollback note — could not revert env file ${file}: ${e?.message ?? e}`);
    }
  }
}

// Reject the JS prototype-chain keys so a dotted path can never walk into Object.prototype
// (prototype-pollution guard — the install-managed keys are all hardcoded constants today, but this
// keeps setDeepKey/deleteDeepKey safe by construction for any future caller). The check is INLINED
// at each computed-member access (not factored into a helper) so static analysis recognises it as a
// sanitiser of the very key used in the bracket write.
function isUnsafeKey(k) {
  return k === "__proto__" || k === "prototype" || k === "constructor";
}

// readDeepKey — value at a dotted path (or undefined). Read-only; no prototype-walk risk.
export function readDeepKey(obj, dottedKey) {
  let cur = obj;
  for (const k of dottedKey.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

export function setDeepKey(obj, dottedKey, value) {
  const parts = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (isUnsafeKey(k)) throw new Error(`unsafe config key segment: '${k}'`);
    if (typeof cur[k] !== "object" || cur[k] == null) cur[k] = {};
    cur = cur[k];
  }
  const leaf = parts[parts.length - 1];
  if (isUnsafeKey(leaf)) throw new Error(`unsafe config key segment: '${leaf}'`);
  cur[leaf] = value;
}

export function deleteDeepKey(obj, dottedKey) {
  const parts = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (isUnsafeKey(k)) throw new Error(`unsafe config key segment: '${k}'`);
    if (typeof cur[k] !== "object" || cur[k] == null) return false; // path absent → nothing to delete
    cur = cur[k];
  }
  const leaf = parts[parts.length - 1];
  if (isUnsafeKey(leaf)) throw new Error(`unsafe config key segment: '${leaf}'`);
  if (Object.prototype.hasOwnProperty.call(cur, leaf)) {
    delete cur[leaf];
    return true;
  }
  return false;
}

// ── default real deps (overridable for tests) ──────────────────────────────────
// cwd is pinned to REPO_ROOT: setup-catalyst.sh derives its target repo from the cwd's git root,
// so without this `catalyst install` from an arbitrary directory would hard-fail or onboard the
// wrong repo. The other composed tools self-resolve via BASH_SOURCE (cwd-independent), so pinning
// the checkout root for all steps is safe + deterministic regardless of where the operator runs it.
function defaultRunStep({ argv, env, cwd }) {
  const res = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    cwd: cwd || REPO_ROOT,
    // The composed setup tools (setup-catalyst.sh, install-cli.sh, brew/git helpers) are chatty;
    // the default 1 MB pipe buffer would make spawnSync ENOBUFS-error on a verbose-but-successful
    // child and the lifecycle would wrongly treat it as a failure. 64 MB headroom.
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(env || {}) },
  });
  if (res.error) return { code: 127, stdout: "", stderr: String(res.error.message || res.error) };
  return { code: res.status == null ? 1 : res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

// probeDaemons — is a broker/execution-core daemon live? Honors CATALYST_ASSUME_NO_DAEMONS=1 as a
// test seam, and (like catalyst-backup) FAILS SAFE: if liveness can't be determined, assume LIVE
// so the teardown guard refuses without --force.
function defaultProbeDaemons(env = process.env) {
  if (env.CATALYST_ASSUME_NO_DAEMONS === "1") return false;
  const res = spawnSync("pgrep", ["-f", "broker/index.mjs|execution-core/(daemon|index)\\.mjs"], { encoding: "utf8" });
  if (res.error) return true; // pgrep missing → assume LIVE (safe)
  return res.status === 0;
}

// probeResidualAgents — after teardown, is ANYTHING catalyst still installed/running? Unlike
// probeDaemons (broker/exec-core only — the work-liveness signal the teardown GUARD uses), this is
// the honest verify-clean check: it also catches the updater agent (the ONLY daemon a developer/
// monitor node runs) and any residual launchd plist. Deterministic on the plist files; the process
// pgrep is best-effort. Honors CATALYST_LAUNCHAGENTS_DIR + CATALYST_ASSUME_NO_DAEMONS test seams.
// RESIDUAL_AGENT_PATTERN — every catalyst stack PROCESS an uninstall's verify-clean must find if a
// teardown left it running (the monitor + otel-forward are nohup children; the Alloy log-shipper is
// deliberately left up by `stop`). CTL-1401 (Codex P2): includes `cloud-sync` now that every install
// adopts it — a failed `launchctl bootout` can leave the writer running with no plist on disk.
export const RESIDUAL_AGENT_PATTERN =
  "broker/index.mjs|execution-core/(daemon|index|updater/updater|cloud-sync)\\.mjs|orch-monitor/server\\.ts|otel-forward/index\\.ts|alloy run .*log-shipper";

function defaultProbeResidualAgents(env = process.env) {
  const laDir = env.CATALYST_LAUNCHAGENTS_DIR || join(homedir(), "Library", "LaunchAgents");
  try {
    if (readdirSync(laDir).some((f) => /^ai\.coalesce\.catalyst-.*\.plist$/.test(f))) return true;
  } catch {
    /* launchagents dir absent → no agents */
  }
  if (env.CATALYST_ASSUME_NO_DAEMONS === "1") return false;
  // Covers every stack daemon, not just broker/exec-core: the monitor (orch-monitor/server.ts) and
  // otel-forward (otel-forward/index.ts) are nohup children of the stack, and the CATALYST Alloy
  // log-shipper (matched by its log-shipper config path, NOT any Alloy on the host) is deliberately
  // LEFT running by `catalyst-stack stop`/`uninstall-services` — so if a teardown didn't reap them,
  // an uninstall must not look clean.
  const res = spawnSync("pgrep", ["-f", RESIDUAL_AGENT_PATTERN], { encoding: "utf8" });
  if (res.error) return false; // can't probe processes; the plist check above already ran
  return res.status === 0;
}

// probeUpdaterAgent — is the developer/monitor catalyst-updater LaunchAgent installed? Used to refuse
// a `install --class worker` that would otherwise leave the updater running alongside the broker (the
// CTL-1348 two-puller race). Honors CATALYST_LAUNCHAGENTS_DIR.
function defaultProbeUpdaterAgent(env = process.env) {
  const laDir = env.CATALYST_LAUNCHAGENTS_DIR || join(homedir(), "Library", "LaunchAgents");
  if (existsSync(join(laDir, "ai.coalesce.catalyst-updater.plist"))) return true;
  // Plist-gone-but-process-alive: a manual/partial cleanup can leave the updater daemon running
  // without its plist — still the two-puller hazard, so check process liveness too.
  if (env.CATALYST_ASSUME_NO_DAEMONS === "1") return false;
  const r = spawnSync("pgrep", ["-f", "execution-core/updater/updater\\.mjs"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

// bundleHasCapturedAgents — did the backup snapshot any launchd agent plists? If so the node had
// PRE-EXISTING agents before this run (a retry/reinstall on a working node), so rollback must NOT
// boot them out (catalyst-backup restore re-lays the plist FILES but never re-bootstraps them, so a
// teardown would leave a previously-working node's services down). When false (a fresh node, no
// agents captured) rollback safely removes whatever provisioning installed this run.
function defaultBundleHasCapturedAgents(bundlePath) {
  try {
    const m = JSON.parse(readFileSync(join(bundlePath, "manifest.json"), "utf8"));
    return Array.isArray(m.captured) && m.captured.some((p) => p.startsWith("launchagents/") && p.endsWith(".plist"));
  } catch {
    return false; // unreadable manifest → treat as fresh (safe to tear down newly-installed agents)
  }
}

// probeWorkerAgents — is the worker stack LaunchAgent installed (even if its daemons are stopped)?
// A stopped-but-installed worker stack would RunAtLoad/StartInterval broker/exec-core back, so a
// developer/monitor install must refuse it, not just a currently-LIVE stack. Honors CATALYST_LAUNCHAGENTS_DIR.
function defaultProbeWorkerAgents(env = process.env) {
  const laDir = env.CATALYST_LAUNCHAGENTS_DIR || join(homedir(), "Library", "LaunchAgents");
  return existsSync(join(laDir, "ai.coalesce.catalyst-stack.plist"));
}

// probeCliInstalled — was a `catalyst` CLI symlink already on the node before this run? Used to decide
// whether a fresh-install rollback should uninstall the symlinks (created this run) or leave them
// (pre-existed). Honors CATALYST_BIN_DIR (the install-cli target).
function defaultProbeCliInstalled(env = process.env) {
  const binDir = env.CATALYST_BIN_DIR || env.CATALYST_CLI_BIN_DIR || join(homedir(), ".catalyst", "bin");
  return existsSync(join(binDir, "catalyst"));
}

// probeDrained — is this node FULLY drained, i.e. admitting 0 new work AND with 0 in-flight tickets?
// `draining:true` alone is NOT enough — a worker can be draining with work still landing, and stopping
// its daemon then would kill in-flight work. So the teardown guard only treats the node as drained
// when an explicit drained sentinel is set OR draining is on with inFlightCount === 0. Best-effort;
// unknown ⇒ false (the guard then requires --force on a live node, the safe default).
// isDrainedStatus — PURE interpretation of `catalyst-execution-core drain --json` output: fully
// drained iff an explicit `drained` sentinel is set, OR `draining` is on with ZERO in-flight tickets.
export function isDrainedStatus(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.drained === true) return true;
  // draining:true alone is NOT drained — require an explicit, present, finite in-flight count of 0.
  // A MISSING count (skewed/degraded status) is UNKNOWN ⇒ fail closed (the guard requires --force).
  const rawCount = parsed.inFlightCount ?? parsed.inflight;
  if (rawCount == null) return false;
  const inFlight = Number(rawCount);
  return parsed.draining === true && Number.isFinite(inFlight) && inFlight === 0;
}

function defaultProbeDrained({ scripts, env = process.env } = {}) {
  if (env.CATALYST_ASSUME_DRAINED === "1") return true;
  const res = spawnSync(scripts.catalyst, ["drain", "--status-read", "--json"], { encoding: "utf8" });
  if (res.error || res.status !== 0 || !res.stdout) return false;
  try {
    return isDrainedStatus(JSON.parse(res.stdout));
  } catch {
    return false;
  }
}

// runDoctorPass — CTL-1369 PR4. Run `catalyst-doctor --profile install --json` and parse its summary.
// doctor's exit code is its FAIL count; its stdout is { ok, counts:{pass,warn,fail}, checks:[...] }.
// Best-effort: an unrunnable/unparseable doctor returns { ok: null } (advisory — never fails an
// otherwise-good install on a doctor/telemetry hiccup; the install IS done). Drives BOTH the
// pre-install before-snapshot (observe-only) and the post-install verification (folds into healthOk).
// Injectable runStep for tests.
function defaultRunDoctorPass({ argv, env, runStep = defaultRunStep }) {
  const r = runStep({ argv, env });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    /* unparseable doctor output → advisory (ok:null) */
  }
  const fails = Array.isArray(parsed?.checks)
    ? parsed.checks.filter((c) => c?.status === "fail").map((c) => c?.name)
    : null;
  return {
    ok: parsed && typeof parsed.ok === "boolean" ? parsed.ok : null, // null = could not determine (advisory)
    rc: r.code,
    counts: parsed?.counts ?? null,
    fails,
  };
}

export function buildDefaultDeps(env) {
  const scripts = resolveScripts(env);
  return {
    scripts,
    env,
    layer2: layer2Path(env),
    runStep: defaultRunStep,
    emit: makeInstallEmitFn({}),
    nowFn: Date.now,
    genTraceId: () => randomBytes(16).toString("hex"),
    genSpanId: () => randomBytes(8).toString("hex"),
    probeDaemons: () => defaultProbeDaemons(env),
    probeResidualAgents: () => defaultProbeResidualAgents(env),
    probeDrained: () => defaultProbeDrained({ scripts, env }),
    bundleHasCapturedAgents: (p) => defaultBundleHasCapturedAgents(p),
    probeWorkerAgents: () => defaultProbeWorkerAgents(env),
    probeCliInstalled: () => defaultProbeCliInstalled(env),
    scriptExists: (p) => existsSync(p),
    binExists: (name) => {
      const r = spawnSync("sh", ["-c", `command -v "${name}" >/dev/null 2>&1`]);
      return !r.error && r.status === 0;
    },
    probeUpdaterAgent: () => defaultProbeUpdaterAgent(env),
    log: (msg) => process.stderr.write(`${msg}\n`),
    InstallRunCtor: InstallRun,
  };
}

// Only install + reinstall overwrite node state, so only they roll back. Uninstall teardown is not
// auto-rolled-back (restoring a half-torn-down node is riskier than leaving it with a loud backup
// pointer for the operator).
function autoRollbacks(operation) {
  return operation === "install" || operation === "reinstall";
}

// Teardown operations stop daemons — refuse to run one against a live, non-drained node unless
// forced (the "uninstall guards a live node" property).
function isTeardown(operation) {
  return operation === "uninstall" || operation === "reinstall";
}

/**
 * runInstallLifecycle — drives the plan through an InstallRun. Returns a result object; never
 * throws for a normal lifecycle failure (the outcome is in the return). Telemetry is best-effort.
 *
 * deps (all injectable): scripts, env, layer2, runStep, emit, nowFn, genTraceId, genSpanId,
 *   probeDaemons, probeResidualAgents, probeDrained, bundleHasCapturedAgents, scriptExists, log,
 *   InstallRunCtor.
 */
export async function runInstallLifecycle({ operation, nodeClass, opts = {} }, deps) {
  const { scripts, env, layer2, runStep, runDoctorPass, emit, nowFn, genTraceId, genSpanId, probeDaemons, probeResidualAgents, probeDrained, bundleHasCapturedAgents, scriptExists, binExists, probeUpdaterAgent, probeWorkerAgents, probeCliInstalled, log, InstallRunCtor } = deps;
  // CTL-1401: only on macOS is an adopt-cloud-sync non-zero a GENUINE failure (a launchctl error that
  // may have left the writer torn down) — on a non-launchd OS it is the expected "macOS-only" skip, so
  // there it stays a benign optional warn. Injectable for tests.
  const isDarwin = deps.isDarwin ?? process.platform === "darwin";

  // Every composed step inherits (a) the RESOLVED class so the bash tools (which re-derive class
  // env-first) cannot diverge from the lifecycle's target — e.g. `install --class developer` on a
  // shell exporting CATALYST_NODE_CLASS=worker must still adopt-updater (mirrors doctor.mjs pinning
  // CATALYST_NODE_CLASS for verify-node); (b) the driver's exact Layer-2 file under BOTH config env
  // names the child tools honor, so the whole run reads/writes ONE config (else an XDG/
  // CATALYST_MACHINE_CONFIG redirect would split node.class/readReplica and pluginDirs/pluginPullOwner
  // across two files and break rollback's single restorable state); and (c) the standard install-bin
  // dirs on PATH so a later step (e.g. adopt-updater's `command -v bun` preflight) finds a tool that
  // setup-catalyst just installed into ~/.bun/bin / ~/.local/bin within its own child process.
  const home = (env.HOME || homedir());
  // Seed the catalyst CLI bin dir (where install-cli.sh just created the symlinks) + the standard
  // install-bin dirs, so a later step finds tools this run installed — e.g. `catalyst-stack start`
  // shells out to catalyst-broker/monitor/execution-core by name, and adopt-updater's `command -v bun`.
  const cliBinDir = env.CATALYST_BIN_DIR || env.CATALYST_CLI_BIN_DIR || `${home}/.catalyst/bin`;
  const seededPath = [cliBinDir, `${home}/.bun/bin`, `${home}/.local/bin`, env.PATH].filter(Boolean).join(":");
  const stepEnv = { ...env, CATALYST_NODE_CLASS: nodeClass, CATALYST_LAYER2_CONFIG_FILE: layer2, CATALYST_MACHINE_CONFIG: layer2, PATH: seededPath };

  // CTL-1369 PR4: the doctor pre/post passes verify the node's PERSISTED installed state. The composed
  // bash tools get CATALYST_NODE_CLASS pinned to the REQUESTED class (they must act on the target), but
  // the DOCTOR must NOT — resolveNodeClass reads CATALYST_NODE_CLASS before Layer-2, so pinning it would
  // make the node-class check PASS from the requested class even if write-config never persisted
  // catalyst.node.class (Codex P2). So doctorEnv clears it (empty ⇒ resolveNodeClass falls through to the
  // Layer-2 the install wrote, which CATALYST_LAYER2_CONFIG_FILE still points at). The doctor passes route
  // through the lifecycle's INJECTED runStep by default (so a test stubbing runStep stubs doctor too) and
  // remain overridable via deps.runDoctorPass for focused tests.
  const doctorEnv = { ...stepEnv, CATALYST_NODE_CLASS: "" };
  const callDoctor = (argv) =>
    typeof runDoctorPass === "function"
      ? runDoctorPass({ argv, env: doctorEnv })
      : defaultRunDoctorPass({ argv, env: doctorEnv, runStep });

  // Pre-flight live-node guard (teardown only) — refuse BEFORE starting a run.
  if (isTeardown(operation) && !opts.force) {
    if (probeDaemons() && !probeDrained()) {
      log(
        `catalyst-install: refusing to ${operation} a live, non-drained node — drain first ` +
          `('catalyst drain') then retry, or pass --force.`,
      );
      return { outcome: "refused", reason: "live-node" };
    }
  }

  const plan = planPhases({ operation, nodeClass, scripts, opts });

  // Pre-flight: every composed script the plan will shell out to must exist. setup-catalyst.sh lives
  // at the repo root (NOT packaged in the plugin cache), so a cache-context run would otherwise take
  // a full backup — or, on reinstall, TEAR THE NODE DOWN — and only then fail. Fail fast instead.
  // EXCEPTION: the kind:"doctor" step is ADVISORY (best-effort) — an absent catalyst-doctor binary must
  // degrade the doctor pass to ok:null (defaultRunDoctorPass), NOT refuse an otherwise-valid install
  // (CTL-1369 PR4 Codex P2). So it is excluded from this hard-prerequisite preflight.
  const planScripts = [...new Set(plan.flatMap((p) => p.steps).filter((s) => s.argv && s.kind !== "doctor").map((s) => s.argv[0]))];
  const missingScripts = planScripts.filter((p) => !scriptExists(p));
  if (missingScripts.length) {
    log(
      `catalyst-install: refusing ${operation} — required script(s) not found: ${missingScripts.join(", ")}. ` +
        `Run from a repo checkout (not the plugin cache), or set the CATALYST_INSTALL_*_SCRIPT overrides.`,
    );
    return { outcome: "refused", reason: "missing-script", missing: missingScripts };
  }

  // Pre-flight: the hard CLI prerequisites the early phases need (acquire's setup-plugin-source and
  // the backup both `require_cmd jq`/git). The installer is a checkout-context op, not a bare-metal
  // bootstrapper — fail fast with an actionable message rather than dying mid-acquire.
  const missingBins = ["git", "jq"].filter((b) => !binExists(b));
  if (missingBins.length) {
    log(`catalyst-install: refusing ${operation} — required tool(s) not on PATH: ${missingBins.join(", ")}. Install them first (e.g. brew install ${missingBins.join(" ")}).`);
    return { outcome: "refused", reason: "missing-prereq", missing: missingBins };
  }

  // Pre-flight: a `install --class worker` on a node that still has the developer/monitor updater
  // agent would run BOTH the broker AND the updater pulling the plugin checkout (the CTL-1348
  // two-puller race) — resetting pluginPullOwner alone doesn't STOP the updater daemon. Refuse and
  // steer to `reinstall` (whose teardown removes the updater), unless --force.
  if (operation === "install" && isWorker(nodeClass) && !opts.force && probeUpdaterAgent()) {
    log(
      `catalyst-install: refusing install --class worker — a developer/monitor updater agent is still ` +
        `installed (the two-puller hazard). Switch profiles with 'catalyst reinstall --class worker' ` +
        `(its teardown removes the updater), or pass --force.`,
    );
    return { outcome: "refused", reason: "stale-updater" };
  }
  // The symmetric case: a `install --class developer|monitor` over a worker stack would set the class +
  // adopt the updater while leaving the worker stack in place — the exact mixed profile the per-class
  // invariant forbids. Check both LIVE daemons AND an INSTALLED-but-stopped stack agent (which would
  // RunAtLoad/StartInterval the daemons back on a developer node). Refuse → reinstall, unless --force.
  if (operation === "install" && !isWorker(nodeClass) && !opts.force && (probeDaemons() || probeWorkerAgents())) {
    log(
      `catalyst-install: refusing install --class ${nodeClass} — a worker stack (broker/execution-core ` +
        `daemons or their LaunchAgent) is present. Switch profiles with 'catalyst reinstall --class ` +
        `${nodeClass}' (its teardown removes the worker stack), or pass --force.`,
    );
    return { outcome: "refused", reason: "live-worker-stack" };
  }

  // CTL-1369 PR4: pre-install doctor — capture the node's BEFORE-state on the SAME class-aware
  // install rubric the post-install verification uses, so the install trace shows before→after (the
  // "SEE an install run" thesis). OBSERVE-ONLY: a fresh node legitimately FAILs the install profile
  // (no agents yet), so this never refuses — the lifecycle's typed guards above (stale-updater /
  // live-worker-stack / live-node) are the refusal mechanism for a genuinely bad pre-state. Only
  // install/reinstall (the provisioning ops, which have doctor in their plan) get a before-snapshot.
  // Best-effort (ok:null when doctor can't run); the summary rides the started event's body payload.
  let preDoctor = null;
  if (operation === "install" || operation === "reinstall") {
    try {
      preDoctor = callDoctor([scripts.doctor, "--profile", "install", "--json"]);
      if (preDoctor) {
        const c = preDoctor.counts;
        log(`catalyst-install: pre-install doctor (--profile install): ${preDoctor.ok === null ? "could not run (advisory)" : preDoctor.ok ? "PASS" : `${c ? c.fail : "?"} fail`} (before-state)`);
      }
    } catch {
      preDoctor = null; // observation must never break an install
    }
  }

  const traceId = genTraceId();
  const spanId = genSpanId();
  const run = new InstallRunCtor({ operation, nodeClass, emit, traceId, spanId, nowFn }).start({ class: nodeClass, preDoctor });

  // Snapshot the node's PRE-RUN state BEFORE the first phase (acquire) writes anything. Used by
  // rollback: a fresh node (no managed keys / no CLI before the run) gets those artifacts removed,
  // and a custom pre-existing pluginDirs (which acquire overwrites before the install backup) is
  // restored. (Captured from the live config now, not from the backup — acquire runs before the
  // install backup, so the bundle already reflects acquire's pluginDirs write.)
  let preCfg = {};
  try {
    preCfg = readLayer2(layer2);
  } catch {
    /* malformed pre-run config — resolveRequestedClass already failed closed; treat as empty here */
  }
  const preInstall = {
    hadManagedKeys: INSTALL_MANAGED_KEYS.some((k) => readDeepKey(preCfg, k) != null),
    hadCli: probeCliInstalled(),
    pluginDirs: readDeepKey(preCfg, "catalyst.orchestration.pluginDirs") ?? null,
  };

  const ctx = { bundlePath: null, healthOk: true, healthRc: null, cleanOk: true, teardownRan: false, doctorOk: true, doctorRc: null, doctorSummary: null, cloudSyncOk: true, envUndos: [], executorChanged: false };

  const runOneStep = async (step) => {
    switch (step.kind) {
      case "backup": {
        const r = runStep({ argv: step.argv, env: stepEnv });
        if (r.code !== 0) throw new Error(`backup failed (rc ${r.code}) — aborting before any overwrite: ${r.stderr.trim()}`);
        // catalyst-backup prints the bundle path on its LAST stdout line.
        const lines = r.stdout.trim().split("\n").filter(Boolean);
        ctx.bundlePath = lines.length ? lines[lines.length - 1] : null;
        log(`catalyst-install: backup → ${ctx.bundlePath}`);
        return;
      }
      case "run": {
        const r = runStep({ argv: step.argv, env: stepEnv });
        // Record that this run booted out the node's launchd agents (the reinstall teardown), so the
        // rollback handler knows the agents are DOWN and must re-bootstrap rather than file-restore alone.
        if (step.label === "uninstall-services" && r.code === 0) ctx.teardownRan = true;
        if (r.code !== 0) {
          if (step.optional) {
            // CTL-1401 (Codex P2): adopt-cloud-sync is optional for PORTABILITY (it hard-fails as
            // macOS-only off launchd), but on macOS a non-zero is a REAL failure — and cmd_adopt_cloud_sync
            // boots the existing agent out BEFORE re-bootstrapping, so a mid-failure can leave the node
            // WITHOUT cloud-sync (the local-replica regression we're fixing). The install profile doctor
            // doesn't check cloud-sync, so don't silently swallow it: record it so the run reports
            // completed-but-degraded (exit 1) instead of a clean success. Still non-fatal for rollback.
            if (step.label === "adopt-cloud-sync" && isDarwin) {
              ctx.cloudSyncOk = false;
              log(`catalyst-install: WARN — adopt-cloud-sync FAILED on macOS (rc ${r.code}) — the cloud-sync writer may be DOWN; node's local Linear replica is at risk: ${r.stderr.trim()}`);
            } else {
              log(`catalyst-install: WARN — optional step '${step.label}' failed (rc ${r.code}), continuing: ${r.stderr.trim()}`);
            }
            return;
          }
          throw new Error(`step '${step.label}' failed (rc ${r.code}): ${r.stderr.trim()}`);
        }
        return;
      }
      case "setkey": {
        const cfg = readLayer2(layer2);
        setDeepKey(cfg, step.key, step.value);
        writeLayer2Atomic(layer2, cfg);
        log(`catalyst-install: set ${step.key} = ${step.value}`);
        return;
      }
      case "setenv": {
        // CTL-1401: idempotent upsert into the daemon env file (execution-core.env). Not a Layer-2
        // key, so it survives remove-config; the launcher sources it on the next start to apply.
        // Codex P2 — execution-core.env is NOT in the catalyst-backup capture set, so a later-phase
        // failure would roll back the bundle while leaving this lever flipped. Capture the pre-image
        // (the file's prior content, or null if it didn't exist) so the rollback handler can revert
        // this exact mutation and the run is a TRUE reversal.
        let priorContent = null;
        try {
          priorContent = readFileSync(step.file, "utf8");
        } catch {
          /* file did not exist → undo = delete */
        }
        ctx.envUndos.push({ file: step.file, priorContent });
        // CTL-1401 (Codex P2): note whether the executor lever actually CHANGED, so an additive install
        // only restarts a live exec-core when needed (an unchanged re-run must not interrupt work). The
        // pre-upsert EFFECTIVE value is the LAST assignment, not the first — bash sources the whole file
        // top-to-bottom so a later duplicate wins (the exact case upsertEnvFile dedupes). Reading the
        // first match here would miss a `sdk`-then-`bg` file and skip the needed restart (Codex P2).
        if (step.key === "CATALYST_EXECUTOR") {
          const matches = [...(priorContent || "").matchAll(/^\s*(?:export\s+)?CATALYST_EXECUTOR=["']?([^"'\s]+)/gm)];
          const effectiveOld = matches.length ? matches[matches.length - 1][1] : null;
          ctx.executorChanged = effectiveOld !== step.value;
        }
        upsertEnvFile(step.file, step.key, step.value);
        log(`catalyst-install: set ${step.key}=${step.value} in ${step.file}`);
        return;
      }
      case "removeconfig": {
        const cfg = readLayer2(layer2);
        const removed = [];
        for (const k of step.keys) if (deleteDeepKey(cfg, k)) removed.push(k);
        writeLayer2Atomic(layer2, cfg);
        log(
          `catalyst-install: removed install-managed keys [${removed.join(", ") || "none"}] from ${layer2} ` +
            `(secrets preserved — they are also in the backup)`,
        );
        return;
      }
      case "healthcheck": {
        // NON-fatal for rollback (an unhealthy node is still installed — never roll back on it), but
        // the verdict DOES drive the command's exit code (see main()).
        const r = runStep({ argv: step.argv, env: stepEnv });
        ctx.healthRc = r.code;
        ctx.healthOk = r.code === 0;
        log(`catalyst-install: healthcheck (verify-node) ${ctx.healthOk ? "PASS" : `FAIL (rc ${r.code})`}`);
        return;
      }
      case "doctor": {
        // CTL-1369 PR4: post-install class-aware verification. NON-fatal for rollback (the node IS
        // installed), but its verdict folds into healthOk → the command exit code. Best-effort: a
        // doctor that can't run / can't be parsed (ok:null) is ADVISORY — it must not fail an
        // otherwise-good install on a doctor hiccup; only an explicit doctor FAIL (ok:false) does.
        // Best-effort + fail-safe: a doctor pass that THROWS (a future runStep/runDoctorPass contract
        // change, or an injected stub that throws) must NOT propagate out of run.phase("healthcheck")
        // into the outer catch — that would ROLL BACK an already-fully-provisioned node. Degrade to
        // advisory (ok:null) instead, symmetric with the try/catch-guarded pre-install pass.
        let summary;
        try {
          summary = callDoctor(step.argv) || { ok: null, rc: null, counts: null, fails: null };
        } catch (e) {
          summary = { ok: null, rc: null, counts: null, fails: null };
          log(`catalyst-install: post-install doctor errored (advisory — install not failed): ${e?.message ?? e}`);
        }
        ctx.doctorSummary = summary;
        ctx.doctorRc = summary.rc;
        ctx.doctorOk = summary.ok !== false; // null (couldn't determine) → advisory PASS; false → fail
        log(
          `catalyst-install: doctor (--profile install) ` +
            (summary.ok === null
              ? "could not run (advisory — install not failed on this)"
              : summary.ok
                ? "PASS (node-class + agent set + pull-owner correct for class)"
                : `FAIL [${(summary.fails || []).join(", ") || `rc ${summary.rc}`}] — node provisioned but not class-correct`),
        );
        return;
      }
      case "restart-execcore": {
        // CTL-1401 (Codex P2): apply an executor change to a LIVE exec-core. Only restarts when the
        // setenv actually changed the lever (an unchanged re-run must not interrupt running work).
        // NON-fatal: the lever is already persisted in execution-core.env, so a failed restart just
        // means the change takes effect on the next start — surface it loudly, never roll back on it.
        if (!ctx.executorChanged) {
          log(`catalyst-install: executor unchanged — exec-core restart not needed`);
          return;
        }
        const r = runStep({ argv: step.argv, env: stepEnv });
        if (r.code !== 0) {
          log(`catalyst-install: WARN — exec-core restart failed (rc ${r.code}); the new executor is persisted and applies on the next start — restart manually to apply now: ${r.stderr.trim()}`);
        } else {
          log(`catalyst-install: restarted exec-core to apply the executor change`);
        }
        return;
      }
      case "verify-clean": {
        // NON-fatal for rollback, but the verdict drives the exit code for teardown ops (see main()).
        // Uses the residual-agent probe (NOT probeDaemons) so it honestly catches the updater agent —
        // the only daemon a developer/monitor node runs — and any leftover launchd plist.
        const residual = probeResidualAgents();
        ctx.cleanOk = !residual;
        log(`catalyst-install: verify-clean ${ctx.cleanOk ? "PASS (no catalyst agents/daemons remain)" : "FAIL (catalyst agents/daemons STILL PRESENT)"}`);
        return;
      }
      default:
        throw new Error(`unknown step kind: ${step.kind}`);
    }
  };

  try {
    for (const { phase, steps } of plan) {
      // One InstallRun.phase per phase (times + emits catalyst.install.phase); a phase groups its
      // ordered steps. A thrown step aborts the phase and re-raises to the rollback handler.
      // eslint-disable-next-line no-await-in-loop
      await run.phase(phase, async () => {
        for (const step of steps) {
          // eslint-disable-next-line no-await-in-loop
          await runOneStep(step);
        }
      });
    }
    if (!ctx.cleanOk) {
      // A teardown that left catalyst agents/daemons present is a FAILED teardown: emit `failed`
      // telemetry (NOT `completed`) so dashboards/alerts keyed on the low-card terminal outcome don't
      // count a dirty uninstall as a success. (verify-clean is non-fatal for ROLLBACK — it never
      // triggers a restore — but the run's OUTCOME is a failure.) cleanOk is only ever false for
      // uninstall (the only op with a verify-clean phase).
      const e = new Error("verify-clean: catalyst agents/daemons still present after teardown — node not fully torn down");
      run.fail(e, { rolledBack: false, detail: { reason: "dirty-teardown", cleanOk: false } });
      return { outcome: "failed", error: e.message, healthOk: ctx.healthOk, healthRc: ctx.healthRc, cleanOk: false, bundlePath: ctx.bundlePath, traceId };
    }
    // CTL-1369 PR4: the completed event carries BOTH doctor summaries (before via started, after here)
    // so the install trace shows the node's health change. doctorOk folds into the command exit code
    // (in main), so a node that provisioned but is NOT class-correct (wrong agents/owner) exits non-zero.
    run.complete({ class: nodeClass, healthOk: ctx.healthOk, doctorOk: ctx.doctorOk, cleanOk: ctx.cleanOk, cloudSyncOk: ctx.cloudSyncOk, bundle: ctx.bundlePath, postDoctor: ctx.doctorSummary });
    return { outcome: "completed", healthOk: ctx.healthOk, healthRc: ctx.healthRc, doctorOk: ctx.doctorOk, doctorRc: ctx.doctorRc, doctorFails: ctx.doctorSummary?.fails ?? null, cleanOk: ctx.cleanOk, cloudSyncOk: ctx.cloudSyncOk, bundlePath: ctx.bundlePath, traceId };
  } catch (err) {
    let rolledBack = false;
    // CTL-1401 (Codex P2): revert any execution-core.env mutation made by a `setenv` step (the
    // `--executor` lever) BEFORE the bundle restore. execution-core.env is outside catalyst-backup's
    // capture set, so without this a rolled-back run would leave CATALYST_EXECUTOR flipped for the next
    // daemon start. No-op when no setenv ran.
    revertEnvUndos(ctx.envUndos, log);
    // disposition: "none" = nothing to undo (failed before/at backup) → benign abort; "ok" = fully
    // reverted; "failed" = restore failed → node in a PARTIAL state. Stamped into the terminal event
    // so a dashboard can tell a safe abort from a node that needs manual recovery (the riskiest case).
    let rollbackDisposition = "none";
    if (autoRollbacks(operation) && ctx.bundlePath) {
      log(`catalyst-install: ${operation} failed — rolling back from ${ctx.bundlePath}`);
      // `catalyst-backup restore` is ADDITIVE: it re-lays captured config/db/plist FILES but never
      // DELETES files created after the snapshot, nor re-bootstraps/restarts agents, and it can corrupt
      // config/db if forced over LIVE broker/exec-core. Four cases, keyed on whether the node's ORIGINAL
      // state (the backup) had launchd agents and whether this run already tore the node down.
      const teardownRan = ctx.teardownRan;
      const hadAgents = bundleHasCapturedAgents(ctx.bundlePath);
      const restoreNode = () => runStep({ argv: [scripts.backup, "restore", ctx.bundlePath, "--force"], env: stepEnv });
      // bootOutAgents → true iff BOTH uninstall-services and stop succeeded. A failed cleanup must drop
      // the rollback to incomplete (agents could still be running), so the caller folds this into rolledBack.
      const bootOutAgents = () => {
        const unsvc = runStep({ argv: [scripts.stack, "uninstall-services"], env: stepEnv });
        if (unsvc.code !== 0) log(`catalyst-install: rollback note — uninstall-services rc ${unsvc.code} (agents may remain): ${unsvc.stderr.trim()}`);
        const stop = runStep({ argv: [scripts.stack, "stop"], env: stepEnv });
        if (stop.code !== 0) log(`catalyst-install: rollback note — stop rc ${stop.code}`);
        return unsvc.code === 0 && stop.code === 0;
      };
      const stripManagedKeys = () => {
        try {
          const cfg = readLayer2(layer2);
          let changed = false;
          for (const k of INSTALL_MANAGED_KEYS) if (deleteDeepKey(cfg, k)) changed = true;
          if (changed) writeLayer2Atomic(layer2, cfg);
        } catch (e) {
          log(`catalyst-install: rollback note — could not strip install-managed keys: ${e.message}`);
        }
      };
      // reBootstrapRestoredClass — re-run install-agents + start-daemons for the RESTORED class (absent
      // ⇒ worker default, NOT the requested target), bringing back agents that were booted out (by a
      // reinstall teardown, or by a failed adopt-updater/install-services that backs itself out).
      const reBootstrapRestoredClass = () => {
        const rawClass = readNodeClassRaw(layer2);
        const restoredClass = rawClass && NODE_CLASSES.includes(rawClass.trim().toLowerCase()) ? rawClass.trim().toLowerCase() : "worker";
        const bringupEnv = { ...stepEnv, CATALYST_NODE_CLASS: restoredClass };
        const bringup = planPhases({ operation: "install", nodeClass: restoredClass, scripts, opts: {} }).filter(
          (p) => p.phase === "install-agents" || p.phase === "start-daemons",
        );
        let ok = true;
        for (const ph of bringup) {
          for (const s of ph.steps) {
            if (s.kind !== "run") continue;
            // CTL-1401 (Codex P2): adopt-cloud-sync is ADDITIVE — re-running it here would adopt the
            // cloud-sync agent on a rolled-back node whose ORIGINAL (pre-run) state had no cloud-sync,
            // so the "rolled_back" outcome would leave a new agent behind (not a true reversal). Skip it
            // in the rollback bring-up: rollback restores the captured state, it does not add agents.
            // (A node that genuinely had cloud-sync gets it back from the bundle restore / next install.)
            if (s.label === "adopt-cloud-sync") continue;
            const r = runStep({ argv: s.argv, env: bringupEnv });
            if (r.code !== 0 && !s.optional) {
              ok = false;
              log(`catalyst-install: rollback re-bootstrap step '${s.label}' failed (rc ${r.code}): ${r.stderr.trim()}`);
            }
          }
        }
        return ok;
      };

      let restore;
      if (!hadAgents) {
        // The node's ORIGINAL state had NO launchd agents (a fresh install, or a config-only node).
        // Boot out anything provisioning installed this run, then restore.
        const bootOk = bootOutAgents();
        if (!bootOk) {
          // Cleanup could NOT stop the agents/daemons it tried to remove — do NOT force a config/db
          // restore over possibly-live broker/exec-core (corruption). Report incomplete (same guard as
          // the live had-agents path). The catch-level pluginDirs restore below still runs.
          log(`catalyst-install: rollback INCOMPLETE — could not boot out the agents this run installed; NOT restoring over possibly-live daemons. Stop the stack and 'catalyst-backup restore ${ctx.bundlePath} --force' manually.`);
          restore = { code: 1 };
          rolledBack = false;
        } else {
          restore = restoreNode();
          if (restore.code === 0) {
            if (teardownRan) {
              // config-only reinstall: teardown ran `install-cli --uninstall`; re-install the symlinks
              // (not captured in the backup) so the restored node still has `catalyst` on PATH.
              const cli = runStep({ argv: [scripts.installCli], env: stepEnv });
              if (cli.code !== 0) log(`catalyst-install: rollback note — re-install CLI symlinks rc ${cli.code}: ${cli.stderr.trim()}`);
            } else {
              // install on a no-agent node. Remove ONLY the artifacts THIS run created, determined from
              // the PRE-RUN snapshot (NOT the post-acquire bundle, whose pluginDirs write makes it look
              // non-empty even on a fresh node). A node that already had these keeps them (restore re-laid
              // its config). Per-project secret files are left either way — re-usable, not operational.
              if (!preInstall.hadCli) {
                const cli = runStep({ argv: [scripts.installCli, "--uninstall"], env: stepEnv });
                if (cli.code !== 0) log(`catalyst-install: rollback note — uninstall CLI symlinks rc ${cli.code}: ${cli.stderr.trim()}`);
              }
              if (!preInstall.hadManagedKeys) stripManagedKeys();
            }
          }
          rolledBack = restore.code === 0;
          log(rolledBack ? `catalyst-install: rolled back — restored ${ctx.bundlePath} (verify launchd/daemon state)` : `catalyst-install: rollback INCOMPLETE (restore rc ${restore.code}); bundle at ${ctx.bundlePath}`);
        }
      } else {
        // The node HAD agents: a reinstall teardown booted out PRE-EXISTING agents, OR an install-retry
        // where a failed provisioning step (adopt-updater/install-services) backed an agent out. If the
        // worker stack is LIVE, STOP it around the forced restore (catalyst-backup --force over running
        // broker/exec-core can corrupt config/db) then restart; otherwise restore + re-bootstrap the
        // restored class so a backed-out agent (e.g. a developer's updater) comes back.
        const live = probeDaemons();
        if (live) {
          const stop = runStep({ argv: [scripts.stack, "stop"], env: stepEnv });
          if (stop.code !== 0) {
            // The stack did NOT stop — do NOT force a restore over still-live broker/exec-core (it can
            // corrupt config/db). Leave the node as-is and report an incomplete rollback for manual recovery.
            log(`catalyst-install: rollback INCOMPLETE — could not stop the live worker stack (rc ${stop.code}); NOT restoring over live daemons. Stop the stack and 'catalyst-backup restore ${ctx.bundlePath} --force' manually.`);
            restore = stop; // non-zero → rolledBack stays false
            rolledBack = false;
          } else {
            restore = restoreNode();
            if (restore.code === 0) {
              // Restart with the RESTORED class (not the requested target pinned in stepEnv), so the
              // started daemons stamp the node's actual class.
              const rawClass = readNodeClassRaw(layer2);
              const restoredClass = rawClass && NODE_CLASSES.includes(rawClass.trim().toLowerCase()) ? rawClass.trim().toLowerCase() : "worker";
              const start = runStep({ argv: [scripts.stack, "start", "--yes"], env: { ...stepEnv, CATALYST_NODE_CLASS: restoredClass } });
              if (start.code !== 0) log(`catalyst-install: rollback note — restart-after-restore rc ${start.code} (run 'catalyst-stack start')`);
              rolledBack = start.code === 0; // the original stack must come back up for a clean rollback
            } else {
              rolledBack = false;
            }
          }
        } else {
          restore = restoreNode();
          const bringupOk = restore.code === 0 ? reBootstrapRestoredClass() : false;
          rolledBack = restore.code === 0 && bringupOk;
        }
        log(rolledBack ? `catalyst-install: rolled back — restored ${ctx.bundlePath} + re-established the node's agents (verify launchd/daemon state)` : `catalyst-install: rollback INCOMPLETE — config restored from ${ctx.bundlePath} but agents are NOT fully re-established; run 'catalyst install' or 'catalyst-stack install-services && catalyst-stack start'`);
      }
      rollbackDisposition = rolledBack ? "ok" : "failed";
    } else if (ctx.bundlePath) {
      log(`catalyst-install: ${operation} failed — NOT auto-rolled-back; restore manually from ${ctx.bundlePath} if needed`);
    }
    // Restore the node's prior pluginDirs that acquire overwrote — UNCONDITIONALLY, even when there is
    // no bundle (the install backup itself failed AFTER acquire repointed it, so the bundle-driven
    // restore above never ran). The catch-level restore above re-laid the post-acquire value; this puts
    // the original back. (No-op for reinstall — it backs up before acquire — and for a fresh node.)
    if (preInstall.pluginDirs) {
      try {
        const cfg = readLayer2(layer2);
        if (readDeepKey(cfg, "catalyst.orchestration.pluginDirs") !== preInstall.pluginDirs) {
          setDeepKey(cfg, "catalyst.orchestration.pluginDirs", preInstall.pluginDirs);
          writeLayer2Atomic(layer2, cfg);
          log(`catalyst-install: rollback — restored prior pluginDirs ${preInstall.pluginDirs}`);
        }
      } catch (e) {
        log(`catalyst-install: rollback note — could not restore prior pluginDirs: ${e.message}`);
      }
    }
    run.fail(err, { rolledBack, detail: { rollback: rollbackDisposition, bundle: ctx.bundlePath } });
    return { outcome: rolledBack ? "rolled_back" : "failed", error: err.message, rolledBack, rollbackDisposition, bundlePath: ctx.bundlePath, traceId };
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const a = { operation: null, class: null, readReplica: null, executor: null, force: false, dryRun: false, json: false, help: false, errors: [] };
  const rest = [...argv];
  // takeValue — consume the next token as FLAG's value; a missing value (end of args, or the next
  // token is itself a flag) is an error, not a silent null — otherwise `catalyst install --class`
  // would fall back to the current/default class and a typo could provision the wrong node.
  const takeValue = (i, flag) => {
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("-")) {
      a.errors.push(`${flag} requires a value`);
      return [null, i];
    }
    return [next, i + 1];
  };
  // First non-flag token is the operation (the router passes it as argv[0]).
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i];
    switch (v) {
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "--force":
        a.force = true;
        break;
      case "--dry-run":
      case "--print":
        a.dryRun = true;
        break;
      case "--json":
        a.json = true;
        break;
      case "--class":
        [a.class, i] = takeValue(i, "--class");
        break;
      case "--read-replica":
        [a.readReplica, i] = takeValue(i, "--read-replica");
        break;
      case "--executor":
        [a.executor, i] = takeValue(i, "--executor");
        break;
      default:
        if (v.startsWith("--class=")) {
          const val = v.slice("--class=".length);
          if (val === "") a.errors.push("--class requires a value");
          else a.class = val;
        } else if (v.startsWith("--read-replica=")) {
          const val = v.slice("--read-replica=".length);
          if (val === "") a.errors.push("--read-replica requires a value");
          else a.readReplica = val;
        } else if (v.startsWith("--executor=")) {
          const val = v.slice("--executor=".length);
          if (val === "") a.errors.push("--executor requires a value");
          else a.executor = val;
        } else if (!v.startsWith("-") && a.operation == null) {
          a.operation = v;
        }
        // other unknown flags are ignored (forward-compat); an unknown operation is caught by validation
        break;
    }
  }
  return a;
}

export function usage() {
  return `catalyst-install — provision / tear down this node for its class (CTL-1369).

Usage (normally via the router: 'catalyst install|uninstall|reinstall …'):
  catalyst-install install   [--class developer|worker|monitor] [--read-replica <url>] [--executor bg|sdk|oneshot-legacy] [--dry-run]
  catalyst-install uninstall [--force] [--dry-run]
  catalyst-install reinstall [--class …] [--read-replica <url>] [--executor bg|sdk|oneshot-legacy] [--force] [--dry-run]

Options:
  --class <c>          target node class (install: declares it; un/reinstall: defaults to current)
  --read-replica <url> developer/monitor: a worker monitor's base URL to read from (e.g. http://host:7400)
  --executor <e>       durably provision the daemon executor (bg|sdk|oneshot-legacy) into
                       execution-core.env; omit to leave the node's existing executor untouched
  --force              teardown a live, non-drained node (uninstall/reinstall guard override)
  --dry-run, --print   resolve + print the per-class step plan; run NOTHING (no side effects)
  --json               machine-readable output (with --dry-run, prints the plan as JSON)
  -h, --help           this help

Per class: worker runs the full work stack (install-services); developer/monitor run the updater
agent (adopt-updater) + boot-drain and never start broker/exec-core.`;
}

function printPlan(plan, { operation, nodeClass }, json, out) {
  if (json) {
    out(JSON.stringify({ operation, nodeClass, dryRun: true, plan }, null, 2));
    return;
  }
  out(`catalyst-install ${operation} --class ${nodeClass}  (dry-run — nothing will run)`);
  for (const { phase, steps } of plan) {
    out(`  ${phase}:`);
    for (const s of steps) {
      const desc =
        s.kind === "setkey"
          ? `set ${s.key}=${s.value}`
          : s.kind === "setenv"
            ? `upsert ${s.key}=${s.value} in ${s.file}`
            : s.kind === "removeconfig"
              ? `remove Layer-2 keys [${s.keys.join(", ")}] (secrets preserved)`
              : s.kind === "verify-clean"
                ? "verify no daemons/agents remain"
                : (s.argv || []).join(" ");
      out(`    - ${s.label}${s.optional ? " (optional)" : ""}: ${desc}`);
    }
  }
}

/**
 * main — CLI entry. Returns an exit code. Side effects via injected deps (default: real).
 * Exit codes: 0 = completed + healthy; 1 = completed-unhealthy / failed / rolled_back; 2 = usage
 * error or refused (live node).
 */
export async function main(argv, depsOverride) {
  const env = depsOverride?.env || process.env;
  const out = depsOverride?.out || ((m) => process.stdout.write(`${m}\n`));
  const errOut = depsOverride?.errOut || ((m) => process.stderr.write(`${m}\n`));

  const args = parseArgs(argv);
  if (args.help) {
    out(usage());
    return 0;
  }
  if (args.errors?.length) {
    for (const e of args.errors) errOut(`catalyst-install: ${e}`);
    errOut(usage());
    return 2;
  }
  if (!args.operation || !LIFECYCLE_OPERATIONS.includes(args.operation)) {
    errOut(`catalyst-install: expected one of ${LIFECYCLE_OPERATIONS.join(" | ")}${args.operation ? ` (got '${args.operation}')` : ""}`);
    errOut(usage());
    return 2;
  }

  const deps = { ...buildDefaultDeps(env), ...(depsOverride || {}), env };

  let nodeClass;
  try {
    ({ nodeClass } = resolveRequestedClass({ optsClass: args.class, env, layer2: deps.layer2 }));
  } catch (e) {
    errOut(`catalyst-install: ${e.message}`);
    return 2;
  }

  // Resolve the read-replica with the same default-to-current precedence as --class: flag > env >
  // current Layer-2. CRUCIAL for reinstall — remove-config strips readReplica during teardown, so
  // without this a reinstall WITHOUT --read-replica would silently drop a developer/monitor node's
  // configured endpoint (and then verify-node would FAIL on the missing read source).
  const readReplica = resolveReadReplica({ flag: args.readReplica, env, layer2: deps.layer2 });

  // CTL-1401: --executor durably provisions the daemon executor lever into execution-core.env. Reject
  // an unrecognized value (a typo must not silently leave the node on a default executor — the whole
  // point of the lever is to make the executor explicit + install-set). No flag ⇒ executor untouched.
  if (args.executor != null && !VALID_EXECUTORS.includes(args.executor)) {
    errOut(`catalyst-install: --executor must be one of ${VALID_EXECUTORS.join(" | ")} (got '${args.executor}')`);
    return 2;
  }
  const opts = { force: args.force, readReplica, executor: args.executor, execCoreEnv: execCoreEnvPath(env) };

  if (args.dryRun) {
    const plan = planPhases({ operation: args.operation, nodeClass, scripts: deps.scripts, opts });
    printPlan(plan, { operation: args.operation, nodeClass }, args.json, out);
    return 0;
  }

  // Install the OTLP tracer BEFORE the run so InstallRun.complete()/fail() → emitInstallTrace()
  // actually export the catalyst.install root/phase spans (the tracer is a no-op until initTracing
  // runs). Off-first: only when CATALYST_TRACING=on, matching updater.mjs. Flushed below. Pin
  // CATALYST_NODE_CLASS to the REQUESTED class first so the tracer resource's catalyst.node.class
  // (built from process config via lib/node-class.mjs) matches the run's class on a fresh/reclassed
  // node, instead of the old/default config value — so dashboards bucket the spans correctly.
  const tracingOn = env.CATALYST_TRACING === "on";
  if (tracingOn) {
    process.env.CATALYST_NODE_CLASS = nodeClass;
    await initTracing({ serviceName: INSTALL_SERVICE_NAME });
  }

  const result = await runInstallLifecycle({ operation: args.operation, nodeClass, opts }, deps);

  // With --json the result JSON is the ONLY thing on stdout — the human success line is suppressed
  // so automation can parse stdout as a single document. (Error/warning lines go to stderr.)
  if (args.json) out(JSON.stringify(result));

  let code;
  switch (result.outcome) {
    case "completed":
      // A dirty teardown (verify-clean found residual agents) is returned as outcome "failed" by
      // runInstallLifecycle, so a "completed" install/uninstall here is genuinely clean. A node that
      // installed but is UNHEALTHY (verify-node) or NOT class-correct (post-install doctor FAIL —
      // CTL-1369 PR4) is still "completed" (the node IS installed) but exits 1. doctorOk===false is an
      // explicit doctor FAIL; doctorOk:true also covers the advisory "couldn't run" (ok:null) case.
      if (!result.healthOk) {
        errOut(`catalyst-install: ${args.operation} completed but verify-node reported the node UNHEALTHY (rc ${result.healthRc ?? "?"}).`);
        code = 1;
      } else if (result.doctorOk === false) {
        errOut(`catalyst-install: ${args.operation} completed but the post-install doctor (--profile install) reported the node is NOT class-correct${result.doctorFails?.length ? ` [${result.doctorFails.join(", ")}]` : ""} — verify the launchd agent set + pluginPullOwner for class '${nodeClass}'.`);
        code = 1;
      } else if (result.cloudSyncOk === false) {
        // CTL-1401 (Codex P2): adopt-cloud-sync failed on macOS — the node may have lost its cloud-sync
        // writer (local Linear replica). The node IS installed, but degraded: exit 1 so this is never
        // reported as a clean success (the install-profile doctor does not check cloud-sync).
        errOut(`catalyst-install: ${args.operation} completed but adopt-cloud-sync FAILED — the cloud-sync writer (local Linear replica) may be DOWN; re-run \`catalyst-stack adopt-cloud-sync\` and verify with \`catalyst-doctor\`.`);
        code = 1;
      } else {
        if (!args.json) out(`catalyst-install: ${args.operation} (${nodeClass}) completed.`);
        code = 0;
      }
      break;
    case "rolled_back":
      errOut(`catalyst-install: ${args.operation} failed and was rolled back: ${result.error}`);
      code = 1;
      break;
    case "failed":
      errOut(`catalyst-install: ${args.operation} failed: ${result.error}`);
      code = 1;
      break;
    case "refused":
      code = 2;
      break;
    default:
      code = 1;
  }

  if (tracingOn) await shutdownTracing(); // flush spans before the process exits
  return code;
}

// Direct-exec guard: run main() only when invoked as a script (not when imported by tests).
const INVOKED_DIRECTLY = (() => {
  try {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (INVOKED_DIRECTLY) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`catalyst-install: unexpected error: ${e?.stack || e}\n`);
      process.exit(1);
    });
}
