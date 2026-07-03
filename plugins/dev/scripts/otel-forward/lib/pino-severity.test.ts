import { describe, test, expect } from "bun:test";
import { pinoLevelToSeverity } from "./pino-severity.ts";

describe("pinoLevelToSeverity (CTL-1424)", () => {
  test("10 → TRACE / 1", () => {
    expect(pinoLevelToSeverity(10)).toEqual({ text: "TRACE", number: 1 });
  });

  test("20 → DEBUG / 5", () => {
    expect(pinoLevelToSeverity(20)).toEqual({ text: "DEBUG", number: 5 });
  });

  test("30 → INFO / 9", () => {
    expect(pinoLevelToSeverity(30)).toEqual({ text: "INFO", number: 9 });
  });

  test("40 → WARN / 13", () => {
    expect(pinoLevelToSeverity(40)).toEqual({ text: "WARN", number: 13 });
  });

  test("50 → ERROR / 17", () => {
    expect(pinoLevelToSeverity(50)).toEqual({ text: "ERROR", number: 17 });
  });

  test("60 → FATAL / 21", () => {
    expect(pinoLevelToSeverity(60)).toEqual({ text: "FATAL", number: 21 });
  });

  test("unknown level 35 → INFO / 9", () => {
    expect(pinoLevelToSeverity(35)).toEqual({ text: "INFO", number: 9 });
  });

  test("level 0 → INFO / 9", () => {
    expect(pinoLevelToSeverity(0)).toEqual({ text: "INFO", number: 9 });
  });

  test("NaN → INFO / 9", () => {
    expect(pinoLevelToSeverity(NaN)).toEqual({ text: "INFO", number: 9 });
  });

  test("non-number → INFO / 9", () => {
    expect(pinoLevelToSeverity("40")).toEqual({ text: "INFO", number: 9 });
  });

  test("undefined → INFO / 9", () => {
    expect(pinoLevelToSeverity(undefined)).toEqual({ text: "INFO", number: 9 });
  });
});
