# Review Thread Resolution Workflow

Shared workflow for resolving GitHub review threads after addressing comments. Referenced by
`/review-comments` (Step 5) and the `unresolved-threads` blocker strategy in
`merge-blocker-diagnosis.md`.

## Step 1: Fetch Unresolved Review Threads

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
OWNER=$(echo "$REPO" | cut -d'/' -f1)
NAME=$(echo "$REPO" | cut -d'/' -f2)

gh api graphql -f query='
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { body author { login } path line }
          }
        }
      }
    }
  }
}' -f owner="$OWNER" -f name="$NAME" -F pr="$PR_NUMBER"
```

## Step 2: Resolve Each Addressed Thread

For each unresolved thread that was either fixed or replied to:

```bash
gh api graphql -f query='
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { isResolved }
  }
}' -f threadId="$THREAD_NODE_ID"
```

## Resolution Rules

| Outcome | Action |
|---------|--------|
| **Code change implemented** | Resolve the thread |
| **Reply posted** (disagreement or clarification) | Resolve the thread (reply is visible in the resolved thread; reviewer can re-open if they disagree) |
| **Approval / praise** | Already not blocking — skip |
| **Could not address** | Do NOT resolve — leave for human review |

## Step 3: Verify

```bash
UNRESOLVED=$(gh api graphql -f query='
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes { isResolved }
      }
    }
  }
}' -f owner="$OWNER" -f name="$NAME" -F pr="$PR_NUMBER" \
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length')

if [ "$UNRESOLVED" -gt 0 ]; then
  echo "$UNRESOLVED unresolved thread(s) remain — manual review needed"
fi
```
