// header-chips.test.ts — tests for the Header chip-row layout helper (CTL-434).
// Run from plugins/dev/scripts/orch-monitor: bun test cli/components/header-chips.test.ts

import { describe, test, expect } from "bun:test";
import { layoutHeaderChips } from "./header-chips.ts";
import type { HeaderChipInput } from "./header-chips.ts";

const base: HeaderChipInput = {
  columns: 200,
  groqStatus: "ok",
  groqPresent: true,
  groqPrefix: "gsk_abc",
  groqSource: "env",
  interestStatus: "ok",
  interestCount: 5,
  versionDisplay: "v9.2.0 · local:523b6fe",
  versionIsLocal: true,
};

function texts(segments: { text: string }[]): string[] {
  return segments.map((s) => s.text);
}

describe("layoutHeaderChips — empty cases", () => {
  test("nothing visible → empty segments", () => {
    const result = layoutHeaderChips({
      columns: 120,
      groqStatus: null,
      groqPresent: false,
      groqPrefix: null,
      groqSource: null,
      interestStatus: "unknown",
      interestCount: null,
      versionDisplay: null,
      versionIsLocal: false,
    });
    expect(result.segments).toEqual([]);
    expect(result.width).toBe(0);
  });

  test("only groq present", () => {
    const result = layoutHeaderChips({
      ...base,
      groqPresent: false,
      groqPrefix: null,
      groqSource: null,
      interestStatus: "unknown",
      interestCount: null,
      versionDisplay: null,
    });
    expect(texts(result.segments)).toEqual(["[Groq: OK]"]);
  });

  test("only broker present", () => {
    const result = layoutHeaderChips({
      ...base,
      groqStatus: null,
      groqPresent: false,
      groqPrefix: null,
      groqSource: null,
      versionDisplay: null,
    });
    expect(texts(result.segments)).toEqual(["[broker: 5 interests]"]);
  });

  test("only version present", () => {
    const result = layoutHeaderChips({
      ...base,
      groqStatus: null,
      groqPresent: false,
      groqPrefix: null,
      groqSource: null,
      interestStatus: "unknown",
      interestCount: null,
    });
    expect(texts(result.segments)).toEqual(["[v9.2.0 · local:523b6fe]"]);
  });
});

describe("layoutHeaderChips — wide width (L0 — full fidelity)", () => {
  test("all chips + decoration at 200 cols", () => {
    const result = layoutHeaderChips({ ...base, columns: 200 });
    expect(texts(result.segments)).toEqual([
      "[Groq: OK]",
      "  gsk_abc... (env)",
      "  [broker: 5 interests]",
      "  [v9.2.0 · local:523b6fe]",
    ]);
  });

  test("decoration omitted when groqPrefix is null even at wide widths", () => {
    const result = layoutHeaderChips({ ...base, columns: 200, groqPrefix: null });
    expect(texts(result.segments)).toEqual([
      "[Groq: OK]",
      "  [broker: 5 interests]",
      "  [v9.2.0 · local:523b6fe]",
    ]);
  });

  test("decoration omitted when groqPresent is false", () => {
    const result = layoutHeaderChips({ ...base, columns: 200, groqPresent: false });
    expect(texts(result.segments)).toEqual([
      "[Groq: OK]",
      "  [broker: 5 interests]",
      "  [v9.2.0 · local:523b6fe]",
    ]);
  });

  test("unknown source falls back to 'unknown' in decoration", () => {
    const result = layoutHeaderChips({ ...base, columns: 200, groqSource: null });
    expect(result.segments[1]?.text).toBe("  gsk_abc... (unknown)");
  });
});

