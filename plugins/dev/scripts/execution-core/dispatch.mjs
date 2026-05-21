// dispatch.mjs — execution-core worker-dispatch adapter (CTL-565).
//
// The single executor seam (D9): the trigger/state layer emits a phase-owed
// intent { orchDir, ticket, phase }; the executor is pluggable. defaultDispatch
// shells out to orchestrate-dispatch-next (local claude --bg); a cloud fork
// swaps the injected dispatch function at one call site.
//
// Extracted from scheduler.mjs so both the scheduler's pull loop AND the
// monitor's →Triage one-shot dispatch share one adapter — they must not each
// hardcode their own shell-out.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// orchestrate-dispatch-next sits one directory up from execution-core/.
const DISPATCH_BIN = fileURLToPath(new URL("../orchestrate-dispatch-next", import.meta.url));

// defaultDispatch — shell out to orchestrate-dispatch-next, which delegates to
// phase-agent-dispatch (idempotent: an existing dispatched/running/done signal
// is a no-op). Injected in tests so no test ever spawns a real worker.
export function defaultDispatch({ orchDir, ticket, phase }) {
  const res = spawnSync(
    DISPATCH_BIN,
    ["--orch-dir", orchDir, "--ticket", ticket, "--phase", phase],
    { encoding: "utf8" },
  );
  if (res.error) return { code: 127, stdout: "", stderr: res.error.message };
  return { code: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// dispatchTicket — thin seam over the injectable dispatch function.
export function dispatchTicket(orchDir, ticket, phase, { dispatch = defaultDispatch } = {}) {
  return dispatch({ orchDir, ticket, phase });
}
