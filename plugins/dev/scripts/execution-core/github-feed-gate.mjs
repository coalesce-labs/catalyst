// github-feed-gate.mjs — CTL-1929, the one place that decides WHICH producer's
// `github.*` events are allowed to drive dispatch.
//
// The peer of `cloud-feed-gate.mjs`, and it inherits that file's whole argument:
// both producers keep writing into the same unified log, the gate picks a winner
// per event, and the loser is CAPTURED rather than dropped so parity stays
// answerable during the cutover itself. Rollback is a flag flip.
//
// ⛔ IT IS NOT A COPY, AND THE TWO DIFFERENCES ARE BOTH SAFETY PROPERTIES.
//
// ── DIFFERENCE 1: SUPPRESSION IS PER NAME, NOT PER STREAM ──────────────────
// The Linear gate may suppress its whole dispatch class, because the Linear
// producer covers all three names. This producer covers 10 of 12 consumed names
// and CANNOT emit the other two (`github.pr.merged` — no `merge_commit_sha`,
// CTC-691; `github.check_suite.completed` — the mirror stores no suite row,
// CTC-667 item 4). Suppressing smee for a name with no replacement is not a
// degraded cutover, it is a total loss of that signal: the CI wait and the whole
// merge→deploy chain, fleet-wide, with no second copy because enforce suppressed it.
//
// So `enforce` here suppresses smee ONLY for names this producer can faithfully
// replace, and the exclusion set is derived from the producer's OWN declarations
// (`GITHUB_UNCOVERED_NAMES`, `PUSH_IS_LOSSY`) rather than re-typed here. A gate
// with a second, hand-maintained coverage list is a gate that goes stale silently
// the first time coverage changes — and the change that closes these gaps is a
// schema bump landing in another repo, which is exactly the kind of change nobody
// remembers to mirror into a constant.
//
// ⭐ This is the Linear gate's own rule applied one level finer. That file already
// says it twice — `INTERNAL_SOURCES` ("suppression is only ever legitimate when a
// replacement exists") and `enforce-not-armed`. Both apply it to the STREAM. Here
// the replacement exists for some names and not others, so the rule has to bind to
// the NAME or it does not bind at all.
//
// ── DIFFERENCE 2: READINESS CROSSES A PROCESS BOUNDARY ─────────────────────
// The Linear gate's `isReady` is a closure over the producer's timer, valid because
// producer and consumer share `daemon.mjs`. The `github.*` consumer is
// `broker/tailer.mjs` → `broker/router.mjs`, a SEPARATE PROCESS. See
// `github-feed-ready.mjs` for why a naive port fails silently in the direction that
// looks fine.
//
// Pure: no I/O, no clock, no env. Every dependency is an argument.

import { getEventName } from "../lib/event-name.mjs";
import { SOURCE_CLOUD_FEED } from "./github-feed-event.mjs";
import { PUSH_IS_LOSSY } from "./github-feed-source.mjs";
// ⛔ THE NAME LISTS MOVED TO A ZERO-IMPORT LEAF and this file no longer owns them.
// `catalyst doctor` is now a consumer — it must report WHICH names a declared-cloud
// node cannot see — and doctor runs under bare Node, which cannot load this file at
// all (it reaches `bun:sqlite` via github-feed-source.mjs). A second copy in doctor
// would keep reporting three uncovered names after CTC-691/667/704 close.
import {
  EXCLUSION_REASONS as LEAF_EXCLUSION_REASONS,
  GITHUB_CONSUMED_NAMES as LEAF_CONSUMED_NAMES,
  GITHUB_UNCOVERED_NAMES as LEAF_UNCOVERED_NAMES,
  computeSuppressible as leafComputeSuppressible,
} from "../lib/github-feed-names.mjs";

/** The three modes, house convention. */
export const GITHUB_FEED_MODES = Object.freeze(new Set(["off", "shadow", "enforce"]));

/**
 * ⛔ `github.push` EMITS BUT MUST NOT SUPPRESS — and the reason corrects a claim
 * this feature shipped in two of its own files.
 *
 * `github-feed-source.mjs`'s header says the `(repo_id, ref)` collapse is
 * "survivable" because "the consumer is rebase detection (CTL-381), which asks 'did
 * this ref move', not 'how many times'". `packages/schema/src/mirror.ts`'s comment
 * on `pushes` makes the same argument. Measured against the consumer, both are wrong:
 *
 *   * `broker/router.mjs:1582` reads `scope.ref` and NOTHING else on `github.push`.
 *     It never reads `before`/`after` and never compares against a stored head, so
 *     it is not asking "did the ref move" — it has no memory to ask that with.
 *   * It sets no `wakeStateKey` (only `check_run`/`check_suite` do, `router.mjs:1510`),
 *     so `suppress_identical_wakes` (`router.mjs:2857`) never applies to push. Every
 *     ARRIVING push edge is a distinct wake, deliberately.
 *
 * So what the consumer consumes is the ARRIVAL, not the column's value, and a
 * last-state projection cannot carry an arrival. Under shadow that is a parity gap
 * (101 of 138 unmatched smee events, CTL-48). Under enforce with smee suppressed it
 * is a wake that never happens and no second copy to recover it from — a worker
 * waiting on a base-branch move parks until its timeout.
 *
 * CTC-704 keys `pushes` per delivery. When it lands, `PUSH_IS_LOSSY` goes false in
 * the source and this set empties itself — no edit here.
 */
