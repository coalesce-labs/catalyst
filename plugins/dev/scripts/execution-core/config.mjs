// config.mjs — execution-core Todo-state monitor configuration: logger, env
// constants, path resolvers, poll/debounce intervals. Zero internal deps
// (leaf module), mirroring broker/config.mjs (CTL-529).
//
// CTL-535: the M4 scheduler's eligible-set monitor. Path resolvers re-read
// CATALYST_DIR per call so tests redirect by setting the env var; production
// daemons pin a stable value at launch.

import { homedir, hostname } from "node:os";
import { resolve, join } from "node:path";
import { readFileSync, existsSync, rmSync, writeFileSync, readdirSync } from "node:fs";

// CTL-1211: schema-version policy for cluster config. config-schema.mjs is a
// dep-free sibling leaf, so this import cannot reintroduce the bun-install crash
// risk the pino try/catch below guards against.
import { schemaCompat } from "./config-schema.mjs";

// --- Logger (CTL-578) ---
// Pino is the daemon's runtime logger. A worktree checkout that hasn't run
// `bun install` cannot resolve it — and any module graph that includes
// config.mjs (registry.mjs, monitor.mjs, …) used to crash at module-load
// before any code ran. Wrap the import in try/catch and substitute a
// console-shim with the same pino-compatible surface so callers degrade
// gracefully instead of aborting.
let log;
try {
  const { default: pino } = await import("pino");
  // CTL-854: write to stderr so CLI commands that emit JSON to stdout are not
  // polluted by log messages (previously pino defaulted to stdout). The daemon
  // (nohup … >> daemon.log 2>&1) captures both streams; the CLI consumer only
  // sees stdout, which stays pure JSON.
  log = pino({ name: "execution-core", level: process.env.LOG_LEVEL ?? "info" }, process.stderr);
} catch (err) {
  const emit = (level) => (...args) => {
    // pino-style: log.info(obj, msg) OR log.info(msg). Console-shim flattens.
    // warn/error/fatal → stderr so CLI commands that write JSON to stdout are
    // not polluted by log messages (CTL-854). info/debug/trace → stdout to
    // preserve the existing observable behavior for test suites that capture
    // stdout for informational output.
    const stream =
      level === "warn" || level === "error" || level === "fatal"
        ? process.stderr
        : process.stdout;
    stream.write(
      `[execution-core:${level}] ${args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ")}\n`,
    );
  };
  log = {
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    debug: emit("debug"),
    fatal: emit("fatal"),
    trace: emit("trace"),
    child: () => log,
  };
  process.stderr.write(
    `[execution-core] WARN: pino unavailable (${err?.message ?? err}); using console shim\n`,
  );
}
export { log };

// --- Paths ---
// Re-resolved per call so tests can redirect by setting CATALYST_DIR;
// production launches pin a stable value.
function catalystDir() {
  return process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
}

export function getExecutionCoreDir() {
  return resolve(catalystDir(), "execution-core");
}

// CTL-1095: drain-flag file. Presence = node is draining (refuse new work).
export function getDrainFlagPath(orchDir) {
  return join(orchDir, "drain");
}

export function isDraining(orchDir) {
  return existsSync(getDrainFlagPath(orchDir));
}

// CTL-1095/CTL-1321: path of the once-per-episode "drained" sentinel marker. The
// scheduler writes it when a drain episode quiesces (in-flight hits 0) and
// applyBootDrainPolicy clears it on boot — both go through this one resolver so
// the two writers can never drift to different filenames (the sentinel was the
// one drain-family path not previously behind a resolver).
export function getDrainedMarkerPath(orchDir) {
  return join(orchDir, "drain.drained");
}

// CTL-1321: boot drain policy. The `drain` flag is a PERSISTENT file (set by
// `catalyst-execution-core drain`, cleared only by `drain --off`), so a
// quiesce→restart otherwise comes back SILENTLY DRAINED — heartbeating healthy
// while admitting zero new work. On boot we clear the flag (plus the
// `drain.drained` sentinel a prior drain episode may have left, see
// scheduler.mjs) so a restart always resumes accepting work. A node deliberately
// kept out of rotation (laptop/debug) opts in via CATALYST_BOOT_DRAINED=1, which
// RE-SETS the flag AFTER the clear ("on restart, always set the flag").
//
// Scope: this gates only NEW-work admission (the scheduler's `!draining` gate).
// It does NOT stop boot-resume (CTL-654) from re-adopting already-running
// in-flight workers — re-adopting a live ticket is not new work. Best-effort and
// never throws, so a transient fs error cannot abort daemon boot (mirrors
// writeBootMarker's fail-open contract + setDrain at cli/drain.mjs). `env` is an
// injectable seam for unit tests; matches the `=== "1"` opt-in idiom used by
// EXECUTION_CORE_FLEET_SELF_HEAL and the beliefs flags. Returns { drained }.
export function applyBootDrainPolicy(orchDir, { env = process.env } = {}) {
  const flag = getDrainFlagPath(orchDir);
  const drainedMarker = getDrainedMarkerPath(orchDir);
  try { rmSync(flag, { force: true }); } catch { /* best-effort */ }
  try { rmSync(drainedMarker, { force: true }); } catch { /* best-effort */ }
  const drained = env.CATALYST_BOOT_DRAINED === "1";
  if (drained) {
    try { writeFileSync(flag, ""); } catch { /* best-effort */ }
  }
  return { drained };
}

export function getEligibleDir() {
  return resolve(getExecutionCoreDir(), "eligible");
}

// CTL-867 — per-team reconcile-health dir. Holds <team>.json health markers
// ({ team, lastSuccessTs, consecutiveFailures, alerting, updatedAt }) the
// monitor writes on every reconcile and the orch-monitor /api/snapshot reads to
// surface each team's "last successful eligible refresh age". This is a SEPARATE
// marker from the eligible projection's content-keyed `updatedAt`: a healthy
// reconcile of an unchanged eligible set skips the projection write entirely
// (eligible-set.mjs skip-when-unchanged), so the projection timestamp can look
// fresh while no poll has actually succeeded in hours. The health marker is
// rewritten every reconcile regardless, so its lastSuccessTs is the truthful
// staleness signal.
export function getReconcileHealthDir() {
  return resolve(getExecutionCoreDir(), "reconcile-health");
}

// CTL-1503 — fleet-health durable-latch dir. Holds the edge-trigger latch marker
// (fleet-health-latch.json) the probe persists on the healthy→degraded /
// degraded→healthy edges and hydrates on start, so a daemon restart mid-episode
// does not re-emit `degraded` with no prior `recovered`. CATALYST_DIR-scoped
// (re-resolved per call) so tests isolate via CATALYST_DIR, mirroring
// getReconcileHealthDir.
export function getFleetHealthDir() {
  return resolve(getExecutionCoreDir(), "fleet-health");
}

// The durable event-log tailer cursor — monitor.mjs persists its byte offset
// here so a daemon restart resumes the fast path instead of re-seeding at EOF.
export function getCursorPath() {
  return resolve(getExecutionCoreDir(), "cursor.json");
}

// CTL-564: the central execution-core registry — the single source for
// team → repoRoot → eligibleQuery. The D4 successor to the per-repo
// enrollment records; all access flows through registry.mjs (the D9 cloud
// seam — file today, a Supabase table later).
export function getRegistryPath() {
  return resolve(getExecutionCoreDir(), "registry.json");
}

// Root for orchestrator run dirs — ~/catalyst/runs/<orchId>/. Each holds a
// workers/<TICKET>/phase-<P>.json signal tree. The audit CLI (CTL-649 Phase 5)
// walks this to join live `claude agents` sessions onto their worker signals.
// Re-resolved per call so tests redirect via CATALYST_DIR.
export function getRunsRoot() {
  return resolve(catalystDir(), "runs");
}

// Root for `claude --bg` job state dirs — ~/.claude/jobs/<bg_job_id>/state.json.
// Env name matches orchestrate-healthcheck's CATALYST_HEALTHCHECK_JOBS_ROOT so
// tests override one variable for both.
export function getJobsRoot() {
  return (
    process.env.CATALYST_HEALTHCHECK_JOBS_ROOT ??
    resolve(homedir(), ".claude", "jobs")
  );
}

// The unified monthly event log. UTC month to match the writer —
// orch-monitor/lib/event-writer.ts uses getUTCFullYear/getUTCMonth, so the
// tailer must resolve the same path or it would follow the wrong file.
export function getEventLogPath() {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return resolve(catalystDir(), "events", `${ym}.jsonl`);
}

// --- Host identity + cluster roster (CTL-859) ---
// PR1 of the distributed-coordination epic. ADDITIVE foundation: a configurable
// host name + a committed cluster roster, read here so later PRs (HRW ownership,
// Linear-CAS claim, takeover/healing) have one source of truth. Nothing in the
// dispatch/claim/eligible-query path consults these yet.

// Layer-2 (machine-local) config path. Mirrors daemon.mjs main()'s resolution:
// CATALYST_LAYER2_CONFIG_FILE || ~/.config/catalyst/config.json. Each host's
// Layer-2 file differs, so this is the right home for a per-host name.
export function getLayer2ConfigPath() {
  return (
    process.env.CATALYST_LAYER2_CONFIG_FILE ||
    resolve(homedir(), ".config", "catalyst", "config.json")
  );
}

// The repo root that owns the committed cluster roster (.catalyst/hosts.json).
// CATALYST_CONFIG_FILE points at <repoRoot>/.catalyst/config.json (mirrors the
// reaper-config resolution in daemon.mjs main()); otherwise fall back to the
// daemon's cwd. Re-resolved per call so tests can redirect via the env var.
// CTL-1093 (#1927) added a named import of this in daemon.mjs but landed without
// the `export`, breaking daemon boot fleet-wide ("Export named 'getCatalystRepoDir'
// not found"). Export restored so the import resolves.
export function getCatalystRepoDir() {
  const cfgFile = process.env.CATALYST_CONFIG_FILE;
  if (cfgFile) {
    // <repoRoot>/.catalyst/config.json → <repoRoot>/.catalyst
    return resolve(cfgFile, "..");
  }
  return resolve(process.cwd(), ".catalyst");
}

// CTL-1211: the cluster control-plane repo (catalyst-cluster) — a pristine clone
// (the plugin-source pattern, CTL-992) holding the node roster + cluster.json +
// SOPS-encrypted secrets. CATALYST_CLUSTER_DIR overrides; default
// ~/catalyst/catalyst-cluster. Re-resolved per call so tests redirect via the env.
export function getClusterRepoDir() {
  return process.env.CATALYST_CLUSTER_DIR || resolve(catalystDir(), "catalyst-cluster");
}

// CTL-1393: the durable change-detection marker for cluster secret auto-refresh.
// Lives next to the decrypted Layer-2 plaintext (~/.config/catalyst) as a hidden
// JSON file: { lastDecryptedSha, lastDecryptedAt, written[], synced[] }. The
// daemon's periodic cluster-secret refresh diffs the cluster clone's HEAD against
// lastDecryptedSha to decide whether a rotated secret needs re-decrypting WITHOUT
// re-spawning sops every tick. Co-located with the config dir (so it honors the
// CATALYST_LAYER2_CONFIG_FILE override that getLayer2ConfigPath resolves) and
// re-resolved per call so tests redirect via that env var.
export function getClusterSyncStatePath() {
  return resolve(getLayer2ConfigPath(), "..", ".cluster-sync-state.json");
}

