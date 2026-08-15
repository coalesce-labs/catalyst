#!/usr/bin/env bun
// cloud-sync.mjs — CTL-1394: the per-node SUPERVISED catalyst-cloud-sync daemon (maintains the local Linear replica).
//
// A single long-lived process (one per host, run under launchd KeepAlive via
// cloud-sync/launch.sh) that maintains a fresh local SQLite replica at the
// canonical path (~/catalyst/catalyst-replica.db) from the Catalyst-Cloud change
// feed, using THIS node's own cloud token. Once it has seeded + is live, the
// scheduler's replica read tier (replica-read.mjs, CTL-1340, when
// CATALYST_LINEAR_REPLICA=on) and the agent-facing `catalyst-linear` CLI (CTL-1391)
// serve Linear reads from this local DB instead of the rate-limited `linearis` —
// the unblock for nodes drowning in 429s.
//
// ENGINE: @catalyst-cloud/sdk@0.4.0 `CatalystReplica` — `start()` opens + migrates +
// stream-seeds (/snapshot) + live-applies, resolving on the FIRST 'live' (seed
// complete); background sync then runs until close(). The SDK owns reconnect/backoff
// and a single-writer lock (<dbPath>.writer.lock, pid+heartbeat) — so a second
// concurrent writer throws loudly rather than corrupting the file.
//
// #127 SCHEMA-SKEW FIX (0.4.0 + schema@0.1.3 + replicate@0.1.3): a mirror AHEAD of the
// client's bundled schema no longer errno:1s. (1) the apply path DROPS a column the local
// schema lacks instead of throwing (forward-compat by construction — additive mirror
// column-adds can't recur this failure); (2) when a column-ADDING migration runs on boot,
// start() forces ONE `/snapshot` re-seed to BACKFILL rows written before the column existed
// (so already-stale rows — the CTL-1397 Backlog-vs-Done casualty — self-heal); (3) a
// warn-once "mirror is ahead: dropping unknown column(s)" drift log. Expect a one-time
// snapshot re-pull per node on the first boot after this bump — normal, not a stall.
//
// APPLY-RESULT TELEMETRY (CTL-1402): `applyFrame` records ONE outcome per live
// frame via a structured `catalyst.replica.apply` LOG line through our `log` callback below
// — `{result: applied|skipped|failed, seq, entity, source, err_message?}`. This REPLACES the
// old string-interpolated "apply failed for … seq=" line (no in-repo bridge, no double-emit),
// makes the errno:1 apply-drift (catalyst-cloud#127) observable in Loki, and carries the
// untruncated `err_message` that pins the drifted column. `telemetry:true` additionally arms
// a `result`-tagged `catalyst.replica.applied` OTLP counter — a no-op today (the fleet runs no
// in-process MeterProvider; OTEL materializes the signal from the Loki line) but durable for
// when one is adopted. The Loki line emits regardless of the flag; the flag is forward-compat.
//
// SECRETS: the token is read by NAME (resolveNodeCloudTokenEnv) and passed ONLY into
// auth.token. It is NEVER logged; the structured-log callback scrubs any token-bearing
// substring (the /connect URL rides ?token=) defensively.
//
// EXIT CONTRACT (paired with the plist's KeepAlive={SuccessfulExit:false}):
//   • no token resolvable        → log the NAME + exit 0  (clean no-op; launchd does
//                                   NOT restart — a tokenless node idles, doctor WARNs)
//   • SIGTERM/SIGINT             → close() (releases the writer lock) + exit 0  (no restart)
//   • start() throws / fatal     → exit 1  (launchd restarts with backoff; a stale
//                                   self-lock auto-reclaims after ~15s)
//   • genuine stall (watchdog)   → self-heal breadcrumb + close() + exit 1  (restart)
//   • dep-skew (CTL-1659)        → self-heal breadcrumb + close() + exit 1  (restart)
// CTL-1508: BOTH close()-then-exit paths are bounded by CATALYST_CLOUD_SYNC_CLOSE_TIMEOUT_MS
// (default 3s) via exitAfterClose — a close() wedged on a dead socket can no longer strand
// the process in a half-dead never-exits state launchd cannot recover from.
//
// DEP-SKEW SELF-HEAL (CTL-1659): a dependency fix lands on main, the updater pulls it, the
// install succeeds — and this process keeps serving the OLD modules until a human notices.
// It went unnoticed for days on 2026-08-04 because nothing restarts this daemon on a dep
// change: `plugin-refresh` deliberately stops at `restart_needed` ("restart stays a gated
// OPERATOR action"), and the broker's `decideStackReload` hard-codes monitor/execution-core/
// otel-forward — the same omission class CTL-1506 fixed one link up the chain. Rather than
// add a FOURTH external restart mechanism, this is a SECOND predicate on the self-heal exit
// that already exists three lines above: at boot we record what we actually resolved
// (captureLoadedDeps), on each heartbeat we re-hash the root lockfile, and a SUSTAINED
// mismatch takes the same breadcrumb + bounded exit-1 path the stall watchdog takes — which
// means launchd KeepAlive is the actuator and health-responder.sh's `no-respawn` condition
// already nets a failed relaunch, with no change to either. Ships SHADOW by default
// (CATALYST_CLOUD_SYNC_DEP_SKEW=off|shadow|enforce); the skew fields ride the freshness
// heartbeat line in every mode, so the signal is alertable in Loki from day one instead of
// being another `restart_needed` nobody watches. The restart ALSO lands on the unified event
// log (`catalyst.replica.dep_skew_restart`, with `…_would_restart` for a detected-but-held
// posture) via the same append emitWriterIdleEvent already uses — the heartbeat line is a LOG
// stream and reaches neither `catalyst-events wait-for`, the broker, the HUD, nor
// orch-monitor, which is the ticket's "the restart is visible in the event log" clause.
import { CatalystReplica } from "@catalyst-cloud/sdk/node";
import { getCloudSyncDepSkewLedgerPath, getCloudSyncDepsPath, getCloudSyncSelfHealPath, getEventLogPath, getHostName, getReplicaDbPath, resolveNodeCloudTokenEnv, HEARTBEAT_INTERVAL_MS } from "./config.mjs";
import { logDaemonHeartbeat } from "../lib/daemon-heartbeat.mjs";
import { emitProcessMemoryMetric } from "../lib/process-memory-metric.mjs"; // CTL-1517: per-process RSS/heap gauge
import { sdkLogRecord } from "./cloud-sync-log.mjs";
import { createSchemaReportingWsFactory } from "./cloud-sync-schema-identity.mjs"; // CTL-1869
import { classifyDepSkew, classifyStall, clearSelfHealBreadcrumb, exitAfterClose, freshnessFields, readReplicaCounts, resolveDepSkewMode, writeSelfHealBreadcrumb } from "./cloud-sync-telemetry.mjs";
import {
  DEP_SKEW_ALERT,
  DEP_SKEW_REASON,
  DEP_SKEW_RESTART_EVENT,
  DEP_SKEW_WOULD_RESTART_EVENT,
  captureLoadedDeps,
  classifyRestartBudget,
  depSkewEventEnvelope,
  depSkewFields,
  readRestartLedger,
  recordRestartAttempt,
  sha256File,
  writeDepsBreadcrumb,
} from "./cloud-sync-deps.mjs";
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

