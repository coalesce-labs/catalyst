// cloud-sync-telemetry.mjs — CTL-1395. Pure helpers for the catalyst-cloud-sync writer's
// freshness telemetry, factored out of the (script-shaped) cloud-sync.mjs so the staleness
// math + field shape are unit-testable without running the writer. CTL-1508 adds the
// exit-safety (`exitAfterClose`) and self-heal-breadcrumb helpers here for the same reason.
import { renameSync, unlinkSync, writeFileSync } from "node:fs";

// freshnessFields — build the structured log fields for one `cloud-sync: freshness` line.
// Semconv-conformant dotted keys (the OTEL logs→metrics connector keys on these). NAME-only
// data — no secrets. `maxUpdatedMs` is the newest mirrored issue `updated_at` (epoch-ms) or
// null; staleness is whole seconds since then (null when unknown — never a bogus number).
// `lastFrameAt` (CTL-1508, SDK 0.6.0 `replica.lastFrameAt`) is the epoch-ms of the last
// inbound socket frame of ANY kind; frame_staleness mirrors the staleness idiom — whole
// seconds since then, null when unknown (older SDK / pre-first-frame / reader mode).
export function freshnessFields({ rows = null, maxUpdatedMs = null, status = null, cursor = null, hostName = null, lastFrameAt = null, now = Date.now() } = {}) {
  const mx = Number(maxUpdatedMs);
  const staleness =
    Number.isFinite(mx) && mx > 0 ? Math.max(0, Math.round((now - mx) / 1000)) : null;
  const lf = Number(lastFrameAt);
  const frameStaleness =
    Number.isFinite(lf) && lf > 0 ? Math.max(0, Math.round((now - lf) / 1000)) : null;
  return {
    "catalyst.linear.replica.staleness": staleness,
    "catalyst.linear.replica.rows": rows == null ? null : Number(rows) || 0,
    "catalyst.linear.replica.status": status ?? null,
    "catalyst.linear.replica.cursor": cursor ?? null,
    "catalyst.linear.replica.frame_staleness": frameStaleness,
    "host.name": hostName ?? null,
  };
}

// The LiveSyncStatus values the SDK surfaces (live-sync-client.d.ts:
// "connecting" | "live" | "reconnecting" | "resyncing" | "error" | "stopped") that mean
// the TRANSPORT is not healthy — an INDEPENDENT liveness failure derived from the
// WebSocket lifecycle (onopen/onclose/onerror/reconnect), NOT from cursor-advance. A
// stuck-reconnecting / errored / stopped socket is a genuine liveness failure; "live",
// "connecting", and "resyncing" are healthy/transient-healthy tailing states.
export const UNHEALTHY_SDK_STATUSES = new Set(["reconnecting", "error", "stopped"]);

