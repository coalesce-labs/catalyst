// codex-account-plane.mjs — the pure core of `catalyst-stack codex-account`.
//
// Every decision that can be made WITHOUT spawning a process: window derivation,
// bucket normalization, binding-window selection, account classification, and
// NDJSON framing. Zero imports, so it stays loadable from bare Node (`catalyst
// doctor`), from bun, and from the CLI wrappers alike.
//
// ── WHY THE {fiveHour, sevenDay} SHAPE DOES NOT PORT ────────────────────────
// The Claude twin (claude-accounts-usage.mjs) reads two fixed headers and can
// name its windows positionally. Codex CANNOT. Measured on mini-2 (codex-cli
// 0.147.0, 2026-08-22) via `account/rateLimits/read`:
//
//   rateLimits            → limitId "codex":
//                             primary   { usedPercent 10, windowDurationMins 10080 }
//                             secondary null
//   rateLimitsByLimitId   → also "codex_bengalfox":
//                             primary   { usedPercent 0, windowDurationMins 300 }
//                             secondary { usedPercent 0, windowDurationMins 10080 }
//
// So the top-level bucket's `primary` is a WEEKLY window and there is no 5-hour
// window in that view at all — while a real 5-hour window exists under a
// DIFFERENT bucket. A positional `primary→fiveHour, secondary→sevenDay` mapping
// would (a) mislabel this account's weekly usage as 5-hour and (b) report its
// 5-hour usage as absent while it exists. Both are wrong in the direction that
// reads as "plenty of quota left".
//
// ⛔ RULE: windows are named from `windowDurationMins`, NEVER from position.
//
// ── WHY THE VERDICT IS FOUR-VALUED AND FAILS CLOSED ─────────────────────────
// `account/rateLimits/read` SUCCEEDS on a throttled account — it just carries a
// non-null `rateLimitReachedType`. This is the exact trap `_ca_entry_rejected_
// reason` (catalyst-stack:4213) exists for on the Claude side, where a 429 still
// returns headers so `.error` is empty. A status derived from "did the call
// work?" calls a dead account healthy. Hence `rejected` is its own verdict.
//
// And `initialize` echoes the resolved `codexHome` back, which is a FREE, EXACT
// positive control the Claude side never had: if the child resolved a different
// home than we asked for, every number under it describes the WRONG ACCOUNT.
// That is an `error`, never an `ok` with good-looking data.

/** The four verdicts. Phase 4's alarm imports these rather than re-deriving them. */
export const ACCOUNT_PLANE_STATUS = Object.freeze({
  OK: "ok",
  UNAUTHENTICATED: "unauthenticated",
  REJECTED: "rejected",
  ERROR: "error",
});

/**
 * Durations with a name the operator already uses. Everything else falls back to
 * the general Nm/Nh/Nd form — a derived label is still honest, a guessed one is not.
 */
export const WINDOW_LABELS = Object.freeze({
  300: "5h",
  10080: "weekly",
});

const UNKNOWN_WINDOW = "unknown";

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isUsableDuration(mins) {
  return typeof mins === "number" && Number.isFinite(mins) && mins > 0;
}

/**
 * Name a window from its duration in minutes.
 * A null/absent/non-numeric duration is "unknown" — NEVER a positional guess.
 */
export function deriveWindowLabel(mins) {
  if (!isUsableDuration(mins)) return UNKNOWN_WINDOW;
  const named = WINDOW_LABELS[mins];
  if (named) return named;
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

/**
 * A window is kept only when it carries a usable `usedPercent`. A window with no
 * number is DROPPED rather than emitted at 0% — a placeholder zero reads as
 * "plenty of quota left", which is the fail-open direction.
 */
function normalizeWindow(w) {
  if (!isPlainObject(w)) return null;
  const usedPercent = w.usedPercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
  const windowDurationMins = isUsableDuration(w.windowDurationMins) ? w.windowDurationMins : null;
  return {
    label: deriveWindowLabel(w.windowDurationMins),
    windowDurationMins,
    usedPercent,
    resetsAt: typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) ? w.resetsAt : null,
  };
}

