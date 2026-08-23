// lease-authority-renew.test.mjs — CTC-921, the progress-gated renewal loop.
// Run: cd plugins/dev/scripts/execution-core && bun test lease-authority-renew.test.mjs
//
// The client CONTRACT for `renew` lives in lease-authority.test.mjs. This file owns the
// DECISION half: when may a holder renew at all, and which of this host's phases get renewed
// on a tick. Both are exercised through injected seams — no network, no timer, no daemon.
//
// ⛔ The load-bearing property under test is invariant I2 (ADR-0027): a renewal is earned by
// PROGRESS, not by being alive. The server only rejects an EMPTY assertion, so nothing stops a
// client from re-POSTing the same string forever — a mechanical keep-alive wearing a costume.
// The refusal has to happen HERE, before the call: a holder whose progress mark has not moved
// makes no call at all and its lease lapses on its own deadline.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { decideRenewal, defaultIsPhaseDispatched, renewActiveLeases } from "./lease-authority.mjs";

describe("decideRenewal — the progress gate", () => {
  test("first-ever check with positive progress → renew", () => {
    expect(decideRenewal({ phase: "implement", mark: 3, lastRenewedMark: undefined })).toEqual({
      shouldRenew: true,
      assertion: "implement-progress:3",
    });
  });

  test("zero progress never renews, even on the first check", () => {
    // 0 is defaultProgressMark's own documented "no progress observed" value — it is also what
    // it returns for an unresolvable worktree or a failed git call, so renewing on 0 would
    // renew on a READ FAILURE.
    expect(decideRenewal({ phase: "implement", mark: 0, lastRenewedMark: undefined })).toEqual({
      shouldRenew: false,
    });
  });

  test("mark unchanged since the last renewal → skip (a stalled holder is not kept alive)", () => {
    expect(decideRenewal({ phase: "implement", mark: 5, lastRenewedMark: 5 })).toEqual({
      shouldRenew: false,
    });
  });

  test("mark increased since the last renewal → renew with a DISTINCT assertion", () => {
    const first = decideRenewal({ phase: "implement", mark: 5, lastRenewedMark: undefined });
    const second = decideRenewal({ phase: "implement", mark: 6, lastRenewedMark: 5 });
    expect(second).toEqual({ shouldRenew: true, assertion: "implement-progress:6" });
    // The CTC-921 acceptance check: assertions across renewals must be pairwise distinct.
    expect(second.assertion).not.toBe(first.assertion);
  });

  test("mark regressed (should not happen, but must not crash or renew) → skip", () => {
    expect(decideRenewal({ phase: "implement", mark: 4, lastRenewedMark: 5 })).toEqual({
      shouldRenew: false,
    });
  });

  test("non-finite or non-numeric marks → skip, never throws", () => {
    for (const mark of [NaN, Infinity, undefined, null, "7"]) {
      expect(decideRenewal({ phase: "implement", mark, lastRenewedMark: 5 })).toEqual({
        shouldRenew: false,
      });
    }
  });

  test("the assertion names the phase, so two phases of one ticket never collide", () => {
    expect(decideRenewal({ phase: "research", mark: 12, lastRenewedMark: 1 }).assertion).toBe(
      "research-progress:12"
    );
  });
});

// ─── the per-tick scan ───────────────────────────────────────────────────────

const HOST = "mini";

/** A nested phase signal in readAllPhaseSignals' normalized shape. */
function signal({
  ticket = "CTC-1",
  phase = "implement",
  status = "running",
  bg = "job-1",
  host = { name: HOST, id: "h1" },
  layout = "nested",
} = {}) {
  return {
    ticket,
    layout,
    phase,
    status,
    liveness: { kind: "bg", value: bg },
    host,
    signalPath: `/fake/${ticket}/phase-${phase}.json`,
    raw: {},
  };
}

/** A recording lease client whose renew() returns a queued outcome. */
function fakeClient(outcomes = [{ renewed: true }]) {
  const calls = [];
  const queue = [...outcomes];
  return {
    calls,
    renew(args) {
      calls.push(args);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (typeof next === "function") return next(args);
      return next;
    },
  };
}

const scan = (opts) =>
  renewActiveLeases({
    client: opts.client,
    hostName: opts.hostName ?? HOST,
    orchDir: "/fake/orch",
    lastRenewedMarks: opts.lastRenewedMarks ?? new Map(),
    readSignals: () => opts.signals ?? [],
    progressMark: opts.progressMark ?? (() => 1),
    readGeneration: opts.readGeneration ?? (() => 7),
    resolveRepoRoot: opts.resolveRepoRoot,
    ...(opts.isPhaseDispatched ? { isPhaseDispatched: opts.isPhaseDispatched } : {}),
  });

