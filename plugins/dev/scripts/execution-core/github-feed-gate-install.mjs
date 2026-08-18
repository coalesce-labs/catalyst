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

import { readGithubFeedConfig } from "./config.mjs";
import { createCaptureSink } from "./cloud-feed-capture.mjs";
import { defaultReadyPath, readReadyState } from "./github-feed-ready.mjs";
import { resolveAccount } from "./github-feed-timer.mjs";
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

export function defaultGithubCapturePath(orchDir, account = "tenant-0") {
  return join(orchDir, "capture", `github-suppressed-${account}.jsonl`);
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
  logger = null,
} = {}) {
  if (config.mode === "off") return null;

  const readyFile = readyPath ?? defaultReadyPath(orchDir, account);
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

  logger?.info?.(
    { mode: config.mode, readyFile, capture: capture.path, cacheMs: READY_CACHE_MS },
    "github-feed gate: armed",
  );

  return { mode: config.mode, isReady, capture, readyPath: readyFile };
}
