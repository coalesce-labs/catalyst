// deploy-state.mjs — execution-core re-export of the canonical deploy
// state machine (CTL-533).
//
// nextDeployState is NOT duplicated here: it lives in
// orch-monitor/lib/deploy-state-machine.ts and is reused verbatim — the
// Step E deploy sub-loop in orchestrate/SKILL.md is its bash glue, and that
// file's own header confirms the .ts function is the authoritative mirror.
// Bun resolves the .ts import directly, so the execution-core barrel and
// scan.mjs get a single in-package import site with zero logic duplication.

export { nextDeployState } from "../orch-monitor/lib/deploy-state-machine.ts";
