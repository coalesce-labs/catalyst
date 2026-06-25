// linear-breaker.mjs — process-wide Linear rate-limit circuit breaker (CTL-679).
//
// Every execution-core Linear access shells out to `linearis` (or
// linear-transition.sh, which itself calls linearis) via spawnSync. On an HTTP
// 429 the failed write writes no success-marker, so the same call re-fires on
// the next scheduler tick (~2s debounced / 30s timer) with NO backoff — a
// self-perpetuating storm that keeps the 2500/hr quota pinned so it never
// recovers (observed: 1302 failed writes/window, 8 tickets retried ~125× each).
//
// This breaker is the safety fix: a single 429 OPENS the breaker process-wide,
// short-circuiting ALL subsequent Linear traffic (reads AND writes) for an
// exponentially-backed-off cooldown — without spawning linearis at all — until
// the cooldown elapses. A clean call CLOSES it and resets the backoff.
import { log } from "./config.mjs";

// The 429 shape linearis surfaces on stderr: "Rate limit exceeded. Only 2500
// requests are allowed per 1 hour". Matched case-insensitively and loosely so a
// reworded message still trips the breaker.
export function isRateLimitError(stderr) {
  return /rate limit exceeded/i.test(String(stderr ?? ""));
}

const BASE_COOLDOWN_MS = 60_000; // first 429 → 60s pause
const MAX_COOLDOWN_MS = 15 * 60_000; // backoff ceiling

// createLinearBreaker — a single breaker instance. The module also exports a
// shared singleton (`linearBreaker`) that both exec wrappers consume so one 429
// pauses the whole process; the factory exists so tests get an isolated breaker
// and can drive its clock via the injected `now`.
export function createLinearBreaker({
  baseCooldownMs = BASE_COOLDOWN_MS,
  maxCooldownMs = MAX_COOLDOWN_MS,
  logger = log,
} = {}) {
  let openUntil = 0; // epoch ms the breaker stays open until (0 = closed)
  let consecutive = 0; // consecutive 429s with no intervening success → backoff exponent

  return {
    // isOpen — true while we are inside the cooldown window; callers must NOT
    // spawn linearis when open.
    isOpen(now = Date.now()) {
      return now < openUntil;
    },

    // recordRateLimited — a real spawn just returned a 429. Open (or re-arm) the
    // breaker with exponential backoff (base × 2^(n-1), capped), honoring a
    // larger Retry-After hint when present. Only ever called from a CLOSED state
    // (an open breaker short-circuits before spawning), so each call is a
    // closed→open transition and logs exactly one "circuit open" line.
    recordRateLimited(now = Date.now(), { retryAfterMs } = {}) {
      consecutive += 1;
      const backoff = Math.min(baseCooldownMs * 2 ** (consecutive - 1), maxCooldownMs);
      const cooldownMs = Math.max(backoff, retryAfterMs ?? 0);
      openUntil = now + cooldownMs;
      logger.warn(
        { consecutive, cooldownMs, openUntil },
        "ctl-679: Linear circuit breaker OPEN — pausing all Linear calls"
      );
    },

    // recordSuccess — a clean call landed; close the breaker and reset backoff.
    // Logs a single "circuit closed" line only when transitioning out of a
    // degraded state (so steady-state successes stay silent).
    recordSuccess() {
      if (consecutive === 0 && openUntil === 0) return;
      const wasDegraded = consecutive > 0;
      consecutive = 0;
      openUntil = 0;
      if (wasDegraded) {
        logger.info({}, "ctl-679: Linear circuit breaker CLOSED — calls resumed");
      }
    },

    // state — test/introspection only.
    state() {
      return { openUntil, consecutive };
    },
  };
}

// The process-wide singleton both exec wrappers (linear-write.mjs,
// linear-query.mjs) share so a 429 on any path pauses every path.
export const linearBreaker = createLinearBreaker();

// withBreaker — wrap a raw exec (the spawnSync normalizer) so it consults the
// breaker before spawning and feeds the result back. When open it returns a
// synthetic non-zero result (stderr "circuit-open") WITHOUT spawning. After a
// real spawn: a 429 opens the breaker; a clean exit (code 0) closes it. A
// non-429 failure leaves the breaker untouched (it is not a rate-limit signal).
// CTL-1339: a 3rd `opts` arg (e.g. { timeoutMs }) is forwarded to the inner
// rawExec untouched — opt-in per-call wall-clock cap for the hot terminal reads.
// The breaker logic is unchanged; an open breaker still short-circuits before
// any spawn (so the cap is moot when open).
export function withBreaker(rawExec, { breaker = linearBreaker, now = Date.now } = {}) {
  return (cmd, args, opts) => {
    const t = now();
    if (breaker.isOpen(t)) {
      return { code: 1, stdout: "", stderr: "circuit-open" };
    }
    const res = rawExec(cmd, args, opts);
    // CTL-1341: a wall-clock TIMEOUT (the CTL-1339 per-call cap fired) is a
    // degraded-API signal — open the breaker so the next read in a multi-read
    // pass short-circuits (`circuit-open`, no spawn) instead of paying the full
    // cap again. This bounds the per-PASS aggregate to ~1 cap, not N×cap (a
    // per-call cap alone left recovery-pass at ~N×8s). A >8s linearis read is
    // genuinely abnormal (healthy reads are sub-second), so the backoff is right.
    if (res.code !== 0 && (res.timedOut || isRateLimitError(res.stderr))) {
      breaker.recordRateLimited(t);
    } else if (res.code === 0) {
      breaker.recordSuccess();
    }
    return res;
  };
}