const TAG = "[catalyst-cloud-sync]";

// hbLogger — pino to stderr (the plist redirects StandardError → cloud-sync.log, which
// Alloy ships under service_name=catalyst.cloud-sync). Mirrors updater.mjs's defensive
// pattern: a missing pino degrades to a JSON-on-stderr shim, never crashes the daemon.
function hbLogger() {
  try {
    const pino = createRequire(import.meta.url)("pino");
    return pino({ name: "cloud-sync", level: process.env.LOG_LEVEL ?? "info" }, process.stderr);
  } catch {
    // Defensive shim (pino is a hard dep, so this is rare): still emit a full-JSON line per
    // level — `time` in ms + top-level fields — so Alloy's `| json` parses fields even here
    // (CTL-1402: the apply-result fields must never degrade to an unqueryable prefixed string).
    const emit = (level) => (a, b) => {
      try {
        const rec = { level, name: "cloud-sync", time: Date.now() };
        if (a && typeof a === "object") { Object.assign(rec, a); if (typeof b === "string") rec.msg = b; }
        else rec.msg = typeof a === "string" ? a : JSON.stringify(a);
        process.stderr.write(JSON.stringify(rec) + "\n");
      } catch { /* best-effort */ }
    };
    return { info: emit("info"), warn: emit("warn"), error: emit("error") };
  }
}
const DEFAULT_BASE_URL = "https://api.catalyst-cloud.coalescelabs.ai/api/v1";
const DEFAULT_ACCOUNT = "tenant-0";
export const WRITER_IDLE_EVENT = "catalyst.replica.writer_idle";

function emitWriterIdleEvent({ host, tokenEnv, tokenSource, dbPath }) {
  try {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const envelope = {
      ts,
      id: randomBytes(8).toString("hex"),
      observedTs: ts,
      severityText: "WARN",
      severityNumber: 13,
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      resource: buildCatalystResource({ serviceName: "catalyst.cloud-sync", host }),
      attributes: {
        "event.name": WRITER_IDLE_EVENT,
        "event.entity": "replica",
        "event.action": "writer_idle",
        "event.label": host,
        host,
        token_env: tokenEnv,
        token_source: tokenSource,
        db_path: dbPath,
      },
      body: { message: `cloud-sync writer idle: no token in ${tokenEnv} (source=${tokenSource})` },
    };
    const logPath = getEventLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(envelope)}\n`);
    return true;
  } catch {
    return false;
  }
}

// CTL-1659 — the AC1 clause "And the restart is visible in the event log". Deliberately the
// SAME append that emitWriterIdleEvent performs (same file, same v2 envelope, same
// fail-open `try`/`return false`): the unified log at ~/catalyst/events/YYYY-MM.jsonl is the
// surface `catalyst-events wait-for`, the broker, the HUD and orch-monitor all read, and the
// heartbeat line alone reaches none of them. The envelope itself is built by the pure
// `depSkewEventEnvelope` in cloud-sync-deps.mjs so its shape is unit-testable without
// running this script-shaped module. FAIL-OPEN, without exception: emitting the observation
// must never be able to block or crash the self-heal exit it is describing — a lost event is
// a lost event, a wedged writer is the incident.
function emitDepSkewEvent({ name, currentLockHash, depSkew, restart }) {
  try {
    const envelope = depSkewEventEnvelope({
      name,
      host: getHostName(),
      mode: DEP_SKEW_MODE,
      reason: depSkew.reason,
      bootLockHash: DEP_SKEW_BOOT_LOCK_HASH,
      currentLockHash,
      lockPath: DEP_SKEW_LOCK_PATH,
      sustained: depSkew.sustained,
      wouldRestart: depSkew.wouldRestart,
      restart,
      id: randomBytes(8).toString("hex"),
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      resource: buildCatalystResource({ serviceName: "catalyst.cloud-sync", host: getHostName() }),
    });
    const logPath = getEventLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(envelope)}\n`);
    return true;
  } catch {
    return false;
  }
}

