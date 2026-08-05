import { compareCodeUnits, normalizeOnboardingRequest } from "./contract.mjs";

export const STEP_STATUS = Object.freeze(["pending", "satisfied", "blocked", "not_applicable"]);

const CONTROL_PLANE_STEP_IDS = Object.freeze([
  "provider.github_access",
  "provider.linear_team",
  "project.identity_config",
  "project.workflow_states",
  "project.git_automations",
  "project.event_ingestion",
]);

const TARGET_STEP_IDS = Object.freeze([
  "target.checkout",
  "target.execution_registry",
  "target.thoughts_mapping",
  "target.activation_policy",
  "target.end_to_end_readiness",
]);

function recordOrEmpty(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
}

function observationKey(step) {
  return step.scope === "control_plane" ? step.id : `target.${step.targetId}.${step.id.slice("target.".length)}`;
}

function applyObservation(step, observations) {
  const observation = observations?.[observationKey(step)];
  if (observation === undefined) return step;
  if (observation === null || typeof observation !== "object" || !STEP_STATUS.includes(observation.status)) {
    throw new TypeError(`observation for ${observationKey(step)} has an invalid status`);
  }
  return {
    ...step,
    status: observation.status,
    reason: recordOrEmpty(observation.reason),
    evidence: recordOrEmpty(observation.evidence),
    repairable: typeof observation.repairable === "boolean" ? observation.repairable : step.repairable,
  };
}

function pendingStep(id, scope, targetId) {
  return {
    id,
    scope,
    ...(targetId ? { targetId } : {}),
    status: "pending",
    reason: { code: "awaiting_observation" },
    evidence: {},
    repairable: true,
  };
}

function offlineStep(id, targetId) {
  return {
    ...pendingStep(id, "target", targetId),
    reason: { code: "target_offline" },
  };
}

function isExecutionTarget(target, request) {
  if (!request.targetPolicy.executionNodeClasses.includes(target.nodeClass)) return false;
  if (target.id === request.controller.id && !request.targetPolicy.includeController) return false;
  return true;
}

export function createOnboardingPlan(request, observations = {}) {
  const normalized = normalizeOnboardingRequest(request);
  const controlPlaneSteps = CONTROL_PLANE_STEP_IDS.map((id) => applyObservation(pendingStep(id, "control_plane"), observations));
  const targetSteps = normalized.targetPolicy.targets
    .filter((target) => isExecutionTarget(target, normalized))
    .flatMap((target) =>
      TARGET_STEP_IDS.map((id) =>
        target.online ? applyObservation(pendingStep(id, "target", target.id), observations) : offlineStep(id, target.id),
      ),
    );

  return [...controlPlaneSteps, ...targetSteps];
}

function summarizeRequiredSteps(steps) {
  const summary = { total: 0, satisfied: 0, pending: 0, blocked: 0 };
  for (const step of steps) {
    if (!STEP_STATUS.includes(step.status)) {
      throw new TypeError(`step ${step.id} has an invalid status`);
    }
    if (step.status === "not_applicable") continue;
    summary.total += 1;
    summary[step.status] += 1;
  }
  return summary;
}

function isReady(summary) {
  return summary.pending === 0 && summary.blocked === 0;
}

export function readinessForPlan(steps) {
  if (!Array.isArray(steps)) throw new TypeError("plan steps are required");
  const requiredSteps = summarizeRequiredSteps(steps);
  const targetIds = [...new Set(steps.filter((step) => step.scope === "target" && typeof step.targetId === "string").map((step) => step.targetId))]
    .sort(compareCodeUnits);
  const targets = targetIds.map((targetId) => {
    const targetRequiredSteps = summarizeRequiredSteps(steps.filter((step) => step.scope === "target" && step.targetId === targetId));
    return { targetId, ready: isReady(targetRequiredSteps), requiredSteps: targetRequiredSteps };
  });

  return { ready: isReady(requiredSteps) && targets.every((target) => target.ready), requiredSteps, targets };
}
