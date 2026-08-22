// system-trouble.mjs — CTL-2156. The SYSTEM-trouble detector: turn the fleet's
// existing provider / rate-limit / capacity telemetry into ONE fleet-scoped,
// auto-clearing alert per condition — instead of one per-ticket escalation.
//
// WHY THIS EXISTS. Measured on 86 items flagged as "waiting on a human", 41 were
// the model provider being overloaded, escalated ONE TICKET AT A TIME. That is a
// system condition, not 41 human decisions: the tickets do not need a person,
// they need the provider to come back, and they resume by themselves when it
// does. So the fan-in is the whole point — N overloaded tickets must produce
// exactly ONE `catalyst.alert.raised`, and ZERO per-ticket artifacts.
//
// SHAPE. Two pure pieces, no I/O, both injectable-clock:
//
//   classifySystemTrouble(event) → { kind, key, active, reason } | null
//       A TABLE over event.name. `active:false` is a RETRACTION — the same key
//       reporting itself healthy again (capacity restored, account no longer
//       rejected). Retraction is what makes the clear EDGE-triggered rather than
//       "wait for the window to age out".
//
//   makeSystemTroubleWindow({ windowMsByKind }) → a trailing-window DISTINCT-KEY
//       counter per kind. The level the alarm machine reads is "how many distinct
//       affected things are currently in trouble", never "how many events arrived".
//
// The level → edge conversion (threshold + persistence + cooldown) is
// alert-emit.mjs's nextLevelAlarmState; the wiring (tail → observe, watchdog tick
// → evaluate → emit) is router.mjs. This module emits NOTHING and writes NOTHING.
//
// EMISSION IS NOT DELIVERY. Even when this fires, all that exists is a
// `catalyst.alert.raised` line in the event log. A downstream rule (Loki/dash0 →
// channel) does delivery; that half is not verifiable from here.

import {
  ALERT_KIND_PROVIDER_DEGRADED,
  ALERT_KIND_RATE_LIMIT_EXHAUSTED,
  ALERT_KIND_CAPACITY_UNAVAILABLE,
} from "./alert-emit.mjs";

// Default trailing window: how long one observation keeps its key "in trouble"
// with no further news. Also the auto-clear backstop — if every producer goes
// quiet, every key ages out and the alert clears on its own.
export const DEFAULT_TROUBLE_WINDOW_MS = 600_000; // 10 min

// account.ratelimit.sampled is a GAUGE (a pct). At or above this it counts as an
// exhausted budget; below it RETRACTS. Tunable by the caller so the broker's
// config knob is the single source (config-drives-behavior).
export const DEFAULT_ACCOUNT_EXHAUSTED_PCT = 100;

