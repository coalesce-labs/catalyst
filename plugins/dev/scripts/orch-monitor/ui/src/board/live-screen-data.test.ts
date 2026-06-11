// CTL-938: PURE logic tests for the worker "Live screen" pane — the
// pre-transcript wedge window. The pane consumes the change-driven
// /api/ec-worker-screen/<shortId> SSE (full screen payload per frame); this
// module derives everything the skin shows: the shortId from the worker's
// bg_job_id, the parsed frame, the "last change Xs ago" age, and the
// 10-consecutive-unchanged-polls wedge label (ticket Scenario 2).
import { describe, it, expect } from "bun:test";
import {
  shortIdFromBgJobId,
  parseScreenFrame,
  applyScreenFrame,
  deriveScreenStatus,
  deriveScreenPaneMode,
  fmtScreenAge,
  SCREEN_WEDGE_AFTER_MS,
  type ScreenViewState,
} from "./live-screen-data";

const EMPTY: ScreenViewState = { screen: null, lastChangeAt: null };

describe("shortIdFromBgJobId", () => {
  it("derives the 8-char short id from a full bg_job_id UUID", () => {
    expect(shortIdFromBgJobId("abcd1234-9d9c-4ef2-aaaa-bbbbccccdddd")).toBe("abcd1234");
  });
  it("passes an already-short id through", () => {
    expect(shortIdFromBgJobId("abcd1234")).toBe("abcd1234");
  });
  it("returns null for absent/malformed ids (never throws)", () => {
    expect(shortIdFromBgJobId(null)).toBeNull();
    expect(shortIdFromBgJobId(undefined)).toBeNull();
    expect(shortIdFromBgJobId("")).toBeNull();
    expect(shortIdFromBgJobId("nope")).toBeNull();
  });
});

describe("parseScreenFrame", () => {
  it("parses a valid frame payload", () => {
    expect(parseScreenFrame('{"screen":"> idle","ts":123}')).toEqual({
      screen: "> idle",
      ts: 123,
    });
  });
  it("rejects malformed JSON / off-shape payloads with null", () => {
    expect(parseScreenFrame("not json")).toBeNull();
    expect(parseScreenFrame('{"ts":1}')).toBeNull();
    expect(parseScreenFrame('{"screen":42,"ts":1}')).toBeNull();
    expect(parseScreenFrame('{"screen":"x","ts":"y"}')).toBeNull();
  });
});

describe("applyScreenFrame", () => {
  it("a first frame sets the screen and stamps lastChangeAt at receipt time", () => {
    const next = applyScreenFrame(EMPTY, { screen: "A", ts: 1 }, 1000);
    expect(next).toEqual({ screen: "A", lastChangeAt: 1000 });
  });
  it("a changed frame replaces the screen and advances lastChangeAt", () => {
    const s1 = applyScreenFrame(EMPTY, { screen: "A", ts: 1 }, 1000);
    const s2 = applyScreenFrame(s1, { screen: "B", ts: 2 }, 4000);
    expect(s2).toEqual({ screen: "B", lastChangeAt: 4000 });
  });
  it("an identical frame keeps lastChangeAt (defensive — the server is change-driven)", () => {
    const s1 = applyScreenFrame(EMPTY, { screen: "A", ts: 1 }, 1000);
    const s2 = applyScreenFrame(s1, { screen: "A", ts: 2 }, 4000);
    expect(s2).toBe(s1); // same reference: no re-render for a no-op frame
  });
});

describe("deriveScreenStatus — last-change age + the frozen-screen wedge signal", () => {
  it("no frame yet → null age, not wedged", () => {
    expect(deriveScreenStatus(null, 5000)).toEqual({ ageMs: null, wedged: false });
  });
  it("a fresh change is not wedged", () => {
    expect(deriveScreenStatus(1000, 3000)).toEqual({ ageMs: 2000, wedged: false });
  });
  it("unchanged across 10 polls (~20s at the 2s cadence) → wedged", () => {
    const at = 1000;
    expect(deriveScreenStatus(at, at + SCREEN_WEDGE_AFTER_MS - 1).wedged).toBe(false);
    expect(deriveScreenStatus(at, at + SCREEN_WEDGE_AFTER_MS).wedged).toBe(true);
  });
  it("a negative clock skew clamps to 0", () => {
    expect(deriveScreenStatus(5000, 4000)).toEqual({ ageMs: 0, wedged: false });
  });
});

describe("deriveScreenPaneMode — the transcript hand-off (ticket Scenario 3)", () => {
  it("no derivable shortId → no-id (the pane dims honestly, no stream attempt)", () => {
    expect(deriveScreenPaneMode(null, false)).toBe("no-id");
    // no-id wins even once the transcript is live — there was never a screen source
    expect(deriveScreenPaneMode(null, true)).toBe("no-id");
  });
  it("shortId present, no transcript yet → screen (the pre-transcript wedge window)", () => {
    expect(deriveScreenPaneMode("abcd1234", false)).toBe("screen");
  });
  it("transcript rows flowing → handed-off (the richer live-tail takes over)", () => {
    expect(deriveScreenPaneMode("abcd1234", true)).toBe("handed-off");
  });
});

describe("fmtScreenAge", () => {
  it("formats seconds and minutes", () => {
    expect(fmtScreenAge(0)).toBe("0s");
    expect(fmtScreenAge(12_300)).toBe("12s");
    expect(fmtScreenAge(75_000)).toBe("1m 15s");
    expect(fmtScreenAge(3_660_000)).toBe("61m 0s");
  });
});