describe("renewActiveLeases — which of this host's phases get renewed", () => {
  test("a running, this-host phase with progress → exactly one renew, correctly addressed", () => {
    const client = fakeClient();
    const marks = new Map();
    const res = scan({ client, signals: [signal()], progressMark: () => 3, lastRenewedMarks: marks });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual({
      ticket: "CTC-1",
      phase: "implement",
      holder: HOST,
      nonce: 7, // the ticket's cluster generation IS the grant nonce
      assertion: "implement-progress:3",
    });
    expect(res.renewed).toBe(1);
    expect(marks.get("CTC-1:implement")).toBe(3);
  });

  test("no progress since the last renewal → NO call at all (the lease is left to lapse)", () => {
    const client = fakeClient();
    const res = scan({
      client,
      signals: [signal()],
      progressMark: () => 3,
      lastRenewedMarks: new Map([["CTC-1:implement", 3]]),
    });
    expect(client.calls).toHaveLength(0);
    expect(res.renewed).toBe(0);
    expect(res.skipped).toBe(1);
  });

  test("a phase dispatched by a DIFFERENT host is never touched", () => {
    const client = fakeClient();
    scan({ client, signals: [signal({ host: { name: "mini-2", id: "h2" } })] });
    expect(client.calls).toHaveLength(0);
  });

  test("a signal with no host attribution is never touched (cannot prove it is ours)", () => {
    const client = fakeClient();
    scan({ client, signals: [signal({ host: null })] });
    expect(client.calls).toHaveLength(0);
  });

  test("only a running phase is renewed — every other status is skipped", () => {
    for (const status of ["dispatched", "complete", "failed", "skipped", "park", "yielded", ""]) {
      const client = fakeClient();
      scan({ client, signals: [signal({ status })] });
      expect(client.calls).toHaveLength(0);
    }
  });

  // ⛔ CTC-921 regression: `bg_job_id` alone is NOT the dispatch test. It is written only by the
  // legacy `claude --bg` executor; every `executor:"sdk"` phase carries `bg_job_id:null` for its
  // whole life. Gating on it made this scan inert for essentially every phase the fleet runs.
  // What is actually required is that SOME liveness source vouches for the phase.
  test("a running phase no liveness source vouches for is skipped", () => {
    const client = fakeClient();
    scan({ client, signals: [signal({ bg: null })], isPhaseDispatched: () => false });
    expect(client.calls).toHaveLength(0);
  });

  test("a running SDK phase (bg_job_id null) IS renewed when the SDK registry vouches for it", () => {
    const client = fakeClient();
    scan({ client, signals: [signal({ bg: null })], isPhaseDispatched: () => true });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].ticket).toBe("CTC-1");
  });

  test("a legacy FLAT signal is ignored (numeric phase, no lease scope)", () => {
    const client = fakeClient();
    scan({ client, signals: [signal({ layout: "flat", phase: 3 })] });
    expect(client.calls).toHaveLength(0);
  });

  test("no cluster-generation.json → skipped: no lease-authority claim on record to renew", () => {
    const client = fakeClient();
    scan({ client, signals: [signal()], readGeneration: () => null });
    expect(client.calls).toHaveLength(0);
  });

  test("a non-finite generation is never sent as a nonce", () => {
    const client = fakeClient();
    scan({ client, signals: [signal()], readGeneration: () => NaN });
    expect(client.calls).toHaveLength(0);
  });
});

