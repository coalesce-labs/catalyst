#!/usr/bin/env bash
# setup-linear-webhook.sh — register/deregister a Linear webhook for orch-monitor.
#
# CTL-224 introduced the GraphQL plumbing. CTL-238 added Layer 2 record
# persistence: after webhookCreate succeeds, the helper writes
# catalyst.monitor.linear.{webhookId,smeeChannel,registeredAt,resourceTypes}
# to ~/.config/catalyst/config.json so re-runs decide idempotency locally and
# --deregister has a clean handle to call webhookDelete with.
#
# CTL-274: the URL field is `smeeChannel` (matches what every consumer reads —
# orch-monitor's webhook-config.ts and the sibling setup-webhooks.sh). Legacy
# records written by earlier versions used `webhookUrl`; read paths fall back
# to that key for back-compat and write paths migrate it on the next write.
#
# Reads Layer 1 .catalyst/config.json for catalyst.projectKey + catalyst.linear.teamId,
# and Layer 2 ~/.config/catalyst/config-<projectKey>.json for linear.apiToken.
#
# Linear-side counterpart of webhookSubscriber.ensureSubscribed in
# plugins/dev/scripts/orch-monitor/lib/webhook-subscriber.ts. Auth pattern
# mirrors plugins/dev/scripts/resolve-linear-ids.sh (CTL-207).

set -uo pipefail

WEBHOOK_URL=""
FORCE=0
DEREGISTER=0
ALL_PUBLIC_TEAMS=0
SECRET_ENV="CATALYST_LINEAR_WEBHOOK_SECRET"
CONFIG_PATH=".catalyst/config.json"
LABEL="Catalyst orch-monitor"
LINEAR_GRAPHQL_ENDPOINT="${LINEAR_GRAPHQL_ENDPOINT:-https://api.linear.app/graphql}"

# Canonical Linear resource types — matches the receiver in
# plugins/dev/scripts/orch-monitor/lib/linear-webhook-handler.ts.
RESOURCE_TYPES=("Issue" "Comment" "IssueLabel" "Cycle" "Reaction" "Project")

usage() {
  cat <<EOF
Usage: $(basename "$0") --webhook-url <https-url> [--force] [--all-public-teams]
                        [--secret-env <NAME>] [--config <path>]
                        [--label <text>]
       $(basename "$0") --deregister [--all-public-teams] [--config <path>]

Registers (or deregisters) a Linear webhook idempotently for orch-monitor.

Register:
  --webhook-url <url>     Public HTTPS URL where Linear should deliver events
                          (e.g. https://your-tunnel/api/webhook/linear).
  --force                 Delete existing webhook and recreate.
  --all-public-teams      Register a workspace-wide webhook (scoped to all
                          public teams in the workspace) instead of a
                          single-team webhook. Stored separately in Layer 2,
                          allowing both to coexist. Warn if conflict detected.

Deregister:
  --deregister            Read the webhookId from the Layer 2 record, call
                          webhookDelete, clear the record, remove the local
                          secret file.
  --all-public-teams      When deregistering, remove the workspace-wide
                          webhook (if present) instead of a single-team webhook.

Common options:
  --secret-env <NAME>     Env-var name printed in the export line.
                          Default: CATALYST_LINEAR_WEBHOOK_SECRET
  --config <path>         Layer 1 config path. Default: .catalyst/config.json
  --label <text>          Linear webhook label. Default: "Catalyst orch-monitor"

Reads Layer 2 secret from ~/.config/catalyst/config-<projectKey>.json
(.linear.apiToken). On register success, writes the registration record
to ~/.config/catalyst/config.json under catalyst.monitor.linear.
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
    --deregister) DEREGISTER=1; shift ;;
    --all-public-teams) ALL_PUBLIC_TEAMS=1; shift ;;
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

if [[ $DEREGISTER -eq 0 && -z "$WEBHOOK_URL" ]]; then
  echo "ERROR: --webhook-url is required (or pass --deregister)" >&2
  usage >&2
  exit 1
fi
if [[ $DEREGISTER -eq 1 && -n "$WEBHOOK_URL" ]]; then
  echo "ERROR: --deregister and --webhook-url are mutually exclusive" >&2
  exit 1
