// preempt-budget.mjs — CTL-2192 Phase 3: the durable cross-lap bound on how
// often ONE victim may be preempted.
//
// scheduler.mjs deletes the in-memory hysteresis key after each successful
// preemption (`rankedAboveSince.delete(hysteresisKey)`), so the same (preemptor,
// victim) pair restarts a fresh 30 s clock forever — a correct preempt→resume
// pair repeated without end. And `rankedAboveSince` is MODULE state, so a daemon
// bounce erases even the within-lap memory. This ledger is the cross-lap bound;
// it is a FILE precisely so that neither of those holds.
//
// It lives in the ticket's own worker dir, so it is GC'd with the ticket — the
// same placement precedent as `.triage-dispatch-counts/` and `.runaway-alerts/`.
//
// FAIL DIRECTION: this is a damper on a working mechanism, not a safety
// interlock. Every unreadable / unwritable path degrades toward TODAY'S
// behaviour (preemption still allowed), because failing closed here would let a
// single corrupt file freeze genuine priority preemption for a ticket forever.
//
// LEAF MODULE: node:fs/node:path only.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// How many times one victim may be preempted inside the window before it becomes
// temporarily non-preemptable. CHOSEN, not derived: research measured 10 claims
// in ~30 min for CTL-2128 and 8 in ~17 min for CTC-355, so 3 sits comfortably
// below the observed pathology while leaving genuine priority preemption room.
// Env-overridable so an operator can tune without a deploy.
export const PREEMPT_MAX_LAPS = envInt("SCHEDULER_PREEMPT_MAX_LAPS", 3);

// The window the count is scoped to. Expiry is what makes this DAMPING rather
// than a permanent exemption.
//
// ⚠️ BOUNDARY, by design: the window is anchored at the FIRST lap and never
// slides (see recordPreemption), so laps clustered at the end of one window plus
// laps at the start of the next can reach up to 2x maxLaps within minutes. That
// is the price of an anchor that can actually EXPIRE under a sustained lap — a
// sliding window would keep resetting and the bound would never be reachable.
// Documented in the configuration reference rather than left for a reader to
// discover from the arithmetic.
export const PREEMPT_BUDGET_WINDOW_MS = envInt("SCHEDULER_PREEMPT_BUDGET_WINDOW_MS", 30 * 60_000);

// ── the PREEMPTOR-side bound ────────────────────────────────────────────────
//
// The victim budget alone bounds one VICTIM, not the storm. The sweep scans
// inFlightRanked from lowest-ranked toward highest, so an exhausted victim does
// not stop the preemption — it hands it to the next, BETTER-ranked in-flight
// worker. Under the preempt-never-launch shape this fleet has hit repeatedly
// (CTC-829, CTL-1550, CTL-1681) a preemptor that wins the ranking but can never
// dispatch would burn victim A's laps, then B's, then C's, evicting
// progressively more valuable work. The bound would be maxLaps x |victims|, and
// the storm redirected rather than stopped.
//
// A preemptor-side counter is a good proxy for "won the eviction and still never
// took the slot": buildGlobalRanking's queued descriptors are exactly the
// eligible tickets with NO workers/<ticket>/ dir, so a preemptor that actually
// launched stops being `topQueued` and stops accruing. One that keeps accruing
// is, by construction, one that keeps evicting without ever running.
export const PREEMPTOR_MAX_LAPS = envInt("SCHEDULER_PREEMPTOR_MAX_LAPS", PREEMPT_MAX_LAPS);

// The ONE spelling of the audit event's action, so recovery.mjs's emitter and
// broker/namespace-parity.test.mjs read the same string rather than two
// hand-typed copies that can drift apart.
export const PREEMPT_BUDGET_EXHAUSTED_ACTION = "preempt-budget-exhausted";

// `scheduler` is an allowed phase-slot exception and this action is not in
// PHASE_EVENT_PATTERN's terminal set, so the name is pure audit with no wake.
export function preemptBudgetExhaustedEventName(ticket) {
  return `phase.scheduler.${PREEMPT_BUDGET_EXHAUSTED_ACTION}.${ticket}`;
}

const FILE = ".preempt-budget.json";
const ALERT_FILE = ".preempt-budget-alert.json";

// The preemptor's ledger canNOT live in workers/<ticket>/: a preemptor is by
// definition a ticket with no worker dir, and CREATING one would make
// listStartedTickets read it as in-flight — turning a damper into a phantom
// dispatch. It gets an orchDir-level dir instead, self-pruned on write.
const PREEMPTOR_DIR = ".preempt-budget";

