// cloud-feed-gate.mjs — CTL-1847, the one place that decides WHICH producer's
// Linear events are allowed to drive dispatch.
//
// ── WHY A GATE AND NOT A REWIRING ──
// Two producers now emit the same three dispatch-class event names into the same
// unified log: the smee→webhook receiver (`orch-monitor/lib/linear-webhook-handler.ts`)
// and the cloud feed (`linear-feed-event.mjs`, which stamps `body.payload.source =
// "cloud-feed"`). Cutting over could have meant moving a data path — diverting the
// webhook receiver's output, or pointing the monitor's tail at a different file.
// Both make the rollback a second migration.
//
// Instead BOTH streams keep landing in the same log and this gate decides, per
// event, which one is authoritative. That buys three things the data-path move
// does not:
//   1. Rollback is a flag flip. No file moves, no receiver change, no drain.
//   2. The parity harness keeps comparing two streams out of ONE file, which is
//      the only way the comparison stays honest during the cutover itself.
//   3. The suppressed stream is CAPTURED, not dropped — a suppressed smee event
//      is written to the capture sink, so "the feed missed one" is answerable
//      after the fact instead of being an absence nobody can reconstruct.
//
// ⛔ The gate NEVER decides what an event MEANS. Dispatch semantics — a state
// edge triggers triage, a non-state edge folds into the eligible projection, a
// comment DELIVERS to the worker inbox and triggers nothing — live in
// monitor.mjs's three handlers and are inherited unchanged by whichever producer
// wins here. Re-implementing that split in the gate would be two sources of
// truth for the one rule the cutover must not perturb.
//
// Pure: no I/O, no clock, no env. Every dependency is an argument.

import { getEventName } from "../lib/event-name.mjs";

/** The three modes, house convention (cf. readDelegateFirstConfig). */
export const CLOUD_FEED_MODES = Object.freeze(new Set(["off", "shadow", "enforce"]));

/**
 * The event names monitor.mjs actually ACTS on. Deliberately not "every
 * linear.* name": the gate must suppress only what could double-dispatch.
 * `linear.issue.priority_changed` and friends are emitted by the webhook path
 * and consumed by nobody (measured, CTL-1847 parity: SMEE_UNHANDLED_NAMES), so
 * gating them would be motion without effect and would make the capture file
 * lie about what was withheld.
 */
export const DISPATCH_CLASS_NAMES = Object.freeze([
  "linear.issue.state_changed", // EDGE  → handleStateChangedEvent → dispatchTriage
  "linear.issue.updated", // EDGE  → handleIssueUpdatedEvent → eligible fold
  "linear.comment.created", // DELIVER → handleCommentCreatedEvent → inbox
]);

const DISPATCH_CLASS_SET = new Set(DISPATCH_CLASS_NAMES);

export const SOURCE_CLOUD_FEED = "cloud-feed";

/**
 * INTERNAL_SOURCES — producers whose events have NO Linear row behind them, and
 * which the cloud feed therefore can never generate a replacement for.
 *
 * ⛔ These must ALWAYS pass the gate, in every mode (Codex P1 round 3).
 * `buildResumeEvent` (orch-monitor/lib/respond-ticket.mjs) emits a synthetic
 * `linear.comment.created` stamped `orch-monitor/respond` that is the SOLE
 * trigger resuming a held worker, and is deliberately never written to Linear.
 * Capturing it left the worker parked forever while the respond endpoint
 * cheerfully returned `resuming`.
 *
 * This is the correction to a rule that was right in the general case and wrong
 * in its domain: "an unknown producer must not inherit the feed's authority" is
 * sound for a competing producer OF LINEAR EVENTS, and unsound for an internal
 * producer that Linear never sees. Suppression is only ever legitimate when a
 * replacement exists.
 */
export const INTERNAL_SOURCES = Object.freeze(new Set(["orch-monitor/respond"]));
export const SOURCE_WEBHOOK = "webhook";
export const SOURCE_OTHER = "other";

/**
 * isDispatchClass — does this event reach one of monitor.mjs's three handlers?
 */
export function isDispatchClass(event) {
  return DISPATCH_CLASS_SET.has(getEventName(event));
}

