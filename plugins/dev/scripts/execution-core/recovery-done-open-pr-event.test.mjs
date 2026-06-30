import { test, expect } from "bun:test";
import {
  buildRecoveryDoneOpenPrEvent,
  appendRecoveryDoneOpenPrEvent,
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
