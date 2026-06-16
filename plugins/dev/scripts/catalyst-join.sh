#!/usr/bin/env bash
# catalyst-join.sh — one-line onboarding for a fresh macOS node into a Catalyst cluster.
#
# Usage:
#   CATALYST_SEED=mini:7400 CATALYST_JOIN_TOKEN=jt_<64hex> bash catalyst-join.sh
#   bash catalyst-join.sh --bundle /path/to/bundle.json   # offline / pre-fetched bundle
#   bash catalyst-join.sh --help
#
# Environment variables:
#   CATALYST_SEED          Seed node address host:port (required unless --bundle is used)
#   CATALYST_JOIN_TOKEN    Join token (jt_ + 64 hex chars); optional in --bundle mode
#   CATALYST_HOST_NAME     Override host name (default: hostname minus .local)
#   CATALYST_DIR           Catalyst state directory (default: ~/catalyst)
#
# Overrides for testing:
#   CATALYST_JOIN_SETUP_SCRIPT      path to setup-catalyst.sh
#   CATALYST_JOIN_INSTALL_CLI_SCRIPT path to install-cli.sh
#   CATALYST_JOIN_PLUGIN_SRC_SCRIPT  path to setup-plugin-source.sh
#   CATALYST_JOIN_STACK_BIN          path to catalyst-stack
#   CATALYST_JOIN_DOCTOR_SCRIPT      path to check-setup.sh
#   CATALYST_JOIN_REACH_PROBE        path to reachability probe script
#   CATALYST_JOIN_FETCH_CMD          path to bundle fetch command (replaces curl)
#   CATALYST_LAYER2_CONFIG_FILE      path to Layer-2 config (default: ~/.config/catalyst/config.json)
#
# The script is resumable: progress is tracked in ${CATALYST_DIR}/cluster/join-progress.json.
# Re-running with the same host.name is a no-op merge (idempotent).
#
# CTL-1185

set -uo pipefail

# ── Script location ───────────────────────────────────────────────────────────
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SELF_DIR}/../../.." && pwd)"

# ── Overridable subprocess paths ──────────────────────────────────────────────
SETUP_SCRIPT="${CATALYST_JOIN_SETUP_SCRIPT:-${REPO_ROOT}/setup-catalyst.sh}"
INSTALL_CLI_SCRIPT="${CATALYST_JOIN_INSTALL_CLI_SCRIPT:-${SELF_DIR}/install-cli.sh}"
PLUGIN_SRC_SCRIPT="${CATALYST_JOIN_PLUGIN_SRC_SCRIPT:-${SELF_DIR}/setup-plugin-source.sh}"
STACK_BIN="${CATALYST_JOIN_STACK_BIN:-${SELF_DIR}/catalyst-stack}"
DOCTOR_SCRIPT="${CATALYST_JOIN_DOCTOR_SCRIPT:-${SELF_DIR}/check-setup.sh}"
REACH_PROBE="${CATALYST_JOIN_REACH_PROBE:-}"
# CATALYST_JOIN_FETCH_CMD — used in acquire_bundle(); resolved there

# ── Logging helpers ───────────────────────────────────────────────────────────
info() { echo "[join] $*"; }
warn() { echo "[join] WARN: $*" >&2; }
fail() { echo "[join] ERROR: $*" >&2; }

# ── Arg parsing ───────────────────────────────────────────────────────────────
BUNDLE_PATH=""
RESUME=1  # default: resume from progress marker if present

