// cluster-claim.test.mjs — the cross-host CLAIM/FENCE attachment library
// (CTL-859 PR2). Every test injects a fake GraphQL `post` so nothing touches
// the network: the fake models a single in-memory Linear attachment per ticket,
// upserting on the verified `catalyst://fence/<TICKET>` url exactly as the live
// API does (attachmentCreate with the same url returns the same node with new
// metadata), so claimTicket's read→write→read-back soft-CAS exercises real
// semantics.
import { describe, it, expect, afterEach } from "bun:test";

import {
  fenceUrl,
  authHeader,
  parseClaimMetadata,
  resolveIssueId,
  readClaim,
  writeClaim,
  claimTicket,
  isFenceCurrent,
  readTriageAttemptCount,
  bumpTriageAttemptCount,
  resetTriageAttemptCount,
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

// captureStdio — captureStdout's sibling for CTL-2033: the claim failure path
// writes a JSON line to stdout AND a human line to stderr, and both are part of
// the contract. Capturing stderr also keeps the suite's output clean.
async function captureStdio(fn) {
  const outChunks = [];
  const errChunks = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (s) => {
    outChunks.push(typeof s === "string" ? s : s.toString());
    return true;
  };
  process.stderr.write = (s) => {
    errChunks.push(typeof s === "string" ? s : s.toString());
    return true;
  };
  try {
    const code = await fn();
    return { code, out: outChunks.join(""), err: errChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
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
      triage_attempt_count: 0,
    });
  });
  it("missing/unparseable generation becomes null", () => {
    expect(parseClaimMetadata({ owner_host: "mini" }).generation).toBeNull();
    expect(parseClaimMetadata({ catalyst_generation: "nope" }).generation).toBeNull();
  });
  it("empty metadata yields an all-null record except triage_attempt_count which defaults to 0", () => {
    expect(parseClaimMetadata(undefined)).toEqual({
      owner_host: null,
      generation: null,
      phase: null,
      claimed_at: null,
      triage_attempt_count: 0,
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
      triage_attempt_count: 0,
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

  // ─── CTL-2033 ───────────────────────────────────────────────────────────────
  // The `claim` subcommand's THIRD outcome. Before this, a throw inside
  // claimTicket (a refused proxy write, a 401, a GraphQL errors[] body) fell to
  // the module's top-level catch: stderr prose + exit 1, and NOTHING on stdout.
  // The sync wrapper therefore saw the same `{won:false, generation:null}` it saw
  // for a peer legitimately winning the fence. These cases pin the separation.
  it("claim: a THROWN claim exits CLAIM_FAILED (11) with a machine-readable error on stdout", async () => {
    async function post(query) {
      if (query.includes("ResolveIssueId")) return { issue: { id: "uuid-CTL-842" } };
      if (query.includes("ReadFence")) return { issue: { attachments: { nodes: [] } } };
      if (query.includes("UpsertFence")) return { attachmentCreate: { success: false } };
      throw new Error("unexpected");
    }
    const { code, out, err } = await captureStdio(() =>
      runCli(["claim", "CTL-842", "mini", "triage"], { post }),
    );
    expect(code).toBe(11);
    const parsed = JSON.parse(out);
    expect(parsed.won).toBe(false);
    expect(parsed.generation).toBeNull();
    // The transport's OWN reason word survives to the caller — not a message scrape.
    expect(parsed.error.reason).toBe("write-not-succeeded");
    expect(parsed.error.message).toContain("success=false");
    // stderr keeps a human line for an operator grep.
    expect(err).toContain("reason=write-not-succeeded");
  });

  it("claim: exit 11 is DISTINCT from exit 0 — a failed claim and a lost race are not the same value", async () => {
    // Lost race: the operation ran, a rival won the read-back.
    let writes = 0;
    async function lostPost(query) {
      if (query.includes("ResolveIssueId")) return { issue: { id: "uuid-CTL-842" } };
      if (query.includes("UpsertFence")) {
        writes += 1;
        return { attachmentCreate: { success: true, attachment: {} } };
      }
      if (query.includes("ReadFence")) {
        const metadata =
          writes === 0 ? null : { owner_host: "rival", catalyst_generation: 1, phase: "triage", claimed_at: "x" };
        return { issue: { attachments: { nodes: metadata ? [{ id: "f", url: fenceUrl("CTL-842"), metadata }] : [] } } };
      }
      throw new Error("unexpected");
    }
    // Failed claim: the write itself is refused.
    async function failedPost(query) {
      if (query.includes("ResolveIssueId")) return { issue: { id: "uuid-CTL-842" } };
      if (query.includes("ReadFence")) return { issue: { attachments: { nodes: [] } } };
      if (query.includes("UpsertFence")) throw new Error("linear graphql http 429");
      throw new Error("unexpected");
    }
    const lost = await captureStdio(() => runCli(["claim", "CTL-842", "mini", "triage"], { post: lostPost }));
    const failed = await captureStdio(() => runCli(["claim", "CTL-842", "mini", "triage"], { post: failedPost }));
    expect(lost.code).toBe(0);
    expect(failed.code).toBe(11);
    expect(lost.code).not.toBe(failed.code);
    expect(JSON.parse(lost.out).error).toBeUndefined();
    expect(JSON.parse(failed.out).error.reason).toBe("claim-threw");
  });

  it("claim: a non-AttachmentTransportError throw is named `claim-threw`, never guessed from its message", async () => {
    async function post(query) {
      if (query.includes("ResolveIssueId")) throw new Error("budget:day-exhausted looking string in a bare Error");
      throw new Error("unexpected");
    }
    const { code, out } = await captureStdio(() => runCli(["claim", "CTL-842", "mini", "triage"], { post }));
    expect(code).toBe(11);
    // The MESSAGE contains "budget:" but the structured reason does not claim to
    // be one — the reason comes from `err.reason`, which a bare Error lacks.
    expect(JSON.parse(out).error.reason).toBe("claim-threw");
  });

  it("claim: stdout stays exactly ONE JSON line on the failure path (the wrapper's last-line parse is unchanged)", async () => {
    async function post(query) {
      if (query.includes("ResolveIssueId")) return { issue: { id: "uuid-CTL-842" } };
      if (query.includes("ReadFence")) return { issue: { attachments: { nodes: [] } } };
      if (query.includes("UpsertFence")) throw new Error("boom");
      throw new Error("unexpected");
    }
    const { out } = await captureStdio(() => runCli(["claim", "CTL-842", "mini", "triage"], { post }));
    expect(out.trim().split("\n").filter(Boolean).length).toBe(1);
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

// ─── CTL-1649: triage_attempt_count field ────────────────────────────────────

describe("parseClaimMetadata — triage_attempt_count (CTL-1649)", () => {
  it("a numeric value round-trips", () => {
    const c = parseClaimMetadata({
      owner_host: "mini",
      catalyst_generation: "2",
      phase: "triage",
      claimed_at: "2026-08-06T00:00:00Z",
      triage_attempt_count: 3,
    });
    expect(c.triage_attempt_count).toBe(3);
  });

  it("a string-encoded number is coerced", () => {
    expect(parseClaimMetadata({ triage_attempt_count: "2" }).triage_attempt_count).toBe(2);
  });

  it("missing → 0 (fail-open: a count defaults to 0, not null)", () => {
    expect(parseClaimMetadata({}).triage_attempt_count).toBe(0);
  });

  it("null → 0", () => {
    expect(parseClaimMetadata({ triage_attempt_count: null }).triage_attempt_count).toBe(0);
  });

  it("unparseable string → 0", () => {
    expect(parseClaimMetadata({ triage_attempt_count: "nope" }).triage_attempt_count).toBe(0);
  });

  it("existing four fields are byte-identical (no regression)", () => {
    const c = parseClaimMetadata({
      owner_host: "mac-studio",
      catalyst_generation: 7,
      phase: "implement",
      claimed_at: "2026-08-06T00:00:00Z",
    });
    expect(c.owner_host).toBe("mac-studio");
    expect(c.generation).toBe(7);
    expect(c.phase).toBe("implement");
    expect(c.claimed_at).toBe("2026-08-06T00:00:00Z");
  });
});

describe("writeClaim — triage_attempt_count (CTL-1649)", () => {
  it("writes triage_attempt_count into the metadata when supplied", async () => {
    const { post, store } = makeFakeLinear();
    await writeClaim("CTL-1649", { owner_host: "mini", generation: 1, phase: "triage", triage_attempt_count: 2 }, { post });
    expect(store.get("CTL-1649").triage_attempt_count).toBe(2);
  });

  it("defaults triage_attempt_count to 0 when omitted", async () => {
    const { post, store } = makeFakeLinear();
    await writeClaim("CTL-1649", { owner_host: "mini", generation: 1, phase: "triage" }, { post });
    expect(store.get("CTL-1649").triage_attempt_count).toBe(0);
  });

  it("preserveClaimedAt keeps the original claimed_at unchanged", async () => {
    const { post, store } = makeFakeLinear();
    const original = "2026-07-01T00:00:00Z";
    await writeClaim(
      "CTL-1649",
      { owner_host: "mini", generation: 1, phase: "triage", triage_attempt_count: 1 },
      { post, preserveClaimedAt: original },
    );
    expect(store.get("CTL-1649").claimed_at).toBe(original);
  });

  it("without preserveClaimedAt, claimed_at is re-stamped", async () => {
    const { post, store } = makeFakeLinear();
    const before = Date.now();
    await writeClaim("CTL-1649", { owner_host: "mini", generation: 1, phase: "triage" }, { post });
    const after = Date.now();
    const writtenMs = Date.parse(store.get("CTL-1649").claimed_at);
    expect(writtenMs).toBeGreaterThanOrEqual(before);
    expect(writtenMs).toBeLessThanOrEqual(after + 1000);
  });

  it("other four keys (owner_host, catalyst_generation, phase) are byte-identical to today", async () => {
    const { post, store } = makeFakeLinear();
    await writeClaim("CTL-1649", { owner_host: "mac-studio", generation: 5, phase: "plan", triage_attempt_count: 1 }, { post });
    const m = store.get("CTL-1649");
    expect(m.owner_host).toBe("mac-studio");
    expect(m.catalyst_generation).toBe(5);
    expect(m.phase).toBe("plan");
  });
});

describe("readTriageAttemptCount (CTL-1649)", () => {
  it("returns the fence count when a fence exists", async () => {
    const { post } = makeFakeLinear({
      seed: { "CTL-1649": { owner_host: "mini", catalyst_generation: 2, phase: "triage", claimed_at: "t", triage_attempt_count: 3 } },
    });
    expect(await readTriageAttemptCount("CTL-1649", { post })).toBe(3);
  });

  it("returns 0 when fence exists but triage_attempt_count is absent (count fails open to 0)", async () => {
    const { post } = makeFakeLinear({
      seed: { "CTL-1649": { owner_host: "mini", catalyst_generation: 1, phase: "triage", claimed_at: "t" } },
    });
    expect(await readTriageAttemptCount("CTL-1649", { post })).toBe(0);
  });

  it("returns null when no catalyst://fence/ attachment exists", async () => {
    const { post } = makeFakeLinear();
    expect(await readTriageAttemptCount("CTL-1649", { post })).toBeNull();
  });
});

describe("bumpTriageAttemptCount (CTL-1649)", () => {
  it("increments the count and returns the new value", async () => {
    const { post, store } = makeFakeLinear({
      seed: { "CTL-1649": { owner_host: "mini", catalyst_generation: 2, phase: "triage", claimed_at: "2026-08-01T00:00:00Z", triage_attempt_count: 1 } },
    });
    const result = await bumpTriageAttemptCount("CTL-1649", { post });
    expect(result).toBe(2);
    expect(store.get("CTL-1649").triage_attempt_count).toBe(2);
  });

  it("preserves owner_host, catalyst_generation, phase (does NOT bump generation)", async () => {
    const { post, store } = makeFakeLinear({
      seed: { "CTL-1649": { owner_host: "mac-studio", catalyst_generation: 5, phase: "triage", claimed_at: "2026-08-01T00:00:00Z", triage_attempt_count: 0 } },
    });
    await bumpTriageAttemptCount("CTL-1649", { post });
    const m = store.get("CTL-1649");
    expect(m.owner_host).toBe("mac-studio");
    expect(m.catalyst_generation).toBe(5);
    expect(m.phase).toBe("triage");
  });

  it("preserves claimed_at (does not re-stamp the staleness clock)", async () => {
    const original = "2026-07-01T00:00:00Z";
    const { post, store } = makeFakeLinear({
      seed: { "CTL-1649": { owner_host: "mini", catalyst_generation: 1, phase: "triage", claimed_at: original, triage_attempt_count: 0 } },
    });
    await bumpTriageAttemptCount("CTL-1649", { post });
    expect(store.get("CTL-1649").claimed_at).toBe(original);
  });

  it("returns null (no-op) when no fence exists", async () => {
    const { post } = makeFakeLinear();
    expect(await bumpTriageAttemptCount("CTL-1649", { post })).toBeNull();
  });

  it("consecutive bumps accumulate correctly (0 → 1 → 2)", async () => {
    const { post } = makeFakeLinear({
      seed: { "CTL-1649": { owner_host: "mini", catalyst_generation: 1, phase: "triage", claimed_at: "t", triage_attempt_count: 0 } },
    });
    expect(await bumpTriageAttemptCount("CTL-1649", { post })).toBe(1);
    expect(await bumpTriageAttemptCount("CTL-1649", { post })).toBe(2);
    expect(await readTriageAttemptCount("CTL-1649", { post })).toBe(2);
  });
});

describe("resetTriageAttemptCount (CTL-2111)", () => {
  it("resets triage_attempt_count to 0 and returns 0 on success", async () => {
    const { post, store } = makeFakeLinear({
      seed: { "CTL-2111": { owner_host: "mini", catalyst_generation: 2, phase: "triage", claimed_at: "2026-08-01T00:00:00Z", triage_attempt_count: 5 } },
    });
    const result = await resetTriageAttemptCount("CTL-2111", { post });
    expect(result).toBe(0);
    expect(store.get("CTL-2111").triage_attempt_count).toBe(0);
  });

  it("preserves owner_host, catalyst_generation, phase (does NOT bump generation — not a takeover)", async () => {
    const { post, store } = makeFakeLinear({
      seed: { "CTL-2111": { owner_host: "mac-studio", catalyst_generation: 5, phase: "triage", claimed_at: "2026-08-01T00:00:00Z", triage_attempt_count: 3 } },
    });
    await resetTriageAttemptCount("CTL-2111", { post });
    const m = store.get("CTL-2111");
    expect(m.owner_host).toBe("mac-studio");
    expect(m.catalyst_generation).toBe(5);
    expect(m.phase).toBe("triage");
  });

  it("preserves claimed_at (does not re-stamp the staleness clock)", async () => {
    const original = "2026-07-01T00:00:00Z";
    const { post, store } = makeFakeLinear({
      seed: { "CTL-2111": { owner_host: "mini", catalyst_generation: 1, phase: "triage", claimed_at: original, triage_attempt_count: 4 } },
    });
    await resetTriageAttemptCount("CTL-2111", { post });
    expect(store.get("CTL-2111").claimed_at).toBe(original);
  });

  it("returns null (no-op, fail-open) when no fence exists", async () => {
    const { post } = makeFakeLinear();
    expect(await resetTriageAttemptCount("CTL-2111", { post })).toBeNull();
  });

  it("a bump then a reset returns the count to 0", async () => {
    const { post } = makeFakeLinear({
      seed: { "CTL-2111": { owner_host: "mini", catalyst_generation: 1, phase: "triage", claimed_at: "t", triage_attempt_count: 0 } },
    });
    expect(await bumpTriageAttemptCount("CTL-2111", { post })).toBe(1);
    expect(await bumpTriageAttemptCount("CTL-2111", { post })).toBe(2);
    expect(await resetTriageAttemptCount("CTL-2111", { post })).toBe(0);
    expect(await readTriageAttemptCount("CTL-2111", { post })).toBe(0);
  });
});

describe("runCli — read-triage-attempt / bump-triage-attempt (CTL-1649)", () => {
  it("read-triage-attempt prints { count } and exits 0 when fence exists", async () => {
    const { post } = makeFakeLinear({
      seed: { "CTL-1649": { owner_host: "mini", catalyst_generation: 1, phase: "triage", claimed_at: "t", triage_attempt_count: 2 } },
    });
    const { code, out } = await captureStdout(() => runCli(["read-triage-attempt", "CTL-1649"], { post }));
    expect(code).toBe(0);
    expect(JSON.parse(out.trim())).toEqual({ count: 2 });
  });

  it("read-triage-attempt prints { count: null } and exits 0 when no fence", async () => {
    const { post } = makeFakeLinear();
    const { code, out } = await captureStdout(() => runCli(["read-triage-attempt", "CTL-1649"], { post }));
    expect(code).toBe(0);
    expect(JSON.parse(out.trim())).toEqual({ count: null });
  });

  it("bump-triage-attempt prints { count } and exits 0 on success", async () => {
    const { post } = makeFakeLinear({
      seed: { "CTL-1649": { owner_host: "mini", catalyst_generation: 1, phase: "triage", claimed_at: "t", triage_attempt_count: 1 } },
    });
    const { code, out } = await captureStdout(() => runCli(["bump-triage-attempt", "CTL-1649"], { post }));
    expect(code).toBe(0);
    expect(JSON.parse(out.trim())).toEqual({ count: 2 });
  });

  it("reset-triage-attempt prints { count: 0 } and exits 0 on success (CTL-2111)", async () => {
    const { post, store } = makeFakeLinear({
      seed: { "CTL-2111": { owner_host: "mini", catalyst_generation: 1, phase: "triage", claimed_at: "t", triage_attempt_count: 7 } },
    });
    const { code, out } = await captureStdout(() => runCli(["reset-triage-attempt", "CTL-2111"], { post }));
    expect(code).toBe(0);
    expect(JSON.parse(out.trim())).toEqual({ count: 0 });
    expect(store.get("CTL-2111").triage_attempt_count).toBe(0);
  });

  it("reset-triage-attempt prints { count: null } and exits 0 when no fence (CTL-2111)", async () => {
    const { post } = makeFakeLinear();
    const { code, out } = await captureStdout(() => runCli(["reset-triage-attempt", "CTL-2111"], { post }));
    expect(code).toBe(0);
    expect(JSON.parse(out.trim())).toEqual({ count: null });
  });

  it("unknown subcommand still exits 1 with usage", async () => {
    const { post } = makeFakeLinear();
    const { code } = await captureStdout(() => runCli(["bogus-cmd"], { post }));
    expect(code).toBe(1);
  });
});

// CTL-1616 PR3: defaultPost's token resolution folds onto the shared
// secret-contract engine (resolveSecret) — this is the synthetic
// LINEAR_API_KEY-only fixture the design mandates, proven here by asserting
// the Authorization header defaultPost actually sends (every other test in
// this file injects its own fake `post`, bypassing defaultPost entirely).
describe("defaultPost — secret-contract fold (CTL-1616 PR3)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("LINEAR_API_KEY-only fixture: defaultPost sends it as the Authorization header when LINEAR_API_TOKEN is absent", async () => {
    const savedToken = process.env.LINEAR_API_TOKEN;
    const savedKey = process.env.LINEAR_API_KEY;
    let seenAuth = null;
    globalThis.fetch = async (_url, opts) => {
      seenAuth = opts.headers.Authorization;
      return { ok: true, json: async () => ({ data: { issue: { id: "issue-1" } } }) };
    };
    try {
      delete process.env.LINEAR_API_TOKEN;
      process.env.LINEAR_API_KEY = "lin_api_fromkey";
      const issueId = await resolveIssueId("CTL-9");
      expect(issueId).toBe("issue-1");
      expect(seenAuth).toBe("lin_api_fromkey");
    } finally {
      if (savedToken === undefined) delete process.env.LINEAR_API_TOKEN;
      else process.env.LINEAR_API_TOKEN = savedToken;
      if (savedKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = savedKey;
    }
  });
});
