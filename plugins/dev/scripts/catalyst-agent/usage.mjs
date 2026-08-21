// usage.mjs — CTL-812 Domain 1. Per-account Claude rate-limit usage sampler.
//
// Given the accounts enumerated for this run (active + refreshed swap backups),
// tickUsage() resolves each account's email/tier ONCE, GETs
// https://api.anthropic.com/api/oauth/usage, normalizes the five_hour /
// seven_day / per-model 7d buckets, computes a forward-looking burn PACE for the
// 5h and 7d windows, and emits one account.ratelimit.sampled envelope per
// account via the injected emit. On HTTP 429 from any account it stops sampling
// the REMAINING accounts this run (a shared limiter — the usage endpoint is
// rate-limited per source IP / token, so continuing would compound the throttle)
// and emits nothing for the throttled or skipped accounts.
//
// The agent is stateless between runs (launchd --once relaunches the process),
// so the email/tier cache lives only for the duration of THIS tickUsage() call.
//
// SELF-CONTAINED: zero npm deps, node:* builtins only; runs under node>=18 and
// bun. The standalone agent does NOT import from execution-core.
//
// SECRETS HYGIENE (hard rule): the OAuth token is passed into fetchUsage /
// resolveEmail and used without ever being logged or echoed. NEVER print it.
//
// All side effects (fetchUsage, resolveEmail, emit, now) are injected so
// tickUsage() is fully unit-testable with no real network.

import { execFileSync } from "node:child_process";
import { log } from "./config.mjs";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_BETA = "oauth-2025-04-20";

// Rolling-window widths used for the pace calculation. 5h and 7d in ms.
const FIVE_HOUR_MS = 5 * 3600_000;
const SEVEN_DAY_MS = 7 * 86_400_000;

export const RATELIMIT_EVENT_SAMPLED = "account.ratelimit.sampled";

// CTL-1947. Every path below that cannot produce a sample used to `continue` after a log.warn
// and emit NOTHING. Prometheus then shows an ABSENT series — which, as CTL-1947 puts it, "looks
// identical to a healthy one that happens to be at zero" and is indistinguishable from the
// exporter not running at all. Measured on mini 2026-08-18 02:2x CT: the poller had been running
// every 300 s and logging "account email unresolvable; skipping account this run" on EVERY run,
// with zero ratelimit events in a 2.7 MB log, while catalyst_account_ratelimit_* had carried no
// data for 7+ days. Nothing was broken loudly; it was broken quietly.
//
// So a run that cannot sample now emits a POSITIVE signal saying so, carrying the reason. An
// absent series is not evidence; a series that says "unsampled because 401" is.
export const RATELIMIT_EVENT_UNSAMPLED = "account.ratelimit.unsampled";

// The reasons, as a closed set — an alert keys on these, so they are a contract, not free text.
export const UNSAMPLED_NO_TOKEN = "no-token";
export const UNSAMPLED_EMAIL_UNRESOLVABLE = "email-unresolvable";
export const UNSAMPLED_USAGE_THROTTLED = "usage-throttled";
export const UNSAMPLED_USAGE_HTTP_ERROR = "usage-http-error";

// buildUnsampledSpec — the envelope for "this account could NOT be sampled this run".
//
// ⛔ It deliberately carries NO utilization fields. A zero would be read as "0% used" by every
// consumer of the sampled metric, which is the precise confusion this event exists to remove:
// unsampled is not low usage, it is NO MEASUREMENT.
export function buildUnsampledSpec({ email = null, reason, status = null, source = null }) {
  return {
    entity: "account",
    // Normalized to null rather than left undefined: the emit layer drops both, but a
    // deterministic shape is what lets a test assert "emitted WITHOUT an email, deliberately"
    // instead of accidentally passing on a typo'd key.
    label: email ?? source ?? "unknown",
    attrs: {
      "account.email": email,
      "account.source": source,
      "ratelimit.unsampled_reason": reason,
      "ratelimit.unsampled_http_status": status,
    },
    payload: { email, source, reason, status },
  };
}

// pctOf — normalize a usage bucket to its numeric utilization. The live usage
// endpoint returns each bucket (five_hour, seven_day, seven_day_opus,
// seven_day_sonnet) as an object { utilization, resets_at }; older docs showed
// the per-model buckets as bare numbers. Accept either shape; null when absent
// (an absent bucket means NO usage → null, never coerced to 0). Mirrors
// execution-core/ratelimit-poller.mjs's pctOf to guard the "[object Object]" bug.
export function pctOf(bucket) {
  if (bucket == null) return null;
  if (typeof bucket === "object") return bucket.utilization ?? null;
  return bucket;
}