// readClusterConfig(dir) — parse <clusterRepoDir>/cluster.json. Returns the
// parsed object, or null when absent/malformed. Never throws.
export function readClusterConfig(dir = getClusterRepoDir()) {
  try {
    const parsed = JSON.parse(readFileSync(resolve(dir, "cluster.json"), "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* absent/malformed cluster repo → null (fall back to project-repo roster) */
  }
  return null;
}

// getHostName — resolve this host's coordination name. Precedence:
//   1. CATALYST_HOST_NAME env (test/alias override; matches lib/host-identity.mjs)
//   2. catalyst.host.name in the Layer-2 (machine-local) config file
//   3. os.hostname() reduced to its first DNS label (strips .local, .rozich, etc.)
// Never throws — an unreadable/malformed Layer-2 file falls through to the
// hostname default. The result is the membership key HRW hashing will use.
export function getHostName() {
  const envOverride = process.env.CATALYST_HOST_NAME;
  if (typeof envOverride === "string" && envOverride.length > 0) return envOverride;
  try {
    const parsed = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"));
    const name = parsed?.catalyst?.host?.name;
    if (typeof name === "string" && name.length > 0) return name;
  } catch {
    /* missing/malformed Layer-2 file → hostname default */
  }
  const base = hostname();
  const dot = base.indexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

// isHostNamePinnedFromConfig — returns true when this host's coordination name
// comes from an explicit pin (CATALYST_HOST_NAME env or Layer-2 catalyst.host.name)
// rather than os.hostname(). Reads the same sources getHostName() uses so the
// boot guard and getHostName() never disagree. CTL-1093.
export function isHostNamePinnedFromConfig() {
  const env = process.env.CATALYST_HOST_NAME;
  if (typeof env === "string" && env.length > 0) return true;
  try {
    const parsed = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"));
    return typeof parsed?.catalyst?.host?.name === "string" &&
           parsed.catalyst.host.name.length > 0;
  } catch { return false; }
}

// --- Node class (CTL-1344) ---
// catalyst.node.class names WHAT KIND of machine this is — `developer` (a
// daemonless client you chat on), `worker` (runs the full stack and picks up
// work), or `monitor` (a reporting host; an enum slot only for now — see the
// node-classes plan §10). The class sets DEFAULTS for levers that already exist
// (roster membership, boot-drain, which daemons start, where board reads come
// from); it adds NO new dispatch gate and the scheduler is unchanged. Stored in
// Layer-2 (machine-local ~/.config/catalyst/config.json) beside catalyst.host.name
// — the same repo is checked out on every machine, so the role is per-machine,
// not per-repo (Layer-1).
export const NODE_CLASSES = Object.freeze(["developer", "worker", "monitor"]);
// Absent ⇒ worker ⇒ today's behavior, zero change (the whole fleet is unset until
// the M6 migration sets it explicitly).
const NODE_CLASS_DEFAULT = "worker";
// An EXPLICIT but unrecognized value (a typo'd "developr") must NOT silently
// become a work-eligible worker (plan §3 footgun guard). It degrades to the most
// restrictive class — `monitor` starts the fewest services, sits out of the
// roster, and boots drained — so a typo can never make a node pick up work, and it
// is flagged recognized:false so `catalyst doctor` (CTL-1355) FAILs until the
// value is corrected.
const NODE_CLASS_MOST_RESTRICTIVE = "monitor";

// readLayer2NodeClass — the raw catalyst.node.class value from the Layer-2 file
// EXACTLY as written (whatever JSON type), or undefined when the key is absent or
// the file is missing/malformed/unreadable. Never throws (parity with getHostName).
// resolveNodeClass — not this reader — judges validity, so a present-but-non-string
// value (`false`, `0`, `[]`) reaches it as an explicit misconfiguration rather than
// being silently flattened to "absent".
function readLayer2NodeClass() {
  try {
    return JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))?.catalyst?.node?.class;
  } catch {
    /* missing/malformed Layer-2 file → undefined (default-to-worker) */
    return undefined;
  }
}

// resolveNodeClass — the pure, no-logging node-class resolver. Mirrors
// getHostName's precedence (CATALYST_NODE_CLASS env → Layer-2 catalyst.node.class
// → default worker) and never throws. Returns the full resolution detail so
// hot-path callers stay log-free and doctor (CTL-1355) can FAIL on an unrecognized
// explicit value:
//   { class, source, inferred, recognized, raw }
//   - source     ∈ "env" | "layer2" | "default"
//   - inferred   = true only for the default (no explicit value anywhere)
//   - recognized = whether the explicit value named a real class (always true for
//                  the inferred default; false is what routes doctor to FAIL)
//   - raw        = the explicit value exactly as written (for the WARN/doctor text)
//
// Validity ladder:
//   - absent (no env + key undefined) OR an explicit null/empty "unset" sentinel
//     ⇒ benign default-to-worker (inferred; zero behavior change). null is the
//     codebase's "unset" convention and an empty string mirrors an empty env var.
//   - a present non-string value (`false`, `0`, `[]`, `{}`) is NOT an absent
//     default — it is an explicit misconfiguration ⇒ recognized:false (most
//     restrictive), so a typo'd config can never make a node work-eligible.
//   - a non-empty string is trimmed + lowercased before the membership check, so
//     "Worker" / " developer " resolve to their canonical class; only a genuine
//     non-member ("developr") is recognized:false.
export function resolveNodeClass() {
  const envRaw = process.env.CATALYST_NODE_CLASS;
  const hasEnv = typeof envRaw === "string" && envRaw.trim().length > 0;
  const raw = hasEnv ? envRaw : readLayer2NodeClass();
  const source = hasEnv ? "env" : "layer2";

  // Absent / explicit "unset" sentinel (undefined key or JSON null) ⇒ worker.
  if (raw === undefined || raw === null) {
    return { class: NODE_CLASS_DEFAULT, source: "default", inferred: true, recognized: true, raw: null };
  }
  // Present but not a string ⇒ explicit misconfiguration, never a silent worker.
  if (typeof raw !== "string") {
    return { class: NODE_CLASS_MOST_RESTRICTIVE, source, inferred: false, recognized: false, raw };
  }
  const normalized = raw.trim().toLowerCase();
  // Empty/whitespace string ⇒ "cleared" (mirrors an empty env var) ⇒ worker.
  if (normalized.length === 0) {
    return { class: NODE_CLASS_DEFAULT, source: "default", inferred: true, recognized: true, raw: null };
  }
  if (NODE_CLASSES.includes(normalized)) {
    return { class: normalized, source, inferred: false, recognized: true, raw };
  }
  return { class: NODE_CLASS_MOST_RESTRICTIVE, source, inferred: false, recognized: false, raw };
}

// getNodeClass — the convenience accessor the rest of the system reads. Returns
// the resolved class string (developer|worker|monitor). Emits a once-per-process
// WARN for the two soft-failure cases — an inferred default (so the operator knows
// the class was never declared) and an unrecognized explicit value (so the typo is
// visible) — without spamming. Hot-path callers that must stay strictly log-free
// use resolveNodeClass().class directly. Never throws.
const _warnedNodeClass = new Set();
export function getNodeClass() {
  const r = resolveNodeClass();
  let msg = null;
  if (r.inferred) {
    msg =
      `catalyst.node.class is not set; inferring "${r.class}" ` +
      `(set CATALYST_NODE_CLASS or catalyst.node.class in ${getLayer2ConfigPath()} to make the role explicit)`;
  } else if (!r.recognized) {
    msg =
      `catalyst.node.class "${r.raw}" is not one of [${NODE_CLASSES.join(", ")}] — ` +
      `treating this node as "${r.class}" (most restrictive); catalyst doctor will FAIL until the value is corrected`;
  }
  if (msg && !_warnedNodeClass.has(msg)) {
    _warnedNodeClass.add(msg);
    log.warn(msg);
  }
  return r.class;
}

// --- CTL-1365a: phase-worker executor selection seam ---
//
// `catalyst.orchestration.executor` selects the phase-worker substrate at the
// dispatch seam. Four substrates:
//   - "bg"             today's detached `claude --bg` job via phase-agent-dispatch.
//   - "sdk"            in-process @anthropic-ai/claude-agent-sdk query() worker
//                      (CTL-1365b). NOT yet implemented — resolves here, but the
//                      dispatch wiring (dispatch.mjs:dispatchForExecutor) falls
//                      back to bg + warns until 1b lands.
//   - "oneshot-legacy" the catalyst-legacy single long-lived job/ticket fallback.
//   - "codex-exec"     child-process `codex exec --json` phase worker on OpenAI
//                      Codex (CTL-1457). Routed per-phase via executorByPhase.
//
// Resolution mirrors resolveNodeClass: CATALYST_EXECUTOR env → Layer-1
// catalyst.orchestration.executor → node-class default. Phase 1: every node-class
// maps to "bg", so the resolver is a pure no-op (an unset flag never changes
// behavior) until an operator explicitly flips a node.
export const EXECUTORS = Object.freeze(["bg", "sdk", "oneshot-legacy", "codex-exec"]);
// The most-restrictive / always-safe substrate. An unrecognized explicit value
// degrades HERE (never silently to sdk) + warns once, mirroring
// NODE_CLASS_MOST_RESTRICTIVE — a typo'd flag can never put a node on an
// unintended substrate.
const EXECUTOR_DEFAULT = "bg";
// The node-class default map (Phase 1: all "bg"). Keyed by getNodeClass(); a class
// absent from the map falls back to EXECUTOR_DEFAULT. This is the ONE place that
// changes (per class) once Phase 2 validates sdk on a node class.
const EXECUTOR_BY_NODE_CLASS = Object.freeze({
  developer: "bg",
  worker: "bg",
  monitor: "bg",
});

// CTL-1457: compound executor aliases — the fully-qualified `<harness>-<mechanism>`
// spelling of an existing bare value. The bare values (bg|sdk|oneshot-legacy|
// codex-exec) stay canonical; these read-time-only aliases let an operator write
// the harness-qualified name and have it resolve to the canonical id. Applied
// inside resolveExecutor (and resolveExecutorForPhase) BEFORE the EXECUTORS
// membership check. Purely additive — never renames a stored value.
const EXECUTOR_ALIASES = Object.freeze({
  "claude-bg": "bg",
  "claude-sdk": "sdk",
  "claude-oneshot": "oneshot-legacy",
});

// The dispatch-mode telemetry vocab (CTL-1365a / OTEL #43/#44, frozen 2026-06-25).
// executor → catalyst.dispatch.mode value. Closed enum {phase-agents |
// oneshot-legacy | sdk | codex-exec}: "bg" maps to the existing "phase-agents"
// label so the telemetry name is stable across the rename.
export const DISPATCH_MODES = Object.freeze(["phase-agents", "oneshot-legacy", "sdk", "codex-exec"]);
const DISPATCH_MODE_BY_EXECUTOR = Object.freeze({
  bg: "phase-agents",
  sdk: "sdk",
  "oneshot-legacy": "oneshot-legacy",
  "codex-exec": "codex-exec",
});
// dispatchModeForExecutor — map a resolved executor to its dispatch-mode telemetry
// value. Unknown/undefined → "phase-agents" (the safe default that matches today's
// substrate). Pure; never throws.
export function dispatchModeForExecutor(executor) {
  return DISPATCH_MODE_BY_EXECUTOR[executor] ?? "phase-agents";
}

// isInProcessDispatchMode — CTL-1457 (T2): does this dispatch mode run its phase
// workers IN-PROCESS (no `claude --bg` job, hence no bg_job_id)? Both "sdk" (the
// in-process Agent SDK query) and "codex-exec" (a `codex exec --json` child that the
// daemon prelaunches + tracks by no-bg_job_id signal, queued behind a semaphore)
// write the same no-bg "dispatched" signals, so BOTH must contribute to the slot /
// occupancy gates or a node at maxParallel shows zero occupied slots and over-admits.
// "phase-agents" (bg) and "oneshot-legacy" are out-of-process (bg_job_id) → false.
// Pure; never throws.
export function isInProcessDispatchMode(mode) {
  return mode === "sdk" || mode === "codex-exec";
}

// readExecutorLayer1 — pull catalyst.orchestration.executor out of a project's
// Layer-1 .catalyst/config.json. Returns the raw value EXACTLY as written, or
// undefined when the key is absent or the file is missing/malformed/unreadable
// (so callers fall back to env/node-class default). Never throws — mirrors
// readFleetHealthConfigLayer1's ENOENT-tolerant shape. resolveExecutor — not this
// reader — judges validity, so a present-but-non-string value reaches it as an
// explicit misconfiguration rather than being flattened to "absent".
export function readExecutorLayer1(configPath) {
  if (!configPath) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return parsed?.catalyst?.orchestration?.executor;
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn(
        { configPath, err: err.message },
        "executor: Layer-1 config unreadable; using node-class default"
      );
    }
    return undefined;
  }
}

