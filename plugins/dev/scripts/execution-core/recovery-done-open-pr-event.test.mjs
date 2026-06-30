import { test, expect } from "bun:test";
import {
  buildRecoveryDoneOpenPrEvent,
  appendRecoveryDoneOpenPrEvent,
  buildRecoveryDoneAppliedEvent,
  appendRecoveryDoneAppliedEvent,
} from "./recovery-done-open-pr-event.mjs";

test("event shape: name, ticket=event.label, open_prs_count, pr_numbers, by (structured metadata)", () => {
  const line = buildRecoveryDoneOpenPrEvent({
    ticket: "CTL-9",
    by: "terminal-sweep",
    openPrs: [{ number: 101, state: "OPEN" }, { number: 42, state: "OPEN" }],
  });
  expect(line.endsWith("\n")).toBe(true);
  const env = JSON.parse(line);
  expect(env.severityText).toBe("WARN");
  const a = env.attributes;
  expect(a["event.name"]).toBe("recovery.done-applied-with-open-pr");
  expect(a["event.label"]).toBe("CTL-9");
  expect(a.ticket).toBe("CTL-9");
  expect(a.open_prs_count).toBe(2);
  expect(a.pr_numbers).toBe("#42,#101"); // sorted, deduped, joined
  expect(a.by).toBe("terminal-sweep");
});

test("accepts a raw number[] for openPrs and dedupes", () => {
  const env = JSON.parse(buildRecoveryDoneOpenPrEvent({ ticket: "CTL-9", openPrs: [7, 7, 3] }));
  expect(env.attributes.open_prs_count).toBe(2);
  expect(env.attributes.pr_numbers).toBe("#3,#7");
});

test("append: emits via the injected seam when ≥1 open PR", () => {
  const lines = [];
  const ok = appendRecoveryDoneOpenPrEvent({
    ticket: "CTL-9",
    by: "reconcile-drain",
    openPrs: [{ number: 5 }],
    append: (l) => lines.push(l),
  });
  expect(ok).toBe(true);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]).attributes.by).toBe("reconcile-drain");
});

test("append: a clean Done (0 open PRs) emits NOTHING and returns false", () => {
  const lines = [];
  const ok = appendRecoveryDoneOpenPrEvent({
    ticket: "CTL-9",
    openPrs: [],
    append: (l) => lines.push(l),
  });
  expect(ok).toBe(false);
  expect(lines).toEqual([]);
});

test("append: never throws (swallows an emitter error)", () => {
  expect(
    appendRecoveryDoneOpenPrEvent({
      ticket: "CTL-9",
      openPrs: [{ number: 1 }],
      append: () => {
        throw new Error("disk full");
      },
    })
  ).toBe(false);
});

// ── CTL-1157 SLICE 3 — the broad `recovery.done-applied` Done-moves event ──────

test("done-applied: a CLEAN delegate Done — name/action/label + underscored count+label dims, INFO", () => {
  const env = JSON.parse(
    buildRecoveryDoneAppliedEvent({
      ticket: "CTL-9",
      openPrsAtDone: 0,
      prsClosed: 2,
      prsKept: 1,
      recoveryMode: "enforce",
      by: "recovery-pass",
      host: "mini",
    })
  );
  const a = env.attributes;
  // final OTEL names (the match-check contract):
  expect(a["event.name"]).toBe("recovery.done-applied");
  expect(a["event.action"]).toBe("done-applied");
  expect(a["event.label"]).toBe("CTL-9"); // ticket=event_label
  expect(a.ticket).toBe("CTL-9");
  expect(a.open_prs_at_done).toBe(0); // [value]
  expect(a.prs_closed).toBe(2); // [value]
  expect(a.prs_kept).toBe(1); // [value]
  expect(a.recovery_mode).toBe("enforce"); // [label]
  expect(a.host_name).toBe("mini"); // [label]
  expect(a.by).toBe("recovery-pass"); // [label]
  // a clean Done (0 open) is INFO — no alarm.
  expect(env.severityText).toBe("INFO");
});

test("done-applied: the red-line — open_prs_at_done>0 flips the event to WARN", () => {
  const env = JSON.parse(
    buildRecoveryDoneAppliedEvent({ ticket: "CTL-9", openPrsAtDone: 2, by: "terminal-sweep" })
  );
  expect(env.attributes.open_prs_at_done).toBe(2);
  expect(env.severityText).toBe("WARN");
  expect(env.attributes.by).toBe("terminal-sweep");
  // defaults: a no-agent path carries 0/0 for closed/kept and enforce mode.
  expect(env.attributes.prs_closed).toBe(0);
  expect(env.attributes.prs_kept).toBe(0);
  expect(env.attributes.recovery_mode).toBe("enforce");
});

test("done-applied: SHADOW is would-apply telemetry (would-done-applied name, never WARN)", () => {
  const env = JSON.parse(
    buildRecoveryDoneAppliedEvent({ ticket: "CTL-9", openPrsAtDone: 3, recoveryMode: "shadow" })
  );
  expect(env.attributes["event.name"]).toBe("recovery.would-done-applied");
  expect(env.attributes["event.action"]).toBe("would-done-applied");
  expect(env.attributes.recovery_mode).toBe("shadow");
  // shadow never alarms even with open PRs — no actual Done was written.
  expect(env.severityText).toBe("INFO");
});

test("done-applied: counts are clamped to non-negative integers", () => {
  const a = JSON.parse(
    buildRecoveryDoneAppliedEvent({
      ticket: "CTL-9",
      openPrsAtDone: -4,
      prsClosed: 2.9,
      prsKept: "x",
    })
  ).attributes;
  expect(a.open_prs_at_done).toBe(0);
  expect(a.prs_closed).toBe(2);
  expect(a.prs_kept).toBe(0);
});

test("done-applied append: fires UNCONDITIONALLY (even on a clean 0-open Done) and never throws", () => {
  const lines = [];
  expect(
    appendRecoveryDoneAppliedEvent({
      ticket: "CTL-9",
      openPrsAtDone: 0,
      by: "reconcile-drain",
      append: (l) => lines.push(l),
    })
  ).toBe(true);
  expect(lines).toHaveLength(1); // unlike the alarm, a clean Done STILL emits a move
  expect(
    appendRecoveryDoneAppliedEvent({
      ticket: "CTL-9",
      append: () => {
        throw new Error("disk full");
      },
    })
  ).toBe(false);
});
