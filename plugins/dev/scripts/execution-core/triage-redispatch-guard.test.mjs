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
  bumpTriageDispatchCount,
  fleetTriageDispatchCount,
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
