import { describe, test, expect } from "bun:test";
import { SEVERITY_NUMBERS, severityNumber } from "./canonical-event-shared.ts";

describe("Severity constants — TRACE and FATAL (CTL-1424)", () => {
  test("SEVERITY_NUMBERS.TRACE === 1", () => {
    expect(SEVERITY_NUMBERS.TRACE).toBe(1);
  });

  test("SEVERITY_NUMBERS.FATAL === 21", () => {
    expect(SEVERITY_NUMBERS.FATAL).toBe(21);
  });

  test("existing severity numbers unchanged", () => {
    expect(SEVERITY_NUMBERS.DEBUG).toBe(5);
    expect(SEVERITY_NUMBERS.INFO).toBe(9);
    expect(SEVERITY_NUMBERS.WARN).toBe(13);
    expect(SEVERITY_NUMBERS.ERROR).toBe(17);
  });

  test("severityNumber('TRACE') === 1", () => {
    expect(severityNumber("TRACE")).toBe(1);
  });

  test("severityNumber('FATAL') === 21", () => {
    expect(severityNumber("FATAL")).toBe(21);
  });
});
