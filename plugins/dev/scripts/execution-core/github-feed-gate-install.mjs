// github-feed-gate-install.mjs — CTL-1929. Builds the `github.*` dispatch gate for
// the BROKER process, which is where the consumer lives.
//
// ⛔ SEPARATE FROM THE DAEMON'S WIRING BECAUSE THE PROCESSES ARE SEPARATE. The
// Linear leg installs its gate inside `daemon.mjs`, next to the producer, and passes
// `isReady` as a closure over the producer's timer handle. That is not available
// here: `github-feed-timer` runs in the daemon and `broker/tailer.mjs` →
// `broker/router.mjs` runs in its own process, so readiness arrives through the file
// `github-feed-ready.mjs` defines and nothing else.
//
// ⚠️ AND THE HOT PATH IS NOT THE SAME EITHER. `monitor.mjs`'s tail sees `linear.*`
// events; the broker's tail sees EVERY event this fleet appends — 687 per 5 min
// measured on mini-2, into a log that has reached 883 MB (CTL-1529). A readFileSync
// per routed event is not acceptable at that rate, so the readiness verdict is cached
// for a short window. The cache is bounded far below the staleness window it feeds,
// so it can delay an un-arm by at most `READY_CACHE_MS` — not defeat it.

import { getExecutionCoreDir, readGithubFeedConfig } from "./config.mjs";
import { createCaptureSink } from "./cloud-feed-capture.mjs";
import { defaultReadyPath, readReadyState } from "./github-feed-ready.mjs";
import { resolveAccount } from "./github-feed-timer.mjs";
import { githubSuppressibleNames, GITHUB_SUPPRESSIBLE_NAMES } from "./github-feed-gate.mjs";
import { createGithubFeedSource } from "./github-feed-source.mjs";
import { join } from "node:path";

/**
 * How long a readiness verdict is reused.
 *
 * 1 s against a 90 s staleness window: three orders of magnitude of read reduction
 * on a tail that routes every event in the fleet, for at most 1 s of extra latency on
 * an un-arm. ⛔ It must stay far below `staleWindowMs`, or the cache becomes a second,
 * longer latch on top of the one the staleness bound exists to break.
 */
export const READY_CACHE_MS = 1000;

/**
 * How long this host's COVERAGE answer is reused.
 *
 * ⛔ IT MUST BE RE-READ, NOT RESOLVED ONCE AT BOOT, and the rollout is exactly why.
 * Both capabilities appear when the cloud-sync WRITER restarts and runs its
 * migrations — an event this process does not participate in and is not notified of.
 * A boot-only read would leave a broker that started before the 0.1.18 restart
 * believing `check_suite.completed` is uncovered for the rest of its life, and the
 * operator would have to know to restart a second daemon to collect a capability
 * that had already arrived.
 *
 * 30 s: two orders of magnitude cheaper than the readiness read it sits beside (a
 * `PRAGMA table_info` on an open handle, not a file read), and it bounds how long a
 * newly-migrated host keeps under-reporting its own coverage.
 */
export const COVERAGE_CACHE_MS = 30_000;

/**
 * Probe this replica for the two capabilities the suppressible set depends on.
 *
 * ⛔ FAILS CLOSED, AND "CLOSED" HERE MEANS THE PRE-CAPABILITY ANSWER — `pushIsLossy:
 * true`, `checkSuiteHasPrAssociation: false` — which yields the smallest suppressible
 * set and therefore leaves smee authoritative for both names. Every failure mode
 * (no replica file, a locked or corrupt database, a throwing PRAGMA) lands there.
 * The opposite default would let an unreadable database silently license suppression.
 */
export function readGithubCoverage({ sourceFactory = createGithubFeedSource } = {}) {
  let src = null;
  try {
    // ⛔ THROUGH THE SOURCE HANDLE, not a hand-rolled `new Database(...)`. The handle
    // already owns the read-only open, the busy timeout and the two capability
    // predicates, and it is the object the producer's own tests drive — so the gate
    // and the producer cannot come to different conclusions about the same replica.
    src = sourceFactory();
    return {
      pushIsLossy: src.pushIsLossy(),
      checkSuiteHasPrAssociation: src.checkSuiteHasPrAssociation(),
      ok: true,
    };
  } catch {
    return { pushIsLossy: true, checkSuiteHasPrAssociation: false, ok: false };
  } finally {
    try { src?.close(); } catch { /* best effort */ }
  }
}

export function defaultGithubCapturePath(orchDir, account = "tenant-0") {
  return join(orchDir, "capture", `github-suppressed-${account}.jsonl`);
}

