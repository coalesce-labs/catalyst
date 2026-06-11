import { describe, it, expect } from "bun:test";
import { isTypingTarget } from "./typing-target";

describe("isTypingTarget — single canonical input-focus guard", () => {
  it("matches INPUT, TEXTAREA, SELECT", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(isTypingTarget({ tagName })).toBe(true);
    }
  });
  it("matches a contenteditable host", () => {
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });
  it("ignores non-typing elements and null", () => {
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
  it("ignores undefined", () => {
    expect(isTypingTarget(undefined)).toBe(false);
  });
});