// Ticket ids are `TEAM-123`. Anything else never becomes a path component.
const SAFE_TICKET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function preemptBudgetPath(orchDir, ticket) {
  return join(orchDir, "workers", ticket, FILE);
}

export function preemptBudgetAlertPath(orchDir, ticket) {
  return join(orchDir, "workers", ticket, ALERT_FILE);
}

/** @returns {string|null} null when the ticket is not a safe path component. */
export function preemptorBudgetPath(orchDir, ticket) {
  if (typeof ticket !== "string" || !SAFE_TICKET.test(ticket)) return null;
  return join(orchDir, PREEMPTOR_DIR, `${ticket}.json`);
}

export function preemptorBudgetAlertPath(orchDir, ticket) {
  if (typeof ticket !== "string" || !SAFE_TICKET.test(ticket)) return null;
  return join(orchDir, PREEMPTOR_DIR, `${ticket}.alert.json`);
}

/**
 * Drop preemptor ledgers whose window is long expired. The victim ledger is GC'd
 * with its worker dir; this one has no such owner, so it prunes itself. Bounded
 * and best-effort — a failed prune must never abort a preemption sweep.
 */
export function prunePreemptorBudgets(orchDir, { now = Date.now, windowMs = PREEMPT_BUDGET_WINDOW_MS } = {}) {
  const dir = join(orchDir, PREEMPTOR_DIR);
  const cutoff = now() - windowMs * 2;
  let pruned = 0;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { pruned: 0 };
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      if (statSync(join(dir, name)).mtimeMs > cutoff) continue;
      rmSync(join(dir, name), { force: true });
      pruned++;
    } catch {
      /* best-effort */
    }
  }
  return { pruned };
}

/**
 * Read the ledger. TRI-STATE on readability: an absent file is a genuine zero,
 * but a file that exists and cannot be parsed (or carries wrong-typed fields) is
 * `readable: false` — never a fresh zero. Collapsing the two would let a corrupt
 * ledger silently restore the unbounded lap it exists to bound.
 *
 * @returns {{count: number, windowStartedAt: number|null, readable: boolean}}
 */
export function readPreemptBudget(orchDir, ticket, { pathFor = preemptBudgetPath } = {}) {
  const file = pathFor(orchDir, ticket);
  // An unresolvable path (unsafe ticket id) is NOT a fresh zero — it is a read we
  // could not perform. Same tri-state discipline as a corrupt file.
  if (!file) return { count: 0, windowStartedAt: null, readable: false };
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    // ENOENT is the honest zero: nothing has been recorded for this ticket.
    if (err?.code === "ENOENT") return { count: 0, windowStartedAt: null, readable: true };
    return { count: 0, windowStartedAt: null, readable: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { count: 0, windowStartedAt: null, readable: false };
  }
  // Type-check BEFORE any coercion: Number(null) and Number([]) are both 0, so a
  // bogus field would read as "nothing spent yet" — the ledger disarmed by the
  // corruption it is supposed to survive.
  if (typeof parsed?.count !== "number" || !Number.isFinite(parsed.count)) {
    return { count: 0, windowStartedAt: null, readable: false };
  }
  if (typeof parsed?.windowStartedAt !== "number" || !Number.isFinite(parsed.windowStartedAt)) {
    return { count: 0, windowStartedAt: null, readable: false };
  }
  return { count: parsed.count, windowStartedAt: parsed.windowStartedAt, readable: true };
}

/**
 * Has this victim spent its budget inside the live window?
 * @returns {{exhausted: boolean, count: number, windowStartedAt: number|null, readable: boolean}}
 */
export function isPreemptBudgetExhausted(
  orchDir,
  ticket,
  { now = Date.now, maxLaps = PREEMPT_MAX_LAPS, windowMs = PREEMPT_BUDGET_WINDOW_MS, pathFor = preemptBudgetPath } = {},
) {
  const b = readPreemptBudget(orchDir, ticket, { pathFor });
  // Fail toward today's behaviour — see the FAIL DIRECTION note above.
  if (!b.readable) return { ...b, exhausted: false };
  if (b.windowStartedAt == null) return { ...b, exhausted: false };
  const windowLive = now() - b.windowStartedAt <= windowMs;
  return { ...b, exhausted: windowLive && b.count >= maxLaps };
}

