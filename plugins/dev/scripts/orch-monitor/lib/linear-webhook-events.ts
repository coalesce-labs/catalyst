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
      /**
       * Linear issue entityId UUID from data.id; null when absent. The
       * `remove` action's payload carries ONLY this UUID (no identifier), so
       * the Gateway's UUID→identifier index (CTL-821) is keyed off it. CTL-822.
       */
      issueId: string | null;
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
       * Current label name list. Accepts BOTH Linear shapes: the GraphQL API's
       * `data.labels = {nodes:[{name}]}` (CTL-681) and the WEBHOOK's flat array
       * `data.labels = [{id,name,color}]` (CTL-1031 — the shape real
       * label-change webhooks actually carry). null when the payload omits
       * `labels` entirely OR the array is malformed (distinguishes "no/unknown
       * label info" from "explicitly empty" []). Eligible-set scoping + the
       * broker's held_since fold need this. CTL-681, CTL-1031.
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
      /**
       * Current estimate (numeric story points) from data.estimate; null when
       * explicitly unset; undefined (field absent) when `estimate` was not present
       * in the webhook payload — KEY-PRESENCE: absent → keep stored value. CTL-957.
       */
      toEstimate?: number | null;
      /**
       * CTL-1174: Current delegate UUID from data.delegate.id. undefined when the
       * `delegate` key is absent from the payload (KEY-PRESENCE: absent → keep);
       * null when the key is present but cleared (explicit un-delegate). DEFENSIVE:
       * Linear does NOT reliably carry delegate in Issue webhooks (routes to
       * AgentSessionEvent) — this field is dormant scaffolding that activates if
       * Linear ever surfaces it.
       */
      toDelegateId?: string | null;
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
 * Priority for updates: state > priority > assignee > delegate > generic.
 * CTL-1174: delegate_changed is lower priority than assignee. The exact
 * updatedFrom key Linear uses for delegate is unverified ("delegateId" is the
 * likely key by analogy with "assigneeId"); we check both spellings defensively.
 */
function issueTopic(action: "create" | "update" | "remove", updatedFromKeys: string[]): string {
  if (action === "create") return "linear.issue.created";
  if (action === "remove") return "linear.issue.removed";
  if (updatedFromKeys.includes("stateId")) return "linear.issue.state_changed";
  if (updatedFromKeys.includes("priority")) return "linear.issue.priority_changed";
  if (updatedFromKeys.includes("assigneeId")) return "linear.issue.assignee_changed";
  if (updatedFromKeys.includes("delegateId") || updatedFromKeys.includes("delegate")) {
    return "linear.issue.delegate_changed";
  }
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
  // CTL-681/CTL-1031 — eligible-set scoping + held_since fold. Linear's GraphQL
  // API returns labels as `{ nodes: [{id, name, …}] }`, but WEBHOOK payloads
  // (the only thing this parser sees) serialize them as a FLAT ARRAY
  // `[{id, name, color}]`. parseLabelNames accepts both. `null` when `labels`
  // is absent / malformed (unknown → keep), `[]` when explicitly empty (clear)
  // — the distinction the daemon's incremental projection + router fold need.
  const toLabels = parseLabelNames(data.labels);
  const projectObj = isObject(data.project) ? data.project : null;
  const toProject = projectObj !== null ? getOptStr(projectObj, "name") : null;
  const toProjectId =
    projectObj !== null ? getOptStr(projectObj, "id") : getOptStr(data, "projectId");
  const description = getOptStr(data, "description") ?? null; // CTL-749
  const descriptionChanged = updatedFromKeys.includes("description"); // CTL-749
  // CTL-957: estimate (numeric story points) — Linear sends data.estimate as a
  // number (or omits it). "estimate" key in updatedFrom means it changed; even
  // when not in updatedFrom the full snapshot always carries the current value
  // when present, so we read it unconditionally when the key exists in data.
  const toEstimate = "estimate" in data
    ? (typeof data.estimate === "number" ? data.estimate : null)
    : undefined; // absent → keep stored value
  // CTL-1174: delegate UUID — KEY-PRESENCE so the broker fold can distinguish
  // "payload said nothing about delegate" (absent key → keep) from "delegate
  // was explicitly cleared" (key present, value null). DEFENSIVE: Linear does
  // NOT reliably emit delegate in Issue webhooks; this is dormant scaffolding.
  const delegateObj = isObject(data.delegate) ? data.delegate : null;
  const toDelegateId = "delegate" in data
    ? (delegateObj !== null ? getOptStr(delegateObj, "id") : null)
    : undefined; // absent → key-presence KEEP
  return {
    kind: "issue",
    action,
    topic: issueTopic(action, updatedFromKeys),
    ticket: getOptStr(data, "identifier"),
    teamKey: teamKeyFromData(data),
    data,
    updatedFromKeys,
    issueId: getOptStr(data, "id"), // CTL-822 — entityId UUID (all a `remove` carries)
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
    toEstimate,
    toDelegateId,
  };
}

// parseLabelNames — extract the label-name list from a `data.labels` value.
//
// Linear serializes labels two different ways depending on the source:
//   • GraphQL API  → `{ nodes: [{ id, name, … }] }`  (paginated relation)
//   • WEBHOOK      → `[{ id, name, color }, …]`        (FLAT ARRAY, CTL-1031)
//
// The pre-CTL-1031 parser only accepted the `{nodes}` shape, so every real
// label-change webhook (a flat array) fell through to null and the broker's
// label fold + held_since stamp never fired (router.mjs:1035,1044). We now
// accept BOTH shapes.
//
// Return contract (the [] vs null distinction the router relies on):
//   • null → "unknown" — labels absent, or a MALFORMED array we can't trust.
//            router.mjs:1035 leaves the stored label set untouched (keep).
//   • []   → "explicitly empty" — a genuine empty label set; router CLEARS
//            the stored labels and clears held_since.
//   • [names…] → the resolved label names.
//
// A flat array is rejected to null (not partially parsed) when ANY entry is a
// non-object or an object without a usable string `name` — a partial parse
// could silently shrink the set and mis-clear `blocked`/`waiting`, which is
// worse than "unknown → keep". CTL-1031.
function parseLabelNames(value: unknown): string[] | null {
  // Flat-array webhook shape: [{ id, name, color }, …]
  if (Array.isArray(value)) {
    return parseLabelArray(value);
  }
  // GraphQL API shape: { nodes: [{ id, name, … }] }
  if (isObject(value)) {
    const nodes = value.nodes;
    if (Array.isArray(nodes)) {
      return parseLabelArray(nodes);
    }
  }
  // Anything else (absent, ids-only in updatedFrom, scalar) → unknown.
  return null;
}

// parseLabelArray — turn an array of label-node objects into a name list, or
// null if the array contains any entry we can't extract a non-empty string
// name from. An empty input array yields [] (the genuine empty-set signal).
function parseLabelArray(arr: unknown[]): string[] | null {
  const names: string[] = [];
  for (const node of arr) {
    if (!isObject(node)) return null;
    const name = getOptStr(node, "name");
    if (name === null) return null;
    names.push(name);
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
