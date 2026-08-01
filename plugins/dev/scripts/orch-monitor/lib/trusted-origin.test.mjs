// CTL-1573 P1 — the reply route must validate Origin against a trusted value,
// not against the request's own (client-controlled) Host header.

import { describe, test, expect } from "bun:test";
import {
  _bonjourResolveCount,
  _bonjourTtlMs,
  _resetBonjourCache,
  bonjourName,
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
  test("reduces an origin to its canonical origin key (scheme preserved)", () => {
    expect(originHost("http://mini:7400")).toBe("http://mini:7400");
    expect(originHost("https://Catalyst.Example")).toBe("https://catalyst.example");
    expect(originHost("http://127.0.0.1:7400")).toBe("http://127.0.0.1:7400");
    // a scheme-default port is dropped, exactly as a browser serializes Origin
    expect(originHost("http://mini:80")).toBe("http://mini");
  });

  test("rejects the opaque 'null' origin browsers send for sandboxed/file: pages", () => {
    expect(originHost("null")).toBeNull();
  });

  test("rejects unparseable, empty, and non-string values", () => {
    for (const bad of ["", "not a url", undefined, null, 42, {}]) {
      expect(originHost(bad)).toBeNull();
    }
  });
});

describe("buildTrustedOrigins", () => {
  test("trusts loopback on the bound port", () => {
    for (const h of ["http://localhost:7400", "http://127.0.0.1:7400", "http://[::1]:7400"]) {
      expect(TRUSTED.has(h)).toBe(true);
    }
  });

  test("trusts this machine's own names — FQDN and short label", () => {
    for (const h of ["http://mini.rozich:7400", "http://mini:7400"]) {
      expect(TRUSTED.has(h)).toBe(true);
    }
  });

  // A `${short}.local` nobody advertises is CLAIMABLE over mDNS by any LAN
  // host, which could then serve a page on our port and pass the guard. Only a
  // `.local` the system actually advertises may be trusted.
  test("does NOT fabricate a ${short}.local alias", () => {
    expect(TRUSTED.has("http://mini.local:7400")).toBe(false);
  });

  // A bare own-host would let ANY other service on this machine (e.g. :80)
  // drive the reply route, since the browser serializes that Origin with no
  // port. That is wider than the Origin-vs-Host check this replaces.
  test("does NOT trust an own name without the bound port", () => {
    for (const h of ["http://mini", "http://localhost", "http://mini.rozich"]) {
      expect(TRUSTED.has(h)).toBe(false);
    }
  });

  test("collapses to the bare form when the bound port is a scheme default", () => {
    const t80 = buildTrustedOrigins({ port: 80, hostnames: ["mini"], addresses: [] });
    expect(t80.has("http://mini")).toBe(true);
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
    const t = buildTrustedOrigins({ port: 9999, hostnames: ["mini"], addresses: [] });
    expect(t.has("http://mini:9999")).toBe(true);
    expect(t.has("http://mini:7400")).toBe(false);
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
    expect(originHost(rebound)).toBe("http://evil.example:7400"); // host === the Host header
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

describe("scheme is part of the key (CTL-1573 round 3)", () => {
  // Reducing to a bare host merged http and https, so a compromised plaintext
  // endpoint on a proxied hostname could drive the HTTPS reply route.
  test("a full https origin does NOT also trust its plaintext endpoint", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      hostnames: [],
      addresses: [],
      extraOrigins: "https://catalyst.example",
    });
    expect(isOriginAllowed("https://catalyst.example", t)).toBe(true);
    expect(isOriginAllowed("http://catalyst.example", t)).toBe(false);
  });

  test("a bare host entry cannot state a scheme, so it trusts both", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      hostnames: [],
      addresses: [],
      extraOrigins: "proxy.example",
    });
    expect(isOriginAllowed("https://proxy.example", t)).toBe(true);
    expect(isOriginAllowed("http://proxy.example", t)).toBe(true);
  });

  test("own names are trusted only under the scheme the monitor serves", () => {
    expect(isOriginAllowed("https://mini:7400", TRUSTED)).toBe(false);
    expect(isOriginAllowed("http://mini:7400", TRUSTED)).toBe(true);
  });
});

