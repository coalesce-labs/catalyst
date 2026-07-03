// cluster-claim.test.mjs — the cross-host CLAIM/FENCE attachment library
// (CTL-859 PR2). Every test injects a fake GraphQL `post` so nothing touches
// the network: the fake models a single in-memory Linear attachment per ticket,
// upserting on the verified `catalyst://fence/<TICKET>` url exactly as the live
// API does (attachmentCreate with the same url returns the same node with new
// metadata), so claimTicket's read→write→read-back soft-CAS exercises real
// semantics.
import { describe, it, expect } from "bun:test";

import {
  fenceUrl,
  authHeader,
  parseClaimMetadata,
  resolveIssueId,
  readClaim,
  writeClaim,
  claimTicket,
  isFenceCurrent,
  runCli,
} from "./cluster-claim.mjs";

// captureStdout — run an async fn with process.stdout.write trapped, returning
// the concatenated output. The CLI writes its JSON result to stdout (the channel
// the spawnSync wrapper parses), so the tests assert on captured stdout.
async function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => {
    chunks.push(typeof s === "string" ? s : s.toString());
    return true;
  };
  try {
    const code = await fn();
    return { code, out: chunks.join("") };
  } finally {
    process.stdout.write = orig;
  }
}

// makeFakeLinear — an in-memory Linear that honours the three operations
// cluster-claim issues: identifier→id resolution, attachment read, and the
// upsert-on-url attachmentCreate. State is a Map<ticket, metadata>. Returns
// { post, store, calls } so a test can pre-seed a claim, inspect the post log,
// or read the resulting metadata directly.
function makeFakeLinear({ seed = {}, missingIssues = new Set() } = {}) {
  // store: ticket → the single fence attachment metadata object (or absent).
  const store = new Map(Object.entries(seed));
  const calls = [];

  async function post(query, variables) {
    calls.push({ query, variables });

    if (query.includes("ResolveIssueId")) {
      // CTL-1363: the real Linear API returns HTTP 400 on
      // issues(filter:{identifier:...}) — IssueFilter has no `identifier` field.
      // Mirror that here so a regression to the broken query shape FAILS the
      // test instead of silently passing (the mock gap that let the original
      // fleet-dispatch wedge ship). Only the issue(id:) form is accepted.
      if (query.includes("identifier")) {
        throw new Error(
          'linear graphql http 400: Field "identifier" is not defined by type "IssueFilter"'
        );
      }
      const id = variables.id;
      if (missingIssues.has(id)) return { issue: null };
      return { issue: { id: `uuid-${id}` } };
    }

    if (query.includes("ReadFence")) {
      // issue(id:) is called with the IDENTIFIER (Linear accepts it directly).
      const ticket = variables.id;
      const metadata = store.get(ticket);
      const nodes = [];
      // an unrelated attachment is always present to prove the url-prefix filter.
      nodes.push({ id: "att-pr", url: "https://github.com/x/y/pull/1", metadata: {} });
      if (metadata) {
        nodes.push({ id: `att-fence-${ticket}`, url: fenceUrl(ticket), metadata });
      }
      return { issue: { attachments: { nodes } } };
    }

    if (query.includes("UpsertFence")) {
      const { issueId, url, metadata } = variables.input;
      // recover the ticket from the fence url (catalyst://fence/<TICKET>).
      const ticket = url.replace("catalyst://fence/", "");
      // verify the resolver was used (issueId is the uuid- form).
      expect(issueId).toBe(`uuid-${ticket}`);
      store.set(ticket, metadata); // upsert-on-url
      return {
        attachmentCreate: { success: true, attachment: { id: `att-fence-${ticket}`, url, metadata } },
      };
    }

    throw new Error(`unexpected query: ${query}`);
  }

  return { post, store, calls };
}

