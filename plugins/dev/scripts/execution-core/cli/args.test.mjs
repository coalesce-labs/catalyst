import { describe, it, expect } from "bun:test";
import { parseArgs, ArgError } from "./args.mjs";

const spec = {
  booleans: ["yes", "dry-run", "json", "include-interactive"],
  numbers: ["max", "min-idle-seconds"],
  strings: ["ticket", "categories"],
};

describe("parseArgs (strict)", () => {
  it("parses booleans, numbers, strings, and positionals", () => {
    const a = parseArgs(
      ["list", "--json", "--max", "5", "--ticket", "CTL-1", "--yes"],
      spec,
    );
    expect(a._).toEqual(["list"]);
    expect(a.json).toBe(true);
    expect(a.yes).toBe(true);
    expect(a.max).toBe(5);
    expect(a.ticket).toBe("CTL-1");
  });

  it("supports --flag=value", () => {
    const a = parseArgs(["--max=20", "--ticket=CTL-9"], spec);
    expect(a.max).toBe(20);
    expect(a.ticket).toBe("CTL-9");
  });

  it("REJECTS an unknown flag (finding #1)", () => {
    expect(() => parseArgs(["--include-interactiv"], spec)).toThrow(ArgError);
    expect(() => parseArgs(["--bogus"], spec)).toThrow(/unknown flag: --bogus/);
  });

  it("REJECTS a non-numeric number flag (finding #2)", () => {
    expect(() => parseArgs(["--min-idle-seconds", "abc"], spec)).toThrow(
      /--min-idle-seconds expects a number/,
    );
    expect(() => parseArgs(["--max", "NaN"], spec)).toThrow(ArgError);
  });

  it("rejects a missing value", () => {
    expect(() => parseArgs(["--ticket"], spec)).toThrow(/requires a value/);
  });

  it("rejects a value on a boolean flag", () => {
    expect(() => parseArgs(["--json=true"], spec)).toThrow(/does not take a value/);
  });

  it("accepts a negative/decimal number", () => {
    expect(parseArgs(["--max", "-1"], spec).max).toBe(-1);
    expect(parseArgs(["--min-idle-seconds", "0.5"], spec)["min-idle-seconds"]).toBe(0.5);
  });
});