describe("dev-server origin gate (CTL-1573 round 3)", () => {
  // `bun run dev:ui` serves the UI on :5173 and Vite proxies /api to the
  // monitor WITHOUT rewriting Origin, so replies 403 unless it is trusted.
  test("the Vite dev origin is trusted only when passed explicitly", () => {
    const prod = buildTrustedOrigins({ port: 7400, hostnames: ["mini"], addresses: [] });
    expect(isOriginAllowed("http://localhost:5173", prod)).toBe(false);

    const dev = buildTrustedOrigins({
      port: 7400,
      hostnames: ["mini"],
      addresses: [],
      devOrigins: "http://localhost:5173 http://127.0.0.1:5173",
    });
    expect(isOriginAllowed("http://localhost:5173", dev)).toBe(true);
    expect(isOriginAllowed("http://127.0.0.1:5173", dev)).toBe(true);
    // the gate must not widen anything else
    expect(isOriginAllowed("http://evil.example:5173", dev)).toBe(false);
  });
});

describe("bonjourName", () => {
  test("returns null off darwin, and never throws", () => {
    const n = bonjourName();
    expect(n === null || typeof n === "string").toBe(true);
    if (typeof n === "string") expect(n).not.toBe("");
  });

  // DoS guard: the allowlist rebuilds on EVERY rejected Origin, and this spawns
  // `scutil` via execFileSync (1s timeout) which blocks Bun's event loop. Without
  // the memo an unauthenticated client could stall the monitor by looping bad
  // Origins at the reply route. Repeated calls must not respawn.
  test("resolves at most once per process (rejected origins must not spawn scutil)", () => {
    _resetBonjourCache();
    expect(_bonjourResolveCount()).toBe(0);
    bonjourName();
    expect(_bonjourResolveCount()).toBe(1);
    for (let i = 0; i < 200; i++) bonjourName();
    // Counting the underlying resolution, NOT elapsed time: a wall-clock
    // threshold fails spuriously when an oversubscribed CI worker deschedules
    // the process mid-loop.
    expect(_bonjourResolveCount()).toBe(1);
  });

  test("buildTrustedOrigins does not re-resolve Bonjour on each rebuild", () => {
    _resetBonjourCache();
    bonjourName();
    expect(_bonjourResolveCount()).toBe(1);
    for (let i = 0; i < 50; i++) buildTrustedOrigins({ port: 7400, addresses: [] });
    expect(_bonjourResolveCount()).toBe(1);
  });
});

describe("opaque / non-http origins (CTL-1573 round 6)", () => {
  // A non-special scheme serializes URL.origin as the literal "null", so
  // accepting one would put "null" in the trusted set — and then EVERY opaque
  // origin (any other extension, any sandboxed frame) matches it.
  test("a configured chrome-extension origin does not poison the set", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      hostnames: [],
      addresses: [],
      extraOrigins: "chrome-extension://trustedid",
    });
    expect(t.has("null")).toBe(false);
    expect(isOriginAllowed("chrome-extension://evilid", t)).toBe(false);
    expect(isOriginAllowed("chrome-extension://trustedid", t)).toBe(false);
    expect(isOriginAllowed("null", t)).toBe(false);
  });

  test("originHost rejects non-http(s) schemes outright", () => {
    for (const o of ["chrome-extension://abc", "file:///etc/passwd", "ftp://host", "data:,x"]) {
      expect(originHost(o)).toBeNull();
    }
  });
});

describe("loopback family follows the bound address (CTL-1573 round 7)", () => {
  // Binding 0.0.0.0 listens on IPv4 only, but an unrelated service can still
  // bind [::1] on the same port. Trusting the IPv6 loopback literal would let
  // content served there POST to the IPv4 monitor and pass the guard.
  test("binding 0.0.0.0 does not trust the IPv6 loopback literal", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      hostnames: [],
      addresses: [],
      bindHost: "0.0.0.0",
    });
    expect(t.has("http://127.0.0.1:7400")).toBe(true);
    expect(t.has("http://[::1]:7400")).toBe(false);
  });

  test("binding :: trusts both loopback literals", () => {
    const t = buildTrustedOrigins({ port: 7400, hostnames: [], addresses: [], bindHost: "::" });
    expect(t.has("http://127.0.0.1:7400")).toBe(true);
    expect(t.has("http://[::1]:7400")).toBe(true);
  });

  test("binding ::1 does not trust the IPv4 loopback literal", () => {
    const t = buildTrustedOrigins({ port: 7400, hostnames: [], addresses: [], bindHost: "::1" });
    expect(t.has("http://[::1]:7400")).toBe(true);
    expect(t.has("http://127.0.0.1:7400")).toBe(false);
  });

  test("the localhost NAME stays trusted regardless of family", () => {
    for (const bind of ["0.0.0.0", "::", "::1", "127.0.0.1"]) {
      const t = buildTrustedOrigins({ port: 7400, hostnames: [], addresses: [], bindHost: bind });
      expect(t.has("http://localhost:7400")).toBe(true);
    }
  });

  test("an unspecified bindHost stays permissive (both families)", () => {
    const t = buildTrustedOrigins({ port: 7400, hostnames: [], addresses: [] });
    expect(t.has("http://127.0.0.1:7400")).toBe(true);
    expect(t.has("http://[::1]:7400")).toBe(true);
  });
});

