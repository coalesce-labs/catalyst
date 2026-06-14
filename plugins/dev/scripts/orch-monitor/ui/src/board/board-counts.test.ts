import { describe, expect, it } from "bun:test";
import { formatIssueCount } from "./board-counts";

describe("formatIssueCount", () => {
  it("groups thousands and pluralizes", () => {
    expect(formatIssueCount(2433)).toBe("2,433 issues");
    expect(formatIssueCount(1)).toBe("1 issue");
    expect(formatIssueCount(0)).toBe("0 issues");
  });
});
