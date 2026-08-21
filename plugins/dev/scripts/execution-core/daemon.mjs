#!/usr/bin/env bun
// daemon.mjs — the execution-core composing daemon (CTL-554). Wires the
// CTL-539 recovery contract, the CTL-535 Todo-state monitor, and the CTL-536
// pull-loop scheduler into one long-lived machine-level process, and owns the
// fs.watch on the central registry.json (CTL-582 D4 — the single source of
// enrolled projects).
//
// `orchDir` for all three composed functions is a single machine-level
// directory — getExecutionCoreDir() (~/catalyst/execution-core/). The daemon
// idempotently ensures a minimal <orchDir>/state.json so the CTL-536 scheduler
// has a maxParallel value to read.

import {
  watch,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  statSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  readdirSync,
} from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import { parseEventTailChunk } from "./event-tail.mjs";
import {
  getExecutionCoreDir,
  applyBootDrainPolicy, // CTL-1321: boot accepting work by default
  writeDaemonRuntimeEnv, // CTL-1678: boot-time env snapshot for read-only surfaces
  getRegistryPath,
  getEventLogPath,
  getReplicaDbPath, // CTL-1929: the github-feed producer reads the replica
  getJobsRoot, // CTL-1165 D3: job-dir GC root
  log,
  EVENT_DEBOUNCE_MS,
  TAILER_POLL_INTERVAL_MS,
  readWaitWatcherConfig,
  readMemorySamplerConfig,
  readFleetHealthConfig, // CTL-1165 D5: fleet-health guardrail config (selfHeal default OFF)
  readDaemonWatchdogConfig, // CTL-1502: stuck-but-alive daemon watchdog config (shadow default)
  readRatelimitPollerConfig,
  getHostName, // CTL-862
  resolveClusterHosts, // CTL-1273/CTL-1271: roster + source + multiHost for the boot assertion
  getLivenessAnchorIssue, // CTL-1271: "multi-host was configured" detector
  getStaticRoster, // CTL-1271: "multi-host was configured" detector
  CLUSTER_SYNC_INTERVAL_MS, // CTL-1274: cluster-repo auto-pull cadence
  isHostNamePinnedFromConfig, // CTL-1093
  getCatalystRepoDir, // CTL-1093 sticky dir
  readDelegateRunnerConfig, // CTL-1331: async board-health delegate runner kill-switch
  readCloudFeedConfig, // CTL-1847: cloud-feed dispatch-source mode
  readGithubFeedConfig, // CTL-1929: github-feed dispatch-source mode (SEPARATE knob)
  readLinearWriteProxyConfig, // CTL-1889: Linear write-proxy transport mode
  resolveLeaseAuthorityMode, // CTL-1786: lease-authority claim gate (off/shadow/enforce)
  readLinearReplica, // CTL-1340: read-replica tier flag (inert; default off)
  getExecutor, // CTL-1365a: phase-worker executor resolver (env→Layer-1→node-class default; all "bg" in Phase 1)
  dispatchModeForExecutor, // CTL-1365a: executor → catalyst.dispatch.mode telemetry vocab
  resolveExecutorForPhase, // CTL-1457: per-phase executor routing hook (boot validation of executorByPhase values)
  readExecutorByPhaseLayer1, // CTL-1457: Layer-1 catalyst.orchestration.executorByPhase map reader
  hasInProcessExecutorRoute, // CTL-1457 (N1): does executorByPhase route ANY phase to sdk|codex-exec? (arms the slot/occupancy gates on a bg node)
  codexConfig, // CTL-1457: codex-exec runtime settings (codexHome/bin/…) for the boot-eligibility gate
  readGovernanceConfig, // CTL-1552: boot governance-mode + source self-report
  readGovernanceSources, // CTL-1552: which config layer each governance mode resolved from
} from "./config.mjs";
import { resolveBootIdentity } from "./host-boot-identity.mjs"; // CTL-1093
import { readStickyIdentity, writeStickyIdentity } from "./host-sticky.mjs"; // CTL-1093
import { ownedBy } from "./hrw.mjs"; // CTL-862: HRW ownership filter
import { defaultIdentityLedgerPath, syncAndResolveSelfIdentities } from "./linear-bot-identity.mjs"; // CTL-1892
import {
  clusterSync as realClusterSync,
  refreshClusterSecretsIfChanged as realRefreshClusterSecrets, // CTL-1393: change-detecting secret re-decrypt
} from "./cluster-sync.mjs"; // CTL-1274: cluster-repo auto-pull
import { startWaitWatcher as realStartWaitWatcher } from "./wait-watcher.mjs";
import { startMemorySampler as realStartMemorySampler } from "./memory-sampler.mjs";
import { startFleetHealthProbe as realStartFleetHealthProbe } from "./fleet-health-probe.mjs"; // CTL-1165 D5: pre-exhaustion fleet-health guardrail
import { startDaemonWatchdogProbe as realStartDaemonWatchdogProbe } from "./daemon-watchdog-probe.mjs"; // CTL-1502: stuck-but-alive daemon watchdog
import { startRatelimitPoller as realStartRatelimitPoller } from "./ratelimit-poller.mjs";
import { listProjects as realListProjects } from "./registry.mjs"; // CTL-854: boot health check
import { startHeartbeat as realStartHeartbeat } from "./heartbeat-event.mjs"; // CTL-859: node.heartbeat emitter
// CAT-57: same advance computation the Linear-anchor liveness publisher uses, so the
// Loki and Linear transports agree on what counts as a phase-boundary advance.
import { computeLastPhaseAdvanceTs, readAllPhaseSignals } from "./signal-reader.mjs";
import { readAdmissionState } from "./admission-state.mjs"; // CTL-1322: live admission block for the heartbeat
import { startLivenessPublisher as realStartLivenessPublisher, localInFlightTickets, localActiveTickets, localActiveSlotCount } from "./cluster-heartbeat-publisher.mjs"; // CTL-1090: cross-host liveness; CTL-1420 (#17): in-flight list; CTL-1581: active (slot-occupancy) list; CTL-1864: slot count
import { emitBootEvent } from "./boot-event.mjs"; // CTL-1084: node.boot self-report
import {
  recoverStartup,
  startMonitor,
  setCloudFeedGate, // CTL-1847
  stopMonitor,
  startScheduler,
  stopScheduler,
  reconcileAll,
  createTicketStateCache,
} from "./index.mjs";
import {
  Reaper,
  defaultReadActivePhaseSignal,
  defaultReadSignalBgJobId,
  defaultAssessWorktreeRemoval,
} from "./reaper.mjs";
import { listOrchDirs } from "./worktree-safety.mjs"; // CTL-1218: legacy-run provenance roots
import { startOrphanReaperTimer, readOrphanReaperConfig } from "./orphan-reaper-timer.mjs";
import { sweepJobDirs } from "./job-dir-gc.mjs"; // CTL-1165 D3: ~/.claude/jobs/<id> dir GC
import { sweepWorkerDirs } from "./worker-dir-gc.mjs"; // CTL-1205: execution-core/workers/<TICKET>/ GC
import { sweepWtCleanupQueue } from "./wt-cleanup-drain.mjs"; // CTL-1218: wt-cleanup-queue drain
import { ProcReaper } from "./proc-reaper.mjs"; // CTL-1165 D2: orphan child-process reaper (default shadow)
import { startWorktreeRefreshTimer, readWorktreeRefreshConfig } from "./worktree-refresh-timer.mjs";
import { startCloudFeedTimer } from "./cloud-feed-timer.mjs"; // CTL-1847
import { startGithubFeedTimer } from "./github-feed-timer.mjs"; // CTL-1929
import { createCaptureSink, defaultCapturePath } from "./cloud-feed-capture.mjs"; // CTL-1847
// CTL-1331: the async board-health delegate runner timer (kicks the DETACHED
// drainer that does the heavy worktree-provision + `claude --bg` off the daemon
// event loop). Gated by readDelegateRunnerConfig; Phase A ships it inert.
import { startDelegateRunnerTimer } from "./delegate-runner.mjs";
import { startStalePrRescueTimer, readStalePrRescueConfig } from "./stale-pr-rescue-timer.mjs";
import { startStalledPrTimer as realStartStalledPrTimer, readStalledPrSweepConfig, DEFAULTS as STALLED_DEFAULTS } from "./stalled-pr-timer.mjs";
import { startGithubQuotaTimer as realStartGithubQuotaTimer, readGithubQuotaSweepConfig, DEFAULTS as GITHUB_QUOTA_TIMER_DEFAULTS } from "./github-quota-timer.mjs";
import { DEFAULTS as RESCUE_DEFAULTS } from "./stale-pr-rescue.mjs";
import { startOrphanPrSweepTimer, readOrphanPrSweepConfig } from "./orphan-pr-sweep-timer.mjs";
import { DEFAULTS as ORPHAN_DEFAULTS } from "./orphan-pr-sweep.mjs";
import { startLinearReconcileTimer, readLinearReconcileConfig } from "./linear-reconcile-timer.mjs";
import { reconcileBootResume, processApprovedResumes } from "./boot-resume.mjs";
// CTL-665: the committed executionCore concurrency reader — imported directly
// (not via the index.mjs barrel, mirroring the orphan-reaper-timer import) so
// main() can resolve the slot-ceiling config once and thread it into the
// scheduler + boot-resume.
// CTL-678: pair the Layer-1 reader with the Layer-2 reader + merger so the
// machine-canonical override (~/.config/catalyst/config.json) can win
// per-field over the committed seed.
import {
  readExecutionCoreConcurrency,
  readExecutionCoreConcurrencyLayer2,
  mergeExecutionCoreConcurrency,
  readAllEligibleTickets, // CTL-862: boot-log ownership count
  clearHoldStopCooldown, // CTL-768
  defaultClearStall, // CTL-1067: J3 stall-clear seam
  readMaxParallel, // CTL-1551: the SCHEDULER-ENFORCED slot ceiling for the heartbeat
  clearDispositionEmit as defaultClearDispositionEmit, // Codex #2970 round 3: reset the in-process worker.transition dedup after an out-of-band clear
} from "./scheduler.mjs";
import * as linearWrite from "./linear-write.mjs"; // CTL-1067: writeStatus for defaultClearStall
import { labelMarkerBase, clearStalledLabel } from "./label-guard.mjs"; // CTL-1567: canonical once-marker path (single source of truth); CTL-1552: clear needs-human LABEL + once-marker together (leaf module → no cycle)
import { defaultForgetIntent } from "./recovery-reasoning.mjs"; // CTL-1567: re-arm recovery when a human responds
import { forgetDurableEscalation } from "./durable-escalation.mjs"; // CTL-1643: clear durable record on operator clear
import { appendWorkerTransitionEvent as defaultAppendWorkerTransitionEvent } from "./worker-transition-event.mjs"; // CTL-764 finding 11: needs-input→cleared on comment wake
import {
  writeBootMarker,
  clearProgressMarks,
  resolvePhaseSessionId,
  defaultAppendOperatorEvent,
} from "./recovery.mjs"; // CTL-655: window the revive budget to this run; CTL-736: reset progress high-water; CTL-768: --resume; CTL-1044: operator-event appender for the scheduler's appendIntentEvent seam
import { resolveGithubBootAuth, rearmGithubTokenFromFile } from "./github-auth-preflight.mjs"; // CTL-1612: boot GitHub-credential preflight (advisory; alerts only on a definitive 401)
import { rearmClaudeAccountsFromFile } from "./claude-accounts-rearm.mjs"; // CTL-1984: account-slot live-rearm hook
import { resolveBootDependencies, BOOT_DEPENDENCY_HOLD_REASON } from "./boot-dependency-preflight.mjs";
import { getReconcileHealth } from "./reconcile-health.mjs";
import { registerRearmHook, armSecret } from "../lib/secret-contract.mjs"; // CTL-1623: wires rearmGithubTokenFromFile as the github-token row's registered timer rearm hook
import { startAutoTuner } from "./autotune.mjs"; // CTL-684: side-car maxParallel auto-tuner
import { dispatchTicket, makeCommentWakeDispatch, makePhaseAwareDispatchFn, setAgentSessionNarrator } from "./dispatch.mjs"; // CTL-549: comment-wake re-dispatch; CTL-1365a/b: executor→dispatch selection at the launch seam + comment-wake executor binding; CTL-1457: per-phase-aware dispatchFn factory (owns the executor→dispatch selection internally)
import { resolveSdkBootExecutor, assertSdkAuth } from "./sdk-run-phase-agent.mjs"; // CTL-1367 item 9 + P3: boot auth gate (subscription-only) that degrades sdk→bg AND emits execution-core.executor.bg-fallback so the silent fallback is observable; CTL-1457 (T5): assertSdkAuth also gates a per-phase sdk route on a bg/default node
import { resolveCodexBootEligibility } from "./codex-run-phase-agent.mjs"; // CTL-1457: codex boot gate (auth.json + `codex --version`) that degrades routed codex phases + emits execution-core.executor.codex-fallback
import { removeLabel as defaultRemoveLabel } from "./linear-write.mjs"; // CTL-549: clear needs-human on resume
import { setLinearWriteProxy, setLinearWriteProxyResolver } from "./linear-write.mjs"; // CTL-1889: install the cloud write-proxy transport + its replica-backed id resolver
import { createLinearWriteProxy } from "./linear-write-proxy.mjs"; // CTL-1889
import { createAgentSessionNarrator } from "./agent-session-narrator.mjs"; // CTL-1943
import { createProxyResolver } from "./linear-write-proxy-resolve.mjs"; // CTL-1889
import { buildTeamIdentityMismatchEvents } from "./config-identity-event.mjs"; // CTL-2076: surface a registry team-identity mismatch (CAT-52) on the unified event log
// CTL-671: the real phantom-sweep seams. startScheduler defaults them to safe
// no-ops (hermetic for direct-call unit tests); the REAL daemon arms them here
// so the phantom worker-dir validity sweep is operative in production.
import { classifyTicketResolution } from "./linear-query.mjs";
import { createGatewayReader } from "./gateway-read.mjs";
import { createReplicaReader } from "./replica-read.mjs"; // CTL-1340: read-replica tier reader
import { setLaneClaimGuard } from "./lane-claim-install.mjs"; // CTL-2068
import { buildLaneClaimGuard, resolveStateMap } from "./lane-claim.mjs"; // CTL-2068
// CTL-2070: the TIMELY per-ticket actor source (fleet write-ledger). loadLedger seeds the
// process singleton at boot; readFleetWrite is the guard's durable-ledger reader. The scheduler
// records writes into the SAME process singleton via defaultRecordFleetWrite (scheduler.mjs).
import {
  loadLedger as loadLaneClaimLedger,
  readFleetWrite as readLaneClaimFleetWrite,
} from "./lane-claim-write-ledger.mjs";
import { isBgJobAlive, refreshAgents, listClaudeAgentsResult } from "./claude-agents.mjs"; // CTL-1165 D3: fail-closed liveness reader for job-dir GC
import { reconcileSdkRegistryOnBoot } from "./sdk-worker-registry.mjs"; // CTL-1410 Phase B
import { resolveNodeClass as _resolveNodeClass } from "./lib/node-class.mjs"; // CTL-1654: node-class heartbeat/actuation guard
// CTL-1786: lease-authority node entitlement, refreshed on the cluster-sync cadence so a
// not_entitled claim refusal is a rare self-healing edge rather than the steady state.
import { createLeaseAuthorityClient, ensureEntitled as ensureLeaseEntitled } from "./lease-authority.mjs";

// CTL-1623: register the github-token row's rearm hook at module load — BEFORE either
// call site below (both live inside startDaemon(), invoked only later) can fire. Makes
// the registry's "re-armable/timer" label live wiring instead of aspiration: previously
// nothing had called registerRearmHook, so armSecret("github-token") would have taken the
// hookless-degrade path (design §6). registerRearmHook is idempotent (Map.set), so a
// module re-evaluation (a test re-importing this file) never double-registers.
registerRearmHook("github-token", ({ env }) => rearmGithubTokenFromFile({ env, log }));
// CTL-1984: register the claude-accounts.env row's rearm hook at module load — BEFORE
// either cluster-sync tick or boot-time arm call can fire. On each cluster-sync tick
// armSecret("claude-accounts.env") reads the active-slot token from disk and mutates
// process.env.CLAUDE_CODE_OAUTH_TOKEN in-process, so an account-slot switch takes
// effect with no daemon restart. registerRearmHook is idempotent (Map.set).
registerRearmHook("claude-accounts.env", ({ env }) => rearmClaudeAccountsFromFile({ env, log }));

const DEFAULT_MAX_PARALLEL = 3;

let _watcher = null;
let _debounceTimer = null;
let _stopMonitor = null;
let _stopScheduler = null;
let _pidFile = null;

