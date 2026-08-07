// durable-escalation.mjs — GC-surviving durable escalation store (CTL-1643).
//
// Writes per-ticket records to orchDir/.escalations/<T>.json, a directory that
// survives stall-janitor J4 and worker-dir-gc.mjs (neither touches it). Both
// the scheduler (recovery.mjs) and the board (board-data.mjs) import from here
// without pulling in each other's dependency graph.
//
// Record shape:
//   { ticket, phase, reason, escalatedAt, labelConfirmed, commentPosted,
//     labelAttempts, source, lastTs }
//
// commentPosted — true once appendEscalatedEvent has fired for this episode.
// Guards the comment/event so it fires at most once across retry ticks even
// while the label is still unconfirmed (CTL-1643 verified-or-loud contract).
//
// Discipline mirrors recordEscalation / defaultForgetIntent: all helpers are
// fail-open and never throw, so a filesystem error never crashes the scheduler
// tick or the board assembly.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function escalationsDir(orchDir) {
  return join(orchDir, ".escalations");
}

function recordPath(orchDir, ticket) {
  return join(escalationsDir(orchDir), `${ticket}.json`);
}

// recordDurableEscalation — write or upsert the escalation record.
//
// On first call: writes a fresh record with labelAttempts:1, escalatedAt:now.
// On subsequent calls:
//   labelConfirmed:false  → increments labelAttempts, updates lastTs, preserves escalatedAt.
//   labelConfirmed:true   → sets labelConfirmed:true, does NOT increment labelAttempts.
// commentPosted is OR'd with the prior value — once true it stays true.
//
// Returns the written record so callers can read labelAttempts immediately.
// Never throws.
export function recordDurableEscalation({
  orchDir,
  ticket,
  phase,
  reason,
  labelConfirmed,
  commentPosted: commentPostedArg,
  source,
  now,
}) {
  try {
    const dir = escalationsDir(orchDir);
    mkdirSync(dir, { recursive: true });
    const path = recordPath(orchDir, ticket);
    let prior = null;
    if (existsSync(path)) {
      try {
        prior = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        prior = null;
      }
    }
    const escalatedAt = prior?.escalatedAt ?? now;
    const labelAttempts =
      labelConfirmed
        ? (prior?.labelAttempts ?? 1)
        : (prior?.labelAttempts ?? 0) + 1;
    // commentPosted is sticky: once set true it is never cleared by a retry tick.
    const commentPosted = commentPostedArg === true || prior?.commentPosted === true;
    const rec = {
      ticket,
      phase,
      reason,
      escalatedAt,
      labelConfirmed: labelConfirmed === true,
      commentPosted,
      labelAttempts,
      source,
      lastTs: now,
    };
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(rec, null, 2));
    renameSync(tmp, path);
    return rec;
  } catch {
    // fail-open: a write failure is not a crash condition
    return {
      ticket,
      phase,
      reason,
      escalatedAt: now,
      labelConfirmed: labelConfirmed === true,
      commentPosted: commentPostedArg === true,
      labelAttempts: 1,
      source,
      lastTs: now,
    };
  }
}

// readDurableEscalations — scan .escalations/ and return all parseable records.
// Absent dir, empty dir, or malformed files all degrade to [] (fail-open).
export function readDurableEscalations(orchDir) {
  try {
    const dir = escalationsDir(orchDir);
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const records = [];
    for (const entry of entries) {
      try {
        const raw = readFileSync(join(dir, entry), "utf8");
        const rec = JSON.parse(raw);
        if (rec && typeof rec === "object") records.push(rec);
      } catch {
        // skip malformed files
      }
    }
    return records;
  } catch {
    return [];
  }
}

// forgetDurableEscalation — unlink the record for a ticket.
// Idempotent and never throws.
export function forgetDurableEscalation(orchDir, ticket) {
  try {
    const path = recordPath(orchDir, ticket);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // fail-open
  }
}
