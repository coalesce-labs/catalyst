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
import { fetchTicketLabels } from "./linear-query.mjs";

// linear-transition.sh sits one directory up from execution-core/ — mirrors the
// sibling-bin spawnSync pattern dispatch.mjs uses for orchestrate-dispatch-next.
const LINEAR_TRANSITION_BIN = fileURLToPath(
  new URL("../linear-transition.sh", import.meta.url)
);

// defaultExec — spawnSync wrapper normalising the result shape. A spawn error
// (binary missing, permission) is reported as code 127, never thrown.
function defaultExec(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) return { code: 127, stdout: "", stderr: res.error.message };
  return { code: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

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

// applyLabel — additively apply a Linear label (triaged, needs-human) AND verify
// the write landed. CTL-587: per memory project_linear_transition_silent_success,
// linearis can exit 0 on a label update that did NOT actually land (rate
// limiting, transient API). The read-back via fetchTicketLabels closes that
// silent-success gap: `applied: true` now means a follow-up `linearis issues
// read` confirmed the label is on the ticket. `applied: false` comes with a
// `reason` discriminator so callers can distinguish:
//   - 'write-failed'   — the update itself exited non-zero (no read-back run)
//   - 'verify-failed'  — update exited 0 but the read-back is missing the label
//                        (the silent-success case) OR the read-back exec failed
//   - 'exception'      — the exec itself threw
// All three are retryable next tick: labelOnce (scheduler.mjs) only writes its
// marker when applied: true, so a failure naturally retries.
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
      log.warn(
        { ticket, label, code: writeRes.code, stderr: writeRes.stderr },
        "linear-write: label write failed (exit non-zero)"
      );
      return { applied: false, reason: "write-failed" };
    }
    const labels = fetchTicketLabels(ticket, { exec });
    if (!Array.isArray(labels) || !labels.includes(label)) {
      log.warn(
        { ticket, label, readback: labels },
        "linear-write: label write exit-0 but read-back missing label (silent-success gap)"
      );
      return { applied: false, reason: "verify-failed" };
    }
    return { applied: true };
  } catch (err) {
    log.warn(
      { ticket, label, err: err.message },
      "linear-write: label write threw — swallowed"
    );
    return { applied: false, reason: "exception" };
  }
}
