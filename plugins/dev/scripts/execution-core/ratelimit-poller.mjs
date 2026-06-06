// ratelimit-poller.mjs — CTL-787. Account-level Claude rate-limit usage poller.
//
// Every ~5 min (floor 180s) it reads the local OAuth access token, calls
// GET https://api.anthropic.com/api/oauth/usage with the validated 3-header
// shape, and emits one account.ratelimit.sampled event carrying the live
// 5h / 7d utilization (plus per-model 7d opus + sonnet) for the account. The
// account email is resolved ONCE (via GET /api/oauth/profile, falling back to
// OTEL_RESOURCE_ATTRIBUTES) and cached on the poller instance.
//
// On HTTP 429 it backs off by skipping ticks (multiplier grows 1→2→4×, so the
// inter-attempt gap grows 2→3→5× intervalMs, capped so the gap stays <=15 min)
// and resets to no-skip on the next success.
//
// Secrets hygiene: the OAuth token is read into a variable and used without
// ever being logged or echoed. NEVER print it.
//
// All side effects (readToken, fetchUsage, resolveEmail, emit, clock) are
// injected so tick() is fully unit-testable with no real network or keychain.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { readRatelimitPollerConfig, log } from "./config.mjs";
import { emitRatelimitEvent, RATELIMIT_EVENT_SAMPLED } from "./ratelimit-event.mjs";

const PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_BETA = "oauth-2025-04-20";
// The hard floor and the absolute backoff ceiling, per the locked CTL-787 spec.
const INTERVAL_FLOOR_MS = 180000;
const BACKOFF_CAP_MS = 15 * 60_000;

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

// defaultReadToken — resolve the local OAuth access token. macOS reads the
// Keychain generic password; other platforms read ~/.claude/.credentials.json.
// Both paths parse the same JSON blob and pull .claudeAiOauth.accessToken.
// Returns null on ANY error — never throws, never logs the token.
function defaultReadToken() {
  try {
    let raw;
    if (process.platform === "darwin") {
      raw = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8" },
      );
    } else {
      raw = readFileSync(resolve(homedir(), ".claude", ".credentials.json"), "utf8");
    }
    const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    return token || null;
  } catch {
    return null;
  }
}

