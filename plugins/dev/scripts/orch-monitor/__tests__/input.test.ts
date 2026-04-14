import { describe, it, expect } from "bun:test";
import { handleKeypress, type InputCallbacks } from "../lib/input";

function makeCallbacks(): InputCallbacks & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    quit: [],
    refresh: [],
    focus: [],
    scrollUp: [],
    scrollDown: [],
  };
  return {
    calls,
    onQuit: () => calls.quit.push(true),
    onRefresh: () => calls.refresh.push(true),
    onFocus: (n: number) => calls.focus.push(n),
    onScrollUp: () => calls.scrollUp.push(true),
    onScrollDown: () => calls.scrollDown.push(true),
  };
}

describe("handleKeypress", () => {
  it("calls onQuit for 'q'", () => {
    const cb = makeCallbacks();
    handleKeypress(Buffer.from("q"), cb);
    expect(cb.calls.quit).toHaveLength(1);
  });

  it("calls onQuit for ctrl-c (0x03)", () => {
    const cb = makeCallbacks();
    handleKeypress(Buffer.from([0x03]), cb);
    expect(cb.calls.quit).toHaveLength(1);
  });

  it("calls onRefresh for 'r'", () => {
    const cb = makeCallbacks();
    handleKeypress(Buffer.from("r"), cb);
    expect(cb.calls.refresh).toHaveLength(1);
  });

  it("calls onFocus with digit for 0-9", () => {
    const cb = makeCallbacks();
    for (let i = 0; i <= 9; i++) {
      handleKeypress(Buffer.from(String(i)), cb);
    }
    expect(cb.calls.focus).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("calls onScrollUp for arrow up", () => {
    const cb = makeCallbacks();
    handleKeypress(Buffer.from([0x1b, 0x5b, 0x41]), cb);
    expect(cb.calls.scrollUp).toHaveLength(1);
  });

  it("calls onScrollDown for arrow down", () => {
    const cb = makeCallbacks();
    handleKeypress(Buffer.from([0x1b, 0x5b, 0x42]), cb);
    expect(cb.calls.scrollDown).toHaveLength(1);
  });

  it("does nothing for unknown keys", () => {
    const cb = makeCallbacks();
    handleKeypress(Buffer.from("z"), cb);
    expect(cb.calls.quit).toHaveLength(0);
    expect(cb.calls.refresh).toHaveLength(0);
    expect(cb.calls.focus).toHaveLength(0);
    expect(cb.calls.scrollUp).toHaveLength(0);
    expect(cb.calls.scrollDown).toHaveLength(0);
  });
});