describe("authHeader — Linear auth contract", () => {
  it("OAuth app-actor token is sent Bearer", () => {
    expect(authHeader("lin_oauth_abc")).toBe("Bearer lin_oauth_abc");
  });
  it("personal API key is sent raw", () => {
    expect(authHeader("lin_api_abc")).toBe("lin_api_abc");
  });
  it("empty token yields empty header (raw)", () => {
    expect(authHeader()).toBe("");
  });
});

describe("fenceUrl — the per-ticket upsert key", () => {
  it("namespaces the synthetic url with the verified prefix", () => {
    expect(fenceUrl("CTL-842")).toBe("catalyst://fence/CTL-842");
  });
});

describe("parseClaimMetadata — normalisation", () => {
  it("coerces catalyst_generation to a Number", () => {
    const c = parseClaimMetadata({
      owner_host: "mini",
      catalyst_generation: "3",
      phase: "implement",
      claimed_at: "2026-06-08T00:00:00.000Z",
    });
    expect(c).toEqual({
      owner_host: "mini",
      generation: 3,
      phase: "implement",
      claimed_at: "2026-06-08T00:00:00.000Z",
    });
  });
  it("missing/unparseable generation becomes null", () => {
    expect(parseClaimMetadata({ owner_host: "mini" }).generation).toBeNull();
    expect(parseClaimMetadata({ catalyst_generation: "nope" }).generation).toBeNull();
  });
  it("empty metadata yields an all-null record", () => {
    expect(parseClaimMetadata(undefined)).toEqual({
      owner_host: null,
      generation: null,
      phase: null,
      claimed_at: null,
    });
  });
});

describe("resolveIssueId — identifier → UUID", () => {
  it("returns the issue UUID for a known identifier", async () => {
    const { post } = makeFakeLinear();
    expect(await resolveIssueId("CTL-842", { post })).toBe("uuid-CTL-842");
  });
  it("returns null when no issue matches", async () => {
    const { post } = makeFakeLinear({ missingIssues: new Set(["CTL-999"]) });
    expect(await resolveIssueId("CTL-999", { post })).toBeNull();
  });
  // CTL-1363 regression guard: resolveIssueId MUST query via issue(id:), never
  // the issues(filter:{identifier:{eq}}) form — IssueFilter has no `identifier`
  // field, so that form is a hard 400 that silently wedged fleet dispatch.
  it("queries via issue(id:) and never the issues(filter:{identifier}) form (CTL-1363)", async () => {
    const { post, calls } = makeFakeLinear();
    await resolveIssueId("CTL-842", { post });
    const resolveCall = calls.find((c) => c.query.includes("ResolveIssueId"));
    expect(resolveCall).toBeDefined();
    expect(resolveCall.query).toContain("issue(id:");
    expect(resolveCall.query).not.toContain("identifier");
  });
});

describe("readClaim — parse the fence attachment", () => {
  it("returns null when no fence attachment exists (ignores unrelated ones)", async () => {
    const { post } = makeFakeLinear();
    expect(await readClaim("CTL-842", { post })).toBeNull();
  });

  it("picks the catalyst://fence/ node and parses its metadata", async () => {
    const { post } = makeFakeLinear({
      seed: {
        "CTL-842": {
          owner_host: "mac-studio",
          catalyst_generation: 7,
          phase: "verify",
          claimed_at: "2026-06-08T01:00:00.000Z",
        },
      },
    });
    expect(await readClaim("CTL-842", { post })).toEqual({
      owner_host: "mac-studio",
      generation: 7,
      phase: "verify",
      claimed_at: "2026-06-08T01:00:00.000Z",
    });
  });
});

