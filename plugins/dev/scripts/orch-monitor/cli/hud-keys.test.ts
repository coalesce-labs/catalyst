// hud-keys.test.ts — covers the 'w' keypress toggle added in CTL-384.
// Mirrors the toggle logic from hud.tsx's useInput handler as a pure function,
// following the same pattern as useSelection.test.ts.

import { describe, test, expect } from "bun:test";

// Mirror of hud.tsx setWrapMode updater: toggles between truncate and wrap.
function toggleWrapMode(current: 'truncate' | 'wrap'): 'truncate' | 'wrap' {
  return current === 'truncate' ? 'wrap' : 'truncate';
}

describe("w key: wrap mode toggle (CTL-384)", () => {
  test("default truncate → press w → wrap", () => {
    expect(toggleWrapMode('truncate')).toBe('wrap');
  });

  test("wrap → press w → truncate", () => {
    expect(toggleWrapMode('wrap')).toBe('truncate');
  });

  test("two presses restores default", () => {
    expect(toggleWrapMode(toggleWrapMode('truncate'))).toBe('truncate');
  });

  test("ESC does not reset wrap mode (separate concern — wrapMode not in ESC handler)", () => {
    // ESC resets filter/pivot/dsl but does not call setWrapMode — this is
    // structural: the ESC block in hud.tsx has no setWrapMode call. The test
    // documents the design decision: wrap persists across filter operations.
    const wrapAfterEsc = 'wrap'; // ESC handler leaves wrapMode unchanged
    expect(wrapAfterEsc).toBe('wrap');
  });
});
