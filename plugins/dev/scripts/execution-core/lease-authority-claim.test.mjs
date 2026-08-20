// lease-authority-claim.test.mjs — CTL-1786 Phase 2.
// Run: cd plugins/dev/scripts/execution-core && bun test lease-authority-claim.test.mjs
//
// The two Gherkin acceptance criteria, executable at the CLIENT-CONTRACT level against a FAKE
// authority that enforces single-winner-per-(ticket,phase). Plus the self-heal / retry / no-retry
// discipline claimViaLease adds on top of the raw client.
//
//   AC-1  Two racers cannot both win — exactly one gets {won:true}, the loser {won:false} with NO
//         retry and NO throw. NEGATIVE CONTROL: a fake authority that (wrongly) grants both makes
//         the AC-1 assertion FAIL, proving it depends on single-winner arbitration.
//   AC-2  Claim before work — a {won:false} produces NO observable side effect: the loser mutates
//         nothing in the store, writes no generation, emits no fence, invokes no dispatch hook.
import { describe, expect, test } from "bun:test";
import { claimViaLease } from "./cluster-claim.mjs";
import { LeaseAuthorityError, ensureEntitled } from "./lease-authority.mjs";

/**
 * makeFakeAuthority — an in-memory lease store that models the DO's single-winner CAS. `claim`
 * grants iff the (ticket,phase) slot is free (and the node is entitled, when required); a second
 * claim while held is refused `lease_held`. `grantBoth:true` is the NEGATIVE CONTROL — it hands a
 * grant to every caller, so any test that truly depends on single-winner must fail under it.
 */
function makeFakeAuthority({ grantBoth = false, requireEntitlement = false } = {}) {
  const leases = new Map(); // `${ticket}::${phase}` -> {holder, nonce}
  const entitled = new Set();
  let nonceSeq = 0;
  const calls = { claim: 0, entitle: 0, release: 0 };
  const client = {
    claim({ ticket, phase, node }) {
      calls.claim += 1;
      if (requireEntitlement && !entitled.has(node)) {
        return { won: false, refusal: "not_entitled" };
      }
      const key = `${ticket}::${phase}`;
      const held = leases.get(key);
      if (held && !grantBoth) {
        return { won: false, refusal: "lease_held", current: held };
      }
      // Numeric nonce — the fence machinery requires a finite-number generation (see
      // grantGeneration). The real client maps grant → number; this fake returns the mapped
      // value directly since it stands in for the whole client.
      const nonce = (nonceSeq += 1);
      if (!held) leases.set(key, { holder: node, nonce });
      return { won: true, generation: nonce, grant: { nonce } };
    },
    entitle({ node }) {
      calls.entitle += 1;
      entitled.add(node);
      return { ok: true, entitlement: { node, expiresAtMs: 1_000_000 } };
    },
    release({ ticket, phase }) {
      calls.release += 1;
      leases.delete(`${ticket}::${phase}`);
      return { released: true };
    },
  };
  return { client, leases, entitled, calls };
}

