import { describe, test, expect } from "bun:test";
import { computeColumnWidths } from "./column-widths.ts";

describe("computeColumnWidths — details field (CTL-395)", () => {
  test("details is present on returned object", () => {
    const w = computeColumnWidths(120);
    expect(typeof w.details).toBe("number");
  });

  test("details floors at 20 on very narrow terminals", () => {
    const w = computeColumnWidths(60);
    expect(w.details).toBe(20);
  });

  test("all columns + margins fit within the terminal width", () => {
    for (const cols of [80, 100, 120, 160, 180, 200, 250, 300]) {
      const w = computeColumnWidths(cols);
      const marginCount =
        4 + // time, repo, event, ref
        (w.showStatus ? 1 : 0) +
        (w.showOrch ? 1 : 0) +
        (w.showWorker ? 1 : 0) +
        (w.showEventId ? 1 : 0);
      const total =
        w.status + w.time + w.repo + w.event + w.ref +
        w.orch + w.worker + w.eventId + w.details + marginCount;
      expect(total).toBeLessThanOrEqual(cols);
    }
  });

  test("details shrinks when terminal narrows (and stays >= 20)", () => {
    const wide = computeColumnWidths(250);
    const narrow = computeColumnWidths(120);
    expect(wide.details).toBeGreaterThan(narrow.details);
    expect(narrow.details).toBeGreaterThanOrEqual(20);
  });

  test("details is always a finite positive number (never flexGrow-style unbounded)", () => {
    for (const cols of [60, 80, 100, 120, 150, 200, 300]) {
      const w = computeColumnWidths(cols);
      expect(Number.isFinite(w.details)).toBe(true);
      expect(w.details).toBeGreaterThanOrEqual(20);
    }
  });
});
