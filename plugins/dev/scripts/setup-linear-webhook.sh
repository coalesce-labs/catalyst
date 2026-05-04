#!/usr/bin/env bash
# setup-linear-webhook.sh — register a Linear webhook for orch-monitor (CTL-224).
#
# Reads Layer 1 .catalyst/config.json for catalyst.projectKey +
# catalyst.linear.teamId, and Layer 2 ~/.config/catalyst/config-<projectKey>.json
# for linear.apiToken. Issues GraphQL against Linear's API to:
#
#   1. List existing webhooks; if one matches the target URL (case-insensitive)
#      and --force is not set, no-op.
#   2. With --force, webhookDelete the matching one.
#   3. webhookCreate with the canonical 6 resourceTypes
#      (Issue, Comment, IssueLabel, Cycle, Reaction, Project).
#   4. Persist webhook.secret to ~/.config/catalyst/linear-webhook-secret
#      (mode 600), mirroring the GitHub-side webhook-secret file.
#   5. Print the `export ${SECRET_ENV}=...` line for the user's shell rc.
#
# Linear-side counterpart of webhookSubscriber.ensureSubscribed in
# plugins/dev/scripts/orch-monitor/lib/webhook-subscriber.ts. Auth pattern
# mirrors plugins/dev/scripts/resolve-linear-ids.sh (CTL-207).

set -uo pipefail

WEBHOOK_URL=""
FORCE=0
SECRET_ENV="CATALYST_LINEAR_WEBHOOK_SECRET"
CONFIG_PATH=".catalyst/config.json"
LABEL="Catalyst orch-monitor"
LINEAR_GRAPHQL_ENDPOINT="${LINEAR_GRAPHQL_ENDPOINT:-https://api.linear.app/graphql}"

usage() {
  cat <<EOF
Usage: $(basename "$0") --webhook-url <https-url> [--force]
                        [--secret-env <NAME>] [--config <path>]
                        [--label <text>]

Registers a Linear webhook idempotently for orch-monitor.

Required:
  --webhook-url <url>     Public HTTPS URL where Linear should deliver events
                          (e.g. https://your-tunnel/api/webhook/linear).

Optional:
  --force                 Delete existing matching webhook and recreate.
  --secret-env <NAME>     Env-var name printed in the export line.
                          Default: CATALYST_LINEAR_WEBHOOK_SECRET
  --config <path>         Layer 1 config path. Default: .catalyst/config.json
  --label <text>          Linear webhook label. Default: "Catalyst orch-monitor"

Reads Layer 2 secret from ~/.config/catalyst/config-<projectKey>.json
(.linear.apiToken).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --webhook-url)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "ERROR: --webhook-url requires a value" >&2; usage >&2; exit 1
      fi
      WEBHOOK_URL="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --secret-env)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "ERROR: --secret-env requires a value" >&2; exit 1
      fi
      SECRET_ENV="$2"; shift 2 ;;
    --config)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "ERROR: --config requires a value" >&2; exit 1
      fi
      CONFIG_PATH="$2"; shift 2 ;;
    --label)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "ERROR: --label requires a value" >&2; exit 1
      fi
      LABEL="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -z "$WEBHOOK_URL" ]]; then
  echo "ERROR: --webhook-url is required" >&2
  usage >&2
  exit 1
fi

