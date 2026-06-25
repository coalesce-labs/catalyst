// delegate-queue.mjs — CTL-1331. The intent queue + slot-reservation ledger for
// the async board-health delegate (design doc §2c, §3a, §4b-claim, §5-GC).
//
// The core scheduler tick is never allowed to spawn a heavy LLM-worker dispatch
// directly. Its only sanctioned board-health side effect is enqueueDelegateIntent
// — an atomic tmp+rename write of a `delegate-intent/v1` file at
//   <orchDir>/.delegate-queue/<TICKET>.json   { status:"queued", kind, phase, … }
// A detached delegate runner (delegate-runner.mjs / -entry.mjs, separate module)
// claims and drains these out of process. This module is PURE bookkeeping:
// atomic file writes (tmp + rename), O_EXCL/rename-based single-flight claims,
// and a dir-scan GC. Nothing here spawns, fetches, or touches the network — every
// liveness check (isBgJobAlive) and clock (now) is injected so tests are
// deterministic with no real claude/git/worktree (mirrors worktree-refresh-timer.mjs).
//
// PHASE A — LAND INERT: with an empty queue, countQueuedDelegates and
// gcDelegateIntents both return 0 → zero behavior change. Nothing here runs on
// its own; it is invoked only by the (separately-integrated) scheduler/runner.
//
// NAMESPACE: this module emits NO events. Event emission (phase.dispatch.*) is
// the caller's responsibility (the act seam / the runner). It never emits
// phase.recovery-pass.* — only the worker emits completion.

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { log } from "./config.mjs";

// The queue dir name, derived from orchDir exactly like recovery-reasoning.mjs
// derives `.recovery-intents/` (recoveryIntentPath: join(orchDir, ".recovery-intents", …)).
export const DELEGATE_QUEUE_DIR = ".delegate-queue";

// Hard GC ceiling for a stale intent (design §5.4 / §7 CATALYST_DELEGATE_INTENT_TTL_MS).
export const DEFAULT_INTENT_TTL_MS = 1_800_000; // 30 min

// Stale-claim reclaim window (design §4 / CATALYST_DISPATCH_TIMEOUT_MS = 15 min).
// A `claimed-*` sidecar older than one ceiling window is renamed back to queued.
export const DEFAULT_CLAIM_CEILING_MS = 900_000; // 15 min

export const INTENT_SCHEMA = "delegate-intent/v1";

// Statuses that hold a slot reservation (counted by countQueuedDelegates) and
// block a re-enqueue (idempotency layer 1). `launched` is non-terminal for
// re-enqueue blocking but NOT counted as a reservation (its claude --bg session
// is now visible to liveBackgroundCount — see design §3b "disjoint by status").
const RESERVING_STATUSES = new Set(["queued", "claimed"]);
const NON_TERMINAL_STATUSES = new Set(["queued", "claimed", "launched"]);

// ── path helpers ─────────────────────────────────────────────────────────────

export function delegateQueueDir(orchDir) {
  return join(orchDir, DELEGATE_QUEUE_DIR);
}

function intentPath(orchDir, ticket) {
  return join(delegateQueueDir(orchDir), `${ticket}.json`);
}

// ── atomic write (tmp + rename) ──────────────────────────────────────────────

function atomicWriteIntent(orchDir, ticket, body) {
  const dir = delegateQueueDir(orchDir);
  mkdirSync(dir, { recursive: true });
  const finalPath = intentPath(orchDir, ticket);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(body));
  renameSync(tmpPath, finalPath);
}

// readIntentFile — parse one queue file; null on absent/malformed (never throws).
function readIntentFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// resolveMaxParallel — maxParallel may be a number or a () => number source.
function resolveMaxParallel(src) {
  const v = typeof src === "function" ? src() : src;
  return Number.isFinite(v) ? v : Infinity;
}

// ── live-worker idempotency probe (design §2c-3) ─────────────────────────────
//
// A live recovery-pass worker for the anchor already exists when
// workers/<TICKET>/phase-recovery-pass.json is dispatched|running AND its
// bg_job_id is alive per the injected isBgJobAlive. Reads the signal file
// directly (the same shape phase-agent-dispatch writes: {status, bg_job_id}).
function recoveryPassWorkerLive(orchDir, ticket, isBgJobAlive) {
  const signalPath = join(orchDir, "workers", ticket, "phase-recovery-pass.json");
  const sig = readIntentFile(signalPath);
  if (!sig) return false;
  if (sig.status !== "dispatched" && sig.status !== "running") return false;
  const bgJobId = sig.bg_job_id ?? null;
  if (!bgJobId) return false;
  try {
    return isBgJobAlive(bgJobId) === true;
  } catch {
    return false;
  }
}

