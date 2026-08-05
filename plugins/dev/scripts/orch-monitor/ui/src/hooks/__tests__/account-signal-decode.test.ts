import { describe, it, expect } from "bun:test";
import {
  decodeAccountSignalFrame,
  isAccountSignal,
  accountIndicatorLabel,
  bannerModel,
  type AccountSignal,
} from "../account-signal-lib";

describe("decodeAccountSignalFrame / isAccountSignal", () => {
  it("parses a valid frame", () => {
    const s = decodeAccountSignalFrame(
      JSON.stringify({
        node: "n",
        status: "ok",
        active: {
          label: "a",
          email: "a@x",
          bindingWindow: "five_hour",
          fiveHour: { pct: 12 },
          sevenDay: { pct: 20 },
        },
      }),
    );
    expect(isAccountSignal(s)).toBe(true);
    expect(s!.active!.label).toBe("a");
  });
  it("rejects malformed input → null", () =>
    expect(decodeAccountSignalFrame("not json")).toBeNull());
});

describe("accountIndicatorLabel (quiet while ok)", () => {
  it("shows active handle + binding-window pct", () => {
    const l = accountIndicatorLabel({
      status: "ok",
      active: { label: "acctA", bindingWindow: "five_hour", fiveHour: { pct: 12 } },
    } as AccountSignal);
    expect(l.text).toContain("acctA");
    expect(l.text).toContain("12%");
    expect(l.tone).toBe("quiet");
  });
  it("error status is muted/neutral, not loud", () =>
    expect(
      accountIndicatorLabel({
        status: "error",
        active: { error: "network error" },
      } as AccountSignal).tone,
    ).toBe("muted"));
});

describe("bannerModel (loud only when active binding rejected)", () => {
  it("null when ok", () => expect(bannerModel({ status: "ok" } as AccountSignal)).toBeNull());
  it("names reset + sibling when rejected", () => {
    const m = bannerModel({
      status: "rejected",
      active: {
        label: "acctA",
        bindingWindow: "seven_day",
        sevenDay: { resetsAt: "2026-08-06T00:00:00.000Z" },
      },
      siblingWithHeadroom: { label: "acctB", email: "b@x" },
    } as AccountSignal);
    expect(m!.resetsAt).toBe("2026-08-06T00:00:00.000Z");
    expect(m!.sibling).toEqual({ label: "acctB", email: "b@x" });
  });
  it("null on error (sensor broken, not exhausted)", () =>
    expect(bannerModel({ status: "error" } as AccountSignal)).toBeNull());
});