function payloadOf(event) {
  const p = event?.body?.payload;
  return p && typeof p === "object" ? p : {};
}
function attrOf(event, key) {
  const a = event?.attributes;
  return a && typeof a === "object" ? a[key] : undefined;
}
function str(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^[+-]?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

/**
 * TROUBLE_RULES — the detector contract, as a table keyed on `event.name`.
 *
 * Each rule is PURE and returns an observation or null. `null` means "this event
 * carries no opinion" — deliberately distinct from `active:false`, which is a
 * positive statement that the key is healthy. A rule that cannot read the field
 * it judges must return null, NOT a retraction: retracting on a malformed event
 * would silently clear a real alert.
 *
 * Adding a producer is a one-line add here plus a case in system-trouble.test.mjs.
 */
export const TROUBLE_RULES = Object.freeze({
  // ── provider_degraded — 429/529 overload from the model provider ───────────
  // execution-core/sdk-run-phase-agent.mjs emits this on every overload retry and
  // once more with exhausted:true when the bounded backoff runs out. Keyed on the
  // TICKET so N overloaded tickets are N keys under ONE alert, which is exactly
  // the fan-in this ticket exists to create.
  "execution-core.sdk.overloaded": (event) => {
    const p = payloadOf(event);
    const ticket = str(p.ticket) ?? str(attrOf(event, "event.label")) ?? "unknown";
    const exhausted = p.exhausted === true;
    return {
      kind: ALERT_KIND_PROVIDER_DEGRADED,
      key: `ticket:${ticket}`,
      active: true,
      reason: exhausted
        ? `provider overload exhausted retries (${ticket})`
        : `provider overload retry (${ticket})`,
    };
  },

  // ── rate_limit_exhausted — an account or API budget is spent ──────────────
  // account.status.changed is EDGE-triggered upstream (orch-monitor's
  // account-status-latch) and carries both directions, so it retracts on its own.
  "account.status.changed": (event) => {
    const p = payloadOf(event);
    const status = str(attrOf(event, "account.status")) ?? str(p.status);
    if (!status) return null; // unreadable → no opinion (never a false retraction)
    const handle =
      str(attrOf(event, "account.handle")) ??
      str(p.handle) ??
      str(attrOf(event, "account.email")) ??
      "unknown";
    return {
      kind: ALERT_KIND_RATE_LIMIT_EXHAUSTED,
      key: `account:${handle}`,
      active: status === "rejected",
      reason: `claude account ${handle} ${status === "rejected" ? "rate-limited (rejected)" : "accepting again"}`,
    };
  },

  // A GAUGE. >= exhaustedPct is trouble; anything below it is a positive
  // retraction, so a recovering account clears the alert without waiting for the
  // window. A missing/unparseable pct is no opinion.
  "account.ratelimit.sampled": (event, { accountExhaustedPct }) => {
    const p = payloadOf(event);
    const pct = num(p.fiveHourPct) ?? num(attrOf(event, "ratelimit.five_hour_pct"));
    if (pct === null) return null;
    const email = str(p.email) ?? str(attrOf(event, "account.email")) ?? "unknown";
    return {
      kind: ALERT_KIND_RATE_LIMIT_EXHAUSTED,
      key: `account:${email}`,
      active: pct >= accountExhaustedPct,
      reason: `claude account ${email} 5h usage ${pct}% (limit ${accountExhaustedPct}%)`,
    };
  },

  // The usage probe itself getting a 429 IS the rate limit. Any other unsampled
  // reason (network, auth) is a different failure — no opinion here.
  "account.ratelimit.unsampled": (event) => {
    const p = payloadOf(event);
    const status =
      num(attrOf(event, "ratelimit.unsampled_http_status")) ?? num(p.status) ?? num(p.httpStatus);
    if (status !== 429) return null;
    const email = str(p.email) ?? str(attrOf(event, "account.email")) ?? "unknown";
    return {
      kind: ALERT_KIND_RATE_LIMIT_EXHAUSTED,
      key: `account:${email}`,
      active: true,
      reason: `claude usage probe 429 for ${email}`,
    };
  },

  // The per-host Linear write budget (execution-core/linear-write-proxy.mjs,
  // CTL-1936). Raised once per exhaustion EPISODE upstream, so no de-dup needed
  // here; the trailing window is what clears it once the budget day rolls over.
  "linear.write.proxy.budget-exhausted": (event) => ({
    kind: ALERT_KIND_RATE_LIMIT_EXHAUSTED,
    key: `linear:write-budget:${str(attrOf(event, "host.name")) ?? str(event?.resource?.["host.name"]) ?? "local"}`,
    active: true,
    reason: "linear write budget exhausted for this host/day",
  }),

  // Linear label writes gave up after their bounded retry — the shared 2500/hr
  // quota is the usual cause (execution-core/label-retry-event.mjs).
  "linear.label.retry-exhausted": () => ({
    kind: ALERT_KIND_RATE_LIMIT_EXHAUSTED,
    key: "linear:label-retry",
    active: true,
    reason: "linear label write retries exhausted (API quota)",
  }),

  // ── capacity_unavailable — the node has no slot to run anything in ─────────
  // execution-core/capacity-event.mjs emits on every autotune maxParallel change,
  // in BOTH directions, so a restored node retracts its own key.
  //
  // KNOWN GAP (stated, not papered over): "executor death" has no dedicated
  // producer event on this host today. A dead executor shows up as its service
  // going silent, which the CTL-1122 ingestion-recency detector already promotes
  // to system_down — so it is covered by a DIFFERENT kind, not by this one. When
  // a real executor-liveness event lands, it is one row in this table.
  "node.capacity.changed": (event) => {
    const p = payloadOf(event);
    const next = num(p.new_maxParallel);
    if (next === null) return null;
    const host = str(p["host.name"]) ?? str(attrOf(event, "event.label")) ?? "unknown";
    return {
      kind: ALERT_KIND_CAPACITY_UNAVAILABLE,
      key: `node:${host}`,
      active: next <= 0,
      reason:
        next <= 0
          ? `node ${host} has no execution slots (maxParallel=${next}${p.reason ? `, ${p.reason}` : ""})`
          : `node ${host} capacity restored (maxParallel=${next})`,
    };
  },
});

/** Every kind this detector can raise — the alert contract, in one place. */
export const SYSTEM_TROUBLE_KINDS = Object.freeze([
  ALERT_KIND_PROVIDER_DEGRADED,
  ALERT_KIND_RATE_LIMIT_EXHAUSTED,
  ALERT_KIND_CAPACITY_UNAVAILABLE,
]);

/**
 * classifySystemTrouble — PURE. Map one ingested event to a trouble observation.
 *
 * @param {object} event  a canonical envelope
 * @param {object} [opts]
 * @param {number} [opts.accountExhaustedPct]
 * @returns {{kind:string,key:string,active:boolean,reason:string}|null}
 */
export function classifySystemTrouble(
  event,
  { accountExhaustedPct = DEFAULT_ACCOUNT_EXHAUSTED_PCT } = {}
) {
  const name = event?.attributes?.["event.name"];
  if (typeof name !== "string") return null;
  const rule = TROUBLE_RULES[name];
  if (!rule) return null;
  try {
    const obs = rule(event, { accountExhaustedPct });
    if (!obs || typeof obs.kind !== "string" || typeof obs.key !== "string") return null;
    return { ...obs, active: obs.active === true };
  } catch {
    // A malformed event must never wedge the broker's hot tail path.
    return null;
  }
}

/**
 * makeSystemTroubleWindow — a trailing-window DISTINCT-KEY counter per kind.
 *
 * The level fed to the alarm machine is `count(kind)` = how many distinct keys
 * are currently in trouble. That is what makes N overloaded tickets ONE alert.
 *
 * Auto-clear has two independent paths, and both matter:
 *   1. RETRACTION — an `active:false` observation deletes the key immediately
 *      (capacity restored, account un-rejected). Fast, edge-accurate.
 *   2. EXPIRY — a key with no news for windowMs ages out. This is the backstop
 *      for producers that only ever report trouble (sdk.overloaded never says
 *      "I'm fine"); without it those alerts would latch forever.
 *
 * Bounded by construction: expired keys are deleted on every read, and prune()
 * sweeps every kind on the watchdog tick, so a long-lived broker cannot grow an
 * unbounded key map (the _emittedWakeCache/CTL-1516 lesson).
 *
 * @param {object} [opts]
 * @param {Record<string, number>} [opts.windowMsByKind]
 * @param {number} [opts.defaultWindowMs]
 * @param {number} [opts.accountExhaustedPct]
 */
export function makeSystemTroubleWindow({
  windowMsByKind = {},
  defaultWindowMs = DEFAULT_TROUBLE_WINDOW_MS,
  accountExhaustedPct = DEFAULT_ACCOUNT_EXHAUSTED_PCT,
} = {}) {
  /** @type {Map<string, Map<string, number>>} kind -> key -> expiresAtMs */
  const byKind = new Map();
  /** @type {Map<string, string>} kind -> the most recent active reason */
  const reasons = new Map();

  const windowFor = (kind) => {
    const w = windowMsByKind[kind];
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : defaultWindowMs;
  };
  const keysFor = (kind) => {
    let m = byKind.get(kind);
    if (!m) {
      m = new Map();
      byKind.set(kind, m);
    }
    return m;
  };
  const pruneKind = (kind, nowMs) => {
    const m = byKind.get(kind);
    if (!m) return;
    for (const [key, expiresAt] of m) if (expiresAt <= nowMs) m.delete(key);
  };

  return {
    /** Fold one already-classified observation in. Returns the observation. */
    observe(obs, nowMs) {
      if (!obs) return null;
      const m = keysFor(obs.kind);
      if (obs.active) {
        m.set(obs.key, nowMs + windowFor(obs.kind));
        if (obs.reason) reasons.set(obs.kind, obs.reason);
      } else {
        m.delete(obs.key); // RETRACTION — edge-accurate clear
      }
      return obs;
    },
    /** Classify + fold one raw event. Returns the observation, or null. */
    observeEvent(event, nowMs) {
      return this.observe(classifySystemTrouble(event, { accountExhaustedPct }), nowMs);
    },
    /** How many distinct things are in trouble for `kind` right now. */
    count(kind, nowMs) {
      pruneKind(kind, nowMs);
      return byKind.get(kind)?.size ?? 0;
    },
    /** The live keys for `kind` (sorted — a stable alert payload). */
    keys(kind, nowMs) {
      pruneKind(kind, nowMs);
      return [...(byKind.get(kind)?.keys() ?? [])].sort();
    },
    /** The most recent active reason recorded for `kind` (forensics). */
    reason(kind) {
      return reasons.get(kind) ?? null;
    },
    /** Sweep every kind — called on the watchdog tick to bound the maps. */
    prune(nowMs) {
      for (const kind of byKind.keys()) pruneKind(kind, nowMs);
    },
    clear() {
      byKind.clear();
      reasons.clear();
    },
    /** Total live keys across all kinds (test/bounding assertions). */
    size(nowMs) {
      this.prune(nowMs);
      let n = 0;
      for (const m of byKind.values()) n += m.size;
      return n;
    },
  };
}