// resolveExecutor — the pure, no-logging executor resolver. Precedence mirrors
// resolveNodeClass (CATALYST_EXECUTOR env → Layer-1 catalyst.orchestration.executor
// → node-class default) and never throws. Returns the full resolution detail so
// the hot dispatch seam stays log-free and getExecutor()/doctor can decide on the
// warn:
//   { executor, source, inferred, recognized, raw }
//   - source     ∈ "env" | "layer1" | "default"
//   - inferred   = true only for the node-class default (no explicit value anywhere)
//   - recognized = whether an explicit value named a real executor (true for the
//                  inferred default; false routes the WARN/doctor to flag the typo)
//   - raw        = the explicit value exactly as written (for the WARN/doctor text)
//
// Validity ladder (mirrors resolveNodeClass):
//   - absent (no env + key undefined) OR an explicit null/empty "unset" sentinel
//     ⇒ benign node-class default (inferred; zero behavior change in Phase 1).
//   - a present non-string value (false/0/[]/{}) ⇒ explicit misconfiguration ⇒
//     recognized:false (most-restrictive "bg"), never a silent sdk.
//   - a non-empty string is trimmed + lowercased before the membership check, so
//     "BG" / " sdk " resolve to their canonical executor; only a genuine
//     non-member ("bgg") is recognized:false.
export function resolveExecutor(configPath) {
  const envRaw = process.env.CATALYST_EXECUTOR;
  const hasEnv = typeof envRaw === "string" && envRaw.trim().length > 0;
  const raw = hasEnv ? envRaw : readExecutorLayer1(configPath);
  const source = hasEnv ? "env" : "layer1";

  const nodeClassDefault = EXECUTOR_BY_NODE_CLASS[resolveNodeClass().class] ?? EXECUTOR_DEFAULT;

  // Absent / explicit "unset" sentinel (undefined key or JSON null) ⇒ node-class default.
  if (raw === undefined || raw === null) {
    return { executor: nodeClassDefault, source: "default", inferred: true, recognized: true, raw: null };
  }
  // Present but not a string ⇒ explicit misconfiguration, never a silent sdk.
  if (typeof raw !== "string") {
    return { executor: EXECUTOR_DEFAULT, source, inferred: false, recognized: false, raw };
  }
  const normalized = raw.trim().toLowerCase();
  // Empty/whitespace string ⇒ "cleared" (mirrors an empty env var) ⇒ node-class default.
  if (normalized.length === 0) {
    return { executor: nodeClassDefault, source: "default", inferred: true, recognized: true, raw: null };
  }
  // CTL-1457: canonicalize a compound alias (claude-bg→bg …) before the membership
  // check. An alias is never "" so this stays after the cleared-string short-circuit.
  const canonical = EXECUTOR_ALIASES[normalized] ?? normalized;
  if (EXECUTORS.includes(canonical)) {
    return { executor: canonical, source, inferred: false, recognized: true, raw };
  }
  return { executor: EXECUTOR_DEFAULT, source, inferred: false, recognized: false, raw };
}

// getExecutor — the convenience accessor the dispatch seam reads. Returns the
// resolved executor string (bg|sdk|oneshot-legacy). Emits a once-per-process WARN
// ONLY for an unrecognized explicit value (the typo guard — mirrors getNodeClass).
// An inferred node-class default is silent: in Phase 1 the WHOLE fleet is
// intentionally defaulted, so there is nothing to declare and a per-boot warn
// would be pure noise. Never throws.
const _warnedExecutor = new Set();
export function getExecutor(configPath) {
  const r = resolveExecutor(configPath);
  if (!r.recognized) {
    const msg =
      `catalyst.orchestration.executor "${r.raw}" is not one of [${EXECUTORS.join(", ")}] — ` +
      `falling back to "${r.executor}" (most restrictive)`;
    if (!_warnedExecutor.has(msg)) {
      _warnedExecutor.add(msg);
      log.warn(msg);
    }
  }
  return r.executor;
}

// --- CTL-1457: per-phase executor routing + codex-exec runtime settings ---

// readExecutorByPhaseLayer1 — resolve the executorByPhase (phase→executor) map.
// Precedence: env CATALYST_EXECUTOR_BY_PHASE (a JSON map) OVER Layer-1
// catalyst.orchestration.executorByPhase — mirroring resolveExecutor's
// env-over-Layer-1 precedence. Returns {} for a null/missing/unparseable file or an
// absent/non-object key so callers fall back to the daemon executor. Never throws —
// mirrors readFleetHealthConfigLayer1's ENOENT-tolerant shape.
//
// CTL-1457 follow-up (Gap 1): the env override is the DURABLE, clobber-safe home for
// a routing pin. On worker nodes the per-node Layer-1 .catalyst/config.json is
// git-reset every few minutes, so a routing pin written to the file cannot persist;
// CATALYST_EXECUTOR_BY_PHASE (set in the daemon launch env) survives that reset. When
// set to a plain-object JSON map it REPLACES the file (env-over-Layer-1). When set but
// malformed (invalid JSON, or JSON that is not a plain object) it WARN-logs actionably
// and FALLS THROUGH to the Layer-1 file — a routing pin never silently vanishes AND a
// typo never silently routes. Example: {"triage":"codex-exec"}.
export function readExecutorByPhaseLayer1(configPath, env = process.env) {
  const rawEnv = env?.CATALYST_EXECUTOR_BY_PHASE;
  if (typeof rawEnv === "string" && rawEnv.trim() !== "") {
    let parsedEnv;
    let parseErr = null;
    try {
      parsedEnv = JSON.parse(rawEnv);
    } catch (err) {
      parseErr = err;
    }
    const isPlainObject =
      !parseErr && parsedEnv && typeof parsedEnv === "object" && !Array.isArray(parsedEnv);
    // Every route VALUE must be a string. A non-string (e.g. {"triage":false} /
    // {"triage":null}) would make resolveExecutorForPhase treat that phase as unrouted
    // AND hide a valid Layer-1 route — silently losing the durable pin this override adds.
    const badPhase = isPlainObject
      ? Object.entries(parsedEnv).find(([, v]) => typeof v !== "string")?.[0]
      : undefined;
    if (isPlainObject && badPhase === undefined) {
      // A well-formed phase→executor string map → env REPLACES the Layer-1 file.
      return parsedEnv;
    }
    // Any malformed shape (JSON parse error, non-object, or a non-string route value) →
    // WARN + fall through to the Layer-1 file. Never throw, never silently route.
    log.warn(
      { value: rawEnv, err: parseErr?.message, badPhase },
      parseErr
        ? "CATALYST_EXECUTOR_BY_PHASE is set but is not valid JSON — ignoring the env override and falling back to the Layer-1 executorByPhase map"
        : badPhase !== undefined
          ? `CATALYST_EXECUTOR_BY_PHASE has a non-string value for phase "${badPhase}" — ignoring the env override and falling back to the Layer-1 executorByPhase map`
          : "CATALYST_EXECUTOR_BY_PHASE is set but did not parse to a JSON object (a phase→executor map) — ignoring the env override and falling back to the Layer-1 executorByPhase map"
    );
  }
  if (!configPath) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    const map = parsed?.catalyst?.orchestration?.executorByPhase;
    return map && typeof map === "object" ? map : {};
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn(
        { configPath, err: err.message },
        "executorByPhase: Layer-1 config unreadable; using daemon executor"
      );
    }
    return {};
  }
}

// resolveExecutorForPhase — the per-phase routing hook (CTL-1457), consulted at
// the daemon's dispatch site to pick the executor for ONE specific phase.
//   - When catalyst.orchestration.executorByPhase[phase] is present: canonicalize
//     any compound alias (claude-sdk→sdk) then validate against EXECUTORS. An
//     INVALID value THROWS a loud, actionable config error naming the phase + the
//     bad value + the valid set — routing NEVER silently falls back on a typo (a
//     silently-downgraded routed phase would be a debugging nightmare).
//   - When the phase key is absent/empty: return the node/daemon executor via
//     resolveExecutor(configPath).executor, so unrouted phases behave EXACTLY as
//     today (zero behavior change when executorByPhase is empty).
// Returns { executor, source } — source is "executorByPhase" for a routed phase,
// else resolveExecutor's source ("env" | "layer1" | "default"). The `env` bag is
// threaded into readExecutorByPhaseLayer1 so the CTL-1457-followup env override
// (CATALYST_EXECUTOR_BY_PHASE, env-over-Layer-1) is honored here too — a phase routed
// via the durable env map resolves exactly as one routed via the Layer-1 file.
export function resolveExecutorForPhase(phase, { configPath, env = process.env } = {}) {
  const map = readExecutorByPhaseLayer1(configPath, env);
  const raw = phase != null ? map[phase] : undefined;
  if (typeof raw === "string" && raw.trim() !== "") {
    const normalized = raw.trim().toLowerCase();
    const canonical = EXECUTOR_ALIASES[normalized] ?? normalized;
    if (!EXECUTORS.includes(canonical)) {
      throw new Error(
        `catalyst.orchestration.executorByPhase["${phase}"] = "${raw}" is not a valid executor — ` +
          `expected one of [${EXECUTORS.join(", ")}] ` +
          `(aliases: ${Object.keys(EXECUTOR_ALIASES).join(", ")}). ` +
          `Fix the Layer-1 config; per-phase routing refuses to silently fall back on an invalid value.`
      );
    }
    return { executor: canonical, source: "executorByPhase" };
  }
  const r = resolveExecutor(configPath);
  return { executor: r.executor, source: r.source };
}

// hasInProcessExecutorRoute — CTL-1457 (N1): does the executorByPhase map route ANY
// phase to an IN-PROCESS executor (sdk|codex-exec)? The slot/occupancy gates count
// no-bg in-flight workers gated on isInProcessDispatchMode(dispatchMode) — but that
// gates on the NODE boot mode. The PRIMARY codex/sdk rollout routes ONE phase to
// codex-exec/sdk on a node whose boot mode is still "phase-agents" (bg); there the
// mode gate is false and the routed no-bg worker is NOT counted → over-admit past
// maxParallel. This predicate ORs into those gates so a bg/oneshot-legacy node that
// routes any phase in-process still arms countSdkInflight. Pure over the ALREADY-READ
// map object (the daemon reads executorByPhase once at boot and passes it here — no
// extra IO); canonicalizes compound aliases (claude-sdk→sdk) before the membership
// test; returns false for an empty/absent/non-object map (the common case → zero
// behavior change, so the zero-change-when-unrouted invariant holds). Never throws.
export function hasInProcessExecutorRoute(executorByPhase) {
  if (!executorByPhase || typeof executorByPhase !== "object") return false;
  for (const raw of Object.values(executorByPhase)) {
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    const canonical = EXECUTOR_ALIASES[normalized] ?? normalized;
    if (isInProcessDispatchMode(canonical)) return true;
  }
  return false;
}

// readCodexConfigLayer1 — pull catalyst.orchestration.codex out of a project's
// Layer-1 .catalyst/config.json. Returns {} for a null/missing/unparseable file
// or an absent/non-object key. Never throws — mirrors readFleetHealthConfigLayer1.
export function readCodexConfigLayer1(configPath) {
  if (!configPath) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    const c = parsed?.catalyst?.orchestration?.codex;
    return c && typeof c === "object" ? c : {};
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn(
        { configPath, err: err.message },
        "codex: Layer-1 config unreadable; using defaults"
      );
    }
    return {};
  }
}

// codexConfig — resolve the codex-exec runtime settings (CTL-1457). Precedence per
// key: env → Layer-1 catalyst.orchestration.codex.<key> → default. Mirrors the
// readFleetHealthConfig style (Layer-1 object + env overrides + defaults). Never
// throws. Returns { codexHome, bin, model, writableRoots, pluginRoot }:
//   - codexHome     CATALYST_CODEX_HOME → codex.codexHome → ${catalystDir()}/codex-home
//   - bin           CATALYST_CODEX_BIN  → codex.bin       → "codex"
//   - model         CATALYST_CODEX_MODEL → codex.model    → null (null = let the
//                   codex config.toml decide; buildCodexArgs adds -m ONLY when
//                   non-null — we never invent a model id).
//   - writableRoots codex.writableRoots (array of strings) → [catalystDir()]. The
//                   thoughts-root is added downstream at arg-build time from the
//                   worktree, NOT here — config.mjs has no thoughts resolver.
//   - pluginRoot    CATALYST_CODEX_PLUGIN_ROOT → codex.pluginRoot → null (resolved
//                   from the launch spec's pluginDirs at runtime).
export function codexConfig({ configPath, env = process.env } = {}) {
  const l1 = readCodexConfigLayer1(configPath);
  const writableRoots = Array.isArray(l1.writableRoots)
    ? l1.writableRoots.filter((v) => typeof v === "string" && v.trim() !== "")
    : [];
  return {
    codexHome: resolveNonEmptyString(env.CATALYST_CODEX_HOME, l1.codexHome, `${catalystDir()}/codex-home`),
    bin: resolveNonEmptyString(env.CATALYST_CODEX_BIN, l1.bin, "codex"),
    model: resolveNonEmptyString(env.CATALYST_CODEX_MODEL, l1.model, null),
    writableRoots: writableRoots.length > 0 ? writableRoots : [catalystDir()],
    pluginRoot: resolveNonEmptyString(env.CATALYST_CODEX_PLUGIN_ROOT, l1.pluginRoot, null),
  };
}

// getStaticRoster — the `static` escape-hatch roster (CTL-1273). A multi-host
// operator who does NOT want the Linear anchor can pin an explicit node list in
// the Layer-2 machine-local config under catalyst.cluster.staticRoster (a JSON
// array of host names). Returns the filtered non-empty array, or null when
// unset/empty/malformed. Never throws. CATALYST_STATIC_ROSTER (a comma-separated
// list) overrides for tests. NOT committed (machine-local per CLAUDE.md).
export function getStaticRoster() {
  const env = process.env.CATALYST_STATIC_ROSTER;
  if (typeof env === "string" && env.length > 0) {
    const hosts = env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hosts.length > 0) return hosts;
  }
  try {
    const raw = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))
      ?.catalyst?.cluster?.staticRoster;
    if (Array.isArray(raw)) {
      const hosts = raw.filter((h) => typeof h === "string" && h.length > 0);
      if (hosts.length > 0) return hosts;
    }
  } catch {
    /* missing/malformed → null */
  }
  return null;
}

