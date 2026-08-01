// CTL-1573 round 5 — the dev proxy must not launder a hostile Origin.
//
// A blanket `headers: { Origin }` on the /api proxy would make `bun run dev:ui`
// an origin-laundering service: any other page (another localhost port, a LAN
// host) could POST a simple text/plain JSON body to
// http://localhost:5173/api/ticket/X/reply, have its Origin replaced with a
// trusted one, and get the Linear write. CORS hides the response, but the side
// effect has already happened.
import { describe, test, expect } from "bun:test";
import { shouldRewriteOrigin } from "./vite.config.ts";

describe("shouldRewriteOrigin", () => {
  test("rewrites a genuine same-origin request from this dev server", () => {
    expect(shouldRewriteOrigin("http://localhost:5173")).toBe(true);
    expect(shouldRewriteOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(shouldRewriteOrigin("HTTP://LOCALHOST:5173")).toBe(true);
  });

  test("does NOT rewrite another local service's origin", () => {
    for (const o of ["http://localhost:3000", "http://127.0.0.1:8080", "http://localhost"]) {
      expect(shouldRewriteOrigin(o)).toBe(false);
    }
  });

  test("does NOT rewrite a remote/LAN or hostile origin", () => {
    for (const o of [
      "https://evil.example",
      "http://192.168.1.9:5173",
      "http://evil.example:5173",
    ]) {
      expect(shouldRewriteOrigin(o)).toBe(false);
    }
  });

  test("leaves a missing Origin untouched (curl / non-browser)", () => {
    expect(shouldRewriteOrigin(undefined)).toBe(false);
    expect(shouldRewriteOrigin(null)).toBe(false);
    expect(shouldRewriteOrigin("")).toBe(false);
  });

  test("does not rewrite the https form of the dev origin", () => {
    expect(shouldRewriteOrigin("https://localhost:5173")).toBe(false);
  });
});
