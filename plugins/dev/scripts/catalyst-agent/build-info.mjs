// build-info.mjs (CTL-1235) — resolve the RUNNING Catalyst build identity for
// telemetry. Three signals:
//   service.version          semver from the agent's own plugin.json (OTel
//                            semconv `service.version`; the running artifact)
//   vcs.ref.head.revision    git commit short-SHA of the agent's checkout (OTel
//                            semconv VCS `vcs.ref.head.revision`)
//   commits-behind-main      how far HEAD is behind origin/main (drift)
//
// version + commit are IMMUTABLE for the process lifetime, so they are resolved
// ONCE and cached. commits-behind changes as main advances, so it is recomputed
// per call (with an optional network fetch). All resolvers degrade to null on
// any error (missing git, detached checkout, offline) — telemetry must never
// crash the agent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// Run a git command in the agent's own checkout (git -C walks up to the repo
// root). Returns trimmed stdout, or null on any failure.
function git(args) {
  try {
    const out = execFileSync("git", ["-C", MODULE_DIR, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

let _version; // undefined = unresolved · null = resolved-absent · string = value
/** OTel semconv `service.version` — semver from the agent's plugin.json. Cached. */
export function serviceVersion() {
  if (_version !== undefined) return _version;
  try {
    const p = new URL("../../.claude-plugin/plugin.json", import.meta.url);
    _version = JSON.parse(readFileSync(p, "utf8")).version ?? null;
  } catch {
    _version = null;
  }
  return _version;
}

let _rev;
/** OTel semconv `vcs.ref.head.revision` — git short-SHA of the running checkout. Cached. */
export function vcsRevision() {
  if (_rev !== undefined) return _rev;
  _rev = git(["rev-parse", "--short", "HEAD"]);
  return _rev;
}

/**
 * commitsBehindMain — how many commits HEAD is behind origin/main. Fetches first
 * (network) unless {fetch:false}. Returns a non-negative integer, or null when
 * git / the remote / the network is unavailable (omit the gauge rather than lie).
 */
export function commitsBehindMain({ fetch = true } = {}) {
  if (fetch) git(["fetch", "--quiet", "origin", "main"]);
  const n = git(["rev-list", "--count", "HEAD..origin/main"]);
  if (n === null) return null;
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

// Test-only: clear the version/commit caches so a test can re-resolve.
export function __resetCaches() {
  _version = undefined;
  _rev = undefined;
}
