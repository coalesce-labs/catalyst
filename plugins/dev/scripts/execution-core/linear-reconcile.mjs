// linear-reconcile.mjs — CTL-1371 completion-signal-driven Linear reconciler (pure core).
//
// We turned off Linear's native GitHub automations because PR/merge events are
// the WRONG trigger for ticket state: a draft PR opens early while work is still
// in progress (CTL-783), and a *merged* PR does not mean *done* — the pipeline
// itself puts deploy-verification + teardown between merge and Done. Inferring
// state from PR/merge state is exactly the fragile automation we removed.
//
// Instead, completion is an EXPLICIT declaration: the agent/model (or a human)
// says "this is done", and this reconciler's only job is to make Linear reflect
// that declared state RELIABLY (idempotent, retried until it lands) through the
// canonical write primitive. A PR is corroboration at most, never a trigger.
//
// PURE — no I/O. It takes completion DECLARATIONS ({ ticket, state }) and the
// current Linear state, decides per ticket whether Linear drifts from the
// declaration, and emits a correction. The timer/CLI inject the I/O seams
// (the declaration store, the webhook-synced cache / GraphQL state reads, and
// the linear-write.mjs write primitive).
//
// IDEMPOTENT: a ticket already in its declared state is an in-sync no-op, and the
// write primitive enforces the CTL-758 backward-write guard so a terminal ticket
// is never dragged backward. Deterministic (no LLM) and safe to re-run.

export const DEFAULTS = Object.freeze({ intervalSeconds: 600 });

export function normalizeId(s) {
  return String(s ?? "").toUpperCase();
}

// teamPrefixOf — the team key from an identifier ("CTL-1371" → "CTL").
export function teamPrefixOf(id) {
  return normalizeId(id).split("-")[0];
}

// stateNameForKind — resolve a declaration's target state KEY to the team's
// Linear state NAME via the config stateMap (e.g. 'done' → "Done", 'inReview' →
// "PR"). 'done' falls back to the literal "Done"; any other key with no mapping
// returns null and the decision becomes a skip:unmapped-target.
export function stateNameForKind(kind, stateMap = {}) {
  return stateMap?.[kind] ?? (kind === "done" ? "Done" : null);
}

// PIPELINE_STATE_KEYS — the canonical pre-terminal phase order (stateMap keys),
// used to keep a non-terminal correction FORWARD-ONLY when ordering is known.
const PIPELINE_STATE_KEYS = Object.freeze([
  "backlog",
  "todo",
  "triage",
  "research",
  "planning",
  "inProgress",
  "verifying",
  "reviewing",
  "remediating",
  "inReview",
]);

