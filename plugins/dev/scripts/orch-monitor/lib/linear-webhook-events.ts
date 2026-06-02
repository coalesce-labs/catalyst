/**
 * Type-safe parser from Linear webhook payloads to internal event shapes.
 *
 * Linear's webhook envelope is `{ action, type, data, updatedFrom?, … }` —
 * `action` is "create" | "update" | "remove", `type` is the resource type
 * (Issue, Comment, Cycle, Reaction, IssueLabel, Project), `data` carries the
 * full current state, and `updatedFrom` (only on update) carries previous
 * values of changed fields.
 *
 * Topic naming: `linear.<noun>.<verb>` — e.g. `linear.issue.state_changed`,
 * `linear.comment.created`. For Issue updates we inspect `updatedFrom` keys
 * to pick the most-specific topic in priority order:
 *   state > priority > assignee > generic-update.
 *
 * Returns `{ kind: "ignored", reason }` for unrecognized types/actions.
 */

export type LinearWebhookEvent =
  | {
      kind: "issue";
      action: "create" | "update" | "remove";
      topic: string;
      ticket: string | null; // e.g. "CTL-210" — from data.identifier
      teamKey: string | null;
      data: Record<string, unknown>;
      updatedFromKeys: string[];
      /** Linear user UUID who triggered the action; null when absent. CTL-263. */
      actorId: string | null;
      /** Current state name from data.state.name; null when absent. CTL-424. */
      toState: string | null;
      /** Current priority from data.priority; null when absent. CTL-424. */
      toPriority: number | null;
      /** Current assignee UUID from data.assignee.id; null when absent. CTL-424. */
      toAssigneeId: string | null;
      /** Current assignee display name from data.assignee.name; null when absent. CTL-424. */
      toAssigneeName: string | null;
      /** Actor display name from actor.name; null when absent. CTL-424. */
      actorName: string | null;
      /**
       * Current label name list from data.labels.nodes[].name; null when the
       * payload omits `labels` entirely (distinguishes "no label info" from
       * "explicitly empty"). Eligible-set scoping needs this. CTL-681.
       */
      toLabels: string[] | null;
      /**
       * Current project name from data.project.name; null when absent. CTL-681.
       */
      toProject: string | null;
      /**
       * Current project UUID from data.project.id, falling back to
       * data.projectId when the project object is omitted (partial payloads).
       * Null when neither is present. Stable join key for incremental
       * projection updates. CTL-681.
       */
      toProjectId: string | null;
      /**
       * Full updatedFrom map (previous values of changed fields). The pre-CTL-681
       * parser kept only the KEY NAMES (`updatedFromKeys`). Retaining the full
       * map lets a downstream consumer ask "did labels actually leave the set?"
       * by diffing previous labelIds against current data.labels.nodes[].id
       * without re-parsing the raw webhook payload.
       */
      previousFromValues: Record<string, unknown>;
      /** Current description text from data.description; null when absent. CTL-749. */
      description: string | null;
      /** True when "description" key appears in updatedFrom (description was edited). CTL-749. */
      descriptionChanged: boolean;
    }
  | {
      kind: "comment";
      action: "create" | "update" | "remove";
      ticket: string | null;
      commentId: string | null;
      issueId: string | null;
      body: string | null;        // CTL-681
      authorId: string | null;    // CTL-681
      authorName: string | null;  // CTL-681
      data: Record<string, unknown>;
    }
  | {
      kind: "cycle";
      action: "create" | "update" | "remove";
      cycleId: string | null;
      teamKey: string | null;
      data: Record<string, unknown>;
    }
  | {
      kind: "reaction";
      action: "create" | "update" | "remove";
      reactionId: string | null;
      data: Record<string, unknown>;
    }
  | {
      kind: "issue_label";
      action: "create" | "update" | "remove";
      labelId: string | null;
      data: Record<string, unknown>;
    }
  | {
      kind: "agent_session";
      action: "create" | "update" | "remove";
      sessionId: string | null;
      issueId: string | null;
      actorId: string | null;
      data: Record<string, unknown>;
    }
  | {
      kind: "mention";
      action: "create" | "update" | "remove";
      ticket: string | null;
      commentId: string | null;
      issueId: string | null;
      body: string | null;
      authorId: string | null;
      authorName: string | null;
      data: Record<string, unknown>;
    }
  | { kind: "ignored"; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getOptStr(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function ignored(reason: string): LinearWebhookEvent {
  return { kind: "ignored", reason };
}

function normalizeAction(value: unknown): "create" | "update" | "remove" | null {
  if (value === "create" || value === "update" || value === "remove") {
    return value;
  }
  return null;
}

function actionLabel(value: unknown): string {
  return typeof value === "string" ? value : "(non-string)";
}

/**
 * Pick the topic for an Issue event based on action and (for updates) the
 * fields changed in updatedFrom.
 *
 * Priority for updates: state > priority > assignee > generic.
 */
function issueTopic(action: "create" | "update" | "remove", updatedFromKeys: string[]): string {
  if (action === "create") return "linear.issue.created";
  if (action === "remove") return "linear.issue.removed";
  if (updatedFromKeys.includes("stateId")) return "linear.issue.state_changed";
  if (updatedFromKeys.includes("priority")) return "linear.issue.priority_changed";
  if (updatedFromKeys.includes("assigneeId")) return "linear.issue.assignee_changed";
  return "linear.issue.updated";
}

function teamKeyFromData(data: Record<string, unknown>): string | null {
  const team = data.team;
  if (!isObject(team)) return null;
  return getOptStr(team, "key");
}

function parseIssue(payload: Record<string, unknown>): LinearWebhookEvent {
  const action = normalizeAction(payload.action);
  if (action === null) return ignored(`Issue: unknown action ${actionLabel(payload.action)}`);
  const data = isObject(payload.data) ? payload.data : null;
  if (data === null) return ignored("Issue: missing data");
  const updatedFrom = isObject(payload.updatedFrom) ? payload.updatedFrom : {};
  const updatedFromKeys = Object.keys(updatedFrom);
  const actor = isObject(payload.actor) ? payload.actor : null;
  const actorId = actor !== null ? getOptStr(actor, "id") : null;
  const actorName = actor !== null ? getOptStr(actor, "name") : null;
  const stateObj = isObject(data.state) ? data.state : null;
  const toState = stateObj !== null ? getOptStr(stateObj, "name") : null;
  const toPriority = typeof data.priority === "number" ? data.priority : null;
  const assigneeObj = isObject(data.assignee) ? data.assignee : null;
  const toAssigneeId = assigneeObj !== null ? getOptStr(assigneeObj, "id") : null;
  const toAssigneeName = assigneeObj !== null ? getOptStr(assigneeObj, "name") : null;
  // CTL-681 — eligible-set scoping fields. Linear's API returns label info as
  // `labels: { nodes: [{id, name, …}] }` (confirmed by orch-monitor/lib/
  // linear.ts and linear-write.mjs:145). `null` when `labels` is absent
  // entirely, `[]` when the array is present but empty — preserves the
  // distinction the daemon's incremental projection needs.
  const toLabels = parseLabelNames(data.labels);
  const projectObj = isObject(data.project) ? data.project : null;
  const toProject = projectObj !== null ? getOptStr(projectObj, "name") : null;
  const toProjectId =
    projectObj !== null ? getOptStr(projectObj, "id") : getOptStr(data, "projectId");
  const description = getOptStr(data, "description") ?? null; // CTL-749
  const descriptionChanged = updatedFromKeys.includes("description"); // CTL-749
  return {
    kind: "issue",
    action,
    topic: issueTopic(action, updatedFromKeys),
    ticket: getOptStr(data, "identifier"),
    teamKey: teamKeyFromData(data),
    data,
    updatedFromKeys,
    actorId,
    actorName,
    toState,
    toPriority,
    toAssigneeId,
    toAssigneeName,
    toLabels,
    toProject,
    toProjectId,
    previousFromValues: updatedFrom,
    description,
    descriptionChanged,
  };
}

// parseLabelNames — extract the label-name list from a webhook `data.labels`
// value. Returns null when labels is absent (not an object), [] when present
// with an empty nodes array, or the names otherwise. CTL-681.
function parseLabelNames(value: unknown): string[] | null {
  if (!isObject(value)) return null;
  const nodes = value.nodes;
  if (!Array.isArray(nodes)) return null;
  const names: string[] = [];
  for (const node of nodes) {
    if (!isObject(node)) continue;
    const name = getOptStr(node, "name");
    if (name !== null) names.push(name);
  }
  return names;
}

function parseComment(payload: Record<string, unknown>): LinearWebhookEvent {
  const action = normalizeAction(payload.action);
  if (action === null) return ignored(`Comment: unknown action ${actionLabel(payload.action)}`);
  const data = isObject(payload.data) ? payload.data : null;
  if (data === null) return ignored("Comment: missing data");
  // Linear's Comment payload nests issue identifier under `issue.identifier`
  // when it expands the relation; older payloads carry just `issueId`.
  let ticket: string | null = null;
  if (isObject(data.issue)) {
    ticket = getOptStr(data.issue, "identifier");
  }
  // CTL-681: capture body + author. Actor precedence mirrors parseIssue:
  // top-level actor > data.user > data.userId.
  const actor = isObject(payload.actor) ? payload.actor : null;
  const userObj = isObject(data.user) ? data.user : null;
  const authorId =
    (actor !== null ? getOptStr(actor, "id") : null) ??
    (userObj !== null ? getOptStr(userObj, "id") : null) ??
    getOptStr(data, "userId");
  const authorName =
    (actor !== null ? getOptStr(actor, "name") : null) ??
    (userObj !== null ? getOptStr(userObj, "name") : null);
  return {
    kind: "comment",
    action,
    ticket,
    commentId: getOptStr(data, "id"),
    issueId: getOptStr(data, "issueId"),
    body: getOptStr(data, "body"),
    authorId,
    authorName,
    data,
  };
}

function parseCycle(payload: Record<string, unknown>): LinearWebhookEvent {
  const action = normalizeAction(payload.action);
  if (action === null) return ignored(`Cycle: unknown action ${actionLabel(payload.action)}`);
  const data = isObject(payload.data) ? payload.data : null;
  if (data === null) return ignored("Cycle: missing data");
  return {
    kind: "cycle",
    action,
    cycleId: getOptStr(data, "id"),
    teamKey: teamKeyFromData(data),
    data,
  };
}

function parseReaction(payload: Record<string, unknown>): LinearWebhookEvent {
  const action = normalizeAction(payload.action);
  if (action === null) return ignored(`Reaction: unknown action ${actionLabel(payload.action)}`);
  const data = isObject(payload.data) ? payload.data : null;
  if (data === null) return ignored("Reaction: missing data");
  return {
    kind: "reaction",
    action,
    reactionId: getOptStr(data, "id"),
    data,
  };
}

function parseIssueLabel(payload: Record<string, unknown>): LinearWebhookEvent {
  const action = normalizeAction(payload.action);
  if (action === null) return ignored(`IssueLabel: unknown action ${actionLabel(payload.action)}`);
  const data = isObject(payload.data) ? payload.data : null;
  if (data === null) return ignored("IssueLabel: missing data");
  return {
    kind: "issue_label",
    action,
    labelId: getOptStr(data, "id"),
    data,
  };
}

function parseAgentSessionEvent(payload: Record<string, unknown>): LinearWebhookEvent {
  const action = normalizeAction(payload.action);
  if (action === null) return ignored(`AgentSessionEvent: unknown action ${actionLabel(payload.action)}`);
  const data = isObject(payload.data) ? payload.data : null;
  if (data === null) return ignored("AgentSessionEvent: missing data");
  const actor = isObject(payload.actor) ? payload.actor : null;
  return {
    kind: "agent_session",
    action,
    sessionId: getOptStr(data, "id"),
    issueId: getOptStr(data, "issueId"),
    actorId: actor !== null ? getOptStr(actor, "id") : null,
    data,
  };
}

function parseMentionEvent(payload: Record<string, unknown>): LinearWebhookEvent {
  const action = normalizeAction(payload.action);
  if (action === null) return ignored(`issueCommentMention: unknown action ${actionLabel(payload.action)}`);
  const data = isObject(payload.data) ? payload.data : null;
  if (data === null) return ignored("issueCommentMention: missing data");
  let ticket: string | null = null;
  if (isObject(data.issue)) {
    ticket = getOptStr(data.issue, "identifier");
  }
  const actor = isObject(payload.actor) ? payload.actor : null;
  const userObj = isObject(data.user) ? data.user : null;
  const authorId =
    (actor !== null ? getOptStr(actor, "id") : null) ??
    (userObj !== null ? getOptStr(userObj, "id") : null) ??
    getOptStr(data, "userId");
  const authorName =
    (actor !== null ? getOptStr(actor, "name") : null) ??
    (userObj !== null ? getOptStr(userObj, "name") : null);
  return {
    kind: "mention",
    action,
    ticket,
    commentId: getOptStr(data, "id"),
    issueId: getOptStr(data, "issueId"),
    body: getOptStr(data, "body"),
    authorId,
    authorName,
    data,
  };
}

/**
 * Parse a Linear webhook payload by `type` (read from the `Linear-Event`
 * header; passed in by the handler). The payload's own `type` field should
 * match — we accept either as the dispatch key, preferring the header.
 */
export function parseLinearWebhookEvent(eventName: string, payload: unknown): LinearWebhookEvent {
  if (!isObject(payload)) return ignored("payload is not an object");
  const payloadType = typeof payload.type === "string" ? payload.type : "";
  const eventType = eventName.length > 0 ? eventName : payloadType;
  switch (eventType) {
    case "Issue":
      return parseIssue(payload);
    case "Comment":
      return parseComment(payload);
    case "Cycle":
      return parseCycle(payload);
    case "Reaction":
      return parseReaction(payload);
    case "IssueLabel":
      return parseIssueLabel(payload);
    case "AgentSessionEvent":
      return parseAgentSessionEvent(payload);
    case "issueCommentMention":
      return parseMentionEvent(payload);
    default:
      return ignored(`unhandled type: ${eventType}`);
  }
}
