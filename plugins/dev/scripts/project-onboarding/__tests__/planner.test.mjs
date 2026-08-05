import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createOnboardingPlan, readinessForPlan } from "../planner.mjs";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const stepRefs = (steps) =>
  steps.map(({ id, scope, targetId }) => ({ id, scope, ...(targetId ? { targetId } : {}) }));

test("creates the hand-defined stable control-plane then local-target step order", () => {
  const plan = createOnboardingPlan(fixture("local-existing-team"));

  assert.deepEqual(stepRefs(plan), [
    { id: "provider.github_access", scope: "control_plane" },
    { id: "provider.linear_team", scope: "control_plane" },
    { id: "project.identity_config", scope: "control_plane" },
    { id: "project.workflow_states", scope: "control_plane" },
    { id: "project.git_automations", scope: "control_plane" },
    { id: "project.event_ingestion", scope: "control_plane" },
    { id: "target.checkout", scope: "target", targetId: "mini-1" },
    { id: "target.execution_registry", scope: "target", targetId: "mini-1" },
    { id: "target.thoughts_mapping", scope: "target", targetId: "mini-1" },
    { id: "target.activation_policy", scope: "target", targetId: "mini-1" },
    { id: "target.end_to_end_readiness", scope: "target", targetId: "mini-1" },
  ]);
});

test("expands cluster targets after control-plane steps", () => {
  const clusterPlan = createOnboardingPlan(fixture("cluster-offline-node"));

  assert.deepEqual(
    [
      ...new Set(
        clusterPlan.filter((step) => step.scope === "target").map((step) => step.targetId)
      ),
    ],
    ["mini-1", "mini-2"]
  );
});

test("preserves declared cloud targets so control-plane success cannot imply fleet convergence", () => {
  const observations = Object.fromEntries(
    [
      "provider.github_access",
      "provider.linear_team",
      "project.identity_config",
      "project.workflow_states",
      "project.git_automations",
      "project.event_ingestion",
    ].map((id) => [id, { status: "satisfied" }])
  );
  const plan = createOnboardingPlan(fixture("cloud-authoritative"), observations);

  assert.deepEqual(
    [...new Set(plan.filter((step) => step.scope === "target").map((step) => step.targetId))],
    ["cloud-worker-1"]
  );
  assert.deepEqual(readinessForPlan(plan), {
    ready: false,
    requiredSteps: { total: 11, satisfied: 6, pending: 5, blocked: 0 },
    targets: [
      {
        targetId: "cloud-worker-1",
        ready: false,
        requiredSteps: { total: 5, satisfied: 0, pending: 5, blocked: 0 },
      },
    ],
  });
});

test("excludes a developer controller from execution targets until policy and node class both permit it", () => {
  const request = fixture("developer-controller-non-executing");
  const excluded = createOnboardingPlan(request);
  const permitted = createOnboardingPlan({
    ...request,
    targetPolicy: { ...request.targetPolicy, executionNodeClasses: ["developer", "worker"] },
  });

  assert.deepEqual(
    [...new Set(excluded.filter((step) => step.scope === "target").map((step) => step.targetId))],
    ["mini-1"]
  );
  assert.deepEqual(
    [...new Set(permitted.filter((step) => step.scope === "target").map((step) => step.targetId))],
    ["laptop", "mini-1"]
  );
});

test("keeps offline cluster targets pending and reports incomplete required-step convergence", () => {
  const plan = createOnboardingPlan(fixture("cluster-offline-node"));
  const offlineSteps = plan.filter((step) => step.targetId === "mini-2");
  const readiness = readinessForPlan(plan);

  assert.deepEqual(
    offlineSteps.map(({ status, reason, repairable }) => ({ status, reason, repairable })),
    [
      { status: "pending", reason: { code: "target_offline" }, repairable: true },
      { status: "pending", reason: { code: "target_offline" }, repairable: true },
      { status: "pending", reason: { code: "target_offline" }, repairable: true },
      { status: "pending", reason: { code: "target_offline" }, repairable: true },
      { status: "pending", reason: { code: "target_offline" }, repairable: true },
    ]
  );
  assert.deepEqual(readiness, {
    ready: false,
    requiredSteps: { total: 16, satisfied: 0, pending: 16, blocked: 0 },
    targets: [
      {
        targetId: "mini-1",
        ready: false,
        requiredSteps: { total: 5, satisfied: 0, pending: 5, blocked: 0 },
      },
      {
        targetId: "mini-2",
        ready: false,
        requiredSteps: { total: 5, satisfied: 0, pending: 5, blocked: 0 },
      },
    ],
  });
});

test("treats blocked and pending required steps as not ready while not_applicable is neutral", () => {
  const readiness = readinessForPlan([
    { id: "provider.github_access", scope: "control_plane", status: "satisfied" },
    { id: "target.checkout", scope: "target", targetId: "mini-1", status: "pending" },
    { id: "target.checkout", scope: "target", targetId: "laptop", status: "not_applicable" },
    { id: "target.execution_registry", scope: "target", targetId: "mini-1", status: "blocked" },
  ]);

  assert.deepEqual(readiness, {
    ready: false,
    requiredSteps: { total: 3, satisfied: 1, pending: 1, blocked: 1 },
    targets: [
      {
        targetId: "laptop",
        ready: true,
        requiredSteps: { total: 0, satisfied: 0, pending: 0, blocked: 0 },
      },
      {
        targetId: "mini-1",
        ready: false,
        requiredSteps: { total: 2, satisfied: 0, pending: 1, blocked: 1 },
      },
    ],
  });
});

test("reports target readiness in locale-independent code-unit order", () => {
  const readiness = readinessForPlan(
    ["ı", "i", "ä", "I", "İ", "z"].map((targetId) => ({
      id: "target.checkout",
      scope: "target",
      targetId,
      status: "satisfied",
    }))
  );

  assert.deepEqual(
    readiness.targets.map(({ targetId }) => targetId),
    ["I", "i", "z", "ä", "İ", "ı"]
  );
});

test("returns byte-stable JSON and changes rerun statuses only from observations", () => {
  const request = fixture("rerun-partial-repair");
  const first = createOnboardingPlan(request, request.observations);
  const duplicate = createOnboardingPlan(request, request.observations);
  const repaired = createOnboardingPlan(request, {
    ...request.observations,
    "target.mini-1.execution_registry": { status: "satisfied", evidence: { entry: "PROJ" } },
  });

  assert.equal(JSON.stringify(first), JSON.stringify(duplicate));
  assert.deepEqual(
    first.map(({ status, reason, evidence, ...stable }) => stable),
    repaired.map(({ status, reason, evidence, ...stable }) => stable)
  );
  assert.equal(first.find((step) => step.id === "target.execution_registry")?.status, "pending");
  assert.equal(
    repaired.find((step) => step.id === "target.execution_registry")?.status,
    "satisfied"
  );
});

test("planner remains a pure module with no adapter or host capability imports", () => {
  const source = readFileSync(fileURLToPath(new URL("../planner.mjs", import.meta.url)), "utf8");

  assert.doesNotMatch(
    source,
    /from\s+["'](?:node:(?:fs|child_process|http|https)|[^"']*(?:adapter|provider|config|http-client)[^"']*)["']/i
  );
});