describe("renewActiveLeases — outcome handling", () => {
  test("a refusal does NOT advance the remembered mark (so the next tick re-attempts)", () => {
    const client = fakeClient([{ renewed: false, refusal: "expired", current: null }]);
    const marks = new Map();
    const res = scan({ client, signals: [signal()], progressMark: () => 4, lastRenewedMarks: marks });
    expect(res.refused).toBe(1);
    expect(marks.has("CTC-1:implement")).toBe(false);
  });

  test("a throwing renew is caught and the tick continues to the next ticket (fail-open)", () => {
    const client = {
      calls: [],
      renew(args) {
        client.calls.push(args);
        if (args.ticket === "CTC-1") throw new Error("cloud down");
        return { renewed: true };
      },
    };
    const res = renewActiveLeases({
      client,
      hostName: HOST,
      orchDir: "/fake/orch",
      lastRenewedMarks: new Map(),
      readSignals: () => [signal({ ticket: "CTC-1" }), signal({ ticket: "CTC-2" })],
      progressMark: () => 2,
      readGeneration: () => 7,
    });
    expect(client.calls).toHaveLength(2); // the second ticket still ran
    expect(res.errors).toBe(1);
    expect(res.renewed).toBe(1);
  });

  test("a throwing progressMark for one ticket does not abort the scan", () => {
    const client = fakeClient();
    const res = renewActiveLeases({
      client,
      hostName: HOST,
      orchDir: "/fake/orch",
      lastRenewedMarks: new Map(),
      readSignals: () => [signal({ ticket: "CTC-1" }), signal({ ticket: "CTC-2" })],
      progressMark: ({ ticket }) => {
        if (ticket === "CTC-1") throw new Error("git exploded");
        return 2;
      },
      readGeneration: () => 7,
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].ticket).toBe("CTC-2");
    expect(res.errors).toBe(1);
  });

  test("an unreadable signal source is survivable — no throw, empty summary", () => {
    const client = fakeClient();
    const res = renewActiveLeases({
      client,
      hostName: HOST,
      orchDir: "/fake/orch",
      lastRenewedMarks: new Map(),
      readSignals: () => {
        throw new Error("no workers dir");
      },
      progressMark: () => 1,
      readGeneration: () => 7,
    });
    expect(res).toEqual({ scanned: 0, renewed: 0, skipped: 0, refused: 0, errors: 1 });
    expect(client.calls).toHaveLength(0);
  });

  test("ACCEPTANCE (CTC-921): across ticks, a progressing holder renews with pairwise-DISTINCT assertions", () => {
    const client = fakeClient();
    const marks = new Map();
    let mark = 1;
    for (const _ of [1, 2, 3]) {
      scan({ client, signals: [signal()], progressMark: () => mark++, lastRenewedMarks: marks });
    }
    const assertions = client.calls.map((c) => c.assertion);
    expect(assertions).toEqual([
      "implement-progress:1",
      "implement-progress:2",
      "implement-progress:3",
    ]);
    expect(new Set(assertions).size).toBe(assertions.length);
  });

  test("ACCEPTANCE (CTC-921): a STALLED holder makes no call on any tick, however many elapse", () => {
    const client = fakeClient();
    const marks = new Map();
    for (const _ of [1, 2, 3, 4, 5]) {
      scan({ client, signals: [signal()], progressMark: () => 2, lastRenewedMarks: marks });
    }
    expect(client.calls).toHaveLength(1); // the first tick earned one; nothing after it did
  });

  test("ACCEPTANCE: the nonce is CONSTANT across renewals — a renewal continues a tenure", () => {
    const client = fakeClient();
    const marks = new Map();
    let mark = 1;
    for (const _ of [1, 2, 3]) {
      scan({ client, signals: [signal()], progressMark: () => mark++, lastRenewedMarks: marks });
    }
    expect(new Set(client.calls.map((c) => c.nonce))).toEqual(new Set([7]));
  });

  test("two phases of the same ticket are tracked independently", () => {
    const client = fakeClient();
    const marks = new Map();
    scan({
      client,
      signals: [signal({ phase: "implement" }), signal({ phase: "research" })],
      progressMark: ({ phase }) => (phase === "implement" ? 3 : 9),
      lastRenewedMarks: marks,
    });
    expect(marks.get("CTC-1:implement")).toBe(3);
    expect(marks.get("CTC-1:research")).toBe(9);
    expect(client.calls.map((c) => c.assertion).sort()).toEqual([
      "implement-progress:3",
      "research-progress:9",
    ]);
  });
});