describe("self-addresses follow the bound family (CTL-1573 round 8)", () => {
  const ADDRS = ["192.168.1.50", "[fe80::1]", "100.65.193.30", "[2001:db8::5]"];

  test("an IPv4-only bind does not trust this host's IPv6 interface origins", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      hostnames: [],
      addresses: ADDRS,
      bindHost: "0.0.0.0",
    });
    expect(t.has("http://192.168.1.50:7400")).toBe(true);
    expect(t.has("http://100.65.193.30:7400")).toBe(true);
    expect(t.has("http://[fe80::1]:7400")).toBe(false);
    expect(t.has("http://[2001:db8::5]:7400")).toBe(false);
  });

  test("a dual-stack bind trusts both families", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      hostnames: [],
      addresses: ADDRS,
      bindHost: "::",
    });
    expect(t.has("http://192.168.1.50:7400")).toBe(true);
    expect(t.has("http://[2001:db8::5]:7400")).toBe(true);
  });

  // A SPECIFIC bind owns the port only on that address. Another service can
  // hold the same port on a different interface, so trusting all same-family
  // addresses would hand that service an allowlisted Origin.
  test("a specific bind trusts only its own address, not every same-family one", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      hostnames: [],
      addresses: ADDRS,
      bindHost: "192.168.1.50",
    });
    expect(t.has("http://192.168.1.50:7400")).toBe(true);
    expect(t.has("http://100.65.193.30:7400")).toBe(false);
    expect(t.has("http://[2001:db8::5]:7400")).toBe(false);
  });

  test("a loopback-only bind does not trust this host's LAN addresses", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      hostnames: [],
      addresses: ADDRS,
      bindHost: "127.0.0.1",
    });
    expect(t.has("http://127.0.0.1:7400")).toBe(true);
    expect(t.has("http://192.168.1.50:7400")).toBe(false);
  });
});



describe("specific IPv6 binds (CTL-1573 round 10)", () => {
  // Treating only ::/::1 as IPv6-capable dropped the server's OWN address when
  // bound to a specific global v6 address — 403-ing every legitimate reply.
  test("a specific global IPv6 bind trusts its own address", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      hostnames: [],
      bindHost: "2001:db8::1",
    });
    expect(t.has("http://[2001:db8::1]:7400")).toBe(true);
  });

  test("a bracketed specific IPv6 bind behaves identically", () => {
    const t = buildTrustedOrigins({ port: 7400, hostnames: [], bindHost: "[2001:db8::1]" });
    expect(t.has("http://[2001:db8::1]:7400")).toBe(true);
  });

  test("a specific IPv6 bind does not trust IPv4 loopback or other v6 addresses", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      hostnames: [],
      addresses: ["[2001:db8::1]", "[2001:db8::9]", "192.168.1.50"],
      bindHost: "2001:db8::1",
    });
    expect(t.has("http://[2001:db8::1]:7400")).toBe(true);
    expect(t.has("http://[2001:db8::9]:7400")).toBe(false);
    expect(t.has("http://192.168.1.50:7400")).toBe(false);
    expect(t.has("http://127.0.0.1:7400")).toBe(false);
  });
});

