// stale-lock.mjs — age-gated detection of a stale git index.lock in a plugin
// checkout (CTL-1415).
//
// A git operation that crashes mid-write leaves `.git/index.lock` behind. Every
// later `git reset --hard` in that checkout then fails with
// "Unable to create '.../index.lock': File exists" — silently freezing plugin
// pulls, so the node quietly stays on stale plugins with no signal. During
// CTL-1401 the laptop sat ~8.5h behind origin/main on exactly this.
//
// This module is the ONE age-gate that both consumers share:
//   - broker/plugin-refresh.mjs   CLEARS the stale lock before it pulls
//   - execution-core/doctor.mjs   REPORTS the stale-lock condition
// so the "safe age" threshold can never drift between what the updater clears
// and what doctor flags.
//
// Pure + seam-injected (statFn, now): no real fs/clock is needed to unit-test
// the classification. Mirrors the ingestion-recency.mjs / plugin-refresh.mjs
// seam-injection convention.

import { statSync } from "node:fs";
import { resolve } from "node:path";

// Safe-age threshold. A git op holding index.lock completes in seconds (this
// repo hard-caps every git call at 20s — CTL-990); a lock older than this was
// orphaned by a crashed process. 10 min stays well clear of any legitimate op
// (including a human running git by hand in the checkout) while capping the
// self-heal latency to roughly one updater poll past the threshold. Far below
// the multi-hour freeze it heals. Env-overridable.
export const STALE_LOCK_THRESHOLD_MS =
  Number(process.env.CATALYST_PLUGIN_STALE_LOCK_MS) || 600_000;

// indexLockPath — the git index lock inside a checkout root.
export function indexLockPath(root) {
  return resolve(root, ".git", "index.lock");
}

// defaultStatFn — mtime epoch-ms of a path, or null when absent/unstattable.
// Swallows ENOENT (the common "no lock" case) and any other stat error so the
// classifier is total (never throws).
function defaultStatFn(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * staleLockStatus — classify a checkout's index.lock WITHOUT touching it.
 *
 * @returns {{present: boolean, ageMs: number|null, stale: boolean}}
 *   present: a lock file exists
 *   ageMs:   now - lock mtime, clamped ≥0 for clock skew (null when absent)
 *   stale:   present AND ageMs >= thresholdMs (safe to clear / worth flagging)
 */
export function staleLockStatus({
  root,
  now = Date.now(),
  thresholdMs = STALE_LOCK_THRESHOLD_MS,
  statFn = defaultStatFn,
} = {}) {
  if (!root) return { present: false, ageMs: null, stale: false };
  const mtimeMs = statFn(indexLockPath(root));
  if (mtimeMs == null) return { present: false, ageMs: null, stale: false };
  const ageMs = Math.max(0, now - mtimeMs);
  return { present: true, ageMs, stale: ageMs >= thresholdMs };
}