/**
 * sourceOf — which producer wrote this event.
 *
 * The cloud-feed answer is POSITIVE: `body.payload.source === "cloud-feed"` is
 * stamped by linear-feed-event.mjs on every event it builds. Everything else is
 * identified by elimination, and that asymmetry is deliberate — a third producer
 * we have not thought of must NOT be able to inherit the feed's authority by
 * default. It lands in `other`, which the enforce branch captures exactly like
 * smee's, so an unknown producer can never silently drive dispatch.
 */
export const SOURCE_INTERNAL = "internal";

export function sourceOf(event) {
  const src = event?.body?.payload?.source;
  if (typeof src === "string" && src === SOURCE_CLOUD_FEED) return SOURCE_CLOUD_FEED;
  if (typeof src === "string" && INTERNAL_SOURCES.has(src)) return SOURCE_INTERNAL;
  const delivery = event?.attributes?.["webhook.delivery.id"];
  if (typeof delivery === "string" && delivery !== "") return SOURCE_WEBHOOK;
  return SOURCE_OTHER;
}

/**
 * echoProbesFor — the (field, value) pairs a given event should be checked
 * against in the CTL-1891 write-echo ring (linear-write-echo.mjs).
 *
 * One probe per field the event actually reports as changed. This is not
 * fastidiousness: `isEcho` CONSUMES a token on a hit, so probing a field the
 * event never carried would spend a token recorded for a different write and
 * let that write's real echo through later.
 *
 * Returns [] for anything with nothing checkable — which yields "not an echo",
 * the safe direction (dispatch rather than silently swallow).
 */
export function echoProbesFor(event) {
  const p = event?.body?.payload ?? {};
  const name = getEventName(event);
  const probes = [];

  if (name === "linear.comment.created") {
    if (typeof p.body === "string" && p.body !== "") {
      probes.push({ field: "comment", value: p.body });
    }
    return probes;
  }

  const keys = Array.isArray(p.updatedFromKeys) ? p.updatedFromKeys : [];
  const changed = (k) => keys.includes(k);

  // A state_changed event is a state edge by definition, whether or not the
  // producer also listed "state" in updatedFromKeys.
  if ((name === "linear.issue.state_changed" || changed("state")) && p.toState !== undefined) {
    probes.push({ field: "state", value: p.toState });
  }
  if (changed("labels") && p.toLabels !== undefined) {
    probes.push({ field: "labels", value: p.toLabels });
  }
  if (changed("assigneeId") && p.toAssigneeId !== undefined) {
    probes.push({ field: "assignee", value: p.toAssigneeId });
  }
  if (changed("delegateId") && p.toDelegateId !== undefined) {
    probes.push({ field: "delegate", value: p.toDelegateId });
  }
  return probes;
}

/**
 * ticketOf — the ticket identifier the echo ring is keyed on.
 */
export function ticketOf(event) {
  const id = event?.attributes?.["linear.issue.identifier"];
  if (typeof id === "string" && id !== "") return id;
  const t = event?.body?.payload?.ticket;
  return typeof t === "string" && t !== "" ? t : null;
}

/**
 * decideDispatch — the whole gate, as one pure function.
 *
 * @param {object} event  a parsed event-log line
 * @param {object} opts
 * @param {string} opts.mode        "off" | "shadow" | "enforce" (anything else degrades to "off")
 * @param {function} [opts.isEcho]  (ticket, field, value) => boolean — the CTL-1891 ring's probe.
 *                                  Omitted/absent ⇒ nothing is ever an echo.
 * @param {function|boolean} [opts.isReady]  () => boolean — has the producer seeded and
 *                                  begun emitting? Enforce degrades to shadow routing until
 *                                  this is true. Omitted/absent ⇒ NOT ready (safe half).
 * @returns {{suppress: boolean, reason: string, source: string, name: string}}
 *
 * `suppress: true` means "do not let this event reach monitor.mjs's handlers;
 * write it to the capture sink instead". It never means "discard".
 */