describe("a specific bind owns exactly one socket (CTL-1573 round 11)", () => {
  // Bound to a LAN address, the monitor does NOT own <loopback>:<port> — another
  // service can hold it, serve a page, and POST to us with a passing Origin.
  test("a LAN-bound monitor does not trust loopback", () => {
    const t = buildTrustedOrigins({ port: 7400, bindHost: "192.168.1.50" });
    expect(t.has("http://192.168.1.50:7400")).toBe(true);
    expect(t.has("http://127.0.0.1:7400")).toBe(false);
    expect(t.has("http://localhost:7400")).toBe(false);
  });

  // ...and the converse: a loopback-bound monitor must still be reachable by
  // the names an operator actually types, or the surface ships inert.
  test("a loopback-bound monitor still trusts localhost and the literal", () => {
    const t = buildTrustedOrigins({ port: 7400, bindHost: "127.0.0.1" });
    expect(t.has("http://127.0.0.1:7400")).toBe(true);
    expect(t.has("http://localhost:7400")).toBe(true);
  });

  // Own NAMES resolve to whichever interface DNS/mDNS picks, not necessarily
  // the bound one.
  test("a specific bind does not trust this host's own names", () => {
    const t = buildTrustedOrigins({ port: 7400, hostnames: ["mini"], bindHost: "127.0.0.1" });
    expect(t.has("http://mini:7400")).toBe(false);
    expect(t.has("http://127.0.0.1:7400")).toBe(true);
  });

  test("a wildcard bind still trusts own names and loopback", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      hostnames: ["mini"],
      addresses: [],
      bindHost: "0.0.0.0",
    });
    expect(t.has("http://mini:7400")).toBe(true);
    expect(t.has("http://localhost:7400")).toBe(true);
    expect(t.has("http://127.0.0.1:7400")).toBe(true);
  });

  test("explicit extras still apply under a specific bind", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      bindHost: "192.168.1.50",
      extraOrigins: "https://catalyst.example",
    });
    expect(isOriginAllowed("https://catalyst.example", t)).toBe(true);
  });
});

describe("dev proxy rewrite target (CTL-1573)", () => {
  test("the origin the Vite proxy rewrites to is trusted on a wildcard bind", () => {
    const t = buildTrustedOrigins({ port: 7400, hostnames: [], addresses: [], bindHost: "0.0.0.0" });
    expect(isOriginAllowed("http://127.0.0.1:7400", t)).toBe(true);
  });
});

describe("bind classification edge cases (CTL-1573 round 13)", () => {
  // Every spelling of the IPv6 unspecified address is the dual-stack wildcard.
  // An exact-string check treated ::0 and the expanded form as SPECIFIC, which
  // kept only the unusable unspecified-address origin and 403'd every real one.
  for (const spelling of ["::", "::0", "0:0:0:0:0:0:0:0"]) {
    test(`"${spelling}" is recognized as the dual-stack wildcard`, () => {
      const t = buildTrustedOrigins({
        port: 7400,
        hostnames: ["mini"],
        addresses: ["192.168.1.50"],
        bindHost: spelling,
      });
      expect(t.has("http://mini:7400")).toBe(true);
      expect(t.has("http://192.168.1.50:7400")).toBe(true);
      expect(t.has("http://localhost:7400")).toBe(true);
      expect(t.has("http://[::1]:7400")).toBe(true);
    });
  }

  // A hostname bind resolves to ONE interface, so it is not a wildcard: it must
  // not pull in every local address and self-name.
  test("a hostname bind trusts that name and nothing derived", () => {
    const t = buildTrustedOrigins({
      port: 7400,
      hostnames: ["mini"],
      addresses: ["192.168.1.50"],
      bindHost: "monitor.internal",
    });
    expect(t.has("http://monitor.internal:7400")).toBe(true);
    expect(t.has("http://192.168.1.50:7400")).toBe(false);
    expect(t.has("http://mini:7400")).toBe(false);
    expect(t.has("http://localhost:7400")).toBe(false);
  });

  // A loopback NAME bind is family-ambiguous — Bun may have bound ::1 — so the
  // literals would be a GUESS, and another process can own the one guessed
  // wrong. The name itself is what the operator browses, so it is trusted.
  test("a `localhost` hostname bind trusts the name but not guessed literals", () => {
    const t = buildTrustedOrigins({ port: 7400, hostnames: ["mini"], bindHost: "localhost" });
    expect(t.has("http://localhost:7400")).toBe(true);
    expect(t.has("http://127.0.0.1:7400")).toBe(false);
    expect(t.has("http://[::1]:7400")).toBe(false);
    expect(t.has("http://mini:7400")).toBe(false);
  });

  test("a loopback LITERAL bind trusts that literal (family is known)", () => {
    const t4 = buildTrustedOrigins({ port: 7400, hostnames: [], bindHost: "127.0.0.1" });
    expect(t4.has("http://127.0.0.1:7400")).toBe(true);
    expect(t4.has("http://[::1]:7400")).toBe(false);
    const t6 = buildTrustedOrigins({ port: 7400, hostnames: [], bindHost: "::1" });
    expect(t6.has("http://[::1]:7400")).toBe(true);
    expect(t6.has("http://127.0.0.1:7400")).toBe(false);
  });
});

