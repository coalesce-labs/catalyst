// advance-guard.mjs — CTL-1805. A durable once-per-edge idempotency guard for the
// execution-core scheduler's advancement chokepoint.
//
// THE BUG THIS CLOSES. The advancement sweep is a PURE re-derivation on every
// tick with NO durable record that an edge was ever applied. So an unchanging
// predecessor signal map re-fires the SAME phase edge forever — on mini
// 2026-08-12 the monitor-merge→monitor-deploy edge for CTL-56 applied 13× in 55s,
// each tick re-reading the same stale phase-monitor-merge.json and fanning out a
// 5-event dispatch/advance/linear-write/transition/reap burst per replay. The 13
// fabricated advances were harmless ONLY because of an unrelated Linear guard
// (skipped-terminal-no-backward); on a not-yet-terminal ticket all 13 would have
// applied as backward state moves.
//
// THE FIX. Make an applied advance a FACT ON DISK, not a re-derivation. Before
// dispatching the FSM-owed next phase, compute an edge key from the PREDECESSOR'S
// IDENTITY — (ticket, from, to, predecessor_generation, predecessor_updatedAt) —
// and suppress the whole fanout iff a marker already records a byte-identical key.
// Keying on predecessor identity (not the bare edge) is load-bearing: a LEGITIMATE
// re-advance (a CTL-1660 backward re-dispatch with a newer predecessor generation,
// a CTL-653 verify⇄remediate re-entry at a new remediate generation) presents a
// DIFFERENT key → not suppressed → marker overwritten. Only an unchanged-input
// replay is suppressed.
//
// FAIL DIRECTION. Every read is fail-OPEN toward ALLOWING the advance: an
// unreadable/absent/parse-broken marker returns "not yet applied", because a guard
// that cannot read its own marker must never wedge the pipeline — the worst case
// without any guard is the pre-CTL-1805 status quo (a replay), never a stall. The
// write is best-effort: a failed marker write leaves the next duplicate merely
// unsuppressed (status quo), never worse.
//
// ZERO-IMPORT LEAF (only node:fs / node:path), so scheduler.mjs and the CI-stable
// advance-idempotency.test.mjs both import it without dragging in config.mjs's
// bun:sqlite graph — same discipline as assertion-evidence.mjs / secret-contract.mjs.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// A field rendered explicitly so a missing value NEVER silently equals another.
// `∅` (not the empty string) so a literal "" and an absent field stay distinct.
const NULL_TOKEN = "∅";
function renderField(v) {
  if (v === undefined || v === null) return NULL_TOKEN;
  const s = String(v);
  return s.length === 0 ? NULL_TOKEN : s;
}

// computeAdvanceEdgeKey — a stable string from the edge PLUS the predecessor's
// identity. `predRaw` is the predecessor phase's raw signal object (from
// readPhaseSignalRaw, or the pre-reset remediateRaw for the remediate-detour
// edge); null/undefined is tolerated (its generation/updatedAt render as ∅).
export function computeAdvanceEdgeKey({ ticket, from, to, predRaw }) {
  const generation = predRaw == null ? null : predRaw.generation;
  const updatedAt = predRaw == null ? null : predRaw.updatedAt;
  return [
    renderField(ticket),
    renderField(from),
    renderField(to),
    renderField(generation),
    renderField(updatedAt),
  ].join("|");
}

// advanceMarkerPath — one dotfile per (from,to) edge under the worker dir. The
// name matches NONE of the tree's phase-*.json signal globs, so it is never read
// as a phase signal (verified: no isPhaseSignalName / workerDirHasPhaseSignals
// change needed).
export function advanceMarkerPath(orchDir, ticket, from, to) {
  return join(
    orchDir,
    "workers",
    ticket,
    `.advance-${renderField(from)}-to-${renderField(to)}.applied`
  );
}

// isAdvanceAlreadyApplied — true IFF the marker exists AND its stored key is
// byte-identical to `key`. Absent / unreadable / parse-broken / key-mismatch →
// false (fail-open toward allowing the advance). A DIFFERING key (newer
// predecessor generation/updatedAt, e.g. across a remediation cycle) is a
// different edge instance → false → the advance proceeds and the marker is
// overwritten by recordAdvanceApplied.
export function isAdvanceAlreadyApplied(orchDir, ticket, from, to, key, deps = {}) {
  const read = deps.readFileSync ?? readFileSync;
  const path = advanceMarkerPath(orchDir, ticket, from, to);
  let raw;
  try {
    raw = read(path, "utf8");
  } catch {
    return false; // absent or unreadable — allow (fail-open)
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false; // corrupt marker — allow (fail-open)
  }
  return parsed != null && parsed.key === key;
}

// recordAdvanceApplied — atomic tmp+rename write of { key, from, to, appliedAt }.
// rename OVERWRITES any stale-key marker (deliberately NOT O_EXCL — a differing
// key must be replaced, e.g. across remediation cycles). Best-effort: on a write
// failure it swallows and returns false (the next duplicate is at worst not
// suppressed — status quo, never worse). Never throws.
export function recordAdvanceApplied(orchDir, ticket, from, to, key, deps = {}) {
  const write = deps.writeFileSync ?? writeFileSync;
  const rename = deps.renameSync ?? renameSync;
  const mkdir = deps.mkdirSync ?? mkdirSync;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const path = advanceMarkerPath(orchDir, ticket, from, to);
  try {
    mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    write(tmp, JSON.stringify({ key, from: from ?? null, to: to ?? null, appliedAt: nowIso() }));
    rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}