// readClusterRepoRoster — the PRIMARY roster source (CTL-1274): the
// catalyst-cluster control-plane repo's cluster.json.roster, read via the
// existing CTL-1211 machinery (readClusterConfig from getClusterRepoDir =
// $CATALYST_CLUSTER_DIR || ~/catalyst/catalyst-cluster). Schema-gated: a
// cluster.json whose schemaVersion is newer than this stack supports is ignored
// (degrade to the next source) rather than trusted blindly. Returns the filtered
// non-empty array of host names, or null when the repo/roster is absent, empty,
// malformed, or too-new. Never throws — FAIL-OPEN, so a read miss falls through
// (it never empties the roster, which would mass-evict the fleet under HRW).
function readClusterRepoRoster() {
  const cluster = readClusterConfig();
  if (cluster && schemaCompat(cluster.schemaVersion) !== "too-new" && Array.isArray(cluster.roster)) {
    const hosts = cluster.roster.filter((h) => typeof h === "string" && h.length > 0);
    if (hosts.length > 0) return hosts;
  }
  return null;
}

// resolveClusterHosts — the single roster-resolution seam (CTL-1273 seam,
// CTL-1274 source swap + per-repo hosts.json retirement). Returns
// { hosts, source, multiHost } so callers (getClusterHosts + the daemon boot
// assertion) share ONE precedence. Precedence:
//   1. 'cluster-repo' — the catalyst-cluster repo's cluster.json.roster (the
//                       dedicated, versioned, durable home for cluster identity —
//                       read==write on the cluster repo; CTL-1211/CTL-1274).
//   2. 'static'       — an explicit catalyst.cluster.staticRoster in Layer-2
//                       (machine-local escape hatch for multi-host without the
//                       cluster repo).
//   3. 'single-host'  — [getHostName()] when nothing else resolves.
// The legacy 'hosts-fallback' rung (per-repo .catalyst/hosts.json) is RETIRED
// (CTL-1274) — the roster's single durable home is the catalyst-cluster repo, and
// a CI guard (hosts-json-retired.test.mjs) fails the build if a project hosts.json
// reappears or a reader regrows. FAIL-OPEN: any source read miss/error falls
// through to the next source — it NEVER empties the roster (which would mass-evict
// the fleet under HRW). Re-read per call so a live add/remove (committed to the
// cluster repo and pulled by cluster-sync) is honored on the next scheduler tick.
export function resolveClusterHosts() {
  // 1. cluster-repo (CTL-1274) — the catalyst-cluster repo's cluster.json.roster.
  //    Schema-gated + fail-open inside readClusterRepoRoster.
  const clusterRepo = readClusterRepoRoster();
  if (clusterRepo) {
    return { hosts: clusterRepo, source: "cluster-repo", multiHost: clusterRepo.length > 1 };
  }

  // 2. static explicit list (escape hatch for multi-host without the cluster repo).
  const staticRoster = getStaticRoster();
  if (staticRoster) {
    return { hosts: staticRoster, source: "static", multiHost: staticRoster.length > 1 };
  }

  // 3. single-host default — no roster source resolved.
  return { hosts: [getHostName()], source: "single-host", multiHost: false };
}

// getClusterHosts — resolve this daemon's cluster roster (the membership keys HRW
// hashes over). Delegates to resolveClusterHosts and returns just the hosts array
// (the existing callers' contract; CTL-1273 moved the precedence into the
// resolver so the boot assertion and the reader can never diverge). Never throws.
export function getClusterHosts() {
  return resolveClusterHosts().hosts;
}

// getCatalystRepoDirHostsPath — absolute path to the committed cluster roster.
// Exported so cli/cluster.mjs and its unit tests share one source of truth
// (avoids drift between the writer and the reader that live in different files).
// Redirectable via CATALYST_CONFIG_FILE (same as getCatalystRepoDir).
export function getCatalystRepoDirHostsPath() {
  return resolve(getCatalystRepoDir(), "hosts.json");
}

// CTL-1057: a multi-host roster that does NOT include this host means every
// ticket HRW-routes to some OTHER host and this daemon silently owns nothing.
// Returns a human warning string in that case, null otherwise. Single-host
// (roster.length <= 1) → null — Phase 1 makes that a deliberate no-op and
// a name mismatch there is not an error worth surfacing.
export function hostMembershipWarning(roster, self) {
  if (!Array.isArray(roster) || roster.length <= 1) return null;
  if (roster.includes(self)) return null;
  return (
    `host "${self}" is not in the cluster roster [${roster.join(", ")}] — ` +
    `this daemon will own zero tickets under HRW. Set catalyst.host.name ` +
    `(Layer-2 config) to a roster entry or fix .catalyst/hosts.json.`
  );
}

// getLivenessAnchorIssue — the Linear ticket identifier the cross-host liveness
// channel attaches per-host heartbeat records to (CTL-1090). Resolution order:
//   1. CATALYST_LIVENESS_ANCHOR_ISSUE env (test/override)
//   2. catalyst.cluster.livenessAnchorIssue in the Layer-2 machine-local config
//      (~/.config/catalyst/config.json) — kept out of the committed repo per
//      CLAUDE.md ("do NOT commit Linear team/project IDs").
//   3. null — multi-host caller logs a one-time warning + no-ops; single-host: silent no-op.
// Never throws. NOT committed (Linear id ⇒ machine-local per CLAUDE.md).
export function getLivenessAnchorIssue() {
  const env = process.env.CATALYST_LIVENESS_ANCHOR_ISSUE;
  if (typeof env === "string" && env.length > 0) return env;
  try {
    const a = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))
      ?.catalyst?.cluster?.livenessAnchorIssue;
    if (typeof a === "string" && a.length > 0) return a;
  } catch { /* missing/malformed → null */ }
  return null;
}

// CTL-1420 (#17): getLivenessReadSource — WHERE the daemon reads CROSS-HOST peer
// liveness for dead-host detection. "loki" reads the unified event log via Loki
// (host + freshness + in_flight, fail-open — Loki is already the central cross-host
// log store, so no mesh/new-store needed); "linear" is the legacy anchor-attachment
// read. Defaults to "linear" for a SAFE rollout (opt-in "loki" via env, mirroring
// CTL-863's CATALYST_FENCE_READ_SOURCE) — the fleet sets =loki once validated, with
// an instant one-var revert. Single-host (roster ≤ 1) is a no-op under either source.
export function getLivenessReadSource() {
  const v = (process.env.CATALYST_LIVENESS_READ_SOURCE || "").trim().toLowerCase();
  return v === "loki" ? "loki" : "linear";
}

// CTL-1420 (#17): getLokiQueryUrl — the Loki base URL the daemon QUERIES for peer
// liveness (read path; distinct from the OTLP push endpoint the daemon writes to).
// Resolution: (1) CATALYST_LOKI_QUERY_URL explicit override; (2) OTEL_EXPORTER_OTLP_ENDPOINT
// with its port swapped to Loki's 3100 (same collector host); (3) null → the caller
// fails open (no Loki read → peers look absent → deadHosts treats them alive → no
// false reclaim). Never hardcodes an address (endpoints are environment-specific).
export function getLokiQueryUrl() {
  const explicit = process.env.CATALYST_LOKI_QUERY_URL;
  if (typeof explicit === "string" && explicit.length > 0) return explicit.replace(/\/+$/, "");
  const otlp = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (typeof otlp === "string" && otlp.length > 0) {
    try {
      const u = new URL(otlp);
      u.port = "3100";
      u.pathname = "/";
      return u.toString().replace(/\/+$/, "");
    } catch {
      return null; // unparseable → fail-open
    }
  }
  return null;
}

// LIVENESS_PUBLISH_INTERVAL_MS — cross-host liveness publish cadence (CTL-1090).
// Coarser than the local heartbeat (30s) because the takeover grace is 10 min;
// ~2 min keeps Linear quota bounded while giving 5 intervals of resolution inside
// the grace window. Env-overridable.
export const LIVENESS_PUBLISH_INTERVAL_MS =
  Number(process.env.EXECUTION_CORE_LIVENESS_PUBLISH_INTERVAL_MS) || 120_000;

// CTL-859 — node-heartbeat cadence. The daemon appends one node.heartbeat event
// to the unified event log every interval so a future liveness reader can decide
// "dead" = no heartbeat for a generous grace window (see the design doc: 5–10 min
// to bias hard against false eviction). Env-overridable for tests/tuning.
export const HEARTBEAT_INTERVAL_MS =
  Number(process.env.EXECUTION_CORE_HEARTBEAT_INTERVAL_MS) || 30_000;

// HEARTBEAT_GRACE_MS — how long after the last heartbeat a host is considered
// dead (CTL-863). 10 minutes is deliberately generous: a false eviction on a
// live-but-slow host is worse than a slow takeover. Env-overridable for tests.
export const HEARTBEAT_GRACE_MS =
  Number(process.env.EXECUTION_CORE_HEARTBEAT_GRACE_MS) || 600_000;

// resolveRestoreHoldMs — parse the CTL-1091 restore-hold override with the
// documented fallback semantics. Valid: a finite value >= 0, INCLUDING an explicit
// 0 (opt-out: disables the hold, admitting a restored host immediately). Invalid →
// fall back to `defaultMs`: unset, empty/whitespace, non-numeric, OR negative.
// CTL-1091 (Codex P2): a bare `Number(env)` coerced an EMPTY value ("") to 0 and
// accepted NEGATIVE values, either of which silently disabled the deflap (a flapping
// host would immediately reclaim its HRW slice) — contradicting the "unset/garbled →
// default" contract. Exported for unit tests.
export function resolveRestoreHoldMs(rawStr, defaultMs) {
  if (typeof rawStr !== "string" || rawStr.trim() === "") return defaultMs;
  const n = Number(rawStr);
  return Number.isFinite(n) && n >= 0 ? n : defaultMs;
}

// HEARTBEAT_RESTORE_HOLD_MS — CTL-1091 restore-side deflap. A host that
// transitioned dead→live must be observed continuously live for this window
// before it re-enters the DISPATCH ownership roster, so a flapping laptop (lid
// open/close) does not grab-then-strand new work. Default = one grace window
// (symmetric with the shed side). During the hold the surviving peer keeps
// covering the slice, so there is no starvation gap. Env-overridable via
// EXECUTION_CORE_HEARTBEAT_RESTORE_HOLD_MS for tests/tuning (see resolveRestoreHoldMs
// for the validation contract — explicit 0 opt-out honored; empty/negative → default).
export const HEARTBEAT_RESTORE_HOLD_MS = resolveRestoreHoldMs(
  process.env.EXECUTION_CORE_HEARTBEAT_RESTORE_HOLD_MS,
  HEARTBEAT_GRACE_MS,
);

// CLUSTER_SYNC_INTERVAL_MS — how often the daemon git-pulls the catalyst-cluster
// clone so a roster change committed on one node (CTL-1274 cluster cli) reaches
// every running daemon without a restart. 5 min keeps the pull cheap while
// bounding propagation lag well inside the heartbeat grace window. Env-overridable
// for tests/tuning; a pull is fail-open (a failure logs + continues, never breaks
// the daemon).
export const CLUSTER_SYNC_INTERVAL_MS =
  Number(process.env.EXECUTION_CORE_CLUSTER_SYNC_INTERVAL_MS) || 5 * 60_000;

// --- Intervals ---
// The periodic reconcile poll — the missed-webhook correctness backstop.
export const RECONCILE_INTERVAL_MS =
  Number(process.env.EXECUTION_CORE_RECONCILE_INTERVAL_MS) || 10 * 60_000;

// CTL-867 — per-team reconcile-health escalation threshold. A team's
// eligibleQuery can error every poll (e.g. its status references a removed
// Linear state → `linearis issues list --team X --status Ready` exits 1). The
// catch in reconcileProject preserves the prior eligible set and logs, which
// is correct, but a *persistent* failure freezes that team's eligible
// projection stale for hours while the daemon looks healthy — invisible
// starvation. After this many CONSECUTIVE failures the monitor escalates beyond
// the buried log.error to a canonical `monitor.reconcile.failing.<TEAM>` event
// the orch-monitor dashboard surfaces. A recovering query clears the alert and
// resets the counter. Default 3 (≈30 min of a 10-min reconcile) so a single
// transient linearis hiccup never alerts, but a removed-state misconfig does.
// Env-overridable for tuning/tests.
export const RECONCILE_FAILURE_ALERT_THRESHOLD =
  Number(process.env.EXECUTION_CORE_RECONCILE_FAILURE_ALERT_THRESHOLD) || 3;

// Debounce window: state_changed events that enter the eligible state coalesce
// into one reconcile poll per affected project per burst.
export const EVENT_DEBOUNCE_MS =
  Number(process.env.EXECUTION_CORE_DEBOUNCE_MS) || 5_000;

