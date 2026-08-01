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
// cover loopback plus this machine's own names and addresses, and
// MONITOR_TRUSTED_ORIGINS is the documented escape hatch for any
// deployment-specific name (reverse proxy, MagicDNS alias).

import { hostname as osHostname, networkInterfaces } from "node:os";

/**
 * Parse a host or a full origin into its canonical `{ host, port }`.
 *
 * Canonicalization goes through `URL` rather than a bare `toLowerCase()` so
 * allowlist entries are compared in the SAME form a browser serializes an
 * Origin in. Without it an IDN entry (`münchen.local`) would be stored verbatim
 * while the browser sends punycode (`xn--mnchen-3ya.local`), and every
 * legitimate reply from that host would 403 — the inertness failure mode again.
 * `URL` also normalizes IPv6 (including IPv4-mapped forms) and drops a
 * scheme-default port, matching how Origin is serialized.
 */
function parseHostish(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "" || s === "null") return null;
  // Accept both "https://host:port" and a bare "host:port".
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.hostname === "") return null;
    return { host: u.host.toLowerCase(), port: u.port };
  } catch {
    return null;
  }
}

/**
 * Normalize an origin to its comparable `host[:port]`.
 * Returns null for anything that is not a parseable absolute URL — including
 * the opaque literal "null", which browsers send for sandboxed/`file:` origins
 * and which must never be treated as trusted.
 */
export function originHost(origin) {
  if (typeof origin !== "string" || origin === "" || origin === "null") return null;
  // An Origin is always absolute; a bare "mini:7400" is not a valid Origin and
  // must not be accepted, so this does NOT reuse parseHostish's bare-host path.
  try {
    const u = new URL(origin);
    if (u.hostname === "" || u.protocol === "file:") return null;
    return u.host.toLowerCase();
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
 * trusting them adds no attacker-controlled input: an attacker cannot make
 * `evil.example` resolve to a name in this list, and a rebinding attack still
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
 * The set of `host[:port]` values this server is legitimately reached by.
 *
 * PORT-QUALIFIED BY DEFAULT. Own names/addresses are trusted only ON THE BOUND
 * PORT. Trusting the bare host too would mean any OTHER service on this machine
 * — `http://mini` on :80 — could drive the reply route, since a browser
 * serializes that Origin as `http://mini` with no port. That is a strictly
 * wider surface than the check this replaces, so it is not the default. A
 * reverse proxy on :80/:443 is a real deployment, but it is expressed
 * explicitly through `extraOrigins` rather than assumed for everyone. (When the
 * bound port IS 80/443 the bare form is added, because the browser omits a
 * scheme-default port and the two forms then denote the same endpoint.)
 *
 * @param {{ port?: number, extraOrigins?: string[] | string | null, hostnames?: string[], addresses?: string[] }} opts
 * @returns {Set<string>}
 */
export function buildTrustedOrigins(opts = {}) {
  const { port, extraOrigins = null, hostnames, addresses } = opts;
  const out = new Set();
  const boundPort = Number.isFinite(port) ? Number(port) : null;

  /** Trust `name` only on the bound port (see PORT-QUALIFIED above). */
  const addOwn = (name) => {
    const parsed = parseHostish(name);
    if (parsed === null) return;
    if (parsed.port !== "") {
      out.add(parsed.host); // caller pinned a port explicitly
      return;
    }
    if (boundPort === null) {
      out.add(parsed.host);
      return;
    }
    out.add(`${parsed.host}:${boundPort}`);
    // A browser omits a scheme-default port from Origin, so on 80/443 the bare
    // form IS the bound endpoint rather than a different service.
    if (boundPort === 80 || boundPort === 443) out.add(parsed.host);
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

  // This machine's own IPs (LAN, Tailscale 100.x).
  for (const addr of addresses ?? selfAddresses()) addOwn(addr);

  // Deployment-specific origins (reverse proxy, Tailscale MagicDNS, an alias).
  // Taken EXACTLY as given, canonicalized: an operator who writes
  // "https://catalyst.example" means port 443 (bare host in Origin), and one who
  // writes "mini-2:7400" means that port. We do not add the bound port to these
  // — the whole point is that they are reached on some other endpoint.
  const extras =
    typeof extraOrigins === "string"
      ? extraOrigins.split(/[,\s]+/)
      : Array.isArray(extraOrigins)
        ? extraOrigins
        : [];
  for (const raw of extras) {
    const parsed = parseHostish(raw);
    if (parsed !== null) out.add(parsed.host);
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
