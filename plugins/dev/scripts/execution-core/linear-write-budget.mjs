// linear-write-budget.mjs — CTL-1936.
//
// A host-side ledger and throttle for cloud write-proxy spend.
//
// ── WHAT HAPPENED ──
// mini-2 spent its entire daily cloud write budget — 300/300 for UTC 2026-08-18 — in
// about 13 minutes, on ONE ticket: 302 of 307 writes were `route=label` on CTL-1805,
// a ticket that is Done in Linear and carries only `orchestrator`. Every Linear write
// from that host was then refused (enforce has no direct-write fallback, by design),
// and the same burst would recur at every UTC day boundary.
//
// ⛔ CTC-674 IS NOT THE DEFECT. Before it, removing an already-absent label returned
// 400, so `clearStalledLabel`'s CTL-1078 back-off engaged and held the loop to ~6/hour.
// CTC-674 correctly made that call return 200 `already-absent` — and the back-off, which
// only counts FAILURES, stopped engaging. The loop went from ~6/hour to ~1,700/hour.
// An error response had been doing a rate limiter's job and nobody knew. The idempotency
// fix is right; what was missing is this file.
//
// ── WHY A PER-TICKET CAP AND NOT A HOST CAP ──
// The failure is a non-converging caller, whose signature is volume concentrated on ONE
// ticket — 302 vs 5 for everything else. A host-wide cap would fire on a host that is
// legitimately busy across many tickets, which AC2's own negative control forbids: "a cap
// that fires on healthy fan-out is a worse defect than the one it replaces." So the
// throttle is per-ticket, and a refusal for one ticket never blocks another's writes.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** The cloud-side daily cap this mirrors. Used for the exhaustion signal, not the throttle. */
export const DEFAULT_DAILY_BUDGET = 300;

/**
 * One ticket's share of a day. 50 sits an order of magnitude above what a real ticket
 * spends walking the 10-phase pipeline (state transitions + label add/remove + comments)
 * and an order of magnitude below the 302 the runaway produced, so it separates the two
 * populations rather than splitting either.
 */
export const DEFAULT_PER_TICKET_CAP = 50;

export const REASONS = Object.freeze({
  TICKET_CAP: "budget:ticket-cap",
  DAY_EXHAUSTED: "budget:day-exhausted",
  CONVERGED: "budget:already-converged",
});

