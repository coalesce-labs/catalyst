// linear-write.mjs — execution-core deterministic Linear status write-back (CTL-558).
//
// The D9 cloud seam for status WRITES — the mirror of linear-query.mjs (reads).
// Internals shell to the bash chokepoint linear-transition.sh (idempotency,
// stateIds UUID resolution, 3-tier state precedence) so there is ONE write path;
// a cloud fork swaps this module without touching the scheduler.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { linearKeyForPhase, TERMINAL_LINEAR_KEY } from "../lib/phase-fsm.mjs";
import { getProjectConfig } from "./registry.mjs";
import { log } from "./config.mjs";
import { fetchTicketLabels, fetchTicketState } from "./linear-query.mjs";
import { withBreaker } from "./linear-breaker.mjs";

// linear-transition.sh sits one directory up from execution-core/ — mirrors the
// sibling-bin spawnSync pattern dispatch.mjs uses for orchestrate-dispatch-next.
const LINEAR_TRANSITION_BIN = fileURLToPath(
  new URL("../linear-transition.sh", import.meta.url)
);

// rawExec — spawnSync wrapper normalising the result shape. A spawn error
// (binary missing, permission) is reported as code 127, never thrown.
function rawExec(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) return { code: 127, stdout: "", stderr: res.error.message };
  return { code: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// defaultExec — rawExec behind the CTL-679 process-wide rate-limit breaker, so
// the status-write path (which shells linear-transition.sh, itself a Linear
// read+write) short-circuits without spawning while the breaker is open. Shared
// singleton with linear-query.mjs: one 429 on any path pauses every path.
const defaultExec = withBreaker(rawExec);

// teamOf — the Linear team key is the identifier prefix: "CTL-558" → "CTL".
export function teamOf(ticket) {
  const m = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(String(ticket ?? ""));
  return m ? m[1] : null;
}

// defaultResolveRepoRoot — team → repoRoot via the central registry.
function defaultResolveRepoRoot(ticket) {
  const team = teamOf(ticket);
  return team ? (getProjectConfig(team)?.repoRoot ?? null) : null;
}

// runTransition — shell linear-transition.sh for one logical key. Best-effort:
// returns { applied, reason } and never throws. Parses the --json result and
// treats a zero exit (with no "update-failed" action) as applied.
function runTransition({
  ticket,
  key,
  resolveRepoRoot = defaultResolveRepoRoot,
  exec = defaultExec,
}) {
  try {
    const repoRoot = resolveRepoRoot(ticket);
    if (!repoRoot) {
      log.warn({ ticket, key }, "linear-write: no repoRoot — skipping status write");
      return { applied: false, reason: "no-repo-root" };
    }
    const config = `${repoRoot}/.catalyst/config.json`;
    const { code, stdout } = exec(LINEAR_TRANSITION_BIN, [
      "--ticket",
      ticket,
      "--transition",
      key,
      "--config",
      config,
      "--json",
    ]);
    let action = null;
    try {
      action = JSON.parse(stdout)?.action ?? null;
    } catch {
      /* non-JSON stdout — leave action null */
    }
    const applied = code === 0 && action !== "update-failed";
    if (!applied) {
      log.warn({ ticket, key, code, action }, "linear-write: status write not applied");
    }
    return { applied, reason: applied ? null : `exit-${code}`, action };
  } catch (err) {
    log.warn(
      { ticket, key, err: err.message },
      "linear-write: status write threw — swallowed"
    );
    return { applied: false, reason: "threw" };
  }
}

// applyPhaseStatus — write the Linear state mapped to `phase`. Idempotent
// (linear-transition.sh read-compares first). triage → no-op (no status key).
export function applyPhaseStatus({ ticket, phase, resolveRepoRoot, exec }) {
  const key = linearKeyForPhase(phase); // throws PhaseFsmError on an unknown phase
  if (key === null) return { applied: false, skipped: "no-status-key" };
  return runTransition({ ticket, key, resolveRepoRoot, exec });
}

// applyTerminalDone — write the terminal Done state on monitor-deploy completion.
export function applyTerminalDone({ ticket, resolveRepoRoot, exec }) {
  return runTransition({ ticket, key: TERMINAL_LINEAR_KEY, resolveRepoRoot, exec });
}

// applyLabel — additively apply a Linear label (needs-human), classify
// any failure, AND verify a successful write actually landed. Returns a tagged
// { applied, reason } shape callers use to decide retry vs short-circuit.
//
// Two failure axes are folded together here:
//   1. CTL-585 — when the write exits non-zero, classifyLabelFailure maps the
//      stderr to a reason so callers can stop the retry storm on the one
//      unrecoverable case ("missing-label": the workspace has no such label;
//      retrying every tick just storms the Linear API).
//   2. CTL-587 — when the write exits 0, linearis can still have silently NOT
//      applied the label (rate limiting, transient API). A read-back via
//      fetchTicketLabels closes that silent-success gap, so `applied: true`
//      means a follow-up read confirmed the label is on the ticket.
//
// reason values:
//   null            — success (applied: true)
//   "missing-label" — workspace lacks the label; create it in the Linear UI.
//                     Unrecoverable inside one daemon lifetime — callers
//                     (scheduler.labelOnce) write a .skipped marker and do not
//                     retry it this run.
//   "rate-limited"  — Linear write rate-cap hit; retry next tick.
//   "verify-failed" — write exited 0 but the read-back is missing the label
//                     (the silent-success case) OR the read-back exec failed;
//                     retry next tick.
//   "transient"     — every other failure (network, spawn error, unknown
//                     stderr, exec threw); retry next tick.
// All reasons except "missing-label" are retryable next tick: labelOnce only
// writes its .applied marker when applied: true, so a failure naturally retries.
export function applyLabel({ ticket, label, exec = defaultExec }) {
  try {
    const writeRes = exec("linearis", [
      "issues",
      "update",
      ticket,
      "--labels",
      label,
      "--label-mode",
      "add",
    ]);
    if (writeRes.code !== 0) {
      const reason = classifyLabelFailure(writeRes.stderr);
      log.warn(
        { ticket, label, code: writeRes.code, reason, stderr: writeRes.stderr },
        "linear-write: label write failed (exit non-zero)"
      );
      return { applied: false, reason };
    }
    const labels = fetchTicketLabels(ticket, { exec });
    if (!Array.isArray(labels) || !labels.includes(label)) {
      log.warn(
        { ticket, label, readback: labels },
        "linear-write: label write exit-0 but read-back missing label (silent-success gap)"
      );
      return { applied: false, reason: "verify-failed" };
    }
    return { applied: true, reason: null };
  } catch (err) {
    log.warn(
      { ticket, label, reason: "transient", err: err.message },
      "linear-write: label write threw — swallowed"
    );
    return { applied: false, reason: "transient" };
  }
}

// removeLabel — remove a single label from a ticket via linearis --label-mode
// remove (CTL-549). Counterpart to applyLabel; used by handleCommentWake to
// clear needs-human/question when re-dispatching a parked worker. No read-back
// (remove is idempotent for absent labels). Returns { removed: true } on
// success, { removed: false, reason } on failure. Never throws.
export async function removeLabel(ticket, label, { exec = defaultExec } = {}) {
  try {
    const res = exec("linearis", [
      "issues",
      "update",
      ticket,
      "--labels",
      label,
      "--label-mode",
      "remove",
    ]);
    if ((res.code ?? res.status ?? 0) !== 0) {
      const reason = classifyLabelFailure(res.stderr ?? "");
      log.warn({ ticket, label, reason }, "removeLabel: failed");
      return { removed: false, reason };
    }
    return { removed: true };
  } catch (err) {
    log.warn({ ticket, label, reason: "transient", err: err.message }, "removeLabel: threw");
    return { removed: false, reason: "transient" };
  }
}

// applyTriageStatus — verified Todo→Triage write-back (CTL-704). Reads the
// pre-transition state, shells linear-transition.sh for the triage key, then
// re-reads to confirm the state actually landed. Returns
// {applied, verified, from_state, to_state, reason}. Never throws (best-effort).
//
// Modelled on applyLabel's read-back pattern (CTL-587). The `fetchState` seam
// is injectable so tests never shell out to linearis; `resolveRepoRoot` + `exec`
// are forwarded to runTransition unchanged.
export function applyTriageStatus({
  ticket,
  resolveRepoRoot = defaultResolveRepoRoot,
  exec = defaultExec,
  fetchState = fetchTicketState,
}) {
  let from_state = null;
  try {
    // 1. Capture pre-transition state (best-effort — null is acceptable).
    from_state = fetchState(ticket, { exec });

    // 2. Shell the transition.
    const t = runTransition({ ticket, key: "triage", resolveRepoRoot, exec });
    if (!t.applied) {
      return { applied: false, verified: false, from_state, to_state: null, reason: t.reason };
    }

    // 3. Resolve expected target state from the project config (stateMap.triage).
    const team = teamOf(ticket);
    const cfg = team ? getProjectConfig(team) : null;
    const expectedState = cfg?.eligibleQuery?.triageStatus ?? "Triage";

    // 4. Re-read to verify the state actually landed.
    const to_state = fetchState(ticket, { exec });
    if (to_state == null) {
      log.warn({ ticket }, "linear-write: triage verify-unreadable — cannot confirm state landed");
      return { applied: true, verified: false, from_state, to_state: null, reason: "verify-unreadable" };
    }
    if (to_state === expectedState) {
      return { applied: true, verified: true, from_state, to_state, reason: null };
    }
    log.warn(
      { ticket, expected: expectedState, actual: to_state },
      "linear-write: triage exit-0 but read-back missing (silent-success gap)"
    );
    return { applied: true, verified: false, from_state, to_state, reason: "verify-failed" };
  } catch (err) {
    log.warn({ ticket, err: err.message }, "linear-write: applyTriageStatus threw — swallowed");
    return { applied: false, verified: false, from_state, to_state: null, reason: "threw" };
  }
}

// applyBlockedByRelation — additively write a durable blocked-by edge
// (CTL-537). Best-effort, never throws; mirrors applyLabel but without a
// read-back: a blocked-by relation is durable (research:140) and the seam
// re-evaluates next tick if the write fails.
export function applyBlockedByRelation({ ticket, blockedBy, exec = defaultExec }) {
  try {
    const res = exec("linearis", ["issues", "update", ticket, "--blocked-by", blockedBy]);
    if (res.code !== 0) {
      log.warn(
        { ticket, blockedBy, code: res.code, stderr: res.stderr },
        "linear-write: blocked-by write failed (exit non-zero)"
      );
      return { applied: false, reason: "transient" };
    }
    return { applied: true, reason: null };
  } catch (err) {
    log.warn(
      { ticket, blockedBy, reason: "transient", err: err.message },
      "linear-write: blocked-by write threw — swallowed"
    );
    return { applied: false, reason: "transient" };
  }
}

// classifyLabelFailure — map a `linearis issues update --labels` stderr to
// one of the tagged reason codes. The substrings are the literal forms observed
// in ~/catalyst/execution-core/daemon.log:
//   - "not found": workspace lacks the label (CTL-585 §3,§7 — CTL-380 QA run).
//   - "Rate limit": linearis CLI surfaced an HTTP 429 (CTL-679 trigger).
//   - "incorrect team": Linear's labels are team-scoped (different UUIDs per
//     team for the same name). linearis resolved the label name in the wrong
//     team's workspace context and sent the cross-team UUID, which Linear
//     rejects. Permanent within one daemon lifetime (the resolver is global) —
//     classified as missing-label so labelOnce writes the .skipped marker and
//     stops the per-tick retry storm. (Observed on ADV tickets when the daemon
//     orchestrates a team whose labels share names with the resolver's default
//     team but have different UUIDs.)
function classifyLabelFailure(stderr) {
  const s = String(stderr ?? "");
  if (s.includes("not found")) return "missing-label";
  if (s.includes("incorrect team")) return "missing-label";
  if (s.includes("Rate limit")) return "rate-limited";
  return "transient";
}
