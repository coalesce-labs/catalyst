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
  // ⛔ A connect/socket timeout carries ETIMEDOUT, and "ETIMEDOUT" does NOT contain the
  // substring "timeout" — so before this branch existed it matched no rule and landed in
  // `other`, the could-not-classify bucket, despite being one of the commonest forwarding
  // failures. These three fail against a classifier without the code check.
  test("ETIMEDOUT (via cause.code) → timeout, not other", () => {
    const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    expect(classifyForwardFailure(e).category).toBe("timeout");
  });
  test("undici UND_ERR_CONNECT_TIMEOUT → timeout", () => {
    const e = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    expect(classifyForwardFailure(e).category).toBe("timeout");
  });
  test("bare `connect ETIMEDOUT host:port` message → timeout", () => {
    expect(classifyForwardFailure(new Error("connect ETIMEDOUT 10.0.0.1:4318")).category).toBe(
      "timeout"
    );
  });
  // Negative control for the branch above: a code check that matched too eagerly would
  // swallow the connection-refused and DNS classes, which share the same wrapper shape.
  test("the ETIMEDOUT branch does not swallow ECONNREFUSED or DNS", () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    expect(classifyForwardFailure(refused).category).toBe("connection_refused");
    expect(classifyForwardFailure(dns).category).toBe("dns");
  });

  test("unknown → other, no httpStatus", () => {
    expect(classifyForwardFailure(new Error("weird"))).toEqual({ category: "other" });
    expect(classifyForwardFailure("string err")).toEqual({ category: "other" });
  });
});
