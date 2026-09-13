// linear-write-path.mjs — CTL-1961. The ONE decision the agent tools share: given the
// write-proxy mode and whether a transport could actually be constructed, does this write
// go through the cloud, go direct, or get REFUSED?
//
// ⛔ WHY THIS IS A SEPARATE, PURE LEAF.
// `linear-ack.mjs` and `linear-reply.mjs` are side-effecting scripts with top-level await
// — they mint a token and write to Linear the moment they are imported, so their routing
// logic cannot be unit-tested in place. Extracting the decision is what makes it testable
// at all, and it is also what stops the two tools growing separate dialects of "what does
// shadow mean" (the drift `linear-comment-write.mjs`'s own header warns about).
//
// ⛔ THE UNAVAILABLE CASE IS NOT `off`, AND THAT DISTINCTION IS THE WHOLE POINT.
// A tool that cannot reach the proxy modules — an out-of-tree copy (CTL-2026), a renamed
// export, a broken checkout — looks EXACTLY like a host with the proxy switched off if you
// collapse both to "no transport". The first cut of this change imported an export name
// that does not exist (`getLinearWriteProxy`, which lives in a different module and returns
// an installed singleton nothing installs in a standalone script); it would have written
// direct forever while reporting itself as a routed tool. So `unavailable` is carried as a
// REASON, and under `enforce` it REFUSES rather than silently falling back — a fallback
// there would defeat the gate on precisely the runs the gate exists for.
//
// Zero imports on purpose: these tools run under bare `node` from an arbitrary cwd.

/** The modes the write proxy understands. Anything else is treated as `off`. */
export const WRITE_PROXY_MODES = Object.freeze(["off", "shadow", "enforce"]);

/**
 * decideWritePath — pure.
 *
 * @param {object}  o
 * @param {string}  o.mode                the resolved proxy mode
 * @param {boolean} o.proxyReady          a transport was actually constructed
 * @param {string|null} o.unavailableReason  why not, when !proxyReady
 * @returns {{action:"proxy"|"direct"|"refuse", observe:boolean, reason:string|null}}
 *   action  — proxy: the cloud performs the write · direct: this host performs it
 *             · refuse: perform NOTHING and exit non-zero
 *   observe — send a non-authoritative observation first, then do the direct write
 *             (shadow only). A reaction is a WRITE, so "observe by doing it too" would
 *             double-write; the observation carries an empty payload.
 *   reason  — set whenever the caller should say something out loud.
 */
export function decideWritePath({ mode, proxyReady = false, unavailableReason = null } = {}) {
  const m = WRITE_PROXY_MODES.includes(mode) ? mode : "off";

  if (m === "off") return { action: "direct", observe: false, reason: null };

  if (m === "enforce") {
    if (proxyReady) return { action: "proxy", observe: false, reason: null };
    // ⛔ Never `direct`. An enforce host that cannot reach the proxy is a host whose
    // operator believes its writes are routed; writing direct would make that belief
    // false and silent at the same time.
    return {
      action: "refuse",
      observe: false,
      reason: unavailableReason ?? "proxy unavailable under enforce",
    };
  }

  // shadow: the direct write still happens; the observation is best-effort. An
  // unavailable proxy here is worth SAYING but must not block the write, because shadow's
  // contract is "change nothing that the operator can see in Linear".
  return proxyReady
    ? { action: "direct", observe: true, reason: null }
    : { action: "direct", observe: false, reason: unavailableReason ?? "proxy unavailable under shadow" };
}
