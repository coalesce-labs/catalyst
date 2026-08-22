// replica-first-resolvers.test.ts — CTL-1806.
//
// The claim this ticket makes is NEGATIVE: "and no Linear API call is made".
// A test that only checks the returned VALUE would pass even if the call were
// still being made, so every case below asserts the fetch SPY's call count
// directly. Each zero-call assertion is paired with a positive control in the
// same describe block — a case that drives the same instrument and returns a
// NON-zero count — so a spy that silently stopped observing can never be
// mistaken for a resolver that stopped calling.
//
// The replica is injected through the `readerFactory` seam (the same seam
// readReplicaTitles has carried since CTL-1372), so these run offline with no
// real catalyst-replica.db and behave identically on a laptop and in CI.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fillEstimateFallback,
  getEstimationMethodAsync,
  _clearEstimateCache,
  _clearMethodCache,
} from "../lib/linear-estimate-fallback.mjs";
import {
  fillTitleDescriptionFallback,
  _clearTitleDescCache,
  _getTitleDescCacheSize,
  _sweepTitleDescCache,
} from "../lib/linear-title-description-fallback.mjs";
import { readReplicaTicketDetails } from "../lib/linear-cache-reader.mjs";

// ── fetch spy ────────────────────────────────────────────────────────────────
// Counts EVERY outbound call. Returns an empty-but-well-formed GraphQL body so a
// resolver that does call through still completes normally (the count, not a
// crash, is what fails the test).
function spyFetch(responseData: unknown = { data: { issues: { nodes: [] } } }) {
  let callCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = ((_u: unknown, _i: unknown) => {
    callCount++;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(responseData) } as Response);
  }) as typeof fetch;
  return {
    get callCount() {
      return callCount;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

// A replica reader stub honouring the primitives' real contracts: a HIT is an
// entry, a MISS is an ABSENT KEY (never a null value).
function fakeReplica({
  estimates = {} as Record<string, number>,
  details = {} as Record<string, unknown>,
  // Codex P1 (#3355): the single-ticket DETAIL path gates on writer liveness.
  // Defaults true so every pre-existing case behaves exactly as before.
  isFresh = true,
} = {}) {
  let closed = false;
  return {
    factory: () => ({
      isFresh: () => isFresh,
      estimates: (ids: string[]) =>
        Object.fromEntries(
          ids.filter((id) => id in estimates).map((id) => [id, estimates[id]])
        ),
      details: (ids: string[]) =>
        Object.fromEntries(ids.filter((id) => id in details).map((id) => [id, details[id]])),
      close: () => {
        closed = true;
      },
    }),
    get closed() {
      return closed;
    },
  };
}

const DETAIL = {
  title: "Replica-served title",
  description: "## From SQLite",
  labels: [{ name: "catalyst-ask", color: "#ff0000" }],
  relations: {
    blockedBy: [
      { identifier: "CTL-99", title: "Blocker", state: { name: "Done", type: "completed" }, priority: 1, project: "P" },
    ],
    blocks: [],
    related: [],
    duplicateOf: [],
  },
  state: { name: "Implement", type: "started" },
  priority: 2,
  project: "Fleet Hardening",
  estimate: 5,
};

// A Linear token must be present, or graphql() short-circuits BEFORE fetch and a
// zero-call assertion would pass for the wrong reason.
let prevToken: string | undefined;
let prevKey: string | undefined;
let eventDir: string;
let prevCatalystDir: string | undefined;

beforeEach(() => {
  prevToken = process.env.LINEAR_API_TOKEN;
  prevKey = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_TOKEN = "lin_api_test_token";
  delete process.env.LINEAR_API_KEY;
  // Redirect the CTL-1806 D3 event emissions into a temp dir so the assertions
  // read this test's own events and nothing writes to the real ~/catalyst log.
  prevCatalystDir = process.env.CATALYST_DIR;
  eventDir = mkdtempSync(join(tmpdir(), "ctl1806-events-"));
  process.env.CATALYST_DIR = eventDir;
  _clearEstimateCache();
  _clearMethodCache();
  _clearTitleDescCache();
});

afterEach(() => {
  if (prevToken !== undefined) process.env.LINEAR_API_TOKEN = prevToken;
  else delete process.env.LINEAR_API_TOKEN;
  if (prevKey !== undefined) process.env.LINEAR_API_KEY = prevKey;
  if (prevCatalystDir !== undefined) process.env.CATALYST_DIR = prevCatalystDir;
  else delete process.env.CATALYST_DIR;
  rmSync(eventDir, { recursive: true, force: true });
});

// Read every catalyst.linear.read event this test emitted.
function readEmitted(): Array<Record<string, unknown>> {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const p = join(eventDir, "events", `${ym}.jsonl`);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  const parsed: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    parsed.push(JSON.parse(line) as Record<string, unknown>);
  }
  return parsed.filter(
    (e) =>
      (e.attributes as Record<string, unknown> | undefined)?.["event.name"] ===
      "catalyst.linear.read"
  );
}

describe("CTL-1806 AC1: a supplemental estimate is served from the replica", () => {
  it("replica HIT → the value comes from the replica and ZERO Linear calls are made", async () => {
    const spy = spyFetch();
    const replica = fakeReplica({ estimates: { "CTL-500": 8 } });
    try {
      const out = await fillEstimateFallback(["CTL-500"], {
        replicaOptions: { readerFactory: replica.factory },
      });
      expect(out["CTL-500"]).toBe(8);
      expect(spy.callCount).toBe(0); // THE claim
    } finally {
      spy.restore();
    }
    expect(replica.closed).toBe(true); // the reader handle is always released
  });

  it("POSITIVE CONTROL: replica MISS → the same spy counts a real Linear call", async () => {
    const spy = spyFetch({
      data: { issues: { nodes: [{ number: 501, estimate: 3, team: { key: "CTL" } }] } },
    });
    const replica = fakeReplica({ estimates: {} });
    try {
      const out = await fillEstimateFallback(["CTL-501"], {
        replicaOptions: { readerFactory: replica.factory },
      });
      // Non-zero here is what makes the zero above evidence rather than silence.
      expect(spy.callCount).toBe(1);
      expect(out["CTL-501"]).toBe(3);
    } finally {
      spy.restore();
    }
  });

  it("a replica NULL estimate is a MISS and FALLS THROUGH (never an authoritative null)", async () => {
    const spy = spyFetch({
      data: { issues: { nodes: [{ number: 502, estimate: 13, team: { key: "CTL" } }] } },
    });
    // The primitive omits a NULL estimate, so the stub omits the key. If the
    // resolver ever treated a replica null as authoritative, this would be 0
    // calls and the board chip would silently vanish for a refresh.
    const replica = fakeReplica({ estimates: {} });
    try {
      const out = await fillEstimateFallback(["CTL-502"], {
        replicaOptions: { readerFactory: replica.factory },
      });
      expect(spy.callCount).toBe(1);
      expect(out["CTL-502"]).toBe(13);
    } finally {
      spy.restore();
    }
  });

  it("a non-numeric replica answer is NOT trusted as an estimate", async () => {
    const spy = spyFetch({
      data: { issues: { nodes: [{ number: 503, estimate: 21, team: { key: "CTL" } }] } },
    });
    // The primitive's contract is hits-only-and-finite, but this resolver must
    // not DEPEND on a reader honouring it: an older or third-party reader that
    // returns a present-but-null value would otherwise be served straight onto
    // the board as an authoritative estimate. Falling through is the safe read.
    const replica = {
      factory: () => ({
        estimates: () => ({ "CTL-503": null as unknown as number }),
        details: () => ({}),
        close: () => {},
      }),
    };
    try {
      const out = await fillEstimateFallback(["CTL-503"], {
        replicaOptions: { readerFactory: replica.factory },
      });
      expect(spy.callCount).toBe(1);
      expect(out["CTL-503"]).toBe(21);
    } finally {
      spy.restore();
    }
  });

  it("a mixed batch fetches ONLY the replica misses", async () => {
    const spy = spyFetch({
      data: { issues: { nodes: [{ number: 601, estimate: 2, team: { key: "CTL" } }] } },
    });
    const replica = fakeReplica({ estimates: { "CTL-600": 5 } });
    try {
      const out = await fillEstimateFallback(["CTL-600", "CTL-601"], {
        replicaOptions: { readerFactory: replica.factory },
      });
      expect(out["CTL-600"]).toBe(5);
      expect(out["CTL-601"]).toBe(2);
      expect(spy.callCount).toBe(1); // one call, for the miss only
    } finally {
      spy.restore();
    }
  });

  it("FILE-PRESENCE gate: an absent replica file falls through without throwing", async () => {
    const spy = spyFetch();
    try {
      // No readerFactory → the real existsSync gate runs against a path that
      // cannot exist. This exercises the GATE, not a stub of it.
      const out = await fillEstimateFallback(["CTL-700"], {
        replicaOptions: { dbPath: "/nonexistent-ctl-1806/no-such-dir/replica.db" },
      });
      expect(out["CTL-700"]).toBe(null);
      expect(spy.callCount).toBe(1);
    } finally {
      spy.restore();
    }
  });
});

describe("CTL-1806 AC2: title/description (and the DETAIL route + relation targets) from the replica", () => {
  it("replica HIT → full payload from the replica and ZERO Linear calls", async () => {
    const spy = spyFetch();
    const replica = fakeReplica({ details: { "CTL-800": DETAIL } });
    try {
      const out = await fillTitleDescriptionFallback(["CTL-800"], {
        replicaOptions: { readerFactory: replica.factory },
      });
      const e = out["CTL-800"];
      expect(e.title).toBe("Replica-served title");
      expect(e.description).toBe("## From SQLite");
      expect(e.state).toEqual({ name: "Implement", type: "started" });
      expect(e.priority).toBe(2);
      expect(e.estimate).toBe(5);
      expect(e.project).toBe("Fleet Hardening");
      expect(e.labels).toEqual([{ name: "catalyst-ask", color: "#ff0000" }]);
      // The relation TARGETS — the half of AC2 that had no replica tier at all.
      expect(e.relations?.blockedBy?.[0]?.identifier).toBe("CTL-99");
      expect(e.relations?.blockedBy?.[0]?.state).toEqual({ name: "Done", type: "completed" });
      // Provenance, so the detail route stops reporting "linear-live" for a read
      // that never touched Linear.
      expect(e.source).toBe("replica");
      expect(spy.callCount).toBe(0); // THE claim
    } finally {
      spy.restore();
    }
  });

  it("POSITIVE CONTROL: replica MISS → the same spy counts a real Linear call", async () => {
    const spy = spyFetch({
      data: {
        issues: {
          nodes: [{ number: 801, title: "From Linear", description: "d", team: { key: "CTL" } }],
        },
      },
    });
    const replica = fakeReplica({ details: {} });
    try {
      const out = await fillTitleDescriptionFallback(["CTL-801"], {
        replicaOptions: { readerFactory: replica.factory },
      });
      expect(spy.callCount).toBe(1);
      expect(out["CTL-801"].title).toBe("From Linear");
      expect(out["CTL-801"].source).toBe("linear");
    } finally {
      spy.restore();
    }
  });

  it("a replica hit with an EMPTY title falls through rather than caching a hollow entry", async () => {
    const spy = spyFetch({
      data: {
        issues: {
          nodes: [{ number: 802, title: "Real", description: null, team: { key: "CTL" } }],
        },
      },
    });
    const replica = fakeReplica({ details: { "CTL-802": { ...DETAIL, title: "" } } });
    try {
      const out = await fillTitleDescriptionFallback(["CTL-802"], {
        replicaOptions: { readerFactory: replica.factory },
      });
      expect(spy.callCount).toBe(1);
      expect(out["CTL-802"].title).toBe("Real");
    } finally {
      spy.restore();
    }
  });

  it("D2/D4: a terminal replica hit takes the 24h TTL, so it is not re-resolved", async () => {
    const replica = fakeReplica({
      details: { "CTL-803": { ...DETAIL, state: { name: "Done", type: "completed" } } },
    });
    const spy1 = spyFetch();
    try {
      await fillTitleDescriptionFallback(["CTL-803"], {
        replicaOptions: { readerFactory: replica.factory },
      });
    } finally {
      spy1.restore();
    }
    // Second call with NO replica available at all: served purely from the 24h
    // cache the synthesized `completed` type selected. Had the type been dropped,
    // this would take the 5-min TTL — still cached here, so the assertion that
    // actually bites is the one in the execution-core ground-truth suite; this
    // one proves the terminal payload survives a replica outage.
    const spy2 = spyFetch();
    try {
      const out = await fillTitleDescriptionFallback(["CTL-803"], {
        replicaOptions: { dbPath: "/nonexistent-ctl-1806/no-such-dir/replica.db" },
      });
      expect(out["CTL-803"].title).toBe("Replica-served title");
      expect(spy2.callCount).toBe(0);
    } finally {
      spy2.restore();
    }
  });
});

describe("CTL-1806 D2->D4: the synthesized terminal type buys the 24h TTL", () => {
  it("a terminal replica hit SURVIVES a sweep 6 minutes later; a started one does not", async () => {
    const replica = fakeReplica({
      details: {
        "CTL-810": { ...DETAIL, state: { name: "Done", type: "completed" } },
        "CTL-811": { ...DETAIL, state: { name: "Implement", type: "started" } },
      },
    });
    const spy = spyFetch();
    try {
      await fillTitleDescriptionFallback(["CTL-810", "CTL-811"], {
        replicaOptions: { readerFactory: replica.factory },
      });
      expect(spy.callCount).toBe(0);
    } finally {
      spy.restore();
    }
    expect(_getTitleDescCacheSize()).toBe(2);
    // Sweep 6 minutes into the future: past the 5-min TTL, far short of 24h.
    // If the terminal entry took the short TTL, BOTH would be evicted — which is
    // the quota regression D2 rejects (2725 of 3887 replica tickets are terminal,
    // so they would all drop from a 24h to a 5-min cache).
    const removed = _sweepTitleDescCache(Date.now() + 6 * 60 * 1000);
    expect(removed).toBe(1);
    expect(_getTitleDescCacheSize()).toBe(1);
  });
});

describe("CTL-1806 AC3: the degraded path is LOUD", () => {
  it("a replica miss that falls through emits catalyst.linear.read source=linearis_miss", async () => {
    const spy = spyFetch();
    const replica = fakeReplica({ estimates: {} });
    try {
      await fillEstimateFallback(["CTL-900"], {
        replicaOptions: { readerFactory: replica.factory },
      });
    } finally {
      spy.restore();
    }
    const events = readEmitted();
    expect(events.length).toBe(1);
    const a = events[0].attributes as Record<string, unknown>;
    expect(a["linear.read.source"]).toBe("linearis_miss");
    expect(a["linear.read.result"]).toBe("ok");
    expect(a["linear.read.op"]).toBe("estimate");
    // The service.name must be orch-monitor's own — attributing these reads to
    // the daemon would corrupt the very metric this ticket exists to move.
    expect((events[0].resource as Record<string, unknown>)["service.name"]).toBe(
      "catalyst.orch-monitor"
    );
  });

  it("the title/description degraded path emits op=title_desc", async () => {
    const spy = spyFetch();
    const replica = fakeReplica({ details: {} });
    try {
      await fillTitleDescriptionFallback(["CTL-901"], {
        replicaOptions: { readerFactory: replica.factory },
      });
    } finally {
      spy.restore();
    }
    const events = readEmitted();
    expect(events.length).toBe(1);
    const a = events[0].attributes as Record<string, unknown>;
    expect(a["linear.read.source"]).toBe("linearis_miss");
    expect(a["linear.read.op"]).toBe("title_desc");
  });

  it("a replica HIT is SILENT — no degraded event, because no Linear call happened", async () => {
    const spy = spyFetch();
    const replica = fakeReplica({ estimates: { "CTL-902": 3 } });
    try {
      await fillEstimateFallback(["CTL-902"], {
        replicaOptions: { readerFactory: replica.factory },
      });
    } finally {
      spy.restore();
    }
    // The event stream is the alarm for "a Linear call is about to happen". If a
    // healthy replica-served render emitted, the alarm would be worthless.
    expect(readEmitted().length).toBe(0);
  });

  it("no Linear credential → result=failed (WARN), so a silently-null node is visible", async () => {
    delete process.env.LINEAR_API_TOKEN;
    delete process.env.LINEAR_API_KEY;
    const spy = spyFetch();
    const replica = fakeReplica({ estimates: {} });
    try {
      await fillEstimateFallback(["CTL-903"], {
        replicaOptions: { readerFactory: replica.factory },
      });
      expect(spy.callCount).toBe(0); // undispatchable — no outbound call at all
    } finally {
      spy.restore();
    }
    const events = readEmitted();
    expect(events.length).toBe(1);
    expect((events[0].attributes as Record<string, unknown>)["linear.read.result"]).toBe("failed");
    expect(events[0].severityText).toBe("WARN");
  });

  // The twin of the test above, for the OTHER resolver. Without it, deleting the
  // `result: "failed"` emission from linear-title-description-fallback.mjs left the
  // whole suite GREEN (mutation-verified), while the same deletion in
  // linear-estimate-fallback.mjs went RED. Two sibling resolvers, one of them
  // silently unguarded on the branch an operator most needs to see: a degraded
  // Linear read that did not even dispatch. AC3 is "the miss is LOUD" — a failure
  // that emits nothing is the exact condition the emission exists to announce.
  // Codex P1 on #3355. The ticket-DETAIL path is a SINGLE-ticket read, and the repo
  // rule requires those to gate freshness and fall back loudly. File presence alone
  // is not enough: when the writer stops but its .db remains, a stale hit is served
  // AND cached for 5-24 hours. Observed for real on the developer laptop 2026-08-14
  // (clean SIGTERM, KeepAlive={SuccessfulExit:false} never revived it, .db left on
  // disk, reads served ~15-minute-old state — CTL-1736 / CTL-1844).
  //
  // This is NOT the CTL-1397 hazard: that was gating on .db/-wal MTIME, which a quiet
  // Linear feed makes look stale. isFresh() reads the .writer.lock HEARTBEAT, which
  // ticks every few seconds regardless of Linear activity.
  it("a STALE replica (writer stopped) is a MISS on the detail path, not a stale hit", async () => {
    const spy = spyFetch();
    const replica = fakeReplica({
      isFresh: false,
      details: { "CTL-905": { title: "stale title", description: "stale" } },
    });
    try {
      const out = await readReplicaTicketDetails({
        ids: ["CTL-905"],
        readerFactory: replica.factory,
      });
      // The row EXISTS in the replica — it is withheld because the writer is dead,
      // so the caller falls through to its loud degraded Linear chain.
      expect(out).toEqual({});
    } finally {
      spy.restore();
    }
  });

  it("a FRESH replica still serves the detail hit (the gate is not a blanket refusal)", async () => {
    const spy = spyFetch();
    const replica = fakeReplica({
      isFresh: true,
      details: { "CTL-906": { title: "live title", description: "live" } },
    });
    try {
      const out = await readReplicaTicketDetails({
        ids: ["CTL-906"],
        readerFactory: replica.factory,
      });
      expect(Object.keys(out)).toEqual(["CTL-906"]);
    } finally {
      spy.restore();
    }
  });

  it("the title/description path ALSO emits result=failed (WARN) with no credential", async () => {
    delete process.env.LINEAR_API_TOKEN;
    delete process.env.LINEAR_API_KEY;
    const spy = spyFetch();
    const replica = fakeReplica({ details: {} });
    try {
      await fillTitleDescriptionFallback(["CTL-904"], {
        replicaOptions: { readerFactory: replica.factory },
      });
      expect(spy.callCount).toBe(0); // undispatchable — no outbound call at all
    } finally {
      spy.restore();
    }
    const events = readEmitted();
    expect(events.length).toBe(1);
    const a = events[0].attributes as Record<string, unknown>;
    expect(a["linear.read.result"]).toBe("failed");
    expect(a["linear.read.op"]).toBe("title_desc");
    expect(events[0].severityText).toBe("WARN");
  });
});

describe("CTL-1806 D1: the team estimation method stays a LABELLED degraded fetch", () => {
  it("emits source=linearis (NOT linearis_miss) — no replica was consulted", async () => {
    // The replica has no teams table and carries no issueEstimation, so this read
    // has no local tier at all. Recording it as a "miss" would imply a replica
    // could have served it.
    const spy = spyFetch({
      data: { teams: { nodes: [{ issueEstimation: { type: "tShirt", allowZero: true, extended: false } }] } },
    });
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "ctl1806-home-"));
    process.env.HOME = home; // isolate the shared on-disk cache
    try {
      const m = await getEstimationMethodAsync("ZZZ");
      expect(m?.type).toBe("tShirt");
      expect(spy.callCount).toBe(1);
      const events = readEmitted();
      expect(events.length).toBe(1);
      const a = events[0].attributes as Record<string, unknown>;
      expect(a["linear.read.source"]).toBe("linearis");
      expect(a["linear.read.op"]).toBe("team_method");
      expect(a["event.label"]).toBe("ZZZ");
    } finally {
      spy.restore();
      if (prevHome !== undefined) process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
      _clearMethodCache();
    }
  });

  it("ONE cache: a record the scheduler wrote is honoured here, with ZERO Linear calls", async () => {
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "ctl1806-home-"));
    process.env.HOME = home;
    try {
      // Write through the execution-core writer — the scheduler's own path.
      const { writeTeamEstimationCache, _resetMemoForTests } = await import(
        "../../execution-core/linear-estimation-method.mjs"
      );
      writeTeamEstimationCache("YYY", { type: "fibonacci", allowZero: false, extended: false });
      _resetMemoForTests(); // force the on-DISK read, not the memo

      const spy = spyFetch();
      try {
        const m = await getEstimationMethodAsync("YYY");
        expect(m?.type).toBe("fibonacci");
        // Before CTL-1806 this module used a 24h TTL over the same file the
        // scheduler writes with a 7-day TTL, so a 30h-old record was valid there
        // and stale here — the board re-fetched and rewrote a file the scheduler
        // was already serving. One TTL now.
        expect(spy.callCount).toBe(0);
        expect(readEmitted().length).toBe(0);
      } finally {
        spy.restore();
      }
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
      _clearMethodCache();
    }
  });
});