// getUserAgent — REQUIRED usage/profile header. A wrong/missing UA triggers an
// instant persistent 429. Built from the locally-installed claude version;
// computed once per run. Falls back to "claude-code/unknown". Mirrors the
// execution-core poller idiom.
export function getUserAgent() {
  try {
    const out = execFileSync("claude", ["--version"], { encoding: "utf8" });
    const token = String(out).trim().split(/\s+/)[0];
    return `claude-code/${token || "unknown"}`;
  } catch {
    return "claude-code/unknown";
  }
}

function authHeaders(token, userAgent) {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": OAUTH_BETA,
    "User-Agent": userAgent,
  };
}

/**
 * computePace — forward-looking burn pace for one rolling window. Positive means
 * the account is consuming its quota FASTER than wall-clock (on track to exhaust
 * before the window resets); negative means it is comfortably under pace.
 *
 *   elapsed = (nowMs − (resetsAt − windowMs)) / windowMs   // fraction of window elapsed
 *   pace    = utilization/100 − elapsed                    // usage fraction minus time fraction
 *
 * Rounded to 3 decimals. Returns null when utilization or resetsAt is missing
 * (or resetsAt is unparseable) — pace is undefined without both. Pure; no I/O.
 *
 * @param {number|null} utilization  bucket utilization as a percent (0..100)
 * @param {string|null} resetsAtIso  ISO timestamp the window resets (window end)
 * @param {number}      windowMs     window width (FIVE_HOUR_MS | SEVEN_DAY_MS)
 * @param {number}      nowMs        current epoch ms
 * @returns {number|null}
 */
export function computePace(utilization, resetsAtIso, windowMs, nowMs) {
  if (utilization == null || resetsAtIso == null) return null;
  const resetsMs = Date.parse(resetsAtIso);
  if (!Number.isFinite(resetsMs)) return null;
  const windowStart = resetsMs - windowMs;
  const elapsed = (nowMs - windowStart) / windowMs;
  const pace = utilization / 100 - elapsed;
  // Round to 3 decimals (round-half-up via Math.round on the scaled value).
  return Math.round(pace * 1000) / 1000;
}

// defaultFetchUsage — GET the usage endpoint with the 3 required headers.
// Returns { status, body } where body is parsed JSON when status===200, else
// null. NEVER throws (a network error returns { status: 0, body: null }).
// Mirrors execution-core/ratelimit-poller.mjs.
export async function defaultFetchUsage(token, { userAgent, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(USAGE_ENDPOINT, {
      method: "GET",
      headers: authHeaders(token, userAgent),
    });
    const status = res.status;
    const body = status === 200 ? await res.json() : null;
    return { status, body };
  } catch {
    return { status: 0, body: null };
  }
}

// parseOtelEmail — pull user.email from the comma-separated
// OTEL_RESOURCE_ATTRIBUTES key=value list (the CTL-787 poller's fallback).
// Only meaningful for the ACTIVE account — the ambient identity belongs to
// whoever is logged in, never to a swapped-out backup. Returns null when absent.
export function parseOtelEmail(env = process.env) {
  const attrs = env.OTEL_RESOURCE_ATTRIBUTES;
  if (!attrs) return null;
  for (const pair of attrs.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    if (pair.slice(0, idx).trim() === "user.email") {
      const value = pair.slice(idx + 1).trim();
      return value || null;
    }
  }
  return null;
}

// defaultResolveEmail — GET /api/oauth/profile to resolve .account.email plus
// .organization.rate_limit_tier / .organization.subscription_status. Returns
// { email, rateLimitTier, subscriptionType } (any field may be null) or null
// when no email could be resolved. NEVER throws. Mirrors the execution-core
// poller; the OTEL_RESOURCE_ATTRIBUTES env fallback is applied by tickUsage
// for the active account only.
export async function defaultResolveEmail(token, { userAgent, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(PROFILE_ENDPOINT, {
      method: "GET",
      headers: authHeaders(token, userAgent),
    });
    if (res.status === 200) {
      const body = await res.json();
      const email = body?.account?.email ?? null;
      const rateLimitTier = body?.organization?.rate_limit_tier ?? null;
      const subscriptionType = body?.organization?.subscription_status ?? null;
      if (email) return { email, rateLimitTier, subscriptionType };
    }
  } catch {
    /* never throw */
  }
  return null;
}