// CAT-29: publish the exact environment the running process booted with so
// catalyst doctor can inspect reality instead of certifying only the installed
// plist. Atomic replacement prevents readers observing a partial JSON body.
export function writeBootFacts(
  orchDir,
  preflight,
  { pid = process.pid, startedAt = new Date().toISOString(), path = process.env.PATH ?? "" } = {},
) {
  const file = join(orchDir, "boot-facts.json");
  const tmp = `${file}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({
      pid,
      startedAt,
      path,
      preflight: {
        ok: preflight?.ok === true,
        missing: Array.isArray(preflight?.missing) ? preflight.missing : [],
        degraded: preflight?.ok !== true || preflight?.degraded === true,
      },
    }),
  );
  renameSync(tmp, file);
  return file;
}
// CTL-649: reap-intent reconciler + periodic orphan-sweep timer.
let _reaper = null;
let _orphanTimer = null;
// CTL-707: periodic background worktree refresh timer.
let _refreshTimer = null;
// CTL-1331: async board-health delegate runner timer (gated CATALYST_DELEGATE_RUNNER).
let _delegateRunnerTimer = null;
// CTL-782: periodic stale/conflicting-PR rescue timer.
let _stalePrRescueTimer = null;
// CTL-1175: periodic orphan-PR detect+notify sweep timer.
let _orphanPrSweepTimer = null;
// CTL-1371: periodic PR→Linear state reconcile timer.
let _linearReconcileTimer = null;
// CTL-1608: periodic stalled-PR detection sweep timer.
let _stalledPrTimer = null;
// CAT-40: periodic GitHub core REST quota snapshot sampler.
let _githubQuotaTimer = null;
let _cloudFeedTimer = null; // CTL-1847: cloud-feed producer tick
let _githubFeedTimer = null; // CTL-1929: github-feed producer tick
// CTL-650: the push-based session wait-state watcher handle.
let _waitWatcher = null;
// CTL-685: per-worker memory sampler handle.
let _memorySampler = null;
// CTL-1165 D5: pre-exhaustion fleet-health probe handle.
let _fleetHealthProbe = null;
// CTL-1502: stuck-but-alive daemon watchdog probe handle.
let _daemonWatchdogProbe = null;
// CTL-787: account-level rate-limit usage poller handle.
let _ratelimitPoller = null;
// CTL-859: node-heartbeat emitter handle (distributed-coordination foundation).
let _heartbeat = null;
// CTL-1090: cross-host liveness publisher handle (multi-host only; single-host no-op).
let _livenessPublisher = null;
// CTL-1274: cluster-repo auto-pull timer handle (git pull --ff-only on a cadence).
let _clusterSyncTimer = null;

// CTL-1786: lease-authority node entitlement state. `_leaseClient` is built lazily; the cached
// entitlement deadline lets ensureLeaseEntitled skip the cloud call until it is close to expiry,
// so the (synchronous) entitle round-trip runs ~once per TTL, not every cluster-sync tick.
let _leaseClient = null;
let _leaseEntitlementExpiresAtMs = null;

// refreshLeaseEntitlement — (re-)entitle this node when the lease gate is shadow/enforce. Cheap
// and cached; FAIL-OPEN — a cloud outage here is logged, never thrown, because a not_entitled
// refusal already self-heals reactively inside claimViaLease. A no-op under `off` (the default),
// so this is inert until an operator opts a host into the lease authority.
function refreshLeaseEntitlement() {
  let mode;
  try {
    mode = resolveLeaseAuthorityMode(process.env);
  } catch {
    return;
  }
  if (mode !== "shadow" && mode !== "enforce") return;
  try {
    if (!_leaseClient) _leaseClient = createLeaseAuthorityClient({ env: process.env });
    const r = ensureLeaseEntitled({
      client: _leaseClient,
      node: getHostName(),
      cachedExpiresAtMs: _leaseEntitlementExpiresAtMs,
    });
    if (r?.refreshed && typeof r.expiresAtMs === "number") {
      _leaseEntitlementExpiresAtMs = r.expiresAtMs;
    }
  } catch (err) {
    log.warn({ err: err?.message }, "cluster-sync timer: lease entitlement refresh threw (continuing)");
  }
}
// CTL-684: auto-tuner stop handle.
let _stopAutoTuner = null;
let _eventWatcher = null;
let _eventDebounceTimer = null;
let _eventPollTimer = null; // CTL-769: poll-fallback drain (fs.watch debounce never fires on the continuously-appended log)
// CTL-792: short-interval liveness-snapshot warmer. ~TTL/2 so the dispatch gate's
// staleMs (2×TTL ≈ 10s) window always sees a fresh snapshot regardless of the
// idle scheduler-tick cadence. Env-tunable.
const LIVENESS_WARM_INTERVAL_MS = Number(process.env.CATALYST_LIVENESS_WARM_MS) || 4_000;
let _livenessTimer = null;
let _eventLogCursor = 0;
// CTL-649: the trailing partial line carried across reads. _eventLogCursor is a
// BYTE offset; consumeEventTail reads only NEW bytes via a file descriptor and
// stitches the leftover onto the front so a line split across two writes (or a
// half-written line at read time) is parsed exactly once, never truncated.
let _eventLogLeftover = "";

// readLinearBotUserIds — collect all known Linear bot user UUIDs from both
// config layers so the self-echo guard covers every app-actor identity:
//   1. NEW:  ~/.config/catalyst/config.json  catalyst.linear.bot.worker.botUserId
//   2. NEW:  ~/.config/catalyst/config.json  catalyst.linear.bot.orchestrator.botUserId
//   3. NEW:  ~/.config/catalyst/config.json  catalyst.linear.bot.cloud.botUserId (CTL-2074)
//   4. OLD:  .catalyst/config.json           catalyst.monitor.linear.botUserId  (Layer-1)
// The `cloud` slot names the cloud tenant's app-actor id the fleet's writes carry
// when CATALYST_LINEAR_WRITE_PROXY=enforce (CTL-1889/ADR-0031). RECOGNITION-ONLY:
// it enters the self-echo set but is deliberately NOT returned by readLinearBotWriteId
// (the daemon must never self-assign as the cloud tenant).
// Returns a Set<string>. Empty set = no filter (fail-open). Never throws. CTL-749.
export function readLinearBotUserIds(layer1Path, layer2Path) {
  const ids = new Set();
  function addFromPath(path, extractor) {
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      extractor(parsed, ids);
    } catch {
      /* ignore unreadable / malformed files */
    }
  }
  // NEW global path: both worker and orchestrator bot identities (Layer 2).
  addFromPath(layer2Path, (p, s) => {
    const bot = p?.catalyst?.linear?.bot;
    if (typeof bot?.worker?.botUserId === "string" && bot.worker.botUserId.length > 0)
      s.add(bot.worker.botUserId);
    if (typeof bot?.orchestrator?.botUserId === "string" && bot.orchestrator.botUserId.length > 0)
      s.add(bot.orchestrator.botUserId);
    // CTL-2074: cloud-proxy app-actor — recognition-only (never a self-assign id).
    if (typeof bot?.cloud?.botUserId === "string" && bot.cloud.botUserId.length > 0)
      s.add(bot.cloud.botUserId);
  });
  // OLD Layer-1 path: catalyst.monitor.linear.botUserId (back-compat). CTL-749.
  addFromPath(layer1Path, (p, s) => {
    const uid = p?.catalyst?.monitor?.linear?.botUserId;
    if (typeof uid === "string" && uid.length > 0) s.add(uid);
  });
  return ids;
}

// readSelfEchoIdentities — the ROTATION-DURABLE self-echo set (CTL-1892).
//
// `readLinearBotUserIds` above is correct but POINT-IN-TIME: it names the currently
// configured app-actors, so a rotation REPLACES the set instead of extending it. From
// the moment a new app-actor starts writing until the config names it, the fleet's own
// echoes read as third-party changes and it dispatches on its own writes. Nothing
// errors — the symptom is indistinguishable from ordinary board activity. Measured on
// this fleet: `f51bc697…` (handle `catalystorchestrator`, 2,241 writes through
// 2026-08-10) was superseded same-day by `ba2989f1…` (`catalystorchestrator2`), and
// only the second is named by any config.
//
// This unions the config set with a durable per-host ledger of every identity the
// fleet has WRITTEN AS, and records the current ones on the way through — so the next
// rotation extends the set rather than reopening the window.
//
// Left as a separate seam rather than folded into readLinearBotUserIds: that function
// is pure and has an inlined twin in doctor.mjs, and giving it a default on-disk
// ledger would make every existing unit test touch real state.
export function readSelfEchoIdentities(layer1Path, layer2Path, ledgerPath, { onDegraded = null } = {}) {
  const configIds = readLinearBotUserIds(layer1Path, layer2Path);
  if (!ledgerPath) return configIds;
  try {
    const r = syncAndResolveSelfIdentities({ configIds, ledgerPath, source: "config" });
    // A degraded ledger is fail-open (config ids are still returned) but must never be
    // silent — "the rotation window is open again" has no other symptom.
    //
    // ⛔ A failed WRITE counts as degradation too. Reporting only `unreadable` misses
    // the read-only-dir / full-disk case entirely: the re-read afterwards reports a
    // healthy-looking `absent`, so durability is silently lost and nothing says so
    // until the NEXT rotation, when the window is already open.
    if (typeof onDegraded === "function") {
      if (r.ledgerStatus === "unreadable") {
        onDegraded({ kind: "ledger-unreadable", status: r.ledgerStatus, reason: r.ledgerReason, path: ledgerPath });
      }
      if (r.notDurable?.length) {
        onDegraded({ kind: "ledger-not-durable", notDurable: r.notDurable, writeFailures: r.writeFailures, path: ledgerPath });
      }
    }
    return r.ids;
  } catch {
    return configIds; // a ledger problem must never cost us the configured ids
  }
}

// refreshSelfEchoIdentitiesInto — re-resolve and merge INTO an existing Set (CTL-1892).
//
// The daemon resolves the identity set once and hands that Set to the monitor, the
// scheduler, and both inbox writers, which capture it in closures. A rotation that
// lands in Layer-2 while the daemon is running would therefore be invisible until a
// restart — the boot-only failure the cluster-sync timer's own comment already warns
// about for credentials ("a credential rotated at 03:00 on a daemon that booted at
// 00:00 stays dead until a human restarts it"). The same argument applies here, and
// the live-rotation moment is precisely the window this ticket exists to close.
//
// Merges in place and returns what it ADDED, so every existing closure observes the
// new identity without re-plumbing. Deliberately MONOTONIC — never removes. A retired
// id must stay recognised, and an id dropped from the set is one the fleet would begin
// dispatching on: the exact defect, reintroduced by the refresh meant to fix it.
export function refreshSelfEchoIdentitiesInto(target, layer1Path, layer2Path, ledgerPath, opts = {}) {
  const added = [];
  try {
    for (const id of readSelfEchoIdentities(layer1Path, layer2Path, ledgerPath, opts)) {
      if (!target.has(id)) {
        target.add(id);
        added.push(id);
      }
    }
  } catch {
    /* a refresh must never wedge the tick that carries it */
  }
  return added;
}

// readLinearBotWriteId — the SINGLE bot UUID the daemon writes as assignee on
// claim (CTL-781): the orchestrator app-actor identity, preferred from Layer-2,
// falling back to the legacy Layer-1 monitor botUserId. Null = self-assign
// disabled (the respect-assignment predicate still runs off the Set). Never throws.
export function readLinearBotWriteId(layer1Path, layer2Path) {
  // Prefer Layer-2: catalyst.linear.bot.orchestrator.botUserId.
  if (layer2Path) {
    try {
      const p = JSON.parse(readFileSync(layer2Path, "utf8"));
      const id = p?.catalyst?.linear?.bot?.orchestrator?.botUserId;
      if (typeof id === "string" && id.length > 0) return id;
    } catch {
      /* ignore */
    }
  }
  // Fallback: Layer-1 catalyst.monitor.linear.botUserId.
  if (layer1Path) {
    try {
      const p = JSON.parse(readFileSync(layer1Path, "utf8"));
      const id = p?.catalyst?.monitor?.linear?.botUserId;
      if (typeof id === "string" && id.length > 0) return id;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// _isBotId — returns true when actorId is in the bot-ids set or (for backward
// compat with tests that pass a plain string) equals the string directly.
// Centralises the "is this the bot?" check used in the three self-echo guards.
export function _isBotId(botUserId, actorId) {
  if (!botUserId || !actorId) return false;
  if (botUserId instanceof Set) return botUserId.has(actorId);
  return botUserId === actorId;
}

// createCommentInboxWriter — factory for a per-daemon onComment subscriber.
// Appends a JSONL entry to ORCH_DIR/workers/<ticket>/inbox.jsonl when the
// ticket is in-flight (workers/ dir exists). Filters bot self-echo via
// botUserId (string or Set<string>). Exported for testing. CTL-749.
export function createCommentInboxWriter(orchDir, botUserId) {
  return function writeCommentToInbox(parsed) {
    const ticket = parsed.ticket ?? parsed.identifier ?? null;
    if (!ticket) return;
    if (_isBotId(botUserId, parsed.authorId)) return;
    const workerDir = join(orchDir, "workers", ticket);
    if (!existsSync(workerDir)) return;
    const entry = JSON.stringify({
      kind: "comment",
      ticket,
      commentId: parsed.commentId,
      body: parsed.body,
      authorId: parsed.authorId,
      authorName: parsed.authorName ?? null,
      receivedAt: new Date().toISOString(),
    });
    appendFileSync(join(workerDir, "inbox.jsonl"), entry + "\n");
  };
}

// createUpdateInboxWriter — factory for a per-daemon onUpdate subscriber.
// Appends a JSONL entry only when descriptionChanged is true and the ticket is
// in-flight. Filters bot self-echo via botUserId. Exported for testing. CTL-749.
export function createUpdateInboxWriter(orchDir, botUserId) {
  return function writeUpdateToInbox(parsed) {
    if (!parsed.descriptionChanged) return;
    const ticket = parsed.ticket ?? parsed.identifier ?? null;
    if (!ticket) return;
    if (_isBotId(botUserId, parsed.actorId)) return;
    const workerDir = join(orchDir, "workers", ticket);
    if (!existsSync(workerDir)) return;
    const entry = JSON.stringify({
      kind: "description_changed",
      ticket,
      description: parsed.description ?? null,
      actorId: parsed.actorId ?? null,
      actorName: parsed.actorName ?? null,
      receivedAt: new Date().toISOString(),
    });
    appendFileSync(join(workerDir, "inbox.jsonl"), entry + "\n");
  };
}

// ensureState — idempotently write a minimal machine-level state.json so the
// CTL-536 scheduler has a maxParallel to read. Never overwrites an operator's
// existing file. Atomic tmp + renameSync, the same idiom as event-cursor.mjs.
function ensureState(orchDir) {
  mkdirSync(orchDir, { recursive: true });
  const statePath = resolve(orchDir, "state.json");
  if (!existsSync(statePath)) {
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ maxParallel: DEFAULT_MAX_PARALLEL }, null, 2));
    renameSync(tmp, statePath);
  }
}

// defaultIsManagedTicket — CTL-1567 (Codex P1): does THIS installation manage the
// ticket? Two independent proofs, either is sufficient:
//   1. a local `workers/<TICKET>/` dir exists — Catalyst has demonstrably run it; or
//   2. the ticket's team prefix is a registered project in registry.json — the
//      ticket is in scope even though its worker dir was reaped (the exact case
//      this whole change exists to serve).
// Fails CLOSED: an unreadable/absent registry with no worker dir ⇒ false, so a
// misconfigured host never mutates labels on tickets it does not own.
export function defaultIsManagedTicket(ticket, orchDir) {
  if (!ticket || !orchDir) return false;
  try {
    if (existsSync(join(orchDir, "workers", ticket))) return true;
  } catch {
    /* fall through to the registry check */
  }
  const prefix = String(ticket).split("-")[0];
  if (!prefix) return false;
  try {
    const reg = JSON.parse(readFileSync(join(orchDir, "registry.json"), "utf8"));
    return (reg?.projects ?? []).some((p) => p?.team === prefix);
  } catch {
    return false; // no registry ⇒ prove nothing ⇒ touch nothing
  }
}

// clearNeedsHumanMarkers — CTL-1567: delete the once-markers that pair with the
// `needs-human` Linear label, so a cleared label and the local marker can never
// disagree. Uses label-guard's `labelMarkerBase` — the SAME path builder labelOnce
// and clearStalledLabel use — rather than a second copy of the layout, so the
// marker naming can never drift between the writer and this reconciler.
// A missing marker is success, not an error: most parked tickets have no worker
// dir at all. A REAL failure (permissions, EIO) is surfaced to the caller rather
// than swallowed, so a marker we could not delete is never reported as reconciled.
export function clearNeedsHumanMarkers(orchDir, ticket, { rm = unlinkSync } = {}) {
  const base = labelMarkerBase(orchDir, ticket, "needs-human");
  const removed = [];
  const failed = [];
  for (const suffix of [".applied", ".skipped"]) {
    const p = `${base}${suffix}`;
    try {
      rm(p);
      removed.push(p);
    } catch (err) {
      // ENOENT is the expected, benign case. Anything else means the marker is
      // still on disk and the label/marker pair is now inconsistent.
      if (err?.code !== "ENOENT") failed.push({ path: p, code: err?.code });
    }
  }
  return { removed, failed };
}

// handleCommentWake — CTL-549 re-dispatch hook. Called on each
// `linear.comment.created` event by the daemon's `onComment` callback wired
// into startMonitor. Scans all phase signals for the comment's ticket; for
// each signal with status === "needs-input", removes the needs-human label
// and re-dispatches via dispatchTicket with the parked handoffPath. For
// status === "stalled", clears the stall via the J3 seam (CTL-1067).
// Fail-open throughout — a bad signal file or clearStall failure is logged
// and skipped, never fatal.
export async function handleCommentWake(
  parsed,
  {
    orchDir,
    dispatch,
    removeLabel,
    botUserId,
    resolveSession = resolvePhaseSessionId,
    clearStall = () => false, // CTL-1067: J3 stall-clear seam; default no-op
    // CTL-764 finding 11: canonical worker.transition emitter for the needs-input→
    // cleared resolution. Injectable for tests; defaults to the real appender.
    appendWorkerTransitionEvent = defaultAppendWorkerTransitionEvent,
    // Codex #2970 round 3: resets the scheduler's in-process worker.transition
    // dedup map (lastDispositionEmit) after this function's own out-of-band clear,
    // so a later genuine re-escalation isn't swallowed by a stale entry. Injectable
    // for tests; defaults to the real scheduler export.
    clearDispositionEmit = defaultClearDispositionEmit,
    // CTL-1567 (Codex P1): is this ticket managed by THIS Catalyst installation?
    // The daemon receives EVERY workspace `linear.comment.created`, so without this
    // gate the no-worker-dir clear below would strip a same-named `needs-human`
    // label off a ticket Catalyst has never owned — and burn one Linear write per
    // workspace comment. Defaults to the real registry check (no wiring required,
    // so an unwired production path is still SAFE, not silently permissive).
    isManagedTicket = defaultIsManagedTicket,
    // CTL-1567 (Codex P1): a human response must RE-ARM recovery, not just unpark.
    // Clearing the label alone leaves `.recovery-intents/<TICKET>.json` latched
    // `escalated:true` for up to 7 days, so the terminal sweep re-applies
    // needs-human while the latch suppresses any fresh attempt — the ticket
    // silently returns to the inbox and cannot be retried. A human answering IS
    // the signal that another attempt is warranted.
    forgetIntent = defaultForgetIntent,
  }
) {
  const { ticket } = parsed ?? {};
  if (!ticket) return;
  // CTL-756: self-echo guard — never re-dispatch on the bot's own comment
  // (e.g. the parking-question comment the parked worker just posted as the
  // Catalyst app actor). Fail-open when botUserId is unset. Mirrors the inbox
  // writers' guard. botUserId accepts a string or Set<string>.
  if (_isBotId(botUserId, parsed.authorId)) return;

  // CTL-1567: CLEAR FIRST — a human answered, so the ticket must drop off the
  // "Needs you" list before anything else is attempted, and regardless of whether
  // anything else succeeds.
  //
  // This used to happen only deep inside the per-signal loop below, which made it
  // conditional on host-local state that has nothing to do with the label:
  //   • no `workers/<TICKET>/` dir  → the `catch { return }` below fired and the
  //     comment was silently dropped. The label lives in LINEAR; a reaped worker
  //     directory must not make it permanently unclearable. Measured 2026-07-29:
  //     10 of 12 parked tickets had no worker dir on either host.
  //   • `status: "needs-human"`     → matched neither the `stalled` nor the
  //     `needs-input` branch, so the ONE status that means "parked for a human"
  //     was the one the wake path ignored.
  //
  // Re-adding is cheap and already automatic (`labelOnce` re-applies it if the
  // ticket still needs a human after this response is processed); never-clearing
  // is what grows the inbox without bound. Idempotent: removeLabel reports the
  // already-absent case as removed:true, so this is safe to run on every comment
  // and safe to run concurrently on both hosts.
  //
  // TWO GATES, both fail CLOSED (Codex P1 ×2). Unlike the self-echo guard above —
  // which may fail open because its only job is suppressing a re-dispatch — this
  // path MUTATES Linear on a ticket that may have no local state at all, so
  // "not sure" must mean "don't touch it":
  //
  //  (a) POSITIVE human provenance. `_isBotId` returns false when botUserId is
  //      unset/malformed OR when authorId is absent, so "not a known bot" does NOT
  //      imply "a human". In that supported fail-open config the escalation posts
  //      its own app-actor explanation comment, whose webhook would then strip the
  //      label it had just applied while the recovery intent stayed latched —
  //      silently defeating the escalation. Require a known author AND a
  //      configured bot set before believing a human answered.
  //  (b) MANAGED ticket. The daemon sees every workspace comment; only clear on
  //      tickets this installation actually manages.
  const humanProvenance = Boolean(parsed.authorId) && Boolean(botUserId);
  let clearedNeedsHuman = false;
  // Codex #2970 round 3: distinct from clearedNeedsHuman (which also covers the
  // idempotent already-absent case and gates the marker reconcile below — that
  // must run either way to keep labelOnce in step). This one is true ONLY when
  // removeLabel performed a real write, so a duplicate webhook / second host
  // re-checking an already-cleared label doesn't emit a second worker.transition
  // "cleared" record for a state change that didn't happen on this call.
  let clearedNeedsHumanWrote = false;
  // Codex #2970 post-merge round 1: this EARLIER needs-input removal (below) can
  // itself be the call that performs the real write — the per-signal loop's own
  // removeLabel(ticket, "needs-input") call then finds the label already absent
  // ({wrote:false}) and would wrongly skip the emission that THIS call earned.
  // Capture it here and OR it into the per-signal loop's write determination so a
  // genuine write, wherever it happens in this invocation, produces exactly one
  // emission instead of zero.
  let needsInputWroteEarly = false;
  if (humanProvenance && isManagedTicket(ticket, orchDir)) {
    try {
      const res = await removeLabel(ticket, "needs-human");
      clearedNeedsHuman = res?.removed !== false; // undefined (test stub) ⇒ success
      clearedNeedsHumanWrote = res?.wrote === true;
    } catch {
      /* fail-open on the WRITE — a Linear 5xx must not block the wake path */
    }
    // CTL-1567 (Codex P1): `needs-input` is the OTHER park label, and the board
    // treats either as a Needs-You ticket (it synthesizes no-worker-dir cards from
    // both). Clearing only needs-human left a parked needs-input ticket in the
    // inbox after the human answered — while this path claimed to be the complete
    // response. Both labels are the same fact from the operator's side.
    try {
      const earlyRes = await removeLabel(ticket, "needs-input");
      needsInputWroteEarly = earlyRes?.wrote === true;
      // Codex #2970 post-merge round 5: this call can ALSO be a real, confirmed
      // clear of the needs-input label — but if the ticket has no local worker
      // dir, the readdirSync below returns before ever reaching the per-signal
      // loop's own clearDispositionEmit(ticket, "needs-input") call. Without this,
      // a live "needs-input" dedup entry would survive indefinitely (there's no
      // later point in this invocation, or any self-heal path, that would reset
      // it for a ticket with no local signal to match against). Reset it here,
      // right where the confirmation is known, independent of whether a worker
      // dir exists.
      if (earlyRes === undefined || earlyRes?.removed !== false) {
        try {
          clearDispositionEmit(ticket, "needs-input");
        } catch {
          /* observability only */
        }
      }
    } catch {
      /* fail-open — same reasoning as above */
    }
    // Re-arm recovery: without this the latch survives and suppresses the retry
    // this response was meant to authorize (see the forgetIntent option above).
    try {
      forgetIntent(ticket, { orchDir });
    } catch (err) {
      log.warn(
        { ticket, err: err?.message },
        "handleCommentWake: recovery-intent re-arm failed — a retry may stay suppressed"
      );
    }
  }
  if (clearedNeedsHuman) {
    // Keep the once-marker in step with the label. Clearing one without the other
    // is the desync that leaves labelOnce permanently disarmed (or the board
    // showing a park Linear no longer has).
    try {
      const { failed } = clearNeedsHumanMarkers(orchDir, ticket);
      if (failed.length) {
        // The label is gone from Linear but a marker survived: labelOnce stays
        // disarmed for this ticket. Surface it — a silent swallow here is exactly
        // the desync this change exists to prevent.
        log.error(
          { ticket, failed },
          "handleCommentWake: needs-human marker NOT removed — labelOnce stays disarmed for this ticket"
        );
      }
    } catch (err) {
      log.warn(
        { ticket, err: err?.message },
        "handleCommentWake: needs-human marker reconcile failed — label already cleared"
      );
    }
    // Codex #2970 round 3: gate the EMISSION on a CONFIRMED write, not merely a
    // confirmed-absent read — otherwise a duplicate webhook / second host that
    // finds the label already gone would still record a fresh "cleared"
    // transition for a change that happened on a prior call, mislabeling the
    // timeline. Only the writer host should ever emit.
    if (clearedNeedsHumanWrote) {
      try {
        appendWorkerTransitionEvent({
          ticket,
          orchId: ticket,
          fromDisposition: "needs-human",
          toDisposition: null,
          reason: "human-responded",
        });
      } catch {
        /* observability only */
      }
    }
    // Codex #2970 post-merge round 2: the daemon and scheduler share
    // lastDispositionEmit in-process — this out-of-band clear never went through
    // recordTransition, so the map still thinks this ticket is "needs-human".
    // Reset it on any CONFIRMED clear (clearedNeedsHuman), not only a write by
    // THIS process (clearedNeedsHumanWrote) — a cross-host clear (another host
    // did the write; this host observes {removed:true, wrote:false}) is just as
    // confirmed, and this process's dedup entry is just as stale either way. Do
    // this rather than waiting on the ticket reaching terminal Done (needs-human's
    // self-heal paths are marker-gated and clearNeedsHumanMarkers above already
    // deleted that marker, so they'd never even attempt the clear).
    if (clearedNeedsHuman) {
      try {
        // Codex #2970 post-merge round 4: clearedNeedsHuman is true on the
        // idempotent already-absent case too — a managed ticket whose CURRENT
        // disposition is "blocked"/"queued" (needs-human never applied) still
        // reaches here. Pass "needs-human" so clearDispositionEmit only resets
        // when the map's live entry actually matches, never an unrelated one.
        clearDispositionEmit(ticket, "needs-human");
      } catch {
        /* observability only */
      }
      // CTL-1643: clear the durable escalation record so the board durable-escalation
      // card disappears when the operator responds. Fail-open (never throws).
      forgetDurableEscalation(orchDir, ticket);
    }
  }

  const workerDir = join(orchDir, "workers", ticket);
  let signalFiles;
  try {
    signalFiles = readdirSync(workerDir).filter(
      (f) => f.startsWith("phase-") && f.endsWith(".json")
    );
  } catch {
    // No local worker state: the label clear above is the entire correct response.
    return;
  }

  for (const fname of signalFiles) {
    let sig;
    try {
      sig = JSON.parse(readFileSync(join(workerDir, fname), "utf8"));
    } catch {
      continue;
    }

    // CTL-1067: an operator answered a STALLED escalation row. Clear the stall via
    // the J3 seam (delete the synthetic stalled signal + remove the needs-human
    // label & markers + .orphan-detected). The scheduler re-derives advancement
    // from the preserved prior-done signal and re-dispatches the phase fresh.
    // CTL-1567: `needs-human` is a SECOND signal status meaning exactly what
    // `stalled` means (written by recovery-emit.mjs / recovery-reasoning.mjs).
    // It matched neither branch here, so an operator answering one of those
    // tickets got no stall clear and no re-dispatch. Treat the two identically
    // until the duplicate status is normalized away (CTL-1552).
    if (sig.status === "stalled" || sig.status === "needs-human") {
      const phase = fname.slice("phase-".length, -".json".length);
      try {
        clearStall({ ticket, phase });
      } catch (err) {
        log.warn(
          { ticket, phase, err: err?.message },
          "handleCommentWake: clearStall threw — skipping"
        );
      }
      continue;
    }

    if (sig.status !== "needs-input") continue;

    const parkedPhase = sig.parkedFrom ?? sig.phase;
    const handoffPath = sig.handoffPath ?? undefined;

    // CTL-768: a held-stopped worker (process killed to free its slot) must be
    // revived with --resume so it continues the paused conversation. Reset the
    // signal to "stalled" first (so phase-agent-dispatch's idempotency guard
    // accepts the re-dispatch — mirrors defaultReviveDispatch) and clear the
    // marker so a future re-park starts clean. A still-alive worker
    // (stoppedForHold falsy) keeps the exact legacy path — no resume, no reset.
    let resumeSession;
    if (sig.stoppedForHold === true) {
      resumeSession = (sig.bg_job_id ? resolveSession(sig.bg_job_id) : null) ?? undefined;
      const signalPath = join(workerDir, fname);
      try {
        const updated = {
          ...sig,
          status: "stalled",
          stoppedForHold: false,
          attentionReason: "ctl-768-hold-wake",
          updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        };
        const tmp = `${signalPath}.tmp.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(updated, null, 2));
        renameSync(tmp, signalPath); // atomic
      } catch (err) {
        log.warn(
          { ticket, phase: parkedPhase, err: err.message },
          "handleCommentWake: hold-wake signal reset failed — skipping"
        );
        continue;
      }
      clearHoldStopCooldown(orchDir, ticket, parkedPhase);
    }

    // CTL-1552: clear the needs-human LABEL and its once-marker TOGETHER via
    // clearStalledLabel — the operator-response unpark now owns both halves. The
    // prior raw label-removal deleted the Linear label but orphaned the once-marker
    // (workers/<T>/.linear-label-needs-human.applied), so labelOnce stayed disarmed
    // (a genuine re-escalation could never re-apply). Both halves together re-arm
    // the guard. Fail-open (clearStalledLabel never throws).
    try {
      clearStalledLabel(orchDir, ticket, "needs-human", { removeLabel });
    } catch {
      /* fail-open */
    }
    // CTL-764 finding E: gate the needs-input→cleared emission on a CONFIRMED removal.
    // removeLabel reports a failed read/write as {removed:false} WITHOUT throwing, so the
    // try/catch alone never suppresses the event — a bare emit would record a clear the
    // durable label never got. An undefined return from a test stub is treated as success
    // to keep the wake path testable.
    // Codex #2970 round 3: removed:true alone still covers both a real removal AND the
    // idempotent already-absent case (linear-write.mjs) — gate the EMISSION on the
    // additive `wrote` field instead, so a duplicate webhook / second host re-checking an
    // already-cleared label doesn't record a second "cleared" transition for a change
    // that happened on a prior call. `wrote` is undefined on a test-stub `undefined`
    // return, so the `res === undefined` success path stays gated on that alone.
    // Codex #2970 post-merge round 1: `needsInputWroteEarly` folds in the EARLIER
    // needs-input removal (in the needs-human block above) — that call can itself be
    // the one that performed the real write, leaving THIS call observing
    // {wrote:false} for a change it didn't make. OR'ing it in means a genuine write,
    // wherever in this invocation it happened, still earns exactly one emission.
    let needsInputRemoved = false;
    // Codex #2970 post-merge round 2: CONFIRMED removal (regardless of who wrote),
    // separate from needsInputRemoved's write-only signal — gates clearDispositionEmit
    // below, not the emission. A cross-host clear (another host wrote; this host
    // observes {removed:true, wrote:false}) is just as confirmed and this process's
    // dedup entry is just as stale either way.
    let needsInputConfirmed = false;
    try {
      const res = await removeLabel(ticket, "needs-input"); // CTL-764 Phase 4: durable needs-input cleared on genuine resolution
      needsInputRemoved = res === undefined || res?.wrote === true || needsInputWroteEarly;
      needsInputConfirmed = res === undefined || res?.removed !== false;
      // Codex #2970 post-merge round 3 / round 5: needsInputWroteEarly is declared
      // once, BEFORE this loop — with multiple phase-*.json signals in needs-input,
      // it would OR into every iteration's needsInputRemoved unchanged, turning one
      // Linear write into one emission per matching signal. Consume the credit here,
      // INSIDE the try, only once removeLabel has actually SUCCEEDED and this
      // iteration has used it — not unconditionally after the try/catch. If this
      // call throws, the catch below skips this line entirely, so a throwing FIRST
      // signal doesn't burn the credit a later, successful signal could still use.
      needsInputWroteEarly = false;
    } catch {
      /* fail-open */
    }
    // CTL-764 finding 11: record the needs-input→cleared resolution in the canonical
    // worker.transition stream. scheduler.mjs owns the park/apply emission; the clear
    // is emitted here (the daemon removes the durable label out-of-band and redispatches
    // — the scheduler never observes this edge). toDisposition:null is encoded as the
    // "cleared" sentinel in the event builder (finding 12). Fail-open — never blocks the
    // wake. finding E: only emitted on a confirmed WRITE (only the writer host emits).
    if (needsInputRemoved) {
      appendWorkerTransitionEvent({
        ticket,
        orchId: ticket,
        fromDisposition: "needs-input",
        toDisposition: null,
        reason: "comment-wake",
        source: "comment-wake-clear",
      });
    }
    // Codex #2970 round 3 / post-merge round 2: scheduler.mjs already self-heals this
    // specific stale entry on its next relevant tick (the
    // `lastDispositionEmit.get(ticket) === HELD_LABEL_NEEDS_INPUT` branch), but
    // resetting it here too closes the window immediately. Gated on CONFIRMED removal,
    // not write-only, so a cross-host clear resets this process's dedup entry too.
    if (needsInputConfirmed) {
      try {
        // Codex #2970 post-merge round 4: same expected-disposition guard as the
        // needs-human site above.
        clearDispositionEmit(ticket, "needs-input");
      } catch {
        /* observability only */
      }
    }

    dispatch(orchDir, ticket, parkedPhase, { handoffPath, resumeSession });
  }
}

