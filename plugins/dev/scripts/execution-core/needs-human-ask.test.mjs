// needs-human-ask.test.mjs — CTL-1871: ASK comment formatter + parser tests.
import { describe, test, expect } from "bun:test";
import {
  formatAskComment,
  parseAskComment,
  ASK_DEFAULT_IF_SILENT,
  ASK_OPERATOR_DEFAULT,
} from "./needs-human-ask.mjs";
import { DEFAULT_IF_SILENT } from "./escalation-explanation.mjs";

// ─── constant exports ───────────────────────────────────────────────────────

describe("module constants", () => {
  test("ASK_DEFAULT_IF_SILENT re-exports DEFAULT_IF_SILENT", () => {
    expect(ASK_DEFAULT_IF_SILENT).toBe(DEFAULT_IF_SILENT);
    expect(typeof ASK_DEFAULT_IF_SILENT).toBe("string");
    expect(ASK_DEFAULT_IF_SILENT.trim()).not.toBe("");
  });

  test("ASK_OPERATOR_DEFAULT is a non-empty string", () => {
    expect(typeof ASK_OPERATOR_DEFAULT).toBe("string");
    expect(ASK_OPERATOR_DEFAULT.trim()).not.toBe("");
  });
});

// ─── formatAskComment ──────────────────────────────────────────────────────

describe("formatAskComment", () => {
  const baseExpl = {
    call_to_action:
      "Authorize retry of CTL-1 or cancel the ticket.",
    default_if_silent: DEFAULT_IF_SILENT,
  };

  test("basic case produces expected format", () => {
    const result = formatAskComment(baseExpl);
    expect(result).toBe(
      `ASK (${ASK_OPERATOR_DEFAULT}): Authorize retry of CTL-1 or cancel the ticket. — default if silent: ${DEFAULT_IF_SILENT}`
    );
  });

  test("default operator is ASK_OPERATOR_DEFAULT", () => {
    const result = formatAskComment(baseExpl);
    expect(result.startsWith(`ASK (${ASK_OPERATOR_DEFAULT}): `)).toBe(true);
  });

  test("custom operator is used when provided", () => {
    const result = formatAskComment(baseExpl, { operator: "Alice" });
    expect(result.startsWith("ASK (Alice): ")).toBe(true);
  });

  test("multi-line call_to_action is collapsed to one line", () => {
    const multiLine = {
      call_to_action:
        "Line one\n  line two\n\nline three",
      default_if_silent: DEFAULT_IF_SILENT,
    };
    const result = formatAskComment(multiLine);
    expect(result).not.toContain("\n");
    expect(result).toContain("Line one line two line three");
  });

  test("missing default_if_silent falls back to ASK_DEFAULT_IF_SILENT", () => {
    const result = formatAskComment({ call_to_action: "Fix or cancel?" });
    expect(result).toContain(DEFAULT_IF_SILENT);
  });

  test("empty explanation falls back gracefully (no throw)", () => {
    expect(() => formatAskComment({})).not.toThrow();
    const result = formatAskComment({});
    expect(result).toMatch(/^ASK \(.+\): .* — default if silent: .+$/);
  });
});

// ─── parseAskComment ──────────────────────────────────────────────────────

describe("parseAskComment", () => {
  test("parses a valid ASK comment", () => {
    const line = `ASK (Ryan): Authorize retry of CTL-1 or cancel. — default if silent: ${DEFAULT_IF_SILENT}`;
    const r = parseAskComment(line);
    expect(r.isAsk).toBe(true);
    expect(r.operator).toBe("Ryan");
    expect(r.oneLine).toBe("Authorize retry of CTL-1 or cancel.");
    expect(r.default).toBe(DEFAULT_IF_SILENT);
  });

  test("returns isAsk:false for a plain comment line", () => {
    expect(parseAskComment("Not an ASK comment").isAsk).toBe(false);
  });

  test("returns isAsk:false for empty string", () => {
    expect(parseAskComment("").isAsk).toBe(false);
  });

  test("returns isAsk:false for non-string input", () => {
    expect(parseAskComment(null).isAsk).toBe(false);
    expect(parseAskComment(undefined).isAsk).toBe(false);
    expect(parseAskComment(42).isAsk).toBe(false);
  });

  test("round-trips: formatAskComment → parseAskComment", () => {
    const expl = {
      call_to_action: "Decide whether to retry CTL-99 or cancel.",
      default_if_silent: "The ticket stays escalated pending your decision.",
    };
    const line = formatAskComment(expl, { operator: "Alice" });
    const parsed = parseAskComment(line);
    expect(parsed.isAsk).toBe(true);
    expect(parsed.operator).toBe("Alice");
    expect(parsed.oneLine).toBe("Decide whether to retry CTL-99 or cancel.");
    expect(parsed.default).toBe("The ticket stays escalated pending your decision.");
  });

  test("round-trips with default operator", () => {
    const expl = {
      call_to_action: "Fix or close?",
      default_if_silent: DEFAULT_IF_SILENT,
    };
    const line = formatAskComment(expl);
    const parsed = parseAskComment(line);
    expect(parsed.isAsk).toBe(true);
    expect(parsed.operator).toBe(ASK_OPERATOR_DEFAULT);
  });
});
