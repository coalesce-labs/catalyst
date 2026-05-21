// stalled-detector.mjs — execution-core Step G stalled-worker decision (CTL-533).
//
// Pure mirror of the stalled-worker scan in orchestrate/SKILL.md. CTL-32
// invariant: a stale signal file is NEVER stall evidence on its own — when
// the worker's branch has an OPEN or MERGED PR the worker is progressing (or
// finished) regardless of the signal's age, so a stale-but-progressing worker
// gets its prior stalled attention RESOLVED, not re-raised. Escalation to a
// `stalled` attention happens only when no authoritative source shows activity.
//
// All non-determinism (clock, git/PR state) is injected; returns a
// { patch, attention } decision and never mutates anything.

import { TERMINAL } from "./signal-reader.mjs";
import { STALE_WORKER_CUTOFF_MS } from "./config.mjs";

const NO_OP = Object.freeze({ patch: {}, attention: null });

// detectStalled — decide the Step G transition for one worker.
//
// inputs: {
//   ticket, nowMs, updatedAtMs (signal .updatedAt as epoch ms; null = unknown),
//   currentStatus, prState:'MERGED'|'OPEN'|'NONE'|...,
//   commitCount, remoteBranchExists, branch,
// }
// returns: { patch, attention }
export function detectStalled(inputs) {
  // Terminal worker states absorb everything.
  if (TERMINAL.has(inputs.currentStatus)) return NO_OP;

  // A missing/unknown updatedAt is treated as not-stale — escalating on
  // missing data would be a false positive.
  if (inputs.updatedAtMs == null) return NO_OP;

  // Fresh signal — nothing to do.
  if (inputs.nowMs - inputs.updatedAtMs <= STALE_WORKER_CUTOFF_MS) return NO_OP;

  // Signal IS stale. CTL-32: consult git + PR state before escalating.
  // An OPEN or MERGED PR is the authoritative progress signal — clear any
  // prior stalled attention an earlier wake-up may have raised on staleness
  // alone (the merge-confirmation scan reconciles a MERGED PR to done).
  if (inputs.prState === "MERGED" || inputs.prState === "OPEN") {
    return {
      patch: {},
      attention: { kind: "resolve-attention", ticket: inputs.ticket },
    };
  }

  // No PR progress — escalate.
  const branch = inputs.branch || "?";
  return {
    patch: {},
    attention: {
      kind: "stalled",
      ticket: inputs.ticket,
      message:
        `No progress for ${Math.round(STALE_WORKER_CUTOFF_MS / 60_000)}+ ` +
        `minutes; branch=${branch} commits=${inputs.commitCount ?? 0} ` +
        `pushed=${inputs.remoteBranchExists ? 1 : 0} ` +
        `pr=${inputs.prState ?? "NONE"}`,
    },
  };
}