usage() {
  cat <<'EOF'
catalyst-join.sh — provision a fresh macOS node into a Catalyst cluster

Usage:
  CATALYST_SEED=<host:port> CATALYST_JOIN_TOKEN=<jt_...> bash catalyst-join.sh
  bash catalyst-join.sh --bundle <path/to/bundle.json>
  bash catalyst-join.sh --help

Environment:
  CATALYST_SEED          Seed address (host:port); required unless --bundle is given
  CATALYST_JOIN_TOKEN    Join token (jt_ + 64 hex chars); optional in --bundle mode
  CATALYST_HOST_NAME     Override host name (default: hostname -s, .local stripped)
  CATALYST_DIR           Catalyst state directory (default: ~/catalyst)

Flags:
  --bundle <path>        Use a pre-fetched local bundle file (skips seed fetch + reachability)
  --no-resume            Ignore existing progress marker and start fresh
  -h, --help             Print this usage and exit 0

The script is resumable: re-run after a failure to skip completed stages.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --bundle)
        [[ $# -ge 2 ]] || { fail "--bundle requires a path argument"; exit 1; }
        BUNDLE_PATH="$2"; shift 2 ;;
      --no-resume)
        RESUME=0; shift ;;
      -h|--help)
        usage; exit 0 ;;
      *)
        fail "Unknown argument: $1"; usage >&2; exit 1 ;;
    esac
  done
}

parse_args "$@"

# ── Token format validation ───────────────────────────────────────────────────
CATALYST_JOIN_TOKEN="${CATALYST_JOIN_TOKEN:-}"

validate_token() {
  local tok="$1"
  if [[ ! "$tok" =~ ^jt_[0-9a-f]{64}$ ]]; then
    fail "Invalid join token format. Expected: jt_ followed by exactly 64 hex characters."
    fail "Got: ${tok:0:10}... (length: ${#tok})"
    return 1
  fi
}

# Require token OR --bundle
if [[ -z "$BUNDLE_PATH" ]]; then
  if [[ -z "$CATALYST_JOIN_TOKEN" ]]; then
    fail "CATALYST_JOIN_TOKEN is required (or use --bundle <path> for offline mode)"
    fail "Get a token from the seed operator: catalyst cluster join-token"
    exit 1
  fi
  validate_token "$CATALYST_JOIN_TOKEN" || exit 1
else
  # --bundle mode: a token is optional, but if one IS supplied it must be
  # well-formed. An unvalidated token would be persisted raw into the marker
  # (CTL-1185 remediate: verify silent-failure finding).
  if [[ -n "$CATALYST_JOIN_TOKEN" ]]; then
    validate_token "$CATALYST_JOIN_TOKEN" || exit 1
  fi
fi

# ── State paths ───────────────────────────────────────────────────────────────
CATALYST_DIR="${CATALYST_DIR:-${HOME}/catalyst}"
MARKER_DIR="${CATALYST_DIR}/cluster"
MARKER_FILE="${MARKER_DIR}/join-progress.json"
LAYER2_CONFIG="${CATALYST_LAYER2_CONFIG_FILE:-${HOME}/.config/catalyst/config.json}"

mkdir -p "$MARKER_DIR"

# ── Atomic jq write helper ────────────────────────────────────────────────────
_atomic_jq_write() {
  local file="$1"; shift
  local jq_prog="$1"; shift
  local tmp
  tmp="$(mktemp "$(dirname "$file")/.jq-write.XXXXXX")"
  if jq "$@" "$jq_prog" "$file" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$file"
    return 0
  else
    rm -f "$tmp"
    return 1
  fi
}

# ── Progress marker helpers ───────────────────────────────────────────────────
marker_init() {
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ "$RESUME" -eq 1 && -f "$MARKER_FILE" ]]; then
    return 0  # preserve existing marker for resume
  fi
  # CTL-1185 remediate: build with jq --arg (not raw printf) so a token or
  # bundlePath containing a double-quote/backslash cannot produce invalid JSON
  # that silently breaks every later marker op under `2>/dev/null` and wedges
  # resume with no error surfaced (verify silent-failure finding).
  jq -n \
    --arg ts "$ts" \
    --arg token "${CATALYST_JOIN_TOKEN:-}" \
    --arg bundlePath "${BUNDLE_PATH:-}" \
    '{completedStages: [], startedAt: $ts}
     + (if $token != "" then {token: $token} else {} end)
     + (if $bundlePath != "" then {bundlePath: $bundlePath} else {} end)' \
    > "$MARKER_FILE"
  # The marker may hold the join token; lock it to 0600 immediately rather than
  # leaving it world-readable until a later marker op's mktemp+mv replaces it
  # (verify security finding; CTL-1203 secrets-600 hygiene).
  chmod 0600 "$MARKER_FILE" 2>/dev/null || true
}

