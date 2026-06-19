// config.mjs — execution-core Todo-state monitor configuration: logger, env
// constants, path resolvers, poll/debounce intervals. Zero internal deps
// (leaf module), mirroring broker/config.mjs (CTL-529).
//
// CTL-535: the M4 scheduler's eligible-set monitor. Path resolvers re-read
// CATALYST_DIR per call so tests redirect by setting the env var; production
// daemons pin a stable value at launch.

import { homedir, hostname } from "node:os";
import { resolve, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

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
function getCatalystRepoDir() {
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
const FLEET_HEALTH_DEFAULTS = Object.freeze({
  enabled: true,
  intervalMs: 120_000,
  jobsThreshold: 500,
  swapUsedMbThreshold: 4096,
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
  return { mode, terminalIdleMs };
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

export function readRecoveryPassConfig() {
  const l2 = readLayer2RecoveryPass();
  // CATALYST_RECOVERY_PASS is the single operator knob:
  //   "0" → off (kill-switch), off|shadow|enforce → that mode, anything else → off.
  const env = process.env.CATALYST_RECOVERY_PASS;
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
