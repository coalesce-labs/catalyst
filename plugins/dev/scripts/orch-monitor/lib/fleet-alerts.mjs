// fleet-alerts.mjs — CTL-2161. The board's FLEET-SCOPED alert strip.
//
// ── WHY THIS EXISTS ──
// This epic deletes the `needs-human` Linear label. Measured on 86 items flagged
// as waiting on a human: 3 genuinely were, and 41 were the model provider being
// overloaded — escalated one ticket at a time. The replacement splits in two:
//
//   SYSTEM trouble → ONE fleet alert, auto-clearing, ZERO per-ticket artifacts.
//   A genuine ask  → ONE ask ticket carrying `blocks` to the work it holds up.
//
// The ask half already has a board surface: the Inbox "Needs you" section IS the
// ask section (board-data.mjs deriveAttention). The SYSTEM half had NONE. Without
// this module the board would go quiet during an outage: the label that used to
// (wrongly, per-ticket) light it up is gone, and the CTL-2156 alerts it was
// replaced with reached the event log and stopped there. A quiet board during an
// outage is the plan's named worst outcome — strictly worse than the bin, because
// at least the bin was visible.
//
// ⛔ THE STRIP IS FLEET-SCOPED, NOT PER-TICKET. One provider outage is ONE row
// however many tickets it touches. If this ever grows a per-ticket row it has
// re-created the thing the epic deleted.
//
// PURE fold + a bounded, fail-open reader. The fold is exported separately so the
// contract is unit-testable without an event log.

import { createReadStream, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The alert event names — mirrors broker/alert-emit.mjs (ALERT_RAISED/CLEARED).
 *  A deliberate local mirror: orch-monitor must not import the broker's module
 *  graph. Pinned by fleet-alerts.test.mjs against the broker's own constants. */
export const ALERT_RAISED = "catalyst.alert.raised";
export const ALERT_CLEARED = "catalyst.alert.cleared";

/** Operator-facing one-liners per kind. An UNKNOWN kind is rendered by its raw
 *  kind string rather than dropped — a new broker alert must never be invisible
 *  here just because this table has not caught up. */
export const ALERT_KIND_TITLES = Object.freeze({
  system_down: "The monitor went quiet",
  provider_degraded: "The model provider is degraded",
  rate_limit_exhausted: "A rate limit / budget is exhausted",
  capacity_unavailable: "No execution capacity",
  system_stall: "Tickets are stalled on a system condition",
});

const isStr = (v) => typeof v === "string" && v !== "";

/**
 * foldFleetAlerts — PURE. Reduce a chronological sequence of alert envelopes to
 * the alerts that are currently RAISED, newest-first.
 *
 * The state machine is per KIND (event.label), which is what makes forty
 * overloaded tickets one row: the broker's level alarm already fans them in, and
 * `raised` for a kind already raised UPDATES that row rather than adding one.
 *
 * ⛔ ORDER, NOT TIMESTAMPS. The fold trusts the log's append order, not `ts` —
 * a producer with a skewed clock must not be able to resurrect a cleared alert.
 * ⛔ AN UNPARSEABLE ENVELOPE IS SKIPPED, NEVER TREATED AS A CLEAR. Silently
 * clearing a live alert on a malformed line is the failure this module exists to
 * avoid; the conservative direction is to leave the alert standing.
 *
 * @param {Iterable<object>} envelopes  parsed event-log objects, oldest first
 * @returns {Array<{kind:string,title:string,reason:string|null,count:number|null,raisedAt:string|null}>}
 */
export function foldFleetAlerts(envelopes) {
  const live = new Map();
  for (const ev of envelopes ?? []) {
    const name = ev?.attributes?.["event.name"];
    if (name !== ALERT_RAISED && name !== ALERT_CLEARED) continue;
    const kind = ev?.attributes?.["event.label"] ?? ev?.body?.payload?.kind ?? null;
    if (!isStr(kind)) continue; // unreadable kind → skip; never a clear-all
    if (name === ALERT_CLEARED) {
      live.delete(kind);
      continue;
    }
    const p = ev?.body?.payload ?? {};
    const prior = live.get(kind);
    live.set(kind, {
      kind,
      title: ALERT_KIND_TITLES[kind] ?? kind,
      reason: isStr(p.reason) ? p.reason : null,
      count: typeof p.count === "number" && Number.isFinite(p.count) ? p.count : null,
      // The FIRST raise is the honest "how long has this been going on" anchor —
      // a re-raise at a higher level must not reset the clock.
      raisedAt: prior?.raisedAt ?? (isStr(ev?.ts) ? ev.ts : null),
    });
  }
  return [...live.values()].reverse();
}

/** The canonical monthly event log path (UTC month), matching
 *  execution-core/config.mjs::getEventLogPath and respond-ticket.mjs. */
export function eventLogPath({ env = process.env, now = new Date() } = {}) {
  const root = env.CATALYST_DIR ? env.CATALYST_DIR : join(homedir(), "catalyst");
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(root, "events", `${month}.jsonl`);
}

/** How much of the tail to read. The alert stream is low-volume but shares the
 *  log with everything else, so this is sized to comfortably span a day of fleet
 *  traffic while staying a bounded read on the board's refresh cadence. */
export const TAIL_BYTES = 8 * 1024 * 1024;

/**
 * readFleetAlerts — the live fleet alert set for the board payload.
 *
 * Reads a BOUNDED tail of the monthly event log and folds it. FAIL-OPEN: any
 * error (absent log, unreadable, mid-write) degrades to [] — the board renders
 * without the strip rather than throwing out of the assemble (CTL-883 posture).
 *
 * ⚠️ A truncated FIRST line is expected (the tail starts mid-record) and is
 * dropped by the per-line JSON.parse guard, like any other malformed line.
 */
export async function readFleetAlerts({
  logPath = null,
  env = process.env,
  now = new Date(),
} = {}) {
  const path = logPath ?? eventLogPath({ env, now });
  try {
    if (!existsSync(path)) return [];
    const size = statSync(path).size;
    const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
    const envelopes = [];
    let carry = "";
    await new Promise((resolve, reject) => {
      const rs = createReadStream(path, { start, encoding: "utf8" });
      rs.on("data", (chunk) => {
        carry += chunk;
        const lines = carry.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          if (line === "") continue;
          // Cheap pre-filter: the log is dominated by non-alert events, and
          // JSON.parse on every line of an 8 MB tail is the expensive part.
          if (!line.includes("catalyst.alert.")) continue;
          try {
            envelopes.push(JSON.parse(line));
          } catch {
            /* malformed / truncated line → skip (never a clear) */
          }
        }
      });
      rs.on("error", reject);
      rs.on("end", resolve);
    });
    if (carry !== "" && carry.includes("catalyst.alert.")) {
      try {
        envelopes.push(JSON.parse(carry));
      } catch {
        /* final partial line → skip */
      }
    }
    return foldFleetAlerts(envelopes);
  } catch {
    return []; // fail-open — never blank the board on a log read error
  }
}