marker_has_stage() {
  local stage="$1"
  [[ -f "$MARKER_FILE" ]] && \
    jq -e --arg s "$stage" '.completedStages | index($s) != null' "$MARKER_FILE" >/dev/null 2>&1
}

marker_add_stage() {
  local stage="$1"
  [[ -f "$MARKER_FILE" ]] || return 0
  local tmp
  tmp="$(mktemp "${MARKER_DIR}/.marker.XXXXXX")"
  jq --arg s "$stage" '.completedStages += [$s] | del(.failedStage)' "$MARKER_FILE" > "$tmp" && \
    mv "$tmp" "$MARKER_FILE" || rm -f "$tmp"
}

marker_set_failed() {
  local stage="$1"
  [[ -f "$MARKER_FILE" ]] || return 0
  local tmp
  tmp="$(mktemp "${MARKER_DIR}/.marker.XXXXXX")"
  jq --arg s "$stage" '.failedStage = $s' "$MARKER_FILE" > "$tmp" && \
    mv "$tmp" "$MARKER_FILE" || rm -f "$tmp"
}

marker_record_bundle() {
  local bundle_path="$1"
  [[ -f "$MARKER_FILE" ]] || return 0
  local tmp
  tmp="$(mktemp "${MARKER_DIR}/.marker.XXXXXX")"
  jq --arg bp "$bundle_path" '.bundlePath = $bp' "$MARKER_FILE" > "$tmp" && \
    mv "$tmp" "$MARKER_FILE" || rm -f "$tmp"
}

# ── Tailscale reachability preflight ─────────────────────────────────────────
preflight_tailscale() {
  local seed="${CATALYST_SEED:-}"
  if [[ -z "$seed" ]]; then
    fail "CATALYST_SEED is required in non-bundle mode (format: host:port)"
    return 1
  fi

  local probe_fn="${REACH_PROBE:-}"
  if [[ -n "$probe_fn" && -x "$probe_fn" ]]; then
    # Use override probe (for tests)
    if ! "$probe_fn" "$seed" 2>/dev/null; then
      fail "Seed '${seed}' is not reachable. Is Tailscale running and the seed online?"
      fail "Hint: tailscale status | grep ${seed%%:*}"
      return 1
    fi
    return 0
  fi

  # Default: check that tailscale is available and the host is reachable
  local host="${seed%%:*}"
  local port="${seed##*:}"
  if ! command -v tailscale >/dev/null 2>&1; then
    fail "tailscale not found in PATH. Install Tailscale first."
    return 1
  fi
  if ! tailscale ping --timeout=5s "$host" >/dev/null 2>&1; then
    fail "Tailscale ping to '${host}' failed. Is this node on the tailnet?"
    return 1
  fi
  # Port reachability check
  if command -v nc >/dev/null 2>&1; then
    if ! nc -z -G 5 "$host" "$port" >/dev/null 2>&1; then
      fail "Port ${port} on '${host}' is not reachable. Is the bundle listener running?"
      return 1
    fi
  fi
}

# ── Bundle acquisition ────────────────────────────────────────────────────────
BUNDLE_TMPFILE=""
BUNDLE_JSON=""

# Required bundle keys for schema validation
BUNDLE_REQUIRED_KEYS=(
  ".layer1Identity.projectKey"
  ".layer1Identity.teamKey"
  ".layer1Identity.stateMap"
  ".botCreds.orchestrator"
  ".botCreds.worker"
  ".hostsRoster"
  ".livenessAnchorIssue"
  ".repoUrl"
  ".pluginSourceUrl"
)

