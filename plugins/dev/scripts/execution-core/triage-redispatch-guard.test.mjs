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
