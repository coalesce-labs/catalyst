import { describe, it, expect } from "bun:test";
import {
  decodeAccountSignalFrame,
  isAccountSignal,
  isAccountUnavailable,
  accountFrameAction,
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

describe("isAccountUnavailable / accountFrameAction (CTL-1653 Codex stale-strip fix)", () => {
  it("recognizes the documented {available:false} unavailable contract", () => {
    expect(isAccountUnavailable({ available: false, node: "mini-2" })).toBe(true);
  });
  it("does not confuse a valid signal or garbage with the unavailable contract", () => {
    expect(isAccountUnavailable({ status: "ok" })).toBe(false);
    expect(isAccountUnavailable("not an object")).toBe(false);
    expect(isAccountUnavailable(null)).toBe(false);
    expect(isAccountUnavailable({ available: true })).toBe(false);
  });
  it("accountFrameAction: apply for a valid signal", () => {
    const action = accountFrameAction({ status: "rejected", active: { label: "acctA" } });
    expect(action.type).toBe("apply");
    expect(action.type === "apply" && action.signal.status).toBe("rejected");
  });
  it("accountFrameAction: clear for {available:false} — a REAL transition, not noise", () => {
    expect(accountFrameAction({ available: false, node: "mini-2" })).toEqual({ type: "clear" });
  });
  it("accountFrameAction: ignore for garbage/truncated input", () => {
    expect(accountFrameAction({ garbage: true })).toEqual({ type: "ignore" });
    expect(accountFrameAction(null)).toEqual({ type: "ignore" });
    expect(accountFrameAction("a string")).toEqual({ type: "ignore" });
  });
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
