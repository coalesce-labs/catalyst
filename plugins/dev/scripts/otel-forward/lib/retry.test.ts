import { describe, test, expect } from "bun:test";
import { withRetry } from "./retry.ts";

describe("withRetry", () => {
  test("returns on first success", async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return "ok"; }, 3, [0, 0, 0]);
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries up to maxAttempts and throws", async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error("fail"); }, 3, [0, 0, 0])).rejects.toThrow("fail");
    expect(calls).toBe(3);
  });
});
