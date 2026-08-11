// CAT-47: per-(ticket, fix class) same-reason backoff and delivery-confirmed
// comment dedup. State intentionally lives outside workers/: terminal tickets
// may have no worker directory, and recoveryForgetIntent does not touch it.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function envNum(names, fallback) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw == null || raw === "") continue;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }
  return fallback;
}

// The attempts ledger owns the in-lifetime bound: threshold 3 deliberately exceeds its two
// attempts, so this history engages only after forgetIntent resets that ledger. BASE_MS must
// exceed the ledger's 30-minute cooldown or this layered guard never blocks. Values are captured
// once at boot; CATALYST_-prefixed names are canonical and the CAT-47 names remain deprecated aliases.
export const RECOVERY_FIX_BACKOFF_THRESHOLD = envNum(
  ["CATALYST_RECOVERY_FIX_BACKOFF_THRESHOLD", "RECOVERY_FIX_BACKOFF_THRESHOLD"],
  3
);
export const RECOVERY_FIX_BACKOFF_BASE_MS = envNum(
  ["CATALYST_RECOVERY_FIX_BACKOFF_BASE_MS", "RECOVERY_FIX_BACKOFF_BASE_MS"],
  2 * 60 * 60 * 1000
);
export const RECOVERY_FIX_BACKOFF_MAX_MS = envNum(
  ["CATALYST_RECOVERY_FIX_BACKOFF_MAX_MS", "RECOVERY_FIX_BACKOFF_MAX_MS"],
  24 * 60 * 60 * 1000
);

export const RECOVERY_FIX_FAILURES_DIR = ".recovery-fix-failures";

export function fixFailurePath(orchDir, ticket, fixClass) {
  return join(orchDir, RECOVERY_FIX_FAILURES_DIR, `${ticket}-${fixClass}.json`);
}

function readState(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeState(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function inFixBackoff(orchDir, ticket, fixClass, nowMs = Date.now()) {
  if (!orchDir) return { blocked: false, count: 0, until: null, lastReason: null };
  const state = readState(fixFailurePath(orchDir, ticket, fixClass));
  const count = Number.isFinite(state.count) && state.count >= 0 ? state.count : 0;
  if (count < RECOVERY_FIX_BACKOFF_THRESHOLD || !Number.isFinite(state.lastTs)) {
    return { blocked: false, count, until: null, lastReason: state.lastReason ?? null };
  }
  const exponent = Math.max(0, count - RECOVERY_FIX_BACKOFF_THRESHOLD);
  const windowMs = Math.min(RECOVERY_FIX_BACKOFF_BASE_MS * (2 ** exponent), RECOVERY_FIX_BACKOFF_MAX_MS);
  const until = state.lastTs + windowMs;
  return { blocked: nowMs < until, count, until, lastReason: state.lastReason ?? null };
}

export function recordFixFailure(
  orchDir,
  ticket,
  fixClass,
  failureReason,
  nowMs = Date.now(),
  { log = console.warn } = {},
) {
  if (!orchDir) return null;
  const path = fixFailurePath(orchDir, ticket, fixClass);
  const prior = readState(path);
  const count = prior.lastReason === failureReason ? (Number(prior.count) || 0) + 1 : 1;
  const next = { ...prior, count, lastReason: failureReason, lastTs: nowMs };
  try {
    writeState(path, next);
    return next;
  } catch (err) {
    if (typeof log === "function") log(`recovery-fix-backoff: write failed: ${err.message}`);
    return null;
  }
}

export function clearFixFailures(orchDir, ticket, fixClass) {
  if (!orchDir) return;
  const path = fixFailurePath(orchDir, ticket, fixClass);
  const prior = readState(path);
  if (prior.lastCommentHash) {
    try { writeState(path, { lastCommentHash: prior.lastCommentHash, lastCommentTs: prior.lastCommentTs }); } catch {}
  } else {
    try { unlinkSync(path); } catch {}
  }
}

export function fixCommentHash(body) {
  return createHash("sha256").update(String(body)).digest("hex");
}

export function shouldPostFixComment(orchDir, ticket, fixClass, commentHash, _nowMs = Date.now()) {
  if (!orchDir) return true;
  return readState(fixFailurePath(orchDir, ticket, fixClass)).lastCommentHash !== commentHash;
}

export function commitFixCommentHash(orchDir, ticket, fixClass, commentHash, nowMs = Date.now()) {
  if (!orchDir) return;
  const path = fixFailurePath(orchDir, ticket, fixClass);
  writeState(path, { ...readState(path), lastCommentHash: commentHash, lastCommentTs: nowMs });
}