/** The UTC day key. Deliberately UTC — the cloud budget resets on the UTC boundary. */
export function utcDayOf(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function emptyLedger(day) {
  return { day, total: 0, byTicket: {}, converged: {}, exhaustedAnnounced: false };
}

/**
 * readLedger — TRI-STATE, and the three states are not interchangeable.
 *
 *   { state: "fresh"   } — no ledger yet (ENOENT). A new day's worth of budget is correct.
 *   { state: "loaded"  } — a usable ledger.
 *   { state: "unusable"} — the file exists but cannot be read or parsed.
 *
 * ⛔ `unusable` is NOT folded into `fresh`. A corrupt ledger silently granting a full
 * budget, and then being overwritten, is how a durable guard gets disarmed by the very
 * corruption it exists to survive (the CTL-1659 shape). The caller is told, and says so.
 */
export function readLedger(path, { readFileFn = readFileSync } = {}) {
  let raw;
  try {
    raw = readFileFn(path, "utf8");
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return { state: "fresh" };
    return { state: "unusable", reason: `unreadable: ${err?.code ?? err?.message ?? "unknown"}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "unusable", reason: "unparseable" };
  }
  // Field types are checked BEFORE any coercion: Number(null) and Number([]) are 0, which
  // reads as "nothing spent yet" and hands a runaway a full fresh budget out of a file
  // that is telling us it is broken.
  if (!parsed || typeof parsed !== "object" || typeof parsed.day !== "string") {
    return { state: "unusable", reason: "malformed" };
  }
  if (typeof parsed.total !== "number" || !Number.isFinite(parsed.total)) {
    return { state: "unusable", reason: "malformed-total" };
  }
  if (!parsed.byTicket || typeof parsed.byTicket !== "object" || Array.isArray(parsed.byTicket)) {
    return { state: "unusable", reason: "malformed-byTicket" };
  }
  return {
    state: "loaded",
    ledger: {
      day: parsed.day,
      total: parsed.total,
      byTicket: parsed.byTicket,
      converged:
        parsed.converged && typeof parsed.converged === "object" && !Array.isArray(parsed.converged)
          ? parsed.converged
          : {},
      exhaustedAnnounced: parsed.exhaustedAnnounced === true,
    },
  };
}

/**
 * rollToDay — the reset is by DAY KEY, never by process start.
 * A ledger whose day differs from today's is replaced, not merged: yesterday's spend has
 * no claim on today's budget, and carrying it forward would throttle a healthy morning.
 */
export function rollToDay(ledger, day) {
  if (!ledger || ledger.day !== day) return emptyLedger(day);
  return ledger;
}

/**
 * classifyWrite — pure. Decide whether this write may be issued.
 *
 * `convergenceKey` (optional) identifies a write whose desired state the cloud has already
 * confirmed reached — see noteConvergence. Passing one is what makes AC3 work; omitting it
 * simply means this write is never suppressed as converged.
 */
export function classifyWrite({
  ledger,
  ticket,
  convergenceKey = null,
  dailyBudget = DEFAULT_DAILY_BUDGET,
  perTicketCap = DEFAULT_PER_TICKET_CAP,
}) {
  const spentForTicket = Number(ledger?.byTicket?.[ticket] ?? 0) || 0;
  const total = Number(ledger?.total ?? 0) || 0;

  if (convergenceKey && ledger?.converged?.[convergenceKey]) {
    return { allow: false, reason: REASONS.CONVERGED, spentForTicket, total };
  }
  // ⛔ Per-ticket BEFORE host-wide: when a single runaway has eaten the day, the honest
  // reason is that ticket's cap, not "the host is out" — and naming the host would send an
  // operator looking for a fleet problem instead of the one stuck caller.
  if (spentForTicket >= perTicketCap) {
    return { allow: false, reason: REASONS.TICKET_CAP, spentForTicket, total, cap: perTicketCap };
  }
  if (total >= dailyBudget) {
    return { allow: false, reason: REASONS.DAY_EXHAUSTED, spentForTicket, total, cap: dailyBudget };
  }
  return { allow: true, reason: null, spentForTicket, total };
}

/** recordWrite — pure. Count a write that was actually ISSUED (not one refused locally). */
export function recordWrite(ledger, ticket) {
  const key = ticket || "<no-ticket>";
  const byTicket = { ...(ledger.byTicket ?? {}) };
  byTicket[key] = (Number(byTicket[key] ?? 0) || 0) + 1;
  return { ...ledger, total: (Number(ledger.total ?? 0) || 0) + 1, byTicket };
}

/**
 * noteConvergence — pure. Record that the cloud confirmed the desired state is ALREADY
 * reached, so an identical write need not be issued again.
 *
 * ⛔ This is NOT a failure. It must never feed the CTL-1078 removal-failure counter:
 * folding it in would restore the old throttle by re-introducing a lie — the write
 * succeeded. Convergence and failure are different states and stay different.
 */
export function noteConvergence(ledger, convergenceKey) {
  if (!convergenceKey) return ledger;
  return { ...ledger, converged: { ...(ledger.converged ?? {}), [convergenceKey]: true } };
}

/** clearConvergence — a genuinely-present label must still remove normally (AC3 control). */
export function clearConvergence(ledger, convergenceKey) {
  if (!convergenceKey || !ledger?.converged?.[convergenceKey]) return ledger;
  const converged = { ...ledger.converged };
  delete converged[convergenceKey];
  return { ...ledger, converged };
}

/**
 * convergenceKeyFor — identifies "this exact desired state, for this ticket".
 * Route + ticket + a stable render of the payload's identity fields. A DIFFERENT label on
 * the same ticket is a different key, so suppressing one never suppresses another.
 */
export function convergenceKeyFor({ routeId, ticket, payload }) {
  if (!routeId || !ticket) return null;
  const ids = Array.isArray(payload?.labelIds) ? [...payload.labelIds].sort().join(",") : "";
  const mode = payload?.mode ?? "";
  if (!ids || !mode) return null;
  return `${routeId}:${ticket}:${mode}:${ids}`;
}

/**
 * classifyExhaustion — edge-triggered (AC5): raise ONCE per episode, not once per refused
 * write. A budget storm is exactly when a per-event alarm buries the one line that matters.
 */
export function classifyExhaustion(ledger, { dailyBudget = DEFAULT_DAILY_BUDGET } = {}) {
  const total = Number(ledger?.total ?? 0) || 0;
  const exhausted = total >= dailyBudget;
  if (!exhausted) return { exhausted: false, announce: false };
  return { exhausted: true, announce: ledger?.exhaustedAnnounced !== true };
}

export function markExhaustionAnnounced(ledger) {
  return { ...ledger, exhaustedAnnounced: true };
}

/** writeLedger — atomic tmp+rename; never leaves a half-written ledger for the next read. */
export function writeLedger(
  path,
  ledger,
  { writeFileFn = writeFileSync, renameFn = renameSync, mkdirFn = mkdirSync } = {}
) {
  const tmp = `${path}.tmp.${process.pid}`;
  mkdirFn(dirname(path), { recursive: true });
  writeFileFn(tmp, `${JSON.stringify(ledger)}\n`, "utf8");
  renameFn(tmp, path);
}
