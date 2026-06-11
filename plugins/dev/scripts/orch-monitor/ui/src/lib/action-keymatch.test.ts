import { describe, it, expect } from "bun:test";
import { parseKeybinding, matchAction } from "./action-keymatch";
import type { ActionEntry } from "./action-registry";

const noop = () => {};
const entries: ActionEntry[] = [
  { id: "nav.surface.board", title: "Go to Tickets", scope: "global", handler: noop, keybinding: "g b" },
  { id: "action.create", title: "Create", scope: "global", handler: noop, keybinding: "c" },
];

describe("parseKeybinding", () => {
  it("splits a chord into prefix + key", () => {
    expect(parseKeybinding("g b")).toEqual({ chord: "g", key: "b" });
  });
  it("treats a single token as a bare key", () => {
    expect(parseKeybinding("c")).toEqual({ chord: null, key: "c" });
  });
});

describe("matchAction", () => {
  const ctx = { surface: "home" as const };
  it("fires a bare single-key action when no chord is pending", () => {
    expect(matchAction(entries, ctx, { key: "c" }, false)?.id).toBe("action.create");
  });
  it("does NOT fire a single-key action while a chord is pending", () => {
    expect(matchAction(entries, ctx, { key: "c" }, true)).toBeNull();
  });
  it("fires a g-chord action only when the chord is pending", () => {
    expect(matchAction(entries, ctx, { key: "b" }, true)?.id).toBe("nav.surface.board");
    expect(matchAction(entries, ctx, { key: "b" }, false)).toBeNull();
  });
  it("ignores keystrokes with meta/ctrl/alt (those belong to other handlers)", () => {
    expect(matchAction(entries, ctx, { key: "c", metaKey: true }, false)).toBeNull();
  });
  it("returns null when no matching binding exists", () => {
    expect(matchAction(entries, ctx, { key: "x" }, false)).toBeNull();
  });
  it("respects scope via visibleActions (board action hidden on home)", () => {
    const boardOnly: ActionEntry[] = [
      { id: "x", title: "X", scope: "board", handler: noop, keybinding: "x" },
    ];
    expect(matchAction(boardOnly, { surface: "home" }, { key: "x" }, false)).toBeNull();
  });
  it("board-scope action fires on board surface", () => {
    const boardOnly: ActionEntry[] = [
      { id: "x", title: "X", scope: "board", handler: noop, keybinding: "x" },
    ];
    expect(matchAction(boardOnly, { surface: "board" }, { key: "x" }, false)?.id).toBe("x");
  });
});
