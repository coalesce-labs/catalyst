import { test, expect } from "bun:test";
import { appendTriageCapEvent } from "./triage-cap-event.mjs";

test("emits the canonical triage cap event", () => {
  const lines = [];
  expect(appendTriageCapEvent({ ticket: "CAT-83", count: 3, cap: 3, append: (line) => lines.push(line) })).toBe(true);
  const event = JSON.parse(lines[0]);
  expect(event.attributes["event.name"]).toBe("triage.redispatch.capped.CAT-83");
  expect(event.body.payload).toMatchObject({ count: 3, cap: 3 });
});
