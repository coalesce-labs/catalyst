// lease-authority.test.mjs — CTL-1786 Phase 1.
// Run: cd plugins/dev/scripts/execution-core && bun test lease-authority.test.mjs
//
// The catalyst-repo CLIENT half of the lease authority (CTC-410). These tests own the
// CLIENT CONTRACT — request shapes, refusal classification vs. transport errors, and the
// grant.nonce → generation mapping — against an INJECTED fake httpFn. No network, ever.
//
// Coverage discipline (mirrors linear-write-proxy.test.mjs): every outcome cell is PINNED,
// not sampled; a refusal is proven to be a NORMAL return (no throw) and a transport/parse
// failure is proven to throw a typed error that can never read as a false win.
import { describe, expect, test } from "bun:test";
import {
  LEASE_EVENT_NAMES,
  LEASE_VERBS,
  LEASE_WOULD_GRANT_EVENT,
  LEASE_WOULD_REFUSE_EVENT,
  LeaseAuthorityError,
  createLeaseAuthorityClient,
  grantGeneration,
  parseLeaseHttpResult,
  probeAuth,
  resolveLeaseBaseUrl,
  resolveLeaseRoutePath,
} from "./lease-authority.mjs";
import { DEFAULT_CLOUD_BASE_URL } from "./linear-write-proxy.mjs";

const TOKEN = "ctok_live_abcdef0123456789";
const envWithKey = (extra = {}) => ({ CATALYST_CLOUD_TOKEN: TOKEN, ...extra });

/**
 * fakeHttp — a recording httpFn at the CLIENT seam. It records every request and returns
 * a queued response of the client's httpFn shape `{transportOk, status, bodyText}`.
 * A response may instead be a function that THROWS, to model a transport that threw.
 */
function fakeHttp(responses) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls = [];
  const httpFn = (req) => {
    calls.push(req);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === "function") return next(req);
    return next;
  };
  return { httpFn, calls };
}

/** A 2xx JSON response in the client httpFn shape. */
const ok = (obj, status = 200) => ({ transportOk: true, status, bodyText: JSON.stringify(obj) });
/** A non-2xx JSON response. */
const httpStatus = (status, obj = {}) => ({ transportOk: true, status, bodyText: JSON.stringify(obj) });

describe("lease route + base URL resolution", () => {
  test("resolveLeaseBaseUrl reuses the write-proxy base (env override honored)", () => {
    expect(resolveLeaseBaseUrl({})).toBe(DEFAULT_CLOUD_BASE_URL);
    expect(resolveLeaseBaseUrl({ CATALYST_CLOUD_BASE_URL: "https://x.example/api/v1/" })).toBe(
      "https://x.example/api/v1"
    );
  });

  test("lease route path is /lease/<verb> for every known verb, null otherwise", () => {
    for (const v of LEASE_VERBS) expect(resolveLeaseRoutePath(v)).toBe(`/lease/${v}`);
    expect(resolveLeaseRoutePath("issue-state")).toBeNull();
    expect(resolveLeaseRoutePath("")).toBeNull();
  });

  test("the verb family is distinct from the write-proxy /agent/* family", () => {
    expect(resolveLeaseRoutePath("claim").startsWith("/lease/")).toBe(true);
    expect(LEASE_VERBS).toContain("entitle");
    expect(LEASE_VERBS).toContain("claim");
    expect(LEASE_VERBS).toContain("release");
  });

  test("event names are the two shadow observation names", () => {
    expect(LEASE_EVENT_NAMES).toEqual([LEASE_WOULD_GRANT_EVENT, LEASE_WOULD_REFUSE_EVENT]);
    expect(LEASE_WOULD_GRANT_EVENT).toBe("lease.claim.would-grant");
    expect(LEASE_WOULD_REFUSE_EVENT).toBe("lease.claim.would-refuse");
  });
});

