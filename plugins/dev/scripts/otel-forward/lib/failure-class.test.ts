import { describe, test, expect } from "bun:test";
import { HttpError } from "./retry.ts";
import { classifyForwardFailure } from "./failure-class.ts";

describe("classifyForwardFailure", () => {
  test("429 → http_429 + status", () => {
    expect(classifyForwardFailure(new HttpError(429))).toEqual({
      category: "http_429",
      httpStatus: 429,
    });
  });
  test("503 → http_5xx + status", () => {
    expect(classifyForwardFailure(new HttpError(503))).toEqual({
      category: "http_5xx",
      httpStatus: 503,
    });
  });
  test("500 → http_5xx + status", () => {
    expect(classifyForwardFailure(new HttpError(500)).category).toBe("http_5xx");
  });
  test("AbortSignal.timeout TimeoutError → timeout", () => {
    const e = new DOMException("The operation timed out.", "TimeoutError");
    expect(classifyForwardFailure(e)).toEqual({ category: "timeout" });
  });
  test("shutdown AbortError → aborted", () => {
    const e = new DOMException("This operation was aborted", "AbortError");
    expect(classifyForwardFailure(e)).toEqual({ category: "aborted" });
  });
  test("ECONNREFUSED (via cause.code) → connection_refused", () => {
    const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(classifyForwardFailure(e).category).toBe("connection_refused");
  });
  test("ENOTFOUND / EAI_AGAIN (via cause.code) → dns", () => {
    const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    expect(classifyForwardFailure(e).category).toBe("dns");
  });
  test("generic fetch failed → network", () => {
    expect(classifyForwardFailure(new TypeError("fetch failed")).category).toBe("network");
  });
  test("unknown → other, no httpStatus", () => {
    expect(classifyForwardFailure(new Error("weird"))).toEqual({ category: "other" });
    expect(classifyForwardFailure("string err")).toEqual({ category: "other" });
  });
});
