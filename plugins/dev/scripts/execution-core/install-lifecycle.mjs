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
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { InstallRun, makeInstallEmitFn, INSTALL_SERVICE_NAME } from "./lib/install-telemetry.mjs";
import { initTracing, shutdownTracing } from "./tracing.mjs";
import { NODE_CLASSES, getNodeClass } from "./config.mjs";

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
  };
}

/** layer2Path — the Layer-2 machine config (same precedence the rest of the toolchain uses). */
export function layer2Path(env = process.env) {
  return env.CATALYST_LAYER2_CONFIG_FILE || join(homedir(), ".config", "catalyst", "config.json");
}

/**
 * resolveRequestedClass — the class this lifecycle run targets. Precedence:
 *   explicit --class > CATALYST_NODE_CLASS env > current Layer-2 class (getNodeClass).
 * An explicit but UNRECOGNIZED --class is a hard error (the §3 footgun fix — never silently
 * fall back to worker on a typo'd developer node). Returns { nodeClass, source }.
 */
export function resolveRequestedClass({ optsClass, env = process.env, currentFn = getNodeClass } = {}) {
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
  return { nodeClass: currentFn(), source: "config" };
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
    steps: [{ label: "plugin-source", kind: "run", argv: [scripts.pluginSrc] }],
  });

  const backup = (label) => ({
    phase: "backup",
    steps: [{ label: "backup", kind: "backup", argv: [scripts.backup, "backup", "--label", label] }],
  });

  const writeConfig = () => {
    const steps = [
      { label: "set-class", kind: "run", argv: [scripts.catalyst, "class", nodeClass] },
      { label: "setup-catalyst", kind: "run", argv: [scripts.setup, "--non-interactive"] },
    ];
    // A developer/monitor node reads a worker's monitor over HTTP — bind it when given. (Worker
    // reads its own local replica, so the key is meaningless there.) Optional: a missing endpoint
    // is surfaced by the developer verify-node rubric, not a hard install failure.
    if (!worker && opts.readReplica) {
      steps.push({ label: "read-replica", kind: "setkey", key: "catalyst.readReplica.baseUrl", value: opts.readReplica });
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
    ],
  });

  const startDaemons = () => ({
    phase: "start-daemons",
    steps: [
      worker
        ? { label: "start-stack", kind: "run", argv: [scripts.stack, "start", "--yes"] }
        : // developer/monitor: boot-drain so a mis-rostered node still admits 0 work. Best-effort
          // (CTL-1352 auto-boot-drain is unbuilt) — verify-node confirms it took.
          { label: "drain", kind: "run", argv: [scripts.catalyst, "drain"], optional: true },
    ],
  });

  const healthcheck = () => ({
    phase: "healthcheck",
    steps: [{ label: "verify-node", kind: "healthcheck", argv: [scripts.stack, "verify-node"] }],
  });

  const stopDaemons = () => ({
    phase: "stop-daemons",
    steps: [{ label: "stop-stack", kind: "run", argv: [scripts.stack, "stop"] }],
  });

  const removeAgents = () => ({
    phase: "remove-agents",
    steps: [
      // uninstall-services removes ALL launchd agents including the updater + reconciles the
      // pull-owner back to broker (CTL-1348).
      { label: "uninstall-services", kind: "run", argv: [scripts.stack, "uninstall-services"] },
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
  if (!existsSync(path)) return {};
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

// Reject the JS prototype-chain keys so a dotted path can never walk into Object.prototype
// (prototype-pollution guard — the install-managed keys are all hardcoded constants today, but this
// keeps setDeepKey/deleteDeepKey safe by construction for any future caller). The check is INLINED
// at each computed-member access (not factored into a helper) so static analysis recognises it as a
// sanitiser of the very key used in the bracket write.
function isUnsafeKey(k) {
  return k === "__proto__" || k === "prototype" || k === "constructor";
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
function defaultProbeResidualAgents(env = process.env) {
  const laDir = env.CATALYST_LAUNCHAGENTS_DIR || join(homedir(), "Library", "LaunchAgents");
  try {
    if (readdirSync(laDir).some((f) => /^ai\.coalesce\.catalyst-.*\.plist$/.test(f))) return true;
  } catch {
    /* launchagents dir absent → no agents */
  }
  if (env.CATALYST_ASSUME_NO_DAEMONS === "1") return false;
  // Covers every stack daemon, not just broker/exec-core: the monitor (orch-monitor/server.ts) and
  // otel-forward (otel-forward/index.ts) are nohup children of the stack — if `catalyst-stack stop`
  // failed to kill them after the plists were removed, an uninstall would otherwise look clean.
  const pattern = "broker/index.mjs|execution-core/(daemon|index|updater/updater)\\.mjs|orch-monitor/server\\.ts|otel-forward/index\\.ts";
  const res = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  if (res.error) return false; // can't probe processes; the plist check above already ran
  return res.status === 0;
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

// probeDrained — is this node draining (admitting 0 new work)? Best-effort; unknown ⇒ false (the
// guard then requires --force on a live node, the safe default).
function defaultProbeDrained({ scripts, env = process.env } = {}) {
  if (env.CATALYST_ASSUME_DRAINED === "1") return true;
  const res = spawnSync(scripts.catalyst, ["drain", "--status-read", "--json"], { encoding: "utf8" });
  if (res.error || res.status !== 0 || !res.stdout) return false;
  try {
    const parsed = JSON.parse(res.stdout);
    return parsed.draining === true || parsed.drained === true;
  } catch {
    return false;
  }
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
    scriptExists: (p) => existsSync(p),
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
 *   probeDaemons, probeResidualAgents, probeDrained, scriptExists, log, InstallRunCtor.
 */
export async function runInstallLifecycle({ operation, nodeClass, opts = {} }, deps) {
  const { scripts, env, layer2, runStep, emit, nowFn, genTraceId, genSpanId, probeDaemons, probeResidualAgents, probeDrained, bundleHasCapturedAgents, scriptExists, log, InstallRunCtor } = deps;

  // Every composed step inherits (a) the RESOLVED class so the bash tools (which re-derive class
  // env-first) cannot diverge from the lifecycle's target — e.g. `install --class developer` on a
  // shell exporting CATALYST_NODE_CLASS=worker must still adopt-updater (mirrors doctor.mjs pinning
  // CATALYST_NODE_CLASS for verify-node); and (b) the driver's exact Layer-2 file under BOTH config
  // env names the child tools honor, so the whole run reads/writes ONE config (else an XDG/
  // CATALYST_MACHINE_CONFIG redirect would split node.class/readReplica and pluginDirs/pluginPullOwner
  // across two files and break rollback's single restorable state).
  const stepEnv = { ...env, CATALYST_NODE_CLASS: nodeClass, CATALYST_LAYER2_CONFIG_FILE: layer2, CATALYST_MACHINE_CONFIG: layer2 };

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
  const planScripts = [...new Set(plan.flatMap((p) => p.steps).filter((s) => s.argv).map((s) => s.argv[0]))];
  const missingScripts = planScripts.filter((p) => !scriptExists(p));
  if (missingScripts.length) {
    log(
      `catalyst-install: refusing ${operation} — required script(s) not found: ${missingScripts.join(", ")}. ` +
        `Run from a repo checkout (not the plugin cache), or set the CATALYST_INSTALL_*_SCRIPT overrides.`,
    );
    return { outcome: "refused", reason: "missing-script", missing: missingScripts };
  }

  const traceId = genTraceId();
  const spanId = genSpanId();
  const run = new InstallRunCtor({ operation, nodeClass, emit, traceId, spanId, nowFn }).start({ class: nodeClass });

  const ctx = { bundlePath: null, healthOk: true, healthRc: null, cleanOk: true };

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
        if (r.code !== 0) {
          if (step.optional) {
            log(`catalyst-install: WARN — optional step '${step.label}' failed (rc ${r.code}), continuing: ${r.stderr.trim()}`);
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
    run.complete({ class: nodeClass, healthOk: ctx.healthOk, cleanOk: ctx.cleanOk, bundle: ctx.bundlePath });
    return { outcome: "completed", healthOk: ctx.healthOk, healthRc: ctx.healthRc, cleanOk: ctx.cleanOk, bundlePath: ctx.bundlePath, traceId };
  } catch (err) {
    let rolledBack = false;
    // disposition: "none" = nothing to undo (failed before/at backup) → benign abort; "ok" = fully
    // reverted; "failed" = restore failed → node in a PARTIAL state. Stamped into the terminal event
    // so a dashboard can tell a safe abort from a node that needs manual recovery (the riskiest case).
    let rollbackDisposition = "none";
    if (autoRollbacks(operation) && ctx.bundlePath) {
      log(`catalyst-install: ${operation} failed — rolling back from ${ctx.bundlePath}`);
      // A restore alone is ADDITIVE — it re-lays captured config/db/plist FILES but cannot
      // un-bootstrap launchd agents provisioning just installed (and a worker's stack keep-alive would
      // restart the daemon). So when this run installed agents onto a FRESH node, tear them down first
      // (boot out, then stop survivors) before restoring. But if the backup captured PRE-EXISTING
      // agents (a retry/reinstall on a working node), DON'T tear them down: restore re-lays their plist
      // files but never re-bootstraps them, so a teardown would leave a previously-working node's
      // services down. Either way the restore is the authoritative "state put back" signal. (install-cli
      // symlinks are intentionally left in place — not captured in the backup, so removing them would be
      // an unrecoverable loss, not a reversal.)
      if (bundleHasCapturedAgents(ctx.bundlePath)) {
        log(`catalyst-install: rollback — backup captured pre-existing launchd agents; leaving them in place (restore re-lays their config; reload them if needed)`);
      } else {
        const unsvc = runStep({ argv: [scripts.stack, "uninstall-services"], env: stepEnv });
        if (unsvc.code !== 0) log(`catalyst-install: rollback note — uninstall-services rc ${unsvc.code} (agents may remain): ${unsvc.stderr.trim()}`);
        const stop = runStep({ argv: [scripts.stack, "stop"], env: stepEnv });
        if (stop.code !== 0) log(`catalyst-install: rollback note — stop rc ${stop.code}`);
      }
      const restore = runStep({ argv: [scripts.backup, "restore", ctx.bundlePath, "--force"], env: stepEnv });
      rolledBack = restore.code === 0;
      rollbackDisposition = rolledBack ? "ok" : "failed";
      log(
        rolledBack
          ? `catalyst-install: rolled back — restored ${ctx.bundlePath} + tore down provisioned agents (verify launchd/daemon state)`
          : `catalyst-install: rollback INCOMPLETE (restore rc ${restore.code}) — node is in a PARTIAL state; bundle at ${ctx.bundlePath}`,
      );
    } else if (ctx.bundlePath) {
      log(`catalyst-install: ${operation} failed — NOT auto-rolled-back; restore manually from ${ctx.bundlePath} if needed`);
    }
    run.fail(err, { rolledBack, detail: { rollback: rollbackDisposition, bundle: ctx.bundlePath } });
    return { outcome: rolledBack ? "rolled_back" : "failed", error: err.message, rolledBack, rollbackDisposition, bundlePath: ctx.bundlePath, traceId };
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const a = { operation: null, class: null, readReplica: null, force: false, dryRun: false, json: false, help: false, errors: [] };
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
      default:
        if (v.startsWith("--class=")) {
          const val = v.slice("--class=".length);
          if (val === "") a.errors.push("--class requires a value");
          else a.class = val;
        } else if (v.startsWith("--read-replica=")) {
          const val = v.slice("--read-replica=".length);
          if (val === "") a.errors.push("--read-replica requires a value");
          else a.readReplica = val;
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
  catalyst-install install   [--class developer|worker|monitor] [--read-replica <url>] [--dry-run]
  catalyst-install uninstall [--force] [--dry-run]
  catalyst-install reinstall [--class …] [--read-replica <url>] [--force] [--dry-run]

Options:
  --class <c>          target node class (install: declares it; un/reinstall: defaults to current)
  --read-replica <url> developer/monitor: a worker monitor's base URL to read from (e.g. http://host:7400)
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
    ({ nodeClass } = resolveRequestedClass({ optsClass: args.class, env }));
  } catch (e) {
    errOut(`catalyst-install: ${e.message}`);
    return 2;
  }

  // Resolve the read-replica with the same default-to-current precedence as --class: flag > env >
  // current Layer-2. CRUCIAL for reinstall — remove-config strips readReplica during teardown, so
  // without this a reinstall WITHOUT --read-replica would silently drop a developer/monitor node's
  // configured endpoint (and then verify-node would FAIL on the missing read source).
  const readReplica = resolveReadReplica({ flag: args.readReplica, env, layer2: deps.layer2 });
  const opts = { force: args.force, readReplica };

  if (args.dryRun) {
    const plan = planPhases({ operation: args.operation, nodeClass, scripts: deps.scripts, opts });
    printPlan(plan, { operation: args.operation, nodeClass }, args.json, out);
    return 0;
  }

  // Install the OTLP tracer BEFORE the run so InstallRun.complete()/fail() → emitInstallTrace()
  // actually export the catalyst.install root/phase spans (the tracer is a no-op until initTracing
  // runs). Off-first: only when CATALYST_TRACING=on, matching updater.mjs. Flushed below.
  const tracingOn = env.CATALYST_TRACING === "on";
  if (tracingOn) await initTracing({ serviceName: INSTALL_SERVICE_NAME });

  const result = await runInstallLifecycle({ operation: args.operation, nodeClass, opts }, deps);

  // With --json the result JSON is the ONLY thing on stdout — the human success line is suppressed
  // so automation can parse stdout as a single document. (Error/warning lines go to stderr.)
  if (args.json) out(JSON.stringify(result));

  let code;
  switch (result.outcome) {
    case "completed":
      if (!result.healthOk) {
        errOut(`catalyst-install: ${args.operation} completed but verify-node reported the node UNHEALTHY (rc ${result.healthRc ?? "?"}).`);
        code = 1;
      } else if (isTeardown(args.operation) && result.cleanOk === false) {
        // A teardown that left catalyst agents/daemons present is a FAILED teardown — surface it as a
        // non-zero exit (symmetric with the healthOk treatment above), not a silent "completed".
        errOut(`catalyst-install: ${args.operation} completed but verify-clean found catalyst agents/daemons STILL PRESENT — node not fully torn down (run 'catalyst-stack stop' / 'catalyst-stack uninstall-services').`);
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
