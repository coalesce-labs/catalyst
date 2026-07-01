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
// ENGINE: @catalyst-cloud/sdk@0.3.1 `CatalystReplica` — `start()` opens + migrates +
// stream-seeds (/snapshot) + live-applies, resolving on the FIRST 'live' (seed
// complete); background sync then runs until close(). The SDK owns reconnect/backoff
// and a single-writer lock (<dbPath>.writer.lock, pid+heartbeat) — so a second
// concurrent writer throws loudly rather than corrupting the file.
//
// APPLY-RESULT TELEMETRY (CTL-1402): 0.3.1's `applyFrame` records ONE outcome per live
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
import { CatalystReplica } from "@catalyst-cloud/sdk/node";
import { getHostName, getReplicaDbPath, resolveNodeCloudTokenEnv, HEARTBEAT_INTERVAL_MS } from "./config.mjs";
import { logDaemonHeartbeat } from "../lib/daemon-heartbeat.mjs";
import { sdkLogRecord } from "./cloud-sync-log.mjs";
import { freshnessFields, readReplicaCounts } from "./cloud-sync-telemetry.mjs";
import { createRequire } from "node:module";

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
const dbPath = getReplicaDbPath();
const { envVar, source } = resolveNodeCloudTokenEnv();
const token = process.env[envVar];

// Fail-open no-op: a node without its token cleanly exits 0 (NOT a crash) so launchd's
// {SuccessfulExit:false} KeepAlive leaves it down rather than churning. doctor's
// replica-token check surfaces the gap by NAME. Provision the token, then re-adopt /
// kickstart to activate.
if (!token) {
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
  // close() is idempotent: stops the socket, releases the lock, closes the DB.
  void replica.close().finally(() => process.exit(0));
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

// CTL-1395: liveness + freshness telemetry. Every HEARTBEAT_INTERVAL_MS emit (a) the
// CTL-1280 `daemon heartbeat` marker — feed-independent proof the writer is alive, → the
// uptime tile (same Loki heartbeat-freshness query as the other daemons) — and (b) a
// freshness line (staleness/rows/status/cursor). This runs on EVERY node class and from
// the writer itself, so it closes the dev-node + seed-window blind spots the scheduler-only
// CTL-1366 gauge misses, and is the continuous OTL-40 "reads recovered" signal. FAIL-OPEN:
// a probe error (DB locked, mid-reconnect) must NEVER crash the writer — emit what we have.
const emitTelemetry = () => {
  try { logDaemonHeartbeat(hlog, "cloud-sync"); } catch { /* best-effort */ }
  try {
    const { rows, maxUpdatedMs } = readReplicaCounts(replica.sql);
    hlog.info(
      freshnessFields({ rows, maxUpdatedMs, status: replica.status, cursor: replica.cursor, hostName: getHostName() }),
      "cloud-sync: freshness",
    );
  } catch { /* best-effort — telemetry must never crash the writer */ }
};
emitTelemetry();
hbTimer = setInterval(emitTelemetry, HEARTBEAT_INTERVAL_MS);

// Keep the process alive: start() has resolved but background sync continues until
// close(). Without this the process would exit 0 and launchd would not restart it
// (and reads would go stale). SIGTERM is the only intended exit from here.
await new Promise(() => {});