// startDaemon — boot the composed daemon. Every composed function is an
// injectable dependency defaulting to the real barrel export, so production
// wiring needs no arguments and tests inject deterministic fakes.
export function startDaemon({
  recover = recoverStartup,
  // CTL-654: synchronous boot-resume pass. Runs once between recover() and the
  // monitor, consuming recover()'s previously-discarded RecoveryReport.
  reconcileBoot = reconcileBootResume,
  startMonitor: monitorFn = startMonitor,
  startScheduler: schedulerFn = startScheduler,
  stopMonitor: stopMonitorFn = stopMonitor,
  stopScheduler: stopSchedulerFn = stopScheduler,
  reconcile = reconcileAll,
  watchRegistry = true,
  debounceMs = EVENT_DEBOUNCE_MS,
  // CTL-769: reaper poll-fallback interval. Injectable so tests can drive the
  // reap-intent drain deterministically; defaults to TAILER_POLL_INTERVAL_MS.
  pollMs = TAILER_POLL_INTERVAL_MS,
  pidFile = null,
  // CTL-649: reaper + orphan-sweep timer. Disable via env knob for tests
  // that only exercise monitor + scheduler.
  enableReaper = process.env.EXECUTION_CORE_DISABLE_REAPER !== "1",
  // CTL-769: reaper factory seam — defaults to the real Reaper; injectable so
  // tests can spy on reap dispatch driven by the poll fallback.
  makeReaper = (opts) => new Reaper(opts),
  orphanReaperConfig = null,
  // CTL-707: worktree refresh timer config (catalyst.orchestration.worktreeRefresh).
  worktreeRefreshConfig = null,
  // CTL-782: stale/conflicting-PR rescue timer config (catalyst.orchestration.stalePrRescue).
  stalePrRescueConfig = null,
  // CTL-1175: orphan-PR detect+notify sweep timer config (catalyst.orchestration.orphanPrSweep).
  orphanPrSweepConfig = null,
  // CTL-1371: PR→Linear state reconcile timer config (catalyst.orchestration.reconcile).
  linearReconcileConfig = null,
  // CTL-1608: stalled-PR detection sweep timer config (catalyst.orchestration.stalledPrSweep).
  stalledPrSweepConfig = null,
  // CTL-1608: injectable seam for the stalled-PR timer (tests spy on it).
  startStalledPrTimer: startStalledPrTimerFn = realStartStalledPrTimer,
  // CAT-40: injectable GitHub quota sampler seam.
  startGithubQuotaTimer: startGithubQuotaTimerFn = realStartGithubQuotaTimer,
  // CTL-650: the session wait-state watcher. Injectable for tests; gated by a
  // config knob (default-on, CATALYST_WAIT_WATCHER=0 disables) like the reaper.
  startWaitWatcher = realStartWaitWatcher,
  enableWaitWatcher = readWaitWatcherConfig().enabled,
  // CTL-685: per-worker memory sampler. Injectable for tests; gated by a config
  // knob (default-on, CATALYST_MEMORY_SAMPLER=0 disables) like the wait-watcher.
  startMemorySampler = realStartMemorySampler,
  enableMemorySampler = readMemorySamplerConfig().enabled,
  // CTL-1165 D5: pre-exhaustion fleet-health probe. Injectable for tests; gated
  // by a config knob (default-on, CATALYST_FLEET_HEALTH=0 disables) like the
  // memory sampler. The probe is EMIT-ONLY by default (self-heal default OFF).
  startFleetHealthProbe = realStartFleetHealthProbe,
  // undefined → resolve from config (env + Layer-1 via configPath) in the boot
  // body below; tests may force true/false and that wins via `??`.
  enableFleetHealth = undefined,
  // CTL-1502: stuck-but-alive daemon watchdog probe. Injectable for tests; gated
  // by the readDaemonWatchdogConfig mode (default "shadow" → enabled; off disables).
  // Shadow-first: it detects + logs would-restart but performs no restart until an
  // operator flips it to enforce.
  startDaemonWatchdogProbe = realStartDaemonWatchdogProbe,
  // undefined → resolve from config (env + Layer-1 via configPath) below; tests
  // may force true/false and that wins via `??`.
  enableDaemonWatchdog = undefined,
  // CTL-787: account-level rate-limit usage poller. Injectable for tests; gated
  // by a config knob (default-on, CATALYST_RATELIMIT_POLLER=0 disables) like the
  // memory sampler.
  startRatelimitPoller = realStartRatelimitPoller,
  enableRatelimitPoller = readRatelimitPollerConfig().enabled,
  // CTL-859: node-heartbeat emitter. Injectable for tests; default-on, gated by
  // CATALYST_HEARTBEAT=0 (the test/opt-out knob, mirroring the other timers).
  // ADDITIVE/dormant — the heartbeat only appends observability events; nothing
  // in dispatch/claim consumes them in PR1.
  startHeartbeat = realStartHeartbeat,
  enableHeartbeat = process.env.CATALYST_HEARTBEAT !== "0",
  // CTL-1090: cross-host liveness publisher. Injectable for tests. Single-host
  // installs get an inert no-op handle from startLivenessPublisher itself.
  startLivenessPublisher = realStartLivenessPublisher,
  // CTL-1654: node-class guard seam. Injectable for tests (production uses the
  // zero-import lib/node-class.mjs resolver). Defaults to the real resolver.
  nodeClassResolver = _resolveNodeClass,
  // CTL-1274 + CTL-1393: cluster-repo auto-refresh. clusterSync runs once at boot
  // (pull + decrypt secrets + seed the change-detection marker); refreshClusterSecrets
  // runs on a cadence — it pulls AND, when the clone's HEAD moved with a secrets/
  // change, re-decrypts the rotated secrets and refreshes the on-disk plaintext
  // (advancing the durable .cluster-sync-state.json marker). This closes the
  // silent-stale window where a rotated secret reached the clone but stayed invisible
  // to the running daemon until a manual restart, AND still propagates roster changes
  // (the next scheduler tick re-reads cluster.json.roster). Both are FAIL-OPEN (a
  // failure logs + continues, never breaks the daemon) and injectable for hermetic
  // tests. enableClusterSync=false disables both (test default + a CATALYST_CLUSTER_SYNC=0
  // kill-switch).
  clusterSync = realClusterSync,
  refreshClusterSecrets = realRefreshClusterSecrets,
  clusterSyncIntervalMs = CLUSTER_SYNC_INTERVAL_MS,
  enableClusterSync = process.env.CATALYST_CLUSTER_SYNC !== "0",
  // CTL-665: committed executionCore concurrency knobs resolved in main() from
  // .catalyst/config.json. Threaded into both the scheduler new-work pull and the
  // boot-resume ceiling. Empty {} (the test default) keeps the legacy state.json path.
  concurrency = {},
  // CTL-676: the resolved config path. Threaded only into startScheduler so the
  // scheduler can re-read concurrency knobs per tick (hot-reload). reconcileBoot
  // intentionally stays on the boot-captured `concurrency` object — it fires
  // once before the scheduler starts and never re-reads. Null in tests that
  // never resolve a config path.
  configPath = null,
  // CTL-678: machine-canonical Layer-2 path (~/.config/catalyst/config.json).
  // Threaded into startScheduler alongside configPath so the per-tick re-read
  // can apply Layer-2's per-field override on every tick (hot-reload of the
  // override). Null in tests; production main() resolves it from
  // CATALYST_LAYER2_CONFIG_FILE || ~/.config/catalyst/config.json.
  layer2Path = null,
  // CTL-684: auto-tuner injectable seams (production uses the real module;
  // tests inject spies). The stop handle is stored so stopDaemon can tear it
  // down symmetrically with the scheduler block.
  startAutoTuner: startAutoTunerFn = startAutoTuner,
  // CTL-854: injectable for the boot empty-registry health check. Tests inject
  // a deterministic fake; production uses the real registry reader.
  listProjects: listProjectsFn = realListProjects,
  // CTL-1612: injectable GitHub-credential boot preflight. Tests inject a fake; in
  // production it probes `gh` for real. Advisory — never throws, never blocks boot.
  githubAuthPreflight = resolveGithubBootAuth,
  bootDependencyPreflight = resolveBootDependencies,
  // CTL-862: injectable seams for the ownership boot-log. Tests inject a fixed
  // roster and eligible list; production resolves them from the real modules.
  readAllEligible = readAllEligibleTickets,
  bootHosts = undefined,
  bootHostName = undefined,
  // CTL-1271: injectable roster-resolution seam for the boot assertion. Tests
  // inject a fixed { hosts, source, multiHost }; production resolves it from the
  // real config (resolveClusterHosts). Kept separate from bootHosts so the
  // CTL-862 ownership-log tests (which inject bootHosts directly) still pass.
  bootResolve = undefined,
} = {}) {
  const orchDir = getExecutionCoreDir();
  let bootDependencyState = { ok: true, missing: [], holdReason: null };
  ensureState(orchDir);
  // CTL-862: write the resolved config path back into the env so downstream
  // callers (getClusterHosts → getCatalystRepoDir) resolve the right repo
  // regardless of the daemon's cwd. ||= preserves any launcher-provided value.
  if (configPath) process.env.CATALYST_CONFIG_FILE ||= configPath;
  // CTL-655: record this daemon process's start time so the first scheduler
  // tick's reclaimDeadWorkIfPossible can window the per-ticket revive budget to
  // the current run (a clean restart resets a budget burned by a prior storm).
  // Must precede schedulerFn (the first reclaim read). Fail-open internally.
  writeBootMarker(orchDir);
  // CTL-736 Phase 3: reset the per-(ticket, phase) progress high-water markers so a
  // stale mark from a prior daemon run cannot false-STOP the first death this run.
  clearProgressMarks(orchDir);
  // CTL-1321: boot accepting work by default — clear the persistent drain flag
  // (+ drain.drained sentinel) a prior drain left, so a quiesce→restart resumes
  // new-work admission instead of coming up silently drained. CATALYST_BOOT_DRAINED=1
  // re-arms drain for nodes deliberately kept out of rotation. Best-effort/fail-open;
  // grouped with the writeBootMarker/clearProgressMarks prior-run resets and ahead of
  // schedulerFn, the sole consumer of the `!draining` new-work gate.
  const _bootDrain = applyBootDrainPolicy(orchDir);
  log.info(
    { drained: _bootDrain.drained },
    _bootDrain.drained
      ? "boot: CATALYST_BOOT_DRAINED set — node boots drained, holding new-work admission (CTL-1321)"
      : "boot: drain flag cleared — node accepting work (CTL-1321)"
  );
  _stopMonitor = stopMonitorFn;
  _stopScheduler = stopSchedulerFn;

  // CTL-792: keep the liveness snapshot warm so an idle tick cadence doesn't hold
  // new-work dispatch forever on the staleMs gate. CTL-790 made the snapshot
  // POPULATE, but it is refreshed only LAZILY (once per scheduler tick) — and an
  // idle daemon ticks every ~15-30s while staleMs is short, so the snapshot is
  // always stale by the next gate check. A dedicated short-interval refresh keeps
  // _asyncSnap < staleMs old AND keeps the worker count ~TTL-accurate (over-spawn-
  // safe). UNCONDITIONAL — core to dispatch, must NOT depend on the optionally-
  // disabled reaper (its earlier placement inside startReaperAndTimer never ran).
  // Fire-and-forget + single-flight; unref'd; torn down in stopDaemon.
  _livenessTimer = setInterval(() => {
    try {
      Promise.resolve(refreshAgents()).catch((err) =>
        log.warn({ err: err?.message }, "liveness warmer: refresh failed")
      );
    } catch (err) {
      log.warn({ err: err?.message }, "liveness warmer: threw");
    }
  }, LIVENESS_WARM_INTERVAL_MS);
  _livenessTimer.unref?.();

  // CTL-586: write the PID file BEFORE the synchronous boot work
  // (recover/monitor/scheduler each trigger a blocking reconcile that fans
  // out one spawnSync("linearis", ...) per registered team). The wrapper's
  // 2s PID-file poll (catalyst-execution-core:83-91) otherwise times out
  // and reports "may be hung mid-init" against a daemon that is in fact
  // booting normally. PID-file presence now means "process up" — callers
  // do `kill 0 <pid>` for liveness; the daemon stays the sole writer.
  if (pidFile) {
    _pidFile = pidFile;
    const tmp = `${pidFile}.tmp`;
    writeFileSync(tmp, String(process.pid));
    renameSync(tmp, pidFile);
  }

  // CTL-1678 (Codex round-3 P1): snapshot the drain-override env THIS process captured,
  // keyed by our pid, so read-only surfaces (status / doctor / verify-node) report the
  // running daemon's effective state instead of re-reading the mutable env file (whose
  // edits are restart-only and may describe a future daemon, not this one). Written
  // AFTER the pid file — readers require both to agree, so the reverse order would
  // publish a snapshot that is briefly unverifiable. `pidFile` is recorded in the
  // payload because EXECUTION_CORE_PID_FILE can relocate it (round-5 P2).
  writeDaemonRuntimeEnv(orchDir, { pidFile });

  // A throw from any composed boot step must not leave a stale PID file —
  // stopDaemon removes _pidFile via unlinkSync. Rethrow so the main()-level
  // try/catch logs and process.exit(1)s as before.
  // CTL-1084: hoisted so emitBootEvent at the boot-log site can reference them
  // after the try block completes without a throw.
  let _bootReport;
  let _bootResume;
  try {
    // CTL-539 — rebuild routing + worker state on boot. CTL-654: capture the
    // RecoveryReport (previously discarded) so the boot-resume pass can consume
    // its `coldStart` verdict + worker buckets.
    const report = recover({ orchDir });
    _bootReport = report;
    // CTL-1365a/b Stage C: resolve the phase-worker executor ONCE per boot (env →
    // Layer-1 catalyst.orchestration.executor → node-class default; every class
    // maps to "bg" in Phase 1, so an unset flag is a pure no-op) and select the
    // dispatch function threaded into ALL FOUR dispatch entry points — the
    // scheduler pull-loop, the monitor's →Triage one-shot, the comment-wake
    // re-dispatch, AND the boot-resume crash-recovery pass — so a node never
    // split-brains (some sites bg, others sdk). Resolved here, BEFORE reconcileBoot,
    // precisely so boot-resume honors the flag too. For executor=bg/oneshot-legacy
    // dispatchFn === defaultDispatch (byte-identical to today); "sdk" → sdkDispatch
    // (injects sdkRunPhaseAgent). dispatchMode is the catalyst.dispatch.mode
    // telemetry vocab ("phase-agents" for bg) for the scheduler's Tier-1 tick line.
    // CTL-1367 item 9 + P3: DAEMON-BOOT auth gate. assertSdkAuth also runs at
    // dispatch time (no claim, no signal on a bad env), but a boot-time check fails
    // LOUD once and gracefully degrades the WHOLE boot to bg rather than letting
    // every sdk dispatch silently meter / refuse. resolveSdkBootExecutor WARN-logs
    // AND emits execution-core.executor.bg-fallback to the unified event log (via
    // defaultAppendOperatorEvent) so the silent bg-fallback — which can diverge from
    // doctor's PASS when the daemon's launchd env lacks the OAuth token the operator
    // shell has — is visible in monitoring. For executor=bg/oneshot-legacy it is a
    // pure pass-through (no auth check, no event), byte-identical to today.
    const bootExec = resolveSdkBootExecutor(getExecutor(configPath), {
      env: process.env,
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      emitEvent: defaultAppendOperatorEvent,
      log,
    });
    // CTL-1457 (finding 1): `let` because a codex-exec BOOT executor that fails the
    // codex boot precondition is degraded to "bg" below (resolveSdkBootExecutor passes
    // codex-exec through untouched — the node-level codex degrade is owned here, the
    // mirror of its own sdk→bg degrade).
    let executor = bootExec.executor;
    // CTL-1457: per-phase executor routing. Read the Layer-1 executorByPhase map
    // ONCE and VALIDATE every value loudly at boot — resolveExecutorForPhase THROWS
    // on an invalid/typo'd executor id, so wrap each per-phase check so a bad value
    // is loud-but-NON-fatal (log.error + a best-effort event) and that phase simply
    // falls back to the boot executor at dispatch time (makePhaseAwareDispatchFn
    // catches the same throw). An empty map (the default) is a pure no-op.
    const executorByPhase = readExecutorByPhaseLayer1(configPath);
    for (const [routedPhase, routedValue] of Object.entries(executorByPhase)) {
      try {
        resolveExecutorForPhase(routedPhase, { configPath });
      } catch (err) {
        log.error(
          { err: err.message, phase: routedPhase, value: routedValue },
          "executorByPhase: invalid routing value at boot — that phase will use the boot executor (fix Layer-1 catalyst.orchestration.executorByPhase)"
        );
        try {
          defaultAppendOperatorEvent({
            "event.name": "execution-core.executor.route-invalid",
            payload: { phase: routedPhase, value: routedValue, reason: err.message },
          });
        } catch {
          /* best-effort */
        }
      }
    }
    // CTL-1457: codex boot-eligibility gate. When codex is routed — a per-phase route
    // OR the node-level boot executor is itself codex-exec (finding 1) — assert the
    // codex auth home + probe `codex --version`; on failure it WARN-logs and emits
    // execution-core.executor.codex-fallback, and makePhaseAwareDispatchFn degrades
    // routed codex phases to the boot executor. When nothing routes to codex it is a
    // pure no-op (eligible:true, no checks, no event). `bootExecutor` is threaded so
    // the gate arms for a codex-exec boot node and labels the event's `effective`
    // degrade target (finding 5: "bg" for a codex node, else the real boot executor).
    const codexElig = resolveCodexBootEligibility(executorByPhase, {
      codexCfg: codexConfig({ configPath }),
      emitEvent: defaultAppendOperatorEvent,
      bootExecutor: bootExec.executor,
      log,
    });
    // CTL-1457 (finding 1): degrade the NODE-LEVEL boot executor when codex-exec is the
    // node default but the codex boot precondition failed — mirror resolveSdkBootExecutor's
    // sdk→bg degrade (it passes codex-exec through untouched, so the node-level codex
    // degrade lives here). Without this a codex-exec node whose auth/binary is unusable
    // would still route EVERY unrouted phase to the non-eligible codex executor. A
    // per-phase codex route degrades separately inside makePhaseAwareDispatchFn.
    if (bootExec.executor === "codex-exec" && !codexElig.eligible) {
      executor = "bg";
    }
    // CTL-1410 Phase B: reap stale SDK-worker disk projections. No in-process
    // worker survives a daemon restart, so any projection whose pid is dead is
    // a leftover of the previous daemon; delete it BEFORE boot-resume and the
    // scheduler run, so no liveness consumer trusts a ghost projection.
    const sdkRegistryBoot = reconcileSdkRegistryOnBoot(orchDir);
    if (sdkRegistryBoot.removed.length > 0 || (sdkRegistryBoot.killedChildren?.length ?? 0) > 0) {
      log.info(
        {
          removed: sdkRegistryBoot.removed,
          kept: sdkRegistryBoot.kept,
          harvested: sdkRegistryBoot.harvested.map((h) => h.ticket),
          // CTL-1457 (N2): orphaned codex children SIGTERM'd before their dead-daemon
          // projections were reaped (empty on a pure sdk/bg fleet).
          killedChildren: (sdkRegistryBoot.killedChildren ?? []).map((k) => k.ticket),
        },
        "boot: reaped stale sdk-worker projections (CTL-1410); harvested warm-resume sessions (CTL-1422); killed orphaned codex children (CTL-1457 N2)"
      );
    }
    // CTL-1422: interrupted in-process runs (dead-pid projections that captured a
    // session UUID) become warm-resume candidates — boot-resume CONTINUES their
    // SDK session via options.resume instead of cold re-dispatching the phase.
    const sdkSessionHarvest = new Map(
      sdkRegistryBoot.harvested.map((h) => [h.ticket, h.sessionId])
    );
    // CTL-1457: the SINGLE phase-aware dispatchFn threaded to all FIVE dispatch entry
    // points. Per dispatch it consults resolveExecutorForPhase(phase) — a routed phase
    // runs on its configured executor (codex degraded to the boot executor when
    // codexElig.eligible is false), every other phase on the boot executor. It also
    // owns the CTL-1396 emitEvent adaptation: for the sdk AND codex-exec arms it binds
    // defaultAppendOperatorEvent (the one-arg {event.name,payload} envelope) into the
    // runner's two-arg (name,payload) emitEvent so execution-core.{sdk,codex}.* telemetry
    // lands in the JSONL event log / Loki, not just daemon.log's stderr. With
    // executorByPhase empty (the default) every phase resolves to the boot executor, so
    // the selected dispatch fn + emitEvent wrapping are byte-identical to today.
    // CTL-1457 (T5): the daemon-boot sdk-auth verdict for a per-phase sdk route. The
    // node-level executor already went through resolveSdkBootExecutor (sdk→bg on a bad
    // env), but a phase EXPLICITLY routed to "sdk" on a bg/default node bypasses that
    // node-level gate — so compute the same auth verdict here and thread it so
    // makePhaseAwareDispatchFn degrades a routed sdk phase to the boot executor ONCE
    // instead of refusing before prelaunch on every dispatch. Zero-change-when-unrouted:
    // the flag is only consulted for an EXPLICITLY-routed sdk phase.
    const sdkBootEligible = assertSdkAuth({
      env: process.env,
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    }).ok;
    const dispatchFn = makePhaseAwareDispatchFn({
      bootExecutor: executor,
      codexBootEligible: codexElig.eligible,
      sdkBootEligible,
      configPath,
      emitEvent: defaultAppendOperatorEvent,
      log,
    });
    const dispatchMode = dispatchModeForExecutor(executor);
    // CTL-1457 (N1): the PRIMARY codex/sdk rollout routes ONE phase to codex-exec/sdk
    // on a node whose boot executor is still bg — there dispatchMode is "phase-agents"
    // so the scheduler/monitor slot gates (which gate on isInProcessDispatchMode) skip
    // countSdkInflight and the routed no-bg worker is NOT counted → over-admit past
    // maxParallel. Derive this flag from the ALREADY-READ executorByPhase map and thread
    // it alongside dispatchMode so those gates OR it in and count the routed worker.
    // Empty map (the default) → false → byte-identical. NOTE: a routed-but-degraded
    // executor (codex not eligible → bg) still arms the gate, but countSdkInflight then
    // sees 0 no-bg signals (the phase launches bg with a bg_job_id), so occupancy is
    // unchanged — the flag is safe to derive from the raw routing map.
    const hasInProcessRoute = hasInProcessExecutorRoute(executorByPhase);
    // CTL-1365b: the comment-wake re-dispatch binding — routes a parked ticket's
    // re-dispatch through the SAME resolved executor (no split-brain).
    const commentWakeDispatch = makeCommentWakeDispatch(dispatchFn);
    // CTL-654: boot-resume — on a cold start, re-dispatch in-flight tickets whose
    // worktree has no live --bg worker, BEFORE the monitor/scheduler start. This
    // bypasses the per-tick reclaim sweep's revive budget (a clean reboot is not
    // a chronic-failure storm) and is bounded by maxParallel so a reboot never
    // spawns a worker storm. Synchronous and inside the same try/catch so a throw
    // still triggers PID-file cleanup. A non-cold-start restart is a no-op.
    // CTL-1365b: dispatch === dispatchFn so the crash-recovery re-dispatch honors
    // the executor flag (defaultDispatch under bg — reconcileBootResume's own
    // default — so byte-identical to today).
    // CTL-1612 (Codex P1, round 2): materialize cluster secrets and arm the GitHub
    // credential BEFORE anything dispatches. reconcileBoot and processApprovedResumes
    // below launch workers synchronously, and dispatch.mjs spawns them with
    // ...process.env — so a node returning after a rotation would hand every resumed
    // worker the stale credential and they would keep it for their whole lifetime, even
    // though the daemon's own env gets corrected later. clusterSync() takes no arguments
    // and is fail-open, so hoisting it here is safe; the periodic refresh timer is still
    // armed further down, next to the other timers.
    if (enableClusterSync) {
      try {
        const bootSync = clusterSync();
        log.info({ pull: bootSync?.pull }, "execution-core daemon: cluster-repo synced at boot");
      } catch (err) {
        log.warn({ err: err?.message }, "execution-core daemon: boot cluster-sync threw (continuing)");
      }
    }
    // Re-arm ONLY (no probe) before anything dispatches: this is a cheap local file read,
    // and it is what stops a boot-resumed worker inheriting a credential the sync just
    // superseded. The probe is deliberately NOT here — it spawns `gh` with a 10s timeout,
    // and putting a network round-trip ahead of crash recovery would delay re-dispatching
    // in-flight work for no diagnostic benefit. It runs after the dispatches instead.
    // CTL-1623: routed through armSecret so the registered rearm hook fires (registerRearmHook
    // above) instead of calling rearmGithubTokenFromFile directly — same effect (the hook
    // closure IS rearmGithubTokenFromFile), but through the registry's arm path.
    armSecret("github-token", { env: process.env });

    // CAT-29 (Codex P1): the dependency verdict must be resolved BEFORE anything
    // dispatches, and it must actually quarantine the actuators. Previously this ran
    // after reconcileBoot/processApprovedResumes had already launched workers and was
    // consumed only by the heartbeat callbacks — so a node missing `linearis`/`node`
    // advertised itself as non-accepting while still dispatching work that could only
    // fail, producing stalled/retry churn. Hoisting is safe: unlike githubAuthPreflight
    // (a 10s `gh` network round-trip, deliberately left after the dispatches) this probe
    // is a local PATH lookup and is fail-open — an indeterminate probe returns ok:true.
    bootDependencyState = bootDependencyPreflight({ env: process.env, log });
    writeBootFacts(orchDir, bootDependencyState);
    if (!bootDependencyState.ok) {
      log.warn(
        { missing: bootDependencyState.missing, holdReason: bootDependencyState.holdReason },
        `execution-core boot dependencies unusable (${bootDependencyState.missing.join(", ")}) — ` +
        `quarantined: crash-recovery re-dispatch, approved-resume dispatch, and the ` +
        `monitor + scheduler actuators are NOT armed. The process stays UP and keeps ` +
        `heartbeating as non-accepting so the fleet can see it refusing (CAT-29).`
      );
    }

    // CAT-29: both boot dispatch entry points are gated on the verdict — a quarantined
    // node must not re-launch in-flight work it cannot run.
    if (bootDependencyState.ok) {
      const bootResume = reconcileBoot({
        orchDir,
        report,
        concurrency,
        dispatch: dispatchFn,
        sdkSessionHarvest,
      }); // CTL-665: config-first ceiling; CTL-1422: warm-resume harvest
      _bootResume = bootResume;
      // CTL-644: dispatch any gated tickets that already have an approval sentinel on disk
      // (operator may have dropped the sentinel while the daemon was down).
      // CTL-1367 item E2: thread the resolved executor dispatch — this is the 5th
      // dispatch entry point and previously defaulted to defaultDispatch, so an
      // approved-resume ticket launched via bg even under executor=sdk (split-brain).
      processApprovedResumes({ orchDir, dispatch: dispatchFn });
    }
    // CTL-1612: NOW probe the credential — after the dispatches, so a 10s `gh` timeout can
    // never delay crash recovery. Advisory only: never throws, never blocks boot, and
    // alerts solely on a definitive 401.
    githubAuthPreflight({ env: process.env, log });
    // CTL-634: one shared TTL state cache. The monitor write-through populates
    // it on every state_changed event; the scheduler read path consults it
    // during out-of-set blocker hydration. A single instance threaded into
    // both is what turns a write-through into a guaranteed next-tick hit.
    const cache = createTicketStateCache();
    // CTL-823: readonly client over the broker's durable descriptor store
    // (~/catalyst/filter-state.db). Fail-open — see gateway-read.mjs.
    const gatewayReader = createGatewayReader();
    // CTL-1340: flag-gated read-replica tier (INERT by default). Constructed
    // ONLY when CATALYST_LINEAR_REPLICA resolves to "on" — otherwise undefined,
    // so the scheduler's replica block is never reached and behavior is
    // byte-identical to pre-CTL-1340. HIT-only acceleration of the hot
    // per-signal terminal reads once a Catalyst-Cloud replica is seeded on host.
    const replicaReader = readLinearReplica().mode === "on" ? createReplicaReader() : undefined;
    // CTL-565: the monitor needs orchDir to one-shot-dispatch the triage phase
    // agent on a →Triage transition. `dispatch` stays an injectable default
    // (dispatch.mjs) so the daemon's fakes-pass-through pattern still holds.
    // CTL-749: resolve bot user IDs from both config layers (Layer-1 old path +
    // Layer-2 new global path) so inbox writers and the comment-wake guard
    // suppress self-echo from BOTH the worker app-actor AND the orchestrator
    // app-actor. Returns a Set<string> — empty = no filter (fail-open).
    // CTL-1892: rotation-durable — config ids UNION every identity this host has
    // written as, so an app-actor re-mint extends the self-echo set instead of
    // reopening a window where the fleet dispatches on its own echoes.
    // A STABLE Set object, filled in place: the monitor, scheduler and both inbox
    // writers capture this reference, so refreshing its CONTENTS on the cluster-sync
    // tick is what makes a LIVE rotation visible without re-plumbing every closure.
    const linearBotUserIds = new Set();
    const refreshBotIdentities = () =>
      refreshSelfEchoIdentitiesInto(linearBotUserIds, configPath, layer2Path, defaultIdentityLedgerPath(), {
        onDegraded: (d) => log?.warn?.(d, "self-echo identity ledger degraded — rotation durability at risk"),
      });
    refreshBotIdentities();
    const linearBotWriteId = readLinearBotWriteId(configPath, layer2Path); // CTL-781

    // ── CTL-2068 — install the lane-claim guard ──
    //
    // "A claim another automation can overwrite is not a claim." Twice in two nights a lane
    // claimed a ticket and the pipeline dragged it BACK to a candidate state minutes later,
    // whereupon a worker dispatched it and opened a duplicate PR.
    //
    // ⛔ Installed UNCONDITIONALLY, not behind a mode flag. Its refusal is narrow (only a
    // regression, and only when a non-fleet actor made the last state change) and every case
    // it cannot judge ALLOWS the write, so there is no posture for it to be wrong in — while
    // a shadow default would reproduce this repo's recurring failure of shipping a correct
    // mechanism nobody ever arms. The DISPATCH half has its own kill switch below, because
    // that one withholds work rather than merely a status write.
    //
    // ⭐ `linearBotUserIds` is passed by REFERENCE on purpose: it is the stable Set filled in
    // place by refreshBotIdentities on every cluster-sync tick, so an app-actor re-mint keeps
    // the guard's notion of "the fleet" current instead of freezing it at boot. A copy here
    // would make the guard read every post-rotation fleet write as a lane's.
    //
    // Without a replica reader the guard has no history to consult and answers INCONCLUSIVE
    // for every ticket — allowing the write, and SAYING so in the log line below rather than
    // silently doing nothing.
    //
    // ⛔ THE STATE MAP IS RESOLVED THROUGH A LADDER, NOT FROM `configPath` ALONE.
    // Measured on the fleet immediately after this guard first shipped: it installed on both
    // minis and ranked ZERO states on `mini`, i.e. it could never refuse anything — an
    // installed-but-inert guard, visible only because the install line logs the count.
    //
    // Cause: `configPath` is `CATALYST_CONFIG_FILE || <cwd>/.catalyst/config.json`, and the
    // two hosts differ. mini-2 pins the env var at the plugin-source config; mini does not,
    // and the daemon's cwd there is the HOME dir — where a `.catalyst/config.json` happens to
    // exist carrying no `catalyst.linear` at all. So the read succeeded and returned nothing,
    // which is worse than failing.
    //
    // The registry's repoRoots are tried FIRST because they are the authoritative source:
    // `linear-transition.sh` — the thing that actually performs the write this guard judges —
    // is invoked with `--config <repoRoot>/.catalyst/config.json`. Ranking off any other file
    // risks judging against a map the writer does not use.
    // ⛔ CTL-2068 (Codex P1): resolved PER TEAM, not once process-wide. The registry holds
    // several teams, each with its own repoRoot and its own `.catalyst/config.json`, and
    // linear-write.mjs resolves repoRoot PER TICKET and hands THAT project's config to
    // linear-transition.sh — including its higher-precedence per-project overrides. Ranking
    // every team against the first registry entry's map judges tickets against names their
    // own writer never uses.
    const laneClaimTeamPaths = new Map();
    // CTL-2076: read the registry identity ONCE and share it between the path map
    // build below and the mismatch scan after guard install — a throwing registry
    // still leaves an empty [] so both paths degrade gracefully.
    let laneClaimProjects = [];
    try {
      laneClaimProjects = listProjectsFn() ?? [];
      for (const proj of laneClaimProjects) {
        if (proj?.team && proj?.repoRoot) {
          laneClaimTeamPaths.set(
            String(proj.team).toUpperCase(),
            resolve(proj.repoRoot, ".catalyst", "config.json")
          );
        }
      }
    } catch {
      /* a throwing registry must not block boot → the guard falls back to the default map */
    }
    // ⚠️ The parameter is NOT named `path`. CTL-1529's event-log read guard taints that
    // identifier module-wide, so `(path) => readFileSync(path, "utf8")` trips it — a false
    // positive (this reads a project's .catalyst/config.json, never the event log). Renaming
    // is the honest fix: an allowlist entry would carve a permanent exemption into a guard
    // that is right to be conservative.
    const laneClaimReadFile = (configFilePath) => readFileSync(configFilePath, "utf8");
    const laneClaimFallback = [
      ["configPath", configPath],
      ["layer2", layer2Path],
    ];
    // The DEFAULT map — every registry project, then the two ambient paths. Used for a ticket
    // whose team is not in the registry, and by the install line below.
    const laneClaimDefault = resolveStateMap(
      [
        ...[...laneClaimTeamPaths].map(([team, path]) => [`registry:${team}`, path]),
        ...laneClaimFallback,
      ],
      laneClaimReadFile
    );
    const laneClaimStateMap = laneClaimDefault.stateMap;
    const laneClaimStateMapSource = laneClaimDefault.source;
    const laneClaimStateMapForTicket = (ticket) => {
      const team = String(ticket ?? "")
        .split("-")[0]
        ?.toUpperCase();
      const path = team ? laneClaimTeamPaths.get(team) : null;
      if (!path) return laneClaimDefault;
      return resolveStateMap([[`registry:${team}`, path], ...laneClaimFallback], laneClaimReadFile);
    };
    // Only an explicit "off" disables the dispatch veto — an unset or misspelled value leaves
    // it armed, because the failure this ticket is about is a claim quietly not being honoured.
    const laneClaimDispatchVeto =
      String(process.env.CATALYST_LANE_CLAIM_DISPATCH_GUARD ?? "")
        .trim()
        .toLowerCase() !== "off";
    // ── CTL-2070: the TIMELY per-ticket actor source (fleet write-ledger). ────────────────────
    // Default ON; only an explicit "off" disables it (same ethos as the dispatch veto above).
    const laneClaimTimelyEnabled =
      String(process.env.CATALYST_LANE_CLAIM_TIMELY_SOURCE ?? "")
        .trim()
        .toLowerCase() !== "off";
    // Recency bound (seconds): env override > Layer-1 catalyst.orchestration.laneClaim
    // .timelyRecencySeconds > default 300. Beyond this window the (now-caught-up) issue_history
    // ladder governs, so the new REFUSE is bounded to the exact claim-to-dispatch window.
    let laneClaimRecencySeconds = 300;
    const laneClaimRecencyEnv = Number(process.env.CATALYST_LANE_CLAIM_TIMELY_RECENCY_SECONDS);
    if (Number.isFinite(laneClaimRecencyEnv) && laneClaimRecencyEnv > 0) {
      laneClaimRecencySeconds = laneClaimRecencyEnv;
    } else {
      try {
        const cfg = JSON.parse(laneClaimReadFile(configPath));
        const fromCfg = cfg?.catalyst?.orchestration?.laneClaim?.timelyRecencySeconds;
        if (Number.isFinite(fromCfg) && fromCfg > 0) laneClaimRecencySeconds = fromCfg;
      } catch {
        /* no Layer-1 override → keep the default */
      }
    }
    const laneClaimRecencyMs = laneClaimRecencySeconds * 1000;
    // Seed the durable write-ledger singleton at boot. Prune window is a comfortable multiple of
    // the recency bound (entries stay well past the window that can act on them, but the file is
    // still bounded to roughly one entry per recently-moving ticket).
    let laneClaimLedgerEntries = 0;
    if (laneClaimTimelyEnabled) {
      try {
        const loaded = loadLaneClaimLedger(undefined, {
          maxAgeMs: laneClaimRecencyMs * 4,
          nowMs: Date.now(),
        });
        laneClaimLedgerEntries = loaded?.size ?? 0;
      } catch {
        /* a ledger load failure must not block boot — the guard degrades to CTL-2068 */
      }
    }
    const laneClaimGuardInstance = buildLaneClaimGuard({
      stateMap: laneClaimStateMap,
      stateMapForTicket: laneClaimStateMapForTicket,
      botUserIds: linearBotUserIds,
      readLastStateChange: replicaReader ? (t) => replicaReader.lastStateChange(t) : undefined,
      readCurrentState: replicaReader ? (t) => replicaReader.lookup(t)?.state ?? null : undefined,
      readFleetSeen: replicaReader ? (t, ids) => replicaReader.fleetEverWroteState(t, ids) : undefined,
      dispatchVeto: laneClaimDispatchVeto,
      // CTL-2070 — the timely source. When disabled, readFleetWrite is left undefined so the
      // guard is EXACTLY CTL-2068 (the timely block is a no-op on `fleetWrite === undefined`).
      readFleetWrite: laneClaimTimelyEnabled ? (t) => readLaneClaimFleetWrite(t) : undefined,
      readCurrentUpdatedAt:
        laneClaimTimelyEnabled && replicaReader ? (t) => replicaReader.currentUpdatedAt(t) : undefined,
      nowMs: () => Date.now(),
      recencyMs: laneClaimRecencyMs,
    });
    setLaneClaimGuard(laneClaimGuardInstance);
    // ⛔ CTL-2068 (Codex P2): `ranked_states` is the guard's OWN rank size, never the raw
    // map's key count. buildStateRank deliberately drops todo/backlog/triage/done, so a map
    // carrying only those keys counts nonzero while the rank is EMPTY — and the healthy INFO
    // line would print over a guard that can never refuse. That is exactly the false-healthy
    // this commit exists to expose, one level in.
    const laneClaimFields = {
      ranked_states: laneClaimGuardInstance.rank.size,
      state_map_source: laneClaimStateMapSource,
      registry_teams: laneClaimTeamPaths.size,
      history_source: replicaReader ? "replica" : "none",
      dispatch_veto: laneClaimDispatchVeto,
      // CTL-2070: report the TIMELY source truthfully — the loaded ledger ENTRY COUNT, not merely
      // "enabled" (the CTL-2068 ranked_states false-healthy lesson: count what the guard can
      // actually use). A fresh host reads `write-ledger` / 0 until the daemon writes a transition.
      timely_source: laneClaimTimelyEnabled ? "write-ledger" : "off",
      ledger_entries: laneClaimLedgerEntries,
    };
    if (laneClaimFields.ranked_states === 0) {
      log.warn(
        laneClaimFields,
        "ctl-2068: lane-claim guard installed but INERT — no rankable state map resolved, it can never refuse"
      );
    } else {
      log.info(laneClaimFields, "ctl-2068: lane-claim guard installed");
    }

    // CTL-2076: a registry entry whose repoRoot declares a DIFFERENT teamKey makes
    // the lane-claim guard abstain (UNRANKED_CURRENT) for every ticket of that team.
    // doctor's registry-team-identity (CAT-52) already WARNs, but only in an advisory
    // section it never FAILs on — so put it on the unified event log too, where the
    // broker/HUD/orch-monitor/Loki (a lane and a human) actually read. Best-effort:
    // defaultAppendOperatorEvent never throws.
    try {
      for (const evt of buildTeamIdentityMismatchEvents(laneClaimProjects)) {
        defaultAppendOperatorEvent(evt);
        log.warn(evt.payload, "ctl-2076: registry entry declares a different Linear team (CAT-52)");
      }
    } catch {
      /* best-effort — a mismatch scan must never block boot */
    }

    const commentInboxWriter = createCommentInboxWriter(orchDir, linearBotUserIds);
    // CTL-1654 (Codex P2 "gate the daemon before starting actuators"): resolve the
    // node class BEFORE arming the actuators, and arm the monitor + scheduler ONLY on
    // a worker node. Previously the node-class guard ran AFTER monitorFn()/schedulerFn()
    // and only suppressed the heartbeat — so a mis-launched exec-core on a monitor/
    // developer node (a direct `catalyst-execution-core start`, or an old launcher)
    // still armed the dispatch + recovery actuators, and suppressing the heartbeat did
    // not make it observation-only. cmd_start already refuses to start exec-core off a
    // worker (the primary control); this is the defense-in-depth backstop that makes the
    // daemon genuinely observe-only when that control is bypassed. The process stays UP
    // (visibly refusing — WARN in logs + verify-node's exec-core-stopped catches it)
    // rather than crash-looping under launchd.
    const { class: _nodeClass } = nodeClassResolver();
    const _isWorkerNode = _nodeClass === "worker";
    if (!_isWorkerNode) {
      log.warn(
        { nodeClass: _nodeClass },
        `execution-core launched on node.class=${_nodeClass} — observe-only: the ` +
        `monitor + scheduler actuators are NOT armed and no heartbeat/liveness is ` +
        `emitted (dispatch AND recovery are inert). cmd_start should not have started ` +
        `exec-core here (CTL-1654).`
      );
    }

    // CTL-1365a/b: executor + dispatchFn + dispatchMode + commentWakeDispatch are
    // resolved ONCE above (before reconcileBoot) and threaded into all four dispatch
    // entry points. The monitor receives dispatchFn for its →Triage one-shot, and
    // the onComment callback routes comment-wakes through commentWakeDispatch (the
    // same executor) — no split-brain.
    // CAT-40: sample the GitHub core REST quota independently of board scans. The
    // rate_limit endpoint does not consume the quota it reports; the timer only
    // publishes a snapshot and board-health separately decides shadow/enforce.
    //
    // Codex P1 (round 2): this MUST be armed — and primed — before schedulerFn
    // below, which runs a synchronous initial board-health pass. Arming only the
    // interval left that first pass with no snapshot, so under
    // CATALYST_BH_GH_QUOTA=enforce it advanced the board-health throttle while
    // quota read `unknown`; with the scheduler's own timer registered first the
    // blind window could span two scans (~10 min) on a host that had in fact been
    // sampling all along. `primeImmediately` samples inline, so by the time the
    // scheduler's first pass reads github-quota.json the snapshot is there.
    // Sampling is host-local observation, not actuation, so it stays OUTSIDE the
    // _isWorkerNode gate — a monitor node publishes its own quota too.
    {
      const githubQuotaCfg = readGithubQuotaSweepConfig(configPath);
      _githubQuotaTimer = startGithubQuotaTimerFn({
        enabled: githubQuotaCfg.enabled ?? true,
        intervalSeconds: githubQuotaCfg.intervalSeconds ?? GITHUB_QUOTA_TIMER_DEFAULTS.intervalSeconds,
        orchDir,
        primeImmediately: true,
      });
    }

    // CTL-1654: the actuator arming below (monitorFn + schedulerFn + auto-tuner) is
    // gated on _isWorkerNode — see the observe-only backstop comment above.
    // CAT-29 (Codex P1): the dependency quarantine joins the CTL-1654 node-class gate —
    // same actuator seam, same observe-only outcome. A node whose boot dependencies are
    // unusable arms neither the monitor nor the scheduler, so it cannot dispatch or
    // reclaim work it has no way to execute.
    if (_isWorkerNode && bootDependencyState.ok) {
    // CTL-1847: arm the cloud-feed dispatch source. Default mode is "off", in
    // which case NO gate is installed (monitor.mjs's `_cloudFeedGate` stays
    // null and its routing block is skipped entirely) and NO producer timer is
    // started — so merging this into the live dispatch path is a no-op on every
    // host until an operator opts in.
    //
    // Installed BEFORE monitorFn so the gate is in place before the tail's
    // first drain; arming it after would leave a window in which enforce-mode
    // smee events dispatched normally, which is exactly the double-dispatch the
    // gate exists to prevent.
    const cloudFeedCfg = readCloudFeedConfig();
    if (cloudFeedCfg.mode !== "off") {
      const cloudFeedCapture = createCaptureSink({ path: defaultCapturePath(orchDir) });
      // Timer FIRST, gate second: until `isReady()` says the producer has
      // completed a real, non-seeding sweep over a HEALTHY feed (Codex P1 #3439;
      // CTL-1902 replaced writer-liveness with feed health), enforce keeps smee
      // authoritative. setInterval does not fire immediately, so nothing is
      // produced between these two statements.
      // ⚠️ Since CTL-1901 `isReady` governs the SMEE side only — a feed event
      // carries its own emission-time authority stamp and is never re-judged
      // against a later reading of this flag.
      _cloudFeedTimer = startCloudFeedTimer({
        mode: cloudFeedCfg.mode,
        intervalSec: cloudFeedCfg.intervalSec,
        orchDir,
        botUserIds: linearBotUserIds,
      });
      setCloudFeedGate({
        mode: cloudFeedCfg.mode,
        capture: cloudFeedCapture,
        // Absent probe ⇒ NOT ready, so a wiring mistake here keeps smee
        // authoritative rather than suppressing it with nothing to replace it.
        isReady: _cloudFeedTimer ? () => _cloudFeedTimer.isReady() : null,
        // CTL-1891's ring has no production RECORDER yet (the CTC-509 proxy
        // caller is CTL-1889), so passing it here would wire a check that can
        // never fire and read as protection we do not have. Left null until the
        // recorder lands; decideDispatch treats an absent probe as "not an
        // echo", which is the pre-ring behaviour.
        isEcho: null,
      });
      log.info(
        {
          mode: cloudFeedCfg.mode,
          intervalSec: cloudFeedCfg.intervalSec,
          capture: cloudFeedCapture.path,
          armed: false,
        },
        "cloud-feed: armed",
      );
    }
    // CTL-1929: the GitHub leg's producer tick.
    //
    // ⛔ READS FROM ITS OWN KNOB. `CATALYST_GITHUB_FEED` is separate from
    // `CATALYST_CLOUD_FEED`, which every worker already runs at `enforce` — sharing
    // the value would have enforced the GitHub leg on every host the moment this
    // merged. The two legs cut over independently or they cut over recklessly.
    //
    // ⚠️ AND THERE IS STILL NO `setGithubFeedGate` CALL HERE, WHICH IS NOT AN
    // OVERSIGHT. The Linear gate lives in this process because `monitor.mjs` — its
    // consumer — is in this process. The `github.*` consumer is `broker/tailer.mjs`
    // → `broker/router.mjs`, a SEPARATE process, so the GitHub gate is installed
    // there (`broker/index.mjs`, via `github-feed-gate-install.mjs`) and readiness
    // reaches it through the file `github-feed-ready.mjs` defines rather than through
    // a closure. Installing a second gate here would be a second authority path the
    // real consumer does not share.
    //
    // So on every host until an operator sets the flag, this block constructs
    // nothing and routing is byte-identical to pre-CTL-1929.
    const githubFeedCfg = readGithubFeedConfig();
    if (githubFeedCfg.mode !== "off") {
      _githubFeedTimer = startGithubFeedTimer({
        mode: githubFeedCfg.mode,
        intervalSec: githubFeedCfg.intervalSec,
        orchDir,
        dbPath: getReplicaDbPath(),
        eventLogPath: getEventLogPath(),
        appendFn: (path, line) => appendFileSync(path, line),
        logger: log,
      });
      log.info(
        {
          requested: _githubFeedTimer?.mode?.requested ?? githubFeedCfg.mode,
          effective: _githubFeedTimer?.mode?.effective ?? null,
          degraded: _githubFeedTimer?.mode?.degraded ?? false,
          intervalSec: githubFeedCfg.intervalSec,
          gate: "installed in the BROKER process (github-feed-gate-install.mjs), not here",
          readyPath: _githubFeedTimer?.readyPath ?? null,
          residual: _githubFeedTimer?.mode?.reason ?? null,
        },
        "github-feed: armed",
      );
    }

    // CTL-1889: the Linear write-proxy transport. Same posture as the cloud-feed
    // block above — `off` (the default) constructs nothing, so linear-write.mjs's
    // module-level install stays null and every Linear write in this process is
    // byte-identical to pre-CTL-1889.
    const writeProxyCfg = readLinearWriteProxyConfig();
    if (writeProxyCfg.mode !== "off") {
      const writeProxy = createLinearWriteProxy({
        mode: writeProxyCfg.mode,
        routes: writeProxyCfg.routes,
      });
      setLinearWriteProxy(writeProxy);
      // The resolver is installed only for `enforce`: shadow never builds a payload
      // (see routeThroughProxy), so opening a replica handle for it would be a handle
      // held open for a code path that cannot run.
      if (writeProxyCfg.mode === "enforce") setLinearWriteProxyResolver(createProxyResolver());

      // ── CTL-1943: narrate each dispatched phase as a Linear agent session ──
      //
      // Only in ENFORCE, and for the same reason the resolver above is: the narrator
      // needs a resolved issue UUID, and shadow deliberately builds no payload and makes
      // no cloud call. Installing it in shadow would open a replica handle for a path
      // that cannot run.
      //
      // ⚠️ It gets its OWN resolver handle rather than sharing the write path's. They are
      // read-only SQLite handles onto the same replica, and `createProxyResolver` closes
      // over one lazily-opened connection; sharing would couple this route's lifetime to
      // the write path's `close()`.
      if (writeProxyCfg.mode === "enforce") {
        setAgentSessionNarrator(
          createAgentSessionNarrator({
            proxy: writeProxy,
            resolver: createProxyResolver(),
            log,
          }),
        );
      }
      log.info(
        {
          mode: writeProxyCfg.mode,
          baseUrl: writeProxy?.baseUrl ?? null,
          account: writeProxy?.account ?? null,
          routesOverridden: writeProxyCfg.routes ? Object.keys(writeProxyCfg.routes) : [],
        },
        "linear-write-proxy: armed",
      );
    }
    monitorFn({
      orchDir,
      cache,
      dispatch: dispatchFn, // CTL-1365a: →Triage one-shot dispatch substrate (bg today)
      dispatchMode, // CTL-1367 P1: gate the SDK-occupancy term in the →Triage budget (no-op under bg)
      hasInProcessRoute, // CTL-1457 (N1): also arm the →Triage SDK-occupancy term when a per-phase route runs in-process on a bg node
      concurrency, // CTL-716: slot-gate uses the same ceiling as the scheduler
      botUserIds: linearBotUserIds, // CTL-781: respect-assignment gate
      botWriteId: linearBotWriteId, // CTL-781: self-assign on claim
      gateway: gatewayReader, // CTL-781: gateway-first assignee reads
      onComment: (parsed) => {
        commentInboxWriter(parsed); // CTL-749: write to inbox.jsonl for in-flight workers
        handleCommentWake(parsed, {
          orchDir,
          dispatch: commentWakeDispatch,
          removeLabel: defaultRemoveLabel,
          botUserId: linearBotUserIds,
          clearStall: defaultClearStall(orchDir, linearWrite),
        }); // CTL-549 + CTL-756 + CTL-1365b: re-dispatch parked tickets through the resolved executor; botUserId suppresses self-echo; CTL-1067: J3 stall-clear
      },
      onUpdate: createUpdateInboxWriter(orchDir, linearBotUserIds), // CTL-749
      // CTL-1397: inject the SAME mode-gated replica reader the scheduler uses
      // (constructed above, bun-only) so the monitor's board-list discovery
      // reconcile reads the local Catalyst-Cloud replica instead of `linearis
      // issues list` — immune to the shared Linear quota + the CTL-679 breaker.
      // undefined when the flag is off → the monitor falls to the linearis path.
      // Injecting here (not importing in monitor.mjs) keeps the Node broker's
      // monitor/recovery import path free of the bun:sqlite static import.
      eligibleReplica: replicaReader,
    }); // CTL-535 + CTL-565 + CTL-634 + CTL-549 + CTL-749 + CTL-716 + CTL-781 + CTL-1397
    // CTL-558: the scheduler writes Linear status via its default `writeStatus`
    // (linear-write.mjs) on every committed phase transition — no daemon wiring
    // needed; production uses the real module, tests inject fakes.
    schedulerFn({
      orchDir,
      cache,
      dispatch: dispatchFn, // CTL-1365a: scheduler pull-loop dispatch substrate (bg today)
      dispatchMode, // CTL-1365a: catalyst.dispatch.mode for the Tier-1 tick line + OTLP resource attr
      hasInProcessRoute, // CTL-1457 (N1): arm the scheduler occupancy gates when a per-phase route runs in-process on a bg node
      concurrency,
      configPath,
      layer2Path,
      botUserIds: linearBotUserIds, // CTL-781: respect-assignment gate
      botWriteId: linearBotWriteId, // CTL-781: self-assign on claim
      // CTL-671: arm the phantom worker-dir validity sweep + bg-liveness reader.
      // CTL-823: the sweep's existence probe consults the durable broker
      // descriptor store first (gateway-read.mjs) — a fresh not-removed
      // descriptor short-circuits "exists" with ZERO subprocess/Linear cost;
      // removed/absent/stale always fall through to the live read
      // (fresh-before-quarantine). Fail-open: any store failure behaves
      // exactly like the pre-gateway path.
      // Spread order matters: the daemon's reader is AUTHORITATIVE — callers
      // (the sweep passes { exec }) cannot accidentally drop it.
      classifyResolution: (identifier, opts = {}) =>
        classifyTicketResolution(identifier, { ...opts, gateway: gatewayReader }),
      // CTL-823: thread the reader to the scheduler's internal fetchState
      // injections (reclaim + terminal backstop) so the 60s state window is
      // live in production, not just in unit tests.
      gateway: gatewayReader,
      // CTL-1340: thread the read-replica reader (undefined unless the flag is
      // on) so the scheduler's per-signal terminal checks can resolve
      // terminal-ness from the local Catalyst-Cloud replica. undefined → inert.
      replica: replicaReader,
      isBgJobAlive,
      // CTL-1044: provide the production operator-event appender for the
      // scheduler's `appendIntentEvent` seam (scheduler.mjs:4300). Without this
      // the seam is null and the advance-shadow comparator's disagree/tick
      // events (beliefs/advance-shadow.mjs:177-198), CTL-936 intent.ineffective,
      // and executeEscalations emissions all silently no-op — the bug this fixes
      // (zero beliefs.* events ever reached the log despite the shadow window
      // running live on mini). The seam contract is a raw
      // { "event.name": string, payload: object } object, which does NOT fit
      // buildEventEnvelope's phase/action schema — hence the dedicated
      // operator-event envelope builder in recovery.mjs. startScheduler keeps
      // its null default (CTL-936 chose silence for legacy/tests).
      appendIntentEvent: defaultAppendOperatorEvent,
    }); // CTL-536 + CTL-634 + CTL-665 + CTL-671 + CTL-676 + CTL-678 + CTL-1044 — pull-loop scheduler (configPath + layer2Path enable per-tick Layer-1+Layer-2 re-read; appendIntentEvent wires operator telemetry to the event log)
    // CTL-684: start the side-car auto-tuner AFTER the scheduler so the
    // scheduler's first tick runs with the operator's current Layer-2 value
    // before any auto-tune adjustments. configPath + layer2Path are threaded
    // so the tuner can re-read the merged concurrency on every sample.
    _stopAutoTuner = startAutoTunerFn({ configPath, layer2Path });
    } // CTL-1654: end worker-only actuator gate (monitor + scheduler + auto-tuner)

    if (watchRegistry) {
      // Watch the execution-core dir for registry.json changes — the registry is
      // the single source of enrolled projects (CTL-582 D4). ensureState already
      // created the dir. registry.mjs writes the registry tmp+rename, so the
      // directory watch sees the rename; the filename filter ignores the noisy
      // state.json / cursor.json writes that share the directory.
      _watcher = watch(getExecutionCoreDir(), (_eventType, filename) => {
        if (filename !== null && filename !== "registry.json") return;
        // _debounceTimer is module-scoped so stopDaemon can cancel a pending
        // reconcile that would otherwise fire after teardown.
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => {
          log.info("execution-core daemon: registry changed — reconciling");
          try {
            reconcile();
          } catch (err) {
            // A reconcile failure means registry changes silently stop being
            // applied — newly registered projects are never picked up. Surface
            // it at error level with the full error, not a swallowed warning.
            log.error(
              { err },
              "execution-core daemon: reconcile failed — registry changes are NOT being applied"
            );
          }
        }, debounceMs);
      });
    }

    if (enableReaper) {
      startReaperAndTimer({
        orphanReaperConfig,
        worktreeRefreshConfig,
        stalePrRescueConfig,
        orphanPrSweepConfig,
        linearReconcileConfig,
        configPath,
        debounceMs,
        pollMs,
        orchDir,
        makeReaper,
      });
    }

    // CTL-650: start the push-based session wait-state watcher. Inside the same
    // try/catch so a throw triggers PID-file cleanup via stopDaemon.
    if (enableWaitWatcher) {
      _waitWatcher = startWaitWatcher({ intervalMs: readWaitWatcherConfig().intervalMs });
    }

    // CTL-685: start the per-worker memory sampler. Inside the same try/catch so
    // a throw triggers PID-file cleanup via stopDaemon.
    if (enableMemorySampler) {
      _memorySampler = startMemorySampler();
    }

    // CTL-1165 D5: start the pre-exhaustion fleet-health probe. EMIT-ONLY by
    // default (self-heal default OFF — first ship is a pure alert). Inside the
    // same try/catch so a throw triggers PID-file cleanup via stopDaemon. The
    // config is resolved WITH configPath (mirroring readOrphanReaperConfig) so
    // the documented Layer-1 catalyst.orchestration.fleetHealth knobs — enable,
    // thresholds, and selfHealEnabled — actually take effect in production, and
    // is passed to the probe so it reads the SAME resolved thresholds.
    const fleetHealthConfig = readFleetHealthConfig(configPath);
    if (enableFleetHealth ?? fleetHealthConfig.enabled) {
      _fleetHealthProbe = startFleetHealthProbe({ orchDir, config: fleetHealthConfig });
    }

    // CTL-1502: start the stuck-but-alive daemon watchdog. SHADOW by default
    // (detect + log would-restart; no restart until an operator flips to enforce).
    // Inside the same try/catch so a throw triggers PID-file cleanup via stopDaemon.
    // Config resolved WITH configPath so the Layer-1
    // catalyst.orchestration.daemonWatchdog knobs take effect, and passed to the
    // probe so it reads the SAME resolved thresholds.
    const daemonWatchdogConfig = readDaemonWatchdogConfig(configPath);
    if (enableDaemonWatchdog ?? daemonWatchdogConfig.enabled) {
      _daemonWatchdogProbe = startDaemonWatchdogProbe({ config: daemonWatchdogConfig });
    }

    // CTL-787: start the account-level rate-limit usage poller. Inside the same
    // try/catch so a throw triggers PID-file cleanup via stopDaemon.
    if (enableRatelimitPoller) {
      _ratelimitPoller = startRatelimitPoller();
    }

    // CTL-1654: _nodeClass / _isWorkerNode were resolved above (before the actuators)
    // so the same guard that skips arming the monitor + scheduler also gates the
    // heartbeat + liveness membership signals here. A monitor/developer node must NOT
    // emit node.heartbeat (the only dispatch-roster signal) — a node that never
    // heartbeats is shed from computeDispatchSurvivingRoster automatically, so even if
    // an actuator were reachable it would own no HRW slice. With CTL-1654's actuator
    // gate above, dispatch AND recovery are now inert on a non-worker node directly,
    // not merely emergently.
    // CTL-859: start the node-heartbeat emitter. Appends a node.heartbeat event
    // to the unified event log every HEARTBEAT_INTERVAL_MS so a future liveness
    // reader (readClusterHeartbeats) can detect a dead node by heartbeat
    // silence. ADDITIVE/dormant — pure observability, no behavior consumes it
    // yet. Inside the same try/catch so a throw triggers PID-file cleanup.
    // CTL-1654: gated on _isWorkerNode — a monitor/developer node must never
    // heartbeat (the heartbeat IS the dispatch-roster membership signal).
    if (enableHeartbeat && _isWorkerNode) {
      // CTL-1322: supply the live admission-state closure so each heartbeat carries
      // { accepting, holdReason, effectiveCapacity, activeWorkers } — computed from
      // the same gate source fns the scheduler enforces (orchDir + concurrency are
      // both in scope here). Fail-open: readAdmissionState never throws.
      _heartbeat = startHeartbeat({
        // CAT-29 (Codex P2): the dependency hold must return the FULL admission shape
        // — { accepting, holdReason, effectiveCapacity, activeWorkers }. The heartbeat
        // builder serializes this object unchanged, so returning only two fields
        // published a heartbeat missing the capacity/occupancy the readers expect.
        // Spread the real state (never throws) so activeWorkers stays truthful, then
        // force the hold: effectiveCapacity 0 is exactly what readAdmissionState
        // itself reports whenever accepting is false.
        admissionFn: () => bootDependencyState.ok
          ? readAdmissionState({ orchDir, concurrency })
          : {
              ...readAdmissionState({ orchDir, concurrency }),
              accepting: false,
              holdReason: BOOT_DEPENDENCY_HOLD_REASON,
              effectiveCapacity: 0,
            },
        boardReachableFn: () => {
          if (!bootDependencyState.ok) {
            return { reachable: false, blindTeams: listProjectsFn().length };
          }
          const projects = listProjectsFn();
          const blindTeams = projects.filter((p) => {
            const team = typeof p === "string" ? p : (p.team ?? p.key);
            const state = team ? getReconcileHealth(team) : null;
            return state?.consecutiveFailures > 0;
          }).length;
          return { reachable: projects.length === 0 || blindTeams < projects.length, blindTeams };
        },
        // CTL-1420 (#17): carry this host's in-flight tickets on every node.heartbeat
        // so a peer can read liveness + ownership from Loki (retiring the Linear
        // heartbeat attachment). Same local signal-scan source the publisher uses.
        inFlightTicketsFn: () => localInFlightTickets(getHostName(), { orchDir }),
        // CTL-1581: the running/dispatched SUBSET — the slot-occupancy signal
        // the Workers deck renders (in_flight also counts parked dirs, which
        // hold no slot).
        activeTicketsFn: () => localActiveTickets(getHostName(), { orchDir }),
        // CTL-1864: publish the SLOT count (liveCount + countYieldedOccupancy), not the
        // ticket count, so a peer's freeSlots matches this host's scheduler occupancy.
        // Reuses the SAME functions the scheduler's occupancy uses — cannot drift.
        activeSlotCountFn: () => localActiveSlotCount(getHostName(), { orchDir }),
        // CTL-1551: carry the live slot ceiling so a peer's monitor can render
        // per-host capacity from Loki (the Linear-anchor capacity transport is
        // retired in loki mode). Uses the SAME readMaxParallel chokepoint the
        // scheduler enforces (config-precedence + bounds), NOT the raw state.json
        // value — and RE-RESOLVES the Layer-1+Layer-2 concurrency per beat
        // (resolveBootConcurrency, the designed hot-reload entry point) so an
        // operator's live concurrency edit reaches peers without a restart,
        // matching the scheduler's own per-tick re-read. Fail-open: an invalid
        // result → attribute omitted.
        maxParallelFn: () =>
          readMaxParallel(orchDir, resolveBootConcurrency({ layer1Path: configPath, layer2Path })),
        // CAT-57 (Codex round 2, P1): carry this host's last phase-boundary advance on
        // node.heartbeat so board-health's nodeProductivity invariant is observable via
        // Loki. Uses the SAME computation the Linear-anchor publisher uses
        // (cluster-heartbeat-publisher.mjs), so the two transports cannot disagree about
        // what counts as an advance. Fail-open: a throw/invalid value omits the attribute.
        lastAdvanceAtFn: () => {
          try {
            return computeLastPhaseAdvanceTs(readAllPhaseSignals(orchDir), { self: getHostName() });
          } catch {
            return null;
          }
        },
      });
      // CTL-1090: cross-host liveness publisher (multi-host only; single-host no-op).
      // startLivenessPublisher self-gates on roster.length > 1, so this is always safe.
      _livenessPublisher = startLivenessPublisher({ orchDir });
    }

    // CTL-1274 + CTL-1393: cluster-repo auto-refresh. Refresh the catalyst-cluster
    // clone at boot (clusterSync = pull + decrypt secrets + seed the change-detection
    // marker) and then on a periodic timer (refreshClusterSecretsIfChanged = pull +
    // re-decrypt ONLY when the clone's HEAD moved with a secrets/ change). A roster
    // change committed on one node (cluster cli) still propagates — the next scheduler
    // tick re-reads cluster.json.roster — and now a ROTATED SECRET also re-materializes
    // on this running daemon without a manual restart (the CTL-1393 silent-stale fix).
    // FAIL-OPEN: both calls swallow errors and return a status object (never throw);
    // the extra try/catch here is belt-and-suspenders so a cluster-sync hiccup can
    // NEVER abort daemon boot or wedge a timer tick. Refresh is a no-op ("no-head")
    // when no clone exists, and skips the sops spawn entirely when HEAD is unchanged.
    if (enableClusterSync) {
      // CTL-1612: the BOOT sync moved earlier (before the boot-resume dispatches, so
      // resumed workers never inherit a stale credential). Only the periodic refresh
      // is armed here, alongside the other timers.
      _clusterSyncTimer = setInterval(() => {
        try {
          refreshClusterSecrets();
        } catch (err) {
          log.warn({ err: err?.message }, "cluster-sync timer: refresh threw (continuing)");
        }
        // CTL-1892: re-resolve the self-echo identity set on the SAME tick and for the
        // SAME reason as the credential re-arm below — an app-actor rotated while this
        // daemon is running is otherwise invisible until a restart, and that live
        // window is exactly what this guard exists to close. Merges in place
        // (monotonic), so the closures already holding the Set observe the new id.
        try {
          const addedIdentities = refreshBotIdentities();
          if (addedIdentities.length) {
            log.info({ added: addedIdentities }, "self-echo identity set extended (app-actor rotation)");
          }
        } catch (err) {
          log.warn({ err: err?.message }, "cluster-sync timer: identity refresh threw (continuing)");
        }
        // CTL-1612: re-arm from disk on EVERY tick, unconditionally. Without this the
        // whole fix is boot-only: a credential rotated at 03:00 on a daemon that booted at
        // 00:00 stays dead until a human restarts it, and we would merely have converted a
        // silent failure into a loud one that still needs hands. Deliberately NOT gated on
        // the refresh result — refreshClusterSecretsIfChanged short-circuits on
        // `head-unchanged` without re-reading the file, and the rotation may also have been
        // materialized by the OTHER writer (cluster-sync at boot, or an operator). The call
        // is a cheap local read, no-ops when the value is unchanged, and never throws.
        // CTL-1623: routed through armSecret (same hook, registered above) — see the
        // boot-time call site's comment for why this isn't a second rearmGithubTokenFromFile
        // call. No surrounding try/catch: armSecret itself never throws (it wraps the
        // registered hook call in its own try/catch and returns the quiet
        // {armed:false,...} triple on failure — see secret-contract.mjs's armSecret), and
        // the hook closure (rearmGithubTokenFromFile) already logs+swallows its own errors
        // via `log`. A wrapping try/catch here would only ever imply protection the callee
        // already provides.
        armSecret("github-token", { env: process.env });
        // CTL-1984: re-arm the account-slot token on the same tick. armSecret never throws;
        // the hook closure (rearmClaudeAccountsFromFile) logs+swallows its own errors.
        armSecret("claude-accounts.env", { env: process.env });
        // CTL-1786: keep this node entitled with the lease authority on the same cadence, so a
        // claim's not_entitled refusal is a rare self-healing edge, not the steady state. Cached
        // + fail-open (see refreshLeaseEntitlement); a strict no-op when the gate is off.
        refreshLeaseEntitlement();
      }, clusterSyncIntervalMs);
      _clusterSyncTimer.unref?.();
    }

    // CTL-1608: start the periodic stalled-PR detection sweep (review/CI/no-push),
    // independent of worker liveness. Read-only gh probing → safe in all modes;
    // board-health owns actuation. Default-off until validated on the live board.
    {
      const stalledCfg = stalledPrSweepConfig ?? {};
      if (stalledCfg.enabled === true) {
        _stalledPrTimer = startStalledPrTimerFn({
          enabled: true,
          intervalSeconds: stalledCfg.intervalSeconds ?? STALLED_DEFAULTS.intervalSeconds,
          orchDir,
          config: stalledCfg,
        });
      }
    }

  } catch (err) {
    stopDaemon();
    throw err;
  }

  // CTL-854: a fresh/headless host whose registry was never written boots a
  // perfectly healthy-looking daemon that dispatches NOTHING. Surface it once
  // at startup (not per-reconcile) with the recovery verb so the operator has
  // an actionable signal rather than a silent idle daemon.
  try {
    if (listProjectsFn().length === 0) {
      log.warn(
        { registry: getRegistryPath() },
        "execution-core daemon: registry has 0 projects — nothing will be dispatched. " +
          "Enroll a project: `catalyst-execution-core register --team <TEAM> --repo-root <path>`"
      );
    }
  } catch (err) {
    log.warn({ err }, "execution-core daemon: registry health check failed (continuing)");
  }

  // CTL-862 / CTL-1271: resolve + ANNOUNCE the cluster roster at boot. The
  // daemon partitions work by this roster, so it must state what it resolved AND
  // where that came from — and NEVER silently degrade to a one-node cluster (the
  // bug that quietly evicted mini-2). resolveClusterHosts returns the single
  // precedence (anchor → static → hosts-fallback → single-host) shared with
  // getClusterHosts, so the boot announcement can never disagree with what the
  // scheduler actually uses.
  //
  // bootHosts (the CTL-862 ownership-log test seam) wins when injected; bootResolve
  // is the CTL-1271 seam for asserting source/multiHost; otherwise resolve for real.
  const resolved =
    bootResolve ??
    (bootHosts
      ? { hosts: bootHosts, source: "injected", multiHost: bootHosts.length > 1 }
      : resolveClusterHosts());
  const bootRoster = resolved.hosts;
  const bootSource = resolved.source;
  const bootMultiHost = resolved.multiHost;
  // CTL-1093: resolve sticky/pinned identity before computing bootSelf so
  // every downstream emitter and child sees the converged coordination name.
  // Feeds off the CTL-1271 roster resolution above (bootMultiHost) so the
  // identity decision and the boot announcement share one source of truth.
  const _stickyDir = getCatalystRepoDir();
  const _ident = resolveBootIdentity({
    pinned: isHostNamePinnedFromConfig(),
    resolvedName: bootHostName ?? getHostName(),
    sticky: readStickyIdentity({ dir: _stickyDir }),
    multiHost: bootMultiHost,
  });
  if (_ident.warning) log.warn({ host: _ident.name, roster: bootRoster }, _ident.warning);
  if (_ident.action === "record" || _ident.action === "restore") {
    writeStickyIdentity({ dir: _stickyDir, name: _ident.name });
  }
  // Inject into env so phase-agent-dispatch (child process) inherits the pinned name
  // via CATALYST_HOST_NAME → catalyst_host_name (host-identity.sh). Only set when
  // not already env-pinned so an explicit operator override always wins and the
  // intentional per-tick getHostName() Layer-2 re-read is preserved. CTL-1093.
  if (_ident.action !== "noop" && !process.env.CATALYST_HOST_NAME) {
    process.env.CATALYST_HOST_NAME = _ident.name;
  }
  const bootSelf = _ident.action === "noop" ? (bootHostName ?? getHostName()) : _ident.name;
  const bootEligible = readAllEligible();
  const bootOwns = bootEligible.filter((t) => ownedBy(t.identifier, bootRoster, bootSelf)).length;

  // CTL-1271: a multi-host configuration that resolves to a single-host roster is
  // a SILENT eviction — every peer drops out of HRW and this node owns the whole
  // fleet's work. Detect "multi-host was EXPECTED" (an anchor or a static roster
  // is configured) but the resolution yielded single-host, and warn LOUDLY (not a
  // hard refuse — a transient Linear blip must not block boot; FAIL-OPEN already
  // kept the prior roster on the read seam). A legitimately single-host install
  // (no anchor, no static) stays SILENT — single-host is a valid, expected state.
  const anchorConfigured = Boolean(getLivenessAnchorIssue());
  const staticConfigured = Boolean(getStaticRoster());
  const multiHostExpected = anchorConfigured || staticConfigured;
  if (multiHostExpected && !bootMultiHost) {
    log.warn(
      {
        roster: bootRoster,
        source: bootSource,
        anchorConfigured,
        staticConfigured,
        host: bootSelf,
      },
      "execution-core daemon: multi-host was configured (cluster anchor / static roster) " +
        "but the roster resolved to a SINGLE host — this node will own the ENTIRE fleet's " +
        "work under HRW. Check the cluster anchor is reachable and enrolled " +
        "(`catalyst cluster status`)."
    );
  }
  // CTL-1084: emit a structured node.boot event so catalyst-stack status can
  // prove what the restart did (version, effective flags, adopted/cleared/rewalk counts).
  // Fail-open — emitBootEvent never throws. Kept alongside the pino log (not replacing it).
  emitBootEvent({
    summary: {
      adoptedWorkers: _bootReport?.workers?.running?.length ?? 0,
      zombiesCleared:
        (_bootReport?.workers?.dead?.length ?? 0) + (_bootReport?.workers?.unknown?.length ?? 0),
      rewalkPlanned: _bootResume?.planned ?? _bootResume?.dispatched ?? 0,
      rewalkDispatched: _bootResume?.dispatched ?? 0,
    },
  });
  // CTL-1552: record which config LAYER each governance knob resolved from
  // (env-override / config / default) at boot, so an operator can tell at a
  // glance whether e.g. board-health enforce came from the host env or Layer-2 —
  // previously only the beliefs booleans' sources were legible. effectiveFlags
  // carries the resolved mode values; flagSources carries the layer each came
  // from (now including boardHealth/recoveryPass/unstuckSweep/deadDocWorker).
  // Fail-open — the boot self-report must never block startup.
  try {
    log.info(
      { effectiveFlags: readGovernanceConfig(), flagSources: readGovernanceSources() },
      "execution-core daemon: governance flags resolved (value ← layer)",
    );
  } catch {
    /* best-effort boot self-report */
  }
  // CTL-1271: announce roster + source + multiHost at boot so an operator can
  // always read what the daemon resolved and where it came from.
  log.info(
    {
      orchDir,
      host: bootSelf,
      owns: bootOwns,
      eligible: bootEligible.length,
      roster: bootRoster,
      source: bootSource,
      multiHost: bootMultiHost,
    },
    "execution-core daemon started"
  );
}

