// event-name-fold.test.mjs — CTL-1834 per-call-site coverage.
//
// Run: cd plugins/dev/scripts/execution-core && bun test event-name-fold.test.mjs
//
// WHY THIS FILE EXISTS SEPARATELY FROM lib/event-name.test.mjs. A boundary test
// proves the boundary reads three keys; it proves NOTHING about whether a given
// call site calls it. Each test below feeds ONE folded site the envelope shape
// that site was blind to BEFORE the fold, so reverting that one fold turns that
// one test RED. A test that passes both before and after a fold is not coverage
// for that fold — see the header note on parseCommentCreatedEvent below.
//
// Fixtures are hand-built. No test here reads ~/catalyst/events/*.jsonl.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseStateChangedEvent,
  parseIssueUpdatedEvent,
  parseCommentCreatedEvent,
} from "./monitor.mjs";
import {
  countReviveEvents,
  hasCompleteEvent,
  __resetEventScanIndexForTest,
} from "./event-scan.mjs";

// ─── execution-core/monitor.mjs (5 folded sites) ────────────────────────────
//
// These read `attributes["event.name"] ?? event.event` — the REVERSE of the
// boundary's order. Folding them is a measured-zero-delta change (322/322 dual
// lines agree), so the tests that would fail on a revert are the v3 ones: monitor
// could never see a v3-shaped Linear event at all.
describe("monitor.mjs parse* resolve through the boundary (CTL-1834)", () => {
  test("parseStateChangedEvent reads a v3-shaped line", () => {
    const out = parseStateChangedEvent({
      ts: "2026-08-07T00:00:00.000Z",
      name: "linear.issue.state_changed",
      detail: { ticket: "CTL-9", teamKey: "CTL", toState: "In Progress" },
    });
    expect(out).not.toBeNull();
    expect(out.identifier).toBe("CTL-9");
    expect(out.toState).toBe("In Progress");
    // CTL-2111: the event ts is surfaced so the cap re-arm can prove a re-queue
    // post-dates the park.
    expect(out.ts).toBe("2026-08-07T00:00:00.000Z");
  });

  test("parseStateChangedEvent surfaces ts=null when the event has no ts (CTL-2111)", () => {
    const out = parseStateChangedEvent({
      name: "linear.issue.state_changed",
      detail: { ticket: "CTL-9", teamKey: "CTL", toState: "Todo" },
    });
    expect(out).not.toBeNull();
    expect(out.ts).toBeNull();
  });

  test("parseIssueUpdatedEvent reads a v3-shaped line", () => {
    const out = parseIssueUpdatedEvent({
      ts: "2026-08-07T00:00:00.000Z",
      name: "linear.issue.updated",
      detail: { ticket: "CTL-9" },
    });
    expect(out).not.toBeNull();
    expect(out.identifier).toBe("CTL-9");
  });

  test("parseCommentCreatedEvent reads a v3-shaped line", () => {
    const out = parseCommentCreatedEvent({
      ts: "2026-08-07T00:00:00.000Z",
      name: "linear.comment.created",
      detail: { ticket: "CTL-9", body: "ping" },
    });
    expect(out).not.toBeNull();
    expect(out.ticket).toBe("CTL-9");
  });

  // REGRESSION HALF — these pass before AND after the fold, so they are NOT
  // coverage for it. They are here to pin the order flip: monitor read
  // attributes-FIRST and now reads event-FIRST, and on a real dual line the two
  // orders must still agree.
  test("regression: v1, v2 and dual shapes all still parse", () => {
    const payload = { ticket: "CTL-9" };
    for (const evt of [
      { event: "linear.comment.created", detail: payload },
      { attributes: { "event.name": "linear.comment.created" }, body: { payload } },
      {
        event: "linear.comment.created",
        attributes: { "event.name": "linear.comment.created" },
        body: { payload },
      },
    ]) {
      expect(parseCommentCreatedEvent(evt)).not.toBeNull();
    }
  });

  test("regression: a non-matching name is still rejected", () => {
    expect(parseCommentCreatedEvent({ name: "linear.issue.updated" })).toBeNull();
    expect(parseStateChangedEvent({ event: "github.pr.merged" })).toBeNull();
    expect(parseStateChangedEvent({})).toBeNull();
  });
});