validate_bundle() {
  local json="$1"
  local missing=()
  for key in "${BUNDLE_REQUIRED_KEYS[@]}"; do
    if ! echo "$json" | jq -e "$key" >/dev/null 2>&1; then
      missing+=("$key")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    fail "Bundle schema validation failed. Missing required keys:"
    for k in "${missing[@]}"; do
      fail "  $k"
    done
    return 1
  fi
}

bundle_get() {
  local path="$1"
  echo "$BUNDLE_JSON" | jq -r "$path // empty"
}

acquire_bundle() {
  if [[ -n "$BUNDLE_PATH" ]]; then
    # --bundle mode: read local file
    if [[ ! -f "$BUNDLE_PATH" ]]; then
      fail "Bundle file not found: $BUNDLE_PATH"
      return 1
    fi
    BUNDLE_JSON="$(cat "$BUNDLE_PATH")"
    validate_bundle "$BUNDLE_JSON" || return 1
    marker_record_bundle "$BUNDLE_PATH"
    info "Bundle loaded from local file: $BUNDLE_PATH"
    return 0
  fi

  # Seed fetch mode
  # NOTE: join-bundle-listener.mjs (CTL-1183) is not yet in tree.
  # This path is coded against the documented bundle contract and exercised
  # via CATALYST_JOIN_FETCH_CMD stub in tests.
  local seed="${CATALYST_SEED:-}"
  local host="${seed%%:*}"
  local port="${seed##*:}"
  local bundle_url="http://${host}:${port}/bundle"
  local fetch_cmd="${CATALYST_JOIN_FETCH_CMD:-}"

  if [[ -n "$fetch_cmd" && -x "$fetch_cmd" ]]; then
    # Test stub or override
    BUNDLE_JSON="$("$fetch_cmd" "$bundle_url" "$CATALYST_JOIN_TOKEN" 2>&1)" || {
      fail "Bundle fetch failed (token may be consumed or listener not running)."
      fail "Re-mint a fresh token: catalyst cluster join-token"
      return 1
    }
  else
    # Default: curl with bearer auth
    local http_out http_code
    BUNDLE_TMPFILE="$(mktemp "${CATALYST_DIR}/.bundle.XXXXXX")"
    chmod 0600 "$BUNDLE_TMPFILE"
    http_code="$(curl -fsS \
      -H "Authorization: Bearer ${CATALYST_JOIN_TOKEN}" \
      -o "$BUNDLE_TMPFILE" \
      -w "%{http_code}" \
      "$bundle_url" 2>&1)" || http_code="000"
    if [[ "$http_code" != "200" ]]; then
      rm -f "$BUNDLE_TMPFILE"
      fail "Bundle fetch returned HTTP ${http_code} from ${bundle_url}"
      fail "Re-mint a fresh token: catalyst cluster join-token"
      return 1
    fi
    BUNDLE_JSON="$(cat "$BUNDLE_TMPFILE")"
    rm -f "$BUNDLE_TMPFILE"
  fi

  validate_bundle "$BUNDLE_JSON" || return 1

  # Record integrityHash if present (no enforcement per CTL-1183)
  local ihash; ihash="$(echo "$BUNDLE_JSON" | jq -r '.integrityHash // empty')"
  [[ -n "$ihash" ]] && info "Bundle integrityHash: ${ihash} (recorded, not enforced)"

  info "Bundle acquired from seed: ${seed}"
}

# ── Stage runner (resumable, stubbable) ───────────────────────────────────────
run_stage() {
  local name="$1"; shift
  if marker_has_stage "$name"; then
    info "Skipping already-completed stage: ${name}"
    return 0
  fi
  info "Running stage: ${name}"
  if "$@"; then
    marker_add_stage "$name"
    info "Stage complete: ${name}"
    return 0
  else
    local ec=$?
    marker_set_failed "$name"
    fail "Stage '${name}' failed (rc=${ec}). Re-run to resume from this stage."
    return $ec
  fi
}

# ── Provisioner stages ────────────────────────────────────────────────────────
do_setup_catalyst() {
  CATALYST_AUTONOMOUS=1 bash "$SETUP_SCRIPT"
}

