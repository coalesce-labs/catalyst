// github-feed-mode.mjs — CTL-1929: the canonical `CATALYST_GITHUB_FEED` resolver.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
// Three processes need to know whether the GitHub cloud feed is authoritative on
// this host, and they do not share a runtime:
//   * `execution-core/daemon.mjs` (bun) — decides whether to run the producer
//   * `broker/tailer.mjs`         (bun) — decides whether to suppress smee
//   * `orch-monitor/server.ts`    (bun) — decides whether to OPEN the smee tunnel
//   * `execution-core/doctor.mjs` (bare Node) — grades the ingestion route
//
// ⚠️ THE STATED REASON FOR A LEAF HERE IS NOT THE ONE I FIRST WROTE, AND THE
// DIFFERENCE IS WORTH RECORDING. `lib/deployment-mode.mjs`'s header says
// `execution-core/config.mjs`'s import chain reaches `bun:sqlite` via
// `linear-query.mjs` and that doctor's bare-Node runtime therefore rejects it. I
// repeated that and then measured it: **config.mjs LOADS under bare Node today**
// (`node -e "import('.../config.mjs')"` succeeds; pino degrades to its console
// shim). That comment is stale — the sqlite reach became lazy at some point.
// `github-feed-gate.mjs` and `github-feed-source.mjs` genuinely DO reject, so the
// sibling `lib/github-feed-names.mjs` leaf is load-bearing for that reason; this
// one is not.
//
// ⛔ IT IS STILL A LEAF, FOR A REASON THAT DOES HOLD: four readers in three
// processes must resolve one flag identically, and `config.mjs` is a bun-oriented
// module that orch-monitor's own header already argues against importing for a
// value it can get from a leaf. Zero-import (node:fs / node:os / node:path only),
// the same shape `lib/deployment-mode.mjs` uses.
//
// The general form, since it cost me a wrong comment: a comment asserting another
// module's load behaviour is a measurement with no test behind it. Re-measure
// before repeating one.
//
// ⛔ AND `config.mjs` DELEGATES TO THIS FILE RATHER THAN KEEPING ITS OWN COPY.
// Two independent readers of one flag is the failure this feature can least afford:
// the producer emitting real events because it read `enforce` while the tunnel gate
// read something else and kept smee open is a double dispatch on every covered
// name, and it would look like a parity bug rather than a config bug.
//
// ── ENV-VS-FILE ASYMMETRY — the same caveat deployment-mode.mjs states ──────
// Layer-2 FILE edits are picked up live (every call re-reads from disk). The ENV
// var is captured into a long-lived process exactly once, at launch. A running
// daemon keeps resolving its OLD value until restarted.
//
// ⚠️ That caveat is sharper here than for deployment mode, because this flag has
// FOUR readers in THREE processes. Flipping it and restarting only execution-core
// leaves the producer emitting real `github.*` names while the broker's gate and
// the tunnel gate are still on the old value — the producer is authoritative and
// nothing suppresses smee. Flip this flag and restart execution-core AND the
// broker AND orch-monitor, or flip it in Layer-2 where every reader picks it up.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** The closed enum. Frozen: callers must never mutate this in place. */
export const GITHUB_FEED_MODES = Object.freeze(["off", "shadow", "enforce"]);

/**
 * The degradation target for every soft-failure case.
 *
 * `off`, not `shadow` — and the asymmetry with a watchdog's shadow is deliberate,
 * inherited verbatim from `readCloudFeedConfig`: a watchdog's shadow observes a
 * daemon it does not touch, while this feature's shadow starts a producer that
 * reads the replica on a timer inside the daemon process. "Off" therefore has to
 * mean "no new work in the tick at all".
 */
export const DEFAULT_GITHUB_FEED_MODE = "off";

/** Minimum tick interval. Number("") and Number(null) are both 0, which would busy-spin. */
export const MIN_INTERVAL_SEC = 5;
export const DEFAULT_INTERVAL_SEC = 30;