export function decideDispatch(event, { mode, isEcho = null, isReady = null } = {}) {
  const name = getEventName(event);
  const source = sourceOf(event);

  // Not something any handler acts on → the gate has no opinion, routing is
  // byte-identical to pre-CTL-1847. Reported explicitly rather than as a bare
  // `false` so the capture file's absences are diagnosable.
  if (!DISPATCH_CLASS_SET.has(name)) {
    return { suppress: false, reason: "not-dispatch-class", source, name };
  }

  // Checked BEFORE the mode branches, deliberately: there is no mode in which
  // suppressing an event with no possible replacement is correct.
  if (source === SOURCE_INTERNAL) {
    return { suppress: false, reason: "internal-source-no-replacement", source, name };
  }

  // An unrecognized mode degrades to today's behaviour rather than to the new
  // one. Same direction as deployment-mode's "settle at the layer asserting the
  // fewest guarantees": a typo in a daemon env var must not silently cut a host
  // over to an unproven dispatch source.
  let m = CLOUD_FEED_MODES.has(mode) ? mode : "off";

  // ⛔ ENFORCE IS NOT ARMED UNTIL THE PRODUCER CAN ACTUALLY PRODUCE
  // (Codex P1, #3439). On a host with a missing or cleared last-seen database,
  // the gate would start suppressing smee immediately while `runDiffSweep`'s
  // FIRST tick only seeds the baseline and emits nothing. Issue changes in that
  // interval get absorbed into the baseline silently; comments are worse — the
  // seeding tick never reads them and the next tick cold-starts the comment
  // cursor at the current time, so comments in the gap reach no inbox EVER.
  //
  // So enforce degrades to shadow's routing (smee authoritative, feed
  // suppressed) until the producer reports itself ready. Absent probe ⇒ NOT
  // ready: a caller that forgets to wire readiness gets the safe half, never
  // the suppressing one.
  if (m === "enforce") {
    let ready = false;
    try {
      ready = typeof isReady === "function" ? isReady() === true : isReady === true;
    } catch {
      ready = false; // a throwing probe is not a ready producer
    }
    if (!ready) {
      return { suppress: source === SOURCE_CLOUD_FEED, reason: "enforce-not-armed", source, name };
    }
  }

  if (m !== "enforce") {
    // off / shadow: smee remains authoritative, exactly as today.
    if (source === SOURCE_CLOUD_FEED) {
      // Defence in depth. In shadow the feed writes to its own sink and should
      // never reach this log at all; if it does (a stale enforce-mode producer
      // still running after a rollback, say) it must not dispatch — that is the
      // precise shape of a rollback that doesn't roll back.
      return { suppress: true, reason: "feed-not-authoritative", source, name };
    }
    return { suppress: false, reason: "webhook-authoritative", source, name };
  }

  // enforce: the feed is the dispatch source; everything else is captured.
  if (source !== SOURCE_CLOUD_FEED) {
    return { suppress: true, reason: "smee-captured", source, name };
  }

  // CTL-1891: a host must not dispatch on its own proxied write coming back.
  // ⚠️ Inert until the CTC-509 proxy caller (CTL-1889) records into the ring —
  // with no recorder, every probe misses and this branch never fires. Wired now
  // and proven by test so that landing the recorder is a one-line change rather
  // than a second trip through the daemon's dispatch path.
  if (typeof isEcho === "function") {
    const ticket = ticketOf(event);
    if (ticket) {
      for (const probe of echoProbesFor(event)) {
        let hit = false;
        try {
          hit = isEcho(ticket, probe.field, probe.value) === true;
        } catch {
          // A throwing ring must not wedge dispatch, and must not silently
          // suppress either — fail OPEN (dispatch), which is what the fleet
          // did before the ring existed.
          hit = false;
        }
        if (hit) {
          return { suppress: true, reason: "own-write-echo", source, name };
        }
      }
    }
  }

  // ⛔ THE EVENT'S OWN STAMP DECIDES, not a flag read now (Codex P1 round 6).
  // `feedAuthority` is written by the sweep that emitted this line and is
  // immutable thereafter, so a readiness transition between emission and
  // consumption cannot retroactively grant authority to a line already on disk —
  // which is exactly how the same edge got dispatched twice across an arming.
  //
  // Absent stamp ⇒ NOT authoritative. Every feed event written by this code path
  // carries one; a line without it predates the stamp or came from somewhere
  // else, and neither is something to dispatch on.
  if (event?.body?.payload?.feedAuthority !== true) {
    return { suppress: true, reason: "feed-emitted-while-unarmed", source, name };
  }

  return { suppress: false, reason: "feed-authoritative", source, name };
}
