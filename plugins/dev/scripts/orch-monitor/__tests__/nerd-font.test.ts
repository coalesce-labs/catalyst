import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  detectNerdFont,
  inProgressGlyph,
  NERD_FONT_IN_PROGRESS,
  FALLBACK_IN_PROGRESS,
  _resetNerdFontCacheForTesting,
} from "../cli/lib/nerd-font.ts";

describe("nerd-font (CTL-353)", () => {
  const prevEnv = process.env.CATALYST_NERD_FONT;

  beforeEach(() => {
    _resetNerdFontCacheForTesting();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CATALYST_NERD_FONT;
    else process.env.CATALYST_NERD_FONT = prevEnv;
    _resetNerdFontCacheForTesting();
  });

  test("CATALYST_NERD_FONT=1 forces detected=true (env source)", () => {
    process.env.CATALYST_NERD_FONT = "1";
    const d = detectNerdFont();
    expect(d.detected).toBe(true);
    expect(d.source).toBe("env");
    expect(inProgressGlyph()).toBe(NERD_FONT_IN_PROGRESS);
  });

  test("CATALYST_NERD_FONT=0 forces detected=false (env source)", () => {
    process.env.CATALYST_NERD_FONT = "0";
    const d = detectNerdFont();
    expect(d.detected).toBe(false);
    expect(d.source).toBe("env");
    expect(inProgressGlyph()).toBe(FALLBACK_IN_PROGRESS);
  });

  test("accepts true/false/yes/no/on/off as boolean overrides", () => {
    for (const val of ["true", "TRUE", "yes", "on"]) {
      _resetNerdFontCacheForTesting();
      process.env.CATALYST_NERD_FONT = val;
      expect(detectNerdFont().detected).toBe(true);
    }
    for (const val of ["false", "FALSE", "no", "off"]) {
      _resetNerdFontCacheForTesting();
      process.env.CATALYST_NERD_FONT = val;
      expect(detectNerdFont().detected).toBe(false);
    }
  });

  test("invalid env override falls through to system probe (not 'env' source)", () => {
    process.env.CATALYST_NERD_FONT = "maybe";
    const d = detectNerdFont();
    // We don't assert detected here — it depends on whether the test machine
    // actually has a Nerd Font installed. We just assert that "maybe" did NOT
    // route through the env path.
    expect(d.source).not.toBe("env");
  });

  test("detection result is cached across calls", () => {
    process.env.CATALYST_NERD_FONT = "1";
    const a = detectNerdFont();
    delete process.env.CATALYST_NERD_FONT;
    const b = detectNerdFont();
    // Without explicit reset, the second call returns the cached result —
    // even though the env var is now gone.
    expect(b).toEqual(a);
  });

  test("hint is always a non-empty string", () => {
    process.env.CATALYST_NERD_FONT = "1";
    expect(detectNerdFont().hint.length).toBeGreaterThan(0);
    _resetNerdFontCacheForTesting();
    process.env.CATALYST_NERD_FONT = "0";
    expect(detectNerdFont().hint.length).toBeGreaterThan(0);
  });

  test("NERD_FONT_IN_PROGRESS is the BMP nf-fa-hourglass_half glyph (U+F252)", () => {
    expect(NERD_FONT_IN_PROGRESS.codePointAt(0)).toBe(0xf252);
    expect(NERD_FONT_IN_PROGRESS.length).toBe(1);
  });

  test("FALLBACK_IN_PROGRESS is U+2026 horizontal ellipsis", () => {
    expect(FALLBACK_IN_PROGRESS.codePointAt(0)).toBe(0x2026);
    expect(FALLBACK_IN_PROGRESS.length).toBe(1);
  });
});
