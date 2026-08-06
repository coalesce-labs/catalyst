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
    expect(shouldRewriteOrigin("HTTP://LOCALHOST:5173")).toBe(true);
  });

  // Vite binds ONE address family, so another local process can own the other
  // family's :5173; accepting both spellings would launder its Origin.
  test("does not rewrite the other loopback spelling", () => {
    expect(shouldRewriteOrigin("http://127.0.0.1:5173")).toBe(false);
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

// CTL-1573 round 14 — the proxy must follow MONITOR_HOST/MONITOR_PORT, or dev
// sends /api to an address the monitor is not listening on and fails before the
// Origin guard is even reached.
describe("monitorOrigin", () => {
  // Every key is explicitly set or cleared, so an ambient MONITOR_PORT/HOST on
  // the developer's or runner's shell cannot leak into these assertions.
  const withEnv = async (partial: Record<string, string | undefined>) => {
    const env: Record<string, string | undefined> = {
      MONITOR_HOST: undefined,
      MONITOR_PORT: undefined,
      ...partial,
    };
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      prev[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      // fresh module instance so the derived constant is recomputed
      const mod = await import(`./vite.config.ts?t=${Math.random()}`);
      return mod.MONITOR_ORIGIN as string;
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  test("defaults to IPv4 loopback on the default port", async () => {
    expect(await withEnv({ MONITOR_HOST: undefined, MONITOR_PORT: undefined })).toBe(
      "http://127.0.0.1:7400",
    );
  });

  test("maps every wildcard spelling to the loopback of that family", async () => {
    for (const v4 of ["0.0.0.0", "0", "0.0", "0.0.0", "00", "0x0"]) {
      expect(await withEnv({ MONITOR_HOST: v4 })).toBe("http://127.0.0.1:7400");
    }
    for (const v6 of ["::", "::0", "0:0:0:0:0:0:0:0"]) {
      expect(await withEnv({ MONITOR_HOST: v6 })).toBe("http://[::1]:7400");
    }
  });

  test("follows a specific host and port", async () => {
    expect(await withEnv({ MONITOR_HOST: "::1", MONITOR_PORT: "9999" })).toBe(
      "http://[::1]:9999",
    );
    expect(await withEnv({ MONITOR_HOST: "192.168.1.50" })).toBe("http://192.168.1.50:7400");
    expect(await withEnv({ MONITOR_HOST: "monitor.internal" })).toBe(
      "http://monitor.internal:7400",
    );
  });
});
