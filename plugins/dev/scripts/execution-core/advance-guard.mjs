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

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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

// The marker's name lives in ONE place, because CTL-2024 added a SECOND reader of
// it (the janitor's retraction). A name built independently in two spots is a
// rename away from a retraction that silently matches nothing — which is the exact
// failure mode CTL-2024 is about, one level up.
const MARKER_PREFIX = ".advance-";
const MARKER_SUFFIX = ".applied";

// advanceMarkerName — `.advance-<from>-to-<to>.applied`. The `-to-` infix is an
// ANCHOR, not decoration: it is what stops a retraction for `merge` from matching
// `...-to-monitor-merge.applied` (see the near-miss control in the CTL-2024 test).
export function advanceMarkerName(from, to) {
  return `${MARKER_PREFIX}${renderField(from)}-to-${renderField(to)}${MARKER_SUFFIX}`;
}

// advanceMarkerPath — one dotfile per (from,to) edge under the worker dir. The
// name matches NONE of the tree's phase-*.json signal globs, so it is never read
// as a phase signal (verified: no isPhaseSignalName / workerDirHasPhaseSignals
// change needed).
export function advanceMarkerPath(orchDir, ticket, from, to) {
  return join(orchDir, "workers", ticket, advanceMarkerName(from, to));
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

// ─────────────────────────────────────────────────────────────────────────────
// retractAdvanceMarkersInto — CTL-2024. THE MARKER IS A CLAIM ABOUT A FACT ON
// DISK, AND ONE ACTOR CAN UNDO THAT FACT WITHOUT TOUCHING THE MARKER.
//
// THE BUG THIS CLOSES. The stall-janitor's unstick (defaultClearStall step 1)
// DELETES the successor's `phase-<to>.json`, and its own header comment states the
// intent: "lets deriveAdvancement re-derive the next phase on the next tick." That
// sentence was FALSE. deriveAdvancement does re-derive — and the guard above then
// suppresses the entire fanout, because the edge key is computed from the
// PREDECESSOR (`phase-<from>.json`), which the unstick never touches. Byte-identical
// key → byte-identical marker → suppressed. FOREVER. Measured on mini 2026-08-18:
// CTC-427 (plan→implement) and CTC-55 (research→plan) each emitted 16 suppressed-
// duplicate advances after a janitor clear; CTC-441, never cleared, emitted 1 — the
// control that says 16 is not the normal idempotent case.
//
// ⚠️ THE ASYMMETRY THAT HID IT. The janitor already re-arms every OTHER durable
// suppressor it can defeat — `.orphan-detected.applied` (CTL-868), the escalation
// cooldown (CTL-1442), the durable escalation record (CTL-1643). The advance marker
// is the one it never learned about, because CTL-1805 added it AFTER those, and it
// is keyed on a file the janitor has no reason to think about.
//
// SCOPE IS DELIBERATELY NARROW. Only edges INTO the cleared phase are retracted:
// that is the only advance whose effect the unstick actually undid. Retracting
// anything wider would re-open the CTL-1805 replay storm on edges that are still
// legitimately applied.
//
// FAIL DIRECTION, and note it INVERTS the guard's. Every read/unlink here is
// best-effort and never throws, but the failure here is toward LEAVING a marker —
// i.e. toward the CTL-2024 stall, not toward a storm. That is the correct direction
// for a retraction: the pre-CTL-2024 status quo is a stuck ticket an operator can
// see and re-arm by hand, whereas an over-eager retraction is a silent replay storm.
//
// Returns the list of retracted marker names (possibly empty) so the caller can log
// what it actually did rather than what it hoped to do.
export function retractAdvanceMarkersInto(orchDir, ticket, to, deps = {}) {
  const readdir = deps.readdirSync ?? readdirSync;
  const remove = deps.rmSync ?? rmSync;
  const dir = join(orchDir, "workers", renderField(ticket));
  // Anchored on `-to-<phase>.applied` — see advanceMarkerName.
  const suffix = `-to-${renderField(to)}${MARKER_SUFFIX}`;
  let names;
  try {
    names = readdir(dir);
  } catch {
    return []; // no worker dir / unreadable — nothing to retract
  }
  const retracted = [];
  for (const name of names) {
    if (!name.startsWith(MARKER_PREFIX) || !name.endsWith(suffix)) continue;
    try {
      remove(join(dir, name), { force: true });
      retracted.push(name);
    } catch {
      /* best-effort: a marker we could not remove stays, and the ticket stays
         stuck — visible, re-armable by hand, and never a storm. */
    }
  }
  return retracted;
}