describe("writeClaim — upsert the attachment", () => {
  it("resolves the issue id and upserts metadata with a fresh claimed_at", async () => {
    const { post, store, calls } = makeFakeLinear();
    const before = Date.now();
    const written = await writeClaim(
      "CTL-842",
      { owner_host: "mini", generation: 1, phase: "triage" },
      { post },
    );
    expect(written.owner_host).toBe("mini");
    expect(written.generation).toBe(1);
    expect(written.phase).toBe("triage");
    // claimed_at is set to ~now (ISO timestamp).
    const ts = Date.parse(written.claimed_at);
    expect(ts).toBeGreaterThanOrEqual(before);
    // the resolver ran before the mutation.
    expect(calls[0].query).toContain("ResolveIssueId");
    expect(calls[1].query).toContain("UpsertFence");
    // metadata landed in the store under the verified key names.
    expect(store.get("CTL-842").catalyst_generation).toBe(1);
    expect(store.get("CTL-842").owner_host).toBe("mini");
  });

  it("upserts on the same url — a second write replaces metadata (one record)", async () => {
    const { post, store } = makeFakeLinear();
    await writeClaim("CTL-842", { owner_host: "mini", generation: 1, phase: "triage" }, { post });
    await writeClaim("CTL-842", { owner_host: "mac-studio", generation: 2, phase: "plan" }, { post });
    // single record, latest metadata.
    expect(store.size).toBe(1);
    expect(store.get("CTL-842").owner_host).toBe("mac-studio");
    expect(store.get("CTL-842").catalyst_generation).toBe(2);
  });

  it("throws when the identifier resolves to no issue", async () => {
    const { post } = makeFakeLinear({ missingIssues: new Set(["CTL-999"]) });
    let err;
    try {
      await writeClaim("CTL-999", { owner_host: "mini", generation: 1, phase: "triage" }, { post });
    } catch (e) {
      err = e;
    }
    expect(err?.message).toMatch(/no issue found/);
  });

  // CTL-863 fleet-unfreeze (entourage follow-up to #2552): a pre-resolved issueId
  // override skips the ResolveIssueId round-trip entirely.
  it("an issueId override SKIPS resolveIssueId — only UpsertFence is called", async () => {
    const { post, store, calls } = makeFakeLinear();
    const written = await writeClaim(
      "CTL-842",
      { owner_host: "mini", generation: 1, phase: "triage" },
      { post, issueId: "uuid-CTL-842" },
    );
    expect(written.owner_host).toBe("mini");
    expect(calls.length).toBe(1); // ONLY the UpsertFence write — no ResolveIssueId call
    expect(calls[0].query).toContain("UpsertFence");
    expect(store.get("CTL-842").owner_host).toBe("mini");
  });

  it("no issueId override → falls through to resolveIssueId unchanged", async () => {
    const { post, calls } = makeFakeLinear();
    await writeClaim("CTL-842", { owner_host: "mini", generation: 1, phase: "triage" }, { post, issueId: null });
    expect(calls[0].query).toContain("ResolveIssueId");
    expect(calls[1].query).toContain("UpsertFence");
  });
});

