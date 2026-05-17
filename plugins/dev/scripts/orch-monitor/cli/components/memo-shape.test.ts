// memo-shape.test.ts — asserts each high-traffic component is wrapped in React.memo.
// We can't drive Ink in bun:test, but we can assert structurally that the exported
// symbol is a MemoExoticComponent: $$typeof === Symbol.for("react.memo").
// This prevents the wrap from being accidentally removed in a future refactor.

import { describe, test, expect } from "bun:test";
import { Header } from "./Header.tsx";
import { EventList } from "./EventList.tsx";
import { EventRow } from "./EventRow.tsx";
import { DetailPane } from "./DetailPane.tsx";
import { PromptInput } from "./PromptInput.tsx";

const REACT_MEMO_TYPE = Symbol.for("react.memo");

function isMemo(c: unknown): boolean {
  return (
    typeof c === "object" &&
    c !== null &&
    (c as { $$typeof?: symbol }).$$typeof === REACT_MEMO_TYPE
  );
}

describe("React.memo wraps (CTL-473)", () => {
  test("Header is a React.memo component", () => {
    expect(isMemo(Header)).toBe(true);
  });
  test("EventList is a React.memo component", () => {
    expect(isMemo(EventList)).toBe(true);
  });
  test("EventRow is a React.memo component", () => {
    expect(isMemo(EventRow)).toBe(true);
  });
  test("DetailPane is a React.memo component", () => {
    expect(isMemo(DetailPane)).toBe(true);
  });
  test("PromptInput is a React.memo component", () => {
    expect(isMemo(PromptInput)).toBe(true);
  });
});
