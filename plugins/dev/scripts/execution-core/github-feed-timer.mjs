// github-feed-timer.mjs — CTL-1929. The daemon-hosted tick for the GitHub leg.
//
// ── ⛔ `enforce` IS NOT REACHABLE YET, BY DESIGN ────────────────────────────
// On the Linear leg, `enforce` means two things at once: the producer emits the
// real event AND `cloud-feed-gate` suppresses smee's copy. Those halves are not
// separable — emitting real `github.*` events while the tunnel is still delivering
// its own would put BOTH on the log, and every consumer would route twice: two
// `monitor-merge` wakes, two CI-wait resolutions, two `filter_state` transitions.
//
// The gate is not wired for `github.*` (`DISPATCH_CLASS_NAMES` is three `linear.*`
// names), and it MUST NOT be until `github.pr.merged` and
// `github.check_suite.completed` exist — CTC-691 and CTC-667 item 4 — because
// suppressing smee for names this producer cannot emit is a total loss of the CI
// wait and the deploy chain.
//
// So `enforce` here DEGRADES TO SHADOW and says so, loudly, once per process. It
// does not silently do nothing (an operator would read the flag as active), and it
// does not half-activate (which is the double-dispatch above). A mode that cannot
// be honoured is refused by name.
//
// ── WHAT SHADOW EMITS, AND WHY IT IS A DIFFERENT NAME ──────────────────────
// `github-feed.would-dispatch`, never the real `github.*` name. Re-emitting
// `github.pr.merged` with a shadow flag would fire every `wait-for` subscriber, the
// broker's PR-lifecycle router, and `plugin-refresh`'s merge auto-pull — a shadow
// that actuates is not a shadow. Same reasoning, and the same shape, as
// `cloud-feed-timer.mjs`'s `cloud-feed.would-dispatch`.
//
// ⚠️ The full event is ALSO written to a shadow FILE, and that file — not the
// would-dispatch line — is what the parity ledger reads. The ledger must compare
// the exact envelope the producer would have emitted, and an instrument that
// changes shape at the moment of cutover cannot judge the cutover.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createGithubFeedSource } from "./github-feed-source.mjs";
import { createSeenStore, defaultSeenPath } from "./github-feed-seen.mjs";
import { githubSweepUnreadyReason, runGithubSweep } from "./github-feed-sweep.mjs";
import { buildCanonicalEvent } from "./lib/canonical-event.mjs";
import { DEFAULT_ACCOUNT } from "./linear-feed-run.mjs";

/**
 * Which account this host is.
 *
 * ⛔ Imported from the Linear leg rather than re-typed, and resolved from the same
 * env var, because every per-account artifact this timer writes — the shadow file,
 * the suppression DB, nine cursor files, and the `catalyst.account` attribute on
 * every would-dispatch marker — is NAMED by it. A hard-coded `tenant-0` on a host
 * configured for another account does not fail: it silently files that host's parity
 * evidence and producer state under the wrong tenant, which is worse than an error
 * because the artifacts still look complete. `linear-feed-run.mjs`'s own comment
 * gives the rule: this must match `cloud-sync.mjs`'s resolution "so the two cannot
 * disagree about which account this host is".
 */
export function resolveAccount(envObj = process.env) {
  return envObj.CATALYST_CLOUD_ACCOUNT || DEFAULT_ACCOUNT;
}

/** The shadow-only marker name. Deliberately NOT a `github.*` name — see the header. */
export const EVENT_WOULD_DISPATCH = "github-feed.would-dispatch";

export function defaultShadowPath(orchDir, account = resolveAccount()) {
  return join(orchDir, "shadow", `github-feed-${account}.jsonl`);
}

/**
 * ⛔ Refuse any path that looks like the unified event log.
 *
 * The shadow sink appends raw producer output. If that path were ever the event
 * log, every shadow event would become a REAL one and the whole containment
 * argument would silently invert — while every counter still read "shadow".
 */
export function assertNotEventLog(path) {
  const p = String(path ?? "");
  if (/[\\/]events[\\/]\d{4}-\d{2}\.jsonl$/.test(p) || p.endsWith("/events")) {
    throw new Error(`github-feed shadow sink refuses an event-log path: ${p}`);
  }
  return p;
}

/**
 * Resolve the mode actually in force, separately from the mode requested.
 *
 * Returns `{ effective, requested, degraded, reason }`. Keeping the two apart is
 * the point: a caller must be able to log what the operator asked for AND what is
 * running, or a degraded node is indistinguishable from a configured one.
 */
export function resolveEffectiveMode(requested) {
  if (requested === "enforce") {
    return {
      requested,
      effective: "shadow",
      degraded: true,
      reason:
        "enforce requires the dispatch gate to suppress the smee copy; the gate carries no github.* names " +
        "(and must not until CTC-691 and CTC-667 item 4 land, or the CI wait and deploy chain lose their only source). " +
        "Running as shadow.",
    };
  }
  return { requested, effective: requested, degraded: false, reason: null };
}

