// stop-worker.mjs — the read-model's ONE destructive endpoint helper (CTL-890,
// BFF8 — the design's P10, gated last).
//
// The ⌘K palette's `⛔ Stop worker` action has no substrate today: the underlying
// `claude stop <shortId>` is known-flaky (the per-job pid file is absent on Claude
// Code 2.1.152, the spare-pool model). This module backs `POST /api/ec-worker/
// <ticket>/stop` with the full design §3.4 contract for the only write-action in
// the redesign:
//
//   1. TYPED CONFIRM — the operator must type the ticket id back; the endpoint
//      refuses unless the typed token matches the path ticket exactly. The
//      response always echoes the exact { shortId, ticket, phase } so the UI can
//      show the operator precisely what they are about to kill (no ambiguity
//      about which run).
//   2. FENCE-AWARE (multi-node requirement) — before issuing the kill, the
//      endpoint passes a cross-host fence-check (cluster-claim.mjs fence-check
//      <ticket> <generation>, exit FENCE_STALE_EXIT=10 ⇒ stale). A stop request
//      that originates from a partitioned / stale-generation node is REJECTED so a
//      zombie node can't kill a worker the cluster has already taken over.
//      SINGLE-HOST (hosts.json absent / length ≤ 1) ⇒ the fence-check is an
//      identity NO-OP pass: there is no other node, so the stop proceeds normally
//      with ZERO added latency and no subprocess (the single-node MVP path).
//   3. The actual kill wraps `claude stop <shortId>` where shortId is the 8-char
//      form derived from the run signal's bg_job_id (the daemon's existing
//      termination primitive — claude-agents.mjs::claudeStop; `claude stop`
//      rejects full UUIDs, so we truncate).
//
// OPTIMISTIC ROLLBACK is a UI-side timer (design §3.4: roll back if the next
// board frame still shows the worker `working` after ~10s) — the endpoint's job
// is to (a) fire the kill, (b) return the verbatim { shortId, ticket, phase }
// identity + the issued/stale outcome so the client can mark the worker
// `stopping` optimistically and arm its rollback timer against the live board.
//
// READ-then-ACT, fail-safe: a missing run signal → 404 (nothing to stop); a
// missing bg_job_id → the run never had a live background session → 409 (no live
// session to stop), never a blind `claude stop` of an empty id; a verified-stale
// fence → 409 fenced; an indeterminate fence (multi-host, fence CLI errored) →
// 409 (do NOT kill on an unconfirmed fence — the conservative answer for a
// destructive action). All filesystem / subprocess / fence collaborators are
// injectable so the route + unit tests drive this without a real worker, a real
// hosts.json, or a real `claude` binary.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { shortIdFromSessionId } from "../../execution-core/claude-ids.mjs";
import { readPhaseSignalVerbatim } from "./ticket-runs.mjs";

// Mirror cluster-claim.mjs's exit contract: the fence CLI exits 10 when the
// generation we asked about is no longer the current claim generation (stale).
const FENCE_STALE_EXIT = 10;

// Absolute path to the cross-host fence CLI, resolved relative to this module so
// it works regardless of the server's cwd (same resolution cluster-claim-sync.mjs
// uses for the claim CLI).
const CLUSTER_CLAIM_CLI = fileURLToPath(
  new URL("../../execution-core/cluster-claim.mjs", import.meta.url),
);

// Hard cap on the fence subprocess (the soft-CAS read is up to a couple of Linear
// round-trips). Generous for a healthy API; bounds a hung call so a stuck fence
// read can't wedge the request handler. Env-overridable for tests / slow networks.
const FENCE_TIMEOUT_MS = Number(process.env.EXECUTION_CORE_CLAIM_TIMEOUT_MS) || 15_000;

