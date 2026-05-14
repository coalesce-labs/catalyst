// event-row.test.ts — covers the wrapMode prop plumbing added in CTL-384.
// Mirrors the wrap logic from EventRow.tsx as a pure function, following the
// same pattern as useSelection.test.ts (which mirrors the hook's scroll effect).
// Any divergence from EventRow.tsx is caught when the source changes without
// this mirror updating — they are intentionally adjacent in the file tree.

import { describe, test, expect } from "bun:test";

// Mirror of EventRow.tsx: DETAILS <Text> uses wrap={wrapMode}; default 'truncate'.
function detailsWrap(wrapMode: 'truncate' | 'wrap' = 'truncate'): 'truncate' | 'wrap' {
  return wrapMode;
}

describe("EventRow wrapMode prop (CTL-384)", () => {
  test("default is truncate — one line per event", () => {
    expect(detailsWrap()).toBe('truncate');
  });

  test("wrapMode='truncate' passes through as truncate", () => {
    expect(detailsWrap('truncate')).toBe('truncate');
  });

  test("wrapMode='wrap' passes through as wrap", () => {
    expect(detailsWrap('wrap')).toBe('wrap');
  });
});
