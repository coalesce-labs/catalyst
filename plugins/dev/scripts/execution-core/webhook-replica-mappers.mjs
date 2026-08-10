// webhook-replica-mappers.mjs — CAT-152. Pure translation from a parsed
// LinearWebhookEvent (orch-monitor/lib/linear-webhook-events.ts) to the
// {entity, op, row, entityId} shape @catalyst-cloud/replicate's applyDelta
// expects. No I/O — every function here is a pure data transform, unit-tested
// against fixture events, never a live webhook or DB.

export function mapIssueChange(event) {
  if (event.kind !== "issue") throw new Error(`mapIssueChange: expected kind "issue", got ${event.kind}`);
  if (event.action === "remove") {
    return { entity: "issues", op: "delete", row: {}, entityId: event.issueId ?? undefined };
  }
  const d = event.data ?? {};
  const row = {
    id: d.id ?? event.issueId,
    identifier: d.identifier ?? event.ticket ?? undefined,
    title: d.title,
    description: d.description,
    state: d.state?.name,
    priority: d.priority,
    estimate: d.estimate,
    url: d.url,
    branch_name: d.branchName,
    assignee_id: d.assignee?.id ?? d.assigneeId,
    team_id: d.team?.id ?? d.teamId,
    project_id: d.project?.id ?? d.projectId,
    cycle_id: d.cycle?.id ?? d.cycleId,
    created_at: toEpochMs(d.createdAt),
    updated_at: toEpochMs(d.updatedAt),
  };
  return { entity: "issues", op: "upsert", row: stripUndefined(row), entityId: row.id };
}

export function mapIssueLabels(event) {
  const raw = event.data?.labels;
  const nodes = Array.isArray(raw) ? raw : Array.isArray(raw?.nodes) ? raw.nodes : null;
  if (!nodes) return { labelDefs: [], issueLabelLinks: [] };
  const issueId = event.data?.id ?? event.issueId;
  const validNodes = nodes.filter((l) => l && typeof l.id === "string");
  const labelDefs = validNodes.map((l) => ({
    entity: "labels",
    op: "upsert",
    row: stripUndefined({ id: l.id, name: l.name, color: l.color }),
  }));
  const issueLabelLinks = validNodes.map((l) => ({
    entity: "issue_labels",
    op: "upsert",
    row: { issue_id: issueId, label_id: l.id },
  }));
  return { labelDefs, issueLabelLinks };
}

export function mapCommentChange(event) {
  if (event.kind !== "comment") throw new Error(`mapCommentChange: expected kind "comment", got ${event.kind}`);
  if (event.action === "remove") {
    return { entity: "comments", op: "delete", row: {}, entityId: event.commentId ?? undefined };
  }
  const d = event.data ?? {};
  const row = {
    id: d.id ?? event.commentId,
    issue_id: d.issueId ?? event.issueId,
    body: d.body,
    author_id: d.user?.id ?? d.userId,
    author_name: d.user?.name,
    parent_id: d.parent?.id ?? d.parentId,
    created_at: toEpochMs(d.createdAt),
    updated_at: toEpochMs(d.updatedAt),
  };
  return { entity: "comments", op: "upsert", row: stripUndefined(row), entityId: row.id };
}

function toEpochMs(iso) {
  if (typeof iso !== "string") return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}
