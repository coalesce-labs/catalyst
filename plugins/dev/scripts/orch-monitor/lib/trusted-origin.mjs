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
// ATTACKER CANNOT INFLUENCE: the set of names this server is legitimately
// reached by. `evil.example:7400` is not one of them, so step 5 becomes a 403.
//
// INERTNESS IS THE OTHER FAILURE MODE. If the allowlist omits the name the
// operator actually browses (mini:7400, mini.local:7400, a Tailscale name), the
// reply surface 403s for real use and the feature ships dead. So the defaults
// cover loopback plus this machine's own names, and MONITOR_TRUSTED_ORIGINS is
// the documented escape hatch for any deployment-specific name.

import { hostname as osHostname, networkInterfaces } from "node:os";

/**
 * This machine's own non-loopback IP addresses.
 *
 * Included because operators routinely reach the monitor by IP rather than by
 * name — a LAN address or a Tailscale 100.x — and omitting them would 403 those
 * sessions (the inertness failure mode). These are the addresses the server is
 * bound and reachable on, so trusting them adds no attacker-controlled input:
 * an attacker cannot make `evil.example` resolve to a name in this list, and a
 * rebinding attack still presents its OWN domain in `Origin`, not our IP.
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
      out.push(a.family === "IPv6" || a.address.includes(":")
        ? `[${a.address.split("%")[0]}]`
        : a.address);
    }
  }
  return out;
}

/**
 * Normalize an origin to its comparable `host[:port]`.
 * Returns null for anything that is not a parseable absolute URL — including
 * the opaque literal "null", which browsers send for sandboxed/`file:` origins
 * and which must never be treated as trusted.
 */
export function originHost(origin) {
  if (typeof origin !== "string" || origin === "" || origin === "null") return null;
  try {
    const u = new URL(origin);
    // A URL like "foo" parses only with a scheme; require a real host so that
    // e.g. "mailto:x" or a bare word can never produce a match.
    return u.host === "" ? null : u.host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The set of `host[:port]` values this server is legitimately reached by.
 *
 * Both the bare host and the `host:port` form are included: a browser omits the
 * port from `Origin` when it is the scheme default (80/443), so a monitor
 * fronted by a reverse proxy on :80 sends `Origin: http://mini` while the
 * server's own port is 7400.
 *
 * @param {{ port?: number, extraOrigins?: string[] | string | null, hostnames?: string[], addresses?: string[] }} opts
 * @returns {Set<string>}
 */
export function buildTrustedOrigins(opts = {}) {
  const { port, extraOrigins = null, hostnames, addresses } = opts;
  const out = new Set();

  const addHost = (h) => {
    if (typeof h !== "string") return;
    const host = h.trim().toLowerCase();
    if (host === "") return;
    out.add(host);
    if (port != null && Number.isFinite(port)) {
      // IPv6 literals must stay bracketed when a port is appended.
      out.add(host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`);
    }
  };

  for (const h of ["localhost", "127.0.0.1", "::1", "[::1]"]) addHost(h);

  // This machine's own names. os.hostname() may be an FQDN ("mini.rozich") or a
  // short label; operators browse by either, plus the mDNS ".local" form.
  const selfNames = hostnames ?? [osHostname()];
  for (const raw of selfNames) {
    if (typeof raw !== "string" || raw === "") continue;
    const name = raw.toLowerCase();
    addHost(name);
    const short = name.split(".")[0];
    addHost(short);
    addHost(`${short}.local`);
  }

  // This machine's own IPs (LAN, Tailscale 100.x) — operators reach the monitor
  // by address as often as by name.
  for (const addr of addresses ?? selfAddresses()) addHost(addr);

  // Deployment-specific names (reverse proxy, Tailscale MagicDNS, an alias).
  // Accepts full origins ("https://catalyst.example") or bare hosts, comma- or
  // whitespace-separated, so the env var is forgiving about format.
  const extras =
    typeof extraOrigins === "string"
      ? extraOrigins.split(/[,\s]+/)
      : Array.isArray(extraOrigins)
        ? extraOrigins
        : [];
  for (const raw of extras) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const parsed = originHost(raw);
    addHost(parsed ?? raw);
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
  const host = originHost(origin);
  if (host === null) return false; // present but unparseable/opaque -> refuse
  return trusted.has(host);
}