// CTL triage-entry fix (Phase 0): poll interval for draining the unified event
// log. The fs.watch tailer (startTailing) is unreliable for cross-process
// appends on macOS — it often never fires, leaving live webhook events
// undrained until the 10-min reconcile or a restart. This short poll calls
// readNewEvents() deterministically so new-work discovery is near-instant.
// readNewEvents is cheap (fstat + read of only the bytes appended since the
// durable cursor) and idempotent, so a tight interval is safe.
export const TAILER_POLL_INTERVAL_MS =
  Number(process.env.EXECUTION_CORE_TAILER_POLL_MS) || 2_000;

// CTL-533: a worker whose signal has not been updated within this window is
// "stale" — a precondition for the Step G stalled scan to consult git/PR
// state. A stale signal alone is never stall evidence (CTL-32). Default 15 min,
// matching the legacy `date -u -v-15M` cutoff in orchestrate/SKILL.md.
export const STALE_WORKER_CUTOFF_MS =
  Number(process.env.EXECUTION_CORE_STALE_WORKER_CUTOFF_MS) || 15 * 60_000;

// CTL-662 — busy-forever backstop ceiling. With STALE_MS / HUNG_CUTOFF_MS gone,
// this is the SOLE long backstop: a worker that stays `busy` past this elapsed
// time with no committed work flags for human (escalateOnce) — NEVER a silent
// reclaim-and-advance. Deliberately high (6h) so a legitimate multi-hour
// sub-agent fan-out or a future Linear-webhook waiter never trips it; only a
// genuinely wedged worker does. Env-overridable for tuning.
export const BUSY_CEILING_MS =
  Number(process.env.EXECUTION_CORE_BUSY_CEILING_MS) || 6 * 60 * 60_000;

// CTL-932 — turn-zero gate threshold. A healthy `claude --bg` worker creates
// its session transcript ~0.3s after its first turn; a wedged one (slash
// command failed to resolve at session start — "Unknown command:
// /catalyst-dev:phase-*") never does and idles forever holding a concurrency
// slot. A running-signal worker older than this with NO transcript AND a
// FRESH `claude agents` snapshot state of "blocked" is classified
// wedged-never-started (stop + replace via the normal revive path; escalate
// needs-human after repeated ineffective replacements). 120s comfortably
// exceeds registration + first-turn latency. Env-overridable.
export const NEVER_STARTED_MS =
  Number(process.env.CATALYST_NEVER_STARTED_MS) || 120_000;

// CTL-809 — ghost-breaker just-dispatched grace. The reclaim alive-branch
// cross-checks the FRESH `claude agents` snapshot to catch a jobLifecycle-alive
// worker whose process is actually gone (CC 2.x never flips a crashed/wedged
// --bg worker's local state.json terminal, so jobLifecycle reports it alive
// forever). A worker younger than this may simply not have registered in
// `claude agents` yet, so its absence is NOT proof of death — only reclaim on
// absence once past this window. Comfortably exceeds observed `claude --bg`
// registration latency + one warmer interval. Env-overridable.
export const GHOST_GRACE_MS =
  Number(process.env.EXECUTION_CORE_GHOST_GRACE_MS) || 90_000;

// CTL-868 — zombie state.json staleness floor. The CTL-809 ghost-breaker only
// fires when the `claude agents` snapshot is FRESH (absent-from-fresh = ghost).
// On a headless host that snapshot is unreliable (CTL-829: `claude agents --json`
// under-reports the background flag), so a corpse stuck at state:"working" — the
// dead-worker-classified-alive zombie that starves all slots — is never broken
// out of `alive-suppressed`. When NO fresh snapshot is available, fall back to
// this state.json mtime floor: a `working` job whose state.json has not been
// rewritten in this long is a corpse (Claude rewrites state.json far more often
// than this during real work — turn/heartbeat updates). Deliberately high (2h) so
// a legitimate in-process sub-agent fan-out never trips it (CTL-662-safe); it is
// ALSO subordinate to a fresh snapshot — a worker LISTED in a fresh snapshot is
// busy and is never reclaimed by this floor, regardless of mtime. Env-overridable.
export const ZOMBIE_STALE_FLOOR_MS =
  Number(process.env.EXECUTION_CORE_ZOMBIE_STALE_FLOOR_MS) || 2 * 60 * 60_000;

// CTL-735 — revival age ceiling (KEPT in CTL-736). `isTicketInFlight` treats any
// ticket with a non-terminal signal as in-flight, so a worker that crashed at
// `running` and never flipped terminal stays swept forever. A reclaim-eligible
// worker whose signal has not been touched in this long is an abandoned historical
// dir (a long-since Done or dead ticket), NOT a fresh crash — it is treated as
// inert (no revive, no escalate) BEFORE the Phase-3 progress gate, so the ~85
// day-stale debris dirs do not each get a one-shot no-progress needs-human flag.
// Deliberately well above any real phase duration (24h) — a genuine multi-hour
// crash is still revived; only a day-stale signal is inert. A signal with no
// parseable timestamp falls through (cannot judge age). Env-overridable.
export const REVIVE_MAX_AGE_MS =
  Number(process.env.EXECUTION_CORE_REVIVE_MAX_AGE_MS) || 24 * 60 * 60_000;

// CTL-1245 — dead-but-`running`-signalled doc-worker transcript-silence floor.
//
// THE GAP this closes: a `--bg` doc-phase worker (triage/research/plan/verify/
// review) that dies WITHOUT Claude stamping its ~/.claude/jobs/<id>/state.json
// terminal (SIGKILL/OOM/daemon-kill leaves it frozen at state:"working") reads
// jobLifecycle === "alive" FOREVER. On the headless enforce host (mini), `claude
// agents --json` is unreliable (CTL-829) so the CTL-809 fresh-snapshot ghost
// breaker cannot fire, and the CTL-868 cold-snapshot mtime floor for these
// doc phases is BUSY_CEILING_MS (6h) — so a genuinely-dead triage/plan corpse
// sits "alive-suppressed" for up to 6h, starving slots (the 2026-06-17 evidence:
// CTL-1240/1241/1242/1243 dead at plan/research, 4.5h+ no recovery).
//
// The corroborator: a LIVE doc worker mid in-process sub-agent fan-out keeps
// writing its transcript (and its subagents' transcripts — transcriptAgeMs folds
// those in), so a fresh transcript proves liveness; a transcript silent beyond
// this floor on an `alive`-by-state.json worker is a corpse. This lets the
// cold-snapshot doc-phase branch declare death in MINUTES instead of 6h while
// staying CTL-662-safe (a busy fan-out is spared by its own transcript writes).
//
// Deliberately well above any plausible inter-turn / sub-agent gap (30 min):
// a healthy doc worker writes its transcript far more often than this. Strictly
// SUBORDINATE to a fresh agents snapshot (a LISTED worker is never reclaimed by
// this floor) and to the death MODE gate below (off by default → strict no-op).
// Env-overridable for tuning. A null transcript age (can't measure — no session,
// no transcript file) is treated as NOT-silent: the worker is spared (fail to a
// false-negative, never touch a possibly-live worker — the #1 invariant).
export const DEAD_DOC_WORKER_TRANSCRIPT_SILENCE_MS =
  Number(process.env.EXECUTION_CORE_DEAD_DOC_WORKER_SILENCE_MS) || 30 * 60_000;

// CTL-650 — the push-based session wait-state watcher. Default ON; the daemon
// continuously classifies live sessions and emits agent.waiting_on_user /
// agent.resumed transition events. CATALYST_WAIT_WATCHER=0 disables it (the
// test/opt-out knob, mirroring EXECUTION_CORE_DISABLE_REAPER). The tick cadence
// reuses EVENT_DEBOUNCE_MS (env-tunable via EXECUTION_CORE_DEBOUNCE_MS) so the
// watcher's enumeration sweep runs at the same order as the reaper sweep.
export function readWaitWatcherConfig() {
  return {
    enabled: process.env.CATALYST_WAIT_WATCHER !== "0",
    intervalMs: EVENT_DEBOUNCE_MS,
  };
}

// CTL-685 — per-worker memory sampler constants. Exported as named constants
// for callers that want a single snapshot; readMemorySamplerConfig() re-reads
// from process.env on every call so tests can manipulate env vars freely.
export const MEMORY_SAMPLE_INTERVAL_MS =
  Number(process.env.EXECUTION_CORE_MEMORY_SAMPLE_INTERVAL_MS) || 30_000;

export const WORKER_RSS_WARN_MB =
  Number(process.env.EXECUTION_CORE_WORKER_RSS_WARN_MB) || 1500;

export const WORKER_RSS_KILL_MB =
  Number(process.env.EXECUTION_CORE_WORKER_RSS_KILL_MB) || 4000;

export const WORKER_OOM_KILLER =
  process.env.EXECUTION_CORE_WORKER_OOM_KILLER !== "0";

export const KILL_SUSTAINED_SAMPLES =
  Number(process.env.EXECUTION_CORE_KILL_SUSTAINED_SAMPLES) || 3;

export function readMemorySamplerConfig() {
  return {
    enabled: process.env.CATALYST_MEMORY_SAMPLER !== "0",
    intervalMs: Number(process.env.EXECUTION_CORE_MEMORY_SAMPLE_INTERVAL_MS) || 30_000,
    warnThresholdMb: Number(process.env.EXECUTION_CORE_WORKER_RSS_WARN_MB) || 1500,
    killThresholdMb: Number(process.env.EXECUTION_CORE_WORKER_RSS_KILL_MB) || 4000,
    killEnabled: process.env.EXECUTION_CORE_WORKER_OOM_KILLER !== "0",
    killSustainedSamples: Number(process.env.EXECUTION_CORE_KILL_SUSTAINED_SAMPLES) || 3,
  };
}

// CTL-1165 D5 — pre-exhaustion fleet-health guardrail config. Re-reads from
// process.env on every call (mirrors readMemorySamplerConfig) so tests mutate
// env freely. Three-layer precedence per knob: env > Layer-1
// (catalyst.orchestration.fleetHealth in .catalyst/config.json) > code default.
// `selfHealEnabled` DEFAULTS OFF — the first ship is a pure alert; nothing is
// reaped until an operator opts in via EXECUTION_CORE_FLEET_SELF_HEAL.
//
// CTL-1503: the fleet.health.degraded event is now EDGE-TRIGGERED with a
// HYSTERESIS BAND — degraded fires once on the healthy→degraded edge and a paired
// fleet.health.recovered fires once on the degraded→healthy edge. The swap signal
// carries a distinct lower `swapUsedMbClearThreshold`: the latch clears only once
// swap drops strictly below the clear threshold, so a signal hovering in the band
// [clear, trip) cannot re-flap. The absolute swap trip is raised above the
// observed normal-swap ceiling (~11.5–24 GB on a 16 GB Mac) so it stops firing on
// every tick. Both are per-host tunable via env / Layer-1.
const FLEET_HEALTH_DEFAULTS = Object.freeze({
  enabled: true,
  intervalMs: 120_000,
  jobsThreshold: 500,
  swapUsedMbThreshold: 24576,
  swapUsedMbClearThreshold: 16384,
  agentsThreshold: 12,
  procsThreshold: 40,
  selfHealEnabled: false,
  sustainedTicks: 2,
});

// readFleetHealthConfigLayer1 — pull catalyst.orchestration.fleetHealth out of a
// project's .catalyst/config.json. Returns {} for a null/missing/unparseable
// file or absent key so callers fall back to env/defaults. Never throws.
export function readFleetHealthConfigLayer1(configPath) {
  if (!configPath) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    const fh = parsed?.catalyst?.orchestration?.fleetHealth;
    return fh && typeof fh === "object" ? fh : {};
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn({ configPath, err: err.message }, "fleet-health: Layer-1 config unreadable; using defaults");
    }
    return {};
  }
}

