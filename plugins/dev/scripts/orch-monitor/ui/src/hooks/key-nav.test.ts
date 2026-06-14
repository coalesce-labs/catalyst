import { describe, it, expect } from "bun:test";
import { classifyKey } from "./key-nav";

describe("classifyKey — unified input-focus guard (CTL-1025)", () => {
  it("swallows j/k while a contenteditable host is focused", () => {
    expect(classifyKey({ key: "j" }, { tagName: "DIV", isContentEditable: true }, false).type)
      .toBe("none");
    expect(classifyKey({ key: "k" }, { tagName: "DIV", isContentEditable: true }, false).type)
      .toBe("none");
  });

  it("swallows j/k while SELECT is focused (newly covered by unified guard)", () => {
    expect(classifyKey({ key: "j" }, { tagName: "SELECT" }, false).type).toBe("none");
  });

  it("still swallows in INPUT and TEXTAREA (regression)", () => {
    expect(classifyKey({ key: "j" }, { tagName: "INPUT" }, false).type).toBe("none");
    expect(classifyKey({ key: "j" }, { tagName: "TEXTAREA" }, false).type).toBe("none");
  });

  it("still lets ⌘K pierce the guard (kept)", () => {
    expect(classifyKey({ key: "k", metaKey: true }, { tagName: "INPUT" }, false).type)
      .toBe("palette");
  });

  it("still classifies j/k when no element is focused (undefined)", () => {
    expect(classifyKey({ key: "j" }, undefined, false).type).toBe("next");
    expect(classifyKey({ key: "k" }, undefined, false).type).toBe("prev");
  });

  it("still classifies j/k when a non-typing element is focused", () => {
    expect(classifyKey({ key: "j" }, { tagName: "BUTTON" }, false).type).toBe("next");
  });
});
