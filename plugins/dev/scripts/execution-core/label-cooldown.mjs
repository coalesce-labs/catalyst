// label-cooldown.mjs — the time-boxed cool-down ledger for Linear LABEL writes.
//
// ⛔ WHY THIS FILE EXISTS AS ITS OWN LEAF (CTL-2043, Decision C). These primitives
// were private to `scheduler.mjs`, which was fine while the only caller was the
// converger. P2-a gives `labelOnce` (`label-guard.mjs`) the same cool-down — and
// `label-guard.mjs` is a LEAF that `scheduler.mjs` imports, so a
// `label-guard → scheduler` import would be exactly the cycle the leaf placement
// exists to avoid (the same shape `label-guard.mjs`'s own header describes for
// recovery → scheduler). One owner, two readers; `scheduler.mjs` re-exports
// `labelCooldownPath` / `labelRetryState` so existing importers keep resolving.
//
// ⚠️ WHAT IS DELIBERATELY *NOT* HERE: the CTL-2052 AC3 cap machinery
// (`labelRetryCapBlocks`, `LABEL_RETRY_CAP`, `LABEL_RETRY_EXHAUSTED_MS`,
// `maybeEscalateRetryExhausted`). That is converger-specific — it eventually STOPS
// re-issuing, which is safe for a disposition label the converger re-derives every
// tick and is NOT obviously safe for `labelOnce`'s `needs-human` escalation, whose
// whole job is to page an operator. Keeping the cap out of this leaf is what stops
// it drifting into labelOnce by import-convenience; there is a test pinning it.
//
// ⚠️ ONE LEDGER PER (ticket, label), SHARED BY BOTH CALLERS — on purpose. The
// converger and `labelOnce` refusing the same (ticket, label) are refusing the SAME
// underlying Linear write, so counting them against one window/one attempt counter
// is the honest accounting: two independent ledgers would let the host issue two
// writes per window for one label, which is the spend COORD-236 was about.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// CTL-834: the cool-down window. Time-boxed and SELF-HEALING, which is the whole
// reason it — and not `labelOnce`'s permanent `.skipped` marker — is the right
// response to a refusal that clears on its own (a budget roll at 00:00 UTC, a
// credential re-mint, a rate-limit window passing). Same default as the dispatch
// cool-down; overridable for tests / quieter quota budgets.
export const LABEL_COOLDOWN_MS = Number(process.env.SCHEDULER_LABEL_COOLDOWN_MS) || 60_000;

// CTL-834 held-label apply cool-down — the same time-boxed-marker shape as the
// CTL-624 dispatch cool-down: a per-(ticket,label) JSON marker carrying failedAt,
// kept OUTSIDE workers/<T>/ so it survives worker-dir GC (see dispatchCooldownPath
// + memory project_scheduler_marker_under_workers_excludes_ticket). The window
// self-heals so an exclusive conflict that later clears lets the label re-apply.
export function labelCooldownPath(orchDir, ticket, label) {
  return join(orchDir, ".label-cooldowns", `${ticket}-${label}.json`);
}

// CTL-2052 — read the cool-down marker (or null). Its own owner of the parse, so the
// attempt-counter reader and the time gate below cannot disagree about the shape.
export function readLabelCooldownMarker(orchDir, ticket, label) {
  try {
    return JSON.parse(readFileSync(labelCooldownPath(orchDir, ticket, label), "utf8"));
  } catch {
    return null;
  }
}

// CTL-2052 — clear the ledger (on a successful apply, or when spending the single
// self-heal probe). ENOENT is the expected case. Best-effort; never throws.
export function clearLabelCooldown(orchDir, ticket, label) {
  try {
    unlinkSync(labelCooldownPath(orchDir, ticket, label));
  } catch {
    /* ENOENT — nothing to clear */
  }
}

export function inLabelCooldown(orchDir, ticket, label, now) {
  const marker = readLabelCooldownMarker(orchDir, ticket, label);
  return (
    marker != null &&
    typeof marker.failedAt === "number" &&
    now - marker.failedAt < LABEL_COOLDOWN_MS
  );
}

// CTL-2052 — the marker carries a per-(ticket,label) attempt count so AC3 can bound
// the storm. Read the prior count, increment, persist, and RETURN the new value so the
// caller can edge-trigger the cap-crossing escalation. Backward-compatible: an old
// marker without `attempts` reads as 0, so the first increment is 1.
export function recordLabelCooldown(orchDir, ticket, label, now) {
  const p = labelCooldownPath(orchDir, ticket, label);
  mkdirSync(dirname(p), { recursive: true });
  const prior = readLabelCooldownMarker(orchDir, ticket, label);
  const priorAttempts = prior && Number.isInteger(prior.attempts) ? prior.attempts : 0;
  const attempts = priorAttempts + 1;
  writeFileSync(p, JSON.stringify({ failedAt: now, attempts }));
  return attempts;
}

// CTL-2052 (AC3) — the pure cap arithmetic, exported so it can be exercised without
// disk. `blocked` short-circuits the apply (still inside the long back-off after the
// cap); `exhaustedProbe` says the long window elapsed so the caller may allow ONE probe
// (and reset the ledger, so the label can still land if the sibling was removed
// meanwhile — it self-heals on a long timescale rather than never; COORD-236 "never
// permanently abandon a label").
//
// ⚠️ The arithmetic lives here (it reads the marker shape this file owns) while the
// converger-only GATE that acts on it stays in scheduler.mjs — see the header.
export function labelRetryState(marker, now, { cap, exhaustedMs } = {}) {
  const attempts = marker && Number.isInteger(marker.attempts) ? marker.attempts : 0;
  const failedAt = marker && typeof marker.failedAt === "number" ? marker.failedAt : 0;
  if (attempts >= cap) {
    if (now - failedAt < exhaustedMs) return { blocked: true, attempts, exhaustedProbe: false };
    return { blocked: false, attempts, exhaustedProbe: true };
  }
  return { blocked: false, attempts, exhaustedProbe: false };
}
