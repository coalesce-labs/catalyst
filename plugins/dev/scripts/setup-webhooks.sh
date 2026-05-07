#!/usr/bin/env bash
# setup-webhooks.sh — idempotent one-shot setup for orch-monitor webhook delivery.
#
# What this script does:
#   1. Creates a fresh smee.io channel (or reuses one supplied via $CATALYST_SMEE_CHANNEL)
#   2. Generates a 32-byte HMAC secret
#   3. Writes catalyst.monitor.github.smeeChannel to ~/.config/catalyst/config.json
#      (cross-project, per-machine — one smee tunnel serves every project on this laptop)
#   4. Writes catalyst.monitor.github.webhookSecretEnv to .catalyst/config.json
#      (team-wide repo config — env-var NAME only, never the value)
#   5. Persists the secret to ~/.config/catalyst/webhook-secret with mode 600
#   6. Migrates a deprecated smeeChannel out of .catalyst/config.json if present
#   7. Optionally adds repos to catalyst.monitor.github.watchRepos (Layer 1) via
#      one or more --add-repo <owner/repo> flags. When ONLY --add-repo flags are
#      passed, the script skips steps 1–6 entirely (no smee channel mutation).
#
# Re-running is safe: the script never overwrites an existing channel
# unless --force is passed.

set -euo pipefail

PROJECT_CONFIG_PATH=".catalyst/config.json"
HOME_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/catalyst"
HOME_CONFIG_PATH="${HOME_CONFIG_DIR}/config.json"
SECRET_PATH="${HOME_CONFIG_DIR}/webhook-secret"
DEFAULT_SECRET_ENV="CATALYST_WEBHOOK_SECRET"
DEFAULT_LINEAR_SECRET_ENV="CATALYST_LINEAR_WEBHOOK_SECRET"
FORCE=0
ADD_REPOS=()
LINEAR_SECRET_ENV=""
LINEAR_REGISTER=0
LINEAR_DEREGISTER=0
LINEAR_ALL_PUBLIC_TEAMS=0
LINEAR_WEBHOOK_URL=""
REGISTER_GITHUB_HOOKS=0
REPO_SHAPE='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
ENV_VAR_SHAPE='^[A-Z_][A-Z0-9_]*$'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# GitHub events the orch-monitor daemon subscribes to at startup. The bash
# verifier mirrors this list so hooks registered here match what the daemon
# would otherwise create on first observation. Source of truth:
# plugins/dev/scripts/orch-monitor/lib/webhook-subscriber.ts (DEFAULT_WEBHOOK_EVENTS).
WEBHOOK_EVENTS=(
  pull_request
  pull_request_review
  pull_request_review_thread
  pull_request_review_comment
  check_suite
  status
  push
  issue_comment
  deployment
  deployment_status
)

