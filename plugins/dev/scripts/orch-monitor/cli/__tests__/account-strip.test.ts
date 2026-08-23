import { test, expect } from "bun:test";
import { accountStripText, accountOverlayLines } from "../components/account-strip";

test("strip shows active handle + binding pct, quiet color when ok", () => {
  const s = accountStripText({
    status: "ok",
    active: { label: "acctA", bindingWindow: "five_hour", fiveHour: { pct: 12 } },
  });
  expect(s.text).toContain("acctA");
  expect(s.text).toContain("12%");
  expect(s.inverse).toBe(false);
});
test("strip goes inverse (loud) when active binding rejected", () => {
  const s = accountStripText({
    status: "rejected",
    active: { label: "acctA", bindingWindow: "seven_day", sevenDay: { pct: 100 } },
  });
  expect(s.inverse).toBe(true);
});
test("overlay lines name reset + sibling when rejected; empty when ok", () => {
  expect(accountOverlayLines({ status: "ok" })).toEqual([]);
  const lines = accountOverlayLines({
    status: "rejected",
    active: {
      label: "acctA",
      sevenDay: { resetsAt: "2026-08-06T00:00:00.000Z" },
      bindingWindow: "seven_day",
    },
    siblingWithHeadroom: { label: "acctB" },
  });
  expect(lines.join(" ")).toContain("acctB");
  expect(lines.join(" ")).toContain("2026-08-06");
});