describe("parseLeaseHttpResult — raw transport → {transportOk,status,bodyText}", () => {
  test("splits the trailing status line off the body", () => {
    const r = parseLeaseHttpResult({ code: 0, stdout: '{"claimed":true}\n200', stderr: "" });
    expect(r).toEqual({ transportOk: true, reason: null, status: 200, bodyText: '{"claimed":true}' });
  });
  test("code 127 → spawn-failed, not transportOk", () => {
    expect(parseLeaseHttpResult({ code: 127, stdout: "", stderr: "boom" })).toMatchObject({
      transportOk: false,
      reason: "spawn-failed",
    });
  });
  test("non-zero exit → transport-error, carries the status if present", () => {
    expect(parseLeaseHttpResult({ code: 7, stdout: "\n500", stderr: "" })).toMatchObject({
      transportOk: false,
      reason: "transport-error",
      status: 500,
    });
  });
  test("a 2xx with no parseable status line is transportOk with status null", () => {
    expect(parseLeaseHttpResult({ code: 0, stdout: "not-a-status", stderr: "" })).toMatchObject({
      transportOk: true,
      status: null,
    });
  });
});

describe("grantGeneration — the fence-compatible NUMERIC generation mapping", () => {
  test("a numeric nonce is the generation (the plan's nonce-as-generation)", () => {
    expect(grantGeneration({ nonce: 7 })).toBe(7);
    expect(grantGeneration({ nonce: "42" })).toBe(42);
  });
  test("a non-numeric nonce falls back to coordinationHeadSeqAtGrant (still a finite number)", () => {
    expect(grantGeneration({ nonce: "uuid-abc", coordinationHeadSeqAtGrant: 5 })).toBe(5);
  });
  test("neither numeric → null (caller throws rather than freeze the fence)", () => {
    expect(grantGeneration({ nonce: "uuid-abc" })).toBeNull();
    expect(grantGeneration({})).toBeNull();
    expect(grantGeneration(null)).toBeNull();
  });
});