// classifyStall — decide the cloud-sync writer's stall posture from cursor-advance AND
// an INDEPENDENT transport-liveness signal. Cursor-silence ALONE is AMBIGUOUS: a healthy
// QUIET feed (no Linear changes for the window) and a dead/half-open socket BOTH freeze
// `replica.cursor` — replica-read.mjs:102-118 documents exactly this (the `-wal`/apply
// cadence goes stale on a quiet feed, which is why writer liveness keys on the
// `.writer.lock` heartbeat, not cursor movement). So we must NEVER page or self-heal
// (restart) on cursor-silence alone: that false-kills a perfectly current idle node every
// quiet window (Codex P1/P2) and re-seeds/pages needlessly. Two independent confirmations
// the cursor can't fake, EITHER of which upgrades cursor-silence to a genuine stall:
//   (a) the SDK's own connection status is unhealthy (reconnecting/error/stopped) — the
//       original CTL-1420 gate, derived from the WebSocket lifecycle; and
//   (b) CTL-1508 (SDK 0.6.0): `lastFrameAt` — epoch-ms of the last inbound frame of ANY
//       kind — has ALSO been frozen for the whole frameStallMs window. Crucially the
//       CTC-135 watchdog's auto-pongs stamp lastFrameAt too (unlike lastChangeFrameAt,
//       which ignores pongs), and the SDK pings after ~90s of idle silence — so a healthy
//       quiet feed keeps lastFrameAt fresh via ping/pong and a lastFrameAt frozen across a
//       10-minute window is something a healthy socket CANNOT produce. This catches the
//       18.5h-RCA half-open socket whose `status` sat latched "live" (onclose never fired),
//       which gate (a) alone was blind to.
// Feature-detected: older SDKs (< 0.6.0) pass lastFrameAt null/undefined and the result is
// BIT-IDENTICAL to the status-only classifier — frame-silence simply never asserts.
//   • cursor advanced within the window                 → healthy (no alert, no restart)
//   • cursor stalled, SDK status healthy, frames fresh  → AMBIGUOUS quiet feed → NO alert,
//        NO restart (surface the cursor-stall only as observational freshness telemetry)
//   • cursor stalled AND (unhealthy status OR frame-silence) → GENUINE stall (independent
//        confirmation) → loud ERROR alert + self-heal restart
export function classifyStall({ rows = null, stalledMs = 0, stallMs = 600_000, status = null, lastFrameAt = null, frameStallMs = stallMs, now = Date.now() } = {}) {
  const cursorStalled = (rows ?? 0) > 0 && stalledMs >= stallMs;
  const sdkUnhealthy = UNHEALTHY_SDK_STATUSES.has(String(status));
  // Frame-silence is only meaningful when the SDK actually surfaces lastFrameAt (finite
  // number). null/undefined (older SDK, pre-first-frame, reader mode) must NEVER assert —
  // that keeps the classifier bit-identical to CTL-1420 behavior for older SDKs.
  const frameSilent = Number.isFinite(lastFrameAt) && now - lastFrameAt >= frameStallMs;
  // A GENUINE stall needs cursor-silence PLUS at least one independent transport-liveness
  // failure — either the SDK admits the socket is unhealthy, or the socket has produced NO
  // inbound bytes (not even watchdog pongs) for the whole window while claiming health.
  const genuine = cursorStalled && (sdkUnhealthy || frameSilent);
  return {
    cursorStalled,
    sdkUnhealthy,
    frameSilent,
    genuine,
    alert: genuine, // page ONLY on a genuine stall — never on a quiet-but-healthy feed
    restart: genuine, // self-heal ONLY on a genuine stall — never false-kill an idle node
    // The freshness-line status: surface a genuine stall loudly; otherwise reflect the
    // SDK's own status (a quiet feed keeps reporting its real "live"/… status honestly).
    displayStatus: genuine ? "stalled" : status ?? "live",
  };
}

// readReplicaCounts — run the single freshness query against a read-model SqlExecutor
// (`replica.sql`). Returns { rows, maxUpdatedMs }, both null on any failure (fail-open:
// a locked / mid-apply DB must never throw out of the writer's telemetry timer).
export function readReplicaCounts(sql) {
  try {
    const row = sql.exec("SELECT COUNT(*) AS n, MAX(updated_at) AS mx FROM issues").toArray()[0];
    const rows = Number(row?.n) || 0;
    // row.mx is null on an empty table; Number(null) === 0 (a finite-but-bogus epoch), so
    // guard the null BEFORE Number() — an empty replica must report maxUpdatedMs null.
    const mxRaw = row?.mx;
    const mx = mxRaw == null ? NaN : Number(mxRaw);
    return { rows, maxUpdatedMs: Number.isFinite(mx) ? mx : null };
  } catch {
    return { rows: null, maxUpdatedMs: null };
  }
}

