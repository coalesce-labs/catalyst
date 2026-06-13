// CTL-1100 Phase 2: fsm-descriptor.mjs — unit tests (bun test, no server).
// Tests: sha correctness, totality over NEXT_PHASE, non-linear edges,
// unclassified fallback, drift guard.

import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PHASES,
  NEXT_PHASE,
  DESCRIPTOR_PATH,
  ANCILLARY_PHASES,
  TERMINAL_PHASE,
  NEW_WORK_ENTRY_PHASE,
  NON_PREEMPTABLE_PHASES,
  STAGE_RANK,
  REMEDIATE_CYCLE_CAP,
} from "./workflow-descriptor.mjs";
import { REVIVE_BUDGET } from "./phase-fsm.mjs";
import {
  enumerateTransitions,
  buildFsmDescriptor,
} from "./fsm-descriptor.mjs";

// ─── 1. descriptorSha matches raw file bytes ────────────────────────────────

test("descriptorSha === sha256 of raw DESCRIPTOR_PATH bytes", async () => {
  const body = await buildFsmDescriptor();
  const expected = createHash("sha256")
    .update(readFileSync(DESCRIPTOR_PATH))
    .digest("hex");
  expect(body.descriptorSha).toBe(expected);
});

// ─── 2. Totality over NEXT_PHASE (every advance edge present) ───────────────

test("all NEXT_PHASE advance edges are present", () => {
  const transitions = enumerateTransitions();
  const advanceEdges = transitions.filter((t) => t.kind === "advance");
  // Every NEXT_PHASE entry should have an advance edge
  for (const [from, to] of Object.entries(NEXT_PHASE)) {
    const edge = advanceEdges.find((t) => t.from === from && t.to === to);
    expect(edge).toBeDefined();
  }
  // Count should match
  expect(advanceEdges.length).toBe(Object.keys(NEXT_PHASE).length);
});

// ─── 3. Non-linear edges present for a representative phase ─────────────────

test("non-linear edges present for 'implement' phase", () => {
  const transitions = enumerateTransitions();
  const fromImplement = transitions.filter((t) => t.from === "implement");
  const edgeTypes = fromImplement.map((t) => t.edgeKind ?? t.kind);

  // revive self-loop (failed → same phase when reviveCount < budget)
  const revive = fromImplement.find((t) => t.to === "implement" && t.kind === "revive");
  expect(revive).toBeDefined();

  // escalation to stalled
  const stalled = fromImplement.find((t) => t.to === "stalled");
  expect(stalled).toBeDefined();

  // park to needs-input
  const park = fromImplement.find((t) => t.to === "needs-input");
  expect(park).toBeDefined();

  // turn-cap continuation self-loop (distinct edgeId from revive)
  const turnCap = fromImplement.find(
    (t) => t.to === "implement" && t.kind === "turn-cap"
  );
  expect(turnCap).toBeDefined();
  if (revive && turnCap) {
    expect(revive.edgeId).not.toBe(turnCap.edgeId);
  }
});

test("verify->remediate and remediate->verify edges present", () => {
  const transitions = enumerateTransitions();
  const vr = transitions.find((t) => t.from === "verify" && t.to === "remediate");
  const rv = transitions.find((t) => t.from === "remediate" && t.to === "verify");
  expect(vr).toBeDefined();
  expect(rv).toBeDefined();
});

test("needs-input->resume edge present", () => {
  const transitions = enumerateTransitions();
  const resume = transitions.find(
    (t) => t.from === "needs-input" && t.to === "resume"
  );
  expect(resume).toBeDefined();
});

// ─── 4. Unclassified fallback + seeded guard data ──────────────────────────

test("un-curated happy-path edge has classification:'unclassified'", () => {
  const transitions = enumerateTransitions();
  // research->plan is a happy-path advance edge, not in fsm-guards.json
  const edge = transitions.find((t) => t.from === "research" && t.to === "plan");
  expect(edge).toBeDefined();
  expect(edge?.classification).toBe("unclassified");
  expect(edge?.guard ?? null).toBeNull();
});

test("seeded verify->remediate edge has classification and guardText", () => {
  const transitions = enumerateTransitions();
  const edge = transitions.find((t) => t.from === "verify" && t.to === "remediate");
  expect(edge?.classification).not.toBe("unclassified");
  expect(edge?.guardText).toBeTruthy();
  expect(edge?.sourceRef).toMatch(/phase-fsm|scheduler/);
});

// ─── 5. Drift guard: buildFsmDescriptor phases match PHASES ─────────────────

test("buildFsmDescriptor().phases deep-equals PHASES", async () => {
  const body = await buildFsmDescriptor();
  expect(body.phases).toEqual(PHASES);
});

test("buildFsmDescriptor() structural shape", async () => {
  const body = await buildFsmDescriptor();
  expect(body.terminalPhase).toBe(TERMINAL_PHASE);
  expect(body.entryPhase).toBe(NEW_WORK_ENTRY_PHASE);
  expect(Array.isArray(body.ancillaryPhases)).toBe(true);
  expect(body.ancillaryPhases).toEqual(ANCILLARY_PHASES);
  expect(body.remediateCycleCap).toBe(REMEDIATE_CYCLE_CAP);
  expect(body.reviveBudget).toBe(REVIVE_BUDGET);
  expect(body.descriptorSha).toMatch(/^[0-9a-f]{64}$/);
  expect(Array.isArray(body.transitions)).toBe(true);
  expect(body.transitions.length).toBeGreaterThan(Object.keys(NEXT_PHASE).length);
  // stageRank should be present
  expect(typeof body.stageRank).toBe("object");
  expect(body.stageRank).toMatchObject(STAGE_RANK);
});