describe("claim — request shape", () => {
  test("POSTs to ${base}/lease/claim with body {ticket,phase,node,ttlMs} and the key as bearer", () => {
    const { httpFn, calls } = fakeHttp(ok({ claimed: true, grant: { nonce: 1, expiresAtMs: 1, scope: { ticket: "CTL-1", phase: "implement" } } }));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    client.claim({ ticket: "CTL-1", phase: "implement", node: "mini", ttlMs: 60000 });
    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${DEFAULT_CLOUD_BASE_URL}/lease/claim`);
    expect(req.token).toBe(TOKEN);
    expect(JSON.parse(req.body)).toEqual({ ticket: "CTL-1", phase: "implement", node: "mini", ttlMs: 60000 });
    // The credential is carried ONLY as the httpFn token arg (curl --config, never argv —
    // that property is proven in linear-write-proxy.test.mjs's real-curl round-trip). It must
    // never leak into the url or the body.
    expect(req.url).not.toContain(TOKEN);
    expect(req.body).not.toContain(TOKEN);
  });

  test("ttlMs is omitted from the body when not supplied", () => {
    const { httpFn, calls } = fakeHttp(ok({ claimed: false, refusal: "lease_held" }));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" });
    expect(JSON.parse(calls[0].body)).toEqual({ ticket: "CTL-1", phase: "implement", node: "mini" });
  });
});

describe("claim — outcome classification", () => {
  test("win: {claimed:true, grant:{nonce}} → {won:true, generation:nonce}", () => {
    const grant = { nonce: 314, expiresAtMs: 123, scope: { ticket: "CTL-1", phase: "implement" } };
    const { httpFn } = fakeHttp(ok({ claimed: true, grant, lease: { id: "L1" }, attribution: { by: "store" } }));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    const res = client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" });
    expect(res.won).toBe(true);
    expect(res.generation).toBe(314);
    expect(res.grant).toEqual(grant);
  });

  test("loss lease_held → {won:false, refusal:'lease_held'}, NO throw", () => {
    const { httpFn, calls } = fakeHttp(ok({ claimed: false, refusal: "lease_held", current: { holder: "mini-2" } }));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    const res = client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" });
    expect(res).toMatchObject({ won: false, refusal: "lease_held" });
    // The store already arbitrated — exactly ONE call, no retry.
    expect(calls).toHaveLength(1);
  });

  test("loss not_entitled → surfaced distinctly so the caller can entitle", () => {
    const { httpFn } = fakeHttp(ok({ claimed: false, refusal: "not_entitled" }));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    const res = client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" });
    expect(res).toMatchObject({ won: false, refusal: "not_entitled" });
  });

  test("claimed:true but grant.nonce missing → typed error, NEVER a silent won:true", () => {
    const { httpFn } = fakeHttp(ok({ claimed: true, grant: {} }));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    expect(() => client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" })).toThrow(LeaseAuthorityError);
  });

  test("2xx body with neither claimed:true nor claimed:false → typed error (never a false win)", () => {
    const { httpFn } = fakeHttp(ok({ hello: "world" }));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    expect(() => client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" })).toThrow(LeaseAuthorityError);
  });
});

describe("claim — HTTP error classification", () => {
  test("400 invalid_field → LeaseAuthorityError, status carried, NOT retryable, NOT a win", () => {
    const { httpFn } = fakeHttp(httpStatus(400, { error: "invalid_field" }));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    try {
      client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LeaseAuthorityError);
      expect(err.status).toBe(400);
      expect(err.retryable).toBe(false);
    }
  });

  test("401/403 → unauthorized, NOT retryable", () => {
    for (const status of [401, 403]) {
      const { httpFn } = fakeHttp(httpStatus(status, { error: "forbidden" }));
      const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
      try {
        client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(LeaseAuthorityError);
        expect(err.retryable).toBe(false);
        expect(err.status).toBe(status);
      }
    }
  });

  test("5xx → transient error flagged retryable", () => {
    const { httpFn } = fakeHttp(httpStatus(503, { error: "unavailable" }));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    try {
      client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LeaseAuthorityError);
      expect(err.retryable).toBe(true);
      expect(err.status).toBe(503);
    }
  });

  test("429 → retryable", () => {
    const { httpFn } = fakeHttp(httpStatus(429, {}));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    expect(() => client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" })).toThrow(LeaseAuthorityError);
    try {
      client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" });
    } catch (err) {
      expect(err.retryable).toBe(true);
    }
  });

  test("network throw → typed transient error flagged retryable", () => {
    const { httpFn } = fakeHttp(() => {
      throw new Error("ECONNREFUSED");
    });
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    try {
      client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LeaseAuthorityError);
      expect(err.retryable).toBe(true);
    }
  });

  test("transport did not complete (transportOk:false) → retryable error", () => {
    const { httpFn } = fakeHttp({ transportOk: false, reason: "transport-error", status: null, bodyText: "" });
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    try {
      client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LeaseAuthorityError);
      expect(err.retryable).toBe(true);
    }
  });

  test("malformed/absent JSON body on a 2xx → typed error, never a silent {won:true}", () => {
    const { httpFn } = fakeHttp({ transportOk: true, status: 200, bodyText: "<html>gateway</html>" });
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    let threw = null;
    try {
      client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(LeaseAuthorityError);
  });

  test("no per-host cloud key → typed error, never a direct/false win", () => {
    const { httpFn, calls } = fakeHttp(ok({ claimed: true, grant: { nonce: "n" } }));
    const client = createLeaseAuthorityClient({ env: {}, httpFn }); // no CATALYST_CLOUD_TOKEN
    try {
      client.claim({ ticket: "CTL-1", phase: "implement", node: "mini" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LeaseAuthorityError);
      expect(err.reason).toBe("no-cloud-token");
    }
    // Refused BEFORE any wire call.
    expect(calls).toHaveLength(0);
  });
});

describe("entitle", () => {
  test("POSTs {node,ttlMs,workTtlMs,budgetUsd} → {ok:true, entitlement}", () => {
    const { httpFn, calls } = fakeHttp(ok({ ok: true, entitlement: { node: "mini", expiresAtMs: 9 } }));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    const res = client.entitle({ node: "mini", ttlMs: 1000, workTtlMs: 2000, budgetUsd: 5 });
    expect(calls[0].url).toBe(`${DEFAULT_CLOUD_BASE_URL}/lease/entitle`);
    expect(JSON.parse(calls[0].body)).toEqual({ node: "mini", ttlMs: 1000, workTtlMs: 2000, budgetUsd: 5 });
    expect(res).toEqual({ ok: true, entitlement: { node: "mini", expiresAtMs: 9 } });
  });

  test("a non-ok 2xx entitle body → typed error, never a false ok", () => {
    const { httpFn } = fakeHttp(ok({ ok: false }));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    expect(() => client.entitle({ node: "mini" })).toThrow(LeaseAuthorityError);
  });

  test("4xx entitle → typed error", () => {
    const { httpFn } = fakeHttp(httpStatus(403, {}));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    expect(() => client.entitle({ node: "mini" })).toThrow(LeaseAuthorityError);
  });
});

describe("release", () => {
  test("POSTs {ticket,phase,holder,nonce} → parses ReleaseResult", () => {
    const { httpFn, calls } = fakeHttp(ok({ released: true, generation: 2 }));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    const res = client.release({ ticket: "CTL-1", phase: "implement", holder: "mini", nonce: "n1" });
    expect(calls[0].url).toBe(`${DEFAULT_CLOUD_BASE_URL}/lease/release`);
    expect(JSON.parse(calls[0].body)).toEqual({ ticket: "CTL-1", phase: "implement", holder: "mini", nonce: "n1" });
    expect(res.released).toBe(true);
  });

  test("4xx release → typed error", () => {
    const { httpFn } = fakeHttp(httpStatus(500, {}));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    try {
      client.release({ ticket: "CTL-1", phase: "implement", holder: "mini", nonce: "n1" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LeaseAuthorityError);
      expect(err.retryable).toBe(true);
    }
  });
});

describe("probeAuth — the non-mutating auth spike", () => {
  test("400 (validation only) reads as AUTHORIZED — reached the DO", () => {
    const { httpFn } = fakeHttp(httpStatus(400, { error: "invalid_field" }));
    const r = probeAuth({ env: envWithKey(), httpFn });
    expect(r).toMatchObject({ ok: true, status: 400, authorized: true });
  });
  test("401/403 reads as NOT AUTHORIZED", () => {
    for (const status of [401, 403]) {
      const { httpFn } = fakeHttp(httpStatus(status, {}));
      const r = probeAuth({ env: envWithKey(), httpFn });
      expect(r).toMatchObject({ ok: true, status, authorized: false });
    }
  });
  test("posts an EMPTY body to /lease/claim and never throws", () => {
    const { httpFn, calls } = fakeHttp(httpStatus(400, {}));
    probeAuth({ env: envWithKey(), httpFn });
    expect(calls[0].url).toBe(`${DEFAULT_CLOUD_BASE_URL}/lease/claim`);
    expect(calls[0].body).toBe("{}");
  });
  test("no key → ok:false, no wire call", () => {
    const { httpFn, calls } = fakeHttp(httpStatus(400, {}));
    const r = probeAuth({ env: {}, httpFn });
    expect(r).toMatchObject({ ok: false, reason: "no-cloud-token" });
    expect(calls).toHaveLength(0);
  });
});

describe("renew — stub (progress-asserted renewal is out of scope, CTL-1786)", () => {
  test("renew throws a typed not-implemented error (no silent no-op)", () => {
    const { httpFn } = fakeHttp(ok({}));
    const client = createLeaseAuthorityClient({ env: envWithKey(), httpFn });
    expect(() => client.renew({ ticket: "CTL-1", phase: "implement", holder: "mini", nonce: "n1" })).toThrow(
      LeaseAuthorityError
    );
  });
});
