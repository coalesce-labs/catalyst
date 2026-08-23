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

const DEFAULT_SCHEME = "http";
// Sentinel for "any 127.0.0.0/8 address on this port". A \u0000 prefix can never
// collide with a real origin key, which is always `scheme://host[:port]`.
const LOOPBACK_V4_MARKER = "\u0000loopback-v4:"; // the monitor serves plaintext; TLS is a front-end concern

/**
 * Is `bind` some spelling of the IPv4 unspecified address (0.0.0.0)?
 *
 * Bun accepts short and non-decimal forms — `0`, `0.0`, `0.0.0`, `00`, `0x0` —
 * and they are all the wildcard. Classifying one as SPECIFIC is the damaging
 * direction: the specific-bind branches then keep only the unusable
 * `http://0.0.0.0:<port>` origin and 403 every reachable one. Parsed
 * numerically rather than pattern-matched so new spellings cannot slip through.
 */
function isUnspecifiedV4(bind) {
  if (bind === "" || bind.includes(":")) return false;
  const parts = bind.split(".");
  if (parts.length > 4) return false;
  return parts.every((p) => p !== "" && Number(p) === 0);
}

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
let bonjourResolvedAt = 0;
let bonjourResolveCount = 0; // test seam: how many times we actually resolved
// Long enough that a request flood cannot turn this into a subprocess DoS
// (the reason it is memoized at all), short enough that a renamed LocalHostName
// stops being trusted while the KeepAlive daemon keeps running — otherwise the
// retired `.local` name stays allowlisted forever and is claimable once freed.
const BONJOUR_TTL_MS = 300_000;

export function bonjourName() {
  // MEMOIZED FOR THE PROCESS LIFETIME — this is a DoS guard, not a micro-opt.
  // The allowlist is rebuilt on every rejected Origin, and this spawns `scutil`
  // via execFileSync with a 1s timeout, which BLOCKS Bun's event loop. Without
  // the memo, any unauthenticated client could POST to the reply route with a
  // bad Origin in a loop and stall the whole monitor. The machine's Bonjour
  // name is stable for a process lifetime, so resolving it once is correct as
  // well as safe (a rename needs a daemon restart, like any other identity).
  if (bonjourResolved && performance.now() - bonjourResolvedAt < BONJOUR_TTL_MS) {
    return bonjourCache;
  }
  bonjourResolved = true;
  bonjourResolvedAt = performance.now();
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
  bonjourResolvedAt = 0;
  bonjourResolveCount = 0;
}

/** Test seam: the memo TTL, so a test can assert it is bounded. */
export function _bonjourTtlMs() {
  return BONJOUR_TTL_MS;
}

/** Test seam: how many times the underlying lookup actually ran. */
export function _bonjourResolveCount() {
  return bonjourResolveCount;
}

/**
 * This machine's Tailscale MagicDNS name (`<host>.<tailnet>.ts.net`), or null.
 *
 * A fleet reached over Tailscale is routinely browsed by this name rather than
 * by `os.hostname()` or the Bonjour `.local` name — neither of which matches
 * it, so without deriving it every host 403s every reply identically (observed
 * live across a multi-host fleet, each browsed as `<name>.<tailnet>.ts.net`).
 * Reading it is best-effort, mirroring `bonjourName()`: any failure (Tailscale
 * not installed, not running, CLI not found) falls back to null rather than
 * throwing, so a non-Tailscale deployment is unaffected.
 */
let tailscaleCache = null;
let tailscaleResolved = false;
let tailscaleResolvedAt = 0;
let tailscaleResolveCount = 0; // test seam: how many times we actually resolved
// Same DoS-guard + staleness rationale as BONJOUR_TTL_MS.
const TAILSCALE_TTL_MS = 300_000;
// The CLI's install location varies by platform/install method; `tailscale` on
// PATH covers Linux/Homebrew, the app-bundle path covers a GUI-only macOS
// install (confirmed: a GUI-only macOS install has no `tailscale` on PATH,
// only this app-bundle binary).
const TAILSCALE_CLI_CANDIDATES = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
];

