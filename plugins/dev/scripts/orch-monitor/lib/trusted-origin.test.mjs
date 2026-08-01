// CTL-1573 P1 — the reply route must validate Origin against a trusted value,
// not against the request's own (client-controlled) Host header.

import { describe, test, expect } from "bun:test";
import {
  buildTrustedOrigins,
  isOriginAllowed,
  originHost,
  selfAddresses,
} from "./trusted-origin.mjs";

const TRUSTED = buildTrustedOrigins({
  port: 7400,
  hostnames: ["mini.rozich"],
  addresses: ["192.168.1.50", "100.65.193.30"],
});

describe("originHost", () => {
  test("reduces an origin to its comparable host[:port]", () => {
    expect(originHost("http://mini:7400")).toBe("mini:7400");
    expect(originHost("https://Catalyst.Example")).toBe("catalyst.example");
    expect(originHost("http://127.0.0.1:7400")).toBe("127.0.0.1:7400");
  });

  test("rejects the opaque 'null' origin browsers send for sandboxed/file: pages", () => {
    expect(originHost("null")).toBeNull();
  });

  test("rejects unparseable, empty, and non-string values", () => {
    for (const bad of ["", "not a url", "mini:7400", undefined, null, 42, {}]) {
      expect(originHost(bad)).toBeNull();
    }
  });
});

describe("buildTrustedOrigins", () => {
  test("trusts loopback on the bound port", () => {
    for (const h of ["localhost:7400", "127.0.0.1:7400", "[::1]:7400"]) {
      expect(TRUSTED.has(h)).toBe(true);
    }
  });

  test("trusts this machine's own names — FQDN, short label, and .local", () => {
    for (const h of ["mini.rozich:7400", "mini:7400", "mini.local:7400"]) {
      expect(TRUSTED.has(h)).toBe(true);
    }
  });

  // A bare own-host would let ANY other service on this machine (e.g. :80)
  // drive the reply route, since the browser serializes that Origin with no
  // port. That is wider than the Origin-vs-Host check this replaces.
  test("does NOT trust an own name without the bound port", () => {
    for (const h of ["mini", "localhost", "mini.rozich", "127.0.0.1"]) {
      expect(TRUSTED.has(h)).toBe(false);
    }
  });

  test("adds the bare form only when the bound port is a scheme default", () => {
    const t80 = buildTrustedOrigins({ port: 80, hostnames: ["mini"], addresses: [] });
    expect(t80.has("mini")).toBe(true);
    const t443 = buildTrustedOrigins({ port: 443, hostnames: ["mini"], addresses: [] });
    expect(t443.has("mini")).toBe(true);
  });

  test("canonicalizes IDN entries to the punycode a browser actually sends", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      hostnames: [],
      addresses: [],
      extraOrigins: "münchen.local:7400",
    });
    expect(isOriginAllowed("http://xn--mnchen-3ya.local:7400", t)).toBe(true);
  });

  test("tracks a non-default port rather than assuming 7400", () => {
    const t = buildTrustedOrigins({ port: 9999, hostnames: ["mini"] });
    expect(t.has("mini:9999")).toBe(true);
    expect(t.has("mini:7400")).toBe(false);
  });

  test("takes deployment-specific origins exactly as given", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      hostnames: ["mini"],
      addresses: [],
      extraOrigins: "https://catalyst.example, mini-2.tail1234.ts.net:7400",
    });
    // A proxy on :443 -> the browser omits the port, so the bare host is right.
    expect(isOriginAllowed("https://catalyst.example", t)).toBe(true);
    expect(isOriginAllowed("http://mini-2.tail1234.ts.net:7400", t)).toBe(true);
    // ...and an extra is NOT silently widened to the bound port.
    expect(isOriginAllowed("http://catalyst.example:7400", t)).toBe(false);
  });

  test("ignores empty/garbage entries in the extras list", () => {
    const t = buildTrustedOrigins({ port: 7400, hostnames: ["mini"], extraOrigins: " , ,, " });
    expect(isOriginAllowed("http://evil.example:7400", t)).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  test("allows the operator's real browsing origins (must not ship inert)", () => {
    for (const o of [
      "http://mini:7400",
      "http://mini.local:7400",
      "http://mini.rozich:7400",
      "http://localhost:7400",
      "http://127.0.0.1:7400",
    ]) {
      expect(isOriginAllowed(o, TRUSTED)).toBe(true);
    }
  });

  // The same host on a DIFFERENT port is a different service, and a compromised
  // one must not be able to drive this route.
  test("rejects another service on this same machine (bare host / other port)", () => {
    for (const o of ["http://mini", "http://localhost", "http://mini:8080"]) {
      expect(isOriginAllowed(o, TRUSTED)).toBe(false);
    }
  });

  test("allows an absent/empty Origin — non-browser clients are not CSRF vectors", () => {
    expect(isOriginAllowed(null, TRUSTED)).toBe(true);
    expect(isOriginAllowed(undefined, TRUSTED)).toBe(true);
    expect(isOriginAllowed("", TRUSTED)).toBe(true);
  });

  test("rejects an ordinary cross-origin page", () => {
    expect(isOriginAllowed("https://evil.example", TRUSTED)).toBe(false);
  });

  // THE REGRESSION THIS TICKET EXISTS FOR. Under DNS rebinding the attacker's
  // page and the target share one origin, so Origin === Host and the previous
  // `Origin` vs `Host` check passed. The allowlist is not derived from the
  // request, so it still refuses.
  test("rejects a DNS-rebinding origin whose Origin and Host would match", () => {
    const rebound = "http://evil.example:7400";
    // Precondition: the OLD guard's comparison would have accepted this.
    expect(originHost(rebound)).toBe("evil.example:7400"); // === the Host header
    expect(isOriginAllowed(rebound, TRUSTED)).toBe(false);
  });

  test("rejects a lookalike hostname that merely contains a trusted name", () => {
    for (const o of [
      "http://mini.evil.example:7400",
      "http://notmini:7400",
      "http://mini.evil.example",
    ]) {
      expect(isOriginAllowed(o, TRUSTED)).toBe(false);
    }
  });

  test("rejects a trusted host reached on an untrusted port", () => {
    expect(isOriginAllowed("http://mini:1234", TRUSTED)).toBe(false);
  });

  // Inertness guard: operators reach the monitor by LAN or Tailscale address
  // as often as by name, and a 403 there would kill the surface in real use.
  test("allows this machine's own LAN / Tailscale addresses", () => {
    expect(isOriginAllowed("http://192.168.1.50:7400", TRUSTED)).toBe(true);
    expect(isOriginAllowed("http://100.65.193.30:7400", TRUSTED)).toBe(true);
  });

  test("still rejects an address that is not ours", () => {
    expect(isOriginAllowed("http://10.9.9.9:7400", TRUSTED)).toBe(false);
  });

  test("rejects a present-but-opaque Origin instead of falling open", () => {
    expect(isOriginAllowed("null", TRUSTED)).toBe(false);
    expect(isOriginAllowed("garbage", TRUSTED)).toBe(false);
  });
});

describe("selfAddresses", () => {
  test("returns bracketed IPv6 and bare IPv4, never loopback, and never throws", () => {
    const addrs = selfAddresses();
    expect(Array.isArray(addrs)).toBe(true);
    for (const a of addrs) {
      expect(typeof a).toBe("string");
      expect(a).not.toBe("127.0.0.1");
      expect(a).not.toBe("[::1]");
      if (a.includes(":")) expect(a.startsWith("[")).toBe(true);
      expect(a.includes("%")).toBe(false); // zone index stripped
    }
  });
});
