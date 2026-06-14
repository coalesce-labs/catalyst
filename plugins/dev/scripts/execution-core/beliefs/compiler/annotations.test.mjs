// annotations.test.mjs — CTL-1103 Phase 1
// Unit tests for @description annotation parsing.

import { describe, it, expect } from "bun:test";
import { parseAnnotations } from "./annotations.mjs";

describe("parseAnnotations — @description (CTL-1103)", () => {
  it("parses a single-line @description value", () => {
    const block = `rule R1 session_registered
@description The signal's bg job appears in the agents listing — the session is registered.
@severity info`;
    const result = parseAnnotations(block);
    expect(result.description).toBe(
      "The signal's bg job appears in the agents listing — the session is registered.",
    );
  });

  it("absent @description yields empty string (back-compat)", () => {
    const block = `rule R2 turn_started\n@severity info`;
    const result = parseAnnotations(block);
    expect(result.description).toBe("");
  });

  it("last-wins when @description appears more than once", () => {
    const block = `rule R1 x\n@description first\n@description second`;
    expect(parseAnnotations(block).description).toBe("second");
  });

  it("@description does not affect other fields", () => {
    const block = `rule R1 x\n@description Some text.\n@severity warn\n@feeds R10`;
    const result = parseAnnotations(block);
    expect(result.severity).toBe("warn");
    expect(result.feeds).toEqual(["R10"]);
    expect(result.description).toBe("Some text.");
  });
});