export function tailscaleMagicDnsName() {
  // MEMOIZED FOR THE PROCESS LIFETIME — same DoS guard as bonjourName(): the
  // allowlist rebuilds on every rejected Origin, and this spawns a subprocess
  // (1s timeout) that blocks Bun's event loop. The MagicDNS name is stable for
  // a process lifetime (a tailnet rename needs a daemon restart, like any
  // other identity), so resolving it once is correct as well as safe.
  if (tailscaleResolved && performance.now() - tailscaleResolvedAt < TAILSCALE_TTL_MS) {
    return tailscaleCache;
  }
  tailscaleResolved = true;
  tailscaleResolvedAt = performance.now();
  tailscaleResolveCount++;
  for (const bin of TAILSCALE_CLI_CANDIDATES) {
    try {
      const out = execFileSync(bin, ["status", "--json"], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const dnsName = JSON.parse(out)?.Self?.DNSName;
      if (typeof dnsName !== "string" || dnsName === "") return (tailscaleCache = null);
      // MagicDNS names are DNS-absolute (trailing dot); Origin never carries one.
      return (tailscaleCache = dnsName.replace(/\.$/, "").toLowerCase());
    } catch {
      continue; // this candidate isn't the right binary/isn't installed — try the next
    }
  }
  return (tailscaleCache = null);
}

/** Test seam: forget the memoized MagicDNS name. */
export function _resetTailscaleCache() {
  tailscaleCache = null;
  tailscaleResolved = false;
  tailscaleResolvedAt = 0;
  tailscaleResolveCount = 0;
}

/** Test seam: how many times the underlying lookup actually ran. */
export function _tailscaleResolveCount() {
  return tailscaleResolveCount;
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
 *   tailscaleDnsName?: string | null,
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
    tailscaleDnsName,
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
  const isV6Literal = bind.includes(":"); // ANY v6 literal, not just ::/::1
  // Every spelling of the IPv6 unspecified address is the dual-stack wildcard:
  // `::`, `::0`, and the fully expanded `0:0:0:0:0:0:0:0`. An exact-string
  // check treated the latter two as a SPECIFIC address, which then kept only
  // the unusable unspecified-address origin and 403'd every real one.
  const isV6Wildcard = isV6Literal && /^[0:]+$/.test(bind);
  const isIpLiteral = /^[0-9.]+$/.test(bind) || isV6Literal;
  // A HOSTNAME bind resolves to a specific interface, so it is NOT a wildcard —
  // treating it as one trusted every local address and self-name while the
  // server owned only one socket. We cannot enumerate what it resolves to, so a
  // hostname bind trusts that name (and loopback if the name IS loopback) and
  // nothing else; anything further belongs in MONITOR_TRUSTED_ORIGINS.
  const isHostnameBind = bind !== "" && !isIpLiteral;
  // Bun accepts short IPv4 wildcard spellings too — `0`, `0.0`, `0.0.0` are all
  // 0.0.0.0. An exact comparison called them SPECIFIC, which then kept only the
  // unusable unspecified-address origin and 403'd every real one.
  const isV4Wildcard = isUnspecifiedV4(bind);
  const isWildcardBind = bind === "" || isV4Wildcard || isV6Wildcard;
  const normalizeAddr = (a) => String(a ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  // Unknown bind -> stay permissive rather than 403 a legitimate operator.
  const bindsV4 = bind === "" || isV6Wildcard || !isV6Literal;
  // ANY IPv6 literal bind is IPv6-capable — including a specific global address
  // like 2001:db8::1. Treating only ::/::1 as v6 dropped the server's OWN
  // address from the allowlist and 403'd every legitimate reply to it.
  const bindsV6 = bind === "" || isV6Wildcard || isV6Literal;
  // RESIDUAL, ACCEPTED: the `localhost` NAME (and this host's own names) are
  // family-ambiguous — the browser chooses. Under a single-family bind, a
  // process squatting the OTHER family's <port> can serve a page whose Origin
  // is one of these names and POST to us.
  //
  // This is not closed by an allowlist knob, and an earlier opt-in that tried
  // (MONITOR_STRICT_LOOPBACK) was removed: it was off by default, so it
  // protected nobody, while every name source it touched needed its own
  // family-scoping and it silently broke both container hosts named `localhost`
  // and the dev proxy. The real fix is to BIND DUAL-STACK (`::`), which makes
  // the squat impossible rather than merely untrusted — documented in the
  // configuration reference.
  // A SPECIFIC bind owns exactly one socket. Bound to a LAN address, the monitor
  // does not own <loopback>:<port> — another service can hold it, serve a page
  // whose Origin would otherwise pass, and POST to us. So loopback is trusted
  // only for a wildcard bind, or when the bind IS the loopback address.
  // Loopback LITERALS are added only when we KNOW the family: a wildcard bind
  // (we own both) or a loopback literal bind. A loopback NAME bind
  // (MONITOR_HOST=localhost) is family-ambiguous — Bun may have bound ::1 — so
  // adding 127.0.0.1 would be a guess, and another process can own the literal
  // we guessed wrong about. The NAME itself is still trusted (added via the
  // hostname-bind path below), which is what the operator actually browses.
  const boundIsLoopbackLiteral =
    normalizeAddr(bind) === "127.0.0.1" || normalizeAddr(bind) === "::1";
  const boundIsLoopback = isWildcardBind || boundIsLoopbackLiteral;
  const loopback = [];
  if (boundIsLoopback) {
    loopback.push("localhost");
    if (bindsV4) loopback.push("127.0.0.1");
    if (bindsV6) loopback.push("[::1]");
  }
  for (const h of loopback) addOwn(h);
  // The ENTIRE 127.0.0.0/8 range reaches an IPv4 wildcard bind — 127.0.0.2 and
  // the Debian-conventional 127.0.1.1 among them — and selfAddresses() excludes
  // internal interfaces, so an operator opening the monitor through one would
  // get a 403. A range cannot be enumerated into a Set, so a marker records the
  // permission and isOriginAllowed expands it (see LOOPBACK_V4_MARKER).
  if (isWildcardBind && bindsV4 && boundPort !== null) {
    out.add(`${LOOPBACK_V4_MARKER}${boundPort}`);
  }

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
    addOwn(raw);
    const short = raw.toLowerCase().split(".")[0];
    if (short !== "") addOwn(short);
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

  // This machine's Tailscale MagicDNS name — the name operators actually type
  // when the fleet is reached over Tailscale, and neither os.hostname() nor the
  // Bonjour name. Same wildcard-bind gate as Bonjour and `hostnames` above: it
  // is an own-name, not an address, so trusting it makes sense only when this
  // port is owned on every interface — applied unconditionally, whether the
  // value comes from live resolution or the `tailscaleDnsName` test seam.
  // `=== undefined` (not merely falsy) is the seam convention, matching
  // `hostnames` — an explicit `null` opts out even on a wildcard bind.
  const tailscale = isWildcardBind
    ? tailscaleDnsName === undefined
      ? tailscaleMagicDnsName()
      : tailscaleDnsName
    : null;
  if (tailscale !== null && tailscale !== undefined) addOwn(tailscale);

  // This machine's own IPs (LAN, Tailscale 100.x), filtered to the bound family
  // for the same reason as the loopback literals: with an IPv4-only bind we do
  // not own this port in the v6 space, so another service could bind an IPv6
  // interface address there and its origin would otherwise be trusted.
  // Only a WILDCARD bind owns this port on every local interface. When the
  // server is bound to one specific address, another service can hold the same
  // port on a different interface, so trusting all same-family addresses would
  // hand that service an allowlisted Origin. A specific bind trusts only itself.
  // A hostname bind trusts the NAME the operator bound, and nothing derived.
  if (isHostnameBind) addOwn(bind);
  const boundAddresses = isWildcardBind
    ? (addresses ?? selfAddresses())
    : isHostnameBind
      ? []
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
  if (trusted.has(key)) return true;
  // Expand the 127.0.0.0/8 marker, if the allowlist carries one for this port.
  const m = /^http:\/\/(127\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d+))?$/.exec(key);
  if (m === null) return false;
  const octets = m[1].split(".").map(Number);
  if (octets.some((o) => o > 255)) return false;
  const port = m[2] ?? "80";
  return trusted.has(`${LOOPBACK_V4_MARKER}${port}`);
}