// buildSampledSpec — assemble the account.ratelimit.sampled envelope spec
// (entity / label / dot-form attrs / body.payload mirror) per the CTL-812
// telemetry contract. Pure. Attrs are placed in DOT form; the emit layer's
// put() pattern drops any null/undefined entry so the collector never promotes
// an empty label (and zero utilization is preserved, not dropped as falsy).
export function buildSampledSpec({
  email,
  fiveHourPct,
  sevenDayPct,
  fiveHourResetsAt,
  sevenDayResetsAt,
  opusPct,
  sonnetPct,
  subscriptionType,
  rateLimitTier,
  fiveHourPace,
  sevenDayPace,
}) {
  return {
    entity: "account",
    label: email ?? "unknown",
    attrs: {
      "account.email": email,
      "ratelimit.five_hour_pct": fiveHourPct,
      "ratelimit.seven_day_pct": sevenDayPct,
      "ratelimit.five_hour_resets_at": fiveHourResetsAt,
      "ratelimit.seven_day_resets_at": sevenDayResetsAt,
      "ratelimit.seven_day_opus_pct": opusPct,
      "ratelimit.seven_day_sonnet_pct": sonnetPct,
      "subscription.type": subscriptionType,
      "rate_limit.tier": rateLimitTier,
      // NEW (CTL-812): forward-looking burn pace per window.
      "ratelimit.five_hour_pace": fiveHourPace,
      "ratelimit.seven_day_pace": sevenDayPace,
    },
    payload: {
      email,
      fiveHourPct,
      sevenDayPct,
      fiveHourResetsAt,
      sevenDayResetsAt,
      opusPct,
      sonnetPct,
      subscriptionType,
      rateLimitTier,
      fiveHourPace,
      sevenDayPace,
    },
  };
}

// emitUnsampled — emit the "could not measure" signal. Never throws: an observability emit must
// not be able to break the sampling loop it is reporting on (the loop already runs inside a
// per-account try, but this is the one call added on the FAILURE paths, so it fails soft by
// construction rather than by luck).
function emitUnsampled(emit, spec, { nowIso } = {}) {
  try {
    if (typeof emit !== "function") return;
    // Third argument mirrors the sampled path EXACTLY (`{ now: nowIso }` — the emit layer
    // receives the ISO-stamp provider, not a called value). Inventing a different envelope
    // contract for the failure path is how a signal ends up unparseable by the same consumer.
    emit(RATELIMIT_EVENT_UNSAMPLED, buildUnsampledSpec(spec), { now: nowIso });
  } catch {
    /* never throw */
  }
}

/**
 * tickUsage — sample rate-limit usage for every account this run, emitting one
 * account.ratelimit.sampled per account. On a 429 from any account it stops the
 * remaining accounts (shared limiter) and emits nothing further. Returns the
 * count of accounts emitted. NEVER throws.
 *
 * @param {object}   opts
 * @param {Array<{source:string, token:string, file?:string}>} opts.accounts
 * @param {Function} [opts.fetchUsage=defaultFetchUsage]     usage GET ({status,body})
 * @param {Function} [opts.resolveEmail=defaultResolveEmail] one-shot email/tier resolver
 * @param {Function} opts.emit                                (name, spec, {now}) → void
 * @param {Function} [opts.now]                               () → epoch ms (defaults to Date.now)
 * @param {Function} [opts.nowIso]                            () → ISO string for the envelope ts (forwarded to emit)
 * @returns {Promise<number>} number of accounts emitted
 */