describe("claimTicket — soft-CAS via read-back", () => {
  it("first claim on an unheld ticket: generation 1, won", async () => {
    const { post } = makeFakeLinear();
    const res = await claimTicket("CTL-842", "mini", "triage", { post });
    expect(res).toEqual({ won: true, generation: 1 });
  });

  it("increments generation past the current holder (takeover bump)", async () => {
    const { post } = makeFakeLinear({
      seed: {
        "CTL-842": {
          owner_host: "dead-host",
          catalyst_generation: 4,
          phase: "implement",
          claimed_at: "2026-06-08T00:00:00.000Z",
        },
      },
    });
    const res = await claimTicket("CTL-842", "mini", "implement", { post });
    expect(res).toEqual({ won: true, generation: 5 });
  });

  it("read-back shows a DIFFERENT owner → won:false (a concurrent host wrote last)", async () => {
    // A poster whose read-back always reports a rival owner at our generation,
    // modelling a concurrent host that won the serialized write race.
    let writes = 0;
    async function post(query) {
      if (query.includes("ResolveIssueId")) return { issue: { id: "uuid-CTL-842" } };
      if (query.includes("UpsertFence")) {
        writes += 1;
        return { attachmentCreate: { success: true, attachment: {} } };
      }
      if (query.includes("ReadFence")) {
        // pre-write read: unheld; post-write read-back: a RIVAL owns our gen.
        const metadata =
          writes === 0
            ? null
            : { owner_host: "rival", catalyst_generation: 1, phase: "triage", claimed_at: "x" };
        const nodes = metadata
          ? [{ id: "f", url: fenceUrl("CTL-842"), metadata }]
          : [];
        return { issue: { attachments: { nodes } } };
      }
      throw new Error("unexpected");
    }
    const res = await claimTicket("CTL-842", "mini", "triage", { post });
    expect(res.generation).toBe(1);
    expect(res.won).toBe(false);
  });

  it("read-back shows a HIGHER generation → won:false (we were leapfrogged)", async () => {
    let writes = 0;
    async function post(query) {
      if (query.includes("ResolveIssueId")) return { issue: { id: "uuid-CTL-842" } };
      if (query.includes("UpsertFence")) {
        writes += 1;
        return { attachmentCreate: { success: true, attachment: {} } };
      }
      if (query.includes("ReadFence")) {
        const metadata =
          writes === 0
            ? null
            : { owner_host: "mini", catalyst_generation: 9, phase: "triage", claimed_at: "x" };
        const nodes = metadata ? [{ id: "f", url: fenceUrl("CTL-842"), metadata }] : [];
        return { issue: { attachments: { nodes } } };
      }
      throw new Error("unexpected");
    }
    const res = await claimTicket("CTL-842", "mini", "triage", { post });
    expect(res.generation).toBe(1);
    expect(res.won).toBe(false);
  });

  it("two SEQUENTIAL claims against the shared fake: second bumps generation and wins", async () => {
    // The fake serializes writes (single in-memory record), modelling Linear's
    // per-issue atomic write. Sequential claims read each other's writes.
    const { post } = makeFakeLinear();
    const a = await claimTicket("CTL-842", "mini", "triage", { post });
    const b = await claimTicket("CTL-842", "mac-studio", "triage", { post });
    expect(a).toEqual({ won: true, generation: 1 });
    expect(b).toEqual({ won: true, generation: 2 });
  });
});