export function githubLossyNames(pushIsLossy = PUSH_IS_LOSSY) {
  return Object.freeze(pushIsLossy ? ["github.push"] : []);
}

export const GITHUB_LOSSY_NAMES = githubLossyNames();

/**
 * ⛔ THE UNCOVERED LIST IS A PROPERTY OF THE REPLICA, NOT OF THIS FILE — the same
 * correction CTC-704 forced on `PUSH_IS_LOSSY`, owed again one name over.
 *
 * `github.check_suite.completed` is emittable exactly when this host's replica has
 * `check_suites.pull_request_numbers` (CTC-712, schema 0.1.18). The pin rolls as a
 * CANARY — mini-2, then mini — so between the two writer restarts one host can emit
 * it and the other cannot, and a constant is necessarily wrong on one of them. Wrong
 * in the dangerous direction it means: smee suppressed for a name this host produces
 * nothing for, so the CI wait hangs with no second copy.
 *
 * ⭐ Default `false` ⇒ UNCOVERED. A caller with no replica handle reports less
 * coverage than it may have, which leaves smee authoritative — the recoverable error.
 */
export function githubUncoveredNames(checkSuiteHasPrAssociation = false) {
  return Object.freeze(checkSuiteHasPrAssociation ? [] : ["github.check_suite.completed"]);
}

/**
 * The suppressible set for ONE host, derived from that host's two capabilities.
 *
 * ⚠️ BOTH DEFAULTS ARE THE PRE-CAPABILITY ANSWER, so calling this with no arguments
 * reproduces today's static set exactly. That is what makes the injection safe to add
 * before anything is wired to it: the wiring changes behaviour, the seam does not.
 */
export function githubSuppressibleNames({
  pushIsLossy = PUSH_IS_LOSSY,
  checkSuiteHasPrAssociation = false,
} = {}) {
  return leafComputeSuppressible({
    consumed: LEAF_CONSUMED_NAMES,
    uncovered: githubUncoveredNames(checkSuiteHasPrAssociation),
    lossy: githubLossyNames(pushIsLossy),
  });
}

/** Re-exported from the leaf so producer, gate and doctor read ONE source. */
export const GITHUB_CONSUMED_NAMES = LEAF_CONSUMED_NAMES;
export const GITHUB_UNCOVERED_NAMES = LEAF_UNCOVERED_NAMES;
export const computeSuppressible = leafComputeSuppressible;
export const EXCLUSION_REASONS = LEAF_EXCLUSION_REASONS;

export const GITHUB_SUPPRESSIBLE_NAMES = computeSuppressible({
  consumed: GITHUB_CONSUMED_NAMES,
  uncovered: GITHUB_UNCOVERED_NAMES,
  lossy: GITHUB_LOSSY_NAMES,
});

const DISPATCH_CLASS_SET = new Set(GITHUB_CONSUMED_NAMES);
const SUPPRESSIBLE_SET = new Set(GITHUB_SUPPRESSIBLE_NAMES);

export const SOURCE_WEBHOOK = "webhook";
export const SOURCE_OTHER = "other";

/** Does this event reach one of the broker router's `github.*` branches? */
export function isGithubDispatchClass(event) {
  return DISPATCH_CLASS_SET.has(getEventName(event));
}

/**
 * sourceOf — which producer wrote this event.
 *
 * Same asymmetry as the Linear gate, for the same reason: the feed's answer is
 * POSITIVE (`body.payload.source === "cloud-feed"`, stamped by
 * `github-feed-event.mjs`), everything else is identified by elimination and lands
 * in `webhook`/`other`, both of which the enforce branch treats as smee. A third
 * producer nobody has thought of must not inherit the feed's authority by default.
 *
 * ⚠️ There is no `INTERNAL_SOURCES` peer here, and that is a measured absence
 * rather than an omission: the Linear leg needs one because `buildResumeEvent`
 * synthesises a `linear.comment.created` that Linear never sees. Nothing on the
 * GitHub side synthesises a `github.*` name — every one of them originates at a
 * real GitHub delivery. If that ever stops being true, this is where it goes, and
 * it goes ABOVE the mode branches.
 */
export function sourceOf(event) {
  const src = event?.body?.payload?.source;
  if (typeof src === "string" && src === SOURCE_CLOUD_FEED) return SOURCE_CLOUD_FEED;
  const delivery = event?.attributes?.["webhook.delivery.id"];
  if (typeof delivery === "string" && delivery !== "") return SOURCE_WEBHOOK;
  return SOURCE_OTHER;
}