// ─── execution-core/event-scan.mjs (1 folded site, budget-critical) ─────────
//
// This is the revive/remediate/complete index. It read the v2 key ONLY, so a
// v1-shaped revive event did NOT consume the per-ticket MAX_REVIVES budget — an
// unbounded revive loop — and a v1-shaped `phase.*.complete.*` was invisible to
// hasCompleteEvent (CTL-778).
describe("event-scan.mjs indexes v1 and v3 shapes too (CTL-1834)", () => {
  let dir;
  let logPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctl1834-scan-"));
    logPath = join(dir, "2026-08.jsonl");
    writeFileSync(logPath, "");
    __resetEventScanIndexForTest();
  });
  afterEach(() => {
    __resetEventScanIndexForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  const append = (obj) => appendFileSync(logPath, JSON.stringify(obj) + "\n");

  test("a v1-shaped revive consumes the revive budget", () => {
    append({ ts: "2026-08-12T00:00:00.000Z", event: "phase.implement.revive.CTL-9" });
    append({ ts: "2026-08-12T00:00:01.000Z", event: "phase.implement.revive.CTL-9" });
    expect(countReviveEvents({ ticket: "CTL-9", path: logPath })).toBe(2);
  });

  test("a v3-shaped revive consumes the revive budget", () => {
    append({ ts: "2026-08-12T00:00:00.000Z", name: "phase.verify.revive.CTL-9" });
    expect(countReviveEvents({ ticket: "CTL-9", path: logPath })).toBe(1);
  });

  test("positive control: a v2-shaped revive still counts", () => {
    append({
      ts: "2026-08-12T00:00:00.000Z",
      attributes: { "event.name": "phase.implement.revive.CTL-9" },
    });
    expect(countReviveEvents({ ticket: "CTL-9", path: logPath })).toBe(1);
  });

  test("mixed shapes of the SAME family all count (the biased-slice failure)", () => {
    // The real defect shape: not a visible zero, but a biased fraction that
    // looks like data. Pre-fix this returned 1 of 3.
    append({ ts: "2026-08-12T00:00:00.000Z", event: "phase.implement.revive.CTL-9" });
    append({
      ts: "2026-08-12T00:00:01.000Z",
      attributes: { "event.name": "phase.implement.revive.CTL-9" },
    });
    append({ ts: "2026-08-12T00:00:02.000Z", name: "phase.implement.revive.CTL-9" });
    expect(countReviveEvents({ ticket: "CTL-9", path: logPath })).toBe(3);
  });

  test("hasCompleteEvent (CTL-778) sees a v1-shaped complete", () => {
    append({ ts: "2026-08-12T00:00:00.000Z", event: "phase.implement.complete.CTL-9" });
    expect(hasCompleteEvent({ ticket: "CTL-9", phase: "implement", path: logPath })).toBe(true);
  });

  test("hasCompleteEvent still says false for a ticket with no complete", () => {
    append({ ts: "2026-08-12T00:00:00.000Z", event: "phase.implement.complete.CTL-9" });
    expect(hasCompleteEvent({ ticket: "CTL-10", phase: "implement", path: logPath })).toBe(false);
  });

  test("an unnamed line is skipped rather than counted or thrown on", () => {
    append({ ts: "2026-08-12T00:00:00.000Z", level: 30, msg: "a pino line" });
    append({ ts: "2026-08-12T00:00:01.000Z", event: "phase.implement.revive.CTL-9" });
    expect(countReviveEvents({ ticket: "CTL-9", path: logPath })).toBe(1);
  });
});
