import { describe, it, expect, mock } from "bun:test";
import { buildSettingsActions } from "./settings-actions";
import { visibleActions } from "./action-registry";

function handlers() {
  return {
    toggleTheme: mock(() => {}),
    toggleSidebar: mock(() => {}),
    setGroupBy: mock((_g: "linear" | "phase") => {}),
    setOrder: mock((_o: "priority" | "recent" | "live") => {}),
    setLayout: mock((_l: "board" | "list") => {}),
  };
}

describe("buildSettingsActions", () => {
  it("includes theme + sidebar as global-scoped", () => {
    const actions = buildSettingsActions(handlers());
    const theme = actions.find((a) => a.id === "settings.theme.toggle");
    const nav = actions.find((a) => a.id === "settings.sidebar.toggle");
    expect(theme?.scope).toBe("global");
    expect(nav?.scope).toBe("global");
  });

  it("theme command fires toggleTheme", () => {
    const h = handlers();
    buildSettingsActions(h).find((a) => a.id === "settings.theme.toggle")!.handler();
    expect(h.toggleTheme).toHaveBeenCalledTimes(1);
  });

  it("board-display commands are board-scoped and hidden off-board", () => {
    const actions = buildSettingsActions(handlers());
    const offBoard = visibleActions(actions, { surface: "workers" });
    expect(offBoard.some((a) => a.id.startsWith("board.groupBy"))).toBe(false);
    const onBoard = visibleActions(actions, { surface: "board" });
    expect(onBoard.some((a) => a.id.startsWith("board.groupBy"))).toBe(true);
  });

  it("a board-display command fires its prefs setter with the right value", () => {
    const h = handlers();
    buildSettingsActions(h).find((a) => a.id === "board.layout.list")!.handler();
    expect(h.setLayout).toHaveBeenCalledWith("list");
  });
});