describe("AC-1 — two racers, exactly one wins", () => {
  test("exactly one of two claims for the same (ticket,phase) wins; the loser does not throw or retry", async () => {
    const authority = makeFakeAuthority();
    const a = await claimViaLease({ ticket: "CTL-1", phase: "implement", hostName: "mini", client: authority.client });
    const b = await claimViaLease({ ticket: "CTL-1", phase: "implement", hostName: "mini-2", client: authority.client });
    const wins = [a, b].filter((r) => r.won).length;
    expect(wins).toBe(1);
    const loser = a.won ? b : a;
    expect(loser).toMatchObject({ won: false, generation: null });
    // The store arbitrated: the loser issued exactly one claim call (2 claims total), no retry.
    expect(authority.calls.claim).toBe(2);
  });

  test("NEGATIVE CONTROL: a fake authority that grants BOTH breaks single-winner (proves the assertion has teeth)", async () => {
    const authority = makeFakeAuthority({ grantBoth: true });
    const a = await claimViaLease({ ticket: "CTL-1", phase: "implement", hostName: "mini", client: authority.client });
    const b = await claimViaLease({ ticket: "CTL-1", phase: "implement", hostName: "mini-2", client: authority.client });
    const wins = [a, b].filter((r) => r.won).length;
    // Under a correct authority this would be 1; the broken authority makes it 2, which is exactly
    // what the AC-1 test above asserts against.
    expect(wins).toBe(2);
  });

  test("the winner's generation is the grant nonce (fence-guard equality token)", async () => {
    const authority = makeFakeAuthority();
    const res = await claimViaLease({ ticket: "CTL-9", phase: "triage", hostName: "mini", client: authority.client });
    expect(res.won).toBe(true);
    expect(Number.isFinite(res.generation)).toBe(true);
    expect(authority.leases.get("CTL-9::triage").nonce).toBe(res.generation);
  });
});

describe("AC-2 — claim before work, never work before claim", () => {
  test("a {won:false} loser mutates NOTHING and triggers no side-effect hook", async () => {
    const authority = makeFakeAuthority();
    // Pre-hold the slot for a peer.
    await claimViaLease({ ticket: "CTL-1", phase: "implement", hostName: "peer", client: authority.client });
    const before = { ...authority.leases.get("CTL-1::implement") };

    // Model the exact call-site gate (scheduler.mjs / monitor.mjs): only act on a confirmed grant.
    const spies = { writeGeneration: 0, emitFence: 0, dispatch: 0 };
    const res = await claimViaLease({ ticket: "CTL-1", phase: "implement", hostName: "mini", client: authority.client });
    if (res.won) {
      spies.writeGeneration += 1;
      spies.emitFence += 1;
      spies.dispatch += 1;
    }

    expect(res.won).toBe(false);
    expect(spies).toEqual({ writeGeneration: 0, emitFence: 0, dispatch: 0 });
    // The loser wrote nothing to the store, and never released the peer's lease.
    expect(authority.leases.get("CTL-1::implement")).toEqual(before);
    expect(authority.calls.release).toBe(0);
  });

  test("POSITIVE CONTROL: a winner DOES fire the side-effect hooks with a real generation", async () => {
    const authority = makeFakeAuthority();
    const spies = { writeGeneration: null };
    const res = await claimViaLease({ ticket: "CTL-2", phase: "implement", hostName: "mini", client: authority.client });
    if (res.won) spies.writeGeneration = res.generation;
    expect(res.won).toBe(true);
    expect(spies.writeGeneration).toBe(res.generation);
    expect(spies.writeGeneration).not.toBeNull();
  });
});