// startReaperAndTimer — wire the Reaper (CTL-649 Phase 4) and the periodic
// orphan-reaper timer (CTL-649 Phase 9) into the daemon. The reaper consumes
// `*.reap-requested` lines appended to the canonical event log by yielding
// workers, supersede paths, abort-worker, and PR-merged cleanup — and runs
// the appropriate executor for each.
//
// Boot replay is best-effort: if it throws, log and continue with live
// consumption only.
function startReaperAndTimer({
  orphanReaperConfig,
  worktreeRefreshConfig,
  stalePrRescueConfig,
  orphanPrSweepConfig,
  linearReconcileConfig,
  configPath,
  debounceMs,
  orchDir,
  // CTL-769: poll-fallback interval. Defaults to TAILER_POLL_INTERVAL_MS
  // (env-tunable via EXECUTION_CORE_TAILER_POLL_MS); injectable so tests can
  // drive the drain on a tiny interval deterministically.
  pollMs = TAILER_POLL_INTERVAL_MS,
  // CTL-769: reaper factory seam. Defaults to the real Reaper; injectable so a
  // test can observe that the poll-fallback timer (not an fs.watch event)
  // dispatched a reap-requested line into reaper.handle().
  makeReaper = (opts) => new Reaper(opts),
}) {
  const eventLogPath = getEventLogPath();
  // CTL-649: the periodic sweep honors the configured recency floor
  // (minIdleSeconds, default 900s). includeInteractive stays at its safe
  // default false — the daemon never opts into reaping human sessions.
  // CTL-661: bind the per-ticket reconciler's canonical-owner reader to this
  // daemon's orchDir so the sweep resolves the authoritative active-phase
  // bg_job_id (falling back to newest-by-last_seen when no signal is found).
  // CTL-1165 D2: construct the production orphan child-process reaper and inject
  // it into the Reaper. DEFAULT mode:"shadow" (emits procOrphans.would-reap, kills
  // NOTHING) so the allowlist + LIVE_TREE correlation bakes on mini before any
  // enforce flip — exactly like stall-janitor (CTL-1004) and cost-cap (CTL-1137).
  // mode/graceMs/worktreeRoot/allowlistPatterns come from
  // orphanReaper.procReaper; the daemon's own pid is on the never-kill list
  // (selfPid defaults to process.pid; broker/monitor are covered by the argv
  // allowlist patterns). A disabled config ("off") makes every sweep an empty
  // no-op.
  // CTL-1531: `widenMode` is a SEPARATE knob from `mode`. The widened
  // any-command orphan class ships dark (shadow) on its own three-state gate, so
  // a host already carrying procReaper.mode:"enforce" — granted for the narrow
  // node/bun class after ITS shadow bake — does not silently inherit authority
  // to SIGTERM an arbitrary PPID-1 command. Flipping it is operator-owned
  // (ADR-023), exactly like the .sh side's SWEEP_PROC_WIDEN.
  const procCfg = orphanReaperConfig?.procReaper ?? {};
  const procReaper = new ProcReaper({
    mode: procCfg.mode ?? "shadow",
    widenMode: procCfg.widenMode ?? "shadow",
    // CTL-1531 round 2: per-run cap on WIDENED confirmed terminations, mirroring
    // orphan-sweep.sh's SWEEP_PROC_WIDEN_MAX_KILLS. Omitted ⇒ the module default
    // (5); a non-numeric value is rejected by the constructor, not by an
    // arithmetic accident that silently uncaps a process killer.
    // Pass through ONLY a real, finite NUMBER. readOrphanReaperConfig just parses
    // JSON with no schema validation, so `""`, `false` and `[]` all reach here —
    // and each `Number()`s to 0, which the constructor accepts as the INTENTIONAL
    // "uncapped" setting. The eager coercion therefore DEFEATED the constructor's
    // own type guard, and a malformed config value silently removed the widened
    // kill ceiling instead of degrading to the documented default of 5.
    //
    // Explicit numeric 0 is preserved: the constructor documents it as a real
    // operator choice ("uncapped"), so this must reject typos WITHOUT taking away
    // that escape hatch. Non-numbers are omitted so the default applies.
    ...(typeof procCfg.widenMaxKills === "number" && Number.isFinite(procCfg.widenMaxKills)
      ? { widenMaxKills: procCfg.widenMaxKills }
      : {}),
    // CTL-1531 (Codex P2): a malformed value must fall back to the DEFAULT, never
    // reach the reaper as NaN. `Number("bad")` is NaN, and the age gate in
    // proc-reaper.mjs is `etimeSec < minEtimeSec` — which is FALSE for every process
    // when the right side is NaN. So one typo'd config field silently removed the
    // 900-second teardown-safety floor and made even a one-second-old arbitrary
    // command killable by the widened path. Omitting the key lets the reaper's own
    // documented default stand, which is the whole point of a floor.
    // Test the RAW type — never coerce. `Number()` maps `false`, `""` and `[]` all to
    // 0, so a coercing guard accepts every one of them as a legitimate floor of zero
    // and disables the 900-second protection just as surely as the NaN case did. Only
    // a real number is a real threshold; anything else falls through to the reaper's
    // documented default. This matches the `widenMaxKills` guard above rather than
    // inventing a second, weaker convention for the same kind of field.
    ...(typeof procCfg.graceMs === "number" &&
    Number.isFinite(procCfg.graceMs) &&
    procCfg.graceMs >= 0
      ? { graceMs: procCfg.graceMs }
      : {}),
    ...(typeof procCfg.minEtimeSec === "number" &&
    Number.isFinite(procCfg.minEtimeSec) &&
    procCfg.minEtimeSec >= 0
      ? { minEtimeSec: procCfg.minEtimeSec }
      : {}),
    ...(procCfg.worktreeRoot ? { worktreeRoot: procCfg.worktreeRoot } : {}),
    ...(Array.isArray(procCfg.allowlistPatterns)
      ? { allowlistPatterns: procCfg.allowlistPatterns }
      : {}),
    daemonPids: [process.pid],
    log,
  });

  _reaper = makeReaper({
    minIdleMs: (orphanReaperConfig?.minIdleSeconds ?? 900) * 1000,
    readActivePhaseSignal: (ticket) => defaultReadActivePhaseSignal(orchDir, ticket),
    readSignalBgJobId: (ticket, phase) => defaultReadSignalBgJobId(orchDir, ticket, phase),
    // CTL-1218 Part A: thread the LIVE orchDir (~/catalyst/execution-core) as a
    // provenance root alongside the legacy ~/catalyst/runs/ dirs. Without this the
    // gate scans only listOrchDirs() and reads every daemon-created worktree as
    // "unknown-provenance" → defer forever. ...listOrchDirs() preserves legacy
    // orchestrator-created provenance detection.
    assessWorktreeRemoval: (event) =>
      defaultAssessWorktreeRemoval(event, undefined, [orchDir, ...listOrchDirs()]),
    procReaper,
  });

  // Boot replay: cover for any intents that landed while the daemon was down.
  _reaper.bootReplay(eventLogPath).catch((err) => {
    log.error({ err }, "reaper: bootReplay threw");
  });
  // Initialize the cursor to the current tail so the live-tail loop only
  // sees lines appended AFTER the replay completed. Reset the leftover too, or
  // a stale partial line from a previous daemon run would be stitched onto the
  // first live read.
  _eventLogLeftover = "";
  try {
    if (existsSync(eventLogPath)) _eventLogCursor = statSync(eventLogPath).size;
  } catch {
    _eventLogCursor = 0;
  }

  // fs.watch the events dir; on rename/change to the current month's file,
  // debounce-read the new tail and hand each parsed line to reaper.handle().
  const eventsDir = dirname(eventLogPath);
  const targetName = basename(eventLogPath);
  try {
    mkdirSync(eventsDir, { recursive: true });
    _eventWatcher = watch(eventsDir, (_evt, filename) => {
      if (filename !== null && filename !== targetName) return;
      clearTimeout(_eventDebounceTimer);
      _eventDebounceTimer = setTimeout(() => consumeEventTail(), debounceMs);
    });
  } catch (err) {
    log.error({ err }, "reaper: event-log watch failed — relying on boot replay only");
  }

  // CTL-769: fs.watch + debounce is perpetually reset by the continuously-
  // appended unified event log, so consumeEventTail only fires during >5s idle
  // gaps — the reaper starves exactly when workers are busy and predecessors
  // accumulate. Mirror the new-work tailer's poll fallback (monitor.mjs:684-685,
  // CTL-711): a cheap, idempotent, cursor-based poll drains reap-intents in ~2s
  // instead of waiting up to the 600s reconcile sweep.
  if (pollMs > 0) {
    _eventPollTimer = setInterval(() => consumeEventTail(), pollMs);
  }

  const cfg = orphanReaperConfig ?? {};
  // CTL-1165 D3: bind the real ~/.claude/jobs/<id> dir GC onto the same 600s
  // orphan-reaper cadence (no new daemon timer). Default-on; an operator can
  // disable via .catalyst → orphanReaper.jobGc.enabled:false. retention/batchCap
  // come from config (env still wins inside sweepJobDirs's defaults). A no-op
  // async closure is bound when disabled so the timer's Promise.all stays
  // uniform.
  const jobGcCfg = cfg.jobGc ?? {};
  const jobGcEnabled = jobGcCfg.enabled !== false;
  const jobGc = jobGcEnabled
    ? () =>
        sweepJobDirs({
          jobsRoot: getJobsRoot(),
          readAgents: () => listClaudeAgentsResult(),
          ...(jobGcCfg.retentionSeconds != null
            ? { retentionMs: Number(jobGcCfg.retentionSeconds) * 1000 }
            : {}),
          ...(jobGcCfg.batchCap != null ? { batchCap: Number(jobGcCfg.batchCap) } : {}),
        })
    : async () => {};
  // CTL-1205: bind the real execution-core/workers/<TICKET>/ dir GC onto the same
  // 600s orphan-reaper cadence (no new daemon timer). Default-on; disable via
  // .catalyst → orphanReaper.workerGc.enabled:false. retention/batchCap come from
  // config (env CATALYST_WORKER_GC_RETENTION_SECONDS / CATALYST_WORKER_GC_BATCH_CAP
  // still win inside sweepWorkerDirs's defaults).
  const workerGcCfg = cfg.workerGc ?? {};
  const workerGcEnabled = workerGcCfg.enabled !== false;
  const workerGc = workerGcEnabled
    ? () =>
        sweepWorkerDirs({
          orchDir,
          readAgents: () => listClaudeAgentsResult(),
          ...(workerGcCfg.retentionSeconds != null
            ? { retentionMs: Number(workerGcCfg.retentionSeconds) * 1000 }
            : {}),
          ...(workerGcCfg.batchCap != null ? { batchCap: Number(workerGcCfg.batchCap) } : {}),
        })
    : async () => {};
  // CTL-1218 Part C: bind the wt-cleanup-queue drain onto the same 600s cadence (no
  // new daemon timer). Default-on; disable via .catalyst → orphanReaper.wtCleanupDrain
  // .enabled:false. The drain reads ~/catalyst/wt-cleanup-queue/*.json, clears markers
  // for already-gone worktrees, and re-runs the CTL-791 gated teardown (NEVER --force)
  // for survivors — confirming merge first (fail-closed).
  const drainCfg = cfg.wtCleanupDrain ?? {};
  const drainEnabled = drainCfg.enabled !== false;
  const wtCleanupDrain = drainEnabled
    ? () =>
        sweepWtCleanupQueue({
          orchDir,
          ...(drainCfg.batchCap != null ? { batchCap: Number(drainCfg.batchCap) } : {}),
        })
    : async () => {};
  _orphanTimer = startOrphanReaperTimer({
    enabled: cfg.enabled !== false,
    intervalSeconds: cfg.intervalSeconds ?? 600,
    jobGc,
    workerGc,
    wtCleanupDrain, // CTL-1218
  });

  // CTL-707: start the periodic worktree-refresh timer.
  const refreshCfg = worktreeRefreshConfig ?? {};
  if (refreshCfg.enabled !== false) {
    _refreshTimer = startWorktreeRefreshTimer({
      enabled: true,
      intervalSeconds: refreshCfg.intervalSeconds ?? 300,
      quietSeconds: refreshCfg.quietSeconds ?? 30,
      orchDir,
    });
  }

  // CTL-1331: start the async board-health delegate runner timer. Gated by
  // CATALYST_DELEGATE_RUNNER — readDelegateRunnerConfig().mode resolves "off"
  // unless board-health is enforce, so Phase A is inert: startDelegateRunnerTimer
  // returns a no-op { stop } handle and nothing drains. When "on" (Phase B), the
  // timer kicks a DETACHED child each interval that does the heavy
  // worktree-provision + `claude --bg` off the daemon event loop. (Phase B also
  // wires CATALYST_EXECUTION_CORE_DIR onto the child spawn so the entry resolves
  // orchDir; until then a forced-on child fails safe — "no orchDir" → exit 0.)
  const delegateRunnerCfg = readDelegateRunnerConfig();
  _delegateRunnerTimer = startDelegateRunnerTimer({
    enabled: delegateRunnerCfg.mode === "on",
    intervalMs: delegateRunnerCfg.intervalMs,
    orchDir,
  });

  // CTL-782: start the periodic stale/conflicting-PR rescue timer.
  // No orchId / linearWrite threading needed: the timer derives the per-ticket
  // orchestrator id from the phase signal's `.orchestrator` (orchId === ticket
  // convention — the daemon has no global orch id), and defaults linearWrite
  // to the real linear-write module so escalations reach the needs-human queue.
  const rescueCfg = stalePrRescueConfig ?? {};
  if (rescueCfg.enabled !== false) {
    _stalePrRescueTimer = startStalePrRescueTimer({
      enabled: true,
      intervalSeconds: rescueCfg.intervalSeconds ?? RESCUE_DEFAULTS.intervalSeconds,
      orchDir,
      config: rescueCfg,
      // CTL-1609 (Codex P1): the delegate ceiling for this timer's escalation
      // enqueues. Resolved lazily per escalation (not captured at boot) so an
      // autotuned maxParallel is honored without a daemon restart. Injected here
      // because the daemon already owns concurrency — importing readMaxParallel
      // inside the timer would pull scheduler.mjs's bun:sqlite graph into it.
      maxParallel: () => readMaxParallel(orchDir),
    });
  }

  // CTL-1175: start the periodic orphan-PR detect+notify sweep timer.
  const orphanCfg = orphanPrSweepConfig ?? {};
  if (orphanCfg.enabled !== false) {
    _orphanPrSweepTimer = startOrphanPrSweepTimer({
      enabled: true,
      intervalSeconds: orphanCfg.intervalSeconds ?? ORPHAN_DEFAULTS.intervalSeconds,
      orchDir,
      config: orphanCfg,
    });
  }

  // CTL-1371: start the periodic PR→Linear state reconcile timer. OPT-IN
  // (default-off): unlike the read-only/notify twins above this can WRITE Linear
  // state, so it only starts when mode is explicitly 'notify' or 'write'. Runs on
  // the daemon event loop, fully separate from schedulerTick (cannot trip the
  // CTL-671 runaway guards). Ship 'notify' first; flip to 'write' once the
  // emitted drift events read clean.
  const reconcileCfg = linearReconcileConfig ?? {};
  const reconcileMode = reconcileCfg.mode ?? "off";
  if (reconcileMode === "notify" || reconcileMode === "write") {
    _linearReconcileTimer = startLinearReconcileTimer({
      enabled: true,
      mode: reconcileMode,
      intervalSeconds: reconcileCfg.intervalSeconds,
      orchDir,
      configPath,
      config: reconcileCfg,
    });
  }

}