describe("Bonjour identity expires (CTL-1573 round 13)", () => {
  // A renamed LocalHostName must stop being trusted while the KeepAlive daemon
  // runs, or the retired `.local` stays allowlisted forever and is claimable
  // once freed. But it must still not re-spawn per rejected request (the DoS).
  test("memoizes within the TTL", () => {
    _resetBonjourCache();
    bonjourName();
    for (let i = 0; i < 200; i++) bonjourName();
    expect(_bonjourResolveCount()).toBe(1);
  });

  test("the TTL is bounded, not process-lifetime", () => {
    expect(_bonjourTtlMs()).toBeGreaterThan(0);
    expect(Number.isFinite(_bonjourTtlMs())).toBe(true);
  });
});

describe("IPv4 wildcard spellings and the loopback range (CTL-1573 round 15)", () => {
  for (const spelling of ["0.0.0.0", "0", "0.0", "0.0.0"]) {
    test(`"${spelling}" is recognized as the IPv4 wildcard`, () => {
      const t = buildTrustedOrigins({
        port: 7400,
        hostnames: ["mini"],
        addresses: ["192.168.1.50"],
        bindHost: spelling,
      });
      expect(t.has("http://mini:7400")).toBe(true);
      expect(t.has("http://192.168.1.50:7400")).toBe(true);
      expect(t.has("http://127.0.0.1:7400")).toBe(true);
    });
  }

  // The whole 127.0.0.0/8 range reaches an IPv4 wildcard bind; selfAddresses()
  // excludes internal interfaces, so these would otherwise 403 a legitimate
  // operator. 127.0.1.1 is the Debian convention for the host's own name.
  test("any 127.0.0.0/8 alias is allowed on a wildcard bind", () => {
    const t = buildTrustedOrigins({ port: 7400, hostnames: [], addresses: [], bindHost: "0.0.0.0" });
    for (const o of [
      "http://127.0.0.1:7400",
      "http://127.0.0.2:7400",
      "http://127.0.1.1:7400",
      "http://127.255.255.254:7400",
    ]) {
      expect(isOriginAllowed(o, t)).toBe(true);
    }
  });

  test("the range does not leak to other ports, hosts, or schemes", () => {
    const t = buildTrustedOrigins({ port: 7400, hostnames: [], addresses: [], bindHost: "0.0.0.0" });
    expect(isOriginAllowed("http://127.0.0.2:8080", t)).toBe(false);
    expect(isOriginAllowed("https://127.0.0.2:7400", t)).toBe(false);
    expect(isOriginAllowed("http://128.0.0.1:7400", t)).toBe(false);
    expect(isOriginAllowed("http://27.0.0.1:7400", t)).toBe(false);
    expect(isOriginAllowed("http://127.0.0.999:7400", t)).toBe(false);
  });

  test("a specific bind gets no loopback range", () => {
    const t = buildTrustedOrigins({ port: 7400, hostnames: [], bindHost: "192.168.1.50" });
    expect(isOriginAllowed("http://127.0.0.2:7400", t)).toBe(false);
  });
});

describe("exotic IPv4 wildcard spellings (CTL-1573 round 16)", () => {
  for (const spelling of ["00", "0x0", "0.00.0.0"]) {
    test(`"${spelling}" is recognized as the IPv4 wildcard`, () => {
      const t = buildTrustedOrigins({
        port: 7400,
        hostnames: ["mini"],
        addresses: [],
        bindHost: spelling,
      });
      expect(t.has("http://mini:7400")).toBe(true);
      expect(t.has("http://127.0.0.1:7400")).toBe(true);
    });
  }

  test("a real address is still specific", () => {
    const t = buildTrustedOrigins({ port: 7400, hostnames: ["mini"], bindHost: "10.0.0.1" });
    expect(t.has("http://10.0.0.1:7400")).toBe(true);
    expect(t.has("http://mini:7400")).toBe(false);
    expect(t.has("http://127.0.0.1:7400")).toBe(false);
  });
});