do_install_cli() {
  bash "$INSTALL_CLI_SCRIPT"
}

do_setup_plugin_source() {
  bash "$PLUGIN_SRC_SCRIPT"
}

# ── SHARED config merge ───────────────────────────────────────────────────────
merge_shared_config() {
  local cfg="$LAYER2_CONFIG"
  mkdir -p "$(dirname "$cfg")"
  if [[ ! -f "$cfg" ]]; then
    # Create at 0600 before it ever holds botCreds.orchestrator/worker — the
    # default umask would otherwise leave a transient world-readable window
    # (verify security finding; CTL-1203 secrets-600 hygiene).
    echo '{}' > "$cfg"
    chmod 0600 "$cfg" 2>/dev/null || true
  fi

  # Extract SHARED keys from bundle; preserve all existing node-local keys
  local la_project la_team la_statemap bot_orch bot_worker liveness repo_url plugin_url
  la_project="$(bundle_get '.layer1Identity.projectKey')"
  la_team="$(bundle_get '.layer1Identity.teamKey')"
  la_statemap="$(echo "$BUNDLE_JSON" | jq '.layer1Identity.stateMap // {}')"
  bot_orch="$(bundle_get '.botCreds.orchestrator')"
  bot_worker="$(bundle_get '.botCreds.worker')"
  liveness="$(bundle_get '.livenessAnchorIssue')"
  repo_url="$(bundle_get '.repoUrl')"
  plugin_url="$(bundle_get '.pluginSourceUrl')"

  local tmp
  tmp="$(mktemp "$(dirname "$cfg")/.config.XXXXXX")"
  jq \
    --arg la_project "$la_project" \
    --arg la_team "$la_team" \
    --argjson la_statemap "$la_statemap" \
    --arg bot_orch "$bot_orch" \
    --arg bot_worker "$bot_worker" \
    --arg liveness "$liveness" \
    --arg repo_url "$repo_url" \
    --arg plugin_url "$plugin_url" \
    '
      .catalyst //= {}
      | .catalyst.linear //= {}
      | .catalyst.linear.bot //= {}
      | .catalyst.linear.bot.orchestrator //= $bot_orch
      | .catalyst.linear.bot.worker //= $bot_worker
      | .catalyst.cluster //= {}
      | .catalyst.cluster.livenessAnchorIssue //= $liveness
      | .catalyst.repository //= $repo_url
      | .catalyst.feedback //= $plugin_url
      | .catalyst.layer1Identity //= {}
      | .catalyst.layer1Identity.projectKey //= $la_project
      | .catalyst.layer1Identity.teamKey //= $la_team
      | .catalyst.layer1Identity.stateMap //= $la_statemap
    ' "$cfg" > "$tmp" && mv "$tmp" "$cfg" || { rm -f "$tmp"; return 1; }
  info "SHARED config merged into ${cfg}"
}

persist_host_name() {
  local cfg="$LAYER2_CONFIG"
  local host_name="${CATALYST_HOST_NAME:-}"
  if [[ -z "$host_name" ]]; then
    host_name="$(hostname -s 2>/dev/null || hostname | sed 's/\.local$//')"
    host_name="${host_name%.local}"
  fi
  if [[ ! -f "$cfg" ]]; then
    echo '{}' > "$cfg"
    chmod 0600 "$cfg" 2>/dev/null || true  # holds botCreds; protect immediately (CTL-1203)
  fi
  local tmp
  tmp="$(mktemp "$(dirname "$cfg")/.config.XXXXXX")"
  jq --arg hn "$host_name" '.catalyst.host.name = $hn' "$cfg" > "$tmp" && mv "$tmp" "$cfg" || { rm -f "$tmp"; return 1; }
  info "host.name set to: ${host_name}"
  # CTL-1185 remediate: return the host name via a global, NOT via stdout. The
  # caller captures host_name="$(persist_host_name)"; echoing here makes command
  # substitution capture the info() line above too, so write_local_roster stored
  # a polluted multi-line value and local-hosts.json became
  # ["[join] host.name set to: <h>\n<h>"] instead of ["<h>"] (verify HIGH finding).
  PERSISTED_HOST_NAME="$host_name"
}