// ── single-host detection (the identity no-op gate) ──────────────────────────
// readClusterHostCount — how many hosts are in the committed cluster roster
// (<repoRoot>/.catalyst/hosts.json, a JSON array of host names). Mirrors
// execution-core/config.mjs::getClusterHosts's tolerance: an absent / unreadable
// / malformed / non-array / empty-array roster collapses to the SINGLE-HOST
// default of 1. Kept LOCAL (not imported from config.mjs) so the orch-monitor
// package stays self-contained and PR-order-independent; the externalities are
// the env var + the file read, both injectable. Never throws.
export function readClusterHostCount({
  env = process.env,
  read = readFileSync,
} = {}) {
  const cfgFile = env.CATALYST_CONFIG_FILE;
  // <repoRoot>/.catalyst/config.json → <repoRoot>/.catalyst (else cwd/.catalyst)
  const catalystDir = cfgFile ? resolve(cfgFile, "..") : resolve(process.cwd(), ".catalyst");
  try {
    const raw = read(resolve(catalystDir, "hosts.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const hosts = parsed.filter((h) => typeof h === "string" && h.length > 0);
      if (hosts.length > 0) return hosts.length;
    }
  } catch {
    /* absent/malformed roster → single-host default */
  }
  return 1;
}

// ── fence-check (single-host no-op pass; multi-host CLI) ──────────────────────
// runFenceCheck — is `generation` still the CURRENT fence for `ticket`?
// Returns a discriminated outcome:
//   { ok: true,  noop: true }               → single-host: identity no-op pass.
//   { ok: true,  noop: false }              → multi-host: fence CLI exit 0 (current).
//   { ok: false, stale: true }              → multi-host: fence CLI exit 10 (stale).
//   { ok: false, stale: false }             → multi-host: any other failure / a
//                                              null generation we can't fence-check
//                                              (indeterminate → fail-closed).
//
// In the SINGLE-HOST MVP this NEVER spawns a subprocess — `hostCount <= 1` short-
// circuits to the no-op pass with zero added latency, exactly the non-cluster
// path. The N>1 branch is the only place the fence CLI runs.
//
// `hostCount`/`spawn`/`nodeBin`/`cli`/`env`/`timeout` are injectable; tests drive
// both branches without a real hosts.json or a real subprocess.
export function runFenceCheck(
  { ticket, generation },
  {
    hostCount = readClusterHostCount(),
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = CLUSTER_CLAIM_CLI,
    env = process.env,
    timeout = FENCE_TIMEOUT_MS,
  } = {},
) {
  // Single-host identity no-op: no other node exists, nothing to fence out.
  if (hostCount <= 1) return { ok: true, noop: true, stale: false };

  // Multi-host: a missing generation can't be affirmatively fence-checked — for a
  // destructive action, fail-closed (treat as not-current, but not verified-stale).
  if (typeof generation !== "number" || !Number.isFinite(generation)) {
    return { ok: false, noop: false, stale: false };
  }

  try {
    const res = spawn(nodeBin, [cli, "fence-check", ticket, String(generation)], {
      encoding: "utf8",
      env,
      timeout,
    });
    if (res && res.status === 0) return { ok: true, noop: false, stale: false };
    if (res && res.status === FENCE_STALE_EXIT) {
      return { ok: false, noop: false, stale: true };
    }
    // Indeterminate (spawn error, timeout, other non-zero): fail-closed.
    return { ok: false, noop: false, stale: false };
  } catch {
    return { ok: false, noop: false, stale: false };
  }
}

// ── the kill primitive ───────────────────────────────────────────────────────
// claudeStop — `claude stop <shortId>`. shortId MUST be the 8-char form (`claude
// stop` rejects full UUIDs with rc=1). Returns { ok, error? }; never throws.
// Local mirror of execution-core/claude-agents.mjs::claudeStop so this lib carries
// no dependency on that module's TTL-cache / agents-list machinery.
const CLAUDE_BIN = process.env.CATALYST_DISPATCH_CLAUDE_BIN || "claude";
export function claudeStop(shortId, { spawn = spawnSync } = {}) {
  try {
    const res = spawn(CLAUDE_BIN, ["stop", shortId], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if ((res?.status ?? 0) === 0) return { ok: true };
    return { ok: false, error: res?.stderr?.trim() || `claude stop rc=${res?.status}` };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// ── orchestration: the endpoint body ─────────────────────────────────────────
// stopWorker — drive the full P10 contract for `POST /api/ec-worker/<ticket>/<phase>/stop`.
// Outcome is a discriminated result the route maps to an HTTP status:
//   { status: "not_found" }                          → 404: no run signal on disk.
//   { status: "confirm_mismatch", expected }         → 400: typed confirm wrong.
//   { status: "no_session", ticket, phase }          → 409: run never had a live
//                                                       bg session (no bg_job_id /
//                                                       unparseable id) — nothing
//                                                       to kill, never a blind stop.
//   { status: "fenced", ticket, phase, shortId }     → 409: a verified-stale fence
//                                                       (exit 10) — a partitioned
//                                                       node is rejected.
//   { status: "fence_indeterminate", ticket, phase, shortId }
//                                                     → 409: multi-host fence could
//                                                       not be confirmed — refuse
//                                                       (don't kill on uncertainty).
//   { status: "stop_failed", ticket, phase, shortId, error }
//                                                     → 502: `claude stop` errored.
//   { status: "stopping", ticket, phase, shortId, fenceNoop }
//                                                     → 200: kill issued; UI marks
//                                                       the worker `stopping` and
//                                                       arms its ~10s optimistic-
//                                                       rollback timer.
//
// `readSignal`/`fenceCheck`/`stop` are injectable so tests cover every branch
// without a real signal, a real fence, or a real `claude`.
export async function stopWorker(
  { ticket, phase, confirm },
  {
    readSignal = readPhaseSignalVerbatim,
    fenceCheck = runFenceCheck,
    stop = claudeStop,
  } = {},
) {
  // Read the run signal first — it is BOTH the existence check and the source of
  // the shortId + generation we need. 404 when the phase has no signal on disk.
  const sig = await readSignal(ticket, phase);
  if (!sig || typeof sig !== "object") {
    return { status: "not_found" };
  }

  // The exact run identity the UI must show in the typed-confirm dialog. shortId is
  // derived below; ticket/phase come from the path (validated by the route).
  // Typed confirm: the operator must type the ticket id back, exactly.
  if (confirm !== ticket) {
    return { status: "confirm_mismatch", expected: ticket };
  }

  // Derive the 8-char shortId from the run's bg_job_id (the live background
  // session). No bg_job_id (a run that never spawned a bg session, or a finished
  // run whose id was cleared) ⇒ nothing to stop — 409, never a blind kill.
  const bgJobId = sig.bg_job_id;
  let shortId;
  try {
    shortId = shortIdFromSessionId(bgJobId);
  } catch {
    return { status: "no_session", ticket, phase };
  }

  // Fence-aware guard (single-host no-op pass; multi-host CLI). The generation we
  // fence-check is the run signal's own generation.
  const generation = typeof sig.generation === "number" ? sig.generation : null;
  const fence = fenceCheck({ ticket, generation });
  if (!fence.ok) {
    return fence.stale
      ? { status: "fenced", ticket, phase, shortId }
      : { status: "fence_indeterminate", ticket, phase, shortId };
  }

  // Fence current (or no-op single-host): issue the kill.
  const res = stop(shortId);
  if (!res.ok) {
    return { status: "stop_failed", ticket, phase, shortId, error: res.error };
  }
  return { status: "stopping", ticket, phase, shortId, fenceNoop: fence.noop === true };
}
