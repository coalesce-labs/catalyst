// adopt-infer-phase.mjs — CLI shim giving bash a one-line call to inferResumePhase.
//
// Usage:
//   node adopt-infer-phase.mjs --ticket PROJ-XXXX [--cwd <worktree-path>]
//
// Prints exactly one bare phase token on stdout and exits 0, or prints an error
// message on stderr and exits non-zero. Designed for bash $(…) capture.
//
// This is the enabling dependency for catalyst-adopt.sh Phase 4 dispatch.
//
// Import strategy: recovery.mjs imports bun:sqlite and is not loadable under bare
// node. This shim inlines the same reverse-walk logic using only work-done-probes.mjs
// (node-only imports) and workflow-descriptor.mjs (pure readFileSync). It mirrors the
// canonical `inferResumePhase` in recovery.mjs — INCLUDING its call convention, which
// passes ONLY `{ cwd }` (recovery.mjs:4514: `inferResumePhase(ticket, { cwd })`).
//
// Deliberate scope — worktree-detectable phases only. The canonical caller does NOT
// thread orchDir, so the orchDir-gated probes (triage/verify/review/pr/monitor-merge/
// monitor-deploy) never fire there; the scheduler owns everything ABOVE implement —
// verify-verdict routing (verify→remediate, scheduler.mjs:1940-1947) and stale
// post-PR signal sanitization (sanitizeStalePostPrSignals, scheduler.mjs:1531-1587) —
// AROUND inferResumePhase, not inside it. Mirroring that, this shim caps inference at
// the range it can prove from the worktree alone (research/plan/implement/commit) and
// re-dispatches from there; the dispatched phase then re-enters the normal scheduler
// path for the precise post-implement routing. Resuming EARLIER than the true phase is
// conservative and safe — the re-run phases (verify/review) are read-only/idempotent, so
// nothing is skipped. Threading orchDir here (a prior attempt) DIVERGED from the
// canonical impl and made the shim select `review`/`teardown` off raw signals without
// the scheduler's verdict/staleness guards — CTL-1642 Codex #3175 P1s (#1, #2).
//
// Calling-convention note: the worktree-scoped probes (research/plan/implement/commit)
// key on `repoRoot`, so makeAdaptedProbes passes repoRoot=cwd (cwd IS the worktree).

import { fileURLToPath } from "node:url";
import { WORK_DONE_PROBES } from "./work-done-probes.mjs";
import { STAGE_RANK, NEW_WORK_ENTRY_PHASE } from "../lib/workflow-descriptor.mjs";

// RESUME_PHASE_ORDER mirrors recovery.mjs: pipeline phases in forward order,
// ancillary `remediate` excluded.
const RESUME_PHASE_ORDER = Object.entries(STAGE_RANK)
  .filter(([id]) => id !== "remediate")
  .sort((a, b) => a[1] - b[1])
  .map(([id]) => id);

// makeAdaptedProbes — wrap WORK_DONE_PROBES so the worktree-scoped probes get the
// context they key on: repoRoot=cwd (cwd IS the worktree), matching the canonical
// caller. orchDir is deliberately NOT supplied (see the scope note in the header), so
// the orchDir-gated post-implement probes short-circuit false — the shim caps at the
// worktree-detectable range exactly as recovery.mjs's `inferResumePhase(ticket,{cwd})`.
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
