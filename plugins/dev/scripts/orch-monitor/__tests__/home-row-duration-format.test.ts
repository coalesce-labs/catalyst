// home-row-duration-format.test.ts — CTL-901 (HOME3): the QUIET single-unit
// relative-duration formatter the calm inbox rows render. Unlike the dense
// board's fmtDuration ("2h 5m"), the inbox shows ONE coarse unit ("2h", "4m") so
// a needs-you row reads as a glance, not a stopwatch — and a null/negative input
// (no honest backing timestamp) yields null so the caller OMITS the cell rather
// than fabricating a "0s". This file pins both the format and the honest-absence
// contract directly against the React-free formatter module.
import { describe, it, expect } from "bun:test";
import { fmtRelativeDuration } from "../ui/src/lib/formatters";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("fmtRelativeDuration — quiet single coarsest unit (CTL-901)", () => {
  it("sub-minute → seconds", () => {
    expect(fmtRelativeDuration(0)).toBe("0s");
    expect(fmtRelativeDuration(30 * SEC)).toBe("30s");
    expect(fmtRelativeDuration(59 * SEC)).toBe("59s");
  });

  it("sub-hour → minutes only (no '4m 0s')", () => {
    expect(fmtRelativeDuration(60 * SEC)).toBe("1m");
    expect(fmtRelativeDuration(4 * MIN)).toBe("4m"); // the implement-phase 4m case
    expect(fmtRelativeDuration(4 * MIN + 30 * SEC)).toBe("4m"); // truncates, one unit
    expect(fmtRelativeDuration(59 * MIN)).toBe("59m");
  });

  it("sub-day → hours only (the Gherkin '2h' example)", () => {
    expect(fmtRelativeDuration(2 * HOUR)).toBe("2h"); // "a quiet relative duration like '2h'"
    expect(fmtRelativeDuration(2 * HOUR + 45 * MIN)).toBe("2h");
    expect(fmtRelativeDuration(23 * HOUR)).toBe("23h");
  });

  it("≥ a day → days", () => {
    expect(fmtRelativeDuration(DAY)).toBe("1d");
    expect(fmtRelativeDuration(3 * DAY + 5 * HOUR)).toBe("3d");
  });
});

describe("fmtRelativeDuration — honest about absence (never fabricates) (CTL-901)", () => {
  it("null input → null (caller omits the cell, no fabricated time)", () => {
    expect(fmtRelativeDuration(null)).toBeNull();
  });

  it("a negative duration (clock skew) → null, never a '-3m'", () => {
    expect(fmtRelativeDuration(-1)).toBeNull();
    expect(fmtRelativeDuration(-5 * MIN)).toBeNull();
  });

  it("a non-finite duration → null", () => {
    expect(fmtRelativeDuration(Number.NaN)).toBeNull();
    expect(fmtRelativeDuration(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