// exitAfterClose — CTL-1508: bound an exit-path `replica.close()` with a hard deadline.
// RCA: both writer exit paths (`SIGTERM shutdown` and the genuine-stall self-heal) did
// `void replica.close().finally(() => process.exit(N))` with NO timeout — but the stall
// path's close() runs over the very dead/half-open socket that CAUSED the stall, the
// close() most likely to never settle. A hung close() stranded the process half-dead
// (hbTimer already cleared, so even heartbeats stopped) and launchd never re-spawned it
// because it never exited. Races closePromise against a deadline timer and calls
// exit(exitCode) EXACTLY ONCE, whichever settles first; a rejected close() also exits
// (the exit code is the contract, the close outcome is best-effort). Additionally arms an
// unref'd failsafe timer at timeoutMs+1000 — belt-and-braces so even a wedged microtask
// queue (the promise callbacks never running) cannot strand the process: timer callbacks
// are macrotasks and still fire. unref'd so the failsafe itself never holds an otherwise
// finished process open. Injectable exit/setTimeoutFn so tests never call the real ones.
export function exitAfterClose({ closePromise, exitCode, timeoutMs = 3_000, exit = process.exit, setTimeoutFn = setTimeout } = {}) {
  let fired = false;
  const fire = () => {
    if (fired) return; // exactly-once: the losers of the race become no-ops
    fired = true;
    exit(exitCode);
  };
  const deadline = setTimeoutFn(fire, timeoutMs);
  const failsafe = setTimeoutFn(fire, timeoutMs + 1_000);
  // unref where supported (fake test timers may not implement it): the failsafe must not
  // keep the process alive on its own; the primary deadline stays ref'd — it is the
  // guarantee that the event loop cannot drain before the exit happens.
  if (typeof failsafe?.unref === "function") failsafe.unref();
  void deadline; // ref'd on purpose (see above)
  // .then(fire, fire): exit on resolve AND on reject, without an unhandled-rejection.
  Promise.resolve(closePromise).then(fire, fire);
}

// --- CTL-1508 self-heal breadcrumb ---------------------------------------------------
// Cross-ticket contract (consumed by CTL-1509's external responder and doctor): when the
// writer self-heals (genuine-stall exit 1), it drops `~/catalyst/cloud-sync.selfheal.json`
// BEFORE initiating close, and the NEXT boot deletes it on reaching 'live'. Therefore:
//   breadcrumb present + writer process ABSENT → launchd did NOT re-spawn the writer
//     (the launchd-no-respawn signature an external responder pages on);
//   breadcrumb present + writer alive          → restart in progress / re-seeding (normal);
//   breadcrumb absent                          → no self-heal pending.
// Shape: { ts, cursor, stalledMs, sdkStatus, expectRestart: true } (ts = epoch-ms of the
// self-heal decision). Both helpers are FAIL-OPEN (return false, never throw): the
// breadcrumb must never block the exit, and a missing file on clear is the normal case.

// writeSelfHealBreadcrumb — atomic tmp+rename (the writeBootMarker idiom, recovery.mjs):
// CTL-1509's responder reads this file from another process, so it must never observe a
// torn write. fs deps injectable for tests.
export function writeSelfHealBreadcrumb(path, { cursor = null, stalledMs = null, sdkStatus = null } = {}, { writeFile = writeFileSync, rename = renameSync, now = Date.now } = {}) {
  try {
    const tmp = `${path}.tmp`;
    writeFile(tmp, JSON.stringify({ ts: now(), cursor, stalledMs, sdkStatus, expectRestart: true }));
    rename(tmp, path);
    return true;
  } catch {
    return false; // fail-open — the self-heal exit proceeds breadcrumb-less
  }
}

// clearSelfHealBreadcrumb — consumed on the next boot's 'live' (restart proven to work).
export function clearSelfHealBreadcrumb(path, { unlink = unlinkSync } = {}) {
  try {
    unlink(path);
    return true;
  } catch {
    return false; // fail-open — ENOENT (no pending self-heal) is the normal case
  }
}