// parseEventTailChunk — pure, deterministic split of a freshly-read byte chunk
// into complete JSON events plus the trailing partial line. CTL-673 moved the
// implementation to the leaf module event-tail.mjs (shared with event-scan.mjs
// and reaper.mjs). It is imported for consumeEventTail's local use AND
// re-exported here unchanged so daemon.test.mjs keeps importing it from daemon.mjs.
export { parseEventTailChunk };

// __resetEventTailCursorForTest — reset the module-level byte cursor + leftover
// so a test can drive consumeEventTail deterministically against a temp file
// from a known starting offset. Test-only; not used by production code.
export function __resetEventTailCursorForTest(cursor = 0, leftover = "") {
  _eventLogCursor = cursor;
  _eventLogLeftover = leftover;
}

// __getEventTailLeftoverForTest — inspect the carried partial line. Test-only.
export function __getEventTailLeftoverForTest() {
  return _eventLogLeftover;
}

// __getEventPollTimerForTest — inspect the CTL-769 poll-fallback interval handle
// so a test can pin its teardown directly (non-null while running, null after
// stopDaemon) instead of inferring it from drain side-effects, which the
// `_reaper = null` guard in stopDaemon would otherwise mask. Test-only.
export function __getEventPollTimerForTest() {
  return _eventPollTimer;
}