// ⛔ THE INERT-SHIP GUARD (the CTL-729 defect class, re-armed for this loop).
// `defaultProgressMark` resolves a code phase's worktree from `repoRoot` — with none, it
// returns 0 for implement/remediate/research/plan, `decideRenewal` skips forever, and the whole
// renewal loop ships INERT for the very phase (implement, the longest) this ticket exists to
// protect. CTL-729 was exactly this bug in the hung-worker probe. So the per-ticket repoRoot
// resolution is pinned here as a behaviour, not left to a comment.
describe("renewActiveLeases — repoRoot is resolved PER TICKET and handed to the probe", () => {
  test("the probe is called with the ticket's resolved repoRoot (never undefined)", () => {
    const client = fakeClient();
    const seen = [];
    scan({
      client,
      signals: [signal({ ticket: "CTC-1" }), signal({ ticket: "CTL-2" })],
      resolveRepoRoot: (ticket) => (ticket === "CTC-1" ? "/repos/cloud" : "/repos/catalyst"),
      progressMark: (arg) => {
        seen.push(arg);
        return 2;
      },
    });
    expect(seen.map((a) => a.repoRoot)).toEqual(["/repos/cloud", "/repos/catalyst"]);
    // CTL-729's own guard: the probe silently IGNORES worktreePath, so passing it instead of
    // repoRoot is the bug. Prove we never hand it one.
    expect(seen.every((a) => !("worktreePath" in a))).toBe(true);
    expect(seen.every((a) => "orchDir" in a && "ticket" in a && "phase" in a)).toBe(true);
  });

  test("an unresolvable repoRoot degrades to null and never aborts the scan", () => {
    const client = fakeClient();
    const seen = [];
    scan({
      client,
      signals: [signal()],
      resolveRepoRoot: () => {
        throw new Error("registry down");
      },
      progressMark: (arg) => {
        seen.push(arg);
        return 2;
      },
    });
    expect(seen[0].repoRoot).toBeNull();
    expect(client.calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CTC-921 — the dispatch predicate itself, against a real .sdk-workers projection.
//
// This block exists because the bug it guards was INVISIBLE to every injected-fake test above:
// `renewActiveLeases` was correct, and the default predicate handed it a `false` for every
// SDK-executor phase. Measured on the live fleet orchDir when this was found: 340/353 nested
// signals were `executor:"sdk"` with `bg_job_id:null`, 13 were `executor:"bg"` with it set, and
// the sole `status:"running"` signal was an SDK one — i.e. the scan could never have renewed
// anything. So these tests use the real filesystem reader, not a stub.
// ─────────────────────────────────────────────────────────────────────────────
describe("defaultIsPhaseDispatched — both executors' liveness sources", () => {
  /** An orchDir with a .sdk-workers/<ticket>.json projection, as the SDK executor writes it. */
  function orchWithProjection({ ticket = "CTC-1", phase = "implement", pid = process.pid, updatedAt = Date.now() }) {
    const dir = mkdtempSync(join(tmpdir(), "ctc921-"));
    mkdirSync(join(dir, ".sdk-workers"), { recursive: true });
    writeFileSync(join(dir, ".sdk-workers", `${ticket}.json`), JSON.stringify({ ticket, phase, pid, updatedAt }));
    return dir;
  }

  test("legacy bg executor: a set bg_job_id vouches on its own, no projection needed", () => {
    expect(defaultIsPhaseDispatched(signal({ bg: "job-1" }), "/nonexistent")).toBe(true);
  });

  test("SDK executor: bg_job_id null + a live, phase-matching projection → dispatched", () => {
    const orch = orchWithProjection({ ticket: "CTC-1", phase: "implement" });
    expect(defaultIsPhaseDispatched(signal({ bg: null }), orch)).toBe(true);
  });

  test("the projection is per-TICKET, so it may not vouch for a SIBLING phase's signal", () => {
    const orch = orchWithProjection({ ticket: "CTC-1", phase: "implement" });
    expect(defaultIsPhaseDispatched(signal({ bg: null, phase: "review" }), orch)).toBe(false);
  });

  test("a dead pid does not vouch — errs toward letting the lease lapse", () => {
    // pid 1 is alive but not ours; use an unassignable pid instead.
    const orch = orchWithProjection({ ticket: "CTC-1", pid: 2 ** 31 - 1 });
    expect(defaultIsPhaseDispatched(signal({ bg: null }), orch)).toBe(false);
  });

  test("a stale projection (older than the freshness window) does not vouch", () => {
    const orch = orchWithProjection({ ticket: "CTC-1", updatedAt: Date.now() - 24 * 60 * 60 * 1000 });
    expect(defaultIsPhaseDispatched(signal({ bg: null }), orch)).toBe(false);
  });

  test("no projection at all → not dispatched, never throws", () => {
    const orch = mkdtempSync(join(tmpdir(), "ctc921-"));
    expect(defaultIsPhaseDispatched(signal({ bg: null }), orch)).toBe(false);
  });

  test("a missing/!string orchDir is tolerated rather than thrown", () => {
    expect(defaultIsPhaseDispatched(signal({ bg: null }), undefined)).toBe(false);
  });
});