// ── enqueueDelegateIntent (design §2b/§2c) ───────────────────────────────────
//
// Atomic tmp+rename write of a delegate-intent/v1 file with status:"queued".
// THREE idempotency no-ops checked BEFORE writing (return {enqueued:false, reason}):
//   1. a non-terminal intent file already exists (queued|claimed|launched) → already-pending
//   2. a live recovery-pass worker for the anchor already exists           → worker-live
//   3. hard ceiling: countQueuedDelegates >= maxParallel                   → queue-full
//
// deps: { orchDir, isBgJobAlive, now, maxParallel }.
export function enqueueDelegateIntent(anchor, payload = {}, deps = {}) {
  const orchDir = deps.orchDir;
  if (!orchDir) return { enqueued: false, reason: "no-orch-dir" };
  if (!anchor) return { enqueued: false, reason: "no-anchor" };

  const now = deps.now ?? (() => Date.now());
  const isBgJobAlive = deps.isBgJobAlive ?? (() => false);

  // (1) queue-file existence — one non-terminal intent per anchor.
  const existing = readIntentFile(intentPath(orchDir, anchor));
  if (existing && NON_TERMINAL_STATUSES.has(existing.status)) {
    return { enqueued: false, reason: "already-pending" };
  }

  // (2) live recovery-pass worker — never even queue a redundant run.
  if (recoveryPassWorkerLive(orchDir, anchor, isBgJobAlive)) {
    return { enqueued: false, reason: "worker-live" };
  }

  // (3) hard ceiling — reservation can never exceed the whole board.
  const max = resolveMaxParallel(deps.maxParallel);
  if (countQueuedDelegates(orchDir) >= max) {
    return { enqueued: false, reason: "queue-full" };
  }

  const intent = {
    schema: INTENT_SCHEMA,
    ticket: anchor,
    status: "queued",
    kind: payload.kind ?? null,
    phase: payload.phase ?? null,
    boardContext: payload.boardContext ?? null,
    reason: payload.reason ?? null,
    enqueuedAt: now(),
  };

  try {
    atomicWriteIntent(orchDir, anchor, intent);
  } catch (err) {
    log.warn({ anchor, err: err.message }, "delegate-queue: enqueue write failed");
    return { enqueued: false, reason: "write-failed" };
  }
  return { enqueued: true, reason: "enqueued" };
}

// ── countQueuedDelegates (design §3a — the slot reservation) ──────────────────
//
// The number of .delegate-queue/*.json whose status is queued OR claimed (NOT
// launched/failed/superseded). Disjoint from liveBackgroundCount by status:
// once an intent flips to `launched`, its claude --bg session is counted there
// instead. Missing dir / malformed files → ignored. Never throws.
export function countQueuedDelegates(orchDir) {
  if (!orchDir) return 0;
  let entries;
  try {
    entries = readdirSync(delegateQueueDir(orchDir));
  } catch {
    return 0; // missing dir
  }
  let n = 0;
  for (const name of entries) {
    // Canonical intent files only: exactly <TICKET>.json (skip claim sidecars
    // like <TICKET>.json.claimed-… and tmp-… artifacts).
    if (!name.endsWith(".json") || name.includes(".json.")) continue;
    const intent = readIntentFile(join(delegateQueueDir(orchDir), name));
    if (intent && RESERVING_STATUSES.has(intent.status)) n++;
  }
  return n;
}

// ── gcDelegateIntents (design §5.4 — release stale/terminal reservations) ─────
//
// Removes intents whose worker signal reached a terminal phase-recovery-pass.json,
// OR whose bg_job_id is dead (injected isBgJobAlive), OR older than a TTL
// (default DEFAULT_INTENT_TTL_MS, injectable via deps.ttlMs). Returns count
// removed. Pure dir-scan + unlink — no spawn. Leaves live queued/claimed and
// launched-with-live-bg intents within TTL.
//
// deps: { isBgJobAlive, ttlMs }.
export function gcDelegateIntents(orchDir, now, deps = {}) {
  if (!orchDir) return 0;
  const dir = delegateQueueDir(orchDir);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // missing dir
  }
  const ttlMs = Number.isFinite(deps.ttlMs) ? deps.ttlMs : DEFAULT_INTENT_TTL_MS;
  const isBgJobAlive = deps.isBgJobAlive ?? (() => false);
  const nowMs = typeof now === "number" ? now : Date.now();

  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith(".json") || name.includes(".json.")) continue;
    const path = join(dir, name);
    const intent = readIntentFile(path);
    if (!intent) continue; // leave malformed/foreign files alone

    let drop = false;

    // (a) hard TTL — any intent older than the ceiling, regardless of status.
    const stamp =
      typeof intent.launchedAt === "number"
        ? intent.launchedAt
        : typeof intent.enqueuedAt === "number"
          ? intent.enqueuedAt
          : null;
    if (stamp !== null && nowMs - stamp >= ttlMs) drop = true;

    // (b) worker reached a terminal recovery-pass signal.
    if (!drop && workerSignalTerminal(orchDir, intent.ticket)) drop = true;

    // (c) launched intent whose bg job is dead (the live count no longer covers it).
    if (!drop && intent.status === "launched") {
      const bgJobId = intent.bg_job_id ?? null;
      let alive = false;
      try {
        alive = bgJobId ? isBgJobAlive(bgJobId) === true : false;
      } catch {
        alive = false;
      }
      if (!alive) drop = true;
    }

    if (drop) {
      try {
        unlinkSync(path);
        removed++;
      } catch {
        /* already gone / unremovable — best effort */
      }
    }
  }
  return removed;
}

