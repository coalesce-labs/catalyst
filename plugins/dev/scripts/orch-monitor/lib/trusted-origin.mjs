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
    if (u.hostname === "" || u.protocol === "file:") return null;
    // `URL.origin` is the browser's own serialization: lowercased, punycode for
    // IDN, bracketed IPv6, scheme-default port omitted.
    return u.origin.toLowerCase();
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
export function bonjourName() {
  if (platform() !== "darwin") return null;
  try {
    const out = execFileSync("scutil", ["--get", "LocalHostName"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const name = out.trim().toLowerCase();
    return name === "" ? null : name;
  } catch {
    return null;
  }
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
 * }} opts
 * @returns {Set<string>}
 */
export function buildTrustedOrigins(opts = {}) {
  const { port, extraOrigins = null, hostnames, addresses, devOrigins = null } = opts;
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

  for (const h of ["localhost", "127.0.0.1", "[::1]"]) addOwn(h);

  // This machine's own names. os.hostname() may be an FQDN ("mini.rozich") or a
  // short label; operators browse by either, plus the mDNS ".local" form.
  const selfNames = hostnames ?? [osHostname()];
  for (const raw of selfNames) {
    if (typeof raw !== "string" || raw === "") continue;
    addOwn(raw);
    const short = raw.toLowerCase().split(".")[0];
    if (short !== "") {
      addOwn(short);
      addOwn(`${short}.local`);
    }
  }
  // The REAL Bonjour name, which need not share os.hostname()'s first label.
  const bonjour = hostnames === undefined ? bonjourName() : null;
  if (bonjour !== null) addOwn(bonjour.endsWith(".local") ? bonjour : `${bonjour}.local`);

  // This machine's own IPs (LAN, Tailscale 100.x).
  for (const addr of addresses ?? selfAddresses()) addOwn(addr);

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