if [[ ! "$WEBHOOK_URL" =~ ^https:// ]]; then
  echo "ERROR: --webhook-url must start with https:// (got: $WEBHOOK_URL)" >&2
  exit 1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: '$1' is required but not installed" >&2
    exit 1
  fi
}

require_cmd jq
require_cmd curl

# ─── Read Layer 1 (.catalyst/config.json) ──────────────────────────────────
if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "ERROR: $CONFIG_PATH not found" >&2
  exit 1
fi

PROJECT_KEY=$(jq -r '.catalyst.projectKey // empty' "$CONFIG_PATH" 2>/dev/null)
if [[ -z "$PROJECT_KEY" ]]; then
  echo "ERROR: catalyst.projectKey not set in $CONFIG_PATH" >&2
  exit 1
fi

TEAM_ID=$(jq -r '.catalyst.linear.teamId // empty' "$CONFIG_PATH" 2>/dev/null)
if [[ -z "$TEAM_ID" ]]; then
  echo "ERROR: catalyst.linear.teamId not set in $CONFIG_PATH." >&2
  echo "       Run plugins/dev/scripts/resolve-linear-ids.sh first to populate it." >&2
  exit 1
fi

# ─── Read Layer 2 secrets (~/.config/catalyst/config-<projectKey>.json) ────
HOME_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/catalyst"
SECRETS_PATH="${HOME_CONFIG_DIR}/config-${PROJECT_KEY}.json"
if [[ ! -f "$SECRETS_PATH" ]]; then
  echo "ERROR: Layer 2 secrets file not found at $SECRETS_PATH" >&2
  echo "       Add a 'linear.apiToken' field there (a personal API key from Linear)." >&2
  exit 1
fi

API_TOKEN=$(jq -r '.linear.apiToken // empty' "$SECRETS_PATH" 2>/dev/null)
if [[ -z "$API_TOKEN" ]]; then
  echo "ERROR: linear.apiToken not found in $SECRETS_PATH" >&2
  exit 1
fi

# ─── GraphQL helper ─────────────────────────────────────────────────────────
linear_graphql() {
  local query="$1"
  local variables="${2:-{\}}"
  local payload
  payload=$(jq -nc --arg q "$query" --argjson v "$variables" '{query:$q,variables:$v}')
  printf '%s' "$payload" | curl -s -X POST "$LINEAR_GRAPHQL_ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "Authorization: $API_TOKEN" \
    -d @-
}

surface_graphql_errors() {
  local resp="$1" stage="$2"
  local err
  err=$(printf '%s' "$resp" | jq -r '.errors[0].message // empty' 2>/dev/null)
  if [[ -n "$err" ]]; then
    echo "ERROR: Linear API error ($stage): $err" >&2
    exit 2
  fi
}

# ─── List existing webhooks ─────────────────────────────────────────────────
LIST_QUERY='query { webhooks { nodes { id url label enabled } } }'
LIST_RESP=$(linear_graphql "$LIST_QUERY" '{}' 2>&1) || {
  echo "ERROR: Linear API call (list webhooks) failed" >&2
  [[ -n "$LIST_RESP" ]] && echo "$LIST_RESP" >&2
  exit 2
}
surface_graphql_errors "$LIST_RESP" "list"

TARGET_URL_LC=$(printf '%s' "$WEBHOOK_URL" | tr '[:upper:]' '[:lower:]')
EXISTING_ID=$(printf '%s' "$LIST_RESP" | jq -r --arg url "$TARGET_URL_LC" \
  '.data.webhooks.nodes[]? | select((.url // "" | ascii_downcase) == $url) | .id' \
  2>/dev/null | head -1)

if [[ -n "$EXISTING_ID" && "$FORCE" -eq 0 ]]; then
  echo "Reusing existing webhook $EXISTING_ID for $WEBHOOK_URL"
  echo "  (use --force to delete and recreate; secret cannot be re-fetched)"
  exit 0
fi

# ─── Delete existing if --force ─────────────────────────────────────────────
if [[ -n "$EXISTING_ID" && "$FORCE" -eq 1 ]]; then
  echo "Deleting existing webhook $EXISTING_ID before recreating..."
  DEL_QUERY='mutation($id:String!){webhookDelete(id:$id){success}}'
  DEL_VARS=$(jq -nc --arg id "$EXISTING_ID" '{id:$id}')
  DEL_RESP=$(linear_graphql "$DEL_QUERY" "$DEL_VARS" 2>&1) || {
    echo "ERROR: Linear API call (delete) failed" >&2
    [[ -n "$DEL_RESP" ]] && echo "$DEL_RESP" >&2
    exit 2
  }
  surface_graphql_errors "$DEL_RESP" "delete"
fi

# ─── Create webhook ─────────────────────────────────────────────────────────
CREATE_QUERY='mutation($url:String!,$label:String!,$teamId:String!,$resourceTypes:[String!]!){webhookCreate(input:{url:$url,label:$label,teamId:$teamId,resourceTypes:$resourceTypes}){success,webhook{id,secret,enabled,url}}}'
CREATE_VARS=$(jq -nc \
  --arg url "$WEBHOOK_URL" \
  --arg label "$LABEL" \
  --arg teamId "$TEAM_ID" \
  '{url:$url,label:$label,teamId:$teamId,resourceTypes:["Issue","Comment","IssueLabel","Cycle","Reaction","Project"]}')

CREATE_RESP=$(linear_graphql "$CREATE_QUERY" "$CREATE_VARS" 2>&1) || {
  echo "ERROR: Linear API call (create) failed" >&2
  [[ -n "$CREATE_RESP" ]] && echo "$CREATE_RESP" >&2
  exit 2
}
surface_graphql_errors "$CREATE_RESP" "create"

SUCCESS=$(printf '%s' "$CREATE_RESP" | jq -r '.data.webhookCreate.success // false')
if [[ "$SUCCESS" != "true" ]]; then
  echo "ERROR: webhookCreate returned success=false" >&2
  echo "Response: $CREATE_RESP" >&2
  exit 2
fi

WEBHOOK_ID=$(printf '%s' "$CREATE_RESP" | jq -r '.data.webhookCreate.webhook.id')
SECRET=$(printf '%s' "$CREATE_RESP" | jq -r '.data.webhookCreate.webhook.secret')

if [[ -z "$WEBHOOK_ID" || "$WEBHOOK_ID" == "null" \
   || -z "$SECRET" || "$SECRET" == "null" ]]; then
  echo "ERROR: webhookCreate response missing id/secret fields" >&2
  echo "Response: $CREATE_RESP" >&2
  exit 2
fi

# ─── Persist secret ─────────────────────────────────────────────────────────
mkdir -p "$HOME_CONFIG_DIR"
SECRET_FILE="${HOME_CONFIG_DIR}/linear-webhook-secret"
( umask 077; printf '%s\n' "$SECRET" > "$SECRET_FILE" )
chmod 600 "$SECRET_FILE"

# ─── Print summary + export instruction ────────────────────────────────────
cat <<EOF
Created Linear webhook $WEBHOOK_ID for $WEBHOOK_URL
  Resource types: Issue, Comment, IssueLabel, Cycle, Reaction, Project
  Secret: persisted to $SECRET_FILE (mode 600)

Export the secret in your shell (and add to your ~/.zshrc / ~/.bashrc):

  export ${SECRET_ENV}="\$(cat $SECRET_FILE)"

Then restart orch-monitor — it will accept Linear deliveries at /api/webhook/linear.
EOF