export async function tickUsage({
  accounts = [],
  fetchUsage = defaultFetchUsage,
  resolveEmail = defaultResolveEmail,
  emit,
  now = () => Date.now(),
  nowIso = undefined,
} = {}) {
  const userAgent = getUserAgent();
  let emittedCount = 0;

  for (const account of accounts) {
    try {
      const token = account?.token;
      if (!token) {
        log.warn({ source: account?.source }, "usage: account has no token; skipping");
        emitUnsampled(emit, { reason: UNSAMPLED_NO_TOKEN, source: account?.source }, { nowIso });
        continue;
      }

      // Resolve email/tier ONCE per account this run. The agent is stateless
      // between runs, so there is no cross-run cache to consult.
      let email = null;
      let orgMeta = { rateLimitTier: null, subscriptionType: null };
      const resolved = await resolveEmail(token, { userAgent });
      if (resolved) {
        email = resolved.email ?? null;
        orgMeta = {
          rateLimitTier: resolved.rateLimitTier ?? null,
          subscriptionType: resolved.subscriptionType ?? null,
        };
      }

      // No email ⇒ no emit (CTL-812 live finding): the profile call can 429
      // under poller contention, and an account.ratelimit.sampled without
      // account.email renders as a GHOST ROW in the per-account scoreboard —
      // an account-keyed sample is unusable without its key. The active
      // account first falls back to OTEL_RESOURCE_ATTRIBUTES user.email (the
      // CTL-787 poller's ambient identity; backups have no ambient identity).
      // Skipping BEFORE fetchUsage also spares the rate-limited endpoint a
      // call we could not attribute anyway; the next run re-resolves.
      if (!email && account?.source === "active") email = parseOtelEmail();
      if (!email) {
        log.warn(
          { source: account?.source },
          "usage: account email unresolvable; skipping account this run",
        );
        // ⛔ THE ONE THAT WENT DARK FOR 7+ DAYS. /api/oauth/profile answers 401 once the stored
        // OAuth credential stops being authorized, resolveEmail returns null, and the ambient
        // OTEL_RESOURCE_ATTRIBUTES fallback is not present under launchd (the plist sets only
        // CATALYST_AGENT_METRICS_ENDPOINT / HOME / PATH), so BOTH paths to an email are dead and
        // the account is skipped forever. It is emitted with no email — the source alone
        // identifies it, and that is exactly the fact worth alerting on.
        emitUnsampled(
          emit,
          { reason: UNSAMPLED_EMAIL_UNRESOLVABLE, source: account?.source },
          { nowIso },
        );
        continue;
      }

      const { status, body } = await fetchUsage(token, { userAgent });

      if (status === 429) {
        // Shared limiter: the usage endpoint throttled us. Continuing would compound the
        // throttle for the remaining accounts, so stop the run here and take no further
        // SAMPLES. (CTL-1947: it does still emit the unsampled signal for THIS account first —
        // "we were throttled" is a measurement worth having, and it is what distinguishes a
        // throttled run from a dead poller. The accounts not reached emit nothing, which the
        // reason field makes legible.)
        log.warn(
          { source: account?.source },
          "usage: 429 from usage endpoint; stopping remaining accounts this run",
        );
        emitUnsampled(
          emit,
          { email, reason: UNSAMPLED_USAGE_THROTTLED, status, source: account?.source },
          { nowIso },
        );
        break;
      }

      if (status !== 200 || !body) {
        log.warn({ status, source: account?.source }, "usage: non-200 usage response; skipping emit");
        emitUnsampled(
          emit,
          { email, reason: UNSAMPLED_USAGE_HTTP_ERROR, status, source: account?.source },
          { nowIso },
        );
        continue;
      }

      const fiveHour = body.five_hour ?? {};
      const sevenDay = body.seven_day ?? {};
      const fiveHourPct = pctOf(body.five_hour);
      const sevenDayPct = pctOf(body.seven_day);
      const fiveHourResetsAt = fiveHour.resets_at ?? null;
      const sevenDayResetsAt = sevenDay.resets_at ?? null;
      const nowMs = now();

      const spec = buildSampledSpec({
        email,
        fiveHourPct,
        sevenDayPct,
        fiveHourResetsAt,
        sevenDayResetsAt,
        opusPct: pctOf(body.seven_day_opus),
        sonnetPct: pctOf(body.seven_day_sonnet),
        subscriptionType: orgMeta.subscriptionType,
        rateLimitTier: orgMeta.rateLimitTier,
        fiveHourPace: computePace(fiveHourPct, fiveHourResetsAt, FIVE_HOUR_MS, nowMs),
        sevenDayPace: computePace(sevenDayPct, sevenDayResetsAt, SEVEN_DAY_MS, nowMs),
      });

      emit(RATELIMIT_EVENT_SAMPLED, spec, { now: nowIso });
      emittedCount++;
    } catch (err) {
      log.warn({ err: err?.message, source: account?.source }, "usage: account tick failed");
    }
  }

  return emittedCount;
}