/** One would-dispatch marker for an event the producer would have emitted. */
export function buildWouldDispatchEvent(event, { account = resolveAccount() } = {}, seams) {
  return buildCanonicalEvent(
    {
      name: EVENT_WOULD_DISPATCH,
      serviceName: "catalyst.execution-core",
      attributes: {
        "catalyst.github_feed.event_name": event?.attributes?.["event.name"] ?? "unknown",
        "vcs.repository.name": event?.attributes?.["vcs.repository.name"],
        "catalyst.account": account,
      },
      payload: {
        account,
        eventName: event?.attributes?.["event.name"] ?? "unknown",
        // The scoping the ledger and a human both need, without duplicating the
        // whole envelope onto the event log (the shadow FILE carries that).
        pr: event?.attributes?.["vcs.pr.number"] ?? null,
        ref: event?.attributes?.["vcs.ref.name"] ?? null,
        sha: event?.attributes?.["vcs.revision"] ?? null,
      },
    },
    seams,
  );
}

/**
 * Run one tick. Pure-ish: every side effect is an injected seam so the whole tick
 * is testable without a daemon, a replica, or a clock.
 */
export function runGithubFeedTick({
  mode,
  orchDir,
  account = resolveAccount(),
  dbPath,
  now = Date.now(),
  appendEventFn,
  appendShadowFn,
  sourceFactory = createGithubFeedSource,
  seenFactory = createSeenStore,
  sweepFn = runGithubSweep,
  feedHealth = { healthy: true },
  seams,
  logger = null,
}) {
  const resolved = resolveEffectiveMode(mode);
  if (resolved.effective === "off") {
    return { skipped: "mode-off", mode: resolved, counts: null, ready: false };
  }

  let source = null;
  let seen = null;
  try {
    source = sourceFactory({ dbPath });
    seen = seenFactory({ path: defaultSeenPath(orchDir, account) });
  } catch (err) {
    // A producer that cannot open its inputs is a FAILURE, not a quiet no-op: it is
    // exactly the state readiness exists to refuse to arm on.
    try { source?.close?.(); } catch { /* best effort */ }
    return {
      skipped: null,
      mode: resolved,
      error: `open-failed:${err?.code ?? err?.name ?? "unknown"}`,
      counts: null,
      ready: false,
    };
  }

  try {
    const emitted = [];
    const counts = sweepFn({
      source,
      seen,
      sink: (event) => {
        emitted.push(event);
        // The FULL envelope goes to the shadow file — that is the ledger's input.
        appendShadowFn?.(event);
        // A marker, under its own name, goes to the event log so the tick is
        // observable without the ledger.
        if (appendEventFn) appendEventFn(buildWouldDispatchEvent(event, { account }, seams));
      },
      orchDir,
      account,
      now,
      seams,
    });

    const report = { counts, stoppedEarly: false };
    const unready = githubSweepUnreadyReason(report, feedHealth);
    if (resolved.degraded && logger?.warn) {
      // Once per tick is deliberate here rather than latched: this state is a
      // deliberate operator-visible refusal, not a flapping alarm, and it ends the
      // moment someone sets the flag to something honourable.
      logger.warn({ requested: resolved.requested, effective: resolved.effective, reason: resolved.reason },
        "github-feed: enforce requested but not honourable — running as shadow");
    }
    return { skipped: null, mode: resolved, counts, emitted: emitted.length, ready: unready === null, unready };
  } finally {
    try { source.close(); } catch { /* best effort */ }
    try { seen.close(); } catch { /* best effort */ }
  }
}

/**
 * Start the recurring tick. Returns `null` when the mode is `off`, so a caller can
 * assert on "no timer was created at all" rather than on a timer that does nothing.
 */
export function startGithubFeedTimer({
  mode,
  intervalSec = 30,
  orchDir,
  account = resolveAccount(),
  dbPath,
  eventLogPath,
  shadowPath,
  appendFn,
  logger = null,
  clock = { setInterval, clearInterval },
} = {}) {
  const resolved = resolveEffectiveMode(mode);
  if (resolved.effective === "off") return null;

  const shadow = assertNotEventLog(shadowPath ?? defaultShadowPath(orchDir, account));
  mkdirSync(dirname(shadow), { recursive: true });

  const appendShadowFn = (event) => {
    try {
      appendFn(shadow, `${JSON.stringify(event)}\n`);
    } catch (err) {
      // Fail-open: the shadow file is EVIDENCE, and evidence must never be
      // load-bearing for the thing it observes.
      logger?.warn?.({ err: err?.message }, "github-feed: shadow append failed");
    }
  };
  const appendEventFn = (event) => {
    try {
      appendFn(eventLogPath, `${JSON.stringify(event)}\n`);
    } catch (err) {
      logger?.warn?.({ err: err?.message }, "github-feed: would-dispatch append failed");
    }
  };

  let last = null;
  const tick = () => {
    try {
      last = runGithubFeedTick({ mode, orchDir, account, dbPath, appendEventFn, appendShadowFn, logger });
    } catch (err) {
      // A guardrail that can wedge the daemon tick is not a guardrail.
      logger?.error?.({ err: err?.message }, "github-feed: tick threw");
      last = { error: `tick-threw:${err?.name ?? "unknown"}`, ready: false };
    }
  };

  const handle = clock.setInterval(tick, Math.max(5, intervalSec) * 1000);
  handle?.unref?.();
  return {
    stop: () => clock.clearInterval(handle),
    tickNow: tick,
    lastReport: () => last,
    // Always false today — `enforce` degrades to shadow, so nothing this producer
    // emits is ever authoritative. Exposed so a future gate reads one answer.
    isReady: () => false,
    mode: resolved,
  };
}
