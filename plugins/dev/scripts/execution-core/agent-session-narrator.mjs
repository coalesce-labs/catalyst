// agent-session-narrator.mjs — CTL-1943 (COORD-107 decision 1, under COORD-122's contract).
//
// Makes a ticket being worked VISIBLE where the work is tracked: as a Linear agent
// session whose plan is the pipeline and whose activities are the phase transitions.
// The cloud half is CTC-682 (catalyst-cloud#780, POST /api/v1/agent/session).
//
// ── ⛔ THE ONE CONSTRAINT THAT SHAPES EVERYTHING HERE ──
// The single shared dispatch seam, `dispatchTicket`, is called from INSIDE the
// synchronous `schedulerTick`. The write-proxy's normal transport is a `spawnSync` of
// curl with a 20 s ceiling. So narrating from this seam on the synchronous path would
// add up to 20 s PER DISPATCH to a tick that CTL-1524 already records as blocking the
// daemon's event loop — a fleet-wide stall traded for a status line.
//
// COORD-122 decided the asymmetry: this route, and ONLY this route, is non-blocking.
// The mechanism lives in linear-write-proxy.mjs (`sendAsync` / NON_BLOCKING_ROUTE_IDS);
// this module is the caller. `narrate` therefore:
//   • never returns a promise the tick could be tempted to await,
//   • never throws — a narration defect must not fail a dispatch,
//   • reports every refusal with the TICKET and the PHASE, because "narration failed"
//     without them is an alert nobody can act on.
//
// ⚠️ WHAT A MISSING NARRATION LOOKS LIKE, so nobody reads it as a dead agent: CTC-682's
// own author flagged that a session which stops emitting goes `stale` at 30 min and then
// reads as "the agent didn't start". A refused or failed narration here is exactly that
// shape, which is why every refusal is named and logged rather than counted.
//
// ── THE PAYLOAD CONTRACT (read off the merged route, not guessed) ──
//   { issueId, plan: [{content, status}], activity: {...} }
//   `plan` is a BARE ARRAY and its entries use `content` — Linear rejects `title` with
//   "Unrecognized key". An EMPTY plan is refused by the cloud on purpose ("an empty plan
//   would erase a visible one"), so `buildSessionPayload` never emits one. An
//   unrecognized `activity.type` is refused by name rather than defaulted.

import { PHASES } from "../lib/workflow-descriptor.mjs";

/** The Linear plan-entry statuses. Frozen — this is the cloud's vocabulary, not ours. */
export const PLAN_STATUS = Object.freeze({
  PENDING: "pending",
  IN_PROGRESS: "inProgress",
  COMPLETED: "completed",
  CANCELED: "canceled",
});

/** The route id in linear-write-proxy's registry. */
export const SESSION_ROUTE_ID = "session";

/** Names this call site in every proxy event (CTL-1936 / AC4 attribution). */
export const NARRATOR_CALLER = "agent-session-narrator";

/**
 * planFor — the pipeline as a Linear plan, with the current phase in progress.
 *
 * Every phase BEFORE the current one reads `completed`. That is a statement about
 * pipeline POSITION, not about outcome: the pipeline is strictly ordered, so reaching
 * phase N means N-1 terminated. It deliberately does not try to reconstruct per-phase
 * success from signal files — that would be a second source of truth for "what happened",
 * which is the cost option 1 in the ticket was rejected for.
 *
 * An unknown phase (an ancillary step like `remediate`, or a typo) yields a plan with
 * nothing in progress rather than throwing — the caller's dispatch must not depend on
 * this function's opinion of a phase name.
 */
export function planFor(phase, { phases = PHASES, closed = false } = {}) {
  const idx = phases.indexOf(phase);
  return phases.map((p, i) => {
    if (closed) return { content: p, status: PLAN_STATUS.COMPLETED };
    if (idx < 0) return { content: p, status: PLAN_STATUS.PENDING };
    if (i < idx) return { content: p, status: PLAN_STATUS.COMPLETED };
    if (i === idx) return { content: p, status: PLAN_STATUS.IN_PROGRESS };
    return { content: p, status: PLAN_STATUS.PENDING };
  });
}

