// stalled-pr-timer.test.mjs — CTL-1608. Unit tests for the stalled-PR timer.
//
// Run: cd plugins/dev/scripts/execution-core && bun test stalled-pr-timer.test.mjs
//
// Network-free: inject a fake prView and a fake clock. Tests drive only the
// exported pure pieces (computeStalledStamps, readStalledPrState, DEFAULTS).

import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeStalledStamps, readStalledPrState, DEFAULTS } from "./stalled-pr-timer.mjs";

const NOW = Date.parse("2026-08-03T12:00:00Z");

describe("DEFAULTS — exported constants", () => {
  test("intervalSeconds is a positive number", () => {
    expect(typeof DEFAULTS.intervalSeconds).toBe("number");
    expect(DEFAULTS.intervalSeconds).toBeGreaterThan(0);
  });
});

describe("computeStalledStamps — the pure stamp transition", () => {
  test("CI failing → stamps ciFirstFailedAt on first observation, preserves it after", () => {
    const view = { state: "OPEN", statusCheckRollup: [{ conclusion: "FAILURE" }], headRefOid: "a" };
    const first = computeStalledStamps(null, view, NOW);
    expect(first.ciFirstFailedAt).toBe(new Date(NOW).toISOString());
    const later = computeStalledStamps(first, { ...view }, NOW + 3_600_000);
    expect(later.ciFirstFailedAt).toBe(first.ciFirstFailedAt); // preserved, not re-stamped
  });

  test("CI recovered → clears ciFirstFailedAt", () => {
    const failing = computeStalledStamps(null, { state: "OPEN", statusCheckRollup: [{ conclusion: "FAILURE" }], headRefOid: "a" }, NOW);
    const green = computeStalledStamps(failing, { state: "OPEN", statusCheckRollup: [{ conclusion: "SUCCESS" }], headRefOid: "a" }, NOW + 60_000);
    expect(green.ciFirstFailedAt).toBeNull();
  });

  test("REVIEW_REQUIRED → stamps reviewRequestedAt; APPROVED clears it", () => {
    const req = computeStalledStamps(null, { state: "OPEN", reviewDecision: "REVIEW_REQUIRED", headRefOid: "a" }, NOW);
    expect(req.reviewRequestedAt).toBe(new Date(NOW).toISOString());
    const done = computeStalledStamps(req, { state: "OPEN", reviewDecision: "APPROVED", headRefOid: "a" }, NOW + 60_000);
    expect(done.reviewRequestedAt).toBeNull();
  });

  test("head OID change → re-stamps lastPushAt (push detected)", () => {
    const first = computeStalledStamps(null, { state: "OPEN", headRefOid: "a" }, NOW);
    expect(first.lastPushAt).toBe(new Date(NOW).toISOString()); // initialized on first sight
    const pushed = computeStalledStamps(first, { state: "OPEN", headRefOid: "b" }, NOW + 7_200_000);
    expect(pushed.lastPushAt).toBe(new Date(NOW + 7_200_000).toISOString());
    expect(pushed.lastKnownHeadOid).toBe("b");
  });

  test("no OID change → lastPushAt preserved (age accrues)", () => {
    const first = computeStalledStamps(null, { state: "OPEN", headRefOid: "a" }, NOW);
    const same = computeStalledStamps(first, { state: "OPEN", headRefOid: "a" }, NOW + 7_200_000);
    expect(same.lastPushAt).toBe(first.lastPushAt);
  });

  test("always refreshes state, prNumber, repo, observedAt", () => {
    const result = computeStalledStamps(null, { state: "OPEN", headRefOid: "x", prNumber: 42, repo: "org/r" }, NOW);
    expect(result.state).toBe("OPEN");
    expect(result.prNumber).toBe(42);
    expect(result.repo).toBe("org/r");
    expect(result.observedAt).toBe(new Date(NOW).toISOString());
  });

  test("null statusCheckRollup → ciFirstFailedAt stays null", () => {
    const result = computeStalledStamps(null, { state: "OPEN", statusCheckRollup: null, headRefOid: "a" }, NOW);
    expect(result.ciFirstFailedAt).toBeNull();
  });

  test("empty statusCheckRollup → ciFirstFailedAt stays null (no checks = not failing)", () => {
    const result = computeStalledStamps(null, { state: "OPEN", statusCheckRollup: [], headRefOid: "a" }, NOW);
    expect(result.ciFirstFailedAt).toBeNull();
  });

  test("multiple check statuses: only one FAILURE → stamps ciFirstFailedAt", () => {
    const view = { state: "OPEN", statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }], headRefOid: "a" };
    const result = computeStalledStamps(null, view, NOW);
    expect(result.ciFirstFailedAt).toBe(new Date(NOW).toISOString());
  });
});

describe("readStalledPrState — aggregate workers/*/stalled-pr.json", () => {
  test("missing dir → empty Map (no throw)", () => {
    const result = readStalledPrState("/tmp/does-not-exist-" + NOW);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test("round-trip: write two workers/<T>/stalled-pr.json, assert Map keyed by ticket", () => {
    const base = join(tmpdir(), "stalled-pr-test-" + NOW);
    const w1 = join(base, "workers", "CTL-100");
    const w2 = join(base, "workers", "CTL-200");
    mkdirSync(w1, { recursive: true });
    mkdirSync(w2, { recursive: true });
    writeFileSync(join(w1, "stalled-pr.json"), JSON.stringify({ ticket: "CTL-100", state: "OPEN", ciFirstFailedAt: new Date(NOW).toISOString() }));
    writeFileSync(join(w2, "stalled-pr.json"), JSON.stringify({ ticket: "CTL-200", state: "OPEN", ciFirstFailedAt: null }));

    const map = readStalledPrState(base);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(2);
    expect(map.get("CTL-100")).toBeDefined();
    expect(map.get("CTL-100").ciFirstFailedAt).toBe(new Date(NOW).toISOString());
    expect(map.get("CTL-200")).toBeDefined();
    expect(map.get("CTL-200").ciFirstFailedAt).toBeNull();
  });

  test("corrupt stalled-pr.json skipped (no throw)", () => {
    const base = join(tmpdir(), "stalled-pr-corrupt-" + NOW);
    const w1 = join(base, "workers", "CTL-300");
    mkdirSync(w1, { recursive: true });
    writeFileSync(join(w1, "stalled-pr.json"), "NOT JSON {{{");

    const map = readStalledPrState(base);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0); // corrupt entry skipped
  });
});