// consumeEventTail — read the NEW BYTES appended to the event log since the
// cursor last advanced (via a file descriptor, exactly like monitor.mjs's
// proven tailer), parse each complete line, and dispatch to the reaper.
//
// `path` and `reaper` are injectable for deterministic tests; production passes
// neither and falls back to the module-level event log + reaper instance.
export function consumeEventTail({ path = getEventLogPath(), reaper = _reaper } = {}) {
  if (!reaper) return;
  let fd;
  let size;
  try {
    fd = openSync(path, "r");
    size = fstatSync(fd).size;
  } catch {
    // Log file not yet created or a transient stat error — best-effort.
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* fd already gone */
      }
    }
    return;
  }

  if (size < _eventLogCursor) {
    // File rotated or truncated — restart from 0 and drop any partial line
    // stitched from the now-vanished bytes.
    _eventLogCursor = 0;
    _eventLogLeftover = "";
  }
  if (size === _eventLogCursor) {
    closeSync(fd);
    return;
  }

  let chunk;
  try {
    const newByteCount = size - _eventLogCursor;
    const buf = Buffer.alloc(newByteCount);
    readSync(fd, buf, 0, newByteCount, _eventLogCursor);
    closeSync(fd);
    chunk = buf.toString("utf8");
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      /* fd already gone */
    }
    log.error({ err }, "reaper: event-log read failed");
    return;
  }
  _eventLogCursor = size;

  const { events, leftover } = parseEventTailChunk(chunk, _eventLogLeftover);
  _eventLogLeftover = leftover;
  for (const event of events) {
    reaper.handle(event).catch((err) => {
      log.error({ err, event: event.event }, "reaper: handle threw");
    });
  }
}