describe("layoutHeaderChips — progressive abbreviation", () => {
  // Full-fidelity width at base: 10 + 18 + 23 + 26 = 77 chars
  // L1 (no deco):                  10 + 23 + 26 = 59 chars
  // L2 (short broker):             10 + 18 + 26 = 54 chars  (broker becomes "[broker: 5 ints]")
  // L3 (med version):              10 + 18 + 20 = 48 chars  ("[v9.2.0 · 523b6fe]")
  // L4 (min version):              10 + 18 + 10 = 38 chars  ("[v9.2.0]")

  test("L1 — drops groq decoration when row would overflow", () => {
    // 75 cols: full = 77 overflows by 2; dropping deco → 59 fits
    const result = layoutHeaderChips({ ...base, columns: 75 });
    expect(texts(result.segments)).toEqual([
      "[Groq: OK]",
      "  [broker: 5 interests]",
      "  [v9.2.0 · local:523b6fe]",
    ]);
    expect(result.width).toBe(59);
  });

  test("L2 — shortens broker label", () => {
    // 55 cols: L1 = 59 overflows; L2 = 54 fits
    const result = layoutHeaderChips({ ...base, columns: 55 });
    expect(texts(result.segments)).toEqual([
      "[Groq: OK]",
      "  [broker: 5 ints]",
      "  [v9.2.0 · local:523b6fe]",
    ]);
    expect(result.width).toBe(54);
  });

  test("L3 — drops 'local:' prefix from version", () => {
    // 50 cols: L2 = 54 overflows; L3 = 47 fits
    const result = layoutHeaderChips({ ...base, columns: 50 });
    expect(texts(result.segments)).toEqual([
      "[Groq: OK]",
      "  [broker: 5 ints]",
      "  [v9.2.0 · 523b6fe]",
    ]);
    expect(result.width).toBe(48);
  });

  test("L4 — drops SHA portion entirely", () => {
    // 40 cols: L3 = 47 overflows; L4 = 38 fits
    const result = layoutHeaderChips({ ...base, columns: 40 });
    expect(texts(result.segments)).toEqual([
      "[Groq: OK]",
      "  [broker: 5 ints]",
      "  [v9.2.0]",
    ]);
    expect(result.width).toBe(38);
  });

  test("extreme widths still keep all three core chips", () => {
    // 30 cols: even L4 (38) overflows; we accept the overflow rather than dropping chips
    const result = layoutHeaderChips({ ...base, columns: 30 });
    expect(texts(result.segments)).toEqual([
      "[Groq: OK]",
      "  [broker: 5 ints]",
      "  [v9.2.0]",
    ]);
  });

  test("release version (no 'local:' prefix) collapses to L4 directly", () => {
    // versionDisplay starts as "v9.2.0 · abc1234" (release), no "local:" to drop.
    // L2 width = 10 + 18 + 18 = 46. L4 (min) = 10 + 18 + 10 = 38.
    const result = layoutHeaderChips({
      ...base,
      versionDisplay: "v9.2.0 · abc1234",
      versionIsLocal: false,
      columns: 40,
    });
    expect(texts(result.segments)).toEqual([
      "[Groq: OK]",
      "  [broker: 5 ints]",
      "  [v9.2.0]",
    ]);
  });

  test("version with no separator (already minimal) is left as-is", () => {
    const result = layoutHeaderChips({
      ...base,
      versionDisplay: "v9.2.0",
      versionIsLocal: false,
      columns: 30,
    });
    expect(texts(result.segments)).toEqual([
      "[Groq: OK]",
      "  [broker: 5 ints]",
      "  [v9.2.0]",
    ]);
  });
});

describe("layoutHeaderChips — short broker label by status", () => {
  test("startup short label includes 'start' suffix", () => {
    const result = layoutHeaderChips({
      ...base,
      interestStatus: "startup",
      interestCount: 0,
      columns: 50, // force short broker
    });
    const brokerSeg = result.segments.find((s) => s.text.includes("broker"));
    expect(brokerSeg?.text).toBe("  [broker: 0 start]");
  });

  test("degraded short label uses 'ints' suffix and inverse flag", () => {
    const result = layoutHeaderChips({
      ...base,
      interestStatus: "degraded",
      interestCount: 0,
      columns: 50, // force short broker
    });
    const brokerSeg = result.segments.find((s) => s.text.includes("broker"));
    expect(brokerSeg?.text).toBe("  [broker: 0 ints]");
    expect(brokerSeg?.inverse).toBe(true);
  });
});

describe("layoutHeaderChips — colors and flags", () => {
  test("groq chip color reflects probe status", () => {
    const result = layoutHeaderChips({ ...base, groqStatus: "missing" });
    expect(result.segments[0]?.color).toBe("yellow");
  });

  test("decoration segment is marked dim", () => {
    const result = layoutHeaderChips({ ...base });
    const deco = result.segments[1];
    expect(deco?.dim).toBe(true);
  });

  test("version is yellow when isLocal, gray otherwise", () => {
    const local = layoutHeaderChips({ ...base, versionIsLocal: true });
    const versionSeg = local.segments.find((s) => s.text.includes("v9.2.0"));
    expect(versionSeg?.color).toBe("yellow");

    const release = layoutHeaderChips({
      ...base,
      versionDisplay: "v9.2.0",
      versionIsLocal: false,
    });
    const releaseSeg = release.segments.find((s) => s.text.includes("v9.2.0"));
    expect(releaseSeg?.color).toBe("gray");
  });

  test("singular vs plural broker label at full fidelity", () => {
    const one = layoutHeaderChips({ ...base, interestCount: 1 });
    const oneSeg = one.segments.find((s) => s.text.includes("broker"));
    expect(oneSeg?.text).toBe("  [broker: 1 interest]");
  });
});
