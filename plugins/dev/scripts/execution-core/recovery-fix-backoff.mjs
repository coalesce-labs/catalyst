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
// exceed the ledger's cooldown or this layered guard never blocks. Values are captured
// once at boot; CATALYST_-prefixed names are canonical and the CAT-47 names remain deprecated aliases.
export const RECOVERY_FIX_BACKOFF_THRESHOLD = envNum(
  ["CATALYST_RECOVERY_FIX_BACKOFF_THRESHOLD", "RECOVERY_FIX_BACKOFF_THRESHOLD"],
  3
);

// CAT-124 (Codex #3223 P2): the "BASE_MS exceeds the ledger cooldown" invariant above was
// asserted against the cooldown's 30-MINUTE DEFAULT, not against its configured value. Raising
// CATALYST_RECOVERY_COOLDOWN_MIN past 120 silently inverted it: defaultShouldSkipItem suppresses
// the ticket for the whole cooldown and inFixBackoff is only consulted AFTER that skip check, so a
// 2-hour base window had already expired by the time this guard was ever reached — the post-reset
// guard became unreachable in a fully supported configuration. Derive the floor from the cooldown
// that is actually configured instead of assuming its default.
//
// The cooldown formula is duplicated (not imported) on purpose: recovery-reasoning.mjs, which owns
// RECOVERY_COOLDOWN_MS, already imports THIS module, so importing back would close a cycle. This
// file is a zero-internal-import leaf and stays that way; the expression below is kept
// character-for-character identical to recovery-reasoning.mjs's, including the `|| default` that
// makes NaN and 0 fall through.
const RECOVERY_COOLDOWN_MS_FOR_FLOOR =
  Number(process.env.CATALYST_RECOVERY_COOLDOWN_MIN) * 60 * 1000 || 30 * 60 * 1000;

// 2x mirrors the safety factor RECOVERY_FIX_FAILURE_TTL_MS already uses for its own
// must-outlive relationship, rather than inventing a new margin. With the default cooldown
// (30m → 1h floor) this is inert: the 2h default base already clears it, so default deployments
// are byte-identical. A clamp only engages when the configured cooldown would otherwise render
// the guard dead, and it always moves in the conservative direction (suppress a repeatedly
// failing ticket for longer, never shorter).
export const RECOVERY_FIX_BACKOFF_BASE_MS = Math.max(
  envNum(["CATALYST_RECOVERY_FIX_BACKOFF_BASE_MS", "RECOVERY_FIX_BACKOFF_BASE_MS"], 2 * 60 * 60 * 1000),
  2 * RECOVERY_COOLDOWN_MS_FOR_FLOOR
);

// MAX is the ceiling the exponential windows saturate at, so it must not sit below the base it
// bounds — otherwise a clamped base would be capped straight back under the cooldown, undoing the
// floor above. RECOVERY_FIX_FAILURE_TTL_MS derives from this and so widens with it automatically.
export const RECOVERY_FIX_BACKOFF_MAX_MS = Math.max(
  envNum(["CATALYST_RECOVERY_FIX_BACKOFF_MAX_MS", "RECOVERY_FIX_BACKOFF_MAX_MS"], 24 * 60 * 60 * 1000),
  RECOVERY_FIX_BACKOFF_BASE_MS
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
  const windowMs = Math.min(
    RECOVERY_FIX_BACKOFF_BASE_MS * 2 ** exponent,
    RECOVERY_FIX_BACKOFF_MAX_MS
  );
  const until = state.lastTs + windowMs;
  return { blocked: nowMs < until, count, until, lastReason: state.lastReason ?? null };
}

export function recordFixFailure(
  orchDir,
  ticket,
  fixClass,
  failureReason,
  nowMs = Date.now(),
  { log = console.warn } = {}
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
    try {
      writeState(path, {
        lastCommentHash: prior.lastCommentHash,
        lastCommentTs: prior.lastCommentTs,
      });
    } catch {}
  } else {
    try {
      unlinkSync(path);
    } catch {}
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