function fleetHealthNumber(envVal, l1Val, def) {
  for (const v of [envVal, l1Val]) {
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return def;
}

export function readFleetHealthConfig(configPath) {
  const l1 = readFleetHealthConfigLayer1(configPath);
  return {
    // env=0 disables; otherwise Layer-1 enabled===false disables; else default-on.
    enabled:
      process.env.CATALYST_FLEET_HEALTH === "0"
        ? false
        : l1.enabled === false
          ? false
          : FLEET_HEALTH_DEFAULTS.enabled,
    intervalMs: fleetHealthNumber(
      process.env.EXECUTION_CORE_FLEET_HEALTH_INTERVAL_MS,
      l1.intervalMs,
      FLEET_HEALTH_DEFAULTS.intervalMs,
    ),
    jobsThreshold: fleetHealthNumber(
      process.env.EXECUTION_CORE_FLEET_JOBS_THRESHOLD,
      l1.jobsThreshold,
      FLEET_HEALTH_DEFAULTS.jobsThreshold,
    ),
    swapUsedMbThreshold: fleetHealthNumber(
      process.env.EXECUTION_CORE_FLEET_SWAP_MB_THRESHOLD,
      l1.swapUsedMbThreshold,
      FLEET_HEALTH_DEFAULTS.swapUsedMbThreshold,
    ),
    // CTL-1503 — lower clear threshold for the swap hysteresis band; the latch
    // releases only once swap drops strictly below this. Same precedence chain.
    swapUsedMbClearThreshold: fleetHealthNumber(
      process.env.EXECUTION_CORE_FLEET_SWAP_MB_CLEAR_THRESHOLD,
      l1.swapUsedMbClearThreshold,
      FLEET_HEALTH_DEFAULTS.swapUsedMbClearThreshold,
    ),
    agentsThreshold: fleetHealthNumber(
      process.env.EXECUTION_CORE_FLEET_AGENTS_THRESHOLD,
      l1.agentsThreshold,
      FLEET_HEALTH_DEFAULTS.agentsThreshold,
    ),
    procsThreshold: fleetHealthNumber(
      process.env.EXECUTION_CORE_FLEET_PROCS_THRESHOLD,
      l1.procsThreshold,
      FLEET_HEALTH_DEFAULTS.procsThreshold,
    ),
    // Self-heal: env=1 enables; otherwise Layer-1 selfHealEnabled===true enables;
    // else DEFAULT OFF (emit-only).
    selfHealEnabled:
      process.env.EXECUTION_CORE_FLEET_SELF_HEAL === "1"
        ? true
        : process.env.EXECUTION_CORE_FLEET_SELF_HEAL === "0"
          ? false
          : l1.selfHealEnabled === true
            ? true
            : FLEET_HEALTH_DEFAULTS.selfHealEnabled,
    sustainedTicks: fleetHealthNumber(
      process.env.EXECUTION_CORE_FLEET_SUSTAINED_TICKS,
      l1.sustainedTicks,
      FLEET_HEALTH_DEFAULTS.sustainedTicks,
    ),
  };
}

// CTL-787 — account-level Claude rate-limit usage poller. Re-reads from
// process.env on every call so tests can manipulate env vars freely (mirrors
// readMemorySamplerConfig). The poller floors intervalMs at 180s internally;
// the default cadence here is ~5 min.
export function readRatelimitPollerConfig() {
  return {
    enabled: process.env.CATALYST_RATELIMIT_POLLER !== "0",
    intervalMs: Number(process.env.EXECUTION_CORE_RATELIMIT_POLL_INTERVAL_MS) || 300000,
    usageEndpoint:
      process.env.EXECUTION_CORE_RATELIMIT_USAGE_ENDPOINT ||
      "https://api.anthropic.com/api/oauth/usage",
  };
}

// --- Auto-tuner (CTL-684) ---
// Sample cadence — how often the auto-tuner polls load + memory.
export const AUTOTUNE_SAMPLE_INTERVAL_MS =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_SAMPLE_INTERVAL_MS) || 30_000;

// Rolling window depth (number of samples ≈ window_seconds/cadence).
export const AUTOTUNE_WINDOW_SAMPLES =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_WINDOW_SAMPLES) || 10;

// Consecutive samples required before a trend is declared.
export const AUTOTUNE_TREND_MIN_SAMPLES =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_TREND_MIN_SAMPLES) || 3;

// Load average "safe" multiplier — load1 must be below cores × factor for a
// down-trend decision to proceed.
export const AUTOTUNE_LOAD_SAFE_FACTOR =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_LOAD_SAFE_FACTOR) || 4;

// Memory-free threshold for critical guard (below this → drop to minParallel).
export const AUTOTUNE_MEM_CRITICAL_PCT =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_MEM_CRITICAL_PCT) || 5;

// Memory-free threshold for warn guard (below this → suppress growth).
export const AUTOTUNE_MEM_WARN_PCT =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_MEM_WARN_PCT) || 20;

// Kill-switch: EXECUTION_CORE_AUTOTUNE=0 disables all sampling and Layer-2 writes.
export const AUTOTUNE_ENABLED = process.env.EXECUTION_CORE_AUTOTUNE !== "0";

// --- Claude-attributable resource control law (CTL-775) ---
// High-water mark for Claude-attributable cpu/mem (% of whole host). Above this
// → shed; below it (minus deadband) → we have headroom to scale up.
export const AUTOTUNE_CLAUDE_RESOURCE_HIGH_WATER_PCT =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_CLAUDE_HIGH_WATER_PCT) || 75;

// Hysteresis around the high-water so a sample straddling the line doesn't flap
// between scale-up and shed.
export const AUTOTUNE_ATTRIBUTION_DEADBAND_PCT =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_ATTRIBUTION_DEADBAND_PCT) || 5;

// Step sizes for the saturation-gated scale-up and the over-provisioned
// drift-down toward the setpoint.
export const AUTOTUNE_SCALE_UP_STEP =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_SCALE_UP_STEP) || 1;
export const AUTOTUNE_DRIFT_DOWN_STEP =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_DRIFT_DOWN_STEP) || 1;

// Multiplicative shed factor applied when Claude-attributable resources hit the
// high-water (reuses the legacy ×0.75 trend-up shed factor).
export const AUTOTUNE_CLAUDE_SHED_FACTOR =
  Number(process.env.EXECUTION_CORE_AUTOTUNE_CLAUDE_SHED_FACTOR) || 0.75;

// --- Progress watchdog for hung phase workers (CTL-729) ---
// Three-layer precedence per knob (mirrors getHostName): env > Layer-2
// (catalyst.watchdog.* in ~/.config/catalyst/config.json) > code default.
// Re-reads on every call (mirrors readMemorySamplerConfig) so tests mutate env
// freely. Never throws — missing/malformed Layer-2 falls through to defaults.

export const WATCHDOG_MINUTES_PER_TURN =
  Number(process.env.EXECUTION_CORE_WATCHDOG_MINUTES_PER_TURN) || 2;
const WATCHDOG_MIN_PHASE_BUDGET_MS = 20 * 60_000;   // absolute floor
const WATCHDOG_FALLBACK_BUDGET_MS = 90 * 60_000;    // when turnCap unparseable
const WATCHDOG_MODES = new Set(["off", "shadow", "enforce"]);

function readLayer2Watchdog() {
  try {
    const w = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))?.catalyst?.watchdog;
    return w && typeof w === "object" ? w : {};
  } catch { return {}; }
}
function resolveMode(envVal, l2Val) {
  for (const v of [envVal, l2Val]) {
    if (typeof v === "string" && WATCHDOG_MODES.has(v)) return v;
  }
  return "shadow"; // conservative default: detect+log, do not kill, until flipped to enforce
}
function resolveCount(envVal, l2Val, def) {
  for (const v of [envVal, l2Val]) {
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return def;
}

export function readWatchdogConfig() {
  const l2 = readLayer2Watchdog();
  // CATALYST_WATCHDOG=0 is the kill-switch → mode:off (back-compat).
  const mode = process.env.CATALYST_WATCHDOG === "0"
    ? "off"
    : resolveMode(process.env.EXECUTION_CORE_WATCHDOG_MODE, l2.mode);
  const silenceThresholdMs =
    Number(process.env.EXECUTION_CORE_WATCHDOG_SILENCE_MS) ||
    (Number(l2.silenceThresholdMinutes) || 0) * 60_000 ||
    30 * 60_000;
  const phaseBudgetMultiplier =
    Number(process.env.EXECUTION_CORE_WATCHDOG_BUDGET_MULTIPLIER) ||
    Number(l2.phaseBudgetMultiplier) || 1.5;
  const reviveBudget = resolveCount(
    process.env.EXECUTION_CORE_WATCHDOG_REVIVE_BUDGET, l2.reviveBudget, 0);
  return { mode, silenceThresholdMs, phaseBudgetMultiplier, reviveBudget };
}

// --- CTL-1137 cost-cap watcher config. SHADOW-FIRST, same shape + precedence as the
// CTL-729 watchdog above: env > Layer-2 catalyst.costCap.* > code default, default
// mode "shadow" (detect + log "would-abort", never kill, until an operator flips it to
// "enforce"). CATALYST_COST_CAP=0 is the kill-switch → "off". The cost SIGNAL is
// Prometheus (the single source of truth — claude_code_cost_usage_USD_total by
// session_id); enforcement FAILS OPEN when Prom is unreachable.
const COST_CAP_DEFAULT_USD = 40;          // $40/phase-session ≈ 1.6× the most expensive legit autonomous run ever (28d, n=1548; max $24.97)
const COST_CAP_DEFAULT_POLL_SEC = 30;     // per-session Prom cadence — NOT every tick
const COST_CAP_DEFAULT_PROM_URL = "http://100.65.193.30:9098"; // OTel/Prom stack on Tailscale

function readLayer2CostCap() {
  try {
    const c = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))?.catalyst?.costCap;
    return c && typeof c === "object" ? c : {};
  } catch { return {}; }
}
function resolvePositiveNumber(envVal, l2Val, def) {
  for (const v of [envVal, l2Val]) {
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return def;
}
function resolveNonEmptyString(envVal, l2Val, def) {
  for (const v of [envVal, l2Val]) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return def;
}

export function readCostCapConfig() {
  const l2 = readLayer2CostCap();
  const mode = process.env.CATALYST_COST_CAP === "0"
    ? "off"
    : resolveMode(process.env.EXECUTION_CORE_COST_CAP_MODE, l2.mode); // shares {off,shadow,enforce}
  const capUsd = resolvePositiveNumber(
    process.env.EXECUTION_CORE_COST_CAP_USD, l2.perSessionUsd, COST_CAP_DEFAULT_USD);
  const pollMs = resolvePositiveNumber(
    process.env.EXECUTION_CORE_COST_CAP_POLL_SEC, l2.pollEverySec, COST_CAP_DEFAULT_POLL_SEC) * 1000;
  const promBaseUrl = resolveNonEmptyString(
    process.env.EXECUTION_CORE_COST_CAP_PROM_URL, l2.promBaseUrl, COST_CAP_DEFAULT_PROM_URL);
  return { mode, capUsd, pollMs, promBaseUrl };
}

// phaseBudgetMs — expected wall-clock ceiling (ms) from the dispatch-time turnCap.
// Pure (no clock/fs) so the predicate gate is cheaply unit-testable.
export function phaseBudgetMs(phase, turnCap, cfg = readWatchdogConfig()) {
  const cap = Number(turnCap);
  if (!Number.isFinite(cap) || cap <= 0) return WATCHDOG_FALLBACK_BUDGET_MS;
  const mult = Number(cfg?.phaseBudgetMultiplier) || 1.5;
  return Math.max(cap * WATCHDOG_MINUTES_PER_TURN * mult * 60_000, WATCHDOG_MIN_PHASE_BUDGET_MS);
}

// --- Stall-janitor for terminal-state leftovers (CTL-1004) ---
// SHADOW-FIRST. Same three-layer precedence as the CTL-729 watchdog (env >
// Layer-2 catalyst.stallJanitor.* > code default), and the SAME conservative
// default — "shadow": detect + log janitor.would.* events, mutate nothing, until
// an operator flips it to "enforce". The janitor only collapses already-terminal,
// unambiguous leftovers (orphan worktrees + idle ghost sessions); it never infers
// liveness or advancement (that is belief-rule territory).
const STALL_JANITOR_MODES = new Set(["off", "shadow", "enforce"]);
// terminalIdleMs — how long a terminal phase signal must have been present before
// an idle background session for the same subject is treated as a ghost (J2). The
// Gherkin pins this at >=600s; matches the orphan-reaper's 600s timer cadence.
const STALL_JANITOR_DEFAULT_TERMINAL_IDLE_MS = 600_000;
// CTL-1324: censusIntervalMs — how often the EXPENSIVE worktree-census halves of
// the stall-janitor pass (J1 orphan-worktree, J3 stall-clear, J4 terminal-signal
// GC) may run. Each of those censuses fires a synchronous `git worktree list` per
// repo + a `git status` per terminal worktree; on a host with many worktrees
// (mini: 61) that ~50–70s of blocking spawnSync per tick ages the daemon's
// node.heartbeat past the CTL-731 degraded threshold and HOLDS new-work dispatch.
// Throttling those censuses to a 15-min cadence (mirrors the Pass 0u unstuck-sweep
// idiom) keeps the hot path cheap while leaving the cheap, urgent J2 ghost-session
// kill running every tick. Logic is UNCHANGED — only the census FREQUENCY.
export const STALL_JANITOR_DEFAULT_CENSUS_INTERVAL_MS = 900_000; // 15 minutes

function readLayer2StallJanitor() {
  try {
    const sj = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))?.catalyst?.stallJanitor;
    return sj && typeof sj === "object" ? sj : {};
  } catch { return {}; }
}

