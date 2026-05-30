// workflow-descriptor.mjs — single source of truth for the pipeline's phase-list
// constants (CTL workflow descriptor v1; see docs/workflow-descriptors-design.md).
//
// Loads lib/workflow.default.json and DERIVES the constants that phase-fsm.mjs and
// scheduler.mjs previously hardcoded in ~5 separate places. phase-fsm.mjs and
// scheduler.mjs now import from here instead of re-declaring them by hand.
//
// This is a PROVENANCE SWAP, not a behavior change: workflow-descriptor.test.mjs
// is a drift guard that asserts every derived constant is byte-equal to the
// historical literal (incl. STAGE_RANK key ORDER). Pure — one readFileSync at
// module load, matching registry.mjs discipline. Imported only by .mjs daemon
// code that already does fs; the pure-bash CTL-736 claim window never loads it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The terminal-success token NEXT_PHASE maps the last step to. Matches
// phase-fsm.mjs TERMINAL_SUCCESS; kept local to avoid an import cycle
// (phase-fsm imports FROM this module).
const TERMINAL_SUCCESS = "done";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DESCRIPTOR_PATH = join(HERE, "workflow.default.json");

export const descriptor = JSON.parse(readFileSync(DESCRIPTOR_PATH, "utf8"));

const steps = descriptor.steps;
const ancillary = descriptor.ancillarySteps ?? [];

// ─── Derived constants (the historical duplication sites) ───

// PHASES — the ordered linear pipeline (phase-fsm.mjs:9).
export const PHASES = steps.map((s) => s.id);

// NEXT_PHASE — happy-path successor table (phase-fsm.mjs:53). The terminal
// step's null `next` resolves to the terminal-success token.
export const NEXT_PHASE = Object.fromEntries(
  steps.map((s) => [s.id, s.next ?? TERMINAL_SUCCESS])
);

// PHASE_LINEAR_KEY — phase → Linear stateMap key (phase-fsm.mjs:75), incl. the
// ancillary remediate key.
export const PHASE_LINEAR_KEY = Object.fromEntries(
  [...steps, ...ancillary].map((s) => [s.id, s.linearKey ?? null])
);

// STAGE_RANK — per-phase preemption rank (scheduler.mjs:108). ORDER-sensitive and
// NON-DENSE: keys are [...PHASES, ...ancillary ids] and remediate=4 sits between
// implement=3 and verify=5, so ranks are explicit per step, never array-index.
export const STAGE_RANK = Object.freeze(
  Object.fromEntries([...steps, ...ancillary].map((s) => [s.id, s.rank]))
);

// TERMINAL_PHASE / NEW_WORK_ENTRY_PHASE (scheduler.mjs:93,99).
export const TERMINAL_PHASE = descriptor.terminalStep;
export const NEW_WORK_ENTRY_PHASE = descriptor.entryStep;

// NON_PREEMPTABLE_PHASES — steps with preemptable:false (scheduler.mjs:213).
export const NON_PREEMPTABLE_PHASES = new Set(
  steps.filter((s) => s.preemptable === false).map((s) => s.id)
);

// Ancillary / remediate metadata (phase-fsm.mjs:40,41,44).
export const ANCILLARY_PHASES = ancillary.map((s) => s.id);
export const REMEDIATE_PHASE = ancillary[0]?.id ?? "remediate";

const remediateCycle = (descriptor.cycles ?? []).find((c) =>
  (c.members ?? []).includes(REMEDIATE_PHASE)
);
export const REMEDIATE_CYCLE_CAP = remediateCycle?.cap ?? 3;