describe("claimTicket — stale-claim preemption (CTL-1297)", () => {
  it("preempts a STALE claim from another host → won:true, generation bumped, no read-back", async () => {
    const { post, calls } = makeFakeLinear({
      seed: {
        "CTL-842": {
          owner_host: "mini-2",
          catalyst_generation: 3,
          phase: "triage",
          claimed_at: "2026-06-20T00:00:00.000Z",
        },
      },
    });
    const now = () => Date.parse("2026-06-20T01:00:00.000Z"); // 1h later → stale
    const res = await claimTicket("CTL-842", "mini", "triage", { post, now, staleMs: 300_000 });
    expect(res.won).toBe(true);
    expect(res.generation).toBe(4); // bumped past the dead owner's gen
    // Preemption skips the read-back: exactly 1 ReadFence call (the initial read),
    // vs 2 for the normal CAS path (initial + read-back).
    expect(calls.filter((c) => c.query.includes("ReadFence")).length).toBe(1);
  });

  it("does NOT preempt a FRESH claim from another host → falls through to soft-CAS (won:false on lost read-back)", async () => {
    // Fresh claim (30s old) → age < staleMs → no preemption.
    // Custom post: read-back always shows rival winning, proving the CAS path ran
    // (preemption would have returned won:true unconditionally, skipping the read-back).
    const freshClaimedAt = "2026-06-20T00:00:00.000Z";
    const now = () => Date.parse("2026-06-20T00:00:30.000Z"); // 30s later → fresh
    let writes = 0;
    async function post(query) {
      if (query.includes("ResolveIssueId")) return { issue: { id: "uuid-CTL-842" } };
      if (query.includes("UpsertFence")) {
        writes += 1;
        return { attachmentCreate: { success: true, attachment: {} } };
      }
      if (query.includes("ReadFence")) {
        // Both pre-write and read-back: rival owns gen 1 at the fresh timestamp.
        return {
          issue: {
            attachments: {
              nodes: [
                {
                  id: "f",
                  url: fenceUrl("CTL-842"),
                  metadata: { owner_host: "rival", catalyst_generation: 1, phase: "triage", claimed_at: freshClaimedAt },
                },
              ],
            },
          },
        };
      }
      throw new Error("unexpected");
    }
    let readFenceCalls = 0;
    const wrappedPost = async (q, v) => {
      if (q.includes("ReadFence")) readFenceCalls++;
      return post(q, v);
    };
    const res = await claimTicket("CTL-842", "mini", "triage", { post: wrappedPost, now, staleMs: 300_000 });
    expect(res.won).toBe(false); // CAS path ran — rival still owns the read-back, no preemption
    // CAS path always does pre-read + read-back = 2 ReadFence calls.
    expect(readFenceCalls).toBe(2);
  });

  it("a stale claim owned by the SAME host takes the normal soft-CAS path", async () => {
    const { post } = makeFakeLinear({
      seed: {
        "CTL-842": {
          owner_host: "mini",
          catalyst_generation: 5,
          phase: "pr",
          claimed_at: "2026-06-20T00:00:00.000Z",
        },
      },
    });
    const res = await claimTicket("CTL-842", "mini", "triage", {
      post,
      now: () => Date.parse("2026-06-20T02:00:00.000Z"),
      staleMs: 300_000,
    });
    expect(res).toEqual({ won: true, generation: 6 });
  });

  it("a claim with unparseable claimed_at is NOT preempted (conservative)", async () => {
    const { post } = makeFakeLinear({
      seed: {
        "CTL-842": { owner_host: "mini-2", catalyst_generation: 2, phase: "triage", claimed_at: null },
      },
    });
    // No preemption → soft-CAS runs → we win (single writer in test)
    const res = await claimTicket("CTL-842", "mini", "triage", {
      post,
      now: () => Date.parse("2026-06-20T05:00:00.000Z"),
      staleMs: 300_000,
    });
    expect(res).toEqual({ won: true, generation: 3 });
  });

  it("no existing claim → won:true, generation 1 (preemption branch is a no-op)", async () => {
    const { post } = makeFakeLinear();
    const res = await claimTicket("CTL-842", "mini", "triage", { post, now: () => 0, staleMs: 300_000 });
    expect(res).toEqual({ won: true, generation: 1 });
  });
});

describe("isFenceCurrent — the pre-side-effect fencing check", () => {
  it("true when the ticket's current generation equals ours", async () => {
    const { post } = makeFakeLinear({
      seed: {
        "CTL-842": { owner_host: "mini", catalyst_generation: 3, phase: "pr", claimed_at: "x" },
      },
    });
    expect(await isFenceCurrent("CTL-842", 3, { post })).toBe(true);
  });

  it("false when a takeover bumped the generation past ours (stale zombie)", async () => {
    const { post } = makeFakeLinear({
      seed: {
        "CTL-842": { owner_host: "other", catalyst_generation: 5, phase: "pr", claimed_at: "x" },
      },
    });
    expect(await isFenceCurrent("CTL-842", 3, { post })).toBe(false);
  });

  it("false when there is no claim at all (nothing authorises our generation)", async () => {
    const { post } = makeFakeLinear();
    expect(await isFenceCurrent("CTL-842", 1, { post })).toBe(false);
  });
});