export function readStallJanitorConfig() {
  const l2 = readLayer2StallJanitor();
  // CATALYST_STALL_JANITOR is the single operator knob (mirrors CATALYST_WATCHDOG):
  //   "0" → off (kill-switch / back-compat with the ticket's default 0),
  //   off|shadow|enforce → that mode, anything else → shadow.
  const env = process.env.CATALYST_STALL_JANITOR ?? process.env.EXECUTION_CORE_STALL_JANITOR_MODE;
  let mode;
  if (env === "0") {
    mode = "off";
  } else if (typeof env === "string" && STALL_JANITOR_MODES.has(env)) {
    mode = env;
  } else if (typeof l2.mode === "string" && STALL_JANITOR_MODES.has(l2.mode)) {
    mode = l2.mode;
  } else {
    mode = "shadow"; // conservative default: shadow-first, never act until flipped
  }
  const terminalIdleMs =
    Number(process.env.EXECUTION_CORE_STALL_JANITOR_TERMINAL_IDLE_MS) ||
    (Number(l2.terminalIdleSeconds) || 0) * 1000 ||
    STALL_JANITOR_DEFAULT_TERMINAL_IDLE_MS;
  // CTL-1324: census throttle interval. env > Layer-2 > default 15 min. Same
  // precedence shape as terminalIdleMs / the unstuck-sweep interval.
  const censusIntervalMs =
    Number(process.env.CATALYST_STALL_JANITOR_INTERVAL_MS) ||
    (Number(l2.censusIntervalSeconds) || 0) * 1000 ||
    STALL_JANITOR_DEFAULT_CENSUS_INTERVAL_MS;
  return { mode, terminalIdleMs, censusIntervalMs };
}

// --- Unstuck sweep (CTL-1064) ---
// OFF by default — operators opt in via shadow then enforce. Same three-layer
// precedence as CTL-1004/CTL-1029 (env > Layer-2 catalyst.unstuckSweep.* >
// code default). Runs as a low-frequency throttled Pass 0u (default 15 min).
const UNSTUCK_SWEEP_MODES = new Set(["off", "shadow", "enforce"]);
export const UNSTUCK_SWEEP_DEFAULT_INTERVAL_MS = 900_000; // 15 minutes

function readLayer2UnstuckSweep() {
  try {
    const us = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))?.catalyst?.unstuckSweep;
    return us && typeof us === "object" ? us : {};
  } catch { return {}; }
}

export function readUnstuckSweepConfig() {
  const l2 = readLayer2UnstuckSweep();
  // CATALYST_UNSTUCK_SWEEP is the single operator knob:
  //   "0" → off (kill-switch), off|shadow|enforce → that mode, anything else → off.
  const env = process.env.CATALYST_UNSTUCK_SWEEP ?? process.env.EXECUTION_CORE_UNSTUCK_SWEEP_MODE;
  let mode;
  if (env === "0") {
    mode = "off";
  } else if (typeof env === "string" && UNSTUCK_SWEEP_MODES.has(env)) {
    mode = env;
  } else if (typeof l2.mode === "string" && UNSTUCK_SWEEP_MODES.has(l2.mode)) {
    mode = l2.mode;
  } else {
    mode = "off"; // safe default: off — operators opt into shadow then enforce
  }
  const intervalMs =
    Number(process.env.CATALYST_UNSTUCK_SWEEP_INTERVAL_MS) ||
    (Number(l2.intervalSeconds) || 0) * 1000 ||
    UNSTUCK_SWEEP_DEFAULT_INTERVAL_MS;
  return { mode, intervalMs };
}

// isThrottled — returns true when (nowMs - lastRunMs) < intervalMs.
// Extracted as a standalone export so tests can assert the throttle guard
// and future low-frequency passes can reuse the same helper.
export function isThrottled(lastRunMs, intervalMs, nowMs) {
  return (nowMs - lastRunMs) < intervalMs;
}

// CTL-1176: Pass 0r — LLM reasoning recovery pass config reader.
// Mirrors readUnstuckSweepConfig exactly: env (CATALYST_RECOVERY_PASS) overrides
// Layer-2 config (.catalyst.recovery.pass.mode), which overrides the safe
// default of 'off'. Ships off (ADR-023); operators opt in to shadow then enforce.
const RECOVERY_PASS_MODES = new Set(["off", "shadow", "enforce"]);

function readLayer2RecoveryPass() {
  try {
    const rp = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))?.catalyst?.recovery?.pass;
    return rp && typeof rp === "object" ? rp : {};
  } catch { return {}; }
}

export function readRecoveryPassConfig(envObj = process.env) {
  const l2 = readLayer2RecoveryPass();
  // CATALYST_RECOVERY_PASS is the single operator knob:
  //   "0" → off (kill-switch), off|shadow|enforce → that mode, anything else → off.
  // CTL-1331 FU-1: env is injectable (default process.env) so readDelegateRunnerConfig
  // resolves the recovery-pass coupling from the SAME injected env it uses for
  // board-health — deterministic in tests, identical at runtime (env === process.env).
  const env = envObj.CATALYST_RECOVERY_PASS;
  let mode;
  if (env === "0") {
    mode = "off";
  } else if (typeof env === "string" && RECOVERY_PASS_MODES.has(env)) {
    mode = env;
  } else if (typeof l2.mode === "string" && RECOVERY_PASS_MODES.has(l2.mode)) {
    mode = l2.mode;
  } else {
    mode = "off"; // safe default: off — operators opt into shadow then enforce
  }
  return { mode };
}

// CTL-1245: dead-but-running doc-worker reclaim mode reader. Mirrors
// readRecoveryPassConfig / readUnstuckSweepConfig exactly: env
// (CATALYST_DEAD_DOC_WORKER_RECLAIM) overrides Layer-2 config
// (.catalyst.recovery.deadDocWorker.mode), which overrides the safe default
// 'off'. Ships off (ADR-023): the transcript-silence corroborator that lets the
// cold-snapshot doc-phase ghost breaker fire in minutes (instead of the 6h busy
// ceiling) is INERT until an operator opts into shadow then enforce.
//   off     → strict no-op: behaviour byte-for-byte identical to pre-CTL-1245.
//   shadow  → measure + LOG the would-be death verdict, take NO action.
//   enforce → set ghostAbsent and fall through to the existing revive path
//             (under the CTL-736 progress gate + O_EXCL claim + CTL-638 cooldown).
const DEAD_DOC_WORKER_MODES = new Set(["off", "shadow", "enforce"]);

function readLayer2DeadDocWorker() {
  try {
    const d = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))?.catalyst?.recovery?.deadDocWorker;
    return d && typeof d === "object" ? d : {};
  } catch { return {}; }
}

export function readDeadDocWorkerConfig() {
  const l2 = readLayer2DeadDocWorker();
  const env = process.env.CATALYST_DEAD_DOC_WORKER_RECLAIM;
  let mode;
  if (env === "0") {
    mode = "off"; // kill-switch
  } else if (typeof env === "string" && DEAD_DOC_WORKER_MODES.has(env)) {
    mode = env;
  } else if (typeof l2.mode === "string" && DEAD_DOC_WORKER_MODES.has(l2.mode)) {
    mode = l2.mode;
  } else {
    mode = "off"; // safe default: off — operators opt into shadow then enforce
  }
  return { mode };
}

// CTL-1290: board-health delegate mode reader. Mirrors the recovery-family
// readers (readRecoveryPassConfig / readDeadDocWorkerConfig) EXACTLY — env
// (CATALYST_BOARD_HEALTH) overrides Layer-2 (.catalyst.boardHealth.mode) —
// with ONE deliberate deviation: the safe default is "shadow", not "off".
// Justification (spec §11.1, ADR-023 deviation, confirmed acceptable): shadow is
// itself a dark state. It emits ONE throttled `recovery.board-scan` heartbeat per
// cadence and mutates NOTHING — the no-mutation guarantee is structural in
// board-health.mjs (no process-spawning import; the `act` seam is enforce-gated
// and shadow/off never reach it). The ticket's whole value IS that shadow
// telemetry, so a shadow default ships the feature on; CATALYST_BOARD_HEALTH=0/off
// is the kill-switch.
//   off     → strict no-op: behaviour byte-for-byte identical to pre-CTL-1290.
//   shadow  → scan + emit recovery.board-scan, take NO action (the default).
//   enforce → additionally ACT (CTL-1300): on a proceeding scan, dispatch ONE
//             holistic recovery-pass delegate anchored to a flagged ticket and
//             carrying the whole-board context. Operator-gated — never auto-enabled.
export const BOARD_HEALTH_MODES = new Set(["off", "shadow", "enforce"]);

// readSanctionedNeedsHuman — CTL-1432 (B3). The operator-sanctioned needs-human
// latch allowlist: tickets a human has deliberately parked at needs-human that the
// delegate must NOT re-propose as moves every scan (they drown the genuinely-stuck
// tickets). They STAY visible in boardContext.frozenNeedsHuman — this only
// suppresses them from proposeMoves. Env CATALYST_BH_SANCTIONED_LATCHES
// (comma-separated ticket ids) overrides Layer-2 catalyst.boardHealth.
// sanctionedNeedsHuman; default empty (suppress nothing).
export function readSanctionedNeedsHuman(env = process.env) {
  const raw = env.CATALYST_BH_SANCTIONED_LATCHES;
  // CTL-1432 (Codex P2): a DEFINED env var — even empty — is an explicit override, so
  // `CATALYST_BH_SANCTIONED_LATCHES=` clears the allowlist (empty → []). Only fall
  // through to Layer-2 when the env var is UNSET (undefined).
  if (typeof raw === "string") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const l2 = readLayer2BoardHealth();
  const list = l2?.sanctionedNeedsHuman;
  return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
}

function readLayer2BoardHealth() {
  try {
    const b = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))?.catalyst?.boardHealth;
    return b && typeof b === "object" ? b : {};
  } catch { return {}; }
}

export function readBoardHealthConfig(env = process.env) {
  const l2 = readLayer2BoardHealth();
  const v = env.CATALYST_BOARD_HEALTH;
  let mode;
  if (v === "0") {
    mode = "off"; // kill-switch
  } else if (typeof v === "string" && BOARD_HEALTH_MODES.has(v)) {
    mode = v;
  } else if (typeof l2.mode === "string" && BOARD_HEALTH_MODES.has(l2.mode)) {
    mode = l2.mode;
  } else {
    mode = "shadow"; // CTL-1290 floor: shadow mutates nothing; garbage → shadow
  }
  return { mode };
}

// CTL-1488: coordination-substrate rollout config. Same off→shadow→enforce
// discipline (ADR-023) and env-override → Layer-2 → default precedence as
// readBoardHealthConfig, with ONE deliberate difference: the default is "off",
// NOT board-health's "shadow" floor. Coordination adds an always-on background
// process (coordination-publish) and — in enforce — network egress to the hub,
// so the safe default is fully inert until an operator promotes it.
export const COORDINATION_MODES = new Set(["off", "shadow", "enforce"]);

function readLayer2Coordination() {
  try {
    const c = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))?.catalyst?.coordination;
    return c && typeof c === "object" ? c : {};
  } catch { return {}; }
}

export function readCoordinationConfig(env = process.env) {
  const l2 = readLayer2Coordination();
  const v = env.CATALYST_COORDINATION_MODE;
  let mode;
  if (v === "0") {
    mode = "off"; // kill-switch — always wins, regardless of Layer-2
  } else if (typeof v === "string" && COORDINATION_MODES.has(v)) {
    mode = v;
  } else if (typeof l2.mode === "string" && COORDINATION_MODES.has(l2.mode)) {
    mode = l2.mode;
  } else {
    mode = "off"; // fail-safe: unset/garbage → inert (no process, no egress)
  }
  // hubUrl: the catalyst-cloud coordination changefeed base URL (Phase 4/5).
  // env override → Layer-2 → null. Null forces the interim Loki-tail transport.
  const envHub = env.CATALYST_COORDINATION_HUB_URL;
  const hubUrl =
    typeof envHub === "string" && envHub !== ""
      ? envHub
      : typeof l2.hubUrl === "string" && l2.hubUrl !== ""
        ? l2.hubUrl
        : null;
  return { mode, hubUrl };
}

// CTL-1488: the local-first coordination mirror. coordination-publish writes the
// ordered coordination subset here (with local_seq) synchronously before any
// network call; the inbound mirror-tail client merges other hosts' rows in.
export function getCoordinationMirrorPath() {
  return resolve(catalystDir(), "coordination.jsonl");
}