// workerSignalTerminal — true when workers/<TICKET>/phase-recovery-pass.json has
// reached a terminal status (the worker finished). Mirrors the phantom-dir
// terminal-success set + the failure/abort terminals.
const TERMINAL_RECOVERY_PASS = new Set([
  "done",
  "complete",
  "skipped",
  "failed",
  "aborted",
  "stalled",
]);
function workerSignalTerminal(orchDir, ticket) {
  if (!ticket) return false;
  const signalPath = join(orchDir, "workers", ticket, "phase-recovery-pass.json");
  const sig = readIntentFile(signalPath);
  if (!sig) return false;
  return TERMINAL_RECOVERY_PASS.has(sig.status);
}

// ── claimIntent (design §4b-claim — O_EXCL/rename single-flight) ──────────────
//
// Atomically claim a queued intent by renaming
//   <TICKET>.json  →  <TICKET>.json.claimed-<pid>-<ts>
// renameSync of a single source inode is atomic: exactly one concurrent racer
// wins; the loser's source is already gone → rename throws → {claimed:false}.
// (Mirrors phase-agent-dispatch's CTL-736 single-flight discipline: a rename
// that one and only one racer can complete.)
export function claimIntent(orchDir, ticket, pid, ts) {
  const from = intentPath(orchDir, ticket);
  const claimPath = `${from}.claimed-${pid}-${ts}`;
  try {
    renameSync(from, claimPath);
  } catch {
    // source absent (already claimed by a racer, or never existed) → lost.
    return { claimed: false };
  }
  return { claimed: true, claimPath };
}

// ── transitionIntent (design §4b — persist status changes) ───────────────────
//
// Persist a status change for a claimed intent. Reads the `from` sidecar (the
// claimed-* path), merges the new fields, atomically writes the canonical
// <TICKET>.json with the new status, and removes the consumed sidecar. Used by
// the runner to flip claimed → launched (bg_job_id/worktreePath/launchedAt) or
// claimed → failed (reason). Atomic tmp+rename for the canonical write.
export function transitionIntent(orchDir, ticket, opts = {}) {
  const { from, status, ...rest } = opts;
  if (!status) return { ok: false, reason: "no-status" };
  let prior = {};
  if (from) {
    prior = readIntentFile(from) ?? {};
  } else {
    prior = readIntentFile(intentPath(orchDir, ticket)) ?? {};
  }
  const next = {
    schema: prior.schema ?? INTENT_SCHEMA,
    ticket: prior.ticket ?? ticket,
    ...prior,
    ...rest,
    status,
  };
  try {
    atomicWriteIntent(orchDir, ticket, next);
  } catch (err) {
    log.warn({ ticket, err: err.message }, "delegate-queue: transition write failed");
    return { ok: false, reason: "write-failed" };
  }
  // Remove the consumed claim sidecar (best-effort; never block on it).
  if (from && from !== intentPath(orchDir, ticket)) {
    try {
      unlinkSync(from);
    } catch {
      /* already gone */
    }
  }
  return { ok: true };
}

// ── reclaimStaleClaims (design §4b crash-safety) ─────────────────────────────
//
// A `claimed-<pid>-<ts>` sidecar left by a crashed runner older than one ceiling
// window (default DEFAULT_CLAIM_CEILING_MS, injectable) is renamed back to the
// canonical <TICKET>.json with status:"queued" so the next cycle re-claims it.
// The claim timestamp is parsed from the sidecar filename suffix. Returns count
// reclaimed. Pure rename — no spawn. Never throws.
export function reclaimStaleClaims(orchDir, now, ceilingMs = DEFAULT_CLAIM_CEILING_MS) {
  if (!orchDir) return 0;
  const dir = delegateQueueDir(orchDir);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  const nowMs = typeof now === "number" ? now : Date.now();
  let reclaimed = 0;

  for (const name of entries) {
    // <TICKET>.json.claimed-<pid>-<ts>
    const m = name.match(/^(.+)\.json\.claimed-\d+-(\d+)$/);
    if (!m) continue;
    const ticket = m[1];
    const ts = Number(m[2]);
    if (!Number.isFinite(ts)) continue;
    if (nowMs - ts < ceilingMs) continue; // still within the window — leave it

    const claimPath = join(dir, name);
    const finalPath = intentPath(orchDir, ticket);
    const sidecar = readIntentFile(claimPath) ?? {};
    const requeued = {
      schema: sidecar.schema ?? INTENT_SCHEMA,
      ticket: sidecar.ticket ?? ticket,
      ...sidecar,
      status: "queued",
    };
    try {
      // Atomic-ish: write the canonical queued file, then drop the stale sidecar.
      atomicWriteIntent(orchDir, ticket, requeued);
      unlinkSync(claimPath);
      reclaimed++;
    } catch {
      /* concurrent reclaim / unremovable — best effort */
    }
  }
  return reclaimed;
}
