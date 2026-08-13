// build-info.mjs (CTL-1235) — resolve the RUNNING Catalyst build identity for
// telemetry. Three signals:
//   service.version          semver from the agent's own plugin.json (OTel
//                            semconv `service.version`; the running artifact)
//   vcs.ref.head.revision    git commit short-SHA of the agent's checkout (OTel
//                            semconv VCS `vcs.ref.head.revision`)
//   commits-behind-main      how far each EXECUTING checkout is behind origin/main
//
// version + commit are IMMUTABLE for the process lifetime, so they are resolved
// ONCE and cached. commits-behind changes as main advances, so it is recomputed
// per call (with an optional network fetch). All resolvers degrade to null on
// any error (missing git, detached checkout, offline) — telemetry must never
// crash the agent.
//
// ─── CTL-1825: WHERE the currency question is asked ────────────────────────────
//
// commits-behind used to be measured with `git -C MODULE_DIR`, i.e. against the
// tree containing THIS FILE. That answers "is the tree the agent lives in
// current?", which is a different question from "is the code this host runs
// current?" whenever those trees differ — and on this fleet they differ BY
// DESIGN: worker nodes execute from `~/catalyst/plugin-source`, while the
// laptop's `com.catalyst.agent` plist runs the agent out of the dev working
// checkout. Measured 2026-08-13 on the laptop:
//
//   git -C ~/code-repos/.../catalyst  rev-list --count HEAD..origin/main  →  0
//   git -C ~/catalyst/plugin-source   rev-list --count HEAD..origin/main  → 24
//
// The gauge read a healthy 0 while the tree actually running health-responder,
// orphan-sweep and log-shipper was 24 behind — not merely imprecise, but
// structurally incapable of being non-zero on a host whose agent checkout is the
// one being kept current. A gauge that can only report 0 is worse than no gauge:
// it is affirmative evidence of currency where none exists.
//
// So the measurement is now taken once per EXECUTING ROOT, and the roots come
// from CTL-1808's `resolveExecutingRoots` — the same enumeration the checkout-sync
// pass fast-forwards. Deliberately one enumeration and not two: a root the syncer
// keeps current that the gauge cannot see (or the reverse) is the same silent gap
// in a new place. The revision/version signals stay MODULE_DIR-scoped, correctly
// — those describe the running artifact, which IS this tree.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
// The ONE execution-core import the standalone agent makes (see README): a pure,
// node:*-only leaf carrying the checkout enumeration. It pulls in no config, no
// emit transport, and no npm dependency, so the agent still runs unchanged under
// bare `node` with no node_modules.
import { resolveExecutingRoots } from "../execution-core/checkout-sync.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// Run a git command in a given checkout (git -C walks up to the repo root).
// Returns trimmed stdout, or null on any failure.
function gitAt(root, args) {
  try {
    const out = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// Run a git command in the agent's OWN checkout — the running artifact's identity
// (version, revision), which is genuinely a property of this tree.
const git = (args) => gitAt(MODULE_DIR, args);

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
 * executingRoots — the checkouts this host actually runs code from. A thin pass-through
 * to CTL-1808's `resolveExecutingRoots` (registry repoRoots ∪ this checkout ∪ Layer-2
 * `catalyst.checkouts[]` ∪ `<CATALYST_DIR>/plugin-source`), re-exported here so the
 * sampler has one import and so this file names the dependency explicitly rather than
 * reaching across the tree at its call site. NOT cached: an operator who enrols a repo
 * mid-flight should see it on the next tick, and the agent runs `--once` anyway.
 */
export function executingRoots(opts) {
  return resolveExecutingRoots(opts);
}

/**
 * commitsBehindByRoot — how many commits each executing root is behind origin/main,
 * ONE measurement per root. Fetches each root first (network) unless {fetch:false}.
 *
 * Returns `[{root, behind}]`, `behind` a non-negative integer or **null** when git /
 * the remote / the network is unavailable for that root. Null is preserved per-root
 * rather than collapsed: an unreadable checkout must drop its own series, not
 * contribute a 0 that reads as "current", and not suppress the roots that DID measure.
 *
 * COST — this went from one fetch per tick to one per root. Measured on the laptop
 * (11 roots, real network): **8.6s**, against a 300s StartInterval. The worst case is
 * bounded by `roots × 2 × 15s` (the two git timeouts) with no network at all, and even
 * then nothing piles up: launchd will not start a second `--once` of the same label
 * while one is running, so a slow tick costs a sample, never a process.
 *
 * Deliberately NO per-sweep time budget. A budget would have to cut the sweep short
 * somewhere, and the enumeration puts `<CATALYST_DIR>/plugin-source` LAST — so the one
 * root this ticket exists to measure is exactly the one a budget would starve first.
 * A blind spot in the same place, reintroduced by the guard against a cost that measures
 * 8.6s, is a bad trade.
 */
export function commitsBehindByRoot({ fetch = true, roots = executingRoots(), gitIn = gitAt } = {}) {
  return (roots ?? []).map((root) => {
    if (fetch) gitIn(root, ["fetch", "--quiet", "origin", "main"]);
    const n = gitIn(root, ["rev-list", "--count", "HEAD..origin/main"]);
    const v = n === null ? NaN : Number(n);
    return { root, behind: Number.isFinite(v) && v >= 0 ? v : null };
  });
}

/**
 * commitsBehindMain — the host's single code-currency number: the MAXIMUM commits-behind
 * across every executing root. Never the agent's own root, and never an average — a fleet
 * is only as current as its stalest tree, and any aggregate that a current root can pull
 * down is the same false-zero this ticket removed. Returns null when NO root resolved
 * (omit the gauge rather than lie).
 */
export function commitsBehindMain(opts = {}) {
  const measured = commitsBehindByRoot(opts)
    .map((r) => r.behind)
    .filter((n) => typeof n === "number");
  return measured.length === 0 ? null : Math.max(...measured);
}

// Test-only: clear the version/commit caches so a test can re-resolve.
export function __resetCaches() {
  _version = undefined;
  _rev = undefined;
}