// Mirrors deployment-mode.mjs's resolveLayer2Path, including its parity decision:
// resolve `~` from the INJECTED env, so a caller passing { env: { HOME: fixture } }
// is genuinely sandboxed rather than silently reading the real user's config.
function resolveLayer2Path(env, layer2ConfigPath) {
  if (typeof layer2ConfigPath === "string" && layer2ConfigPath.length > 0) {
    return layer2ConfigPath;
  }
  const override = env?.CATALYST_LAYER2_CONFIG_FILE;
  if (typeof override === "string" && override.length > 0) return override;
  const home = typeof env?.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
  return resolve(home, ".config", "catalyst", "config.json");
}

function readLayer2GithubFeed(env, layer2ConfigPath) {
  try {
    const parsed = JSON.parse(readFileSync(resolveLayer2Path(env, layer2ConfigPath), "utf8"));
    const gf = parsed?.catalyst?.githubFeed;
    return gf && typeof gf === "object" ? gf : {};
  } catch {
    return {};
  }
}

/**
 * resolveGithubFeedMode — env (`CATALYST_GITHUB_FEED`) → Layer-2
 * (`catalyst.githubFeed.mode`) → `off`.
 *
 * Returns `{ mode, intervalSec, source }`. `source` is reported so an operator can
 * tell a deliberately-configured host from one that fell through to the default —
 * a distinction that matters most during a cutover, when "why is this host still
 * on smee?" has two very different answers.
 *
 * ⚠️ An UNRECOGNISED value degrades to `off`, not to the next rung. A typo in a
 * daemon env var must not silently cut a host over to an unproven dispatch source,
 * and must not silently inherit a Layer-2 value the operator was trying to override.
 */
export function resolveGithubFeedMode({ env = process.env, layer2ConfigPath } = {}) {
  const l2 = readLayer2GithubFeed(env, layer2ConfigPath);
  const raw = env?.CATALYST_GITHUB_FEED;
  // ⚠️ EMPTY-OR-WHITESPACE IS "UNSET", NOT "INVALID". CAT-57's contract is explicit
  // that an empty var still defers to Layer-2 rather than overriding it — an unset
  // var and a var set to "" are the same operator intent, and treating "" as a typo
  // would make `export CATALYST_GITHUB_FEED=` silently disable a Layer-2 rollout.
  const set = typeof raw === "string" && raw.trim().length > 0;

  let mode = DEFAULT_GITHUB_FEED_MODE;
  let source = "default";
  if (raw === "0") {
    mode = "off";
    source = "env";
  } else if (set && GITHUB_FEED_MODES.includes(raw)) {
    mode = raw;
    source = "env";
  } else if (set) {
    // ⛔ SET-BUT-INVALID FALLS BACK TO `off` **AND OVERRIDES LAYER-2** — CAT-57's
    // rule, which `execution-core/config.mjs`'s readGithubFeedConfig does NOT
    // currently follow (it falls through to Layer-2 on a typo). That is the wrong
    // direction for a knob whose whole purpose is containment: an operator reaching
    // for the env var to REDUCE actuation would silently leave Layer-2 `enforce`
    // live. Corrected here, and config.mjs now delegates, so the two cannot differ.
    mode = "off";
    source = "env-invalid";
  } else if (typeof l2.mode === "string" && GITHUB_FEED_MODES.includes(l2.mode)) {
    mode = l2.mode;
    source = "layer2";
  }

  const parsed = Number(env?.CATALYST_GITHUB_FEED_INTERVAL_SEC ?? l2.intervalSeconds);
  const intervalSec =
    Number.isFinite(parsed) && parsed >= MIN_INTERVAL_SEC ? Math.floor(parsed) : DEFAULT_INTERVAL_SEC;

  return { mode, intervalSec, source };
}

/**
 * githubFeedIsAuthoritative — the one question the tunnel gate and doctor ask.
 *
 * ⛔ Named for what it MEANS, not for the value it compares against. A call site
 * reading `mode === "enforce"` invites the next person to add `|| mode === "shadow"`
 * when shadow starts looking healthy — and shadow is precisely the mode in which
 * smee must keep running, because nothing the producer emits is authoritative.
 */
export function githubFeedIsAuthoritative(opts = {}) {
  return resolveGithubFeedMode(opts).mode === "enforce";
}