write_local_roster() {
  local host_name="$1"
  local local_roster="${CATALYST_DIR}/cluster/local-hosts.json"
  mkdir -p "$(dirname "$local_roster")"

  local existing="[]"
  if [[ -f "$local_roster" ]]; then
    existing="$(cat "$local_roster")"
  fi

  # Merge-preserve: add host if not already present
  local tmp
  tmp="$(mktemp "${CATALYST_DIR}/cluster/.roster.XXXXXX")"
  echo "$existing" | jq --arg h "$host_name" 'if index($h) then . else . + [$h] end' > "$tmp" && \
    mv "$tmp" "$local_roster" || { rm -f "$tmp"; return 1; }

  info "Local roster written: ${local_roster}"
  info "NOTE: The committed .catalyst/hosts.json roster has NOT been modified."
  info "      To activate this node, update and commit .catalyst/hosts.json."
}

do_config_merge() {
  merge_shared_config || return 1
  # CTL-1185 remediate: persist_host_name returns the host name via the global
  # PERSISTED_HOST_NAME (not stdout) so the info() progress line can't pollute
  # the captured value. Same shell — run_stage calls "$@" directly, no subshell.
  PERSISTED_HOST_NAME=""
  persist_host_name || return 1
  write_local_roster "$PERSISTED_HOST_NAME" || return 1
}

do_doctor_gate() {
  if bash "$DOCTOR_SCRIPT" >/dev/null 2>&1; then
    info "Doctor gate passed."
    return 0
  else
    fail "Setup health check (doctor gate) failed. Run '${DOCTOR_SCRIPT}' for details."
    return 1
  fi
}

do_install_stack() {
  "$STACK_BIN" install-services
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  info "=== Catalyst node join (CTL-1185) ==="

  # 1. Preflight
  if [[ -z "$BUNDLE_PATH" ]]; then
    preflight_tailscale || exit 1
  fi

  # 2. Initialize progress marker
  marker_init

  # 3. Acquire + validate bundle
  if ! marker_has_stage "acquire-bundle"; then
    acquire_bundle || { marker_set_failed "acquire-bundle"; exit 1; }
    marker_add_stage "acquire-bundle"
  else
    info "Skipping already-completed stage: acquire-bundle"
    # Re-load bundle from stored path for subsequent stages
    local stored_path
    stored_path="$(jq -r '.bundlePath // empty' "$MARKER_FILE" 2>/dev/null || true)"
    if [[ -n "$stored_path" && -f "$stored_path" ]]; then
      BUNDLE_JSON="$(cat "$stored_path")"
    else
      # Seed mode resume: we don't have the bundle body, re-acquire
      acquire_bundle || { marker_set_failed "acquire-bundle"; exit 1; }
    fi
  fi

  # 4. Provisioners (order matters)
  run_stage "setup-catalyst"      do_setup_catalyst      || exit 1
  run_stage "install-cli"         do_install_cli          || exit 1
  run_stage "setup-plugin-source" do_setup_plugin_source  || exit 1

  # 5. SHARED config merge + per-node items
  run_stage "config-merge" do_config_merge || exit 1

  # 6. Doctor gate (T4)
  run_stage "doctor" do_doctor_gate || exit 1

  # 7. Install launchd stack LAST (Stage-0 SHADOW)
  run_stage "stack" do_install_stack || exit 1

  # Guard so a successful re-run doesn't append a duplicate shadow-stop entry to
  # completedStages each time (verify low finding).
  marker_has_stage "shadow-stop" || marker_add_stage "shadow-stop"

  info ""
  info "=== Stage-0 SHADOW complete ==="
  info "This node is provisioned but INERT (owns zero tickets via HRW)."
  info "To activate: update and commit .catalyst/hosts.json with this node."
  info "Local roster: ${CATALYST_DIR}/cluster/local-hosts.json"
  info ""
}

main
