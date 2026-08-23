// stalled-pr-timer.test.mjs — CTL-1608. Unit tests for the stalled-PR timer.
//
// Run: cd plugins/dev/scripts/execution-core && bun test stalled-pr-timer.test.mjs
//
// Network-free: inject a fake prView and a fake clock. Tests drive only the
// exported pure pieces (computeStalledStamps, readStalledPrState, DEFAULTS).

import { describe, test, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// CTL-2181 — the stamp gains the inputs a finished-draft classifier needs.
// ---------------------------------------------------------------------------

describe("CTL-2181 — the gh field list actually requests isDraft (C3)", () => {
  // This is the POSITIVE CONTROL that the draft input reaches production.
  // Without it every downstream test can pass against a fixture while the one
  // sweep that walks every worker-tracked open PR stays structurally draft-blind
  // — the exact shape of the C3 blind site. It fails CLOSED: if the `--json`
  // literal moves or is restructured, the match is null and the test fails
  // rather than quietly asserting nothing.
  test("the gh field list requests isDraft", () => {
    const src = readFileSync(new URL("./stalled-pr-timer.mjs", import.meta.url), "utf8");
    const m = /"--json",\s*\n?\s*"([^"]*headRefOid[^"]*)"/.exec(src);
    expect(m).not.toBeNull();
    expect(m[1].split(",")).toContain("isDraft");
  });

  test("negative control: the same matcher does NOT find a field we never request", () => {
    const src = readFileSync(new URL("./stalled-pr-timer.mjs", import.meta.url), "utf8");
    const m = /"--json",\s*\n?\s*"([^"]*headRefOid[^"]*)"/.exec(src);
    expect(m[1].split(",")).not.toContain("mergeStateStatus");
  });
});

describe("CTL-2181 — computeStalledStamps carries isDraft + a four-way ciState", () => {
  const T0 = "2026-08-03T10:00:00Z";

  test("carries isDraft and a four-way ciState", () => {
    const view = {
      state: "OPEN",
      isDraft: true,
      headRefOid: "a",
      statusCheckRollup: [{ conclusion: "SUCCESS", startedAt: T0 }],
    };
    const s = computeStalledStamps(null, view, NOW);
    expect(s.isDraft).toBe(true);
    expect(s.ciState).toBe("passing");
  });

  test("a non-draft PR stamps isDraft false, not undefined", () => {
    const s = computeStalledStamps(null, { state: "OPEN", isDraft: false, headRefOid: "a" }, NOW);
    expect(s.isDraft).toBe(false);
  });

  test("an absent isDraft in the view stamps null (unknown), never false", () => {
    // A stamp written by a pre-CTL-2181 view must not claim the PR is ready.
    const s = computeStalledStamps(null, { state: "OPEN", headRefOid: "a" }, NOW);
    expect(s.isDraft).toBeNull();
  });

  test("no CI run → ciState 'none' (NOT passing) and ciFirstFailedAt stays null", () => {
    const s = computeStalledStamps(
      null,
      { state: "OPEN", isDraft: true, headRefOid: "a", statusCheckRollup: [] },
      NOW,
    );
    expect(s.ciState).toBe("none");
    expect(s.ciFirstFailedAt).toBeNull();
  });

  test("pending / failing / unknown rollups each get their own ciState", () => {
    const at = (rollup) =>
      computeStalledStamps(null, { state: "OPEN", headRefOid: "a", statusCheckRollup: rollup }, NOW)
        .ciState;
    expect(at([{ conclusion: null }])).toBe("pending");
    expect(at([{ conclusion: "FAILURE" }])).toBe("failing");
    expect(at([{ conclusion: "WAT" }])).toBe("unknown");
  });
});

describe("CTL-2181 — an honest first-observation push anchor", () => {
  test("first observation anchors lastPushAt to the earliest check startedAt, not now", () => {
    const earliest = "2026-08-02T00:00:00Z";
    const view = {
      state: "OPEN",
      headRefOid: "a",
      statusCheckRollup: [
        { conclusion: "SUCCESS", startedAt: "2026-08-02T02:00:00Z" },
        { conclusion: "SUCCESS", startedAt: earliest },
      ],
    };
    const s = computeStalledStamps(null, view, NOW);
    expect(s.lastPushAt).toBe(new Date(Date.parse(earliest)).toISOString());
    expect(s.pushAnchor).toBe("check-started-at");
  });

  test("first observation with no usable startedAt falls back to now, and SAYS so", () => {
    const s = computeStalledStamps(
      null,
      { state: "OPEN", headRefOid: "a", statusCheckRollup: [{ context: "x", state: "SUCCESS" }] },
      NOW,
    );
    expect(s.lastPushAt).toBe(new Date(NOW).toISOString());
    expect(s.pushAnchor).toBe("first-observation");
  });

  test("a startedAt in the FUTURE is refused — clock skew must not manufacture age", () => {
    const s = computeStalledStamps(
      null,
      {
        state: "OPEN",
        headRefOid: "a",
        statusCheckRollup: [{ conclusion: "SUCCESS", startedAt: new Date(NOW + 60_000).toISOString() }],
      },
      NOW,
    );
    expect(s.lastPushAt).toBe(new Date(NOW).toISOString());
    expect(s.pushAnchor).toBe("first-observation");
  });

  test("an unparsable startedAt falls back rather than throwing", () => {
    const s = computeStalledStamps(
      null,
      { state: "OPEN", headRefOid: "a", statusCheckRollup: [{ conclusion: "SUCCESS", startedAt: "wat" }] },
      NOW,
    );
    expect(s.pushAnchor).toBe("first-observation");
  });

  test("a later tick never re-derives the anchor from checks (OID unchanged → age preserved)", () => {
    const prev = {
      lastPushAt: "2026-08-01T00:00:00Z",
      lastKnownHeadOid: "abc",
      pushAnchor: "check-started-at",
    };
    const s = computeStalledStamps(
      prev,
      {
        state: "OPEN",
        headRefOid: "abc",
        statusCheckRollup: [{ conclusion: "SUCCESS", startedAt: "2026-08-02T00:00:00Z" }],
      },
      NOW,
    );
    expect(s.lastPushAt).toBe("2026-08-01T00:00:00Z");
    expect(s.pushAnchor).toBe("check-started-at");
  });

  test("an observed push sets pushAnchor to 'push-observed' (the strongest anchor)", () => {
    const first = computeStalledStamps(null, { state: "OPEN", headRefOid: "a" }, NOW);
    const pushed = computeStalledStamps(first, { state: "OPEN", headRefOid: "b" }, NOW + 3_600_000);
    expect(pushed.pushAnchor).toBe("push-observed");
    expect(pushed.lastPushAt).toBe(new Date(NOW + 3_600_000).toISOString());
  });

  test("a prev with no pushAnchor (pre-CTL-2181 stamp) carries forward as first-observation", () => {
    const prev = { lastPushAt: "2026-08-01T00:00:00Z", lastKnownHeadOid: "abc" };
    const s = computeStalledStamps(prev, { state: "OPEN", headRefOid: "abc" }, NOW);
    expect(s.pushAnchor).toBe("first-observation");
  });
});

describe("CTL-2181 — regression guard: the CTL-1608 stamp fields are unchanged", () => {
  test("ciFirstFailedAt/reviewRequestedAt semantics unchanged", () => {
    const s = computeStalledStamps(
      null,
      { state: "OPEN", statusCheckRollup: [{ conclusion: "FAILURE" }], reviewDecision: "REVIEW_REQUIRED" },
      NOW,
    );
    expect(s.ciFirstFailedAt).toBe(new Date(NOW).toISOString());
    expect(s.reviewRequestedAt).toBe(new Date(NOW).toISOString());
  });

  test("an UNKNOWN check conclusion does not stamp ciFirstFailedAt (isFailingState untouched)", () => {
    const s = computeStalledStamps(
      null,
      { state: "OPEN", statusCheckRollup: [{ conclusion: "WAT" }] },
      NOW,
    );
    expect(s.ciFirstFailedAt).toBeNull();
    expect(s.ciState).toBe("unknown"); // ...but the new field DOES say we could not tell
  });
});