describe("not_entitled self-heals; transient retries; lease_held never retries", () => {
  test("not_entitled → client entitles the node once → re-claim wins", async () => {
    const authority = makeFakeAuthority({ requireEntitlement: true });
    const res = await claimViaLease({ ticket: "CTL-1", phase: "implement", hostName: "mini", client: authority.client });
    expect(res.won).toBe(true);
    expect(authority.calls.entitle).toBe(1);
    // one refused claim + one winning claim
    expect(authority.calls.claim).toBe(2);
  });

  test("a second not_entitled (entitle didn't take) does NOT loop forever — returns won:false", async () => {
    // A client that always refuses not_entitled, and an entitle that reports ok but never sticks.
    let claims = 0;
    const client = {
      claim: () => {
        claims += 1;
        return { won: false, refusal: "not_entitled" };
      },
      entitle: () => ({ ok: true, entitlement: {} }),
    };
    const res = await claimViaLease({ ticket: "CTL-1", phase: "implement", hostName: "mini", client });
    expect(res).toMatchObject({ won: false, generation: null });
    // exactly two claims: the first, and the one after the single entitle self-heal.
    expect(claims).toBe(2);
  });

  test("a lease_held refusal is NOT retried — one claim call, silent backoff", async () => {
    let claims = 0;
    const client = {
      claim: () => {
        claims += 1;
        return { won: false, refusal: "lease_held" };
      },
      entitle: () => ({ ok: true, entitlement: {} }),
    };
    const res = await claimViaLease({ ticket: "CTL-1", phase: "implement", hostName: "mini", client });
    expect(res).toMatchObject({ won: false, generation: null });
    expect(claims).toBe(1);
  });

  test("transient (retryable) error → bounded retry then win", async () => {
    let attempts = 0;
    const client = {
      claim: () => {
        attempts += 1;
        if (attempts <= 2) throw new LeaseAuthorityError("server-error", { retryable: true, status: 503 });
        return { won: true, generation: 99, grant: { nonce: 99 } };
      },
      entitle: () => ({ ok: true, entitlement: {} }),
    };
    const res = await claimViaLease({ ticket: "CTL-1", phase: "implement", hostName: "mini", client, maxRetries: 2 });
    expect(res.won).toBe(true);
    expect(attempts).toBe(3);
  });

  test("transient error beyond the retry cap → THROWS (so runCli yields exit 11)", async () => {
    let attempts = 0;
    const client = {
      claim: () => {
        attempts += 1;
        throw new LeaseAuthorityError("server-error", { retryable: true, status: 503 });
      },
      entitle: () => ({ ok: true, entitlement: {} }),
    };
    let threw = null;
    try {
      await claimViaLease({ ticket: "CTL-1", phase: "implement", hostName: "mini", client, maxRetries: 2 });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(LeaseAuthorityError);
    expect(attempts).toBe(3); // initial + 2 retries
  });

  test("a NON-retryable error is surfaced immediately (no retry) so the caller stalls loudly", async () => {
    let attempts = 0;
    const client = {
      claim: () => {
        attempts += 1;
        throw new LeaseAuthorityError("unauthorized", { retryable: false, status: 403 });
      },
      entitle: () => ({ ok: true, entitlement: {} }),
    };
    await expect(
      claimViaLease({ ticket: "CTL-1", phase: "implement", hostName: "mini", client, maxRetries: 5 })
    ).rejects.toBeInstanceOf(LeaseAuthorityError);
    expect(attempts).toBe(1);
  });

  test("no client → throws a typed error (never a silent win)", async () => {
    await expect(
      claimViaLease({ ticket: "CTL-1", phase: "implement", hostName: "mini", client: null })
    ).rejects.toBeInstanceOf(LeaseAuthorityError);
  });
});

describe("ensureEntitled — idempotent + TTL-aware", () => {
  test("re-entitles when there is no cached deadline", () => {
    const authority = makeFakeAuthority();
    const r = ensureEntitled({ client: authority.client, node: "mini" });
    expect(r.entitled).toBe(true);
    expect(r.refreshed).toBe(true);
    expect(authority.calls.entitle).toBe(1);
  });

  test("skips the call when the cached deadline is beyond the refresh window", () => {
    const authority = makeFakeAuthority();
    const now = () => 1000;
    const r = ensureEntitled({
      client: authority.client,
      node: "mini",
      cachedExpiresAtMs: 1000 + 60 * 60_000, // 1h out
      now,
      refreshWindowMs: 5 * 60_000,
    });
    expect(r.refreshed).toBe(false);
    expect(authority.calls.entitle).toBe(0);
  });

  test("re-entitles when the cached deadline is within the refresh window", () => {
    const authority = makeFakeAuthority();
    const now = () => 1000;
    const r = ensureEntitled({
      client: authority.client,
      node: "mini",
      cachedExpiresAtMs: 1000 + 60_000, // 1 min out, inside a 5-min window
      now,
      refreshWindowMs: 5 * 60_000,
    });
    expect(r.refreshed).toBe(true);
    expect(authority.calls.entitle).toBe(1);
  });
});