/**
 * Record one performed preemption. Opens a window on the first one and on the
 * first one past an expired window; otherwise increments WITHOUT moving the
 * window — a window that slid forward on every write could never expire under a
 * sustained lap, which is exactly when the bound has to be reachable.
 *
 * Never throws: an unwritable worker dir must not abort the preemption sweep.
 *
 * @returns {{count: number, windowStartedAt: number|null, written: boolean}}
 */
export function recordPreemption(
  orchDir,
  ticket,
  { now = Date.now, windowMs = PREEMPT_BUDGET_WINDOW_MS, pathFor = preemptBudgetPath, ensureDir = false } = {},
) {
  const ts = now();
  const prev = readPreemptBudget(orchDir, ticket, { pathFor });
  // A corrupt ledger is REPLACED by a fresh window rather than incremented from
  // a base we could not read.
  const continuing = prev.readable && prev.windowStartedAt != null && ts - prev.windowStartedAt <= windowMs;
  const next = continuing
    ? { count: prev.count + 1, windowStartedAt: prev.windowStartedAt }
    : { count: 1, windowStartedAt: ts };
  const file = pathFor(orchDir, ticket);
  if (!file) return { ...next, written: false };
  try {
    if (ensureDir) mkdirSync(join(file, ".."), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, file);
    return { ...next, written: true };
  } catch {
    return { ...next, written: false };
  }
}

// ── the preemptor-side wrappers ─────────────────────────────────────────────
//
// Same ledger semantics, different owner and a different default cap. Kept as
// named wrappers rather than making every call site pass `pathFor` by hand, so a
// site cannot silently read the victim ledger while believing it read the
// preemptor's.

/** @returns {{exhausted: boolean, count: number, windowStartedAt: number|null, readable: boolean}} */
export function isPreemptorBudgetExhausted(orchDir, ticket, { now = Date.now, maxLaps = PREEMPTOR_MAX_LAPS, windowMs = PREEMPT_BUDGET_WINDOW_MS } = {}) {
  return isPreemptBudgetExhausted(orchDir, ticket, { now, maxLaps, windowMs, pathFor: preemptorBudgetPath });
}

/** @returns {{count: number, windowStartedAt: number|null, written: boolean}} */
export function recordPreemptorLap(orchDir, ticket, { now = Date.now, windowMs = PREEMPT_BUDGET_WINDOW_MS } = {}) {
  return recordPreemption(orchDir, ticket, { now, windowMs, pathFor: preemptorBudgetPath, ensureDir: true });
}

// ── once-per-window announcement guard ──────────────────────────────────────
//
// The exhausted verdict is re-derived on EVERY tick for as long as the window
// is live, so an ungated emit would write one event every ~2 minutes for 30
// minutes per victim — re-creating the per-tick event burn this ticket exists to
// stop. Keyed on the WINDOW, not on a separate timestamp, so a fresh window
// always announces exactly once. Same shape as CTL-671's `.runaway-alerts`
// marker; an absent/malformed marker reads as "not yet announced", because
// missing an alert is worse than repeating one.

/** @returns {boolean} true iff this window's exhaustion has already been announced. */
export function budgetExhaustionAnnounced(orchDir, ticket, windowStartedAt, { pathFor = preemptBudgetAlertPath } = {}) {
  const file = pathFor(orchDir, ticket);
  if (!file) return false;
  let seen;
  try {
    seen = JSON.parse(readFileSync(file, "utf8"))?.windowStartedAt;
  } catch {
    return false;
  }
  return typeof seen === "number" && seen === windowStartedAt;
}

/** Record that this window's exhaustion has been announced. Never throws. */
export function recordBudgetExhaustionAnnounced(
  orchDir,
  ticket,
  windowStartedAt,
  { pathFor = preemptBudgetAlertPath, ensureDir = false } = {},
) {
  const file = pathFor(orchDir, ticket);
  if (!file) return false;
  try {
    if (ensureDir) mkdirSync(join(file, ".."), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ ticket, windowStartedAt }));
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Preemptor-side twin of budgetExhaustionAnnounced. */
export function preemptorExhaustionAnnounced(orchDir, ticket, windowStartedAt) {
  return budgetExhaustionAnnounced(orchDir, ticket, windowStartedAt, { pathFor: preemptorBudgetAlertPath });
}

/** Preemptor-side twin of recordBudgetExhaustionAnnounced. */
export function recordPreemptorExhaustionAnnounced(orchDir, ticket, windowStartedAt) {
  return recordBudgetExhaustionAnnounced(orchDir, ticket, windowStartedAt, {
    pathFor: preemptorBudgetAlertPath,
    ensureDir: true,
  });
}
