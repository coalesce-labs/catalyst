// github-feed-timer.mjs — CTL-1929. The daemon-hosted tick for the GitHub leg.
//
// ── `enforce` IS REACHABLE, AND IT IS REACHABLE PER NAME ───────────────────
// It was not, until `github-feed-gate.mjs` landed. The blocker was never the
// producer: `enforce` means the producer emits the real event AND the gate
// suppresses smee's copy, and those halves are not separable — emitting real
// `github.*` names while the tunnel still delivers its own puts BOTH on the log and
// every consumer routes twice.
//
// ⛔ WHAT CHANGED IS THE GRANULARITY, NOT THE RULE. The earlier refusal was
// all-or-nothing: because this producer cannot emit `github.pr.merged` (CTC-691) or
// `github.check_suite.completed` (CTC-667 item 4), enforce was refused ENTIRELY, so
// nine fully-covered names sat behind two uncovered ones. The gate now suppresses
// smee per NAME, so the two gaps hold back only themselves.
//
// ⚠️ THIS FILE MUST THEREFORE EMIT REAL NAMES ONLY FOR WHAT THE GATE CAN SUPPRESS.
// The two sides are the same invariant read from opposite ends — the producer
// decides what to emit, the gate decides what to suppress, and if they disagree the
// result is either a double dispatch (feed emits, gate does not suppress smee) or a
// dropped edge (gate suppresses smee, feed declined to emit). Both sides read
// `GITHUB_SUPPRESSIBLE_NAMES`, so they cannot disagree.
//
// An excluded name still goes out as a `would-dispatch` marker under enforce, so
// the parity ledger keeps observing it and the gap stays measurable while it lasts.
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
import {
  GITHUB_CONSUMED_NAMES,
  GITHUB_SUPPRESSIBLE_NAMES,
} from "./github-feed-gate.mjs";
import { defaultReadyPath, writeReadyState } from "./github-feed-ready.mjs";

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

/**
 * The names this producer may emit under their REAL name. Derived from the gate's
 * export, never re-typed — see the header's "same invariant from opposite ends".
 */