fi

if [[ -n "$WEBHOOK_URL" && ! "$WEBHOOK_URL" =~ ^https:// ]]; then
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

# Layer 2 paths.
HOME_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/catalyst"
HOME_CONFIG_PATH="${HOME_CONFIG_DIR}/config.json"
SECRETS_PATH="${HOME_CONFIG_DIR}/config-${PROJECT_KEY}.json"
SECRET_FILE="${HOME_CONFIG_DIR}/linear-webhook-secret"

# ─── Layer 2 record helpers (CTL-238) ──────────────────────────────────────

# Read the Linear registration record from Layer 2 (~/.config/catalyst/config.json).
# Accepts optional $1 = key (e.g. "workspace" or team UUID). Outputs compact JSON
# or empty string when no usable record exists.
#
# Backward compatibility: If catalyst.monitor.linear is a single object (pre-keyed
# format), treat it as if it were keyed under "workspace".
#
# A "usable" record requires non-empty webhookId AND a non-empty URL field — either
# the canonical `smeeChannel` (CTL-274) or the legacy `webhookUrl`. The returned
# object is normalized to always have `.smeeChannel` populated.
read_linear_record() {
  local key="${1:-workspace}"
  [[ -f "$HOME_CONFIG_PATH" ]] || { echo ""; return 0; }
  jq -c --arg key "$key" '
    (.catalyst.monitor.linear // {}) as $linear
    | (if ($linear | type) == "object" and ($linear.webhookId // "") != ""
        then
          # Single object format (backward compat) — treat as "workspace" key
          (if $key == "workspace" then $linear else empty end)
        else
          # Keyed object format — lookup by key
          ($linear[$key] // {})
        end) as $r
    | (($r.smeeChannel // "") | tostring) as $canon
    | (($r.webhookUrl  // "") | tostring) as $legacy
    | (if $canon != "" then $canon else $legacy end) as $url
    | if (($r.webhookId // "") != "") and ($url != "")
      then $r | .smeeChannel = $url
      else empty
      end
  ' "$HOME_CONFIG_PATH" 2>/dev/null
}

# Write the registration record to a keyed location in Layer 2. Supports multi-team
# setup: records are stored under catalyst.monitor.linear[$key], where $key is
# typically "workspace" or a team UUID.
#
# Arguments:
#   $1: key (e.g. "workspace" or team UUID)
#   $2: webhook_id
#   $3: webhook_url
#   $4: resource_types_json (JSON array string)
#
# Backward compatibility: If the file currently has a single-object format,
# migrate it to keyed format. On write, always use keyed format.
write_linear_record() {
  local key="$1" webhook_id="$2" webhook_url="$3" resource_types_json="$4"
  local timestamp; timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$HOME_CONFIG_DIR"
  [[ -f "$HOME_CONFIG_PATH" ]] || echo "{}" > "$HOME_CONFIG_PATH"
  local tmp; tmp=$(mktemp)
  jq --arg key "$key" --arg id "$webhook_id" --arg url "$webhook_url" \
     --arg ts "$timestamp" --argjson rt "$resource_types_json" '
       .catalyst //= {}
       | .catalyst.monitor //= {}
       | .catalyst.monitor.linear //= {}
       | (if (.catalyst.monitor.linear | type) == "object" and
              (.catalyst.monitor.linear.webhookId // "") != ""
         then
           # Migrate single-object format to keyed object
           {"workspace": .catalyst.monitor.linear}
         else
           # Already keyed or empty
           (.catalyst.monitor.linear | if type == "object" then . else {} end)
         end) as $linear
       | .catalyst.monitor.linear = ($linear + {
           ($key): {
             webhookId: $id,
             smeeChannel: $url,
             registeredAt: $ts
           } + (if ($rt | length) > 0 then {resourceTypes: $rt} else {} end)
         })
     ' "$HOME_CONFIG_PATH" > "$tmp"
  mv "$tmp" "$HOME_CONFIG_PATH"
}

# Clear a specific Linear registration record key from the Layer 2 keyed object.
# Accepts optional $1 = key (default "workspace"). Deletes only that key,
# preserving other team records.
#
# Arguments:
#   $1: key to delete (optional, default "workspace")
clear_linear_record() {
  local key="${1:-workspace}"
  [[ -f "$HOME_CONFIG_PATH" ]] || return 0
  local tmp; tmp=$(mktemp)
  jq --arg key "$key" '
    if (.catalyst.monitor.linear // null) != null
    then
      .catalyst.monitor.linear |= del(.[$key])
      | if (.catalyst.monitor.linear // {}) == {} then del(.catalyst.monitor.linear) else . end
      | if (.catalyst.monitor // {}) == {} then del(.catalyst.monitor) else . end
      | if (.catalyst // {}) == {} then del(.catalyst) else . end
    else .
    end
  ' "$HOME_CONFIG_PATH" > "$tmp"
  mv "$tmp" "$HOME_CONFIG_PATH"
}

# Detect conflicts between workspace-wide and per-team webhooks.
# Warns if:
#   - Registering workspace webhook but per-team webhooks exist
#   - Registering per-team webhook but workspace webhook exists
#
# Arguments:
#   $1: key being registered ("workspace" or team UUID)
detect_webhook_conflicts() {
  local key="$1"
  [[ -f "$HOME_CONFIG_PATH" ]] || return 0

  # Get all registered keys (skip if linear config doesn't exist or is single object)
  local registered_keys
  registered_keys=$(jq -r '
    (.catalyst.monitor.linear // {}) as $linear
    | if ($linear | type) == "object" and ($linear.webhookId // "") != ""
      then
        # Single object format — this is the legacy "workspace"
        "workspace"
      else
        # Keyed format — list all keys
        ($linear | keys[]? // empty)
      end
  ' "$HOME_CONFIG_PATH" 2>/dev/null)

  if [[ -z "$registered_keys" ]]; then
    return 0
  fi

  if [[ "$key" == "workspace" ]]; then
    # Registering workspace webhook — warn if per-team webhooks exist
    for registered_key in $registered_keys; do
      if [[ "$registered_key" != "workspace" ]]; then
        echo "⚠️  WARNING: Per-team webhook already registered ($registered_key)" >&2
        echo "   Workspace-wide webhook will coexist with per-team webhooks." >&2
        echo "   Linear events will reach both webhooks." >&2
        return 0
      fi
    done
  else
    # Registering per-team webhook — warn if workspace webhook exists
    for registered_key in $registered_keys; do
      if [[ "$registered_key" == "workspace" ]]; then
        echo "⚠️  WARNING: Workspace-wide webhook already registered" >&2
        echo "   This per-team webhook will coexist with the workspace webhook." >&2
        echo "   Events for team $key will reach both webhooks." >&2
        return 0
      fi
    done
  fi
}

# ─── Linear API auth + GraphQL helpers ─────────────────────────────────────
# Lazy: we only require curl and the API token when we actually need to make
# a call. The Layer 2 short-circuit on register and the deregister-with-no-
# record path both exit before reaching this point.
load_api_token() {
  require_cmd curl
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
}

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

delete_via_graphql() {
  local id="$1"
  # $id below is a GraphQL variable inside a single-quoted query, not a shell var.
  # shellcheck disable=SC2016
  local query='mutation($id:String!){webhookDelete(id:$id){success}}'
  local vars; vars=$(jq -nc --arg id "$id" '{id:$id}')
  local resp; resp=$(linear_graphql "$query" "$vars" 2>&1) || {
    echo "ERROR: Linear API call (delete) failed" >&2
    [[ -n "$resp" ]] && echo "$resp" >&2
    exit 2
  }
  surface_graphql_errors "$resp" "delete"
  local success; success=$(printf '%s' "$resp" | jq -r '.data.webhookDelete.success // false')
  if [[ "$success" != "true" ]]; then
    echo "ERROR: webhookDelete returned success=false" >&2
    echo "Response: $resp" >&2
    exit 2
  fi
}

# ─── --deregister branch ───────────────────────────────────────────────────
if [[ $DEREGISTER -eq 1 ]]; then
  DEREGISTER_KEY="workspace"
  if [[ $ALL_PUBLIC_TEAMS -eq 0 ]]; then
    # Deregister per-team webhook — need teamId
    TEAM_ID=$(jq -r '.catalyst.linear.teamId // empty' "$CONFIG_PATH" 2>/dev/null)
    if [[ -z "$TEAM_ID" ]]; then
      echo "ERROR: catalyst.linear.teamId not set in $CONFIG_PATH" >&2
      echo "       To deregister a per-team webhook, set it first." >&2
      echo "       To deregister the workspace webhook, use: $0 --deregister --all-public-teams" >&2
      exit 1
    fi
    DEREGISTER_KEY="$TEAM_ID"
  fi

  EXISTING_RECORD="$(read_linear_record "$DEREGISTER_KEY")"
  if [[ -z "$EXISTING_RECORD" ]]; then
    echo "ERROR: no Linear webhook record found for key '$DEREGISTER_KEY' in $HOME_CONFIG_PATH" >&2
    echo "       Nothing to deregister." >&2
    exit 1
  fi
  RECORD_ID=$(printf '%s' "$EXISTING_RECORD" | jq -r '.webhookId')
  RECORD_URL=$(printf '%s' "$EXISTING_RECORD" | jq -r '.smeeChannel')
  load_api_token
  delete_via_graphql "$RECORD_ID"
  clear_linear_record "$DEREGISTER_KEY"
  rm -f "$SECRET_FILE"
  echo "Deregistered Linear webhook ${RECORD_ID} (${RECORD_URL})"
  echo "Cleared Layer 2 record for key '$DEREGISTER_KEY' + removed ${SECRET_FILE}"
  exit 0
fi

# ─── --register branch ──────────────────────────────────────────────────────
# Determine the registration key and validate preconditions.
REGISTER_KEY="workspace"
TEAM_ID=""
if [[ $ALL_PUBLIC_TEAMS -eq 0 ]]; then
  # Per-team webhook — need teamId
  TEAM_ID=$(jq -r '.catalyst.linear.teamId // empty' "$CONFIG_PATH" 2>/dev/null)
  if [[ -z "$TEAM_ID" ]]; then
    echo "ERROR: catalyst.linear.teamId not set in $CONFIG_PATH." >&2
    echo "       Run plugins/dev/scripts/resolve-linear-ids.sh first to populate it." >&2
    echo "       Or use --all-public-teams to register a workspace-wide webhook." >&2
    exit 1
  fi
  REGISTER_KEY="$TEAM_ID"
fi

# Step 1 (CTL-238): Layer 2 short-circuit. When a record exists we know the
# webhookId locally — no need to call `webhooks { nodes }` to discover it.
LAYER2_HANDLED=0
EXISTING_RECORD="$(read_linear_record "$REGISTER_KEY")"
if [[ -n "$EXISTING_RECORD" ]]; then
  RECORD_URL=$(printf '%s' "$EXISTING_RECORD" | jq -r '.smeeChannel')
  RECORD_ID=$(printf '%s' "$EXISTING_RECORD" | jq -r '.webhookId')
  if [[ "$RECORD_URL" == "$WEBHOOK_URL" && "$FORCE" -eq 0 ]]; then
    echo "Webhook already registered (id=${RECORD_ID}, url=${RECORD_URL}); skipping."
    echo "  (use --force to delete and recreate; secret cannot be re-fetched)"
    exit 0
  fi
  if [[ "$RECORD_URL" != "$WEBHOOK_URL" && "$FORCE" -eq 0 ]]; then
    echo "ERROR: Layer 2 records a different webhook URL: ${RECORD_URL}" >&2
    echo "       Requested: ${WEBHOOK_URL}" >&2
    echo "       Use --force to delete the existing webhook and register the new URL." >&2
    exit 1
  fi
  # --force path (same URL or different URL): delete by stored ID, clear the
  # record, and skip the API list step — we already know the world.
  load_api_token
  if [[ "$RECORD_URL" == "$WEBHOOK_URL" ]]; then
    echo "Deleting existing webhook ${RECORD_ID} (force)..."
  else
    echo "Deleting existing webhook ${RECORD_ID} (different URL, force)..."
  fi
  delete_via_graphql "$RECORD_ID"
  clear_linear_record "$REGISTER_KEY"
  LAYER2_HANDLED=1
fi

# Detect conflicts before creating a new webhook
detect_webhook_conflicts "$REGISTER_KEY"

# Step 2: API-side dedup fallback. Runs only when no Layer 2 record was
# present — i.e., a fresh laptop, or a webhook registered manually before
# CTL-238 shipped. The --force path above sets LAYER2_HANDLED=1 to skip
# this; we already know the create call is what's needed.
if [[ "$LAYER2_HANDLED" -eq 0 ]]; then
  load_api_token

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
    # API found a matching webhook from a previous (manual) registration.
    # Reuse it. Write a partial Layer 2 record so future re-runs short-circuit
    # locally — resourceTypes are unknown from a list response, so the field
    # is omitted (we don't fabricate).
    echo "Reusing existing webhook $EXISTING_ID for $WEBHOOK_URL"
    echo "  (use --force to delete and recreate; secret cannot be re-fetched)"
    write_linear_record "$EXISTING_ID" "$WEBHOOK_URL" "[]"
    echo "Wrote Layer 2 record (partial — resourceTypes/secret not retrievable from list response)"
    exit 0
  fi

  if [[ -n "$EXISTING_ID" && "$FORCE" -eq 1 ]]; then
    echo "Deleting existing webhook $EXISTING_ID (API-discovered, force)..."
    delete_via_graphql "$EXISTING_ID"
  fi
fi

# Step 3: create.
# Choose mutation based on whether registering workspace or per-team webhook.
RESOURCE_TYPES_JSON=$(printf '%s\n' "${RESOURCE_TYPES[@]}" | jq -R . | jq -sc .)

if [[ $ALL_PUBLIC_TEAMS -eq 1 ]]; then
  # Workspace-wide webhook — use allPublicTeams: true instead of teamId.
  # shellcheck disable=SC2016
  CREATE_QUERY='mutation($url:String!,$label:String!,$resourceTypes:[String!]!){webhookCreate(input:{url:$url,label:$label,allPublicTeams:true,resourceTypes:$resourceTypes}){success,webhook{id,secret,enabled,url}}}'
  CREATE_VARS=$(jq -nc \
    --arg url "$WEBHOOK_URL" \
    --arg label "$LABEL" \
    --argjson resourceTypes "$RESOURCE_TYPES_JSON" \
    '{url:$url,label:$label,allPublicTeams:true,resourceTypes:$resourceTypes}')
else
  # Per-team webhook — use teamId.
  # shellcheck disable=SC2016
  CREATE_QUERY='mutation($url:String!,$label:String!,$teamId:String!,$resourceTypes:[String!]!){webhookCreate(input:{url:$url,label:$label,teamId:$teamId,resourceTypes:$resourceTypes}){success,webhook{id,secret,enabled,url}}}'
  CREATE_VARS=$(jq -nc \
    --arg url "$WEBHOOK_URL" \
    --arg label "$LABEL" \
    --arg teamId "$TEAM_ID" \
    --argjson resourceTypes "$RESOURCE_TYPES_JSON" \
    '{url:$url,label:$label,teamId:$teamId,resourceTypes:$resourceTypes}')
fi

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

# Persist secret (mode 600) — mirrors the GitHub side at ~/.config/catalyst/webhook-secret.
mkdir -p "$HOME_CONFIG_DIR"
( umask 077; printf '%s\n' "$SECRET" > "$SECRET_FILE" )
chmod 600 "$SECRET_FILE"

# Write the Layer 2 registration record (CTL-238).
write_linear_record "$REGISTER_KEY" "$WEBHOOK_ID" "$WEBHOOK_URL" "$RESOURCE_TYPES_JSON"

cat <<EOF
Created Linear webhook $WEBHOOK_ID for $WEBHOOK_URL
  Resource types: $(printf '%s, ' "${RESOURCE_TYPES[@]}" | sed 's/, $//')
  Secret: persisted to $SECRET_FILE (mode 600)
  Layer 2 record: $HOME_CONFIG_PATH (catalyst.monitor.linear)

Export the secret in your shell (and add to your ~/.zshrc / ~/.bashrc):

  export ${SECRET_ENV}="\$(cat $SECRET_FILE)"

Then restart orch-monitor — it will accept Linear deliveries at /api/webhook/linear.
EOF