/**
 * producerReadyPath — where the PRODUCER writes its readiness file.
 *
 * ⛔ CTL-1976: RESOLVED FROM THE PRODUCER'S DIRECTORY, NEVER THE CALLER'S. This
 * gate's other artifact — the capture sink — is owned by whichever process installs
 * the gate, so `orchDir` is the right root for it. The readiness file is NOT: it is
 * written by `github-feed-timer` inside the daemon, under `getExecutionCoreDir()`,
 * and this side only ever READS it. Deriving it from the installer's `orchDir` meant
 * the broker (whose `orchDir` is `CATALYST_DIR`, one level up) read
 * `~/catalyst/shadow/...` while the daemon wrote `~/catalyst/execution-core/shadow/...`.
 *
 * ⚠️ AND THAT MISS IS NOT SYMMETRIC, WHICH IS WHY IT IS A `readFileSync` AWAY FROM
 * SILENT. `readReadyState` answers `ready:false` for an absent file, and in
 * `decideDispatch` readiness gates ONLY the smee branch — the feed branch is gated on
 * the `feedAuthority` stamp, which the producer computes from ITS OWN (correct) path.
 * So a mismatched path does not fail closed on both sides: smee keeps routing AND the
 * feed routes, i.e. every covered name dispatches TWICE, while every log line on both
 * processes reads healthy. The readiness lever exists to make `enforce` refusable; a
 * lever wired to a file nobody writes is a check that cannot fire.
 *
 * Measured on mini-2 (2026-08-18 11:15 CT) with the gate armed in shadow: broker
 * `readyFile` `/Users/ryan/catalyst/shadow/github-feed-ready-tenant-0.json` — absent;
 * daemon's, under `execution-core/`, fresh on every 30 s tick.
 */
export function producerReadyPath(account = resolveAccount(), executionCoreDir = getExecutionCoreDir()) {
  return defaultReadyPath(executionCoreDir, account);
}

/**
 * createGithubFeedGate — the object `decideDispatch` takes as its second argument.
 *
 * Returns `null` when the mode is `off`, so the caller can skip the gate entirely
 * and keep routing byte-identical to pre-CTL-1929 rather than running a gate that
 * decides nothing on every event.
 */
export function createGithubFeedGate({
  orchDir,
  account = resolveAccount(),
  config = readGithubFeedConfig(),
  readyPath,
  capturePath,
  now = () => Date.now(),
  readState = readReadyState,
  captureFactory = createCaptureSink,
  readCoverage = readGithubCoverage,
  logger = null,
} = {}) {
  if (config.mode === "off") return null;

  // ⛔ producerReadyPath, NOT defaultReadyPath(orchDir, ...) — see its header (CTL-1976).
  const readyFile = readyPath ?? producerReadyPath(account);
  const capture = captureFactory({ path: capturePath ?? defaultGithubCapturePath(orchDir, account) });

  let cachedAt = -Infinity;
  let cached = { ready: false, reason: "ready-never-read" };

  const isReady = () => {
    const t = now();
    if (t - cachedAt < READY_CACHE_MS) return cached;
    // ⛔ The cache is refreshed even when the read FAILS. Keeping the last good
    // verdict on an error would make an unreadable file behave like a fresh one,
    // which is the latch again — readReadyState already returns a not-ready verdict
    // for every failure mode, so simply taking its answer is the safe path.
    cached = readState(readyFile, { now: t, intervalSec: config.intervalSec });
    cachedAt = t;
    return cached;
  };

  let coverageAt = -Infinity;
  let coverageSet = GITHUB_SUPPRESSIBLE_NAMES;
  let coverageState = { pushIsLossy: true, checkSuiteHasPrAssociation: false, ok: false };

  const resolveSuppressible = () => {
    const t = now();
    if (t - coverageAt < COVERAGE_CACHE_MS) return coverageSet;
    // ⛔ THIS RUNS ON THE BROKER'S TAIL, WHICH SEES EVERY EVENT THE FLEET APPENDS.
    // `readGithubCoverage` catches internally, but this seam is injectable and the
    // caller's implementation is not this module's to trust — an escaping throw here
    // would take down routing for the whole fleet to answer a question whose safe
    // answer is already known. Caught, and degraded to the pre-capability set: the
    // same verdict an unreadable replica produces.
    let next;
    try {
      next = readCoverage();
    } catch {
      next = { pushIsLossy: true, checkSuiteHasPrAssociation: false, ok: false };
    }
    coverageAt = t;
    // Announce only on CHANGE. This runs on the broker's hot tail; a line per event —
    // or even per cache miss — is the flood, and the thing an operator needs to see is
    // the moment a host's coverage moved, which is rare and load-bearing.
    if (
      next.pushIsLossy !== coverageState.pushIsLossy ||
      next.checkSuiteHasPrAssociation !== coverageState.checkSuiteHasPrAssociation ||
      next.ok !== coverageState.ok
    ) {
      coverageSet = githubSuppressibleNames(next);
      logger?.info?.(
        { ...next, suppressible: coverageSet.length, names: coverageSet },
        "github-feed gate: coverage changed",
      );
      coverageState = next;
    }
    return coverageSet;
  };

  logger?.info?.(
    { mode: config.mode, readyFile, capture: capture.path, cacheMs: READY_CACHE_MS },
    "github-feed gate: armed",
  );

  const gate = { mode: config.mode, isReady, capture, readyPath: readyFile };
  // ⭐ A GETTER, so `decideDispatch`'s destructure re-resolves it. A plain property
  // would freeze this host's coverage at gate-construction time, which is boot — and
  // both capabilities arrive later, at a writer restart this process never sees.
  Object.defineProperty(gate, "suppressible", {
    enumerable: true,
    get: resolveSuppressible,
  });
  return gate;
}
