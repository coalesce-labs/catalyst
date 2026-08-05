export const SCHEMA_VERSION = "1";
export const DEPLOYMENT_MODES = Object.freeze(["single-host", "cluster", "cloud"]);
export const NODE_CLASSES = Object.freeze(["developer", "worker", "monitor"]);

function requireObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function normalizeNodeClass(value, name) {
  const nodeClass = requiredString(value, name).toLowerCase();
  if (!NODE_CLASSES.includes(nodeClass)) {
    throw new TypeError(`${name} must be valid`);
  }
  return nodeClass;
}

function normalizeTarget(target) {
  const source = requireObject(target, "target");
  if (typeof source.online !== "boolean") {
    throw new TypeError("target online status is required");
  }
  return {
    id: requiredString(source.id, "target id"),
    nodeClass: normalizeNodeClass(source.nodeClass, "target node class"),
    online: source.online,
  };
}

function normalizeTeam(value) {
  const team = requireObject(value, "team");
  const intent = requiredString(team.intent, "team intent").toLowerCase();
  if (intent !== "existing" && intent !== "create") {
    throw new TypeError("team intent must be valid");
  }
  const normalized = { intent, key: requiredString(team.key, "team key") };
  if (intent === "create") {
    if (team.confirmed !== true) {
      throw new TypeError("create team must be explicitly confirmed");
    }
    normalized.confirmed = true;
  }
  return normalized;
}

function normalizeTargetPolicy(value, deploymentMode) {
  const policy = requireObject(value, "target policy");
  if (!Array.isArray(policy.targets) || (policy.targets.length === 0 && deploymentMode !== "cloud")) {
    throw new TypeError("target policy requires explicit targets");
  }
  if (typeof policy.includeController !== "boolean") {
    throw new TypeError("target policy includeController is required");
  }
  if (!Array.isArray(policy.executionNodeClasses) || policy.executionNodeClasses.length === 0) {
    throw new TypeError("target policy requires explicit execution node classes");
  }

  const targets = policy.targets.map(normalizeTarget).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(targets.map(({ id }) => id)).size !== targets.length) {
    throw new TypeError("target ids must be unique");
  }
  const executionNodeClasses = [...new Set(policy.executionNodeClasses.map((nodeClass) => normalizeNodeClass(nodeClass, "execution node class")))]
    .sort((left, right) => NODE_CLASSES.indexOf(left) - NODE_CLASSES.indexOf(right));

  return { targets, includeController: policy.includeController, executionNodeClasses };
}

export function normalizeOnboardingRequest(value) {
  const request = requireObject(value, "request");
  if (request.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError(`schemaVersion must be ${SCHEMA_VERSION}`);
  }

  const vcsRepo = requiredString(request.vcsRepo, "vcsRepo");
  if (!/^[^/\s]+\/[^/\s]+$/.test(vcsRepo)) {
    throw new TypeError("vcsRepo must be a valid unambiguous owner/repository");
  }
  const projectKey = requiredString(request.projectKey, "projectKey");
  const deploymentMode = requiredString(request.deploymentMode, "deployment mode").toLowerCase();
  if (!DEPLOYMENT_MODES.includes(deploymentMode)) {
    throw new TypeError("deployment mode must be valid");
  }

  const controller = requireObject(request.controller, "controller");
  const normalizedController = {
    id: requiredString(controller.id, "controller id"),
    nodeClass: normalizeNodeClass(controller.nodeClass, "controller node class"),
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    vcsRepo,
    projectKey,
    team: normalizeTeam(request.team),
    deploymentMode,
    controller: normalizedController,
    targetPolicy: normalizeTargetPolicy(request.targetPolicy, deploymentMode),
  };
}
