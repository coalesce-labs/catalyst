// linear-reconcile-store.mjs — CTL-1371 durable completion-declaration store.
//
// The lightweight "this ticket is done" signal the model/pipeline/human drops.
// One JSON marker per ticket at ${CATALYST_DIR}/completions/<TICKET>.json:
//   { ticket, state, declaredAt, declaredBy, note, reconciledAt?, reconciledState? }
// `state` is a stateMap KEY (default 'done'). A declaration is PENDING until
// `reconciledAt` is stamped — the reconciler drains pending declarations to
// Linear and stamps reconciledAt once the write lands, so a write that fails
// (rate-limit / daemon down / breaker open) is retried, not lost. Re-declaring a
// DIFFERENT state re-opens the marker (clears reconciledAt).
//
// Filesystem-only + atomic (tmp + rename); safe for concurrent writers (each
// ticket is its own file).

import { readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function catalystDir() {
  return process.env.CATALYST_DIR || join(homedir(), "catalyst");
}

export function completionsDir() {
  return process.env.CATALYST_COMPLETIONS_DIR || join(catalystDir(), "completions");
}

export function declarationPath(ticket, dir = completionsDir()) {
  return join(dir, `${ticket}.json`);
}

// readDeclaration — the marker for one ticket, or null when absent/unreadable.
export function readDeclaration(ticket, dir = completionsDir()) {
  try {
    return JSON.parse(readFileSync(declarationPath(ticket, dir), "utf8"));
  } catch {
    return null;
  }
}

// writeDeclaration — atomically persist a declaration object. Returns it.
export function writeDeclaration(decl, dir = completionsDir()) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }
  const final = declarationPath(decl.ticket, dir);
  const tmp = `${final}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(decl, null, 2));
  renameSync(tmp, final);
  return decl;
}

// declare — (re)declare a ticket's target state. A NEW or changed-state
// declaration clears reconciledAt so the reconciler picks it up again. `clock`
// is injectable so tests don't depend on wall-clock time.
export function declare(
  { ticket, state = "done", declaredBy = "model", note = null },
  { dir = completionsDir(), clock } = {}
) {
  const now = clock ? clock.nowIso() : new Date().toISOString();
  const prior = readDeclaration(ticket, dir);
  const decl = {
    ticket,
    state,
    declaredBy,
    note: note ?? prior?.note ?? null,
    declaredAt: prior && prior.state === state ? (prior.declaredAt ?? now) : now,
    // Re-declaring (or changing the target) re-opens the marker for reconcile.
    reconciledAt: prior && prior.state === state ? (prior.reconciledAt ?? null) : null,
    reconciledState: prior && prior.state === state ? (prior.reconciledState ?? null) : null,
  };
  return writeDeclaration(decl, dir);
}

// listDeclarations — all markers (default) or only PENDING ones (reconciledAt
// not yet stamped — i.e. the declared state hasn't been confirmed in Linear).
// Sorted by ticket for determinism.
export function listDeclarations({ dir = completionsDir(), pendingOnly = false } = {}) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.includes(".tmp."));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.sort()) {
    let d;
    try {
      d = JSON.parse(readFileSync(join(dir, n), "utf8"));
    } catch {
      continue;
    }
    if (!d?.ticket) continue;
    if (pendingOnly && d.reconciledAt) continue;
    out.push(d);
  }
  return out;
}

// markReconciled — stamp a declaration as reconciled to `reconciledState`.
export function markReconciled(ticket, reconciledState, { dir = completionsDir(), clock } = {}) {
  const d = readDeclaration(ticket, dir);
  if (!d) return null;
  d.reconciledState = reconciledState;
  d.reconciledAt = clock ? clock.nowIso() : new Date().toISOString();
  return writeDeclaration(d, dir);
}