// CTL-1331: delegate-runner config reader. Gates the DETACHED process that
// drains the board-health delegate queue (where the heavy worktree-provision +
// `claude --bg` spawn moved off the daemon event loop). Mirrors the
// readBoardHealthConfig style — env override > a default — with the key twist
// that the runner's default is COUPLED to board-health: it only makes sense to
// run the drainer when board-health is actually enqueuing intents. So:
//   mode default = "on"  when board-health resolves to "enforce" (it enqueues)
//                  "off" otherwise (shadow/off never enqueue → nothing to drain).
// An explicit CATALYST_DELEGATE_RUNNER ∈ {on,off} overrides the coupling (off =
// a fully-observable shadow-of-enforce: intents accumulate + emit
// phase.dispatch.enqueued without any worker launching; on = force-drain). A
// garbage value falls back to the coupling. Phase A ships with board-health
// typically shadow, so the default resolves "off" — the runner is INERT and
// nothing drains until an operator flips board-health to enforce (or sets the
// runner on explicitly). interval/intentTtl are plain numeric env knobs with
// the §7 defaults; a non-numeric/empty override falls back to the default.
export const DELEGATE_RUNNER_MODES = new Set(["on", "off"]);

function readPositiveIntEnv(raw, fallback) {
  const n = Number(raw);
  return typeof raw === "string" && raw !== "" && Number.isFinite(n) && n > 0
    ? n
    : fallback;
}

// CTL-1331 follow-up: the gateway freshness window for the RECLAIM sweep's per-signal
// Linear terminal-check (fetchTicketState). The default 60s GATEWAY_STATE_FRESH_MS is
// far too tight for STUCK tickets: a ticket that isn't changing gets no webhooks, so
// its read-replica descriptor ages past 60s and every reclaim tick falls back to a
// slow `linearis` exec (the 3.8-5.3s reclaim-lap spike; ADV-1400's descriptor was 29h
// stale). The reclaim terminal short-circuit is a best-effort optimization, and a
// stale "non-terminal" descriptor is reliable — a real terminal transition would have
// refreshed it via webhook — so the reclaim check TRUSTS the read-replica's last-known
// state regardless of age. Operator-tunable; unset/0/invalid → effectively unbounded.
export function readReclaimGatewayFreshMs(env = process.env) {
  const v = Number(env.CATALYST_RECLAIM_GATEWAY_FRESH_MS);
  return Number.isFinite(v) && v > 0 ? v : Number.MAX_SAFE_INTEGER;
}

// CTL-1340: the Catalyst-Cloud read-replica tier for the scheduler's hot
// per-signal terminal checks (reclaim / recovery / terminal sweeps). When ON,
// fetchTicketState reads terminal-ness from a local sub-ms SQLite replica
// (replica-read.mjs) instead of the rate-limited per-tick `linearis` exec —
// HIT-only acceleration: a MISS falls through to today's gateway+live path.
// Ships OFF (the inert seam): the live flip happens once a replica is seeded on
// the host. Binary on/off (NOT the 3-mode recovery family) — there is no
// "shadow" middle state for a pure read accelerator.
//   env CATALYST_LINEAR_REPLICA: "on"/"1" → on; "0"/"off"/unset/garbage → off.
//   Layer-2 override: .catalyst.linearReplica.mode ("on" enables; anything else off).
// env wins over Layer-2; default off.
export const LINEAR_REPLICA_MODES = new Set(["on", "off"]);

function readLayer2LinearReplica() {
  try {
    const r = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))?.catalyst?.linearReplica;
    return r && typeof r === "object" ? r : {};
  } catch {
    return {};
  }
}

export function readLinearReplica(env = process.env) {
  const l2 = readLayer2LinearReplica();
  const v = env.CATALYST_LINEAR_REPLICA;
  let mode;
  if (v === "on" || v === "1") {
    mode = "on"; // explicit operator enable
  } else if (v === "0" || v === "off") {
    mode = "off"; // explicit kill-switch
  } else if (typeof v === "string" && v !== "") {
    mode = "off"; // garbage env value → off (never silently on)
  } else if (l2.mode === "on") {
    mode = "on"; // Layer-2 enable (env unset)
  } else {
    mode = "off"; // safe default: off — operators opt in
  }
  return { mode };
}

// CTL-1340: path to the local Catalyst-Cloud SQLite replica. CATALYST_REPLICA_DB
// overrides; default ~/catalyst/catalyst-replica.db. Re-resolved per call (the
// catalystDir() idiom) so tests redirect via the env var.
export function getReplicaDbPath() {
  return process.env.CATALYST_REPLICA_DB || resolve(catalystDir(), "catalyst-replica.db");
}

// --- Catalyst-Cloud token resolution (CTL-1394) ---
// The supervised cloud-sync daemon reads its cloud token from a STANDARD env-var NAME —
// `CATALYST_CLOUD_TOKEN` — on EVERY host (the same name cloud-token-env.mjs / CTL-1307
// already projects into cluster.env). The per-node-ness is the VALUE the operator
// provisions into that host's 0600 cloud-sync.env, NOT the name — so this installs
// on arbitrary hosts with ZERO code changes (no host names baked into the source). An
// optional override (env `CATALYST_CLOUD_TOKEN_ENV` / Layer-2 `catalyst.cloud.tokenEnv`)
// lets a host point at a differently-named var. NAME-ONLY: this never reads or returns the
// secret VALUE (the writer reads process.env[name]; doctor checks presence by name), so the
// result is safe to log.
const DEFAULT_CLOUD_TOKEN_ENV = "CATALYST_CLOUD_TOKEN";

// readLayer2CloudTokenEnv — the raw catalyst.cloud.tokenEnv string from the Layer-2
// file, or undefined (absent/malformed/non-string). Never throws (parity with
// readLayer2NodeClass). The per-host escape hatch — name your token var without a code change.
function readLayer2CloudTokenEnv() {
  try {
    const v = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))?.catalyst?.cloud?.tokenEnv;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

// resolveNodeCloudTokenEnv — resolve the env-var NAME that holds this host's cloud token:
// env override → Layer-2 override → the standard `CATALYST_CLOUD_TOKEN`. Returns
// { envVar, source } where source ∈ "env" | "layer2" | "default". Pure + NAME-only: it never
// reads process.env[envVar] (the secret value), so it is safe to log the result. No host
// names are hardcoded — the resolver is host-agnostic by design.
export function resolveNodeCloudTokenEnv({ env = process.env } = {}) {
  const override = env.CATALYST_CLOUD_TOKEN_ENV;
  if (typeof override === "string" && override.length > 0) {
    return { envVar: override, source: "env" };
  }
  const l2 = readLayer2CloudTokenEnv();
  if (l2) return { envVar: l2, source: "layer2" };
  return { envVar: DEFAULT_CLOUD_TOKEN_ENV, source: "default" };
}

export function readDelegateRunnerConfig(env = process.env) {
  const v = env.CATALYST_DELEGATE_RUNNER;
  let mode;
  if (typeof v === "string" && DELEGATE_RUNNER_MODES.has(v)) {
    mode = v; // explicit operator override (on|off)
  } else {
    // Coupled default: ON when EITHER async-enqueuing path is in enforce — the
    // whole-board board-health delegate (CTL-1331 Phase B) OR the per-item Pass 0r
    // recovery (CTL-1331 FU-1, CATALYST_RECOVERY_PASS). Both enqueue recovery-pass
    // delegate intents the runner must drain; with the runner off while either is
    // enforce, intents would accumulate (reserved slots) and never dispatch —
    // silently halting recovery. (readRecoveryPassConfig reads process.env; on the
    // daemon env === process.env so this resolves correctly at runtime.)
    const enqueuingActive =
      readBoardHealthConfig(env).mode === "enforce" ||
      readRecoveryPassConfig(env).mode === "enforce";
    mode = enqueuingActive ? "on" : "off";
  }
  return {
    mode,
    intervalMs: readPositiveIntEnv(env.CATALYST_DELEGATE_RUNNER_INTERVAL_MS, 15000),
    intentTtlMs: readPositiveIntEnv(env.CATALYST_DELEGATE_INTENT_TTL_MS, 1800000),
  };
}

// CTL-1331: read-only delegate-queue depth probe for the governance snapshot.
// NEVER load-bearing — a pure, best-effort dir scan that counts the reserving
// intents (`queued|claimed`, the same set countQueuedDelegates folds into the
// slot reservation; `launched` is excluded because the live `claude --bg`
// session is already counted by liveBackgroundCount). It reads the on-disk
// queue artifact directly (no import of delegate-queue.mjs → no coupling to the
// drainer module's internals and no risk of a missing-module import error while
// the queue module lands separately in Phase A). Returns 0 when the dir is
// absent (empty queue / inert Phase A) and 0 on ANY read error — it must never
// throw into the heartbeat path. The queue lives under the per-host
// execution-core dir (getExecutionCoreDir() === the daemon's orchDir).
const DELEGATE_QUEUE_DIRNAME = ".delegate-queue";
const DELEGATE_RESERVING_STATUSES = new Set(["queued", "claimed"]);

export function readDelegateQueueDepth() {
  const dir = join(getExecutionCoreDir(), DELEGATE_QUEUE_DIRNAME);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // dir absent (empty/inert) or unreadable — report 0, never throw
  }
  let depth = 0;
  for (const name of names) {
    // Canonical intent files only — skip `<TICKET>.json.claimed-…` sidecars and
    // `<TICKET>.json.tmp-…` artifacts (mirrors countQueuedDelegates' filter).
    if (!name.endsWith(".json") || name.includes(".json.")) continue;
    try {
      const intent = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (DELEGATE_RESERVING_STATUSES.has(intent?.status)) depth += 1;
    } catch {
      // a half-written / unparseable intent file — ignore it for the readout
    }
  }
  return depth;
}

// --- Governance snapshot for operator visibility (CTL-1062/CTL-1084) ---
// READ-ONLY, NEVER load-bearing. Recomputes each governance value the same way
// its per-tick gate site does so the heartbeat payload and the
// `catalyst-execution-core governance` CLI can show what the daemon is actually
// running with — without grepping `ps eww`. Does NOT replace the gate reads
// (see audit-proxy-must-not-be-load-bearing): the gates keep their own inline
// reads; this is a parallel, side-effect-free view.
//
// CTL-1084: beliefs-family flags are now THREE-LAYER (env override > Layer-2
// catalyst.governance.<flag> boolean > default false) so a restart with an
// empty launching shell preserves the operator's intent. Per-tick gate sites
// (scheduler.mjs/collector.mjs/diagnostician.mjs) keep reading process.env
// unchanged — the launcher (catalyst-execution-core cmd_start) evals the
// resolved exports so the daemon process inherits the durable value.

function readLayer2Governance() {
  try {
    const g = JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))?.catalyst?.governance;
    return g && typeof g === "object" ? g : {};
  } catch { return {}; }
}

// Three-layer beliefs flag: explicit env ("1"/"0") > Layer-2 boolean > default false.
// Returns both the effective boolean and its source so the boot self-report can flag overrides.
function resolveBeliefsFlag(envVal, l2Val) {
  if (envVal === "1") return { value: true,  source: "env-override" };
  if (envVal === "0") return { value: false, source: "env-override" };
  if (typeof l2Val === "boolean") return { value: l2Val, source: "config" };
  return { value: false, source: "default" };
}

const BELIEFS_FLAGS = {
  beliefsShadow:        "CATALYST_BELIEFS_SHADOW",
  diagnostician:        "CATALYST_DIAGNOSTICIAN",
  intentsEnforce:       "CATALYST_INTENTS_ENFORCE",
  advanceShadowSummary: "CATALYST_ADVANCE_SHADOW_SUMMARY",
};

export function readGovernanceConfig(env = process.env) {
  const l2 = readLayer2Governance();
  const beliefs = {};
  for (const [key, envName] of Object.entries(BELIEFS_FLAGS)) {
    beliefs[key] = resolveBeliefsFlag(env[envName], l2[key]).value;
  }
  return {
    ...beliefs,
    // mode subsystems — reuse existing three-layer readers so Layer-2 flows through
    stallJanitor: { mode: readStallJanitorConfig().mode },
    watchdog: { mode: readWatchdogConfig().mode },
    unstuckSweep: { mode: readUnstuckSweepConfig().mode },
    // CTL-1331: surface the async board-health delegate runner so operators can
    // see at a glance whether the drainer is on and how deep the intent queue
    // is. READ-ONLY / NEVER load-bearing (matches every other governance field):
    // the gate sites keep their own inline reads. `mode` renders in the human
    // `catalyst-execution-core governance` view (renderGovernance picks .mode);
    // `queueDepth` is a best-effort dir scan visible in the --json view.
    delegateRunner: {
      mode: readDelegateRunnerConfig(env).mode,
      queueDepth: readDelegateQueueDepth(),
    },
  };
}

// readGovernanceSources — parallel view of where each beliefs flag's effective
// value came from: "env-override" | "config" | "default". Used by the boot
// self-report (boot-event.mjs) and catalyst-stack status to surface env overrides.
export function readGovernanceSources(env = process.env) {
  const l2 = readLayer2Governance();
  const out = {};
  for (const [key, envName] of Object.entries(BELIEFS_FLAGS)) {
    out[key] = resolveBeliefsFlag(env[envName], l2[key]).source;
  }
  return out;
}
