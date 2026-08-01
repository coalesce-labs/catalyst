// CTL-1573 P1 — trusted-origin allowlist for state-changing routes.
//
// WHY NOT `Origin` vs the request's own `Host` (what this replaces):
// the monitor binds 0.0.0.0 with no auth, so POST /api/ticket/<t>/reply posts
// operator-authored text to Linear. The original guard compared
// `new URL(origin).host` against `req.headers.get("host")`. In a browser JS
// cannot set `Host` (it is a forbidden header), so that does block ordinary
// CSRF — but it is defeated by DNS REBINDING, which is the actual hole:
//
//   1. operator loads http://evil.example:7400/ (attacker-controlled)
//   2. evil.example re-resolves to this host's IP
//   3. the page fetches http://evil.example:7400/api/ticket/CTL-1/reply
//   4. the browser calls that SAME-ORIGIN, so it sends
//        Origin: http://evil.example:7400   Host: evil.example:7400
//   5. the two match -> the old guard passes -> a comment is posted as the operator
//
// Both sides of that comparison are attacker-chosen, so comparing them to each
// other can never reject it. The fix is to compare `Origin` against a value the
// ATTACKER CANNOT INFLUENCE: the set of origins this server is legitimately
// reached by.
//
// KEYS ARE FULL ORIGINS (`scheme://host[:port]`), not bare hosts. Reducing to a
// host silently merges http and https, so a compromised plaintext endpoint on a
// proxied hostname could drive the HTTPS reply route. `URL.origin` also drops a
// scheme-default port, which is exactly how a browser serializes `Origin`.
//
// INERTNESS IS THE OTHER FAILURE MODE, and it is the one that has bitten this
// codebase repeatedly: an allowlist missing the origin the operator actually
// browses 403s every reply and ships the surface dead. Hence loopback, own
// names (including the real Bonjour name on macOS), own addresses, the Vite dev
// origin under a dev gate, and MONITOR_TRUSTED_ORIGINS as the escape hatch.

import { hostname as osHostname, networkInterfaces, platform } from "node:os";
import { execFileSync } from "node:child_process";

const DEFAULT_SCHEME = "http"; // the monitor serves plaintext; TLS is a front-end concern

/** Canonical origin key for a full origin string, or null. */
function originKey(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "" || s === "null") return null;
  try {
    const u = new URL(s);
    // Only the schemes a browser can actually reach this server over. A
    // "non-special" scheme (chrome-extension:, custom:) serializes `URL.origin`
    // as the literal string "null", so accepting one would put "null" in the
    // trusted set — and EVERY opaque origin then matches it. Restricting the
    // scheme closes that; the explicit "null" guard below is the belt-and-braces.
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.hostname === "") return null;
    // `URL.origin` is the browser's own serialization: lowercased, punycode for
    // IDN, bracketed IPv6, scheme-default port omitted.
    const origin = u.origin.toLowerCase();
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Normalize an `Origin` header to its canonical key.
 * Returns null for anything that is not a parseable absolute URL — including
 * the opaque literal "null", which browsers send for sandboxed/`file:` origins
 * and which must never be treated as trusted.
 */
export function originHost(origin) {
  return originKey(origin);
}

/**
 * The machine's real mDNS/Bonjour name on macOS.
 *
 * `os.hostname()` can be a DHCP-provided FQDN (`mini.corp.example`) whose first
 * label differs from what Bonjour advertises (`Ryans-Mac-mini.local`), so
 * synthesizing `${short}.local` can trust a name nobody uses while omitting the
 * one operators actually browse. Reading it is best-effort: any failure falls
 * back to the synthesized form.
 */
let bonjourCache = null;
let bonjourResolved = false;
let bonjourResolveCount = 0; // test seam: how many times we actually resolved

