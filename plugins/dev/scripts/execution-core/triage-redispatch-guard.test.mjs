// triage-redispatch-guard.test.mjs — CTL-1441: the triage re-dispatch loop
// terminator. CTL-1403 was re-triaged 12× in ~30h because sweepMissingTriage
// keys only on triage.json (which a WORKER_DIR mis-derivation can write
// astray) and nothing bounds per-ticket triage dispatches. These are the pure
// helpers behind the cap; the sweep/dispatch integration lives in
// monitor.test.mjs (CI-excluded suite — see the workflow's exclusion comment).
//
// Run: cd plugins/dev/scripts/execution-core && bun test triage-redispatch-guard.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { tmpdir } from "node:os";
import {
  TRIAGE_DISPATCH_CAP,
  readTriageSignalStatus,
  readTriageDispatchCount,
  readTriageDispatchRecord,
  bumpTriageDispatchCount,
  fleetTriageDispatchCount,
  markTriageCapped,
  rearmTriageCapOnRequeue,
} from "./monitor.mjs";

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(pathJoin(tmpdir(), "triage-guard-"));
});
afterEach(() => {
  try {
    rmSync(orchDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("readTriageSignalStatus (CTL-1441 guard a)", () => {
  test("returns the status of an existing phase-triage.json", () => {
    const dir = pathJoin(orchDir, "workers", "CTL-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(pathJoin(dir, "phase-triage.json"), JSON.stringify({ status: "done" }));
    expect(readTriageSignalStatus(orchDir, "CTL-1")).toBe("done");
  });

  test("absent signal → null (fail-open)", () => {
    expect(readTriageSignalStatus(orchDir, "CTL-2")).toBeNull();
  });

  test("malformed signal → null (never throws)", () => {
    const dir = pathJoin(orchDir, "workers", "CTL-3");
    mkdirSync(dir, { recursive: true });
    writeFileSync(pathJoin(dir, "phase-triage.json"), "not-json{");
    expect(readTriageSignalStatus(orchDir, "CTL-3")).toBeNull();
  });

  test("signal without a string status → null", () => {
    const dir = pathJoin(orchDir, "workers", "CTL-4");
    mkdirSync(dir, { recursive: true });
    writeFileSync(pathJoin(dir, "phase-triage.json"), JSON.stringify({ status: 7 }));
    expect(readTriageSignalStatus(orchDir, "CTL-4")).toBeNull();
  });
});

describe("triage dispatch counter (CTL-1441 guard b)", () => {
  test("count starts at 0 and bumps persistently", () => {
    expect(readTriageDispatchCount(orchDir, "CTL-10")).toBe(0);
    expect(bumpTriageDispatchCount(orchDir, "CTL-10")).toBe(1);
    expect(bumpTriageDispatchCount(orchDir, "CTL-10")).toBe(2);
    expect(readTriageDispatchCount(orchDir, "CTL-10")).toBe(2);
    // persisted with a timestamp for the operator
    const data = JSON.parse(
      readFileSync(pathJoin(orchDir, ".triage-dispatch-counts", "CTL-10.json"), "utf8"),
    );
    expect(data.count).toBe(2);
    expect(typeof data.lastDispatchAt).toBe("string");
  });

  test("malformed counter file → treated as 0 (fail-open), next bump repairs it", () => {
    const dir = pathJoin(orchDir, ".triage-dispatch-counts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(pathJoin(dir, "CTL-11.json"), "garbage");
    expect(readTriageDispatchCount(orchDir, "CTL-11")).toBe(0);
    expect(bumpTriageDispatchCount(orchDir, "CTL-11")).toBe(1);
  });

  test("cap default is 3 and env-overridable at import time", () => {
    // The default matters: 3 bounded remediation attempts (a re-triage IS the
    // remedial action for a missing triage.json), then park loudly.
    expect(TRIAGE_DISPATCH_CAP).toBe(3);
  });

  test("a MISSING orch dir never gets manufactured by a bump (shared-literal test-dir pollution guard, Codex R3)", () => {
    const ghost = pathJoin(orchDir, "does-not-exist");
    const n = bumpTriageDispatchCount(ghost, "CTL-14");
    expect(n).toBe(1); // in-memory count still returned
    expect(existsSync(ghost)).toBe(false); // nothing persisted
  });

  test("counters are per-ticket", () => {
    bumpTriageDispatchCount(orchDir, "CTL-12");
    expect(readTriageDispatchCount(orchDir, "CTL-12")).toBe(1);
    expect(readTriageDispatchCount(orchDir, "CTL-13")).toBe(0);
  });
});

// ─── CTL-1649: fleetTriageDispatchCount ──────────────────────────────────────

describe("fleetTriageDispatchCount — fleet-wide cap (CTL-1649)", () => {
  test("multiHost:false returns host-local count verbatim (fence seam never called)", () => {
    bumpTriageDispatchCount(orchDir, "CTL-1649"); // host-local = 1
    let fenceCalled = false;
    const count = fleetTriageDispatchCount(orchDir, "CTL-1649", {
      multiHost: false,
      readFenceCount: () => { fenceCalled = true; return { count: 99 }; },
    });
    expect(count).toBe(1);
    expect(fenceCalled).toBe(false);
  });

  test("multiHost:true with fence count > host-local → returns fence count (cross-host churn scenario)", () => {
    // Simulate: new owner has host-local count=0, fence carries count=3 from prior owner.
    // Fleet count = max(0, 3) = 3 → cap is reached.
    const count = fleetTriageDispatchCount(orchDir, "CTL-1649", {
      multiHost: true,
      readFenceCount: () => ({ count: 3 }),
    });
    expect(count).toBe(3);
    expect(count).toBeGreaterThanOrEqual(TRIAGE_DISPATCH_CAP); // regression guard: would park
  });

  test("multiHost:true with fence count < host-local → returns host-local (normal same-owner case)", () => {
    bumpTriageDispatchCount(orchDir, "CTL-1649");
    bumpTriageDispatchCount(orchDir, "CTL-1649"); // host-local = 2
    const count = fleetTriageDispatchCount(orchDir, "CTL-1649", {
      multiHost: true,
      readFenceCount: () => ({ count: 1 }), // fence behind host-local
    });
    expect(count).toBe(2);
  });

  test("multiHost:true with fence returning null (fail-open) → returns host-local", () => {
    bumpTriageDispatchCount(orchDir, "CTL-1649"); // host-local = 1
    const count = fleetTriageDispatchCount(orchDir, "CTL-1649", {
      multiHost: true,
      readFenceCount: () => ({ count: null }),
    });
    expect(count).toBe(1);
  });

  test("multiHost:true with fence seam throwing (fail-open) → returns host-local", () => {
    bumpTriageDispatchCount(orchDir, "CTL-1649"); // host-local = 1
    const count = fleetTriageDispatchCount(orchDir, "CTL-1649", {
      multiHost: true,
      readFenceCount: () => { throw new Error("network"); },
    });
    expect(count).toBe(1);
  });

  // ─── REGRESSION: cross-host double-spend (CTL-1649, the headline bug) ────
  // On a two-host ownership churn, the new owner starts with host-local count=0.
  // Before CTL-1649 the cap gate read host-local only → saw 0 → dispatched even
  // though the fleet had already consumed all 3 allowed attempts. With the fix,
  // fleetTriageDispatchCount reads the fence (count=3) and returns 3 → parks.
  test("regression — cross-host churn: host-local 0 but fence 3 → cap fires, no dispatch", () => {
    // host-local is 0 (new owner, fresh orchDir)
    expect(readTriageDispatchCount(orchDir, "CTL-1649")).toBe(0);
    const fleetCount = fleetTriageDispatchCount(orchDir, "CTL-1649", {
      multiHost: true,
      readFenceCount: () => ({ count: TRIAGE_DISPATCH_CAP }),
    });
    expect(fleetCount).toBeGreaterThanOrEqual(TRIAGE_DISPATCH_CAP);
  });
});

// ─── CTL-2111: rearmTriageCapOnRequeue ───────────────────────────────────────

describe("rearmTriageCapOnRequeue — human re-queue re-arm (CTL-2111)", () => {
  // Seed a capped record: bump to the cap, then mark it capped at a fixed time.
  function seedCapped(ticket, cappedAt) {
    bumpTriageDispatchCount(orchDir, ticket);
    bumpTriageDispatchCount(orchDir, ticket);
    bumpTriageDispatchCount(orchDir, ticket);
    markTriageCapped(orchDir, ticket, { now: () => cappedAt });
    const rec = readTriageDispatchRecord(orchDir, ticket);
    expect(rec.cappedAt).toBe(cappedAt);
    return rec;
  }

  function makeSpies() {
    const calls = { resetFence: [], clearLabel: [], appendRearmEvent: [] };
    return {
      calls,
      resetFence: (arg) => { calls.resetFence.push(arg); return { count: 0 }; },
      clearLabel: (dir, t) => { calls.clearLabel.push({ dir, t }); },
      appendRearmEvent: (arg) => { calls.appendRearmEvent.push(arg); return true; },
    };
  }

  test("capped + eventTs NEWER than cappedAt → re-armed (multi-host): counter+fence reset, label cleared, event once", () => {
    seedCapped("CTL-2111", "2026-08-20T00:00:00Z");
    const s = makeSpies();
    const res = rearmTriageCapOnRequeue(orchDir, "CTL-2111", {
      eventTs: "2026-08-21T00:00:00Z",
      multiHost: true,
      resetFence: s.resetFence,
      clearLabel: s.clearLabel,
      appendRearmEvent: s.appendRearmEvent,
    });
    expect(res.rearmed).toBe(true);
    expect(s.calls.resetFence).toHaveLength(1);
    expect(s.calls.resetFence[0]).toMatchObject({ ticket: "CTL-2111" });
    expect(s.calls.clearLabel).toHaveLength(1);
    expect(s.calls.appendRearmEvent).toHaveLength(1);
    expect(readTriageDispatchCount(orchDir, "CTL-2111")).toBe(0);
    expect(readTriageDispatchRecord(orchDir, "CTL-2111").cappedAt).toBeUndefined();
  });

  test("capped + eventTs OLDER/equal to cappedAt → no-op, no spies", () => {
    seedCapped("CTL-2111", "2026-08-21T00:00:00Z");
    const s = makeSpies();
    const older = rearmTriageCapOnRequeue(orchDir, "CTL-2111", {
      eventTs: "2026-08-20T00:00:00Z", multiHost: true,
      resetFence: s.resetFence, clearLabel: s.clearLabel, appendRearmEvent: s.appendRearmEvent,
    });
    expect(older.rearmed).toBe(false);
    const equal = rearmTriageCapOnRequeue(orchDir, "CTL-2111", {
      eventTs: "2026-08-21T00:00:00Z", multiHost: true,
      resetFence: s.resetFence, clearLabel: s.clearLabel, appendRearmEvent: s.appendRearmEvent,
    });
    expect(equal.rearmed).toBe(false);
    expect(s.calls.resetFence).toHaveLength(0);
    expect(s.calls.clearLabel).toHaveLength(0);
    expect(s.calls.appendRearmEvent).toHaveLength(0);
    // record untouched (still capped)
    expect(readTriageDispatchRecord(orchDir, "CTL-2111").cappedAt).toBe("2026-08-21T00:00:00Z");
  });

  test("NOT capped (no cappedAt) → no-op regardless of eventTs", () => {
    bumpTriageDispatchCount(orchDir, "CTL-2111"); // count but never capped
    const s = makeSpies();
    const res = rearmTriageCapOnRequeue(orchDir, "CTL-2111", {
      eventTs: "2030-01-01T00:00:00Z", multiHost: true,
      resetFence: s.resetFence, clearLabel: s.clearLabel, appendRearmEvent: s.appendRearmEvent,
    });
    expect(res.rearmed).toBe(false);
    expect(res.reason).toBe("not-capped");
    expect(s.calls.resetFence).toHaveLength(0);
  });

  test("eventTs missing/unparseable → conservative no-op (cannot prove newer)", () => {
    seedCapped("CTL-2111", "2026-08-20T00:00:00Z");
    const s = makeSpies();
    expect(rearmTriageCapOnRequeue(orchDir, "CTL-2111", { eventTs: null, multiHost: true,
      resetFence: s.resetFence, clearLabel: s.clearLabel, appendRearmEvent: s.appendRearmEvent }).rearmed).toBe(false);
    expect(rearmTriageCapOnRequeue(orchDir, "CTL-2111", { eventTs: "not-a-date", multiHost: true,
      resetFence: s.resetFence, clearLabel: s.clearLabel, appendRearmEvent: s.appendRearmEvent }).rearmed).toBe(false);
    expect(s.calls.resetFence).toHaveLength(0);
  });

  // ── CTL-2111 (Codex #3824 P1): the fence reset must be CONFIRMED before the
  // host-local latch is dropped. resetTriageAttemptCountSync signals failure with
  // `{count:null}` and never throws, so an ignored result stranded the ticket:
  // fleet fence still capped → re-parked, local cappedAt gone → never retried,
  // and the durable event claimed a re-arm that did not happen.
  test("multi-host + fence reset UNCONFIRMED ({count:null}) → latch retained, no event, not rearmed", () => {
    seedCapped("CTL-2111", "2026-08-20T00:00:00Z");
    const s = makeSpies();
    const res = rearmTriageCapOnRequeue(orchDir, "CTL-2111", {
      eventTs: "2026-08-21T00:00:00Z", multiHost: true,
      resetFence: () => ({ count: null }), // ordinary write failure — does NOT throw
      clearLabel: s.clearLabel, appendRearmEvent: s.appendRearmEvent,
    });
    expect(res.rearmed).toBe(false);
    expect(res.reason).toBe("fence-reset-unconfirmed");
    // The durable event must not claim a re-arm that did not happen.
    expect(s.calls.appendRearmEvent).toHaveLength(0);
    // The latch survives, so a later re-queue can RETRY the reset (the old code
    // cleared cappedAt here, after which every later event read "not-capped").
    const rec = readTriageDispatchRecord(orchDir, "CTL-2111");
    expect(rec?.cappedAt).toBe("2026-08-20T00:00:00Z");
  });

  test("multi-host + fence reset THROWS → treated as unconfirmed, latch retained", () => {
    seedCapped("CTL-2111", "2026-08-20T00:00:00Z");
    const s = makeSpies();
    const res = rearmTriageCapOnRequeue(orchDir, "CTL-2111", {
      eventTs: "2026-08-21T00:00:00Z", multiHost: true,
      resetFence: () => { throw new Error("spawn failed"); },
      clearLabel: s.clearLabel, appendRearmEvent: s.appendRearmEvent,
    });
    expect(res.rearmed).toBe(false);
    expect(res.reason).toBe("fence-reset-unconfirmed");
    expect(s.calls.appendRearmEvent).toHaveLength(0);
    expect(readTriageDispatchRecord(orchDir, "CTL-2111")?.cappedAt).toBe("2026-08-20T00:00:00Z");
  });

  // Positive control: the SAME harness with a CONFIRMED reset must re-arm, so the
  // two assertions above are evidence of the gate and not of a broken fixture.
  test("multi-host + fence reset CONFIRMED ({count:0}) → latch cleared, event emitted", () => {
    seedCapped("CTL-2111", "2026-08-20T00:00:00Z");
    const s = makeSpies();
    const res = rearmTriageCapOnRequeue(orchDir, "CTL-2111", {
      eventTs: "2026-08-21T00:00:00Z", multiHost: true,
      resetFence: () => ({ count: 0 }),
      clearLabel: s.clearLabel, appendRearmEvent: s.appendRearmEvent,
    });
    expect(res.rearmed).toBe(true);
    expect(s.calls.appendRearmEvent).toHaveLength(1);
    expect(readTriageDispatchRecord(orchDir, "CTL-2111")?.cappedAt).toBeFalsy();
    expect(readTriageDispatchCount(orchDir, "CTL-2111")).toBe(0);
  });

  test("single-host → resetFence NOT called; host-local reset + event still happen", () => {
    seedCapped("CTL-2111", "2026-08-20T00:00:00Z");
    const s = makeSpies();
    const res = rearmTriageCapOnRequeue(orchDir, "CTL-2111", {
      eventTs: "2026-08-21T00:00:00Z", multiHost: false,
      resetFence: s.resetFence, clearLabel: s.clearLabel, appendRearmEvent: s.appendRearmEvent,
    });
    expect(res.rearmed).toBe(true);
    expect(s.calls.resetFence).toHaveLength(0); // no fence write single-host
    expect(s.calls.clearLabel).toHaveLength(1);
    expect(s.calls.appendRearmEvent).toHaveLength(1);
    expect(readTriageDispatchCount(orchDir, "CTL-2111")).toBe(0);
  });

  // CTL-2111 (Codex #3824 P1): the NON-load-bearing seams stay fail-open — but the
  // multi-host fence reset does NOT, because on multi-host the host-local reset
  // un-gates nothing by itself (fleetTriageDispatchCount takes max(local, fence)).
  // This test therefore pairs a CONFIRMED fence reset with two throwing auxiliary
  // seams; the throwing-fence case is asserted separately above.
  test("auxiliary seams throwing → still rearmed:true, never throws (fail-open)", () => {
    seedCapped("CTL-2111", "2026-08-20T00:00:00Z");
    const res = rearmTriageCapOnRequeue(orchDir, "CTL-2111", {
      eventTs: "2026-08-21T00:00:00Z", multiHost: true,
      resetFence: () => ({ count: 0 }), // confirmed — the load-bearing seam succeeded
      clearLabel: () => { throw new Error("linear 500"); },
      appendRearmEvent: () => { throw new Error("disk full"); },
    });
    expect(res.rearmed).toBe(true);
    expect(readTriageDispatchCount(orchDir, "CTL-2111")).toBe(0);
    expect(readTriageDispatchRecord(orchDir, "CTL-2111").cappedAt).toBeUndefined();
  });

  test("single-host: every seam throwing → still rearmed:true, never throws (fail-open)", () => {
    seedCapped("CTL-2111", "2026-08-20T00:00:00Z");
    const res = rearmTriageCapOnRequeue(orchDir, "CTL-2111", {
      eventTs: "2026-08-21T00:00:00Z", multiHost: false, // no fence involved at all
      resetFence: () => { throw new Error("fence down"); },
      clearLabel: () => { throw new Error("linear 500"); },
      appendRearmEvent: () => { throw new Error("disk full"); },
    });
    expect(res.rearmed).toBe(true);
    expect(readTriageDispatchCount(orchDir, "CTL-2111")).toBe(0);
    expect(readTriageDispatchRecord(orchDir, "CTL-2111").cappedAt).toBeUndefined();
  });
});
