#!/usr/bin/env node
// lease-authority.mjs — CTL-1786, the catalyst-repo CLIENT half of CTC-410.
//
// ── WHAT THIS IS ──
// A dependency-light client for the cloud lease authority — a per-tenant Durable Object
// whose `POST /lease/claim` is a GENUINE store-side compare-and-swap (`WHERE generation = ?`).
// Unlike the Linear-attachment soft-CAS (`cluster-claim.mjs`), which is last-writer-wins and
// can only VOLUNTARILY exclude, this authority can actually REFUSE a claim: exactly one racer
// receives a grant and the loser is TOLD it lost (`{claimed:false, refusal}`) rather than
// inferring it from a read-back. That refusal-by-the-store is the whole point (AC-1).
//
// ── THE WIRE PROTOCOL (measured, catalyst-cloud @ 4a84cd4) ──
//   POST /lease/entitle  {node, ttlMs?, workTtlMs?, budgetUsd?} → {ok:true, entitlement}
//   POST /lease/claim    {ticket, phase, node, ttlMs?}
//        win  → {claimed:true,  lease, grant, attribution}
//               grant = {nonce, expiresAtMs, scope:{ticket,phase}, coordinationHeadSeqAtGrant}
//        loss → {claimed:false, refusal:"not_entitled"|"lease_held", current, attribution:null}
//   POST /lease/release  {ticket, phase, holder, nonce} → ReleaseResult (advances the generation)
//   POST /lease/renew    — OUT OF SCOPE here: the store requires a non-empty progress
//        assertion (invariant I2), so a mechanical keep-alive is forbidden. `renew` is a
//        loud stub; progress-asserted renewal is the follow-up ticket.
//
// ⛔ `grant.nonce` IS the `generation`. `fence-guard.mjs` compares generations by EQUALITY,
// so any unique token is a drop-in — the nonce is mapped to `generation` at THIS boundary so
// every upper layer keeps speaking the existing vocabulary and fence-guard is unchanged.
//
// ── CREDENTIAL DISCIPLINE (inherited from linear-write-proxy.mjs, not re-derived) ──
// The transport, base URL, and per-host key are the SAME as the write proxy: the token rides
// curl's `--config -` stdin document (never argv, never disk), the base URL is
// `resolveProxyBaseUrl`, and the key is `resolveSecret("cloud-token")` via `resolveHostKey`.
// Reusing that module rather than duplicating the ~15-line curl primitive keeps the "no secret
// in argv" property proven in ONE place (its real-curl round-trip test).
//
// ── ERRORS vs. REFUSALS ──
// A REFUSAL (`claimed:false`) is a NORMAL RETURN — the store arbitrated and this host lost, so
// there is nothing to retry. Only a transport failure, a non-2xx status, or an unreadable body
// THROWS a typed `LeaseAuthorityError`, and every throw carries a `retryable` flag so the claim
// layer can bound-retry the transient ones and give up loudly on the terminal ones. A claim
// path may NEVER return a silent `won:true` it did not earn — an ambiguous 2xx throws.

import {
  defaultHttpFn,
  parseProxyBody,
  resolveHostKey,
  resolveProxyBaseUrl,
  scrub,
} from "./linear-write-proxy.mjs";

/** The lease verb family. Frozen — this is DATA. Distinct from the write-proxy /agent/* family. */
export const LEASE_VERBS = Object.freeze(["entitle", "claim", "renew", "release", "revoke"]);

/**
 * Shadow-mode observation event names (Phase 3). Two names, not one name plus a flag: an
 * off-machine alert must be able to select grant vs. refuse from `attributes` alone, since
 * otel-forward strips `body.payload`. Registered in broker/namespace-parity.test.mjs by IMPORT.
 */
export const LEASE_WOULD_GRANT_EVENT = "lease.claim.would-grant";
export const LEASE_WOULD_REFUSE_EVENT = "lease.claim.would-refuse";
export const LEASE_EVENT_NAMES = Object.freeze([LEASE_WOULD_GRANT_EVENT, LEASE_WOULD_REFUSE_EVENT]);

