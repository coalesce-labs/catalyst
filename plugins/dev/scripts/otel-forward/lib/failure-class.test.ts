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

  // ⛔ BUN SHAPES — the runtime the daemon actually runs under. MEASURED on bun 1.3.5
  // (2026-08-23): a fetch to a closed port and to an unresolvable host BOTH yield
  // name="Error", code="ConnectionRefused", msg="Unable to connect. Is the computer able
  // to access the url?", with no `cause`. Before these branches existed, the commonest
  // collector failure of all landed in `other` on production while the Node-shaped
  // synthetic above reached `connection_refused` — green in the test, blind in prod.
  const bunRefused = () =>
    Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
      code: "ConnectionRefused",
    });
  test("bun connection-refused shape → network, not other", () => {
    expect(classifyForwardFailure(bunRefused()).category).toBe("network");
  });
  test("bun DNS failure carries the SAME code, so it must not claim connection_refused", () => {
    // Bun cannot distinguish the two; `network` is the honest class. Asserting the
    // NEGATIVE pins that a future edit does not invent a precision the runtime lacks.
    expect(classifyForwardFailure(bunRefused()).category).not.toBe("connection_refused");
    expect(classifyForwardFailure(bunRefused()).category).not.toBe("dns");
  });
  test("top-level code ECONNRESET → network even when the message says nothing", () => {
    const e = Object.assign(new Error("socket hang up-ish, no token here"), {
      code: "ECONNRESET",
    });
    expect(classifyForwardFailure(e).category).toBe("network");
  });
  // Positive control: the Node shapes must still classify precisely. If the broad Bun
  // branches were placed too early they would swallow these, and the two most useful
  // categories would collapse into `network`.
  test("the bun branches do not swallow the precise Node classes", () => {
    const nodeRefused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const nodeDns = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ENOTFOUND" },
    });
    expect(classifyForwardFailure(nodeRefused).category).toBe("connection_refused");
    expect(classifyForwardFailure(nodeDns).category).toBe("dns");
  });

  test("unknown → other, no httpStatus", () => {
    expect(classifyForwardFailure(new Error("weird"))).toEqual({ category: "other" });
    expect(classifyForwardFailure("string err")).toEqual({ category: "other" });
  });
});
