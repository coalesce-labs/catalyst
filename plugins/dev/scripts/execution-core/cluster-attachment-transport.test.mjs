// cluster-attachment-transport.test.mjs — CTL-1889 increment 3 / CTC-692.
// Run: cd plugins/dev/scripts/execution-core && bun test cluster-attachment-transport.test.mjs
//
// ⛔ WHAT THIS SUITE IS FOR. `cluster-claim.mjs` is the fleet's cross-host mutex. Moving its
// two Linear calls onto the cloud proxy swaps a transport that THROWS on failure
// (`defaultPost`) for one that NEVER throws (`proxy.send`/`proxy.read` return tagged
// verdicts). Every test below exists because that swap has a specific way of turning a
// refusal into a silent double claim, and each one is written to FAIL if the throw is
// removed — the mutation controls at the bottom prove that rather than assume it.
import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_READ_ROUTE,
  ATTACHMENT_WRITE_ROUTE,
  AttachmentTransportError,
  createGraphqlAttachmentTransport,
  createProxyAttachmentTransport,
  resolveAttachmentTransport,
} from "./cluster-attachment-transport.mjs";
import { claimTicket, fenceUrl, readClaim, writeClaim } from "./cluster-claim.mjs";

/** A proxy double. Records calls; the verdicts are supplied per test. */
function fakeProxy({ sendResult, readResult } = {}) {
  const calls = { send: [], read: [] };
  return {
    calls,
    send(args) {
      calls.send.push(args);
      return typeof sendResult === "function" ? sendResult(args) : sendResult;
    },
    read(args) {
      calls.read.push(args);
      return typeof readResult === "function" ? readResult(args) : readResult;
    },
  };
}

const OK_SEND = { handled: true, applied: true, reason: null, status: 200 };
const okRead = (attachments = []) => ({ ok: true, attachments, reason: null, status: 200 });