/**
 * LeaseAuthorityError — the ONE thrown type. `retryable` splits the transient failures
 * (5xx / 429 / network / unreadable) the claim layer may bound-retry from the terminal ones
 * (4xx / auth / no-key / malformed grant) it must surface immediately. `reason` is a stable
 * machine word; `detail` is a scrubbed excerpt of the cloud's own message.
 */
export class LeaseAuthorityError extends Error {
  constructor(reason, { retryable = false, status = null, detail = null, cause = null } = {}) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "LeaseAuthorityError";
    this.reason = reason;
    this.retryable = retryable;
    this.status = status;
    this.detail = detail;
    if (cause) this.cause = cause;
  }
}

/** resolveLeaseBaseUrl — the cloud API base, the SAME one the write proxy uses. */
export function resolveLeaseBaseUrl(env = process.env) {
  return resolveProxyBaseUrl(env);
}

/** resolveLeaseRoutePath — `/lease/<verb>` for a known verb, else null (never a fabricated URL). */
export function resolveLeaseRoutePath(verb) {
  if (!LEASE_VERBS.includes(verb)) return null;
  return `/lease/${verb}`;
}

/**
 * parseLeaseHttpResult — normalize the raw `defaultHttpFn` shape (`{code, stdout, stderr}`,
 * where stdout is `"<body>\n<http_code>"`) into `{transportOk, reason, status, bodyText}`.
 *
 * A transport that could not run/complete (`code 127` spawn-failure, non-zero curl exit) is
 * `transportOk:false` with a named reason. Otherwise `transportOk:true` with the split status
 * (null when no `\n%{http_code}` trailer was written — a proxy/HTML error page).
 */
export function parseLeaseHttpResult(raw) {
  const code = raw?.code;
  if (code === 127) {
    return { transportOk: false, reason: "spawn-failed", status: null, bodyText: "" };
  }
  const text = typeof raw?.stdout === "string" ? raw.stdout : "";
  const nl = text.lastIndexOf("\n");
  const statusRaw = nl === -1 ? text : text.slice(nl + 1);
  const status = /^\d{3}$/.test(statusRaw.trim()) ? Number(statusRaw.trim()) : null;
  const bodyText = nl === -1 ? "" : text.slice(0, nl);
  if (code !== 0) return { transportOk: false, reason: "transport-error", status, bodyText };
  return { transportOk: true, reason: null, status, bodyText };
}

/**
 * defaultLeaseHttpFn — the real wire call. Delegates to the write-proxy's curl-over-stdin
 * transport (so the credential-in-argv property is proven in ONE place) and returns the
 * client-seam shape `{transportOk, reason, status, bodyText}`.
 */
export function defaultLeaseHttpFn({ url, method, token, body }) {
  return parseLeaseHttpResult(defaultHttpFn({ url, method, token, body }));
}

/** leaseErrorForStatus — map a non-2xx (or null) status to a typed, correctly-retryable error. */
function leaseErrorForStatus(status, body) {
  const detail =
    typeof body?.error === "string" ? body.error : typeof body?.reason === "string" ? body.reason : null;
  const opts = { status, detail: detail ? scrub(detail).slice(0, 300) : null };
  if (status === null) return new LeaseAuthorityError("unreadable-status", { ...opts, retryable: true });
  if (status === 429) return new LeaseAuthorityError("rate-limited", { ...opts, retryable: true });
  if (status >= 500) return new LeaseAuthorityError("server-error", { ...opts, retryable: true });
  if (status === 401 || status === 403) return new LeaseAuthorityError("unauthorized", { ...opts, retryable: false });
  if (status === 404) return new LeaseAuthorityError("not-found", { ...opts, retryable: false });
  if (status === 400) return new LeaseAuthorityError("invalid-field", { ...opts, retryable: false });
  return new LeaseAuthorityError("rejected", { ...opts, retryable: false });
}

const is2xx = (status) => status !== null && status >= 200 && status < 300;

/**
 * createLeaseAuthorityClient — the installed client.
 *
 * `{ entitle, claim, release, renew }`. Each verb builds a JSON body, POSTs it through the
 * injected `httpFn`, and maps the answer into the existing vocabulary. Seams (`env`, `httpFn`,
 * `resolveKey`, `baseUrl`) exist so the whole client is unit-testable with a fake httpFn — no
 * network in any test.
 */
