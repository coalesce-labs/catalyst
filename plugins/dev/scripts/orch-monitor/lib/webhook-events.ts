/**
 * Type-safe parser from GitHub webhook payloads to internal event shapes.
 *
 * Returns `{ kind: "ignored", reason }` rather than throwing for unrecognized
 * event names or malformed payloads — webhook payloads can change shape and
 * the receiver should be permissive.
 */

/**
 * Author identity carried on review and comment events.
 *
 * `type` is GitHub's `user.type` field — typically `"User"` or `"Bot"`,
 * but `"Mannequin"` and `"Organization"` also appear. We pass it through
 * verbatim so consumers can write `detail.author.type == "Bot"` filters
 * without re-parsing. Empty strings indicate the upstream payload was
 * missing the user block (defensive default; the field always exists on
 * well-formed GitHub webhooks).
 */
export interface AuthorRef {
  login: string;
  type: string;
}

export type WebhookEvent =
  | {
      kind: "pull_request";
      repo: string;
      number: number;
      action: string;
      merged: boolean;
      mergedAt: string | null;
      draft: boolean;
      mergeable: boolean | null;
    }
  | {
      kind: "pull_request_review";
      repo: string;
      number: number;
      action: string;
      reviewState: string;
      reviewer: string;
      body: string;
      author: AuthorRef;
    }
  | {
      kind: "pull_request_review_thread";
      repo: string;
      number: number;
      action: string;
      threadId: number;
    }
  | {
      kind: "check_suite";
      repo: string;
      prNumbers: number[];
      conclusion: string | null;
      status: string;
    }
  | {
      kind: "status";
      repo: string;
      sha: string;
      state: string;
    }
  | {
      kind: "push";
      repo: string;
      ref: string;
      baseSha: string;
      headSha: string;
      commits: Array<{ id: string; message: string }>;
    }
  | {
      kind: "issue_comment";
      repo: string;
      number: number;
      action: string;
      commentId: number;
      body: string;
      htmlUrl: string;
      author: AuthorRef;
    }
  | {
      kind: "pull_request_review_comment";
      repo: string;
      number: number;
      action: string;
      commentId: number;
      body: string;
      htmlUrl: string;
      author: AuthorRef;
    }
  | {
      kind: "deployment";
      repo: string;
      deploymentId: number;
      environment: string;
      sha: string;
      refName: string;
      payloadUrl: string | null;
    }
  | {
      kind: "deployment_status";
      repo: string;
      deploymentId: number;
      environment: string;
      state: string;
      targetUrl: string | null;
      environmentUrl: string | null;
    }
  | {
      kind: "release";
      repo: string;
      action: string;
      releaseId: number;
      tag: string;
      name: string;
      draft: boolean;
      prerelease: boolean;
      htmlUrl: string;
    }
  | {
      kind: "workflow_run";
      repo: string;
      action: string;
      workflowId: number;
      runId: number;
      name: string;
      headSha: string;
      headBranch: string;
      status: string;
      conclusion: string | null;
      runNumber: number;
      htmlUrl: string;
      prNumbers: number[];
    }
  | { kind: "ignored"; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStr(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

function getOptStr(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function getNum(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === "number" ? v : 0;
}

function getBool(obj: Record<string, unknown>, key: string): boolean {
  return obj[key] === true;
}

function getOptBool(
  obj: Record<string, unknown>,
  key: string,
): boolean | null {
  const v = obj[key];
  return typeof v === "boolean" ? v : null;
}

function getRepoFullName(payload: Record<string, unknown>): string | null {
  const repo = payload.repository;
  if (!isObject(repo)) return null;
  const fullName = repo.full_name;
  return typeof fullName === "string" && fullName.length > 0 ? fullName : null;
}

function ignored(reason: string): WebhookEvent {
  return { kind: "ignored", reason };
}

function parseAuthor(value: unknown): AuthorRef {
  if (!isObject(value)) return { login: "", type: "" };
  return { login: getStr(value, "login"), type: getStr(value, "type") };
}

export function parseWebhookEvent(
  eventName: string,
  payload: unknown,
): WebhookEvent {
  if (!isObject(payload)) return ignored("payload is not an object");
  const repo = getRepoFullName(payload);
  if (repo === null) return ignored("missing repository.full_name");

  switch (eventName) {
    case "pull_request":
      return parsePullRequest(repo, payload);
    case "pull_request_review":
      return parsePullRequestReview(repo, payload);
    case "pull_request_review_thread":
      return parsePullRequestReviewThread(repo, payload);
    case "check_suite":
      return parseCheckSuite(repo, payload);
    case "status":
      return parseStatus(repo, payload);
    case "push":
      return parsePush(repo, payload);
    case "issue_comment":
      return parseIssueComment(repo, payload);
    case "pull_request_review_comment":
      return parsePullRequestReviewComment(repo, payload);
    case "deployment":
      return parseDeployment(repo, payload);
    case "deployment_status":
      return parseDeploymentStatus(repo, payload);
    case "release":
      return parseRelease(repo, payload);
    case "workflow_run":
      return parseWorkflowRun(repo, payload);
    default:
      return ignored(`unhandled event: ${eventName}`);
  }
}

function parsePullRequest(
  repo: string,
  payload: Record<string, unknown>,
): WebhookEvent {
  const pr = payload.pull_request;
  if (!isObject(pr)) return ignored("pull_request: missing pull_request");
  const number = getNum(pr, "number");
  if (number === 0) return ignored("pull_request: missing number");
  return {
    kind: "pull_request",
    repo,
    number,
    action: getStr(payload, "action"),
    merged: getBool(pr, "merged"),
    mergedAt: getOptStr(pr, "merged_at"),
    draft: getBool(pr, "draft"),
    mergeable: getOptBool(pr, "mergeable"),
  };
}

function parsePullRequestReview(
  repo: string,
  payload: Record<string, unknown>,
): WebhookEvent {
  const pr = payload.pull_request;
  const review = payload.review;
  if (!isObject(pr)) return ignored("pull_request_review: missing pull_request");
  if (!isObject(review)) return ignored("pull_request_review: missing review");
  const number = getNum(pr, "number");
  if (number === 0) return ignored("pull_request_review: missing number");
  const user = isObject(review.user) ? review.user : {};
  return {
    kind: "pull_request_review",
    repo,
    number,
    action: getStr(payload, "action"),
    reviewState: getStr(review, "state"),
    reviewer: getStr(user, "login"),
    body: getStr(review, "body"),
    author: parseAuthor(review.user),
  };
}

function parsePullRequestReviewThread(
  repo: string,
  payload: Record<string, unknown>,
): WebhookEvent {
  const pr = payload.pull_request;
  const thread = payload.thread;
  if (!isObject(pr))
    return ignored("pull_request_review_thread: missing pull_request");
  if (!isObject(thread))
    return ignored("pull_request_review_thread: missing thread");
  const number = getNum(pr, "number");
  if (number === 0)
    return ignored("pull_request_review_thread: missing number");
  return {
    kind: "pull_request_review_thread",
    repo,
    number,
    action: getStr(payload, "action"),
    threadId: getNum(thread, "id"),
  };
}

function parseCheckSuite(
  repo: string,
  payload: Record<string, unknown>,
): WebhookEvent {
  const suite = payload.check_suite;
  if (!isObject(suite)) return ignored("check_suite: missing check_suite");
  const prsRaw = suite.pull_requests;
  const prNumbers: number[] = [];
  if (Array.isArray(prsRaw)) {
    for (const entry of prsRaw) {
      if (isObject(entry)) {
        const n = getNum(entry, "number");
        if (n > 0) prNumbers.push(n);
      }
    }
  }
  return {
    kind: "check_suite",
    repo,
    prNumbers,
    conclusion: getOptStr(suite, "conclusion"),
    status: getStr(suite, "status"),
  };
}

function parseStatus(
  repo: string,
  payload: Record<string, unknown>,
): WebhookEvent {
  const sha = getStr(payload, "sha");
  if (sha.length === 0) return ignored("status: missing sha");
  return {
    kind: "status",
    repo,
    sha,
    state: getStr(payload, "state"),
  };
}

function parsePush(
  repo: string,
  payload: Record<string, unknown>,
): WebhookEvent {
  const commitsRaw = payload.commits;
  const commits: Array<{ id: string; message: string }> = [];
  if (Array.isArray(commitsRaw)) {
    for (const entry of commitsRaw) {
      if (isObject(entry)) {
        commits.push({
          id: getStr(entry, "id"),
          message: getStr(entry, "message"),
        });
      }
    }
  }
  return {
    kind: "push",
    repo,
    ref: getStr(payload, "ref"),
    baseSha: getStr(payload, "before"),
    headSha: getStr(payload, "after"),
    commits,
  };
}

function parseIssueComment(
  repo: string,
  payload: Record<string, unknown>,
): WebhookEvent {
  const issue = payload.issue;
  const comment = payload.comment;
  if (!isObject(issue)) return ignored("issue_comment: missing issue");
  if (!isObject(comment)) return ignored("issue_comment: missing comment");
  // Only PR-attached comments are interesting for the preview pipeline
  if (!isObject(issue.pull_request))
    return ignored("issue_comment: not a PR comment");
  const number = getNum(issue, "number");
  if (number === 0) return ignored("issue_comment: missing number");
  return {
    kind: "issue_comment",
    repo,
    number,
    action: getStr(payload, "action"),
    commentId: getNum(comment, "id"),
    body: getStr(comment, "body"),
    htmlUrl: getStr(comment, "html_url"),
    author: parseAuthor(comment.user),
  };
}

function parsePullRequestReviewComment(
  repo: string,
  payload: Record<string, unknown>,
): WebhookEvent {
  const pr = payload.pull_request;
  const comment = payload.comment;
  if (!isObject(pr))
    return ignored("pull_request_review_comment: missing pull_request");
  if (!isObject(comment))
    return ignored("pull_request_review_comment: missing comment");
  const number = getNum(pr, "number");
  if (number === 0)
    return ignored("pull_request_review_comment: missing number");
  return {
    kind: "pull_request_review_comment",
    repo,
    number,
    action: getStr(payload, "action"),
    commentId: getNum(comment, "id"),
    body: getStr(comment, "body"),
    htmlUrl: getStr(comment, "html_url"),
    author: parseAuthor(comment.user),
  };
}

function parseDeployment(
  repo: string,
  payload: Record<string, unknown>,
): WebhookEvent {
  const deployment = payload.deployment;
  if (!isObject(deployment)) return ignored("deployment: missing deployment");
  return {
    kind: "deployment",
    repo,
    deploymentId: getNum(deployment, "id"),
    environment: getStr(deployment, "environment"),
    sha: getStr(deployment, "sha"),
    refName: getStr(deployment, "ref"),
    payloadUrl: getOptStr(deployment, "payload_url"),
  };
}

function parseDeploymentStatus(
  repo: string,
  payload: Record<string, unknown>,
): WebhookEvent {
  const deployment = payload.deployment;
  const status = payload.deployment_status;
  if (!isObject(deployment))
    return ignored("deployment_status: missing deployment");
  if (!isObject(status))
    return ignored("deployment_status: missing deployment_status");
  return {
    kind: "deployment_status",
    repo,
    deploymentId: getNum(deployment, "id"),
    environment: getStr(deployment, "environment"),
    state: getStr(status, "state"),
    targetUrl: getOptStr(status, "target_url"),
    environmentUrl: getOptStr(status, "environment_url"),
  };
}

function parseRelease(
  repo: string,
  payload: Record<string, unknown>,
): WebhookEvent {
  const release = payload.release;
  if (!isObject(release)) return ignored("release: missing release");
  return {
    kind: "release",
    repo,
    action: getStr(payload, "action"),
    releaseId: getNum(release, "id"),
    tag: getStr(release, "tag_name"),
    name: getStr(release, "name"),
    draft: getBool(release, "draft"),
    prerelease: getBool(release, "prerelease"),
    htmlUrl: getStr(release, "html_url"),
  };
}

function parseWorkflowRun(
  repo: string,
  payload: Record<string, unknown>,
): WebhookEvent {
  const run = payload.workflow_run;
  if (!isObject(run)) return ignored("workflow_run: missing workflow_run");
  const prsRaw = run.pull_requests;
  const prNumbers: number[] = [];
  if (Array.isArray(prsRaw)) {
    for (const entry of prsRaw) {
      if (isObject(entry)) {
        const n = getNum(entry, "number");
        if (n > 0) prNumbers.push(n);
      }
    }
  }
  return {
    kind: "workflow_run",
    repo,
    action: getStr(payload, "action"),
    workflowId: getNum(run, "workflow_id"),
    runId: getNum(run, "id"),
    name: getStr(run, "name"),
    headSha: getStr(run, "head_sha"),
    headBranch: getStr(run, "head_branch"),
    status: getStr(run, "status"),
    conclusion: getOptStr(run, "conclusion"),
    runNumber: getNum(run, "run_number"),
    htmlUrl: getStr(run, "html_url"),
    prNumbers,
  };
}