/**
 * isClosingPhase — is this dispatch the pipeline's last?
 *
 * `teardown` is the terminal step, so dispatching it is the only moment this seam sees
 * that can honestly be called "close". Derived from the descriptor's last element rather
 * than a literal, so a descriptor change cannot leave a hardcoded name behind.
 */
export function isClosingPhase(phase, { phases = PHASES } = {}) {
  return phases.length > 0 && phase === phases[phases.length - 1];
}

/**
 * buildSessionPayload — pure. The whole request body for one narration.
 *
 * The closing dispatch sends a `response` activity, which is the route's terminal type;
 * every other dispatch sends an `action` naming the phase. `action` is used rather than
 * `thought` because a phase dispatch is something the agent DID, and the route models
 * that distinction.
 */
export function buildSessionPayload({ issueId, phase, phases = PHASES, host = null }) {
  const closed = isClosingPhase(phase, { phases });
  const activity = closed
    ? {
        type: "response",
        body: `Pipeline complete — \`${phase}\` dispatched, all ${phases.length} phases done.`,
      }
    : {
        type: "action",
        action: `Dispatch \`${phase}\``,
        parameter: phase,
      };
  return {
    issueId,
    plan: planFor(phase, { phases, closed }),
    activity,
    ...(host ? { hostId: host } : {}),
  };
}

/**
 * createAgentSessionNarrator — bind the transport and the id resolver.
 *
 * Returns `{ narrate }`, or null when there is nothing to narrate through. A null
 * narrator is the DEFAULT state of the daemon (the proxy is `off` unless configured), so
 * the no-narrator path is the one that must stay free — `dispatchTicket` treats a null
 * narrator as a no-op.
 */
export function createAgentSessionNarrator({ proxy, resolver = null, log = null, phases = PHASES } = {}) {
  if (!proxy || typeof proxy.sendAsync !== "function") return null;

  return {
    /**
     * narrate — one call per dispatched phase. SYNCHRONOUS AND TOTAL.
     *
     * ⛔ Returns a plain verdict object and NEVER a promise: the tick must not be able to
     * await this even by accident. It also never throws — every failure path below ends
     * in a named, logged verdict, because a narration defect that fails a dispatch would
     * be strictly worse than no narration at all.
     */
    narrate(ticket, phase, { host = null } = {}) {
      try {
        if (typeof ticket !== "string" || ticket.trim() === "") {
          return { narrated: false, reason: "no-ticket" };
        }
        if (typeof phase !== "string" || phase.trim() === "") {
          return { narrated: false, reason: "no-phase" };
        }

        // ⛔ The issue UUID comes from the freshness-gated replica resolver, exactly like
        // every other proxied write. There is no live-Linear fallback ON PURPOSE: this
        // route is worth zero dispatch risk and zero shared-quota API calls, so an
        // unresolvable ticket is a named skip, not a reason to reach for the API.
        if (!resolver || typeof resolver.issue !== "function") {
          return { narrated: false, reason: "no-resolver" };
        }
        const r = resolver.issue(ticket);
        if (!r?.ok) {
          const reason = `resolve:${r?.reason ?? "unknown"}`;
          log?.warn?.({ ticket, phase, reason }, "agent-session: cannot resolve issue id — narration skipped");
          return { narrated: false, reason };
        }

        const payload = buildSessionPayload({ issueId: r.issueId, phase, phases, host });
        const res = proxy.sendAsync({
          routeId: SESSION_ROUTE_ID,
          ticket,
          phase,
          payload,
          caller: NARRATOR_CALLER,
        });
        return { narrated: res?.dispatched === true, reason: res?.reason ?? null };
      } catch (err) {
        // The catch-all exists so this function's own defects can never reach the
        // scheduler. It is not a place to hide one — it logs with ticket and phase.
        log?.warn?.(
          { ticket, phase, err: String(err?.message ?? err).slice(0, 200) },
          "agent-session: narration threw — dispatch unaffected"
        );
        return { narrated: false, reason: "narrator-threw" };
      }
    },
  };
}
