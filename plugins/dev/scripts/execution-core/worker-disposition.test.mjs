// worker-disposition.test.mjs — CTL-764 Phase 3: precedence resolver + label-set helper.
// Run: cd plugins/dev/scripts/execution-core && bun test worker-disposition.test.mjs
import { describe, test, expect } from "bun:test";
import {
  resolveDisposition,
  desiredLabelSet,
  DISP_NEEDS_HUMAN,
  DISP_NEEDS_INPUT,
  DISP_BLOCKED,
  DISP_QUEUED,
  DISPOSITIONS,
} from "./worker-disposition.mjs";

describe("DISPOSITIONS constant", () => {
  test("descending precedence order: needs-human, needs-input, blocked, queued", () => {
    expect(DISPOSITIONS).toEqual([DISP_NEEDS_HUMAN, DISP_NEEDS_INPUT, DISP_BLOCKED, DISP_QUEUED]);
  });

  test("constants have expected string values", () => {
    expect(DISP_NEEDS_HUMAN).toBe("needs-human");
    expect(DISP_NEEDS_INPUT).toBe("needs-input");
    expect(DISP_BLOCKED).toBe("blocked");
    expect(DISP_QUEUED).toBe("queued");
  });
});

describe("resolveDisposition", () => {
  test("no args → null (healthy)", () => {
    expect(resolveDisposition()).toBeNull();
  });

  test("all false → null (healthy)", () => {
    expect(
      resolveDisposition({ needsHuman: false, needsInput: false, blocked: false, queued: false })
    ).toBeNull();
  });

  test("queued alone → queued", () => {
    expect(resolveDisposition({ queued: true })).toBe(DISP_QUEUED);
  });

  test("blocked alone → blocked", () => {
    expect(resolveDisposition({ blocked: true })).toBe(DISP_BLOCKED);
  });

  test("needs-input alone → needs-input", () => {
    expect(resolveDisposition({ needsInput: true })).toBe(DISP_NEEDS_INPUT);
  });

  test("needs-human alone → needs-human", () => {
    expect(resolveDisposition({ needsHuman: true })).toBe(DISP_NEEDS_HUMAN);
  });

  test("blocked beats queued", () => {
    expect(resolveDisposition({ blocked: true, queued: true })).toBe(DISP_BLOCKED);
  });

  test("needs-input beats blocked + queued", () => {
    expect(resolveDisposition({ needsInput: true, blocked: true, queued: true })).toBe(
      DISP_NEEDS_INPUT
    );
  });

  test("needs-human dominates needs-input + blocked + queued", () => {
    expect(
      resolveDisposition({ needsHuman: true, needsInput: true, blocked: true, queued: true })
    ).toBe(DISP_NEEDS_HUMAN);
  });

  test("needs-human dominates every combination (exhaustive 16-row truth table)", () => {
    // 2^4 = 16 combinations. Assert the full precedence ladder:
    // needs-human > needs-input > blocked > queued > null
    for (let bits = 0; bits < 16; bits++) {
      const needsHuman = !!(bits & 0b1000);
      const needsInput = !!(bits & 0b0100);
      const blocked = !!(bits & 0b0010);
      const queued = !!(bits & 0b0001);
      const result = resolveDisposition({ needsHuman, needsInput, blocked, queued });
      let expected;
      if (needsHuman) expected = DISP_NEEDS_HUMAN;
      else if (needsInput) expected = DISP_NEEDS_INPUT;
      else if (blocked) expected = DISP_BLOCKED;
      else if (queued) expected = DISP_QUEUED;
      else expected = null;
      expect(result).toBe(
        expected,
        `bits=${bits.toString(2).padStart(4, "0")} (nh=${needsHuman},ni=${needsInput},b=${blocked},q=${queued})`
      );
    }
  });
});

describe("desiredLabelSet", () => {
  test("null → empty Set", () => {
    const s = desiredLabelSet(null);
    expect(s instanceof Set).toBe(true);
    expect(s.size).toBe(0);
  });

  test("undefined → empty Set", () => {
    const s = desiredLabelSet(undefined);
    expect(s instanceof Set).toBe(true);
    expect(s.size).toBe(0);
  });

  test("'queued' → Set{ 'queued' }", () => {
    const s = desiredLabelSet("queued");
    expect(s instanceof Set).toBe(true);
    expect(s.size).toBe(1);
    expect(s.has("queued")).toBe(true);
  });

  test("'needs-human' → Set{ 'needs-human' }", () => {
    const s = desiredLabelSet("needs-human");
    expect(s.size).toBe(1);
    expect(s.has("needs-human")).toBe(true);
  });

  test("'needs-input' → Set{ 'needs-input' }", () => {
    const s = desiredLabelSet("needs-input");
    expect(s.has("needs-input")).toBe(true);
  });

  test("'blocked' → Set{ 'blocked' }", () => {
    const s = desiredLabelSet("blocked");
    expect(s.has("blocked")).toBe(true);
  });
});