export function bonjourName() {
  // MEMOIZED FOR THE PROCESS LIFETIME — this is a DoS guard, not a micro-opt.
  // The allowlist is rebuilt on every rejected Origin, and this spawns `scutil`
  // via execFileSync with a 1s timeout, which BLOCKS Bun's event loop. Without
  // the memo, any unauthenticated client could POST to the reply route with a
  // bad Origin in a loop and stall the whole monitor. The machine's Bonjour
  // name is stable for a process lifetime, so resolving it once is correct as
  // well as safe (a rename needs a daemon restart, like any other identity).
  if (bonjourResolved) return bonjourCache;
  bonjourResolved = true;
  bonjourResolveCount++;
  if (platform() !== "darwin") return (bonjourCache = null);
  try {
    const out = execFileSync("scutil", ["--get", "LocalHostName"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const name = out.trim().toLowerCase();
    return (bonjourCache = name === "" ? null : name);
  } catch {
    return (bonjourCache = null);
  }
}

/** Test seam: forget the memoized Bonjour name. */
export function _resetBonjourCache() {
  bonjourCache = null;
  bonjourResolved = false;
  bonjourResolveCount = 0;
}

/** Test seam: how many times the underlying lookup actually ran. */
export function _bonjourResolveCount() {
  return bonjourResolveCount;
}

/**
 * This machine's own non-loopback IP addresses.
 *
 * Included because operators routinely reach the monitor by IP rather than by
 * name — a LAN address or a Tailscale 100.x — and omitting them would 403 those
 * sessions. These are the addresses the server is bound and reachable on, so
 * trusting them adds no attacker-controlled input: a rebinding attack still
 * presents its OWN domain in `Origin`, not our address.
 */
export function selfAddresses() {
  const out = [];
  let ifaces;
  try {
    ifaces = networkInterfaces();
  } catch {
    return out; // never let interface enumeration break request handling
  }
  for (const addrs of Object.values(ifaces ?? {})) {
    for (const a of addrs ?? []) {
      if (!a || typeof a.address !== "string" || a.internal) continue;
      // IPv6 literals are bracketed in a URL host; strip any zone index (%en0),
      // which never appears in an Origin header.
      out.push(
        a.family === "IPv6" || a.address.includes(":")
          ? `[${a.address.split("%")[0]}]`
          : a.address
      );
    }
  }
  return out;
}

/**
 * The set of origins this server is legitimately reached by.
 *
 * PORT-QUALIFIED. Own names/addresses are trusted only ON THE BOUND PORT.
 * Trusting the bare host too would let any OTHER service on this machine
 * (`http://mini` on :80) drive the reply route, since a browser omits a
 * scheme-default port — a strictly wider surface than the check this replaces.
 * A proxy on :80/:443 is a real deployment, but it is stated explicitly through
 * `extraOrigins` rather than assumed for everyone.
 *
 * @param {{
 *   port?: number,
 *   extraOrigins?: string[] | string | null,
 *   hostnames?: string[],
 *   addresses?: string[],
 *   devOrigins?: string[] | string | null,
 *   bindHost?: string | null,
 *   strictLoopback?: boolean,
 * }} opts
 * @returns {Set<string>}
 */
export function buildTrustedOrigins(opts = {}) {
  const {
    port,
    extraOrigins = null,
    hostnames,
    addresses,
    devOrigins = null,
    bindHost = null,
    strictLoopback = false,
  } = opts;
  const out = new Set();
  const boundPort = Number.isFinite(port) ? Number(port) : null;

  /** Trust `host` on the bound port, under the scheme the monitor serves. */
  const addOwn = (host) => {
    if (typeof host !== "string" || host.trim() === "") return;
    const h = host.trim();
    const authority = boundPort === null ? h : `${h}:${boundPort}`;
    const key = originKey(`${DEFAULT_SCHEME}://${authority}`);
    if (key !== null) out.add(key);
  };

  // Loopback, restricted to the address family the server actually BOUND.
  // Binding 0.0.0.0 listens on IPv4 only, yet Bun lets an unrelated service bind
  // [::1] on the same port; trusting the IPv6 loopback literal would let content
  // served from http://[::1]:7400 POST to the IPv4 monitor and pass this guard.
  // (The `localhost` NAME stays trusted — which family it resolves to is the
  // browser's choice, and if it resolved to a family we are not on, the operator
  // could not reach us by that name in the first place.)
  const bind = (typeof bindHost === "string" ? bindHost.trim().toLowerCase() : "").replace(
    /^\[|\]$/g,
    ""
  );
  const isV6Wildcard = bind === "::"; // dual-stack: accepts IPv4-mapped too
  const isV6Literal = bind.includes(":"); // ANY v6 literal, not just ::/::1
  // A hostname bind (not an IP literal) is treated as a wildcard: we cannot
  // enumerate what it covers, and being permissive beats 403-ing the operator.
  const isIpLiteral = /^[0-9.]+$/.test(bind) || isV6Literal;
  const isWildcardBind = bind === "" || bind === "0.0.0.0" || isV6Wildcard || !isIpLiteral;
  const normalizeAddr = (a) => String(a ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  // Unknown bind -> stay permissive rather than 403 a legitimate operator.
  const bindsV4 = bind === "" || isV6Wildcard || !isV6Literal;
  // ANY IPv6 literal bind is IPv6-capable — including a specific global address
  // like 2001:db8::1. Treating only ::/::1 as v6 dropped the server's OWN
  // address from the allowlist and 403'd every legitimate reply to it.
  const bindsV6 = bind === "" || isV6Wildcard || isV6Literal;
  // The `localhost` NAME is family-ambiguous: the browser chooses. Under an
  // IPv4-only bind, a service squatting [::1]:<port> can serve a page whose
  // Origin is `http://localhost:<port>` and POST to our IPv4 address, so the
  // name is strictly weaker than the literals above.
  //
  // It is trusted by DEFAULT anyway, because dropping it would 403 the single
  // most common local access path (`http://localhost:7400`) on every IPv4-only
  // deployment — a certain, universal inertness failure — to close an attack
  // that first requires an adversary to run code locally and bind that port.
  // `strictLoopback` is the opt-in for deployments that prefer the opposite
  // trade; binding dual-stack (`::`) removes the squat window entirely.
  const dropAmbiguousLoopback = strictLoopback && !(bindsV4 && bindsV6);
  // A SPECIFIC bind owns exactly one socket. Bound to a LAN address, the monitor
  // does not own <loopback>:<port> — another service can hold it, serve a page
  // whose Origin would otherwise pass, and POST to us. So loopback is trusted
  // only for a wildcard bind, or when the bind IS the loopback address.
  const boundIsLoopback =
    isWildcardBind || normalizeAddr(bind) === "127.0.0.1" || normalizeAddr(bind) === "::1";
  const loopback = [];
  if (boundIsLoopback) {
    if (!dropAmbiguousLoopback) loopback.push("localhost");
    if (bindsV4) loopback.push("127.0.0.1");
    if (bindsV6) loopback.push("[::1]");
  }
  for (const h of loopback) addOwn(h);

  // This machine's own names. os.hostname() may be an FQDN ("mini.rozich") or a
  // short label; operators browse by either, plus the mDNS ".local" form.
  // Own NAMES resolve to whichever interface DNS/mDNS picks, which need not be
  // the one a specific bind listens on — so they are trusted only for a
  // wildcard bind. Bound to 127.0.0.1, trusting `mini` would accept a page
  // served by another process holding that port on the LAN interface.
  // `hostnames` is a test seam for what os.hostname() returns — it must not
  // exempt the caller from the bind rule, so the gate is applied either way.
  const selfNames = isWildcardBind ? (hostnames ?? [osHostname()]) : [];
  for (const raw of selfNames) {
    if (typeof raw !== "string" || raw === "") continue;
    // In strict mode a host literally NAMED `localhost` (common in containers)
    // would re-add the family-ambiguous origin that strictLoopback just removed.
    const isLoopbackName = (n) => n === "localhost" || n.startsWith("localhost.");
    const lowered = raw.toLowerCase();
    if (!(dropAmbiguousLoopback && isLoopbackName(lowered))) addOwn(raw);
    const short = lowered.split(".")[0];
    if (short !== "" && !(dropAmbiguousLoopback && isLoopbackName(short))) addOwn(short);
    // NOTE: `${short}.local` is deliberately NOT synthesized. When
    // os.hostname() is `mini.corp.example` but Bonjour advertises
    // `Ryans-Mac-mini.local`, nothing owns `mini.local` — so any LAN host can
    // claim it over mDNS, serve a page on the monitor's port, and its
    // `Origin: http://mini.local:7400` would pass an allowlist that had
    // fabricated that name. Only a `.local` the system actually advertises is
    // trusted (below); anything else belongs in MONITOR_TRUSTED_ORIGINS.
  }
  // The REAL Bonjour name, which need not share os.hostname()'s first label.
  const bonjour = hostnames === undefined && isWildcardBind ? bonjourName() : null;
  if (bonjour !== null) addOwn(bonjour.endsWith(".local") ? bonjour : `${bonjour}.local`);

  // This machine's own IPs (LAN, Tailscale 100.x), filtered to the bound family
  // for the same reason as the loopback literals: with an IPv4-only bind we do
  // not own this port in the v6 space, so another service could bind an IPv6
  // interface address there and its origin would otherwise be trusted.
  // Only a WILDCARD bind owns this port on every local interface. When the
  // server is bound to one specific address, another service can hold the same
  // port on a different interface, so trusting all same-family addresses would
  // hand that service an allowlisted Origin. A specific bind trusts only itself.
  const boundAddresses = isWildcardBind
    ? (addresses ?? selfAddresses())
    : (addresses ?? [isV6Literal ? `[${bind}]` : bind]).filter(
        (a) => normalizeAddr(a) === normalizeAddr(bind)
      );
  for (const addr of boundAddresses) {
    const isV6 = String(addr).startsWith("[") || String(addr).includes(":");
    if (isV6 ? bindsV6 : bindsV4) addOwn(addr);
  }

  const split = (v) =>
    typeof v === "string" ? v.split(/[,\s]+/) : Array.isArray(v) ? v : [];

  // Deployment-specific origins (reverse proxy, MagicDNS alias) and dev-server
  // origins. Taken EXACTLY as given — a full origin keeps its scheme, so
  // `https://catalyst.example` does NOT also trust the plaintext endpoint on
  // that host. A bare `host[:port]` cannot state a scheme, so it trusts both
  // (documented), which is why a full origin is the safer way to write one.
  for (const raw of [...split(extraOrigins), ...split(devOrigins)]) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const s = raw.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      const key = originKey(s);
      if (key !== null) out.add(key);
    } else {
      for (const scheme of ["http", "https"]) {
        const key = originKey(`${scheme}://${s}`);
        if (key !== null) out.add(key);
      }
    }
  }

  return out;
}

/**
 * Decide whether a request may perform a state-changing action.
 *
 * An ABSENT/empty `Origin` is allowed: browsers always attach `Origin` to a
 * POST, so the only clients omitting it are non-browser ones (curl, the tests,
 * the documented smoke checks) which are not subject to CSRF. This preserves
 * the pre-existing contract — the guard's job is to stop a BROWSER being used
 * as a confused deputy, not to authenticate callers. The route is unauthenticated
 * by design; adding auth is a separate concern.
 *
 * @param {string | null | undefined} origin  raw `Origin` header
 * @param {Set<string>} trusted               from buildTrustedOrigins()
 */
export function isOriginAllowed(origin, trusted) {
  if (origin == null || origin === "") return true;
  const key = originKey(origin);
  if (key === null) return false; // present but unparseable/opaque -> refuse
  return trusted.has(key);
}
