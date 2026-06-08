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
import { withAuthRemint } from "./linear-remint.mjs";
// CTL-758: the SHARED Linear terminal-state predicate ({Done,Canceled} — its OWN
// set, NOT TERMINAL_LINEAR_KEY which is the transition KEY "done"). Gates the
// backward-write guard below.
import { isLinearTerminal } from "./terminal-state.mjs";

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
// CTL-785: withAuthRemint interposes under the breaker — an open breaker still
// short-circuits before any spawn (including the remint retry).
const defaultExec = withBreaker(withAuthRemint(rawExec));

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
// returns { applied, reason, action, from_state, to_state } and never throws.
// Parses the --json result and treats a zero exit (with no "update-failed"
// action) as applied.
//
// CTL-757: the shell already computes `.currentState` (the pre-transition state
// it read for its idempotency check) and `.targetState` (the resolved target).
// Surfacing them as from_state/to_state is FREE — no extra Linear read — and
// gives the caller-emitted linear.state.write audit event its before/after pair.
// The SAME current-state read also serves the CTL-758 backward-write guard.
// from_state/to_state default to null when the shell emits non-JSON (no-linearis,
// spawn error) or omits the fields (older stub).
function runTransition({
  ticket,
  key,
  resolveRepoRoot = defaultResolveRepoRoot,
  exec = defaultExec,
  // CTL-758: the SHARED TTL state cache + fetchState seam for the backward-write
  // guard. fetchState defaults to the real linear-query helper; cache defaults
  // undefined (the guard then does ONE cheap read per non-terminal-key write —
  // and callers that thread the scheduler's shared cache pay ≤1 read per ticket
  // per TTL). Both injectable so tests never shell out.
  fetchState = fetchTicketState,
  cache,
  // CTL-758: a caller that ALREADY read the pre-transition state (applyTriageStatus
  // reads from_state before this call) passes it here so the guard reuses it
  // instead of issuing a second read. undefined → the guard reads for itself.
  knownCurrentState,
}) {
  try {
    const repoRoot = resolveRepoRoot(ticket);
    if (!repoRoot) {
      log.warn({ ticket, key }, "linear-write: no repoRoot — skipping status write");
      return { applied: false, reason: "no-repo-root", from_state: null, to_state: null };
    }

    // CTL-758 — BACKWARD-WRITE GUARD. linear-transition.sh only guards
    // CURRENT==TARGET; it does NOT refuse a backward move. A daemon write that
    // would drag a ticket already at a terminal Linear state (Done/Canceled) BACK
    // to a non-terminal state (PR, Research, …) is the CTL-549/550/749 regression
    // — a late phase-pr/advance echo un-completing a finished ticket. So for a
    // NON-terminal target key we pre-read the current state (cheap, cached) and,
    // if it is already terminal, SKIP the shell entirely.
    //
    // CRITICAL SAFETY: the forward terminal write (key === TERMINAL_LINEAR_KEY,
    // i.e. "done" — applyTerminalDone + the reconcile backstop) is EXPLICITLY
    // EXEMPT from this guard. It must always proceed, or every monitor-deploy Done
    // write is blocked and tickets strand at PR. We only read+guard for
    // key !== TERMINAL_LINEAR_KEY, so the forward Done path never even reads here.
    if (key !== TERMINAL_LINEAR_KEY) {
      const current =
        knownCurrentState !== undefined ? knownCurrentState : fetchState(ticket, { exec, cache });
      if (isLinearTerminal(current)) {
        log.warn(
          { ticket, key, current },
          "ctl-758: refusing backward write — ticket already at terminal Linear state, skipping shell",
        );
        return {
          applied: false,
          skipped: "terminal-no-backward",
          reason: "skipped-terminal-no-backward",
          from_state: current,
          to_state: null,
        };
      }
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
    let from_state = null;
    let to_state = null;
    try {
      const parsed = JSON.parse(stdout) ?? {};
      action = parsed.action ?? null;
      // currentState/targetState are empty strings when unresolved — normalise
      // to null so the audit payload never carries a misleading "".
      from_state = parsed.currentState || null;
      to_state = parsed.targetState || null;
    } catch {
      /* non-JSON stdout — leave action/from_state/to_state null */
    }
    const applied = code === 0 && action !== "update-failed";
    if (!applied) {
      log.warn({ ticket, key, code, action }, "linear-write: status write not applied");
    }
    return { applied, reason: applied ? null : `exit-${code}`, action, from_state, to_state };
  } catch (err) {
    log.warn(
      { ticket, key, err: err.message },
      "linear-write: status write threw — swallowed"
    );
    return { applied: false, reason: "threw", from_state: null, to_state: null };
  }
}

// applyPhaseStatus — write the Linear state mapped to `phase`. Idempotent
// (linear-transition.sh read-compares first). triage → no-op (no status key).
// CTL-758: `cache` is threaded through to runTransition's backward-write guard
// so the per-tick shared TTL cache (createTicketStateCache) serves the guard's
// pre-write read — ≤1 fetchTicketState per ticket per TTL, not a new API storm.
export function applyPhaseStatus({ ticket, phase, resolveRepoRoot, exec, cache }) {
  const key = linearKeyForPhase(phase); // throws PhaseFsmError on an unknown phase
  if (key === null) return { applied: false, skipped: "no-status-key" };
  return runTransition({ ticket, key, resolveRepoRoot, exec, cache });
}

// applyTerminalDone — write the terminal Done state on monitor-deploy completion.
// CTL-758: this is the FORWARD terminal write (key === TERMINAL_LINEAR_KEY) — it
// is EXEMPT from the backward-write guard, so runTransition does not read state
// here. `cache` is forwarded for symmetry (unused by the exempt path).
export function applyTerminalDone({ ticket, resolveRepoRoot, exec, cache }) {
  return runTransition({ ticket, key: TERMINAL_LINEAR_KEY, resolveRepoRoot, exec, cache });
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
//   "exclusive-conflict" — CTL-834: the label is in an exclusive group whose
//                     sibling is already on the ticket. Unrecoverable while the
//                     sibling is present — callers back off (labelOnce writes
//                     .skipped; convergeHeldLabel arms a cool-down).
//   "rate-limited"  — Linear write rate-cap hit; retry next tick.
//   "verify-failed" — write exited 0 but the read-back is missing the label
//                     (the silent-success case) OR the read-back exec failed;
//                     retry next tick.
//   "transient"     — every other failure (network, spawn error, unknown
//                     stderr, exec threw); retry next tick.
// Unrecoverable reasons ("missing-label", "exclusive-conflict") are NOT retried;
// every other reason is retryable next tick (labelOnce only writes its .applied
// marker when applied: true, so a failure naturally retries).
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

// removeLabel — remove a single label from a ticket while preserving its OTHER
// labels (CTL-549). Counterpart to applyLabel; used by handleCommentWake to
// clear needs-human/question when re-dispatching a parked worker.
//
// linearis 2026.4.9 has NO single-label-remove primitive: `--label-mode` only
// accepts `add` or `overwrite` (the old `remove` value is REJECTED with
// "--label-mode must be either 'add' or 'overwrite'"), and `--clear-labels`
// drops ALL labels. So the only way to remove one label without clobbering the
// rest is read-modify-write: read the current label set, filter out the target,
// and overwrite with the remainder (or --clear-labels when nothing remains).
// This keeps the write inside linearis and preserves the issue's other labels.
//
// Idempotent: if the label is already absent we return { removed: true } without
// a write. A failed read (fetchLabels returns non-array) is { removed: false,
// reason: 'transient' } so the caller retries. Mirrors applyLabel's shape for
// logging + failure classification. Never throws.
export async function removeLabel(
  ticket,
  label,
  { exec = defaultExec, fetchLabels = fetchTicketLabels } = {}
) {
  try {
    const current = fetchLabels(ticket, { exec });
    if (!Array.isArray(current)) {
      // Read failed (linearis non-zero / non-JSON) — cannot safely overwrite
      // without knowing the current set, so retry next tick.
      log.warn({ ticket, label, reason: "transient" }, "removeLabel: read failed");
      return { removed: false, reason: "transient" };
    }
    if (!current.includes(label)) {
      // Idempotent: the label is already gone, no write needed.
      return { removed: true };
    }
    const remaining = current.filter((l) => l !== label);
    const res = remaining.length
      ? exec("linearis", [
          "issues",
          "update",
          ticket,
          "--labels",
          remaining.join(","),
          "--label-mode",
          "overwrite",
        ])
      : exec("linearis", ["issues", "update", ticket, "--clear-labels"]);
    if ((res.code ?? res.status ?? 0) !== 0) {
      const reason = classifyLabelFailure(res.stderr ?? "");
      log.warn({ ticket, label, reason, stderr: res.stderr }, "removeLabel: write failed");
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

    // 2. Shell the transition. CTL-758: pass the from_state we just read as
    //    knownCurrentState so the backward-write guard reuses it (no second read).
    //    A Todo→Triage move is forward, but the guard still correctly refuses it
    //    if the ticket is somehow already terminal (Done/Canceled) — without an
    //    extra linearis call.
    const t = runTransition({
      ticket,
      key: "triage",
      resolveRepoRoot,
      exec,
      knownCurrentState: from_state,
    });
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

// ALLOWED_ESTIMATE_POINTS — the Fibonacci-derived points scale used by the
// reference-class lookup tool (CTL-751). Only these values are accepted by
// applyEstimate; anything else is rejected without calling linearis.
const ALLOWED_ESTIMATE_POINTS = new Set([1, 3, 5, 8, 13]);

// HUMAN_ESTIMATE_LABEL — tickets carrying this label have a hand-set estimate
// that machine write-backs must never clobber (estimation-methodology.md §6b).
// Same label score-tickets.ts --check-labels honors (its HUMAN_LABEL const).
const HUMAN_ESTIMATE_LABEL = "estimate-source:human";

// applyEstimate — write a numeric estimate to a ticket's Linear estimate field
// (CTL-751). Best-effort, never throws; mirrors applyLabel shape (try/catch,
// log.warn, tagged return). No read-back (the estimate field is not subject to
// the label silent-success gap; a verifying read-back can be added as follow-up).
//
// CTL-813 — estimate-source:human guard. Pre-reads the ticket's labels and
// SKIPS the write when HUMAN_ESTIMATE_LABEL is present, honoring the
// methodology contract that human estimates are never machine-overwritten.
// FAIL-OPEN on an unreadable label set (null / throw): proceeding matches the
// score-tickets --check-labels precedent ("label check failed; proceeding
// without filter") — the scheduler's estimate write is one-shot (fires once on
// the triage→research advance), so failing closed would silently drop it
// forever on any transient read hiccup.
export function applyEstimate({ ticket, estimate, exec = defaultExec, fetchLabels = fetchTicketLabels }) {
  if (!ALLOWED_ESTIMATE_POINTS.has(estimate)) {
    return { applied: false, reason: "invalid-estimate" };
  }
  try {
    let labels = null;
    try {
      labels = fetchLabels(ticket, { exec });
    } catch {
      /* fail-open — treated as unreadable below */
    }
    if (Array.isArray(labels) && labels.includes(HUMAN_ESTIMATE_LABEL)) {
      log.info(
        { ticket, estimate, label: HUMAN_ESTIMATE_LABEL },
        "linear-write: estimate write skipped — ticket carries a human estimate"
      );
      return { applied: false, skipped: "human-estimate", reason: "skipped-human-estimate" };
    }
    if (!Array.isArray(labels)) {
      log.warn(
        { ticket, estimate },
        "linear-write: estimate label pre-read failed — proceeding without human-estimate guard (fail-open)"
      );
    }
    const res = exec("linearis", ["issues", "update", ticket, "--estimate", String(estimate)]);
    if (res.code !== 0) {
      log.warn(
        { ticket, estimate, code: res.code, stderr: res.stderr },
        "linear-write: estimate write failed (exit non-zero)"
      );
      return { applied: false, reason: "transient" };
    }
    return { applied: true, reason: null };
  } catch (err) {
    log.warn(
      { ticket, estimate, reason: "transient", err: err.message },
      "linear-write: estimate write threw — swallowed"
    );
    return { applied: false, reason: "transient" };
  }
}

// applyAssignee — write the Catalyst bot as the Linear assignee on a claimed
// ticket (CTL-781). Mirrors applyLabel: try/catch, log.warn, tagged
// {applied, reason} return, CTL-587-style read-back so applied:true means a
// follow-up read confirmed the assignee landed. Never throws.
// reason values: null | "invalid-user" | "transient" | "verify-failed".
export function applyAssignee({ ticket, userId, exec = defaultExec }) {
  if (typeof userId !== "string" || userId.length === 0) {
    return { applied: false, reason: "invalid-user" };
  }
  try {
    const writeRes = exec("linearis", ["issues", "update", ticket, "--assignee", userId]);
    if (writeRes.code !== 0) {
      log.warn(
        { ticket, userId, code: writeRes.code, stderr: writeRes.stderr },
        "linear-write: assignee write failed (exit non-zero)"
      );
      return { applied: false, reason: "transient" };
    }
    const readRes = exec("linearis", ["issues", "read", ticket]);
    let actual = null;
    try {
      actual = JSON.parse(readRes.stdout ?? "")?.assignee?.id ?? null;
    } catch {
      /* unparseable read-back — falls through to verify-failed */
    }
    if (readRes.code !== 0 || actual !== userId) {
      log.warn(
        { ticket, userId, readback: actual },
        "linear-write: assignee write exit-0 but read-back mismatch (silent-success gap)"
      );
      return { applied: false, reason: "verify-failed" };
    }
    return { applied: true, reason: null };
  } catch (err) {
    log.warn(
      { ticket, userId, reason: "transient", err: err.message },
      "linear-write: assignee write threw — swallowed"
    );
    return { applied: false, reason: "transient" };
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
//   - "not exclusive child" (CTL-834): the label belongs to an EXCLUSIVE Linear
//     label group and a SIBLING from that group is already on the ticket, so the
//     add can never land while the sibling is present. Its own unrecoverable
//     reason ("exclusive-conflict") so callers back off instead of re-issuing it
//     every ~22s tick (observed: 218 fails / 44 min on the held-label converger —
//     CTL-838 blocked↔needs-human, ADV-1295 blocked↔waiting).
export function classifyLabelFailure(stderr) {
  const s = String(stderr ?? "");
  if (s.includes("not found")) return "missing-label";
  if (s.includes("incorrect team")) return "missing-label";
  if (s.includes("not exclusive")) return "exclusive-conflict";
  if (s.includes("Rate limit")) return "rate-limited";
  return "transient";
}
