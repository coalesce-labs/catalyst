#!/usr/bin/env node
// node-presence.mjs — CTL-1272. NEW, ADDITIVE liveness source.
//
// Derives "is peer X up and healthy right now" from two real, already-running
// fleet substrates — Tailscale device presence + a peer-HTTP /healthz check over
// the tailnet — instead of the slow, rate-limited Linear-attachment heartbeat
// (CTL-1090). Three tiers:
//   1. reachable — Tailscale Online === true (network path exists)
//   2. up        — the peer answers /healthz over the tailnet
//   3. healthy   — that response reports a recent scheduler tick (not wedged)
//
// DORMANT in this ticket: this module has NO caller in the dispatch path. It is
// the clean seam CTL-1091's liveness-roster.mjs (effectiveLiveRoster) will later
// consume — swapping its input from readPeerHeartbeats to readLivePeers. The
// existing Linear-attachment heartbeat (cluster-heartbeat*.mjs) is left intact so
// nothing regresses; it may still feed the dashboard.
//
// HYSTERESIS (N-consecutive-observation flip) is OUT OF SCOPE here — it lives
// downstream in CTL-1091's liveness-roster.mjs. This module exposes a single
// point-in-time observation; the consumer wraps it with hysteresis.
//
// PURITY / INJECTABILITY (mirrors cluster-heartbeat.mjs / cluster-sync.mjs's
// "default real runner, override in opts" convention): the Tailscale exec and
// the HTTP fetch are both injectable so tests are hermetic — no real binary, no
// real network. The ONLY config touch is getHostName() for self-exclusion in
// readLivePeers (already env-redirectable via CATALYST_HOST_NAME). NO import of
// scheduler.mjs / daemon.mjs.
//
// FAIL-OPEN (the highest-risk correctness boundary): a *probe-infrastructure*
// error (tailscale binary missing / spawn failure / null status) must degrade to
// "assume live" — never mass-evict the fleet over our own inability to see. A
// *definitive negative*, however, is honored: a host present in Tailscale status
// with Online===false, or a clean /healthz response reporting unhealthy, is a
// real "not live".

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getHostName } from "./config.mjs";

// macOS ships the binary inside the app bundle; PATH `tailscale` is the fallback
// (Linux/CLI installs). Both are overridable via the exec seam.
const TAILSCALE_APP_BUNDLE_BIN =
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

// The monitor HTTP port the /healthz probe hits over the tailnet.
const DEFAULT_MONITOR_PORT = 7400;

// "Recent scheduler tick" staleness bound. The /healthz lastTickAgeMs is derived
// from node.heartbeat freshness (~30s cadence), so a generous default tolerates
// normal heartbeat jitter while still catching a wedged daemon. Overridable.
const DEFAULT_STALE_MS = 120_000;

// defaultExec — the production Tailscale runner. Resolves the app-bundle binary
// when present, else the PATH `tailscale`. Returns stdout as a string (the
// execFileSync utf8 contract). Throws on spawn failure / non-zero exit, which
// readTailscaleStatus catches and turns into null.
function defaultExec(file, args) {
  return execFileSync(file, args, { encoding: "utf8" });
}

function defaultTailscaleBin() {
  return existsSync(TAILSCALE_APP_BUNDLE_BIN)
    ? TAILSCALE_APP_BUNDLE_BIN
    : "tailscale";
}

// ─── readTailscaleStatus ─────────────────────────────────────────────────────

