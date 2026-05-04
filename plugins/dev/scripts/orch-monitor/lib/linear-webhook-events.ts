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
    }
  | {
      kind: "comment";
      action: "create" | "update" | "remove";
      ticket: string | null;
      commentId: string | null;
      issueId: string | null;
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
  | { kind: "ignored"; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getOptStr(
  obj: Record<string, unknown>,
  key: string,
): string | null {
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
function issueTopic(
  action: "create" | "update" | "remove",
  updatedFromKeys: string[],
): string {
  if (action === "create") return "linear.issue.created";
  if (action === "remove") return "linear.issue.removed";
  if (updatedFromKeys.includes("stateId")) return "linear.issue.state_changed";
  if (updatedFromKeys.includes("priority"))
    return "linear.issue.priority_changed";
  if (updatedFromKeys.includes("assigneeId"))
    return "linear.issue.assignee_changed";
  return "linear.issue.updated";
}

function teamKeyFromData(data: Record<string, unknown>): string | null {
  const team = data.team;
  if (!isObject(team)) return null;
  return getOptStr(team, "key");
}

function parseIssue(payload: Record<string, unknown>): LinearWebhookEvent {
  const action = normalizeAction(payload.action);
  if (action === null)
    return ignored(`Issue: unknown action ${actionLabel(payload.action)}`);
  const data = isObject(payload.data) ? payload.data : null;
  if (data === null) return ignored("Issue: missing data");
  const updatedFrom = isObject(payload.updatedFrom)
    ? payload.updatedFrom
    : {};
  const updatedFromKeys = Object.keys(updatedFrom);
  return {
    kind: "issue",
    action,
    topic: issueTopic(action, updatedFromKeys),
    ticket: getOptStr(data, "identifier"),
    teamKey: teamKeyFromData(data),
    data,
    updatedFromKeys,
  };
}

function parseComment(payload: Record<string, unknown>): LinearWebhookEvent {
  const action = normalizeAction(payload.action);
  if (action === null)
    return ignored(`Comment: unknown action ${actionLabel(payload.action)}`);
  const data = isObject(payload.data) ? payload.data : null;
  if (data === null) return ignored("Comment: missing data");
  // Linear's Comment payload nests issue identifier under `issue.identifier`
  // when it expands the relation; older payloads carry just `issueId`.
  let ticket: string | null = null;
  if (isObject(data.issue)) {
    ticket = getOptStr(data.issue, "identifier");
  }
  return {
    kind: "comment",
    action,
    ticket,
    commentId: getOptStr(data, "id"),
    issueId: getOptStr(data, "issueId"),
    data,
  };
}

function parseCycle(payload: Record<string, unknown>): LinearWebhookEvent {
  const action = normalizeAction(payload.action);
  if (action === null)
    return ignored(`Cycle: unknown action ${actionLabel(payload.action)}`);
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
  if (action === null)
    return ignored(`Reaction: unknown action ${actionLabel(payload.action)}`);
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
  if (action === null)
    return ignored(`IssueLabel: unknown action ${actionLabel(payload.action)}`);
  const data = isObject(payload.data) ? payload.data : null;
  if (data === null) return ignored("IssueLabel: missing data");
  return {
    kind: "issue_label",
    action,
    labelId: getOptStr(data, "id"),
    data,
  };
}

/**
 * Parse a Linear webhook payload by `type` (read from the `Linear-Event`
 * header; passed in by the handler). The payload's own `type` field should
 * match — we accept either as the dispatch key, preferring the header.
 */
export function parseLinearWebhookEvent(
  eventName: string,
  payload: unknown,
): LinearWebhookEvent {
  if (!isObject(payload)) return ignored("payload is not an object");
  const payloadType =
    typeof payload.type === "string" ? payload.type : "";
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
    default:
      return ignored(`unhandled type: ${eventType}`);
  }
}