// scrub — strip any secret-shaped substring before anything reaches a log line. Covers
// the cloud token riding the /connect URL (?token=…), an Authorization: Bearer header,
// and a Linear token shape, in case the SDK ever surfaces a request URL/header in a log.
function scrub(s) {
  return String(s)
    .replace(/([?&]token=)[^&\s"']+/gi, "$1***")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/\blin_(?:api|oauth)_[A-Za-z0-9_-]+/g, "lin_***");
}

const baseUrl = process.env.CATALYST_CLOUD_BASE_URL || DEFAULT_BASE_URL;
const account = process.env.CATALYST_CLOUD_ACCOUNT || DEFAULT_ACCOUNT;
// startTimeoutMs (sdk 0.2.1): reject start() if 'live' isn't reached within this — a
// wedged cold /snapshot or unreachable host fails fast → exit 1 → launchd restarts, instead
// of a supervised process hanging forever. A positive override wins; an explicit `0` DISABLES
// the timeout (for a known-slow cold seed — pass `undefined` so the SDK uses no timeout, NOT
// 0 which the SDK would treat as "time out immediately"); unset/non-numeric → 120_000 default.
function resolveStartTimeoutMs(raw) {
  if (raw === "0") return undefined; // explicit disable → omit (SDK default = no timeout)
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}
const startTimeoutMs = resolveStartTimeoutMs(process.env.CATALYST_REPLICA_START_TIMEOUT_MS);
// CTL-1508: hard deadline on the exit-path replica.close() (both SIGTERM/SIGINT and the
// genuine-stall self-heal). close() over a dead/half-open socket — the stall path's most
// likely socket — can hang forever; unbounded, that stranded a half-dead writer (hbTimer
// already cleared, heartbeats stopped) that launchd could never replace because the
// process never exited. See exitAfterClose in cloud-sync-telemetry.mjs.
const CLOSE_TIMEOUT_MS = Number(process.env.CATALYST_CLOUD_SYNC_CLOSE_TIMEOUT_MS) || 3_000;
const dbPath = getReplicaDbPath();
const { envVar, source } = resolveNodeCloudTokenEnv();
const token = process.env[envVar];

// Fail-open no-op: a node without its token cleanly exits 0 (NOT a crash) so launchd's
// {SuccessfulExit:false} KeepAlive leaves it down rather than churning. doctor's
// replica-token check surfaces the gap by NAME. Provision the token, then re-adopt /
// kickstart to activate.
if (!token) {
  try {
    emitWriterIdleEvent({ host: getHostName(), tokenEnv: envVar, tokenSource: source, dbPath });
  } catch { /* fail-open — telemetry must never alter the clean idle exit */ }
  console.log(`${TAG} no token in ${envVar} (source=${source}); writer idle — provision the token, then adopt/kickstart to activate`);
  process.exit(0);
}

// hlog defined BEFORE construction so the SDK `log` callback below routes through pino.
const hlog = hbLogger();

const replica = new CatalystReplica({
  baseUrl,
  account,
  auth: { kind: "token", token }, // the value flows ONLY here — never logged
  dbPath,
  startTimeoutMs,
  // writerGuard.ownerKey (sdk 0.2.1): a stable per-logical-writer identity so a launchd
  // KeepAlive relaunch reclaims its OWN just-crashed lock IMMEDIATELY (same host+tenant),
  // instead of waiting out the ~15s staleMs lease — kills the restart churn on a hard
  // crash. Default two-writer protection is unchanged for any writer without an ownerKey
  // (a second LIVE writer with a DIFFERENT ownerKey still throws loudly).
  writerGuard: { ownerKey: `${getHostName()}-${account}` },
  // CTL-1869: report the schema bundle this process ACTUALLY LOADED, so the hub can
  // classify skew instead of recording `unreported`. CTC-471 shipped the receiving
  // half and CTC-487/PR #435 shipped a sender — for apps/host-sync, which no real
  // host runs; THIS is the replica the fleet runs, so all 3 connected replicas
  // reported `unreported`. Replicates the SDK's default factory on a URL carrying
  // schema_tail/schema_count; a null tail appends nothing and stays honestly
  // `unreported`. Runs per (re)connect, so the identity tracks the loaded bundle
  // across reconnects rather than freezing at process start.
  wsFactory: createSchemaReportingWsFactory(),
  // CTL-1402: arm the SDK's opt-in telemetry. The apply-result signal the fleet consumes is
  // the structured `catalyst.replica.apply` LOG line (via the `log` callback below), which emits
  // regardless of this flag; enabling it additionally arms the `catalyst.replica.applied` OTLP
  // counter — a no-op today (no in-process MeterProvider) but durable when one is adopted. No
  // MeterProvider is stood up here, so no OTLP exporter is created (OTEL's guidance).
  telemetry: true,
  onStatus: (status) => console.log(`${TAG} status=${status}`),
  // CTL-1402: route SDK logs through the pino logger (full JSON → stderr → cloud-sync.log →
  // Alloy `loki.process.pino` keeps the full body → `| json`), so the structured
  // `catalyst.replica.apply` fields (result/seq/entity/source/err_message) are QUERYABLE. A
  // prefixed `console.log` string is shipped as an opaque body and its fields never register —
  // which would defeat this whole change. Object `extra` → top-level pino fields; string extra →
  // a `detail` field; scrub token-bearing strings defensively (values + message).
  log: (level, msg, extra) => {
    const r = sdkLogRecord(level, msg, extra, scrub);
    if (r.fields === undefined) hlog[r.level](r.msg);
    else hlog[r.level](r.fields, r.msg);
  },
});

let closing = false;
let hbTimer = null;
const shutdown = (sig) => {
  if (closing) return;
  closing = true;
  if (hbTimer) clearInterval(hbTimer);
  console.log(`${TAG} ${sig} — closing (releasing writer lock)`);
  // close() is idempotent: stops the socket, releases the lock, closes the DB. CTL-1508:
  // bounded — a close() wedged on a dead socket must not strand a manual stop forever.
  // Still exit 0 whether close settles or times out: KeepAlive={SuccessfulExit:false}
  // must NOT restart a deliberate stop.
  exitAfterClose({ closePromise: replica.close(), exitCode: 0, timeoutMs: CLOSE_TIMEOUT_MS });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log(`${TAG} starting (db=${dbPath}, account=${account}, token=${envVar}, base=${baseUrl})`);
try {
  // Resolves on the FIRST 'live' (caught-up + seed-complete). Bounded by startTimeoutMs
  // (above) unless disabled — a wedged /snapshot rejects and we exit 1 → launchd restarts;
  // onStatus drives progress visibility meanwhile.
  await replica.start();
} catch (err) {
  // A second live writer on this path, an unreachable host, or a seed failure lands
  // here. exit 1 → launchd restarts with backoff (and reclaims a stale self-lock).
  console.error(`${TAG} start failed: ${scrub(err?.message ?? String(err))}`);
  process.exit(1);
}
console.log(`${TAG} live — replica seeded + tailing the change feed (cursor=${replica.cursor})`);

// CTL-1508: reaching 'live' proves a prior self-heal restart WORKED, so consume the
// breadcrumb the pre-restart run dropped (see the genuine-stall block below for the full
// CTL-1509 contract). Best-effort — a missing file (no self-heal pending) is the normal
// case and clearSelfHealBreadcrumb never throws.
clearSelfHealBreadcrumb(getCloudSyncSelfHealPath());

// --- CTL-1659: record what this process ACTUALLY loaded ------------------------------
// Written ONCE, here, because reaching 'live' is the moment the modules are proven usable.
// The record carries the RESOLVED module path, the version read from THAT path's
// package.json, a digest of the entry file, the root that served it, and a SHA-256 of that
// root's lockfile — deliberately NOT "what the lockfile said", which would re-manufacture
// the claim under test (the CTL-1646 shadowed-install class). `bootLockHash` is also the
// baseline the per-tick predicate below compares against.
const DEP_SKEW_MODE = resolveDepSkewMode(process.env.CATALYST_CLOUD_SYNC_DEP_SKEW);
// Consecutive-tick threshold: bun rewrites bun.lock IN PLACE during an install, so a
// single tick can catch it mid-write. Two consecutive observations (~1 min at the default
// 30s heartbeat) is past any plausible write window.
const DEP_SKEW_SUSTAINED_TICKS = Number(process.env.CATALYST_CLOUD_SYNC_DEP_SKEW_TICKS) || 2;
// Uptime floor — a just-relaunched writer never immediately exits again, so even a
// pathological lockfile churn cannot restart faster than this.
const DEP_SKEW_UPTIME_FLOOR_MS = Number(process.env.CATALYST_CLOUD_SYNC_DEP_SKEW_UPTIME_MS) || 120_000;
// Durable budget (the loop terminator). Default: at most ONE dep-skew restart per 6h. The
// predicate is self-clearing — a relaunch re-captures the CURRENT digest, so boot ===
// current again — and this covers only what self-clearing cannot: a lockfile being
// rewritten continuously by a broken install loop.
const DEP_SKEW_BUDGET_WINDOW_MS = Number(process.env.CATALYST_CLOUD_SYNC_DEP_SKEW_WINDOW_MS) || 21_600_000;
const DEP_SKEW_MAX_RESTARTS = Number(process.env.CATALYST_CLOUD_SYNC_DEP_SKEW_MAX_RESTARTS) || 1;
const depsRequire = createRequire(import.meta.url);
let _bootDeps = null;
if (DEP_SKEW_MODE !== "off") {
  try {
    _bootDeps = captureLoadedDeps({
      startDir: dirname(fileURLToPath(import.meta.url)),
      resolveModule: (specifier) => depsRequire.resolve(specifier),
    });
    writeDepsBreadcrumb(getCloudSyncDepsPath(), _bootDeps);
    hlog.info(
      {
        event: "catalyst.replica.deps_captured",
        ...depSkewFields({ mode: DEP_SKEW_MODE, bootLockHash: _bootDeps.lockHash, skewed: false }),
        "catalyst.cloud_sync.deps.root": _bootDeps.root,
        "catalyst.cloud_sync.deps.degraded": _bootDeps.degraded,
        "catalyst.cloud_sync.deps.packages": _bootDeps.packages.map((p) => `${p.id}@${p.version ?? "?"}`).join(","),
        "host.name": getHostName(),
      },
      `cloud-sync: loaded-dependency boot record written (mode=${DEP_SKEW_MODE}${_bootDeps.degraded ? `, DEGRADED: ${_bootDeps.degradedReasons.join("; ")}` : ""})`,
    );
  } catch (err) {
    // Fail-open by construction: recording module identity must never take down the
    // writer. A missing record is UNKNOWN to doctor, never "clean" — that asymmetry is
    // what keeps this safe to fail.
    _bootDeps = null;
    try { hlog.warn({ event: "catalyst.replica.deps_capture_failed" }, `cloud-sync: dependency boot record failed: ${scrub(err?.message ?? String(err))}`); } catch { /* best-effort */ }
  }
}
const DEP_SKEW_BOOT_LOCK_HASH = _bootDeps?.lockHash ?? null;
const DEP_SKEW_LOCK_PATH = _bootDeps?.lockPath ?? null;
const BOOT_MS = Date.now();
let _depSkewMismatches = 0;
// The one-shot latch keys on the POSTURE, not on a bare boolean: an episode that escalates
// (skewed → sustained → would-restart) must re-alert once per step, or the only line in
// Loki would be the earliest and weakest one, saying "no restart" about a run that went on
// to restart. It re-arms (null) the moment skew clears.
let _depSkewAlertedPosture = null;
// A SECOND latch, for the undurable-ledger decline. That branch lives inside
// `if (depSkew.restart)`, OUTSIDE the posture latch above, so with sustained skew in
// enforce mode and a ledger that stays unwritable (a full or read-only ~/catalyst) it fires
// on EVERY heartbeat: one ERROR line plus one `dep_skew_would_restart` event every 30s for
// the whole incident — an alarm flooding the very surfaces (cloud-sync.log, the unified
// event log) it exists to make legible. Same count-exactly / warn-sparsely discipline as
// CTL-1817/CTL-1823 (otel-forward/lib/sparse-warn.ts): the condition is re-evaluated every
// tick, the ANNOUNCEMENT is edge-triggered. Keyed on the same posture string as the alert
// latch, so a genuine change (skew clears, the budget runs out, the run stops being
// sustained) re-announces once; it re-arms (null) the moment skew clears.
//
// Deliberately latches only the EMISSIONS, never the write attempt: retrying
// `recordRestartAttempt` each tick is what lets a repaired filesystem resume the self-heal,
// and a latch that suppressed the retry would turn one transient EROFS into a permanent
// refusal.
let _depSkewDeclinedPosture = null;

// CTL-1395: liveness + freshness telemetry. Every HEARTBEAT_INTERVAL_MS emit (a) the
// CTL-1280 `daemon heartbeat` marker — feed-independent proof the writer is alive, → the
// uptime tile (same Loki heartbeat-freshness query as the other daemons) — and (b) a
// freshness line (staleness/rows/status/cursor). This runs on EVERY node class and from
// the writer itself, so it closes the dev-node + seed-window blind spots the scheduler-only
// CTL-1366 gauge misses, and is the continuous OTL-40 "reads recovered" signal. FAIL-OPEN:
// a probe error (DB locked, mid-reconnect) must NEVER crash the writer — emit what we have.
// CTL-1420 follow-up — cursor-advance WATCHDOG + visible status + loud alert. RCA of the
// 18.5h silent freeze (a half-open push WebSocket the SDK never noticed; onclose never
// fired so it never reconnected): EVERY liveness signal was decoupled from cursor-advance.
// The heartbeat kept beating and `status` stayed latched "live" while the cursor sat frozen
// and the replica silently went stale — forcing the fleet's agents back onto the
// rate-limited personal `linearis` key with no alarm.
//
// CODEX-REVIEW FIX (P1/P2): cursor-silence ALONE must NOT trigger a page/restart. A healthy
// QUIET feed (no Linear changes for the window) freezes `replica.cursor` EXACTLY like a
// dead/half-open socket does — replica-read.mjs:102-118 documents this (the apply cadence
// goes stale on a quiet feed, which is why writer liveness keys on the `.writer.lock`
// heartbeat, not cursor movement). Keying "stalled" on cursor-silence alone therefore
// false-classifies a perfectly current idle node and would re-seed/restart/page every quiet
// window. The SDK (0.4.0) exposed no per-frame keepalive/last-frame timestamp, so we gate the
// destructive action on an ADDITIONAL independent liveness failure the cursor can't fake —
// the SDK's own connection status (classifyStall).
// CTL-1508 (SDK 0.6.0): the SDK now DOES surface `replica.lastFrameAt` — epoch-ms of the
// last inbound socket bytes of ANY kind, INCLUDING the CTC-135 watchdog's pong traffic
// (unlike `lastChangeFrameAt`, which ignores pongs). A healthy quiet feed keeps lastFrameAt
// fresh via ping/pong (the SDK pings after ~90s of idle), so a lastFrameAt frozen across
// the whole stall window is something a healthy socket CANNOT produce — it independently
// confirms the half-open case even while `status` sits latched "live" (exactly the 18.5h
// RCA shape gate-by-status alone was blind to). classifyStall therefore accepts EITHER
// confirmation; feature-detected via typeof so an older SDK (getter absent) degrades
// bit-identically to the status-only classifier. A GENUINE stall = cursor-silence AND
// (an unhealthy SDK status (reconnecting/error/stopped) OR whole-window frame-silence);
// only THEN do we:
//   (1) surface status="stalled" in the freshness line (a mere quiet feed keeps its real status);
//   (2) emit the LOUD ERROR alert to Loki (the alarm Ryan asked for — now fires only on a
//       PROVABLE stall, never on a quiet-but-healthy feed, so no false pages every quiet window);
//   (3) SELF-HEAL by exiting so launchd KeepAlive re-spawns (a fresh socket + re-seed).
// A cursor stall with a still-"live" SDK status (indistinguishable quiet-vs-halfopen) is left
// as observational freshness telemetry only — never a false-kill. The generous
// CATALYST_CLOUD_SYNC_STALL_MS window (default 10 min) additionally widens the genuine case.
const STALL_MS = Number(process.env.CATALYST_CLOUD_SYNC_STALL_MS) || 600_000;
let _lastCursor = replica.cursor;
let _lastAdvanceMs = Date.now();
let _stallAlerted = false;
const emitTelemetry = () => {
  try { logDaemonHeartbeat(hlog, "cloud-sync"); } catch { /* best-effort */ }
  // CTL-1517: per-process RSS/heap OTel gauge (fire-and-forget; never throws/blocks).
  emitProcessMemoryMetric({ serviceName: "catalyst.cloud-sync", log: hlog }).catch(() => {});
  let rows = null;
  let maxUpdatedMs = null;
  try { ({ rows, maxUpdatedMs } = readReplicaCounts(replica.sql)); } catch { /* best-effort */ }
  const now = Date.now();
  const cursor = replica.cursor;
  if (cursor !== _lastCursor) { _lastCursor = cursor; _lastAdvanceMs = now; _stallAlerted = false; }
  const stalledMs = now - _lastAdvanceMs;
  const sdkStatus = replica.status ?? "live";
  // CTL-1508: per-frame transport liveness (SDK 0.6.0). Feature-detect via typeof — an
  // older SDK has no getter (undefined) and MUST degrade to the status-only classifier
  // bit-identically, so anything non-number becomes null (which never asserts).
  const lastFrameAt = typeof replica.lastFrameAt === "number" ? replica.lastFrameAt : null;
  // A stall is GENUINE (alert + self-heal) only when cursor-silence is CONFIRMED by an
  // independent transport-liveness failure — an unhealthy SDK status OR whole-window
  // frame-silence (CTL-1508) — never on cursor-silence alone, which a healthy quiet feed
  // produces identically (Codex P1/P2).
  const { genuine, restart, displayStatus, sdkUnhealthy, frameSilent } = classifyStall({ rows, stalledMs, stallMs: STALL_MS, status: sdkStatus, lastFrameAt, now });
  if (!genuine) _stallAlerted = false; // re-arm the one-shot alert for the next genuine stall
  // CTL-1659: re-hash the root lockfile the modules were served from. A digest read is
  // O(file) on a ~200KB text file once per heartbeat — cheap, and it touches nothing the
  // SDK owns. An unreadable lockfile yields null, which classifyDepSkew treats as UNKNOWN
  // (never as skew), so a transient read error cannot kill a healthy writer.
  const currentLockHash = DEP_SKEW_LOCK_PATH ? sha256File(DEP_SKEW_LOCK_PATH) : null;
  if (DEP_SKEW_BOOT_LOCK_HASH && currentLockHash && currentLockHash !== DEP_SKEW_BOOT_LOCK_HASH) _depSkewMismatches += 1;
  else _depSkewMismatches = 0; // any matching (or unknown) tick resets the run
  // The budget is consulted BEFORE deciding, so its refusal is REPORTED in the same
  // classification (and therefore in the alert line) rather than being discovered as a
  // silent no-op after the alarm has already claimed a restart was coming. Read only when
  // a mismatch run is actually open, so the healthy steady state costs no extra syscall.
  const depSkewLedger = _depSkewMismatches > 0 ? readRestartLedger(getCloudSyncDepSkewLedgerPath()) : null;
  const budget = classifyRestartBudget({
    ledger: depSkewLedger,
    now,
    windowMs: DEP_SKEW_BUDGET_WINDOW_MS,
    maxRestarts: DEP_SKEW_MAX_RESTARTS,
  });
  const depSkew = classifyDepSkew({
    bootLockHash: DEP_SKEW_BOOT_LOCK_HASH,
    currentLockHash,
    consecutiveMismatches: _depSkewMismatches,
    sustainedTicks: DEP_SKEW_SUSTAINED_TICKS,
    uptimeMs: now - BOOT_MS,
    uptimeFloorMs: DEP_SKEW_UPTIME_FLOOR_MS,
    mode: DEP_SKEW_MODE,
    budgetAllowed: budget.allowed,
    budgetReason: budget.reason,
  });
  const depSkewPosture = `${depSkew.skewed}:${depSkew.sustained}:${depSkew.wouldRestart}:${depSkew.restart}`;
  if (!depSkew.skewed) { _depSkewAlertedPosture = null; _depSkewDeclinedPosture = null; } // re-arm the one-shots for the next episode
  try {
    hlog.info(
      {
        ...freshnessFields({ rows, maxUpdatedMs, status: displayStatus, cursor, hostName: getHostName(), lastFrameAt, now }),
        // The skew observation rides the EXISTING heartbeat line in every mode, so a Loki
        // rule can alarm on it without waiting for someone to run doctor. Shadow with
        // nobody watching is precisely the failure this ticket exists to remove.
        ...depSkewFields({
          mode: DEP_SKEW_MODE,
          bootLockHash: DEP_SKEW_BOOT_LOCK_HASH,
          currentLockHash,
          skewed: depSkew.known ? depSkew.skewed : null,
          sustained: depSkew.known ? depSkew.sustained : null,
          wouldRestart: depSkew.known ? depSkew.wouldRestart : null,
        }),
      },
      "cloud-sync: freshness",
    );
  } catch { /* best-effort — telemetry must never crash the writer */ }
  if (depSkew.skewed && depSkewPosture !== _depSkewAlertedPosture) {
    _depSkewAlertedPosture = depSkewPosture;
    try {
      hlog.warn(
        {
          event: "catalyst.replica.dep_skew",
          "catalyst.alert": DEP_SKEW_ALERT,
          ...depSkewFields({ mode: DEP_SKEW_MODE, bootLockHash: DEP_SKEW_BOOT_LOCK_HASH, currentLockHash, skewed: true, sustained: depSkew.sustained, wouldRestart: depSkew.wouldRestart }),
          "catalyst.cloud_sync.deps.lock_path": DEP_SKEW_LOCK_PATH,
          "catalyst.cloud_sync.deps.reason": depSkew.reason,
          "host.name": getHostName(),
        },
        `cloud-sync: the root lockfile changed since this writer loaded its modules — the daemon is serving PRE-CHANGE code (mode=${DEP_SKEW_MODE}${depSkew.restart ? ", self-healing via restart" : `, no restart: ${depSkew.reason ?? "held"}`})`,
      );
    } catch { /* the alarm must never crash the writer */ }
    // …and the same escalation step onto the UNIFIED EVENT LOG, gated on the same posture
    // latch so a 30s heartbeat cannot spam it. Only the HELD case is emitted here: when
    // `depSkew.restart` is true the restart block below owns the emission, because only
    // AFTER the budget is spent is "restarting" a truthful claim — a ledger that cannot be
    // persisted declines the exit, and an event announcing a restart that never happened is
    // the same lie `restart_needed` told.
    if (depSkew.wouldRestart && !depSkew.restart) {
      emitDepSkewEvent({ name: DEP_SKEW_WOULD_RESTART_EVENT, currentLockHash, depSkew, restart: false });
    }
  }
  if (depSkew.restart) {
    // Spend the durable budget FIRST: if the ledger cannot be persisted there is no loop
    // terminator, so we decline the restart rather than risk an unbounded relaunch cycle.
    // Declining is never destructive — it leaves exactly today's behavior (a skewed but
    // running writer), which the doctor check and the alert above both name.
    const spent = recordRestartAttempt(getCloudSyncDepSkewLedgerPath(), { ledger: depSkewLedger, now, windowMs: DEP_SKEW_BUDGET_WINDOW_MS });
    if (spent === null) {
      // EDGE-TRIGGERED, not per-tick. The write above is retried every heartbeat (that is
      // how a repaired filesystem resumes the self-heal), but the ERROR line and the
      // unified-log event are announced once per DECLINED POSTURE — otherwise a sustained
      // skew with a permanently-unwritable ledger emits both every 30s for the duration of
      // the incident, burying the one line an operator needs under thousands of copies of
      // itself. The latch re-arms on any posture change and the moment skew clears.
      if (depSkewPosture !== _depSkewDeclinedPosture) {
        _depSkewDeclinedPosture = depSkewPosture;
        try { hlog.error({ event: "catalyst.replica.dep_skew", "catalyst.alert": DEP_SKEW_ALERT }, "cloud-sync: dep-skew restart DECLINED — the restart-budget ledger could not be persisted, so the loop has no terminator"); } catch { /* best-effort */ }
        // The posture block above skipped its would-restart event (it saw `restart: true`, and
        // deferred to this block), so without this line an enforce-mode host with an unwritable
        // ledger would emit NOTHING to the unified log — silence on precisely the configuration
        // that is trying to act and cannot. `reason` carries the ledger failure.
        emitDepSkewEvent({
          name: DEP_SKEW_WOULD_RESTART_EVENT,
          currentLockHash,
          depSkew: { ...depSkew, reason: "the dep-skew restart-budget ledger could not be persisted — declining the restart (the loop would have no terminator)" },
          restart: false,
        });
      }
    } else {
      // Same exit path as the CTL-1508 genuine-stall self-heal, with a `reason`
      // discriminator: breadcrumb (so health-responder.sh's no-respawn condition nets a
      // failed relaunch) + bounded close + exit 1. NEVER exit 0 — the plist pairs
      // KeepAlive={SuccessfulExit:false} with an exit-0 "clean no-op, stay DOWN" contract,
      // so a clean exit here would permanently stop the replica writer.
      //
      // AC1's second clause, emitted HERE — after the budget is spent and before the exit,
      // the one window in which "this writer is restarting for dep-skew" is both true and
      // still recordable. Ordered ahead of clearInterval/exitAfterClose deliberately: the
      // bounded close can exit the process at any point after it is called, so an append
      // sequenced after it could be lost on exactly the runs that matter most.
      emitDepSkewEvent({ name: DEP_SKEW_RESTART_EVENT, currentLockHash, depSkew, restart: true });
      writeSelfHealBreadcrumb(getCloudSyncSelfHealPath(), { cursor, stalledMs: null, sdkStatus, reason: DEP_SKEW_REASON });
      try { if (hbTimer) clearInterval(hbTimer); } catch { /* best-effort */ }
      exitAfterClose({ closePromise: replica.close(), exitCode: 1, timeoutMs: CLOSE_TIMEOUT_MS });
      return; // the stall block below must not also fire on the way out
    }
  }
  if (genuine && !_stallAlerted) {
    _stallAlerted = true;
    // The alarm that was missing for 18.5h — now gated on an independent liveness failure
    // (unhealthy SDK status, or CTL-1508 whole-window frame-silence) so it never fires on
    // a quiet-but-healthy feed. ERROR severity → ships via hlog→Alloy→Loki. The reason
    // clause names WHICH confirmation fired (frame-silence implies a finite lastFrameAt).
    const reason = sdkUnhealthy
      ? `unhealthy SDK status=${sdkStatus}`
      : `NO inbound frames for ${Math.round((now - lastFrameAt) / 1000)}s (not even watchdog pongs) despite SDK status=${sdkStatus}`;
    try {
      hlog.error(
        {
          event: "catalyst.replica.stalled",
          "catalyst.alert": "replica_stalled",
          cursor,
          stalledMs,
          rows,
          "sdk.status": sdkStatus,
          // CTL-1508: which independent confirmation(s) upgraded cursor-silence to genuine,
          // plus the raw frame timestamp (null on an older SDK) for the responder/RCA.
          "sdk.unhealthy": sdkUnhealthy,
          "sdk.frame_silent": frameSilent,
          "sdk.last_frame_at": lastFrameAt,
          "host.name": getHostName(),
        },
        `cloud-sync: replica cursor STALLED ${Math.round(stalledMs / 1000)}s (>${Math.round(STALL_MS / 1000)}s) with ${reason} — reads are going stale; self-healing via restart`,
      );
    } catch { /* the alarm must never crash the writer */ }
    if (restart) {
      // Self-heal: stop the timer, close the replica, and exit non-zero so launchd
      // (KeepAlive={SuccessfulExit:false}) re-spawns with a fresh socket + re-seed.
      //
      // CTL-1508 SELF-HEAL BREADCRUMB — a cross-ticket contract consumed by CTL-1509's
      // external responder and doctor. BEFORE initiating close, atomically drop
      // ~/catalyst/cloud-sync.selfheal.json = {ts, cursor, stalledMs, sdkStatus,
      // expectRestart: true}; the NEXT boot deletes it on reaching 'live' (above). So:
      //   breadcrumb present + writer process ABSENT → launchd did NOT re-spawn us —
      //     the launchd-no-respawn signature the responder pages on / doctor flags;
      //   breadcrumb present + writer alive          → restart in progress (normal);
      //   breadcrumb absent                          → no self-heal pending.
      // Best-effort by construction (writeSelfHealBreadcrumb never throws) — the
      // breadcrumb must never block the exit.
      writeSelfHealBreadcrumb(getCloudSyncSelfHealPath(), { cursor, stalledMs, sdkStatus });
      try { if (hbTimer) clearInterval(hbTimer); } catch { /* best-effort */ }
      // CTL-1508: bounded exit — this close() runs over the very dead socket that CAUSED
      // the stall (the close most likely to hang). Unbounded, a hung close stranded a
      // half-dead writer (heartbeats stopped above) that launchd could never replace.
      exitAfterClose({ closePromise: replica.close(), exitCode: 1, timeoutMs: CLOSE_TIMEOUT_MS });
    }
  }
};
emitTelemetry();
hbTimer = setInterval(emitTelemetry, HEARTBEAT_INTERVAL_MS);

// Keep the process alive: start() has resolved but background sync continues until
// close(). Without this the process would exit 0 and launchd would not restart it
// (and reads would go stale). SIGTERM is the only intended exit from here.
await new Promise(() => {});
