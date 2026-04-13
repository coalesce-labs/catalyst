import { describe, it, expect } from "bun:test";
import { checkProcessAlive } from "../lib/liveness";

describe("process liveness", () => {
  it("should detect current process as alive", () => {
    expect(checkProcessAlive(process.pid)).toBe(true);
  });

  it("should detect non-existent PID as dead", () => {
    expect(checkProcessAlive(999999999)).toBe(false);
  });

  it("should return false for null PID", () => {
    expect(checkProcessAlive(null)).toBe(false);
  });
});
