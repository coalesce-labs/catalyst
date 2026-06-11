import { describe, it, expect } from "bun:test";
import { visibleActions, type ActionEntry } from "./action-registry";

const noop = () => {};
const global1: ActionEntry = { id: "g1", title: "Toggle theme", scope: "global", handler: noop };
const boardOnly: ActionEntry = { id: "b1", title: "Group by status", scope: "board", handler: noop };

describe("visibleActions — context-aware scope filter", () => {
  it("global entries are always visible", () => {
    expect(visibleActions([global1], { surface: "workers" }).map((a) => a.id)).toEqual(["g1"]);
  });

  it("board-scoped entries are hidden off the board", () => {
    expect(visibleActions([global1, boardOnly], { surface: "workers" }).map((a) => a.id)).toEqual(["g1"]);
  });

  it("board-scoped entries appear on the board", () => {
    expect(visibleActions([global1, boardOnly], { surface: "board" }).map((a) => a.id)).toEqual(["g1", "b1"]);
  });

  it("preserves input order", () => {
    expect(visibleActions([boardOnly, global1], { surface: "board" }).map((a) => a.id)).toEqual(["b1", "g1"]);
  });

  it("empty registry yields no actions", () => {
    expect(visibleActions([], { surface: "board" })).toEqual([]);
  });
});