/** A fence node as the cloud reports it. */
const fenceNode = (ticket, meta) => ({
  id: `att-${ticket}`,
  url: fenceUrl(ticket),
  metadata: meta,
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 1. THE READ — a refusal must THROW, never become "no claim exists"
// ══════════════════════════════════════════════════════════════════════════════════════

describe("the read-back refuses LOUDLY (the fencing-token reset)", () => {
  // Every refusal shape `proxy.read` can produce. Each must throw; none may yield [].
  const refusals = [
    ["no-cloud-token", { ok: false, reason: "no-cloud-token", status: null }],
    ["server-error", { ok: false, reason: "server-error", status: 503 }],
    ["rate-limited", { ok: false, reason: "rate-limited", status: 429 }],
    ["unauthorized", { ok: false, reason: "unauthorized", status: 403 }],
    ["read-unreadable (a 200 whose body we cannot read)", { ok: false, reason: "read-unreadable", status: 200 }],
    ["cloud:failed — the MAX_ATTACHMENT_PAGES bound was hit", { ok: false, reason: "cloud:failed", status: 502 }],
    ["cloud:rejected — no such issue", { ok: false, reason: "cloud:rejected", status: 404 }],
    ["a malformed verdict (undefined)", undefined],
  ];

  for (const [label, readResult] of refusals) {
    test(`readAttachments THROWS on ${label}`, async () => {
      const t = createProxyAttachmentTransport({ proxy: fakeProxy({ readResult }) });
      await expect(t.readAttachments("CTL-1")).rejects.toBeInstanceOf(AttachmentTransportError);
    });
  }

  test("⛔ a refused read does NOT reset the fencing token — claimTicket propagates, it does not claim at generation 1", async () => {
    // The scenario that makes this the most dangerous line in the increment: another host
    // holds CTL-1 at generation 7, and our read-back fails. If the failure became `[]`,
    // `nextGen` would be 1 and the CAS would report a WIN on a ticket we do not own.
    const proxy = fakeProxy({
      readResult: { ok: false, reason: "server-error", status: 503 },
      sendResult: OK_SEND,
    });
    const transport = createProxyAttachmentTransport({ proxy });

    await expect(claimTicket("CTL-1", "mini", "triage", { transport })).rejects.toThrow(
      /server-error/,
    );
    // ⛔ THE ASSERTION THAT OWNS THIS TEST: no write was attempted at all. A claim we could
    // not even read is a claim we must not write, because the generation we would write is
    // a fabrication.
    expect(proxy.calls.send).toHaveLength(0);
  });

  test("NEGATIVE CONTROL — the same path SUCCEEDS when the read answers, so the test above is not passing on a broken harness", async () => {
    const store = new Map();
    const proxy = upsertingProxy(store);
    const transport = createProxyAttachmentTransport({ proxy });
    const res = await claimTicket("CTL-1", "mini", "triage", { transport });
    expect(res).toEqual({ won: true, generation: 1 });
  });

  test("an EMPTY list is a real answer and stays one — 'no fence' must not be collapsed into the failure case", async () => {
    const transport = createProxyAttachmentTransport({ proxy: fakeProxy({ readResult: okRead([]) }) });
    await expect(transport.readAttachments("CTL-1")).resolves.toEqual([]);
    await expect(readClaim("CTL-1", { transport })).resolves.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 2. THE WRITE — a refusal must THROW, or the stale-preemption branch invents a win
// ══════════════════════════════════════════════════════════════════════════════════════

describe("the write refuses LOUDLY (the unearned win)", () => {
  const refusals = [
    ["budget:day-exhausted", { handled: true, applied: false, reason: "budget:day-exhausted" }],
    ["budget:ticket-cap", { handled: true, applied: false, reason: "budget:ticket-cap" }],
    ["no-cloud-token", { handled: true, applied: false, reason: "no-cloud-token" }],
    ["server-error", { handled: true, applied: false, reason: "server-error" }],
    ["cloud:rejected", { handled: true, applied: false, reason: "cloud:rejected" }],
    ["handled:false (a mode this path excludes)", { handled: false, applied: false, reason: "shadow" }],
    ["a malformed verdict (undefined)", undefined],
  ];

  for (const [label, sendResult] of refusals) {
    test(`upsertAttachment THROWS on ${label}`, async () => {
      const t = createProxyAttachmentTransport({ proxy: fakeProxy({ sendResult }) });
      await expect(
        t.upsertAttachment({ ticket: "CTL-1", url: "catalyst://fence/CTL-1", title: "m", metadata: {} }),
      ).rejects.toBeInstanceOf(AttachmentTransportError);
    });
  }

  test("⛔ THE STALE-PREEMPTION BRANCH: a refused write must NOT return won:true — there is no read-back on that path to catch it", async () => {
    // A stale claim held by ANOTHER host takes the preemption branch, which is:
    //     await writeClaim(...); return { won: true, generation: nextGen };
    // Nothing verifies the write. The throw is the only guard, so this is the test that
    // proves a budget refusal cannot become a fleet-wide double dispatch.
    const stale = {
      owner_host: "mini-2",
      catalyst_generation: 7,
      phase: "triage",
      claimed_at: new Date(1_000).toISOString(),
    };
    const proxy = fakeProxy({
      readResult: okRead([fenceNode("CTL-1", stale)]),
      sendResult: { handled: true, applied: false, reason: "budget:day-exhausted" },
    });
    const transport = createProxyAttachmentTransport({ proxy });

    const claim = claimTicket("CTL-1", "mini", "triage", {
      transport,
      staleMs: 1,
      now: () => 10_000_000,
    });
    await expect(claim).rejects.toThrow(/budget:day-exhausted/);
    // The preemption branch WAS taken (one write attempted, no read-back after it) — so this
    // test is exercising the unguarded path and not some earlier bail-out.
    expect(proxy.calls.send).toHaveLength(1);
    expect(proxy.calls.read).toHaveLength(1);
  });

  test("NEGATIVE CONTROL — the same stale preemption WINS when the write is applied", async () => {
    const stale = {
      owner_host: "mini-2",
      catalyst_generation: 7,
      phase: "triage",
      claimed_at: new Date(1_000).toISOString(),
    };
    const proxy = fakeProxy({ readResult: okRead([fenceNode("CTL-1", stale)]), sendResult: OK_SEND });
    const transport = createProxyAttachmentTransport({ proxy });
    await expect(
      claimTicket("CTL-1", "mini", "triage", { transport, staleMs: 1, now: () => 10_000_000 }),
    ).resolves.toEqual({ won: true, generation: 8 });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 3. THE SOFT-CAS ITSELF, THROUGH THE PROXY — a lost race is a refusal
// ══════════════════════════════════════════════════════════════════════════════════════

/**
 * An upsert-on-url proxy double that behaves like the LIVE route as measured on 2026-08-18:
 * the same url replaces the same node's metadata and never duplicates. Interleaving is
 * driven by the test, so the race is deterministic rather than timing-dependent.
 */
function upsertingProxy(store) {
  return {
    calls: { send: [], read: [] },
    send({ payload }) {
      store.set(payload.url, { id: `att-${payload.url}`, url: payload.url, metadata: payload.metadata });
      return OK_SEND;
    },
    read() {
      return okRead([...store.values()]);
    },
  };
}

describe("the soft-CAS survives the proxy", () => {
  test("⛔ two claimers, WRITES INTERLEAVED BEFORE EITHER READS BACK — exactly one wins", async () => {
    // The true-race ordering: A writes, B writes, then both read back. B wrote last, so B's
    // read-back shows B and A's shows B — one winner, one refusal. This is the ordering the
    // mechanism is designed for, and it must hold identically through the proxy.
    const store = new Map();
    const proxy = upsertingProxy(store);
    const transport = createProxyAttachmentTransport({ proxy });

    const [a, b] = await Promise.all([
      claimTicket("CTL-1", "host-a", "triage", { transport }),
      claimTicket("CTL-1", "host-b", "triage", { transport }),
    ]);

    const winners = [a, b].filter((r) => r.won);
    expect(winners).toHaveLength(1);
    // ⛔ And the LOSER is a refusal, not a silent success: `won:false` is what makes the
    // caller back off rather than dispatch.
    expect([a, b].filter((r) => !r.won)).toHaveLength(1);
  });

  test("the winner's generation is the one written, and the fence carries the winner's host", async () => {
    const store = new Map();
    const transport = createProxyAttachmentTransport({ proxy: upsertingProxy(store) });
    const [a, b] = await Promise.all([
      claimTicket("CTL-1", "host-a", "triage", { transport }),
      claimTicket("CTL-1", "host-b", "triage", { transport }),
    ]);
    const winner = [a, b].find((r) => r.won);
    const fence = await readClaim("CTL-1", { transport });
    expect(fence.generation).toBe(winner.generation);
    expect(["host-a", "host-b"]).toContain(fence.owner_host);
  });

  test("the upsert never duplicates the fence node — one url, one node, as measured live", async () => {
    const store = new Map();
    const transport = createProxyAttachmentTransport({ proxy: upsertingProxy(store) });
    await writeClaim("CTL-1", { owner_host: "a", generation: 1, phase: "p" }, { transport });
    await writeClaim("CTL-1", { owner_host: "a", generation: 2, phase: "p" }, { transport });
    expect([...store.keys()]).toEqual([fenceUrl("CTL-1")]);
    await expect(readClaim("CTL-1", { transport })).resolves.toMatchObject({ generation: 2 });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 4. THE ROUTE CONTRACT — what is sent, and what is deliberately NOT
// ══════════════════════════════════════════════════════════════════════════════════════

describe("the proxy transport's wire contract", () => {
  test("⭐ the IDENTIFIER is passed through with NO UUID resolution — the measured property this increment depends on", async () => {
    const proxy = fakeProxy({ sendResult: OK_SEND, readResult: okRead([]) });
    const transport = createProxyAttachmentTransport({ proxy });
    await transport.upsertAttachment({
      ticket: "CTL-1889",
      url: "catalyst://fence/CTL-1889",
      title: "catalyst-meta",
      metadata: { a: 1 },
    });
    expect(proxy.calls.send[0].payload.issueId).toBe("CTL-1889");
    // And the read-back asks by the same identifier, on the read route.
    await transport.readAttachments("CTL-1889");
    expect(proxy.calls.read[0]).toMatchObject({
      routeId: ATTACHMENT_READ_ROUTE,
      query: { issueId: "CTL-1889" },
    });
  });

  test("a caller-supplied UUID is used verbatim when present (the cluster-claim-sync cache path)", async () => {
    const proxy = fakeProxy({ sendResult: OK_SEND });
    const transport = createProxyAttachmentTransport({ proxy });
    await transport.upsertAttachment({
      ticket: "CTL-1889",
      issueId: "8fd311c5-uuid",
      url: "u",
      title: "t",
      metadata: {},
    });
    expect(proxy.calls.send[0].payload.issueId).toBe("8fd311c5-uuid");
  });

  test("the write goes to the write route and the read to the read route — never crossed", async () => {
    const proxy = fakeProxy({ sendResult: OK_SEND, readResult: okRead([]) });
    const transport = createProxyAttachmentTransport({ proxy });
    await transport.upsertAttachment({ ticket: "T", url: "u", title: "t", metadata: {} });
    await transport.readAttachments("T");
    expect(proxy.calls.send[0].routeId).toBe(ATTACHMENT_WRITE_ROUTE);
    expect(proxy.calls.read[0].routeId).toBe(ATTACHMENT_READ_ROUTE);
  });

  test("⛔ the read-back goes through `read`, NOT `send` — that is what keeps it off the write budget", async () => {
    const proxy = fakeProxy({ readResult: okRead([]) });
    await createProxyAttachmentTransport({ proxy }).readAttachments("T");
    // If a future edit routed the read through `send`, every claim would spend TWO budget
    // units and an exhausted host could no longer VERIFY a claim — so it would stop
    // dispatching entirely. Asserting the absence positively.
    expect(proxy.calls.send).toHaveLength(0);
    expect(proxy.calls.read).toHaveLength(1);
  });

  test("a proxy missing either half is refused at construction, by name", () => {
    expect(() => createProxyAttachmentTransport({ proxy: { send() {} } })).toThrow(/no-proxy/);
    expect(() => createProxyAttachmentTransport({ proxy: null })).toThrow(/no-proxy/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 5. MODE SELECTION — enforce uses the proxy, everything else is the untouched old path
// ══════════════════════════════════════════════════════════════════════════════════════

describe("resolveAttachmentTransport", () => {
  const post = async () => ({ issue: { id: "u", attachments: { nodes: [] } } });

  test("enforce + a proxy → the proxy transport", () => {
    const t = resolveAttachmentTransport({ mode: "enforce", post, proxy: fakeProxy({}) });
    expect(t.via).toBe("proxy");
  });

  for (const mode of ["off", "shadow"]) {
    test(`${mode} → the app-actor transport, unchanged`, () => {
      expect(resolveAttachmentTransport({ mode, post, proxy: fakeProxy({}) }).via).toBe("app-actor");
    });
  }

  test("enforce with NO proxy falls back to the app-actor path rather than returning undefined", () => {
    expect(resolveAttachmentTransport({ mode: "enforce", post, proxy: null }).via).toBe("app-actor");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 6. THE GRAPHQL TRANSPORT still throws where it always did
// ══════════════════════════════════════════════════════════════════════════════════════

describe("the app-actor transport keeps its own failure contract", () => {
  test("a missing issue on READ throws rather than reporting zero attachments", async () => {
    const t = createGraphqlAttachmentTransport({ post: async () => ({ issue: null }) });
    await expect(t.readAttachments("CTL-1")).rejects.toThrow(/no issue found/);
  });

  test("success:false on WRITE throws, with the string operators have grepped for since CTL-1363", async () => {
    const t = createGraphqlAttachmentTransport({
      post: async (q) =>
        q.includes("ResolveIssueId")
          ? { issue: { id: "u" } }
          : { attachmentCreate: { success: false } },
    });
    await expect(
      t.upsertAttachment({ ticket: "CTL-1", url: "u", title: "t", metadata: {} }),
    ).rejects.toThrow(/success=false/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// 7. ⛔ MUTATION CONTROLS — proof the assertions above can actually FAIL
// ══════════════════════════════════════════════════════════════════════════════════════

describe("mutation controls", () => {
  test("⛔ a transport that swallows a TRANSIENT failed read into [] produces the full silent double claim — won:true at generation 1 over a live generation 7", async () => {
    // The honest reproduction, and the reason the throw is not merely tidy. The failure is
    // TRANSIENT: the FIRST read (the one that computes `nextGen`) fails and is swallowed
    // into `[]`; the read-back that follows succeeds. So:
    //   • `current` reads as "no claim"          → nextGen = 1, past a LIVE generation 7
    //   • we write our claim at generation 1     → the fence now says mini/1
    //   • the read-back sees mini/1, which is us → won: TRUE
    // Two hosts now believe they own CTL-1, and mini-2's `isFenceCurrent(CTL-1, 7)` starts
    // answering false, so the host actually doing the work aborts mid-flight. No error is
    // raised anywhere. If this control ever stops reproducing, the tests above are vacuous.
    const store = new Map([
      [
        fenceUrl("CTL-1"),
        fenceNode("CTL-1", {
          owner_host: "mini-2",
          catalyst_generation: 7,
          phase: "implement",
          claimed_at: new Date().toISOString(),
        }),
      ],
    ]);
    let firstRead = true;
    const swallowing = {
      via: "broken",
      async resolveIssueId(t) {
        return t;
      },
      async readAttachments() {
        if (firstRead) {
          firstRead = false;
          return []; // ⛔ THE BUG: a transport error swallowed into "no claim exists"
        }
        return [...store.values()];
      },
      async upsertAttachment({ url, metadata }) {
        store.set(url, { id: `att-${url}`, url, metadata });
        return null;
      },
    };

    const res = await claimTicket("CTL-1", "mini", "triage", { transport: swallowing });
    expect(res).toEqual({ won: true, generation: 1 }); // ⛔ the unearned win, over generation 7
    // And the damage is durable: the fence now names us at a LOWER generation than the host
    // that legitimately held it, so the real owner's fencing check will start failing.
    expect(store.get(fenceUrl("CTL-1")).metadata.catalyst_generation).toBe(1);
  });

  test("a transport that swallows a failed WRITE lets the stale-preemption branch return won:true with nothing written", async () => {
    const writes = [];
    const swallowing = {
      via: "broken",
      async resolveIssueId(t) {
        return t;
      },
      async readAttachments() {
        return [
          fenceNode("CTL-1", {
            owner_host: "mini-2",
            catalyst_generation: 7,
            phase: "triage",
            claimed_at: new Date(1_000).toISOString(),
          }),
        ];
      },
      async upsertAttachment() {
        writes.push("refused-but-silent"); // ⛔ the bug: no throw
        return null;
      },
    };
    const res = await claimTicket("CTL-1", "mini", "triage", {
      transport: swallowing,
      staleMs: 1,
      now: () => 10_000_000,
    });
    // THE UNEARNED WIN, reproduced. This is what the throw in the real transport prevents.
    expect(res).toEqual({ won: true, generation: 8 });
    expect(writes).toEqual(["refused-but-silent"]);
  });
});