export function createLeaseAuthorityClient({
  env = process.env,
  httpFn = defaultLeaseHttpFn,
  resolveKey = resolveHostKey,
  baseUrl = null,
} = {}) {
  const base = baseUrl ?? resolveLeaseBaseUrl(env);

  // callVerb — the shared request → {status, body, bodyText}. Throws on a transport failure,
  // a missing credential, or a spawn that threw. Does NOT interpret the status class — each
  // verb owns that, because success shapes differ.
  const callVerb = (verb, payload) => {
    const path = resolveLeaseRoutePath(verb);
    if (path === null) throw new LeaseAuthorityError("unknown-verb", { retryable: false });

    // ⛔ THE LOUD NO-CREDENTIAL REFUSAL. A host with no per-host key must fail with a NAMED,
    // non-retryable reason BEFORE any wire call — never degrade to a direct write, never
    // look like a success. Mirrors the write proxy's `no-cloud-token` refusal.
    const key = resolveKey(env);
    if (!key || key.value === null) {
      throw new LeaseAuthorityError("no-cloud-token", { retryable: false });
    }

    const body = JSON.stringify(payload ?? {});
    let res;
    try {
      res = httpFn({ url: `${base}${path}`, method: "POST", token: key.value, body });
    } catch (err) {
      throw new LeaseAuthorityError("transport-threw", {
        retryable: true,
        detail: scrub(err?.message ?? String(err)),
        cause: err,
      });
    }
    if (!res || res.transportOk === false) {
      throw new LeaseAuthorityError(res?.reason ?? "transport-error", {
        retryable: true,
        status: res?.status ?? null,
      });
    }
    const parsed = parseProxyBody(res.bodyText ?? "");
    return { status: res.status ?? null, body: parsed, bodyText: res.bodyText ?? "" };
  };

  return {
    baseUrl: base,

    /**
     * claim — the refusable claim. Win → `{won:true, generation:grant.nonce, grant, ...}`;
     * a refusal → `{won:false, refusal, current, attribution}` (a NORMAL return, no throw, no
     * retry). Every ambiguous or errored response THROWS — a claim may never fabricate a win.
     */
    claim({ ticket, phase, node, ttlMs = null }) {
      const payload = { ticket, phase, node };
      if (ttlMs != null) payload.ttlMs = ttlMs;
      const { status, body } = callVerb("claim", payload);

      if (is2xx(status)) {
        if (!body || typeof body !== "object") {
          throw new LeaseAuthorityError("unreadable-claim-body", { retryable: true, status });
        }
        if (body.claimed === true) {
          const nonce = body?.grant?.nonce;
          if (typeof nonce !== "string" && typeof nonce !== "number") {
            // A win we cannot turn into a generation is useless AND dangerous — fail loud
            // rather than return won:true with no token to write into cluster-generation.json.
            throw new LeaseAuthorityError("grant-missing-nonce", { retryable: false, status });
          }
          return {
            won: true,
            generation: nonce,
            grant: body.grant,
            lease: body.lease ?? null,
            attribution: body.attribution ?? null,
          };
        }
        if (body.claimed === false) {
          return {
            won: false,
            refusal: typeof body.refusal === "string" ? body.refusal : "unknown",
            current: body.current ?? null,
            attribution: body.attribution ?? null,
          };
        }
        // A 2xx that is neither a win nor a refusal is an answer we do not have.
        throw new LeaseAuthorityError("unreadable-claim", { retryable: false, status });
      }
      throw leaseErrorForStatus(status, body);
    },

    /**
     * entitle — establish/refresh this node's entitlement row. `not_entitled` self-heals by
     * calling this then re-claiming (see cluster-claim.mjs:claimViaLease).
     */
    entitle({ node, ttlMs = null, workTtlMs = null, budgetUsd = null }) {
      const payload = { node };
      if (ttlMs != null) payload.ttlMs = ttlMs;
      if (workTtlMs != null) payload.workTtlMs = workTtlMs;
      if (budgetUsd != null) payload.budgetUsd = budgetUsd;
      const { status, body } = callVerb("entitle", payload);

      if (is2xx(status)) {
        if (body && body.ok === true) return { ok: true, entitlement: body.entitlement ?? null };
        throw new LeaseAuthorityError("entitle-unreadable", { retryable: true, status });
      }
      throw leaseErrorForStatus(status, body);
    },

    /**
     * release — hand the lease back so the slot frees before TTL (the lease analogue of
     * emitFenceReleased). Best-effort by contract; a failure throws so the caller can decide,
     * but not releasing is safe — the lease expires at TTL regardless.
     */
    release({ ticket, phase, holder, nonce }) {
      const { status, body } = callVerb("release", { ticket, phase, holder, nonce });
      if (is2xx(status)) {
        if (body && typeof body === "object") {
          return { released: body.released !== false, result: body };
        }
        throw new LeaseAuthorityError("release-unreadable", { retryable: true, status });
      }
      throw leaseErrorForStatus(status, body);
    },

    /**
     * renew — OUT OF SCOPE (CTL-1786). The store requires a non-empty progress assertion
     * (invariant I2), so a mechanical keep-alive is forbidden by the store. A loud stub rather
     * than a silent no-op so a future caller cannot believe it renewed. Progress-asserted
     * renewal is the follow-up ticket.
     */
    renew() {
      throw new LeaseAuthorityError("renew-not-implemented", { retryable: false });
    },
  };
}