function normalizeBucket(bucket, fallbackId) {
  if (!isPlainObject(bucket)) return null;
  const windows = [normalizeWindow(bucket.primary), normalizeWindow(bucket.secondary)].filter(
    Boolean,
  );
  return {
    limitId: typeof bucket.limitId === "string" && bucket.limitId ? bucket.limitId : fallbackId,
    limitName: typeof bucket.limitName === "string" ? bucket.limitName : null,
    planType: typeof bucket.planType === "string" ? bucket.planType : null,
    rateLimitReachedType:
      typeof bucket.rateLimitReachedType === "string" && bucket.rateLimitReachedType
        ? bucket.rateLimitReachedType
        : null,
    credits: bucket.credits ?? null,
    windows,
  };
}

/**
 * Flatten an `account/rateLimits/read` response into one entry per limitId.
 *
 * Prefers `rateLimitsByLimitId` (the complete view) and falls back to the single
 * top-level `rateLimits` bucket for a server that does not send the map.
 * Returns [] — never throws — on any malformed input.
 */
export function normalizeRateLimits(resp) {
  if (!isPlainObject(resp)) return [];
  const byId = resp.rateLimitsByLimitId;
  const out = [];
  if (isPlainObject(byId)) {
    for (const [key, bucket] of Object.entries(byId)) {
      const normalized = normalizeBucket(bucket, key);
      if (normalized) out.push(normalized);
    }
    if (out.length > 0) return out;
  }
  const single = normalizeBucket(resp.rateLimits, "codex");
  return single ? [single] : [];
}

/**
 * The window that actually binds this account: the most-consumed one across every
 * bucket. Codex exposes no `representativeClaim`, so "most consumed" is the honest
 * stand-in. Returns null when there is no window at all — never a fabricated zero,
 * because "0% used" and "I could not see any usage" must not read the same.
 */
export function deriveBindingWindow(buckets) {
  if (!Array.isArray(buckets)) return null;
  let binding = null;
  for (const bucket of buckets) {
    if (!isPlainObject(bucket) || !Array.isArray(bucket.windows)) continue;
    for (const w of bucket.windows) {
      if (!isPlainObject(w) || typeof w.usedPercent !== "number") continue;
      if (binding === null || w.usedPercent > binding.usedPercent) {
        binding = {
          limitId: bucket.limitId ?? null,
          label: w.label,
          windowDurationMins: w.windowDurationMins ?? null,
          usedPercent: w.usedPercent,
          resetsAt: w.resetsAt ?? null,
        };
      }
    }
  }
  return binding;
}

/** Trailing-slash-insensitive path compare. The caller resolves symlinks; this only normalizes. */
function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const strip = (p) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  return strip(a) === strip(b);
}

function verdict(status, reason, extra = {}) {
  return {
    status,
    reason: reason ?? null,
    email: extra.email ?? null,
    planType: extra.planType ?? null,
    accountType: extra.accountType ?? null,
    buckets: extra.buckets ?? [],
    binding: extra.binding ?? null,
  };
}

/**
 * Classify one account home from the three raw RPC results.
 *
 * Rungs, fail-closed at each one:
 *   1. transport `error`                                        → error
 *   2. `initialize.codexHome` absent, or ≠ `requestedHome`      → error
 *   3. `account.account == null`, or a `rateLimitsError`        → unauthenticated
 *   4. any bucket with a non-null `rateLimitReachedType`        → rejected
 *   5. otherwise                                                → ok
 *
 * On rung 2 the buckets are DISCARDED rather than reported: they describe a
 * different account than the one that was asked about, and attributing them to
 * the requested handle is precisely the misreading the positive control exists
 * to prevent.
 */