// orderedStatesForMap — the stateMap's state NAMES in pipeline order (deduped,
// dropping absent keys). Enables the forward-only guard for non-terminal targets;
// an empty list disables the guard (back-compat).
export function orderedStatesForMap(stateMap = {}) {
  const seen = new Set();
  const out = [];
  for (const k of PIPELINE_STATE_KEYS) {
    const name = stateMap?.[k];
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// decideCorrection — the pure per-ticket decision: does Linear's current state
// match the DECLARED target state?
//   action: 'in-sync' (already target) | 'correct' (drift → write) | 'skip'.
// `terminalStates` is the set of Linear state NAMES treated as terminal
// (Done/Canceled/…). We never propose dragging a terminal ticket to a different
// state — so a deliberately-Canceled ticket is never "completed" to Done even
// when a declaration says done; a human reopens it explicitly.
export function decideCorrection({
  ticket,
  kind,
  currentState,
  stateMap = {},
  terminalStates = [],
  orderedStates = [],
}) {
  const target = stateNameForKind(kind, stateMap);
  if (!target) {
    return {
      ticket,
      kind,
      action: "skip",
      reason: "unmapped-target",
      currentState: currentState ?? null,
      target: null,
    };
  }
  const cur = currentState == null ? null : String(currentState);
  if (cur !== null && cur === target) {
    return { ticket, kind, action: "in-sync", reason: "already-target", currentState: cur, target };
  }
  // A ticket already in ANY terminal state (Done/Canceled/Duplicate) that is not
  // the exact target is left untouched: never drag Done→non-terminal (the CTL-758
  // regression) AND never resurrect a deliberately-Canceled ticket. Operators
  // reopen such tickets by hand.
  const termSet = new Set((terminalStates ?? []).map((s) => String(s)));
  if (cur !== null && termSet.has(cur)) {
    const reason = kind === "done" ? "terminal-not-target" : "terminal-no-backward";
    return { ticket, kind, action: "skip", reason, currentState: cur, target };
  }
  // A terminal (Done) write is guard-EXEMPT in the primitive (applyTerminalDone
  // bypasses the CTL-758 backward guard) and the shell only no-ops on
  // current===target, so it must fire ONLY on a CONFIRMED non-terminal current
  // state. On an unknown current (cache/read miss) a Done write could resurrect a
  // Canceled ticket — refuse it and let a readable retry self-heal.
  if (kind === "done" && cur === null) {
    return {
      ticket,
      kind,
      action: "skip",
      reason: "unknown-current-unsafe",
      currentState: null,
      target,
    };
  }
  // FORWARD-ONLY guard for a NON-terminal target (e.g. inReview): never regress a
  // ticket already at or past the target in the pipeline. When the caller supplies
  // the ordering, skip unless the known current state is strictly BEFORE the
  // target; an unknown-to-pipeline current state is conservatively left alone.
  if (kind !== "done" && cur !== null && Array.isArray(orderedStates) && orderedStates.length) {
    const order = orderedStates.map((s) => String(s));
    const tgtIdx = order.indexOf(target);
    const curIdx = order.indexOf(cur);
    if (tgtIdx !== -1 && (curIdx === -1 || curIdx >= tgtIdx)) {
      return { ticket, kind, action: "skip", reason: "not-forward", currentState: cur, target };
    }
  }
  return {
    ticket,
    kind,
    action: "correct",
    reason: cur === null ? "unknown-current" : "drift",
    currentState: cur,
    target,
  };
}

// reconcileDeclarations — reconcile a list of completion DECLARATIONS to Linear.
// Each declaration is { ticket, state } where `state` is a stateMap KEY
// (default 'done'). Linear is driven by the EXPLICIT declaration, never inferred
// from PR/merge state. Injected seams:
//   readState(ticket)        → current Linear state NAME | null   (cache/GraphQL)
//   applyCorrection({ticket, kind, target}) → { applied, action, from_state, to_state, reason }
// A read FAILURE (throw) becomes a visible skip — never a blind write. Under
// `dryRun` applyCorrection is never called. Returns { rows, summary }.
export async function reconcileDeclarations({
  declarations = [],
  stateMap = {},
  terminalStates = [],
  orderedStates,
  readState,
  applyCorrection,
  dryRun = false,
}) {
  const order = orderedStates ?? orderedStatesForMap(stateMap);
  const rows = [];
  for (const decl of declarations) {
    const ticket = decl.ticket;
    const kind = decl.state || "done";

    let currentState = null;
    if (readState) {
      try {
        currentState = await readState(ticket);
      } catch (err) {
        rows.push({
          ticket,
          kind,
          target: null,
          currentState: null,
          decision: "skip",
          reason: "read-failed",
          applied: false,
          error: err?.message ?? String(err),
        });
        continue;
      }
    }

    const decision = decideCorrection({
      ticket,
      kind,
      currentState,
      stateMap,
      terminalStates,
      orderedStates: order,
    });
    const base = {
      ticket,
      kind,
      target: decision.target,
      currentState: decision.currentState,
      decision: decision.action,
      reason: decision.reason,
    };

    if (decision.action !== "correct") {
      rows.push({ ...base, applied: false });
      continue;
    }
    if (dryRun) {
      rows.push({ ...base, applied: false, dryRun: true });
      continue;
    }
    try {
      const res = await applyCorrection({ ticket, kind, target: decision.target });
      rows.push({
        ...base,
        applied: Boolean(res?.applied),
        writeAction: res?.action ?? null,
        from_state: res?.from_state ?? null,
        to_state: res?.to_state ?? null,
        writeReason: res?.reason ?? res?.skipped ?? null,
      });
    } catch (err) {
      rows.push({ ...base, applied: false, error: err?.message ?? String(err) });
    }
  }
  return { rows, summary: summarize(rows) };
}

// summarize — counts over a flat list of result rows.
//   corrected   — a write that ACTUALLY changed state (writeAction 'transitioned').
//   noop        — an idempotent landed write (current===target, 'skipped').
//   unconfirmed — a 'done' declaration skipped 'unknown-current-unsafe' because
//                 the current state couldn't be read; the write was NOT attempted.
//   failed      — a write that did not land for a non-throwing reason
//                 (no-repo-root, exit-N, update-failed). A guard refusal
//                 (terminal-no-backward) is NOT a failure.
export function summarize(rows) {
  const s = {
    tickets: rows.length,
    corrected: 0,
    noop: 0,
    inSync: 0,
    drift: 0,
    skipped: 0,
    unconfirmed: 0,
    failed: 0,
    errors: 0,
  };
  for (const r of rows) {
    if (r.error) s.errors += 1;
    if (r.decision === "in-sync") s.inSync += 1;
    else if (r.decision === "skip") {
      s.skipped += 1;
      if (r.reason === "unknown-current-unsafe") s.unconfirmed += 1;
    } else if (r.decision === "correct") {
      s.drift += 1;
      if (r.applied) {
        if (r.writeAction === "skipped") s.noop += 1;
        else s.corrected += 1;
      } else if (
        r.dryRun !== true &&
        !r.error &&
        r.writeReason !== "terminal-no-backward" &&
        r.writeReason !== "skipped-terminal-no-backward"
      ) {
        s.failed += 1;
      }
    }
  }
  return s;
}