usage() {
  cat <<EOF
Usage: $(basename "$0") [--force] [--add-repo owner/repo ...]

Sets up webhook delivery for orch-monitor:
  • Creates a smee.io channel
  • Generates an HMAC secret
  • Writes channel URL to ${HOME_CONFIG_PATH} (cross-project, per-machine)
  • Writes env-var name to ${PROJECT_CONFIG_PATH} (team-wide repo config)
  • Persists the secret to ${SECRET_PATH} (mode 600)

Options:
  --force                    Overwrite existing channel/secret if already configured
  --add-repo <owner/repo>    Add a repo to catalyst.monitor.github.watchRepos in
                             ${PROJECT_CONFIG_PATH}. Repeatable. When this is the
                             only intent flag, channel/secret setup is skipped.
  --linear-secret-env <NAME> Write catalyst.monitor.linear.webhookSecretEnv = NAME
                             to ${PROJECT_CONFIG_PATH}. Default ${DEFAULT_LINEAR_SECRET_ENV}.
                             When this is the only intent flag, channel/secret
                             setup for GitHub is skipped.
  --linear-register          Auto-register a Linear webhook via Linear's
                             GraphQL API (requires --webhook-url). Idempotent:
                             re-running with the same URL no-ops based on the
                             local Layer 2 record. Combine with --force to
                             delete and recreate. When this is the only intent
                             flag, channel/secret setup for GitHub is skipped.
  --linear-all-public-teams  When used with --linear-register, register a
                             workspace-wide webhook (allPublicTeams: true)
                             instead of a single-team webhook. Allows both
                             workspace and per-team webhooks to coexist.
  --linear-deregister        Delete the Linear webhook recorded in Layer 2 and
                             clear the local record + secret file. When this
                             is the only intent flag, channel/secret setup for
                             GitHub is skipped.
  --linear-all-public-teams  When used with --linear-deregister, remove the
                             workspace-wide webhook instead of a per-team one.
  --webhook-url <https-url>  Public HTTPS URL where Linear should deliver
                             events. When omitted with --linear-register, a
                             new smee.io channel is auto-provisioned and the
                             URL is written to ${HOME_CONFIG_PATH}. CTL-242.
  --register-github-hooks    For each repo in catalyst.monitor.github.watchRepos,
                             POST a webhook to the GitHub API if one pointing at
                             the smee channel does not already exist. Off by
                             default — without this flag the script only reports
                             registration status. Requires \`gh\` to be installed
                             and authenticated with admin access to each repo.
  -h|--help                  Show this message

Environment:
  CATALYST_SMEE_CHANNEL  Reuse this smee URL instead of generating one
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --add-repo)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "ERROR: --add-repo requires an argument" >&2
        usage
        exit 1
      fi
      ADD_REPOS+=("$2")
      shift 2
      ;;
    --linear-secret-env)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "ERROR: --linear-secret-env requires an argument" >&2
        usage
        exit 1
      fi
      LINEAR_SECRET_ENV="$2"
      shift 2
      ;;
    --linear-register) LINEAR_REGISTER=1; shift ;;
    --linear-deregister) LINEAR_DEREGISTER=1; shift ;;
    --linear-all-public-teams) LINEAR_ALL_PUBLIC_TEAMS=1; shift ;;
    --webhook-url)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "ERROR: --webhook-url requires an argument" >&2
        usage
        exit 1
      fi
      LINEAR_WEBHOOK_URL="$2"
      shift 2
      ;;
    --register-github-hooks) REGISTER_GITHUB_HOOKS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

# Validate --add-repo arguments before doing any work so a typo doesn't leave
# the config in a half-modified state.
for repo in "${ADD_REPOS[@]}"; do
  if [[ ! "$repo" =~ $REPO_SHAPE ]]; then
    echo "ERROR: --add-repo value '$repo' must match owner/repo (e.g. coalesce-labs/catalyst)" >&2
    exit 1
  fi
done

# Validate --linear-secret-env name shape (env-var conventions: uppercase,
# alphanumeric, underscores, must not start with a digit).
if [[ -n "$LINEAR_SECRET_ENV" ]]; then
  if [[ ! "$LINEAR_SECRET_ENV" =~ $ENV_VAR_SHAPE ]]; then
    echo "ERROR: --linear-secret-env value '$LINEAR_SECRET_ENV' must be a valid env-var name (uppercase letters, digits, underscores; cannot start with a digit)" >&2
    exit 1
  fi
fi

# Validate Linear flag combinations (CTL-238).
if [[ $LINEAR_REGISTER -eq 1 && $LINEAR_DEREGISTER -eq 1 ]]; then
  echo "ERROR: --linear-register and --linear-deregister are mutually exclusive" >&2
  exit 1
fi
if [[ $LINEAR_DEREGISTER -eq 1 && -n "$LINEAR_WEBHOOK_URL" ]]; then
  echo "ERROR: --linear-deregister and --webhook-url are mutually exclusive" >&2
  exit 1
fi
if [[ -n "$LINEAR_WEBHOOK_URL" && ! "$LINEAR_WEBHOOK_URL" =~ ^https:// ]]; then
  echo "ERROR: --webhook-url must start with https:// (got: $LINEAR_WEBHOOK_URL)" >&2
  exit 1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: '$1' is required but not installed" >&2
    exit 1
  fi
}

require_cmd jq

# Short-circuit when --add-repo and/or --linear-secret-env are the only intent
# flags. The user is asking to update Layer 1 config, not (re)provision
# channel/secret — which means we don't need curl/openssl and we never call
# out to the network. Channel setup is a separate user action; the daemon
# tolerates a missing channel.
SKIP_GITHUB_SETUP=0
if [[ $FORCE -eq 0 && -z "${CATALYST_SMEE_CHANNEL:-}" ]]; then
  if [[ ${#ADD_REPOS[@]} -gt 0 || -n "$LINEAR_SECRET_ENV" \
        || $LINEAR_REGISTER -eq 1 || $LINEAR_DEREGISTER -eq 1 ]]; then
    SKIP_GITHUB_SETUP=1
  fi
fi
ADD_REPO_ONLY=$SKIP_GITHUB_SETUP

# --linear-register without --webhook-url auto-provisions a smee channel (CTL-242)
# and needs curl. --linear-deregister only does GraphQL + local file ops (no curl).
LINEAR_NEEDS_SMEE=0
if [[ $LINEAR_REGISTER -eq 1 && -z "$LINEAR_WEBHOOK_URL" ]]; then
  LINEAR_NEEDS_SMEE=1
fi

if [[ $ADD_REPO_ONLY -eq 0 || $LINEAR_NEEDS_SMEE -eq 1 ]]; then
  require_cmd curl
fi
if [[ $ADD_REPO_ONLY -eq 0 ]]; then
  require_cmd openssl
fi

# Provision (or reuse) a Linear smee.io channel and write it to Layer 2.
# Sets LINEAR_WEBHOOK_URL to the resulting URL. CTL-242.
provision_linear_smee_channel() {
  mkdir -p "$HOME_CONFIG_DIR"
  if [[ ! -f "$HOME_CONFIG_PATH" ]]; then
    echo "{}" > "$HOME_CONFIG_PATH"
  fi

  local existing_linear_channel
  existing_linear_channel=$(jq -r '.catalyst.monitor.linear.smeeChannel // ""' "$HOME_CONFIG_PATH" 2>/dev/null || true)

  if [[ -n "$existing_linear_channel" && $FORCE -eq 0 ]]; then
    echo "Reusing existing Linear smee channel from $HOME_CONFIG_PATH: $existing_linear_channel (use --force to regenerate)"
    LINEAR_WEBHOOK_URL="$existing_linear_channel"
    return 0
  fi

  echo "Creating new Linear smee.io channel..."
  local new_channel
  new_channel=$(curl -s -L -o /dev/null -w "%{url_effective}" https://smee.io/new)
  if [[ -z "$new_channel" || "$new_channel" != https://smee.io/* || "$new_channel" == "https://smee.io/new" ]]; then
    echo "ERROR: failed to create Linear smee channel (got: $new_channel)" >&2
    exit 1
  fi
  echo "Created Linear smee channel: $new_channel"

  local tmp; tmp=$(mktemp)
  jq --arg channel "$new_channel" '
    .catalyst //= {}
    | .catalyst.monitor //= {}
    | .catalyst.monitor.linear //= {}
    | .catalyst.monitor.linear.smeeChannel = $channel
  ' "$HOME_CONFIG_PATH" > "$tmp"
  mv "$tmp" "$HOME_CONFIG_PATH"
  echo "Wrote catalyst.monitor.linear.smeeChannel to $HOME_CONFIG_PATH"
  LINEAR_WEBHOOK_URL="$new_channel"
}

# Merge an array of new repos into .catalyst.monitor.github.watchRepos in the
# project config, deduping while preserving insertion order. Creates parent
# objects as needed.
merge_watch_repos() {
  local repos_json="$1"
  mkdir -p "$(dirname "$PROJECT_CONFIG_PATH")"
  if [[ ! -f "$PROJECT_CONFIG_PATH" ]]; then
    echo "{}" > "$PROJECT_CONFIG_PATH"
  fi
  local tmp; tmp=$(mktemp)
  jq --argjson new "$repos_json" '
    def dedup_preserve_order:
      reduce .[] as $x ([]; if any(.[]; . == $x) then . else . + [$x] end);
    .catalyst //= {} |
    .catalyst.monitor //= {} |
    .catalyst.monitor.github //= {} |
    .catalyst.monitor.github.watchRepos =
      (((.catalyst.monitor.github.watchRepos // []) + $new) | dedup_preserve_order)
  ' "$PROJECT_CONFIG_PATH" > "$tmp"
  mv "$tmp" "$PROJECT_CONFIG_PATH"
}

# Write catalyst.monitor.linear.webhookSecretEnv to the project config (Layer 1).
# Mirrors the GitHub webhookSecretEnv pattern — env-var NAME only, never the
# value. CTL-210.
write_linear_secret_env() {
  local env_name="$1"
  mkdir -p "$(dirname "$PROJECT_CONFIG_PATH")"
  if [[ ! -f "$PROJECT_CONFIG_PATH" ]]; then
    echo "{}" > "$PROJECT_CONFIG_PATH"
  fi
  local tmp; tmp=$(mktemp)
  jq --arg env_name "$env_name" '
    .catalyst //= {} |
    .catalyst.monitor //= {} |
    .catalyst.monitor.linear //= {} |
    .catalyst.monitor.linear.webhookSecretEnv = $env_name
  ' "$PROJECT_CONFIG_PATH" > "$tmp"
  mv "$tmp" "$PROJECT_CONFIG_PATH"
}

# Verify (and optionally register) a GitHub webhook on `repo` that delivers to
# `channel`. Idempotent: if a hook with config.url == channel already exists,
# the function reports it and exits without POSTing. CTL-254.
#
# Arguments:
#   $1 — owner/repo
#   $2 — smee channel URL
#   $3 — HMAC secret (only consulted on POST; pass empty string to register
#        without one, e.g. when called for a status-only check)
#
# Globals:
#   REGISTER_GITHUB_HOOKS — 1 to POST when missing, 0 to only warn
#   WEBHOOK_EVENTS        — array of event names to subscribe (POST path only)
verify_github_hook() {
  local repo="$1" channel="$2" secret="$3"
  local hooks_json existing
  if ! hooks_json=$(gh api "repos/${repo}/hooks" 2>&1); then
    echo "  ⚠ ${repo}: could not list hooks (gh not authenticated, or no admin access)"
    echo "    ${hooks_json}" | sed 's/^/      /'
    return 0
  fi
  existing=$(jq -r --arg ch "$channel" \
    '[.[] | select(.config.url == $ch)] | length' <<<"$hooks_json" 2>/dev/null || echo "0")
  if [[ "$existing" != "0" ]]; then
    echo "  ✓ ${repo}: webhook already registered (${channel})"
    return 0
  fi
  if [[ $REGISTER_GITHUB_HOOKS -eq 0 ]]; then
    echo "  ⚠ ${repo}: no webhook registered for ${channel}"
    echo "    Register with: $(basename "$0") --register-github-hooks"
    return 0
  fi
  # POST a new hook. Mirror the events list used by the runtime daemon.
  local args=(api -X POST "repos/${repo}/hooks"
    -f name=web
    -F active=true
    -f "config[url]=${channel}"
    -f "config[content_type]=json")
  if [[ -n "$secret" ]]; then
    args+=(-f "config[secret]=${secret}")
  fi
  local evt
  for evt in "${WEBHOOK_EVENTS[@]}"; do
    args+=(-f "events[]=${evt}")
  done
  local err_file; err_file=$(mktemp)
  if gh "${args[@]}" >/dev/null 2>"$err_file"; then
    echo "  ✓ ${repo}: webhook registered (${channel})"
  else
    echo "  ✗ ${repo}: failed to register webhook"
    sed 's/^/      /' "$err_file" 2>/dev/null || true
  fi
  rm -f "$err_file"
}

if [[ $SKIP_GITHUB_SETUP -eq 1 ]]; then
  if [[ ${#ADD_REPOS[@]} -gt 0 ]]; then
    repos_json=$(printf '%s\n' "${ADD_REPOS[@]}" | jq -R . | jq -s .)
    merge_watch_repos "$repos_json"
    echo "Added ${#ADD_REPOS[@]} repo(s) to catalyst.monitor.github.watchRepos in $PROJECT_CONFIG_PATH"
    jq -r '.catalyst.monitor.github.watchRepos[]' "$PROJECT_CONFIG_PATH" \
      | sed 's/^/  • /'
  fi
  if [[ -n "$LINEAR_SECRET_ENV" ]]; then
    write_linear_secret_env "$LINEAR_SECRET_ENV"
    echo "Wrote catalyst.monitor.linear.webhookSecretEnv = $LINEAR_SECRET_ENV to $PROJECT_CONFIG_PATH"
    if [[ $LINEAR_REGISTER -eq 0 && $LINEAR_DEREGISTER -eq 0 ]]; then
      echo "  → Set the secret with: export $LINEAR_SECRET_ENV=<your-linear-webhook-signing-secret>"
      echo "  → Then run with --linear-register --webhook-url <url> to auto-register the webhook,"
      echo "    or see website/src/content/docs/observability/webhooks.md for manual registration."
    fi
  fi
  if [[ $LINEAR_REGISTER -eq 1 ]]; then
    if [[ -z "$LINEAR_WEBHOOK_URL" ]]; then
      provision_linear_smee_channel
    fi
    helper_secret_env="${LINEAR_SECRET_ENV:-$DEFAULT_LINEAR_SECRET_ENV}"
    helper_args=(
      --webhook-url "$LINEAR_WEBHOOK_URL"
      --secret-env "$helper_secret_env"
      --config "$PROJECT_CONFIG_PATH"
    )
    [[ $FORCE -eq 1 ]] && helper_args+=(--force)
    [[ $LINEAR_ALL_PUBLIC_TEAMS -eq 1 ]] && helper_args+=(--all-public-teams)
    bash "${SCRIPT_DIR}/setup-linear-webhook.sh" "${helper_args[@]}"
  elif [[ $LINEAR_DEREGISTER -eq 1 ]]; then
    deregister_args=(--deregister --config "$PROJECT_CONFIG_PATH")
    [[ $LINEAR_ALL_PUBLIC_TEAMS -eq 1 ]] && deregister_args+=(--all-public-teams)
    bash "${SCRIPT_DIR}/setup-linear-webhook.sh" "${deregister_args[@]}"
  fi
  exit 0
fi

read_smee_channel_from() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  jq -r '.catalyst.monitor.github.smeeChannel // ""' "$path" 2>/dev/null || true
}

# ─── 1. Determine smee channel ─────────────────────────────────────────────
existing_home_channel=$(read_smee_channel_from "$HOME_CONFIG_PATH")
existing_project_channel=$(read_smee_channel_from "$PROJECT_CONFIG_PATH")

if [[ -n "${CATALYST_SMEE_CHANNEL:-}" ]]; then
  channel="$CATALYST_SMEE_CHANNEL"
  echo "Using channel from CATALYST_SMEE_CHANNEL: $channel"
elif [[ -n "$existing_home_channel" && $FORCE -eq 0 ]]; then
  channel="$existing_home_channel"
  echo "Reusing existing channel from $HOME_CONFIG_PATH: $channel (use --force to regenerate)"
elif [[ -n "$existing_project_channel" && $FORCE -eq 0 ]]; then
  # Migrate deprecated location.
  channel="$existing_project_channel"
  echo "Found deprecated smeeChannel in $PROJECT_CONFIG_PATH — migrating to $HOME_CONFIG_PATH"
else
  echo "Creating new smee.io channel..."
  # smee.io/new responds with HTTP 307 to GET (not POST). Follow the redirect
  # with -L and capture the final URL via %{url_effective}.
  channel=$(curl -s -L -o /dev/null -w "%{url_effective}" https://smee.io/new)
  if [[ -z "$channel" || "$channel" != https://smee.io/* || "$channel" == "https://smee.io/new" ]]; then
    echo "ERROR: failed to create smee channel (got: $channel)" >&2
    exit 1
  fi
  echo "  → $channel"
fi

# ─── 2. Generate or reuse secret ───────────────────────────────────────────
mkdir -p "$HOME_CONFIG_DIR"
if [[ -f "$SECRET_PATH" && $FORCE -eq 0 ]]; then
  echo "Reusing existing secret at $SECRET_PATH (use --force to regenerate)"
else
  secret=$(openssl rand -hex 32)
  ( umask 077; echo "$secret" > "$SECRET_PATH" )
  chmod 600 "$SECRET_PATH"
  echo "Wrote new HMAC secret to $SECRET_PATH (mode 600)"
fi

# ─── 3. Write smeeChannel to cross-project home-dir config ────────────────
if [[ ! -f "$HOME_CONFIG_PATH" ]]; then
  echo "{}" > "$HOME_CONFIG_PATH"
fi
tmp=$(mktemp)
jq --arg channel "$channel" \
  '
    .catalyst //= {}
    | .catalyst.monitor //= {}
    | .catalyst.monitor.github //= {}
    | .catalyst.monitor.github.smeeChannel = $channel
  ' "$HOME_CONFIG_PATH" > "$tmp"
mv "$tmp" "$HOME_CONFIG_PATH"
echo "Updated $HOME_CONFIG_PATH"

# ─── 4. Write webhookSecretEnv to per-repo project config ─────────────────
mkdir -p "$(dirname "$PROJECT_CONFIG_PATH")"
if [[ ! -f "$PROJECT_CONFIG_PATH" ]]; then
  echo "{}" > "$PROJECT_CONFIG_PATH"
fi
tmp=$(mktemp)
jq --arg secret_env "$DEFAULT_SECRET_ENV" \
  '
    .catalyst //= {}
    | .catalyst.monitor //= {}
    | .catalyst.monitor.github //= {}
    | .catalyst.monitor.github.webhookSecretEnv = $secret_env
  ' "$PROJECT_CONFIG_PATH" > "$tmp"
mv "$tmp" "$PROJECT_CONFIG_PATH"
echo "Updated $PROJECT_CONFIG_PATH"

# ─── 5. Migrate: drop deprecated smeeChannel from project config ───────────
if [[ -n "$existing_project_channel" ]]; then
  tmp=$(mktemp)
  jq '
    del(.catalyst.monitor.github.smeeChannel)
    | if (.catalyst.monitor.github // {}) == {} then del(.catalyst.monitor.github) else . end
    | if (.catalyst.monitor // {}) == {} then del(.catalyst.monitor) else . end
    | if (.catalyst // {}) == {} then del(.catalyst) else . end
  ' "$PROJECT_CONFIG_PATH" > "$tmp"
  mv "$tmp" "$PROJECT_CONFIG_PATH"
  echo "→ Removed deprecated smeeChannel from $PROJECT_CONFIG_PATH (commit this change)"
fi

# ─── 6. Apply --add-repo entries (if combined with normal setup) ────────────
if [[ ${#ADD_REPOS[@]} -gt 0 ]]; then
  repos_json=$(printf '%s\n' "${ADD_REPOS[@]}" | jq -R . | jq -s .)
  merge_watch_repos "$repos_json"
  echo "Added ${#ADD_REPOS[@]} repo(s) to catalyst.monitor.github.watchRepos"
fi

# ─── 6b. Apply --linear-secret-env (if combined with normal setup) ──────────
if [[ -n "$LINEAR_SECRET_ENV" ]]; then
  write_linear_secret_env "$LINEAR_SECRET_ENV"
  echo "Wrote catalyst.monitor.linear.webhookSecretEnv = $LINEAR_SECRET_ENV"
fi

# ─── 6c. --linear-register / --linear-deregister (if combined) ─────────────
if [[ $LINEAR_REGISTER -eq 1 ]]; then
  if [[ -z "$LINEAR_WEBHOOK_URL" ]]; then
    provision_linear_smee_channel
  fi
  helper_secret_env="${LINEAR_SECRET_ENV:-$DEFAULT_LINEAR_SECRET_ENV}"
  helper_args=(
    --webhook-url "$LINEAR_WEBHOOK_URL"
    --secret-env "$helper_secret_env"
    --config "$PROJECT_CONFIG_PATH"
  )
  [[ $FORCE -eq 1 ]] && helper_args+=(--force)
  bash "${SCRIPT_DIR}/setup-linear-webhook.sh" "${helper_args[@]}"
elif [[ $LINEAR_DEREGISTER -eq 1 ]]; then
  bash "${SCRIPT_DIR}/setup-linear-webhook.sh" \
    --deregister --config "$PROJECT_CONFIG_PATH"
fi

# ─── 6d. Verify GitHub webhook registration for each watched repo ───────────
# For each repo in catalyst.monitor.github.watchRepos, call the GitHub Hooks
# API to check whether a hook pointing at $channel already exists. Reports
# the status; with --register-github-hooks, registers any missing hook via
# POST. Skipped silently when watchRepos is empty.
mapfile -t WATCH_REPOS < <(jq -r '.catalyst.monitor.github.watchRepos[]?' \
  "$PROJECT_CONFIG_PATH" 2>/dev/null || true)

if [[ ${#WATCH_REPOS[@]} -gt 0 ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "⚠ Skipping GitHub webhook verification — \`gh\` is not installed."
    echo "  Install GitHub CLI to verify or auto-register webhooks: https://cli.github.com"
  else
    echo
    echo "Verifying GitHub webhook registration for ${#WATCH_REPOS[@]} repo(s)…"
    secret_value=""
    if [[ -f "$SECRET_PATH" ]]; then
      secret_value=$(cat "$SECRET_PATH")
    fi
    for repo in "${WATCH_REPOS[@]}"; do
      verify_github_hook "$repo" "$channel" "$secret_value"
    done
  fi
fi

# ─── 7. Print next steps ───────────────────────────────────────────────────
cat <<EOF

Setup complete.

Export the secret in your shell (and add to your ~/.zshrc / ~/.bashrc):

  export ${DEFAULT_SECRET_ENV}="\$(cat $SECRET_PATH)"

Then restart orch-monitor — it will tunnel deliveries from $channel to
http://localhost:7400/api/webhook and auto-subscribe each repo it observes.

If any repo above shows ⚠, register its webhook with:
  $(basename "$0") --register-github-hooks

EOF