export function classifyAccountPlane({
  requestedHome,
  initialize,
  account,
  rateLimits,
  rateLimitsError,
  error,
} = {}) {
  const accountObj = isPlainObject(account) ? account.account : null;
  const identity = isPlainObject(accountObj)
    ? {
        email: typeof accountObj.email === "string" ? accountObj.email : null,
        planType: typeof accountObj.planType === "string" ? accountObj.planType : null,
        accountType: typeof accountObj.type === "string" ? accountObj.type : null,
      }
    : { email: null, planType: null, accountType: null };

  // 1. Transport failure outranks everything — there is nothing to interpret.
  if (error) {
    return verdict(ACCOUNT_PLANE_STATUS.ERROR, String(error?.message ?? error), identity);
  }

  // 2. The positive control: which home did the child ACTUALLY resolve?
  const resolvedHome = isPlainObject(initialize) ? initialize.codexHome : null;
  if (typeof resolvedHome !== "string" || !resolvedHome) {
    return verdict(
      ACCOUNT_PLANE_STATUS.ERROR,
      `the app-server did not report a codexHome for the requested home ${requestedHome ?? "(none)"}, so which account these numbers describe is unknown`,
      identity,
    );
  }
  if (!samePath(resolvedHome, requestedHome)) {
    return verdict(
      ACCOUNT_PLANE_STATUS.ERROR,
      `requested ${requestedHome} but the app-server resolved ${resolvedHome} — these numbers describe a different account`,
      identity,
    );
  }

  const buckets = normalizeRateLimits(rateLimits);
  const binding = deriveBindingWindow(buckets);
  const withData = { ...identity, buckets, binding };

  // 3. No account, or the limits read refused: unauthenticated, never ok.
  if (rateLimitsError) {
    const msg =
      (isPlainObject(rateLimitsError) ? rateLimitsError.message : null) ?? String(rateLimitsError);
    return verdict(ACCOUNT_PLANE_STATUS.UNAUTHENTICATED, msg, withData);
  }
  if (!isPlainObject(accountObj)) {
    return verdict(
      ACCOUNT_PLANE_STATUS.UNAUTHENTICATED,
      "account/read returned no account for this home (codex account authentication required)",
      withData,
    );
  }

  // 4. ⛔ The RPC succeeds on a throttled account. Any bucket, not just the first.
  for (const bucket of buckets) {
    if (bucket.rateLimitReachedType) {
      return verdict(
        ACCOUNT_PLANE_STATUS.REJECTED,
        `rate limit reached on bucket '${bucket.limitId}': ${bucket.rateLimitReachedType}`,
        withData,
      );
    }
  }

  return verdict(ACCOUNT_PLANE_STATUS.OK, null, withData);
}

/** The one definition of "this account cannot serve work". Phase 4 imports it. */
export function isRejectedStatus(status) {
  return status === ACCOUNT_PLANE_STATUS.REJECTED;
}

/**
 * Line-framer for the app-server's NDJSON stdout.
 *
 * Holds a partial trailing fragment back until its newline arrives — the same
 * discipline every event-log reader in this repo uses, and for the same reason:
 * a read landing mid-write sees a fragment that is a healthy in-flight message,
 * not a damaged one. An unparseable line is SKIPPED, never thrown, so one bad
 * frame cannot abort the whole read.
 */
export function parseNdjson() {
  let leftover = "";
  return {
    push(chunk) {
      if (chunk === null || chunk === undefined) return [];
      leftover += typeof chunk === "string" ? chunk : String(chunk);
      const parts = leftover.split("\n");
      leftover = parts.pop() ?? "";
      const out = [];
      for (const raw of parts) {
        const line = raw.replace(/\r$/, "").trim();
        if (!line) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // not a frame — skip it, never throw
        }
        // Only objects are JSON-RPC frames; a bare scalar is noise.
        if (isPlainObject(parsed)) out.push(parsed);
      }
      return out;
    },
  };
}

/**
 * `/…/codex-home-acctN` → `acctN`. Anything else is null — a home we cannot name
 * is reported as unnamed, never as a guessed handle. Note `~/catalyst/codex-home`
 * (the selector itself) and `~/.codex` both correctly yield null.
 */
export function handleFromHomePath(p) {
  if (typeof p !== "string" || !p) return null;
  const m = /codex-home-(acct\d+)\/?$/.exec(p);
  return m ? m[1] : null;
}