describe("runCli — the spawnSync CLI surface (CTL-850)", () => {
  it("claim: prints {won, generation} JSON and exits 0", async () => {
    const { post } = makeFakeLinear();
    const { code, out } = await captureStdout(() =>
      runCli(["claim", "CTL-842", "mini", "triage"], { post }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ won: true, generation: 1 });
  });

  it("claim: a LOST read-back still exits 0 with won:false in stdout (wrapper reads `won`)", async () => {
    // A rival owns our generation on the read-back → soft-CAS reports won:false,
    // but the OPERATION succeeded, so the CLI exit stays 0; the sync wrapper
    // decides not-to-dispatch from the `won:false` it parses out of stdout.
    let writes = 0;
    async function post(query) {
      if (query.includes("ResolveIssueId")) return { issue: { id: "uuid-CTL-842" } };
      if (query.includes("UpsertFence")) {
        writes += 1;
        return { attachmentCreate: { success: true, attachment: {} } };
      }
      if (query.includes("ReadFence")) {
        const metadata =
          writes === 0
            ? null
            : { owner_host: "rival", catalyst_generation: 1, phase: "triage", claimed_at: "x" };
        const nodes = metadata ? [{ id: "f", url: fenceUrl("CTL-842"), metadata }] : [];
        return { issue: { attachments: { nodes } } };
      }
      throw new Error("unexpected");
    }
    const { code, out } = await captureStdout(() =>
      runCli(["claim", "CTL-842", "mini", "triage"], { post }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ won: false, generation: 1 });
  });

  it("fence-check: exits 0 and prints {current:true} when the generation matches", async () => {
    const { post } = makeFakeLinear({
      seed: {
        "CTL-842": { owner_host: "mini", catalyst_generation: 3, phase: "pr", claimed_at: "x" },
      },
    });
    const { code, out } = await captureStdout(() =>
      runCli(["fence-check", "CTL-842", "3"], { post }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ current: true });
  });

  it("fence-check: exits 10 (FENCE_STALE_EXIT) and prints {current:false} when stale/missing", async () => {
    const { post } = makeFakeLinear(); // no claim at all
    const { code, out } = await captureStdout(() =>
      runCli(["fence-check", "CTL-842", "3"], { post }),
    );
    expect(code).toBe(10);
    expect(JSON.parse(out)).toEqual({ current: false });
  });

  it("unknown subcommand: exits 1", async () => {
    const { post } = makeFakeLinear();
    const { code } = await captureStdout(() => runCli(["bogus"], { post }));
    expect(code).toBe(1);
  });

  // CTL-863 fleet-unfreeze (entourage follow-up to #2552).
  it("resolve-issue-id: prints {issueId} and exits 0", async () => {
    const { post } = makeFakeLinear();
    const { code, out } = await captureStdout(() =>
      runCli(["resolve-issue-id", "CTL-842"], { post }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ issueId: "uuid-CTL-842" });
  });

  it("resolve-issue-id: {issueId:null} on a missing ticket", async () => {
    const { post } = makeFakeLinear({ missingIssues: new Set(["CTL-999"]) });
    const { code, out } = await captureStdout(() =>
      runCli(["resolve-issue-id", "CTL-999"], { post }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ issueId: null });
  });

  it("claim: an optional 4th issueId arg skips ResolveIssueId (only ReadFence/UpsertFence calls)", async () => {
    const { post, calls } = makeFakeLinear();
    const { code, out } = await captureStdout(() =>
      runCli(["claim", "CTL-842", "mini", "triage", "uuid-CTL-842"], { post }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ won: true, generation: 1 });
    expect(calls.some((c) => c.query.includes("ResolveIssueId"))).toBe(false);
  });

  it("claim: preempts a stale cross-host claim via the default threshold (CTL-1297)", async () => {
    // claimed_at at the Unix epoch is centuries stale relative to any real Date.now(),
    // so the default 300_000ms threshold fires without needing to inject `now`.
    const { post } = makeFakeLinear({
      seed: {
        "CTL-842": {
          owner_host: "other-host",
          catalyst_generation: 2,
          phase: "triage",
          claimed_at: "1970-01-01T00:00:00.000Z",
        },
      },
    });
    const { code, out } = await captureStdout(() =>
      runCli(["claim", "CTL-842", "mini", "triage"], { post }),
    );
    expect(code).toBe(0);
    const result = JSON.parse(out);
    expect(result.won).toBe(true);
    expect(result.generation).toBe(3); // bumped past generation 2
  });
});