// getUserAgent — REQUIRED header. A wrong/missing UA triggers an instant
// persistent 429. Built from the locally-installed claude version; computed
// once at startup. Falls back to "claude-code/unknown".
function getUserAgent() {
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

// pctOf — normalize a usage bucket to its numeric utilization. The live usage
// endpoint returns each bucket (five_hour, seven_day, seven_day_opus,
// seven_day_sonnet) as an object { utilization, resets_at }; older docs showed
// the per-model buckets as bare numbers. Accept either shape, null when absent.
// (Validated 2026-06-06: seven_day_sonnet came back as an object, so emitting it
// raw produced "[object Object]" in Loki — this guards against that.)
function pctOf(bucket) {
  if (bucket == null) return null;
  if (typeof bucket === "object") return bucket.utilization ?? null;
  return bucket;
}

// defaultFetchUsage — GET the usage endpoint with the 3 required headers.
// Returns { status, body } where body is parsed JSON when status===200, else
// null. NEVER throws (a network error returns { status: 0, body: null }).
async function defaultFetchUsage(token, { endpoint, userAgent }) {
  try {
    const res = await fetch(endpoint, {
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
// OTEL_RESOURCE_ATTRIBUTES key=value list. Returns null when absent.
function parseOtelEmail() {
  const attrs = process.env.OTEL_RESOURCE_ATTRIBUTES;
  if (!attrs) return null;
  for (const pair of attrs.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    if (key === "user.email") {
      const value = pair.slice(idx + 1).trim();
      return value || null;
    }
  }
  return null;
}

// defaultResolveEmail — GET /api/oauth/profile to resolve .account.email and
// harvest .organization.rate_limit_tier / .organization.subscription_status
// when present. On failure, parse user.email from OTEL_RESOURCE_ATTRIBUTES.
// Returns { email, rateLimitTier, subscriptionType } (any field may be null);
// returns null only when NO email could be resolved at all. NEVER throws.
async function defaultResolveEmail(token, { userAgent }) {
  try {
    const res = await fetch(PROFILE_ENDPOINT, {
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
    /* fall through to the env fallback */
  }
  const fallbackEmail = parseOtelEmail();
  if (fallbackEmail) {
    return { email: fallbackEmail, rateLimitTier: null, subscriptionType: null };
  }
  return null;
}

/**
 * startRatelimitPoller — start the periodic account rate-limit poll. Returns
 * { stop, tick }. All I/O is injected so tick() is testable with zero real
 * network or keychain access.
 *
 * @param {object} opts
 * @param {object}   [opts.clock=realClock()]                fake-clock seam
 * @param {object}   [opts.config=readRatelimitPollerConfig()] cadence + endpoint
 * @param {Function} [opts.readToken=defaultReadToken]       OAuth token reader (sync, returns string|null)
 * @param {Function} [opts.fetchUsage=defaultFetchUsage]     usage GET ({status,body})
 * @param {Function} [opts.resolveEmail=defaultResolveEmail] one-shot email resolver
 * @param {Function} [opts.emit=emitRatelimitEvent]          event emitter
 * @param {Function} [opts.now]                              injectable envelope timestamp fn (forwarded to emit; defaults to real time)
 */
export function startRatelimitPoller({
  clock = realClock(),
  config = readRatelimitPollerConfig(),
  readToken = defaultReadToken,
  fetchUsage = defaultFetchUsage,
  resolveEmail = defaultResolveEmail,
  emit = emitRatelimitEvent,
  now = undefined,
} = {}) {
  const userAgent = getUserAgent();
  const intervalMs = Math.max(INTERVAL_FLOOR_MS, config.intervalMs);
  // Cap the backoff multiplier so the inter-attempt GAP stays <= BACKOFF_CAP_MS.
  // N skipped ticks before the next real attempt yield a gap of (N+1)*intervalMs,
  // so the cap on N is floor(BACKOFF_CAP_MS / intervalMs) - 1 (e.g. 5 min interval
  // → maxMultiplier 2 → max gap (2+1)*5 = 15 min; 3 min interval → maxMultiplier 4
  // → max gap (4+1)*3 = 15 min). At least 1.
  const maxMultiplier = Math.max(1, Math.floor(BACKOFF_CAP_MS / intervalMs) - 1);

  // Account email is resolved lazily on the first successful token read and
  // cached for the life of the poller. orgMeta carries the profile-harvested
  // tier/subscription so they ride on every emit.
  let cachedEmail = null;
  let orgMeta = { rateLimitTier: null, subscriptionType: null };
  let emailResolved = false; // guard so a null-resolving profile is not retried every tick
  let backoffMultiplier = 1; // 1 = no backoff; grows on 429
  let skipCounter = 0; // ticks to skip before the next real attempt

  async function tick() {
    try {
      if (skipCounter > 0) {
        skipCounter--;
        return;
      }

      const token = readToken();
      if (!token) {
        log.warn("ratelimit-poller: no OAuth token available; skipping tick");
        return;
      }

      // Resolve the account email ONCE; reuse the cached value thereafter.
      if (!emailResolved) {
        const resolved = await resolveEmail(token, { userAgent });
        emailResolved = true;
        if (resolved) {
          cachedEmail = resolved.email ?? null;
          orgMeta = {
            rateLimitTier: resolved.rateLimitTier ?? null,
            subscriptionType: resolved.subscriptionType ?? null,
          };
        }
      }

      const { status, body } = await fetchUsage(token, {
        endpoint: config.usageEndpoint,
        userAgent,
      });

      if (status === 429) {
        // Backoff: skip the next (multiplier) intervals, then grow the
        // multiplier (capped). Reset only on a 200.
        skipCounter = backoffMultiplier;
        backoffMultiplier = Math.min(backoffMultiplier * 2, maxMultiplier);
        log.warn(
          { nextSkips: skipCounter },
          "ratelimit-poller: 429 from usage endpoint; backing off",
        );
        return;
      }

      if (status !== 200 || !body) {
        log.warn({ status }, "ratelimit-poller: non-200 usage response; skipping emit");
        return;
      }

      // Success — reset backoff.
      backoffMultiplier = 1;
      skipCounter = 0;

      const fiveHour = body.five_hour ?? {};
      const sevenDay = body.seven_day ?? {};
      emit(
        RATELIMIT_EVENT_SAMPLED,
        {
          email: cachedEmail,
          fiveHourPct: pctOf(body.five_hour),
          sevenDayPct: pctOf(body.seven_day),
          fiveHourResetsAt: fiveHour.resets_at ?? null,
          sevenDayResetsAt: sevenDay.resets_at ?? null,
          opusPct: pctOf(body.seven_day_opus),
          sonnetPct: pctOf(body.seven_day_sonnet),
          subscriptionType: orgMeta.subscriptionType,
          rateLimitTier: orgMeta.rateLimitTier,
        },
        { now },
      );
    } catch (err) {
      log.warn({ err: err?.message }, "ratelimit-poller: tick failed");
    }
  }

  const handle = clock.setInterval(tick, intervalMs);
  if (typeof handle?.unref === "function") handle.unref();
  return { stop: () => clock.clearInterval(handle), tick };
}