/**
 * decideDispatch — the whole gate, as one pure function.
 *
 * @param {object} event  a parsed event-log line
 * @param {object} opts
 * @param {string} opts.mode  "off" | "shadow" | "enforce" (anything else degrades to "off")
 * @param {function|boolean} [opts.isReady]  () => boolean — is the producer currently
 *        arming? Consulted for the SMEE side ONLY; a feed event's authority is carried
 *        by its own emission-time stamp (CTL-1901's asymmetry, inherited verbatim).
 *        Omitted/absent ⇒ NOT ready, so a wiring mistake keeps smee authoritative.
 * @returns {{suppress: boolean, reason: string, source: string, name: string}}
 *
 * `suppress: true` means "do not route this event; write it to the capture sink
 * instead". It never means "discard".
 */
export function decideDispatch(event, { mode, isReady = null, suppressible = null } = {}) {
  const name = getEventName(event);
  const source = sourceOf(event);
  // ⛔ THE HOST'S SET, OR THE STATIC ONE — never a merge of the two. `suppressible`
  // is this replica's answer (see `githubSuppressibleNames`); omitting it keeps the
  // module constant, which under-reports coverage and therefore leaves smee
  // authoritative. Falling back on ANY non-Set value is deliberate: a caller that
  // passes something malformed gets the safe set rather than a crash in the tailer's
  // hot path or, worse, an empty set that suppresses nothing and dispatches both.
  const suppressibleSet =
    suppressible instanceof Set
      ? suppressible
      : Array.isArray(suppressible)
        ? new Set(suppressible)
        : SUPPRESSIBLE_SET;

  if (!DISPATCH_CLASS_SET.has(name)) {
    return { suppress: false, reason: "not-dispatch-class", source, name };
  }

  // An unrecognised mode degrades to today's behaviour, not the new one — a typo in
  // a daemon env var must not cut a host over to an unproven dispatch source.
  const m = GITHUB_FEED_MODES.has(mode) ? mode : "off";

  if (m !== "enforce") {
    if (source === SOURCE_CLOUD_FEED) {
      // Defence in depth: in shadow the producer writes only to its own sink and to
      // `github-feed.would-dispatch`, so a real `github.*` feed event reaching this
      // log means a stale enforce-mode producer survived a rollback. It must not
      // dispatch — that is the precise shape of a rollback that does not roll back.
      return { suppress: true, reason: "feed-not-authoritative", source, name };
    }
    return { suppress: false, reason: "webhook-authoritative", source, name };
  }

  // ───────────────────────────── enforce ─────────────────────────────

  if (source === SOURCE_CLOUD_FEED) {
    // ⛔ A feed event for an EXCLUDED name must not dispatch either. The producer
    // should never emit one — but if a future coverage change lets a name through
    // here while this gate still excludes it, the result would be BOTH copies
    // dispatching (smee is unsuppressed for excluded names by the branch below).
    // Refusing on both sides makes the two halves of the exclusion agree by
    // construction rather than by everyone remembering to change them together.
    if (!suppressibleSet.has(name)) {
      return {
        suppress: true,
        reason: `feed-excluded:${EXCLUSION_REASONS[name] ?? "unknown"}`,
        source,
        name,
      };
    }
    // Absent stamp ⇒ NOT authoritative. Every feed event written by this code path
    // carries one; a line without it predates the stamp or came from somewhere
    // else, and neither is something to dispatch on.
    if (event?.body?.payload?.feedAuthority !== true) {
      return { suppress: true, reason: "feed-emitted-while-unarmed", source, name };
    }
    return { suppress: false, reason: "feed-authoritative", source, name };
  }

  // ── smee (and any unknown producer) ──

  // ⛔ CHECKED BEFORE READINESS, and the order matters. A name with no replacement
  // is unsuppressible no matter how healthy the producer is, so asking "is the
  // producer ready" first would imply that a ready producer could earn the right to
  // suppress `github.pr.merged` — which is the single worst outcome this feature
  // has (the merge→deploy chain, fleet-wide, with no second copy).
  if (!suppressibleSet.has(name)) {
    return {
      suppress: false,
      reason: EXCLUSION_REASONS[name] ?? "no-replacement:unknown",
      source,
      name,
    };
  }

  // The readiness lever, inherited from the Linear gate: enforce does not suppress
  // smee until the producer can actually produce. Absent probe ⇒ not ready.
  let ready = false;
  let reason = "enforce-not-armed";
  try {
    if (typeof isReady === "function") {
      const verdict = isReady();
      // Accepts a bare boolean or a `{ ready, reason }` verdict — the cross-process
      // reader returns the latter so a capture record can say WHY smee kept authority.
      if (typeof verdict === "boolean") ready = verdict;
      else if (verdict && typeof verdict === "object") {
        ready = verdict.ready === true;
        if (typeof verdict.reason === "string" && verdict.reason !== "") {
          reason = `enforce-not-armed:${verdict.reason}`;
        }
      }
    } else if (isReady === true) {
      ready = true;
    }
  } catch {
    ready = false; // a throwing probe is not a ready producer
    reason = "enforce-not-armed:probe-threw";
  }
  if (!ready) {
    return { suppress: false, reason, source, name };
  }

  return { suppress: true, reason: "smee-captured", source, name };
}
