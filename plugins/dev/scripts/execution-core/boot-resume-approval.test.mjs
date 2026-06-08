// boot-resume-approval.test.mjs — CTL-644. processApprovedResumes: dispatch
// gated tickets whose operator-approval sentinel exists.
//
// Run: cd plugins/dev/scripts/execution-core && bun test boot-resume-approval.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  processApprovedResumes,
  bootResumePendingPath,
  bootResumeApprovedPath,
} from "./boot-resume.mjs";

let orchDir;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "boot-resume-approval-"));
});

afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

function writePendingMarker(dir, ticket, phase, worktreePath) {
  const workerDir = join(dir, "workers", ticket);
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(
    bootResumePendingPath(dir, ticket),
    JSON.stringify({ ticket, phase, worktreePath, requestedAt: "2026-06-08T00:00:00Z" })
  );
}

function writeApprovedMarker(dir, ticket) {
  const workerDir = join(dir, "workers", ticket);
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(bootResumeApprovedPath(dir, ticket), "");
}

function makeReviveDispatch(code = 0) {
  const calls = [];
  const fn = (...args) => { calls.push(args); return { code }; };
  fn.calls = calls;
  return fn;
}

describe("processApprovedResumes (CTL-644)", () => {
  test("approved gated ticket dispatches + clears both sentinels on success", () => {
    writePendingMarker(orchDir, "CTL-50", "implement", "/wt/CTL-50");
    writeApprovedMarker(orchDir, "CTL-50");

    const reviveDispatch = makeReviveDispatch(0);

    processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
    });

    expect(reviveDispatch.calls.length).toBe(1);
    expect(reviveDispatch.calls[0][0]).toMatchObject({ ticket: "CTL-50", phase: "implement" });

    // Both sentinels cleared
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-50"))).toBe(false);
    expect(existsSync(bootResumeApprovedPath(orchDir, "CTL-50"))).toBe(false);
  });

  test("pending marker present but no approval sentinel — no dispatch, marker retained", () => {
    writePendingMarker(orchDir, "CTL-51", "review", "/wt/CTL-51");
    // No approved sentinel written

    const reviveDispatch = makeReviveDispatch(0);

    processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
    });

    expect(reviveDispatch.calls.length).toBe(0);
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-51"))).toBe(true);
  });

  test("approval dispatch routes through reviveDispatch seam — same budget/storm guards as cheap path", () => {
    writePendingMarker(orchDir, "CTL-52", "verify", "/wt/CTL-52");
    writeApprovedMarker(orchDir, "CTL-52");

    // Use a tracking reviveDispatch that records its args — the point is
    // that processApprovedResumes must call reviveDispatch (not a raw
    // dispatch), so existing MAX_REVIVES and storm-breaker guards apply.
    const reviveDispatch = makeReviveDispatch(0);
    const rawDispatch = makeReviveDispatch(0);

    processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: rawDispatch,
      appendEvent: () => true,
    });

    // reviveDispatch is invoked; raw dispatch is NOT invoked directly.
    expect(reviveDispatch.calls.length).toBe(1);
    expect(rawDispatch.calls.length).toBe(0);
  });

  // CTL-639 verify: cover the dispatch-failure retry contract and the edge
  // paths the original 3 tests left untested.
  test("dispatch failure (code: 1) retains both sentinels and counts failed", () => {
    writePendingMarker(orchDir, "CTL-53", "implement", "/wt/CTL-53");
    writeApprovedMarker(orchDir, "CTL-53");

    const reviveDispatch = makeReviveDispatch(1); // non-zero → failure

    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
    });

    expect(res).toMatchObject({ dispatched: 0, failed: 1 });
    // Sentinels retained so the next tick retries.
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-53"))).toBe(true);
    expect(existsSync(bootResumeApprovedPath(orchDir, "CTL-53"))).toBe(true);
  });

  test("reviveDispatch throwing is caught and counted as a failure (sentinels retained)", () => {
    writePendingMarker(orchDir, "CTL-54", "review", "/wt/CTL-54");
    writeApprovedMarker(orchDir, "CTL-54");

    const reviveDispatch = () => { throw new Error("boom"); };

    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
    });

    expect(res).toMatchObject({ dispatched: 0, failed: 1 });
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-54"))).toBe(true);
    expect(existsSync(bootResumeApprovedPath(orchDir, "CTL-54"))).toBe(true);
  });

  test("approved sentinel with an unreadable pending marker is skipped (no dispatch)", () => {
    const workerDir = join(orchDir, "workers", "CTL-55");
    mkdirSync(workerDir, { recursive: true });
    // Pending path is a present-but-corrupt JSON file; approval sentinel present.
    writeFileSync(bootResumePendingPath(orchDir, "CTL-55"), "{not valid json");
    writeApprovedMarker(orchDir, "CTL-55");

    const reviveDispatch = makeReviveDispatch(0);

    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
    });

    expect(reviveDispatch.calls.length).toBe(0);
    expect(res).toMatchObject({ dispatched: 0, failed: 0 });
  });

  test("non-directory entries at the workers/ level are ignored", () => {
    // A stray file directly under workers/ must not be treated as a ticket dir
    // (guards the withFileTypes/isDirectory() filter, CTL-639 hardening).
    mkdirSync(join(orchDir, "workers"), { recursive: true });
    writeFileSync(join(orchDir, "workers", "stray.txt"), "not a ticket");

    const reviveDispatch = makeReviveDispatch(0);

    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
    });

    expect(reviveDispatch.calls.length).toBe(0);
    expect(res).toMatchObject({ dispatched: 0, failed: 0 });
  });

  test("missing workers/ directory returns zero counts without throwing", () => {
    // orchDir exists but has no workers/ subdir yet.
    const res = processApprovedResumes({
      orchDir,
      reviveDispatch: makeReviveDispatch(0),
      dispatch: () => {},
      appendEvent: () => true,
    });
    expect(res).toMatchObject({ dispatched: 0, failed: 0 });
  });
});