// Run `tailscale status --json` and parse it into { Self, Peer }. Returns null on
// ANY error (binary missing, non-JSON stdout) — never throws. A null return is a
// probe-infrastructure failure, which downstream fail-open treats as "assume
// live", NOT as "everyone is offline".
export function readTailscaleStatus({ exec = defaultExec, bin = defaultTailscaleBin() } = {}) {
  try {
    const stdout = exec(bin, ["status", "--json"]);
    const parsed = JSON.parse(String(stdout));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── tailscaleNameForRoster ──────────────────────────────────────────────────

// firstDnsLabel — "mini.tail32996b.ts.net." → "mini". Strips the leading label
// from a Tailscale DNSName (which may carry a trailing dot). Empty/garbage → "".
function firstDnsLabel(dnsName) {
  if (typeof dnsName !== "string" || dnsName.length === 0) return "";
  const trimmed = dnsName.replace(/^\.+/, "");
  const dot = trimmed.indexOf(".");
  const label = dot === -1 ? trimmed : trimmed.slice(0, dot);
  return label.trim();
}

// Map a Tailscale node (Self or a Peer entry) to its roster name. Precedence:
//   1. nameMap[HostName] (explicit operator override; e.g. RyansMini250233→mini)
//   2. DNSName first DNS label (mini.tail…→mini) — the working fallback, since
//      Tags are null fleet-wide (verified 2026-06-18), so tag-based mapping is
//      unusable this ticket. Tags are a future enhancement.
//   3. HostName verbatim (mini-2 already matches its roster name)
export function tailscaleNameForRoster(tsNode, { nameMap = {} } = {}) {
  if (!tsNode || typeof tsNode !== "object") return "";
  const hostName = typeof tsNode.HostName === "string" ? tsNode.HostName : "";
  if (hostName && Object.prototype.hasOwnProperty.call(nameMap, hostName)) {
    return nameMap[hostName];
  }
  const label = firstDnsLabel(tsNode.DNSName);
  if (label) return label;
  return hostName;
}

// ─── tailscaleOnline ─────────────────────────────────────────────────────────

// allNodes — yield every node entry in a status (Self + each Peer value).
function* allNodes(status) {
  if (!status || typeof status !== "object") return;
  if (status.Self) yield status.Self;
  const peers = status.Peer;
  if (peers && typeof peers === "object") {
    for (const node of Object.values(peers)) yield node;
  }
}

// True iff the roster host maps to a Tailscale node with Online===true. A host
// absent from the status (not Self, not any Peer) → false. A null status → false.
// NOTE: false here is "definitively not online" relative to a status we DID read;
// the fail-open posture lives in isHostLive, which distinguishes a null status
// (probe failure) from a status that simply lacks the host.
export function tailscaleOnline(status, rosterHost, { nameMap = {} } = {}) {
  if (!status) return false;
  for (const node of allNodes(status)) {
    if (tailscaleNameForRoster(node, { nameMap }) === rosterHost) {
      return node.Online === true;
    }
  }
  return false;
}

// ─── probePeerHealth ─────────────────────────────────────────────────────────

// GET <baseUrl>/healthz over the tailnet and classify the three tiers. Shape:
//   { reachable, up, healthy, daemonAlive, lastTickAgeMs }
//   - reachable: a 2xx response came back (network path + HTTP up)
//   - up:        the body parsed into a recognizable health object
//   - healthy:   daemonAlive === true AND lastTickAgeMs <= staleMs (not wedged)
// A fetch throw / non-2xx / unparseable body → { reachable:false, healthy:false }.
// NEVER throws. `host` is the roster name (informational — baseUrl already
// encodes the target); kept in the signature so callers read probePeerHealth(host,…)
// symmetrically with isHostLive/tailscaleOnline. `lastTickAgeMs` is server-computed
// (the /healthz endpoint reports the age), so no local clock is needed here.
export async function probePeerHealth(
  // eslint-disable-next-line no-unused-vars -- host documents the target (see header)
  host,
  { baseUrl, fetchImpl = fetch, staleMs = DEFAULT_STALE_MS } = {},
) {
  const notReachable = { reachable: false, up: false, healthy: false, daemonAlive: false, lastTickAgeMs: null };
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/healthz`, { method: "GET" });
  } catch {
    return notReachable;
  }
  if (!res || typeof res.status !== "number" || res.status < 200 || res.status >= 300) {
    return notReachable;
  }
  let body;
  try {
    body = await res.json();
  } catch {
    // 2xx but the body isn't JSON — the network is reachable but the daemon
    // isn't reporting a parseable health shape, so it is up-but-not-healthy.
    return { reachable: true, up: false, healthy: false, daemonAlive: false, lastTickAgeMs: null };
  }
  if (!body || typeof body !== "object") {
    return { reachable: true, up: false, healthy: false, daemonAlive: false, lastTickAgeMs: null };
  }
  const daemonAlive = body.daemonAlive === true;
  const lastTickAgeMs =
    typeof body.lastTickAgeMs === "number" ? body.lastTickAgeMs : null;
  const fresh = lastTickAgeMs != null && lastTickAgeMs <= staleMs;
  const healthy = daemonAlive && fresh;
  return { reachable: true, up: true, healthy, daemonAlive, lastTickAgeMs };
}

// ─── isHostLive ──────────────────────────────────────────────────────────────

// Combine Tailscale presence AND peer-HTTP health into a single observation:
//   live = online (Tailscale Online===true) AND healthy (/healthz fresh tick).
//
// FAIL-OPEN: if reading the Tailscale status itself fails at the infra level
// (exec spawn failure / null status), we cannot SEE the fleet → assume the host
// is live rather than mass-evict (source:"fail-open"). Likewise, if Tailscale
// says Online===true but the /healthz probe THROWS (network blip / fetch error,
// reachable:false), we degrade to assume-live rather than evict a host the tailnet
// believes is up. A DEFINITIVE negative is honored: Online===false (host present
// in a status we read, reporting offline) → not live; a clean /healthz response
// reporting unhealthy (reachable, parsed, but stale/dead daemon) → not live.
export async function isHostLive(host, opts = {}) {
  const {
    nameMap = {},
    exec = defaultExec,
    bin = defaultTailscaleBin(),
    baseUrl,
    fetchImpl = fetch,
    staleMs = DEFAULT_STALE_MS,
  } = opts;

  // Allow a pre-read status to be injected (so readLivePeers reads it ONCE);
  // otherwise read it here. A read failure → null → fail-open.
  const status =
    "status" in opts ? opts.status : readTailscaleStatus({ exec, bin });

  // FAIL-OPEN #1: we could not read presence at all → assume live.
  if (status == null) {
    return { live: true, online: null, reachable: null, healthy: null, lastTickAgeMs: null, source: "fail-open" };
  }

  const online = tailscaleOnline(status, host, { nameMap });

  // DEFINITIVE negative: Tailscale read fine and the host is Online===false (or
  // absent). Honor it — this is the signal that re-homes a dead host's work.
  if (!online) {
    return { live: false, online: false, reachable: false, healthy: false, lastTickAgeMs: null, source: "tailscale" };
  }

  // Online===true → probe /healthz.
  const probe = await probePeerHealth(host, { baseUrl, fetchImpl, staleMs });

  // FAIL-OPEN #2: Tailscale says Online but the probe couldn't even reach the
  // peer (fetch threw / network blip). Don't evict a host the tailnet believes
  // is up — degrade to assume-live.
  if (!probe.reachable) {
    return {
      live: true,
      online: true,
      reachable: false,
      healthy: null,
      lastTickAgeMs: null,
      source: "fail-open",
    };
  }

  // Reachable: now the /healthz verdict is authoritative (clean response).
  return {
    live: probe.healthy,
    online: true,
    reachable: true,
    healthy: probe.healthy,
    lastTickAgeMs: probe.lastTickAgeMs,
    source: "probe",
  };
}

// ─── readLivePeers ───────────────────────────────────────────────────────────

// Map isHostLive over the roster (MINUS self). Self is always treated live and
// is NEVER probed against itself — the local daemon evaluates its own health
// elsewhere, and the laptop's Tailscale HostName/DNSName don't match any roster
// name anyway (so trying to self-match in the status would mis-classify it).
//
// Reads the Tailscale status ONCE and threads it into every per-host call, so a
// roster of N peers costs one `tailscale status --json` + N /healthz GETs.
//
// Returns { [host]: { live, online, reachable, healthy, lastTickAgeMs|null, source } }.
export async function readLivePeers(roster, opts = {}) {
  const {
    nameMap = {},
    exec = defaultExec,
    bin = defaultTailscaleBin(),
    fetchImpl = fetch,
    staleMs = DEFAULT_STALE_MS,
    baseUrlFor = (host) => `http://${host}:${DEFAULT_MONITOR_PORT}`,
    self = getHostName(),
  } = opts;

  const status =
    "status" in opts ? opts.status : readTailscaleStatus({ exec, bin });

  const out = {};
  for (const host of Array.isArray(roster) ? roster : []) {
    if (host === self) {
      out[host] = {
        live: true,
        online: true,
        reachable: true,
        healthy: true,
        lastTickAgeMs: null,
        source: "self",
      };
      continue;
    }
    out[host] = await isHostLive(host, {
      status,
      nameMap,
      baseUrl: baseUrlFor(host),
      fetchImpl,
      staleMs,
    });
  }
  return out;
}