// ─── Auth spike (CTL-1786 Phase 1 §2) ────────────────────────────────────────
//
// The single biggest client-side risk is whether the host `CATALYST_CLOUD_TOKEN` satisfies
// the DO's admin-token gate (`requireAdminTokenPrincipal`). This probe answers it WITHOUT
// mutating anything: it POSTs a deliberately EMPTY body to `/lease/claim`, which the DO
// rejects at validation. The STATUS discriminates auth from validation:
//   400 invalid_field ⇒ AUTHORIZED — the request reached the DO and failed validation only
//                       (an invalid claim seeds no row, so this writes nothing).
//   401 / 403         ⇒ NOT AUTHORIZED — enforce is blocked on the cloud-auth dependency
//                       (CTC-418/419); shadow + the client still land, enforce is deferred.
// Reports the raw status without going through the throwing classifier.
export function probeAuth({ env = process.env, httpFn = defaultLeaseHttpFn, resolveKey = resolveHostKey } = {}) {
  const base = resolveLeaseBaseUrl(env);
  const key = resolveKey(env);
  if (!key || key.value === null) {
    return { ok: false, reason: "no-cloud-token", status: null, authorized: null };
  }
  let res;
  try {
    res = httpFn({ url: `${base}/lease/claim`, method: "POST", token: key.value, body: "{}" });
  } catch (err) {
    return { ok: false, reason: "transport-threw", detail: scrub(err?.message ?? String(err)), status: null, authorized: null };
  }
  const status = res?.status ?? null;
  // 400 (or any non-auth 4xx that is not 401/403) means the credential was accepted and only
  // the payload was rejected — i.e. authorized. 401/403 is an auth rejection.
  const authorized = status === 401 || status === 403 ? false : status !== null ? true : null;
  return { ok: true, status, authorized, bodyText: res?.bodyText ?? "" };
}

// isMain — true when run as `node lease-authority.mjs …`, false when imported. Suffix check
// (not bun-only import.meta.main) so the CLI fires under the daemon's node runtime, mirroring
// cluster-claim.mjs::isMain.
function isMain() {
  return (
    process.argv[1] &&
    (process.argv[1].endsWith("/lease-authority.mjs") || process.argv[1].endsWith("lease-authority.mjs"))
  );
}

if (isMain()) {
  const [cmd] = process.argv.slice(2);
  if (cmd === "probe" || cmd === "--probe") {
    const result = probeAuth();
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.authorized === true) {
      process.stderr.write(`lease-authority: AUTHORIZED (status ${result.status}) — enforce is not blocked on auth\n`);
      process.exit(0);
    }
    if (result.authorized === false) {
      process.stderr.write(
        `lease-authority: NOT AUTHORIZED (status ${result.status}) — enforce blocked on the cloud-auth dependency (CTC-418/419)\n`
      );
      process.exit(3);
    }
    process.stderr.write(`lease-authority: probe INCONCLUSIVE (reason=${result.reason ?? "unknown"})\n`);
    process.exit(2);
  }
  process.stderr.write("lease-authority.mjs: usage: lease-authority.mjs probe\n");
  process.exit(1);
}
