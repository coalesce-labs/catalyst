// fsm-descriptor.mjs — pure assembler for the GET /api/fsm/descriptor endpoint.
// Exports:
//   enumerateTransitions(guards?) — totality edge list (NEXT_PHASE + non-linear)
//   buildFsmDescriptor()         — full response object (async: reads RULES_SHA)
//
// Static-imports workflow-descriptor.mjs + phase-fsm.mjs (both bun:sqlite-free).
// RULES_SHA is loaded via a try/catch computed import (degrades to null).
// fsm-guards.json is loaded once at module-load time; a malformed file degrades
// to {} (all-unclassified) rather than crashing.
//
// No bun:sqlite anywhere in this module's transitive graph — safe for a plain
// static import in server.ts.

import { createHash, } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PHASES,
  NEXT_PHASE,
  DESCRIPTOR_PATH,
  STAGE_RANK,
  TERMINAL_PHASE,
  NEW_WORK_ENTRY_PHASE,
  NON_PREEMPTABLE_PHASES,
  ANCILLARY_PHASES,
  REMEDIATE_PHASE,
  REMEDIATE_CYCLE_CAP,
  PHASE_LINEAR_KEY,
} from "./workflow-descriptor.mjs";
import { REVIVE_BUDGET, PARK_STATE, TERMINAL_FAILURE, TERMINAL_LINEAR_KEY } from "./phase-fsm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARDS_PATH = join(HERE, "fsm-guards.json");

// loadGuards() — read fsm-guards.json once at module load; degrade to {} on any error.
function loadGuards() {
  try {
    return JSON.parse(readFileSync(GUARDS_PATH, "utf8"));
  } catch {
    return {};
  }
}
const GUARDS = loadGuards();

// resolveGuard — look up guard data for an edge using exact key then wildcard.
// Returns { guardText, datalog, sourceRef, classification } or the unclassified default.
function resolveGuard(from, to, kind) {
  const exactKey = `${from}->${to}`;
  const wildcardKey = `*->${kind}`;
  const g = GUARDS[exactKey] ?? GUARDS[wildcardKey] ?? null;
  if (g) {
    return {
      guardText: g.guardText ?? null,
      datalog: g.datalog ?? null,
      sourceRef: g.sourceRef ?? null,
      classification: g.classification ?? "unclassified",
    };
  }
  return { guardText: null, datalog: null, sourceRef: null, classification: "unclassified" };
}

// readRulesSha — try to import rules.mjs via computed specifier (bun:sqlite-free
// but execution-core/beliefs/rules.generated.mjs may import bun:sqlite; the try/catch
// ensures the endpoint still responds with rulesSha:null if unavailable).
async function readRulesSha() {
  try {
    const rulesMod = ["../execution-core/beliefs/rules.mjs"].join("");
    const mod = await import(rulesMod);
    return mod.RULES_SHA ?? null;
  } catch {
    return null;
  }
}

// enumerateTransitions — produce the full edge set:
//   (1) one advance edge per NEXT_PHASE entry (happy-path)
//   (2) per pipeline phase: revive / escalate / park / turn-cap self-loops
//   (3) needs-input->resume
//   (4) verify->remediate / remediate->verify router cycle
// Never drops an edge; un-curated edges get classification:'unclassified'.
export function enumerateTransitions(guards = GUARDS) {
  const result = [];

  // Helper: build a guard lookup from the supplied guards map.
  function lookup(from, to, kind) {
    const exactKey = `${from}->${to}`;
    const wildcardKey = `*->${kind}`;
    const g = guards[exactKey] ?? guards[wildcardKey] ?? null;
    if (g) {
      return {
        guardText: g.guardText ?? null,
        datalog: g.datalog ?? null,
        sourceRef: g.sourceRef ?? null,
        classification: g.classification ?? "unclassified",
      };
    }
    return { guardText: null, datalog: null, sourceRef: null, classification: "unclassified" };
  }

  // 1. Advance edges (happy-path).
  for (const [from, to] of Object.entries(NEXT_PHASE)) {
    const g = lookup(from, to, "advance");
    result.push({
      edgeId: `${from}->advance`,
      from,
      to,
      kind: "advance",
      ...g,
    });
  }

  // 2. Per-pipeline-phase non-linear edges.
  for (const phase of PHASES) {
    // revive self-loop: failed → same phase when reviveCount < REVIVE_BUDGET
    const reviveG = lookup(phase, phase, "revive");
    result.push({
      edgeId: `${phase}->revive`,
      from: phase,
      to: phase,
      kind: "revive",
      ...reviveG,
    });

    // escalation to stalled (2nd failure)
    const stalledG = lookup(phase, TERMINAL_FAILURE, "stalled");
    result.push({
      edgeId: `${phase}->stalled`,
      from: phase,
      to: TERMINAL_FAILURE,
      kind: "escalation",
      ...stalledG,
    });

    // park → needs-input
    const parkG = lookup(phase, PARK_STATE, "needs-input");
    result.push({
      edgeId: `${phase}->park`,
      from: phase,
      to: PARK_STATE,
      kind: "park",
      ...parkG,
    });

    // turn-cap continuation self-loop (distinct edgeId from revive)
    const tcG = lookup(phase, phase, "turn-cap");
    result.push({
      edgeId: `${phase}->turn-cap`,
      from: phase,
      to: phase,
      kind: "turn-cap",
      ...tcG,
    });
  }

  // 3. needs-input -> resume (return to parkedFrom phase)
  const resumeG = lookup(PARK_STATE, "resume", "resume");
  result.push({
    edgeId: `needs-input->resume`,
    from: PARK_STATE,
    to: "resume",
    kind: "resume",
    ...resumeG,
  });

  // 4. verify⇄remediate router cycle (deriveAdvancement, not transition())
  const vrG = lookup("verify", REMEDIATE_PHASE, "remediate-cycle");
  result.push({
    edgeId: `verify->remediate`,
    from: "verify",
    to: REMEDIATE_PHASE,
    kind: "remediate-cycle",
    ...vrG,
  });
  const rvG = lookup(REMEDIATE_PHASE, "verify", "remediate-cycle");
  result.push({
    edgeId: `remediate->verify`,
    from: REMEDIATE_PHASE,
    to: "verify",
    kind: "remediate-cycle",
    ...rvG,
  });

  return result;
}

// buildFsmDescriptor — assemble the full /api/fsm/descriptor response.
// Async because we read the file hash + RULES_SHA at request-time.
export async function buildFsmDescriptor() {
  const [descriptorSha, rulesSha] = await Promise.all([
    Promise.resolve(
      createHash("sha256").update(readFileSync(DESCRIPTOR_PATH)).digest("hex")
    ),
    readRulesSha(),
  ]);

  return {
    phases: PHASES,
    nextPhase: NEXT_PHASE,
    stageRank: STAGE_RANK,
    terminalPhase: TERMINAL_PHASE,
    entryPhase: NEW_WORK_ENTRY_PHASE,
    nonPreemptable: [...NON_PREEMPTABLE_PHASES],
    ancillaryPhases: ANCILLARY_PHASES,
    remediateCycleCap: REMEDIATE_CYCLE_CAP,
    reviveBudget: REVIVE_BUDGET,
    cycles: [
      {
        id: "verify-remediate",
        members: ["verify", REMEDIATE_PHASE],
        cap: REMEDIATE_CYCLE_CAP,
      },
    ],
    transitions: enumerateTransitions(),
    phaseLinearKey: PHASE_LINEAR_KEY,
    terminalLinearKey: TERMINAL_LINEAR_KEY,
    descriptorSha,
    rulesSha,
  };
}