// stopDaemon — tear down the watcher, the pending debounce, the composed
// monitor + scheduler, and the PID file. Idempotent and safe to call when
// nothing is running.
export function stopDaemon() {
  if (_watcher) {
    try {
      _watcher.close();
    } catch {
      /* watcher already closed */
    }
    _watcher = null;
  }
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (_stopMonitor) {
    try {
      _stopMonitor();
    } catch {
      /* monitor not running */
    }
  }
  if (_stopScheduler) {
    try {
      _stopScheduler();
    } catch {
      /* scheduler not running */
    }
  }
  // CTL-649: tear down reaper + orphan timer + event-log watcher.
  if (_eventWatcher) {
    try {
      _eventWatcher.close();
    } catch {
      /* already closed */
    }
    _eventWatcher = null;
  }
  if (_eventDebounceTimer) {
    clearTimeout(_eventDebounceTimer);
    _eventDebounceTimer = null;
  }
  if (_eventPollTimer) {
    clearInterval(_eventPollTimer);
    _eventPollTimer = null;
  }
  if (_livenessTimer) {
    clearInterval(_livenessTimer);
    _livenessTimer = null;
  }
  if (_orphanTimer) {
    try {
      _orphanTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _orphanTimer = null;
  }
  if (_refreshTimer) {
    try {
      _refreshTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _refreshTimer = null;
  }
  // CTL-1847: stop the cloud-feed producer tick and UNINSTALL the gate. Both,
  // not just the timer: a live gate with a dead producer would keep suppressing
  // smee in enforce mode while nothing replaced it — a silent total dispatch
  // outage, which is strictly worse than either half alone.
  if (_githubFeedTimer) {
    try {
      _githubFeedTimer.stop();
    } catch {
      /* best effort */
    }
    _githubFeedTimer = null;
  }
  if (_cloudFeedTimer) {
    try {
      _cloudFeedTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _cloudFeedTimer = null;
  }
  try {
    setCloudFeedGate(null);
  } catch {
    /* monitor module not loaded */
  }
  // CTL-1331: stop the delegate runner timer (no-op handle when gated off).
  if (_delegateRunnerTimer) {
    try {
      _delegateRunnerTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _delegateRunnerTimer = null;
  }
  if (_stalePrRescueTimer) {
    try {
      _stalePrRescueTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _stalePrRescueTimer = null;
  }
  if (_orphanPrSweepTimer) {
    try {
      _orphanPrSweepTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _orphanPrSweepTimer = null;
  }
  if (_linearReconcileTimer) {
    try {
      _linearReconcileTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _linearReconcileTimer = null;
  }
  if (_stalledPrTimer) {
    try {
      _stalledPrTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _stalledPrTimer = null;
  }
  if (_githubQuotaTimer) {
    try {
      _githubQuotaTimer.stop();
    } catch {
      /* timer already stopped */
    }
    _githubQuotaTimer = null;
  }
  _reaper = null;
  // CTL-650: stop the wait-state watcher.
  if (_waitWatcher) {
    try {
      _waitWatcher.stop();
    } catch {
      /* watcher already stopped */
    }
    _waitWatcher = null;
  }
  // CTL-685: stop the per-worker memory sampler.
  if (_memorySampler) {
    try {
      _memorySampler.stop();
    } catch (err) {
      log.warn({ err: err?.message }, "stopDaemon: memory-sampler stop failed");
    }
    _memorySampler = null;
  }
  // CTL-1165 D5: stop the pre-exhaustion fleet-health probe.
  if (_fleetHealthProbe) {
    try {
      _fleetHealthProbe.stop();
    } catch (err) {
      log.warn({ err: err?.message }, "stopDaemon: fleet-health-probe stop failed");
    }
    _fleetHealthProbe = null;
  }
  // CTL-1502: stop the stuck-but-alive daemon watchdog probe.
  if (_daemonWatchdogProbe) {
    try {
      _daemonWatchdogProbe.stop();
    } catch (err) {
      log.warn({ err: err?.message }, "stopDaemon: daemon-watchdog stop failed");
    }
    _daemonWatchdogProbe = null;
  }
  // CTL-787: stop the account-level rate-limit usage poller.
  if (_ratelimitPoller) {
    try {
      _ratelimitPoller.stop();
    } catch (err) {
      log.warn({ err: err?.message }, "stopDaemon: ratelimit-poller stop failed");
    }
    _ratelimitPoller = null;
  }
  // CTL-859: stop the node-heartbeat emitter.
  if (_heartbeat) {
    try {
      _heartbeat.stop();
    } catch (err) {
      log.warn({ err: err?.message }, "stopDaemon: heartbeat stop failed");
    }
    _heartbeat = null;
  }
  // CTL-1090: stop the cross-host liveness publisher.
  if (_livenessPublisher) {
    try {
      _livenessPublisher.stop();
    } catch (err) {
      log.warn({ err: err?.message }, "stopDaemon: liveness-publisher stop failed");
    }
    _livenessPublisher = null;
  }
  // CTL-1274: stop the cluster-repo auto-pull timer.
  if (_clusterSyncTimer) {
    clearInterval(_clusterSyncTimer);
    _clusterSyncTimer = null;
  }
  // CTL-684: stop the auto-tuner.
  if (_stopAutoTuner) {
    try {
      _stopAutoTuner();
    } catch {
      /* tuner already stopped */
    }
    _stopAutoTuner = null;
  }
  _eventLogCursor = 0;
  _eventLogLeftover = "";
  if (_pidFile) {
    try {
      unlinkSync(_pidFile);
    } catch {
      /* pid file already gone */
    }
    _pidFile = null;
  }
  log.info("execution-core daemon stopped");
}

// resolveBootConcurrency — CTL-678. Build the concurrency object the daemon
// threads at boot by merging the committed Layer-1 seed under the
// machine-canonical Layer-2 override. Layer-2 wins per valid integer field;
// absent Layer-2 fields fall back to Layer-1; absent in both yields {} (the
// legacy empty-concurrency path preserved end-to-end). Pure helper — CTL-676's
// hot-reload work can re-invoke it from a watch handler without refactor.
export function resolveBootConcurrency({ layer1Path, layer2Path }) {
  const layer1 = readExecutionCoreConcurrency(layer1Path);
  const layer2 = readExecutionCoreConcurrencyLayer2(layer2Path);
  return mergeExecutionCoreConcurrency(layer1, layer2);
}

function main() {
  const idx = process.argv.indexOf("--pid-file");
  const pidFile = idx >= 0 ? process.argv[idx + 1] : null;

  // CTL-649 Phase 9: thread the periodic-reaper config from .catalyst/config.json
  // into the timer. Path is env-overridable (CATALYST_CONFIG_FILE); otherwise
  // the daemon reads the launch-cwd's config. Absent/partial config falls back
  // to the built-in defaults (enabled, 600s) inside startReaperAndTimer.
  const configPath =
    process.env.CATALYST_CONFIG_FILE || resolve(process.cwd(), ".catalyst", "config.json");
  const orphanReaperConfig = readOrphanReaperConfig(configPath);
  // CTL-707: read the worktree-refresh config from the same config file.
  const worktreeRefreshConfig = readWorktreeRefreshConfig(configPath);
  // CTL-782: read the stale-PR-rescue config from the same config file.
  const stalePrRescueConfig = readStalePrRescueConfig(configPath);
  // CTL-1175: read the orphan-PR sweep config from the same config file.
  const orphanPrSweepConfig = readOrphanPrSweepConfig(configPath);
  // CTL-1608: read the stalled-PR sweep config from the same config file.
  const stalledPrSweepConfig = readStalledPrSweepConfig(configPath);
  // CTL-665 / CTL-678: resolve the executionCore concurrency knobs once here
  // and thread them into startDaemon → scheduler + boot-resume. The
  // machine-canonical Layer-2 file (~/.config/catalyst/config.json) wins
  // per-field over the committed Layer-1 seed; absent/partial in both yields
  // {} → the scheduler falls back to state.json + the hardcoded default. The
  // env var CATALYST_LAYER2_CONFIG_FILE overrides the Layer-2 path for tests.
  const layer2Path =
    process.env.CATALYST_LAYER2_CONFIG_FILE ||
    resolve(homedir(), ".config", "catalyst", "config.json");
  // CTL-1371: reconcile config is node-scoped — Layer-2 (+ CATALYST_RECONCILE_MODE
  // env) overrides the committed Layer-1 seed so an operator can flip the writer
  // off/notify/write per node.
  const linearReconcileConfig = readLinearReconcileConfig(configPath, layer2Path);
  const concurrency = resolveBootConcurrency({ layer1Path: configPath, layer2Path });
  log.info(
    { concurrency, layer2Present: existsSync(layer2Path) },
    "execution-core: resolved boot concurrency"
  );

  // A post-startup throw (a monitor/scheduler timer callback, the watcher)
  // must not leave a half-dead daemon holding a valid PID file — that makes
  // every health check lie. Exit non-zero with a tagged fatal log instead.
  const fatal = (label) => (err) => {
    log.error({ err }, `execution-core daemon: ${label} — exiting`);
    process.exit(1);
  };
  process.on("uncaughtException", fatal("uncaught exception"));
  process.on("unhandledRejection", fatal("unhandled rejection"));

  try {
    startDaemon({
      pidFile,
      orphanReaperConfig,
      worktreeRefreshConfig,
      stalePrRescueConfig,
      orphanPrSweepConfig,
      linearReconcileConfig,
      stalledPrSweepConfig,
      concurrency,
      configPath,
      layer2Path,
    }); // CTL-676 + CTL-678 + CTL-707 + CTL-782 + CTL-1175 + CTL-1371 + CTL-1608
  } catch (err) {
    log.error({ err }, "execution-core daemon: failed to start");
    process.exit(1);
  }

  const shutdown = (sig) => {
    log.info({ sig }, "execution-core daemon shutting down");
    stopDaemon();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Run main() only on direct invocation, never when imported as a module
// (daemon.test.mjs imports startDaemon/stopDaemon without triggering main()).
if (import.meta.main) main();
