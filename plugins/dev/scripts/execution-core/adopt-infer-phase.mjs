// adopt-infer-phase.mjs — CLI shim giving bash a one-line call to inferResumePhase.
//
// Usage: node adopt-infer-phase.mjs --ticket CTL-XXXX [--cwd <worktree-path>]
//
// Prints exactly one bare phase token on stdout and exits 0, or prints an error
// message on stderr and exits non-zero. Designed for bash $(…) capture.
//
// This is the enabling dependency for catalyst-adopt.sh Phase 4 dispatch.
//
// Import strategy: recovery.mjs imports bun:sqlite and is not loadable under bare
// node. This shim inlines the same reverse-walk logic using only work-done-probes.mjs
// (node-only imports) and workflow-descriptor.mjs (pure readFileSync). The logic
// mirrors inferResumePhase in recovery.mjs exactly.
//
// Calling-convention note: WORK_DONE_PROBES expect ({ ticket, repoRoot }, opts) as
// their first arg, but inferResumePhase calls probe(ticketString, { cwd }). The
// shim adapts them via makeAdaptedProbes so the probes get the expected object form,
// with repoRoot=cwd (since cwd IS the worktree).

import { fileURLToPath } from "node:url";
import { WORK_DONE_PROBES } from "./work-done-probes.mjs";
import { STAGE_RANK, NEW_WORK_ENTRY_PHASE } from "../lib/workflow-descriptor.mjs";

// RESUME_PHASE_ORDER mirrors recovery.mjs: pipeline phases in forward order,
// ancillary `remediate` excluded.
const RESUME_PHASE_ORDER = Object.entries(STAGE_RANK)
  .filter(([id]) => id !== "remediate")
  .sort((a, b) => a[1] - b[1])
  .map(([id]) => id);

// makeAdaptedProbes — wrap WORK_DONE_PROBES from their ({ ticket, repoRoot }, opts)
// calling convention to match the (ticketString, { cwd }) convention that
// inferResumePhase uses. When cwd IS the worktree path, repoRoot=cwd lets
// resolveWorktree find the ticket's worktree via `git -C cwd worktree list`.
function makeAdaptedProbes(ticket, cwd) {
  return Object.fromEntries(
    Object.entries(WORK_DONE_PROBES).map(([phase, probeFn]) => [
      phase,
      () => probeFn({ ticket, repoRoot: cwd }),
    ])
  );
}

// inferResumePhase — mirrors recovery.mjs:4411. Walk in reverse; the first probe
// that returns true is the last completed phase, so resume at the next one.
async function inferResumePhase(ticket, { probes, cwd } = {}) {
  const adapted = probes || makeAdaptedProbes(ticket, cwd);
  for (let i = RESUME_PHASE_ORDER.length - 1; i >= 0; i--) {
    const phase = RESUME_PHASE_ORDER[i];
    const probe = adapted[phase];
    if (typeof probe !== "function") continue;
    if (await probe(ticket, { cwd })) {
      const next = RESUME_PHASE_ORDER[i + 1];
      return next ?? null;
    }
  }
  return NEW_WORK_ENTRY_PHASE;
}

async function main() {
  const args = process.argv.slice(2);
  let ticket = "";
  let cwd = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ticket" && args[i + 1]) {
      ticket = args[++i];
    } else if (args[i] === "--cwd" && args[i + 1]) {
      cwd = args[++i];
    }
  }

  if (!ticket) {
    process.stderr.write("adopt-infer-phase: --ticket <ID> is required\n");
    process.exit(1);
  }

  const phase = await inferResumePhase(ticket, { cwd });
  if (phase === null) {
    process.stderr.write(
      `adopt-infer-phase: all phases appear complete for ${ticket} (null resume phase)\n`
    );
    process.exit(1);
  }
  process.stdout.write(phase + "\n");
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    process.stderr.write(`adopt-infer-phase: ${e.message}\n`);
    process.exit(1);
  });
}