const SUPPRESSIBLE_SET = new Set(GITHUB_SUPPRESSIBLE_NAMES);

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
export function resolveEffectiveMode(
  requested,
  // ⚠️ INJECTABLE SO THE DERIVATION IS OBSERVABLE. With the real constants baked
  // in, a hand-written "9 of 12" in the reason string is indistinguishable from the
  // computed one — the test that claims to own that mutation passes with it applied,
  // and would keep passing after a gap closes and the true number becomes 10. That
  // sentence is what an operator reads to decide the tunnel can retire.
  { suppressible = GITHUB_SUPPRESSIBLE_NAMES, consumed = GITHUB_CONSUMED_NAMES } = {},
) {
  if (requested === "enforce") {
    // ⚠️ NOT degraded, but not unqualified either — the reason is retained and now
    // states the residual, because an operator who reads `mode: enforce` and infers
    // "the tunnel can go" would be wrong until all three gaps close. A mode that is
    // partially honoured has to say which part.
    return {
      requested,
      effective: "enforce",
      degraded: false,
      reason:
        `enforce is authoritative for ${suppressible.length} of ${consumed.length} consumed names; ` +
        `smee stays authoritative for ${consumed.length - suppressible.length} ` +
        `(CTC-691, CTC-667 item 4, CTC-704) and the tunnel cannot retire until they close.`,
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
  // Readiness as of the END of the PREVIOUS tick. Defaults false so a caller that
  // forgets to thread it emits unstamped events, which the gate refuses — the
  // non-dispatching half, same direction as every other absent probe here.
  authorityAtEntry = false,
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

  // Readiness AS THIS TICK BEGAN. Captured before the sweep runs, so every event
  // this sweep emits is stamped with one value that cannot change underneath it —
  // see the stamp comment in the sink. `authorityAtEntry` is recomputed at the end
  // of the tick for the NEXT one; that is the value written to the ready file.
  const authorityNow = () => authorityAtEntry;

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
        // The FULL envelope goes to the shadow file — that is the ledger's input,
        // in EVERY mode. An instrument that changes shape at the moment of cutover
        // cannot judge the cutover.
        appendShadowFn?.(event);
        if (!appendEventFn) return;

        const name = event?.attributes?.["event.name"];
        // ⛔ REAL NAME ONLY FOR WHAT THE GATE CAN SUPPRESS. Read from the gate's own
        // export so the producer and the gate cannot drift: emitting a real name the
        // gate will not suppress double-dispatches that name, and declining a name
        // the gate DOES suppress drops the edge entirely.
        if (resolved.effective === "enforce" && SUPPRESSIBLE_SET.has(name)) {
          // ⛔ AUTHORITY IS STAMPED AT EMISSION, not read at consumption (CTL-1901).
          // A later readiness change must not retroactively grant OR revoke authority
          // for a line already on disk — the sweep's cursor has advanced past the
          // edge, so a revoked line reaches neither path.
          //
          // ⚠️ And here the stamp is doing MORE work than on the Linear leg, because
          // the consumer is a different process: the broker cannot see this timer's
          // state at all, so the stamp is the only authority signal that crosses.
          const stamped = {
            ...event,
            body: {
              ...event.body,
              payload: { ...(event.body?.payload ?? {}), feedAuthority: authorityNow() === true },
            },
          };
          // ⛔ NO try/catch. In enforce this append IS the dispatch: swallowing a
          // failure would let the sweep settle the emission and advance its cursor
          // past the edge while the gate suppresses smee's copy — the edge would
          // reach nothing, permanently, with a counter as the only trace. Letting it
          // throw engages the sweep's last-contiguous-success rule so the next tick
          // re-emits. Opposite posture to the shadow sink above, which is evidence.
          appendEventFn(stamped);
          return;
        }
        // Shadow, or an excluded name under enforce: a marker under its OWN name, so
        // nothing actuates and the ledger keeps observing the gap while it lasts.
        appendEventFn(buildWouldDispatchEvent(event, { account }, seams));
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
  readyPath,
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

  const readyFile = readyPath ?? defaultReadyPath(orchDir, account);

  let last = null;
  // Readiness carried BETWEEN ticks. The sweep stamps every event it emits with the
  // value that was true when the tick began (see runGithubFeedTick), so a flip
  // during a tick cannot split that tick's output across two authority regimes.
  let authority = false;

  const publishReady = (state) => {
    // ⛔ WRITTEN EVERY TICK, INCLUDING THE UNREADY ONES. A heartbeat that is only
    // written while healthy is indistinguishable from a dead process — which is the
    // same failure the staleness bound exists for, arriving one step earlier. The
    // un-ready ticks are the ones whose REASON an operator most needs.
    writeReadyState(readyFile, { ...state, at: Date.now(), intervalSec }, { logger });
  };

  const tick = () => {
    try {
      last = runGithubFeedTick({
        mode,
        orchDir,
        account,
        dbPath,
        appendEventFn,
        appendShadowFn,
        logger,
        authorityAtEntry: authority,
      });
      authority = last?.ready === true;
      publishReady({ ready: authority, unready: last?.unready ?? null, mode: last?.mode?.effective ?? null });
    } catch (err) {
      // A guardrail that can wedge the daemon tick is not a guardrail.
      logger?.error?.({ err: err?.message }, "github-feed: tick threw");
      last = { error: `tick-threw:${err?.name ?? "unknown"}`, ready: false };
      // ⛔ A THROWN TICK MUST UN-ARM, and must say so rather than simply stop
      // writing. If it only stopped writing, the previous `ready: true` would sit
      // there until the staleness window expired and the gate would keep suppressing
      // smee for up to 90 s on the authority of a tick that crashed.
      authority = false;
      publishReady({ ready: false, unready: `tick-threw:${err?.name ?? "unknown"}`, mode: null });
    }
  };

  const handle = clock.setInterval(tick, Math.max(5, intervalSec) * 1000);
  handle?.unref?.();
  return {
    stop: () => clock.clearInterval(handle),
    tickNow: tick,
    lastReport: () => last,
    // ⚠️ THE IN-PROCESS ANSWER, AND IT IS NOT THE ONE THE GATE USES. The `github.*`
    // consumer is the broker, a separate process, which reads the ready FILE instead
    // (github-feed-ready.mjs). This is exposed for the daemon's own logging and for
    // tests; wiring it into a gate that lives in this process would work and would
    // also be a second, in-memory authority path that the real consumer does not
    // share — two answers to one question.
    isReady: () => last?.ready === true,
    readyPath: readyFile,
    mode: resolved,
  };
}
