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
#   CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT path to provision-thoughts.sh
#   CATALYST_JOIN_STACK_BIN          path to catalyst-stack
#   CATALYST_JOIN_DOCTOR_SCRIPT      path to catalyst-doctor (CTL-1186 activation gate)
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
PROVISION_THOUGHTS_SCRIPT="${CATALYST_JOIN_PROVISION_THOUGHTS_SCRIPT:-${SELF_DIR}/provision-thoughts.sh}"
STACK_BIN="${CATALYST_JOIN_STACK_BIN:-${SELF_DIR}/catalyst-stack}"
# CTL-1186 fail-closed activation gate (NOT the full-workstation check-setup.sh,
# which is cwd-relative + asserts a fully-provisioned dev box and so exits nonzero
# on a fresh SHADOW node). catalyst-doctor exits 0 iff zero FAIL checks; warns are
# expected on a fresh node. Overridable for tests via CATALYST_JOIN_DOCTOR_SCRIPT.
DOCTOR_SCRIPT="${CATALYST_JOIN_DOCTOR_SCRIPT:-${SELF_DIR}/catalyst-doctor}"
REACH_PROBE="${CATALYST_JOIN_REACH_PROBE:-}"
# CATALYST_JOIN_FETCH_CMD — used in acquire_bundle(); resolved there

# CTL-1617 PR5: the bash mirror of the deployment-mode resolver. Sourced
# unconditionally here (a normal top-of-script lib dependency, same as every
# other lib/*.sh a script in this tree relies on). Consulted from exactly one
# place — merge_shared_config's webhook-wiring gate, below — which decides
# whether to wire webhook ingestion into this node's Layer-2 config based on
# the declared deployment mode (falling back to the pre-CTL-1617 roster-
# length heuristic when the mode is undeclared). See that function's header
# comment for the full decision rule.
# shellcheck source=lib/catalyst-deployment-mode.sh
. "${SELF_DIR}/lib/catalyst-deployment-mode.sh"

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
# CTL-1210: sibling files in the same dir — shared keys (byte-identical across nodes) and
# per-node identity/tunables. Derived from LAYER2_CONFIG so CATALYST_LAYER2_CONFIG_FILE
# overrides in tests also move these siblings correctly.
CLUSTER_SECRETS_CONFIG="${LAYER2_CONFIG%/*}/cluster-secrets.json"
NODE_CONFIG="${LAYER2_CONFIG%/*}/node.json"

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

# Drop a stage from completedStages so a resume re-executes it. Used when a
# LATER stage discovers that this stage's output is what needs refreshing
# (e.g. config-merge failing on a Layer-1 typo that lives in the
# setup-plugin-source checkout — a plain resume would re-read the same stale
# clone forever; see the webhook-wiring gate).
marker_remove_stage() {
  local stage="$1"
  [[ -f "$MARKER_FILE" ]] || return 0
  local tmp
  tmp="$(mktemp "${MARKER_DIR}/.marker.XXXXXX")"
  jq --arg s "$stage" '.completedStages -= [$s]' "$MARKER_FILE" > "$tmp" && \
    mv "$tmp" "$MARKER_FILE" || rm -f "$tmp"
}

# Record that the webhook-wiring gate deliberately deferred wiring (Stage-0
# roster guard) so activation tooling / an operator inspecting the marker can
# see the node is intentionally unwired. config-merge still completes — this
# breadcrumb, the gate's log note, and doctor's webhook-ingestion FAIL once
# the node is activated at roster>1 are the recovery signals.
marker_note_deferred_wiring() {
  local reason="$1"
  [[ -f "$MARKER_FILE" ]] || return 0
  local tmp
  tmp="$(mktemp "${MARKER_DIR}/.marker.XXXXXX")"
  jq --arg r "$reason" '.webhookWiringDeferred = {reason: $r}' "$MARKER_FILE" > "$tmp" && \
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

  # Default: confirm the seed host:port is reachable.
  local host="${seed%%:*}"
  local port="${seed##*:}"

  # CTL-1214 (PATH-B #2): the `tailscale` CLI is NOT required. A node can be
  # fully on the tailnet via the GUI app with no CLI on PATH (mini-2's case).
  # When the CLI is present, use `tailscale ping` as a tailnet liveness check;
  # the signal that actually matters is a TCP connect to the seed port, which
  # nc/curl provide with or without the CLI.
  if command -v tailscale >/dev/null 2>&1; then
    if ! tailscale ping --timeout=5s "$host" >/dev/null 2>&1; then
      fail "Tailscale ping to '${host}' failed. Is this node on the tailnet?"
      return 1
    fi
  fi

  # TCP reachability to the seed port (works with or without the tailscale CLI).
  # Prefer nc (protocol-agnostic); fall back to curl (a 404 from the listener
  # still proves the port is reachable — curl without -f exits 0).
  # NOTE: use `-w` (connect timeout) NOT `-G` — `-G` is a BSD/macOS-only flag and
  # OpenBSD/GNU nc on Linux error out on it even when the port is open. `-w secs`
  # is understood by BSD, OpenBSD, and GNU nc alike (CTL-1214 verify finding).
  if command -v nc >/dev/null 2>&1; then
    if ! nc -z -w 5 "$host" "$port" >/dev/null 2>&1; then
      fail "Port ${port} on '${host}' is not reachable. Is this node on the tailnet and the bundle listener running?"
      fail "Hint: confirm Tailscale is connected (GUI app or CLI) and the seed armed 'catalyst cluster join-token'."
      return 1
    fi
  elif command -v curl >/dev/null 2>&1; then
    if ! curl -sS -o /dev/null --connect-timeout 5 "http://${host}:${port}/" >/dev/null 2>&1; then
      fail "Seed '${host}:${port}' is not reachable. Is this node on the tailnet and the bundle listener running?"
      return 1
    fi
  else
    warn "No reachability probe tool (nc/curl) available; skipping TCP preflight."
  fi
}

# ── Bundle acquisition ────────────────────────────────────────────────────────
BUNDLE_TMPFILE=""
BUNDLE_JSON=""

# Required bundle keys that must be PRESENT and NON-NULL — identity, bot
# credentials, roster, and URLs. A null here means a broken/misresolved seed
# config (e.g. the listener read the wrong Layer-1); fail FAST rather than
# silently enrol the node with an empty Linear team/projectKey (CTL-1214 verify).
BUNDLE_REQUIRED_KEYS=(
  ".layer1Identity.projectKey"
  ".layer1Identity.teamKey"
  ".layer1Identity.stateMap"
  ".botCreds.orchestrator"
  ".botCreds.worker"
  ".hostsRoster"
  ".repoUrl"
  ".pluginSourceUrl"
)

# Required keys that must EXIST but may legitimately be null — e.g.
# .livenessAnchorIssue is null until an anchor ticket is set (CTL-1214 #4).
BUNDLE_EXISTENCE_KEYS=(
  ".livenessAnchorIssue"
)

validate_bundle() {
  local json="$1"
  local missing=()
  # Non-null assertion for identity/credential/url keys: `jq -e "$key"` exits
  # non-zero on null/false, so an all-null layer1Identity is rejected here.
  for key in "${BUNDLE_REQUIRED_KEYS[@]}"; do
    if ! echo "$json" | jq -e "$key" >/dev/null 2>&1; then
      missing+=("$key")
    fi
  done
  # Existence-only assertion (CTL-1214 #4): the key must be present but its value
  # may be null. Test path existence via `any(paths; …)` — a null value passes,
  # a structurally-absent key still fails.
  for key in "${BUNDLE_EXISTENCE_KEYS[@]}"; do
    if ! echo "$json" | jq -e --arg key "$key" \
        '($key | ltrimstr(".") | split(".")) as $p | any(paths; . == $p)' \
        >/dev/null 2>&1; then
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
  # CTL-1214 (PATH-B #1): the armed listener serves ONLY /join-bundle
  # (execution-core/join-listener.mjs JOIN_ROUTE); any other path 404s, so the
  # seed-fetch join can never succeed with "/bundle". Must match JOIN_ROUTE.
  local bundle_url="http://${host}:${port}/join-bundle"
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
  # CTL-1263: install-cli.sh's ensure_alloy provisions the Grafana Alloy
  # log-shipper binary as part of this stage, so a joined node inherits the
  # shipper with no extra wiring (do_install_stack's launchd agent then auto-
  # starts it via `catalyst-stack start`). Surface a LOUD but NON-FATAL warning
  # if the binary did not land (e.g. a headless Linux box with no brew and a
  # flaky GitHub download) — install-cli warn+continues by design, so the join
  # must not hard-fail here. The shipper is optional infra; start_shipper warns
  # again at start time so the gap is never silent.
  if ! command -v alloy >/dev/null 2>&1; then
    warn "alloy not installed by install-cli — log-shipper will not start on this node (install Grafana Alloy manually, then 'catalyst-stack start')"
  fi
  # CTL-1500: install-cli.sh's ensure_agent_browser provisions agent-browser
  # (>= min) + Chrome for Testing on this node. Surface a LOUD but NON-FATAL
  # warning if it did not land (e.g. a headless box with no brew) — browser-
  # testing skills degrade, but the join must not hard-fail on optional infra.
  if ! command -v agent-browser >/dev/null 2>&1; then
    warn "agent-browser not installed by install-cli — browser-testing skills will not run on this node (install: brew install agent-browser && agent-browser install)"
  fi
  return 0
}

do_setup_plugin_source() {
  bash "$PLUGIN_SRC_SCRIPT"
}

# Install the GitHub CLI binary into ~/.local/bin when absent. provision-thoughts
# clones PRIVATE org thoughts repos and runs BEFORE setup-catalyst installs gh, so
# the join can't rely on setup-catalyst's prereq step for it. Idempotent; returns
# non-zero only if the install genuinely failed.
ensure_gh() {
  command -v gh >/dev/null 2>&1 && return 0
  command -v jq >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 || {
    warn "cannot install gh (need curl + jq)"; return 1; }
  local os arch ghver tmp
  os="$(uname -s)"; arch="$(uname -m)"
  case "$arch" in arm64 | aarch64) arch="arm64" ;; x86_64 | amd64) arch="amd64" ;; esac
  ghver="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest 2>/dev/null | jq -r '.tag_name // empty' | sed 's/^v//')"
  [[ -n "$ghver" ]] || { warn "could not resolve latest gh version"; return 1; }
  mkdir -p "$HOME/.local/bin"; tmp="$(mktemp -d)"
  info "Installing GitHub CLI gh ${ghver} → ~/.local/bin (needed for thoughts auth)…"
  if [[ "$os" == "Darwin" ]]; then
    curl -fsSL "https://github.com/cli/cli/releases/download/v${ghver}/gh_${ghver}_macOS_${arch}.zip" -o "$tmp/gh.zip" \
      && unzip -q "$tmp/gh.zip" -d "$tmp" && cp "$tmp"/gh_*/bin/gh "$HOME/.local/bin/gh"
  else
    curl -fsSL "https://github.com/cli/cli/releases/download/v${ghver}/gh_${ghver}_linux_${arch}.tar.gz" | tar xz -C "$tmp" \
      && cp "$tmp"/gh_*/bin/gh "$HOME/.local/bin/gh"
  fi
  chmod +x "$HOME/.local/bin/gh" 2>/dev/null || true
  rm -rf "$tmp"
  export PATH="$HOME/.local/bin:$PATH"
  command -v gh >/dev/null 2>&1 || { warn "gh install failed"; return 1; }
}

# Establish GitHub HTTPS auth for the thoughts clone+push WITHOUT embedding a PAT
# in the repo. Two mechanisms, in order: (1) CATALYST_JOIN_GITHUB_TOKEN → a 0600
# ~/.netrc (gh-free — the reliable headless path mini-2 used; git uses it for
# clone AND push); (2) an existing or freshly-installed `gh` credential helper.
# provision-thoughts (next stage) clones PRIVATE org repos, so SOME auth must
# exist by then — but a Stage-0 SHADOW node owns zero tickets and the sync-gate
# only activates at roster>1, so this stage is non-fatal and flags the gap.
do_github_auth() {
  # (1) Operator-supplied token → HTTPS credentials via ~/.netrc (no gh needed).
  if [[ -n "${CATALYST_JOIN_GITHUB_TOKEN:-}" ]]; then
    local netrc="$HOME/.netrc"
    # Don't clobber a pre-existing ~/.netrc that already configures github.com —
    # the operator's own credentials win; we only WRITE when there's nothing for
    # github.com yet (and preserve any other machine stanzas).
    if [[ -f "$netrc" ]] && grep -qiE '^[[:space:]]*machine[[:space:]]+github\.com\b' "$netrc"; then
      info "~/.netrc already has a github.com entry — leaving it unchanged."
    else
      # Create at 0600 from the start (no world-readable window), preserving any
      # existing non-github stanzas by appending.
      [[ -f "$netrc" ]] || { : > "$netrc"; chmod 600 "$netrc" 2>/dev/null || true; }
      chmod 600 "$netrc" 2>/dev/null || true
      printf 'machine github.com\nlogin %s\npassword %s\n' \
        "${CATALYST_JOIN_GITHUB_USER:-x-access-token}" "$CATALYST_JOIN_GITHUB_TOKEN" >> "$netrc"
      info "GitHub HTTPS auth configured via ~/.netrc (0600)."
    fi
    return 0
  fi
  # (2) gh credential helper — install gh if absent (private thoughts clone needs it).
  if ! ensure_gh; then
    warn "No CATALYST_JOIN_GITHUB_TOKEN and gh unavailable — the thoughts clone may fail."
    warn "Provide CATALYST_JOIN_GITHUB_TOKEN or run 'gh auth login', then re-run the join."
    return 0
  fi
  if gh auth status >/dev/null 2>&1; then
    gh auth setup-git >/dev/null 2>&1 \
      && info "GitHub HTTPS credential helper configured via gh." \
      || warn "gh auth setup-git failed — thoughts push may not work until fixed."
  else
    warn "gh is installed but not authenticated — set CATALYST_JOIN_GITHUB_TOKEN or run 'gh auth login', then re-run."
  fi
  return 0
}

# Provision the HumanLayer thoughts system (PATH-B #6): clone each served org's
# thoughts repo into ~/catalyst/hlt/<org>/thoughts, write a clean humanlayer.json
# (deterministic repoMappings), verify auth. Orgs are derived data-driven from
# the node's execution-core registry when present, else from the bundle's
# thoughtsOrg (the product/thoughts org — distinct from repoUrl, which is
# wherever the catalyst plugin source itself lives) — never a hardcoded list.
# MUST run before setup-catalyst, whose thoughts-init binds the checkout to
# these repos + humanlayer.json.
do_provision_thoughts() {
  local pt="$PROVISION_THOUGHTS_SCRIPT"
  [[ -x "$pt" ]] || { fail "provision-thoughts.sh not found/executable at $pt"; return 1; }
  local args=(--node-user "${USER:-$(whoami)}")
  local registry="${CATALYST_DIR}/execution-core/registry.json"
  # Same provisioner-parity rule as the webhook-wiring gate below: the checkout
  # lives where setup-plugin-source.sh put it (CATALYST_PLUGIN_SOURCE or the
  # $HOME default), not at a from-scratch ${CATALYST_DIR}/plugin-source guess.
  [[ -f "$registry" ]] || registry="${CATALYST_PLUGIN_SOURCE:-${HOME}/catalyst/plugin-source}/plugins/dev/scripts/execution-core/registry.json"
  # The seed's primary thoughts org: bundle .thoughtsOrg IS the GitHub org that
  # hosts the thoughts repo (join-bundle.mjs sets it from Layer-1
  # catalyst.thoughts.org, falling back to .profile). NOT
  # .layer1Identity.projectKey — projectKey is the Layer-2 secrets-file key (see
  # AGENTS.md "Configuration"), not a GitHub org (Codex #3080 P1). NOT repoUrl's
  # org either — repoUrl/pluginSourceUrl point at wherever the catalyst plugin
  # source itself lives, which can be a different org/personal fork entirely.
  local primary_org primary_org_source primary_profile
  primary_org="$(bundle_get '.thoughtsOrg')"
  primary_org_source="$(bundle_get '.thoughtsOrgSource')"
  # Codex #3080 P1: the profile ALIAS paired with the org. It need not equal the owner
  # (rightsite-cloud/adva), and provision-thoughts' bare-CSV path would otherwise
  # register profile == org — leaving humanlayer.json with no `adva` profile even though
  # create-worktree.sh later requests `adva` by name from Layer-1, so background
  # worktrees resolve a nonexistent profile and fail to sync thoughts. Empty on an older
  # bundle (identity applies, the previous behavior).
  primary_profile="$(bundle_get '.thoughtsProfile')"
  if [[ "$primary_org_source" == "thoughts.profile" ]]; then
    warn "join bundle carries no catalyst.thoughts.org — using catalyst.thoughts.profile ('$primary_org') as the GitHub org."
    warn "profile is a HumanLayer alias and need not equal the owner; set catalyst.thoughts.org in the seed's .catalyst/config.json."
  elif [[ -z "$primary_org" ]]; then
    # An older bundle, or a Layer-1 with thoughts persistence disabled. Never
    # abort the join over it: fall through with no primary declared and let
    # provision-thoughts derive the org set from the registry (Codex #3080 P1).
    warn "join bundle carries neither catalyst.thoughts.org nor .profile — no primary thoughts org declared."
  fi
  if [[ -f "$registry" ]]; then
    args+=(--registry "$registry")
    # Forward the declared primary ALONGSIDE --registry. Without it the
    # registry's first project silently becomes the global thoughtsRepo /
    # defaultProfile — registry order is not a primary-org declaration
    # (Codex #3080 P1).
    [[ -n "$primary_org" ]] && args+=(--primary-org "$primary_org")
    [[ -n "$primary_profile" ]] && args+=(--primary-profile "$primary_profile")
  elif [[ -n "$primary_org" ]]; then
    # Carry the paired alias through the no-registry path too — this is the branch that
    # discarded it (Codex #3080 P1).
    args+=(--orgs "$primary_org" --primary-org "$primary_org")
    [[ -n "$primary_profile" ]] && args+=(--primary-profile "$primary_profile")
  else
    # No registry AND no declared org: provision-thoughts has nothing to act on
    # and would hard-exit. Thoughts persistence is optional, so skip the stage
    # rather than failing the join.
    warn "provision-thoughts: no registry and no thoughts org — skipping thoughts provisioning."
    warn "Set catalyst.thoughts.org on the seed and re-run to enable thoughts persistence on this node."
    return 0
  fi
  local pt_out pt_rc=0
  pt_out="$(bash "$pt" "${args[@]}" 2>&1)" || pt_rc=$?
  printf '%s\n' "$pt_out"
  [[ "$pt_rc" -eq 0 ]] && return 0
  # provision-thoughts failed — usually push-auth (an M2 precondition), not the
  # clone. If the primary thoughts repo is present AND has a usable HEAD (a real
  # read-OK clone, not a partial/interrupted one), severity depends on whether
  # this node will own work. Read the org the provisioner actually settled on
  # rather than assuming a hardcoded name: with --registry and no declared
  # primary it picks the first derived org, which only it knows.
  local resolved_org
  resolved_org="$(sed -nE 's/^\[provision-thoughts\] Primary org: (.+)$/\1/p' <<<"$pt_out" | tail -1)"
  [[ -n "$resolved_org" ]] || resolved_org="$primary_org"
  local primary="${CATALYST_DIR:-$HOME/catalyst}/hlt/${resolved_org}/thoughts"
  if [[ -n "$resolved_org" ]] && [[ -d "$primary/.git" ]] && git -C "$primary" rev-parse --verify -q HEAD >/dev/null 2>&1; then
    # CTL-1293: a multiHost MEMBER (roster>1) WILL own HRW work, and a worker
    # that can't push thoughts strands its research/learnings/handoffs (peers
    # never see them) — so an unverified push is a HARD blocker, not a warning.
    # A single-host / Stage-0 SHADOW node (roster<=1) owns no work and has no
    # peers to sync to, so it may warn-and-proceed. The previous unconditional
    # "acceptable for SHADOW" downgrade was the silent strand.
    local pt_roster_len
    pt_roster_len="$(echo "$BUNDLE_JSON" | jq '(.hostsRoster // []) | length' 2>/dev/null)"
    if [[ "${pt_roster_len:-0}" -gt 1 ]]; then
      fail "provision-thoughts: clone OK but push-auth UNVERIFIED on a multiHost member (roster=${pt_roster_len})."
      fail "A member that owns work MUST sync thoughts to peers. Set CATALYST_JOIN_GITHUB_TOKEN (or 'gh auth login') and re-run."
      return 1
    fi
    warn "provision-thoughts: clone OK but push-auth/verify incomplete — acceptable for single-host/Stage-0 SHADOW."
    warn "Configure CATALYST_JOIN_GITHUB_TOKEN (or 'gh auth login') and re-run before activating as a member."
    return 0
  fi
  fail "provision-thoughts failed before a usable primary thoughts clone. Check GitHub auth / network."
  return 1
}

# ── SHARED config merge ───────────────────────────────────────────────────────
merge_shared_config() {
  # CTL-1210: shared bundle keys go to $CLUSTER_SECRETS_CONFIG (byte-identical across nodes,
  # 0600).  $cfg remains for the webhook-wiring gate's cloudFeed/githubFeed node-local writes.
  local cfg="$CLUSTER_SECRETS_CONFIG"
  local cfg_node="$NODE_CONFIG"
  mkdir -p "$(dirname "$cfg")"
  if [[ ! -f "$cfg" ]]; then
    echo '{}' > "$cfg"
    chmod 0600 "$cfg" 2>/dev/null || true
  fi

  # Extract SHARED keys from bundle. cluster-secrets.json must contain ONLY shared keys so its
  # sha256 is byte-identical across all cluster nodes. Use `jq -S` (sorted keys) for
  # deterministic serialization — a //= merge into a mixed file would vary by node-local state.
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
  tmp="$(mktemp "$(dirname "$cfg")/.cluster-secrets.XXXXXX")"
  chmod 0600 "$tmp" 2>/dev/null || true
  # Fresh deterministic write (not //= merge) so the file is byte-identical on every node.
  jq -S \
    --arg la_project "$la_project" \
    --arg la_team "$la_team" \
    --argjson la_statemap "$la_statemap" \
    --arg bot_orch "$bot_orch" \
    --arg bot_worker "$bot_worker" \
    --arg liveness "$liveness" \
    --arg repo_url "$repo_url" \
    --arg plugin_url "$plugin_url" \
    --null-input \
    '{
      catalyst: {
        cluster: { livenessAnchorIssue: $liveness },
        feedback: $plugin_url,
        layer1Identity: ($la_statemap | { projectKey: $la_project, teamKey: $la_team, stateMap: . }),
        linear: { bot: { orchestrator: $bot_orch, worker: $bot_worker } },
        repository: $repo_url
      }
    }' > "$tmp" && mv "$tmp" "$cfg" || { rm -f "$tmp"; return 1; }
  info "SHARED config written to ${cfg}"

  # CTL-1284: webhook ingestion wiring (non-secret smee channels + per-team
  # webhookId map; HMAC secrets travel via SOPS/cluster-sync, not the bundle).
  # GATED on multiHost — roster length > 1. At roster length 1, HRW is an
  # identity no-op AND claimDispatch is skipped, so a single node ingesting
  # webhooks would actuate every inbound event → double-dispatch. The bundle's
  # hostsRoster is the conservative, present-at-config-merge-time signal (the
  # live resolveClusterHosts() may not yet see the cluster-repo roster here).
  local roster_len monitor_wh
  roster_len="$(echo "$BUNDLE_JSON" | jq '(.hostsRoster // []) | length')"
  monitor_wh="$(echo "$BUNDLE_JSON" | jq '.monitorWebhooks // null')"

  # CTL-1617 PR5 — FLIPPED (migration plan §9 PR5): the gate below now
  # decides on the declared deployment mode, not the roster_len heuristic.
  # The shadow cycle that gated this flip (one full join cycle, both the
  # multi-host/wire shape and the single-host/skip shape) reported
  # verdict=AGREE in both; see the PR5 shadow-cycle evidence in the ticket
  # thread for the exact log lines.
  #
  # Rule (design §6 row 2 / §9 PR5, tightened by the post-merge Codex
  # follow-up — see the three FIX notes below):
  #   - mode resolves to "cluster" (recognized, NOT inferred) AND the bundle's
  #     roster_len > 1                                              → wire
  #   - mode resolves to "cluster" but roster_len <= 1 (FIX 1)       → skip
  #   - mode resolves to a recognized non-cluster value              → skip
  #   - mode is declared but UNRECOGNIZED (a typo)                   → the
  #     config-merge STAGE FAILS outright (FIX 3, below) — it never reaches
  #     this decision at all
  #   - mode is ABSENT (inferred:true — a join bundle/repo predating this
  #     migration) → FALL BACK to the old roster_len heuristic. A newly-
  #     joining cluster member must never silently lose webhook wiring just
  #     because neither side of the join has declared a deployment mode yet.
  #
  # FIX 1 (P1 — Stage-0 double-dispatch guard, post-merge Codex thread 3):
  # the ORIGINAL flip let "mode=cluster" wire unconditionally, regardless of
  # roster length. But the runtime fencing this gate exists to protect is
  # itself roster-derived (execution-core/monitor.mjs: `multiHost =
  # roster.length > 1` gates the claimDispatch soft-CAS) — so wiring webhooks
  # on a roster<=1 node, just because the FLEET declares "cluster", hands a
  # Stage-0 shadow node (joined but not yet added to the roster) live webhook
  # ingestion with no dispatch fencing underneath it: the exact double-
  # dispatch hazard CTL-1284's original roster_len>1 gate existed to prevent.
  # The mode-declared "wire" branch below therefore re-adds the roster_len>1
  # conjunct; a declared "cluster" with roster_len<=1 settles on
  # rule=mode-declared / decision=skip, same as any other non-cluster mode,
  # with an explicit `note=` field on the log line explaining why (a bare
  # "skip" here could otherwise read as "mode is not cluster", which would be
  # wrong). This does NOT reopen the inferred/heuristic path: the heuristic
  # branch already carries its own roster_len>1 conjunct (see
  # heuristic_verdict below) and is untouched.
  #
  # WHAT THE RESOLVER SEES HERE, mid-join (read this before touching the
  # block below):
  #   - Layer-2 candidate is $cfg ITSELF — the very file this function is
  #     mid-write on. The SHARED-config merge above has already landed
  #     catalyst.cluster/catalyst.linear/etc into it, but nothing in
  #     catalyst-join.sh ever writes catalyst.deployment.mode, so Layer-2
  #     is @ABSENT for this key on every join today — it always falls
  #     through to Layer-1.
  #   - catalyst_resolve_deployment_mode's OWN default Layer-1 path is
  #     CWD-relative (${CATALYST_CONFIG_FILE:-$(pwd)/.catalyst/config.json}),
  #     and $PWD at config-merge time is wherever the operator invoked
  #     catalyst-join.sh from (docs/cluster-onboarding.md's one-liner) — it is
  #     NEVER the plugin-source checkout. That checkout is what the
  #     setup-plugin-source stage (already run — step 4, before this one)
  #     provisions, and — since it is a clone of THIS repo's main branch —
  #     its .catalyst/config.json is the file that actually declares
  #     "cluster" for this fleet, as of PR4 (#2901). Left at its own default,
  #     the resolver would see neither file and report "default"
  #     (inferred:true) on every real join, no matter what this repo
  #     declares. So the call below points CATALYST_CONFIG_FILE explicitly at
  #     that checkout's config — a single-command-scoped override (restored
  #     the instant the call returns; see the bash semantics this relies on)
  #     — so the gate reads a live Layer-1 signal instead of unconditionally
  #     reading "default".
  #   - FIX 2 (P2 — provisioner path parity, post-merge Codex thread 2): that
  #     checkout path must be derived with setup-plugin-source.sh's OWN
  #     `DEFAULT_PATH="${CATALYST_PLUGIN_SOURCE:-$HOME/catalyst/plugin-source}"`
  #     expression, not a from-scratch `${CATALYST_DIR}/plugin-source` guess —
  #     the two diverge silently whenever CATALYST_DIR != $HOME/catalyst (a
  #     common override; see CATALYST_DIR's own doc comment atop this script)
  #     or CATALYST_PLUGIN_SOURCE is set, in which case setup-plugin-source
  #     provisioned the checkout at ONE path while this gate went looking at
  #     ANOTHER, found nothing, and silently degraded to inferred/heuristic —
  #     the exact class of gap this gate was written to close.
  local pluginsrc_root="${CATALYST_PLUGIN_SOURCE:-${HOME}/catalyst/plugin-source}"
  local pluginsrc_config="${pluginsrc_root}/.catalyst/config.json"
  CATALYST_CONFIG_FILE="$pluginsrc_config" catalyst_resolve_deployment_mode >/dev/null

  # FIX 3 (P2 — resume idempotency, post-merge Codex thread 4): this gate
  # runs inside the append-only config-merge STAGE (do_config_merge, driven
  # by run_stage). An explicitly-declared-but-UNRECOGNIZED mode (an operator
  # typo) must never be allowed to silently degrade to mode-declared/skip and
  # let the stage report success — run_stage would then add "config-merge" to
  # completedStages, and a resume after the operator fixes the typo would
  # skip this stage forever and never re-evaluate the wire/skip decision (the
  # resolver's own single-host default for a bad value is otherwise
  # indistinguishable, downstream, from a genuinely-declared single-host
  # fleet). So: FAIL the stage outright, before the wire/skip decision is
  # even computed (see the ordering note above) and before any config write
  # for the webhook block below. run_stage's existing failure path
  # (marker_set_failed "config-merge") already makes this resumable — a
  # later run_stage "config-merge" call finds no "config-merge" entry in
  # completedStages and re-executes merge_shared_config from scratch once the
  # value is fixed.
  #
  # The three sources catalyst_resolve_deployment_mode can have settled on
  # are exactly env / layer2 / layer1 (a "default" source is by definition
  # inferred:true and never reaches here) — re-read the raw candidate
  # directly from whichever one SOURCE names, purely for this error message.
  # (lib/catalyst-deployment-mode.sh deliberately does not export the raw
  # value itself — see that file's CATALYST_DEPLOYMENT_MODE_INFERRED doc
  # comment — so the caller reconstructs it here, read-only, best-effort.)
  if [[ "$CATALYST_DEPLOYMENT_MODE_INFERRED" != "true" && "$CATALYST_DEPLOYMENT_MODE_RECOGNIZED" != "true" ]]; then
    local raw_mode=""
    case "$CATALYST_DEPLOYMENT_MODE_SOURCE" in
      env)
        raw_mode="${CATALYST_DEPLOYMENT_MODE-}"
        ;;
      layer2)
        local _l2home="${HOME-}"; [[ -z "$_l2home" ]] && _l2home=~
        local _l2f="${CATALYST_LAYER2_CONFIG_FILE:-${_l2home}/.config/catalyst/config.json}"
        raw_mode="$(jq -r '.catalyst.deployment.mode // empty' "$_l2f" 2>/dev/null)"
        ;;
      layer1)
        raw_mode="$(jq -r '.catalyst.deployment.mode // empty' "$pluginsrc_config" 2>/dev/null)"
        ;;
    esac
    fail "webhook-wiring gate (CTL-1617 PR5): declared deployment mode is UNRECOGNIZED: value=\"${raw_mode}\" source=${CATALYST_DEPLOYMENT_MODE_SOURCE}."
    fail "Valid values: single-host|cluster|cloud. Fix the value and re-run catalyst-join.sh — it resumes from the config-merge stage."
    # When the garbage value came from the LAYER-1 plugin-source checkout, a
    # plain resume cannot heal: setup-plugin-source is already in
    # completedStages, so its ff-only pull never re-runs and the same stale
    # clone is re-read forever, even after the fix is committed upstream.
    # Invalidate that stage so the resume re-pulls the checkout first.
    if [[ "$CATALYST_DEPLOYMENT_MODE_SOURCE" == "layer1" ]]; then
      marker_remove_stage "setup-plugin-source"
      fail "The bad value lives in the plugin-source checkout (${pluginsrc_config}); the setup-plugin-source stage has been invalidated so the re-run refreshes the checkout before re-evaluating."
    fi
    return 1
  fi

  local heuristic_verdict monitor_wh_state rule decision note=""
  if [[ "${roster_len:-0}" -gt 1 && "$monitor_wh" != "null" ]]; then
    heuristic_verdict="wire"
  else
    heuristic_verdict="skip"
  fi
  if [[ "$monitor_wh" != "null" ]]; then monitor_wh_state="present"; else monitor_wh_state="absent"; fi

  if [[ "$CATALYST_DEPLOYMENT_MODE_INFERRED" == "true" ]]; then
    # Mode key absent everywhere (pre-migration bundle/repo) — fall back to
    # the original roster-length heuristic rather than silently skipping.
    rule="heuristic-fallback"
    decision="$heuristic_verdict"
  else
    # Mode declared and RECOGNIZED (the FIX 3 check above has already ruled
    # out the unrecognized case) — it decides, but "cluster" additionally
    # requires roster_len > 1 (FIX 1): the Stage-0 roster guard.
    rule="mode-declared"
    if [[ "$CATALYST_DEPLOYMENT_MODE_RESOLVED" == "cluster" && "${roster_len:-0}" -gt 1 ]]; then
      decision="wire"
    elif [[ "$CATALYST_DEPLOYMENT_MODE_RESOLVED" == "cluster" ]]; then
      decision="skip"
      note="stage0-roster-guard: mode=cluster but roster_len=${roster_len:-0} (<=1) -- runtime dispatch fencing is roster-derived (execution-core/monitor.mjs multiHost=roster.length>1), so wiring here would double-dispatch; deferred: after activating this node in the committed roster, re-run catalyst-join.sh --no-resume with a FRESH join token (catalyst cluster join-token; the original is single-use) or a retained --bundle (until then doctor FAILs webhook-ingestion on this node once roster>1)"
      # Post-merge Codex finding (#2914 P1): config-merge still completes on
      # this branch, so nothing re-evaluates the decision when the roster
      # later grows. Leave a durable breadcrumb in the progress marker for
      # the activation flow / operator; the loud fleet-level signal is
      # doctor's webhook-ingestion FAIL on the activated-but-unwired node.
      marker_note_deferred_wiring "stage0-roster-guard (mode=cluster, roster_len=${roster_len:-0}): after roster activation re-run catalyst-join.sh --no-resume with a fresh join token (catalyst cluster join-token) or a retained --bundle"
    else
      decision="skip"
    fi
  fi
  # A "wire" decision with no monitorWebhooks in the bundle has nothing to
  # write — degrade to skip so the log line always matches the actual
  # outcome (mirrors the heuristic's original implicit `monitor_wh != null`
  # conjunct, now applied uniformly to both rules).
  [[ "$decision" == "wire" && "$monitor_wh" == "null" ]] && decision="skip"

  local note_field=""
  [[ -n "$note" ]] && note_field=" note=${note}"

  info "webhook-wiring gate (CTL-1617 PR5): decision=${decision} rule=${rule} mode=${CATALYST_DEPLOYMENT_MODE_RESOLVED} source=${CATALYST_DEPLOYMENT_MODE_SOURCE} inferred=${CATALYST_DEPLOYMENT_MODE_INFERRED} | heuristic_would=${heuristic_verdict} roster_len=${roster_len:-0} monitorWebhooks=${monitor_wh_state}${note_field}"

  if [[ "$decision" == "wire" ]]; then
    # CTL-1928: strip the LINEAR webhook block before the merge. Linear
    # ingestion is the cloud feed now, and the workspace's Linear webhook
    # subscriptions were retired at the cutover — wiring them onto a joining
    # host would re-create a path that no longer delivers. join-bundle.mjs no
    # longer EMITS this block, but a bundle is a file that outlives the code
    # that wrote it (a retained --bundle, or a seed on an older plugin-source),
    # so the consumer strips it too rather than trusting the producer.
    #
    # Both halves must go. orch-monitor's readLinearSmeeChannel falls back to
    # the first per-team entry's smeeChannel, so deleting only the top-level
    # `.linear.smeeChannel` still leaves enough to start a tunnel; and a
    # per-team `webhookId` arriving without its HMAC secret is what doctor
    # grades as half-wired config residue (webhook-ingestion FAIL).
    local monitor_wh_stripped stripped_linear="no"
    monitor_wh_stripped="$(echo "$monitor_wh" | jq -c 'del(.linear)')" || {
      fail "webhook-wiring: could not strip the retired Linear block from monitorWebhooks"
      return 1
    }
    [[ "$(echo "$monitor_wh" | jq 'has("linear")')" == "true" ]] && stripped_linear="yes"
    # A bundle offering ONLY the retired Linear block leaves nothing to wire —
    # but it must still fall through to the write below, because that write is
    # what provisions the cloud-feed replacement. Merging an empty object into
    # .catalyst.monitor is a no-op, so one code path serves both cases.
    local github_wired="yes"
    [[ "$(echo "$monitor_wh_stripped" | jq 'length')" -eq 0 ]] && github_wired="no"
    local tmp2
    tmp2="$(mktemp "$(dirname "$cfg")/.config.XXXXXX")"
    # Deep-merge ($wh * existing): existing node-local values WIN (non-clobber),
    # new keys from the bundle are added.
    #
    # ⛔ CTL-1928 (Codex #3485 P1): provision the REPLACEMENT in the same write
    # that removes the original. Stripping the Linear block above takes away
    # this node's only Linear route, and `readCloudFeedConfig` defaults to
    # "off" — so a fresh multi-host join would come up with NO Linear ingestion
    # at all: no state-change, no issue-update, no comment events. It would not
    # even look broken, because `webhook-ingestion` is satisfied by the GitHub
    # route alone. Removing a path without enabling its successor is how a node
    # ends up silently blind.
    #
    # `//=` so it is NON-CLOBBER: a node that already declares a mode (or an
    # operator who has deliberately set "off"/"shadow") keeps its own value;
    # only an ABSENT key is filled.
    #
    # "enforce" is the safe value to default to, not an aggressive one: the
    # producer's own readiness gate fails CLOSED (defaultReplicaFresh — absent,
    # unreadable, malformed or stale replica all read as NOT fresh), so the feed
    # only becomes authoritative on a host whose replica writer is actually
    # alive. The alternative default — "off" — cannot become authoritative
    # under any condition, which on a post-cutover fleet means permanently no
    # Linear dispatch. Note the live minis carry this as an ENV var in
    # execution-core.env rather than in Layer-2, so this fills a genuinely
    # empty key on a joining node rather than fighting an existing one.
    #
    # ⛔ CTL-2004: the GITHUB half of the very same rule, which the Linear half above
    # has had since CTL-1928 and this leg never got. The write directly above hands a
    # joining node `monitor.github.smeeChannel` — a tunnel CHANNEL. What decides whether
    # it OPENS is `.catalyst.githubFeed.mode`: `githubFeedIsAuthoritative()` is
    # `mode === "enforce"`, orch-monitor suppresses the tunnel only on that, and the mode
    # resolves env -> Layer-2 -> default "off". Layer-1 does not carry it. So a node
    # joining a fleet that has already cut over was handed the channel and no mode, read
    # the "off" default as not-authoritative, and came up on SMEE — healthy, green, and on
    # the exact transport the cutover retired. Same shape as the Linear comment above:
    # carrying a route without carrying the posture that governs it is how a node ends up
    # silently on the wrong one.
    #
    # ⚠️ Deliberately the SEED'S value, never a hardcoded "enforce". The Linear leg can
    # safely default to enforce because its producer's readiness gate fails CLOSED. The
    # GitHub feed is mid-rollout, so pinning a joining host to "enforce" while the fleet
    # is still in shadow would shut its tunnel BEFORE the cloud feed is authoritative for
    # it and drop github.* events wholesale — the CI wait, monitor-merge and the broker's
    # PR-lifecycle routing. Inheriting the seed's declared posture is the only value that
    # is correct at every point of the rollout.
    #
    # `//=` so it is NON-CLOBBER, matching the line above: an operator's existing value
    # wins, only an ABSENT key is filled. A bundle with no githubFeed writes nothing at
    # all — `$gf` is null and the `//=` is guarded — so an older seed degrades to exactly
    # today's behaviour rather than being pinned to a posture nobody declared.
    local bundle_gf
    bundle_gf="$(echo "$BUNDLE_JSON" | jq -c '.githubFeed // null')" || bundle_gf="null"
    # CTL-1210: split webhook writes by key class.
    # SHARED (monitor.github.smeeChannel)         → $CLUSTER_SECRETS_CONFIG.
    # NODE   (cloudFeed.mode, githubFeed.mode)    → $cfg_node (node.json).
    local tmp_shared tmp_node
    tmp_shared="$(mktemp "$(dirname "$cfg")/.cluster-secrets.XXXXXX")"
    chmod 0600 "$tmp_shared" 2>/dev/null || true
    # merge $wh (monitor block) into cluster-secrets.json (non-clobber for monitor sub-keys).
    jq --argjson wh "$monitor_wh_stripped" '
        .catalyst //= {}
        | .catalyst.monitor = ($wh * (.catalyst.monitor // {}))
      ' "$cfg" > "$tmp_shared" && mv "$tmp_shared" "$cfg" || { rm -f "$tmp_shared"; return 1; }
    # cloudFeed.mode + githubFeed.mode (per-node tunables) → node.json (non-clobber).
    if [[ ! -f "$cfg_node" ]]; then echo '{}' > "$cfg_node"; chmod 0600 "$cfg_node" 2>/dev/null || true; fi
    tmp_node="$(mktemp "$(dirname "$cfg_node")/.node.XXXXXX")"
    chmod 0600 "$tmp_node" 2>/dev/null || true
    jq --argjson gf "$bundle_gf" '
        .catalyst //= {}
        | .catalyst.cloudFeed //= {} | .catalyst.cloudFeed.mode //= "enforce"
        | if ($gf | type) == "object" and ($gf.mode | type) == "string"
          then .catalyst.githubFeed //= {} | .catalyst.githubFeed.mode //= $gf.mode
          else . end
      ' "$cfg_node" > "$tmp_node" && mv "$tmp_node" "$cfg_node" || { rm -f "$tmp_node"; return 1; }
    local cf_mode gf_mode
    cf_mode="$(jq -r '.catalyst.cloudFeed.mode // "unset"' "$cfg_node" 2>/dev/null)"
    gf_mode="$(jq -r '.catalyst.githubFeed.mode // "unset"' "$cfg_node" 2>/dev/null)"
    if [[ "$github_wired" == "no" ]]; then
      info "webhook ingestion NOT wired (rule=${rule} mode=${CATALYST_DEPLOYMENT_MODE_RESOLVED} roster=${roster_len:-0}) | bundle carried ONLY the retired Linear block (CTL-1928); cloudFeed=${cf_mode} githubFeed=${gf_mode}"
    else
      info "webhook ingestion wired (rule=${rule} mode=${CATALYST_DEPLOYMENT_MODE_RESOLVED} roster=${roster_len:-0} github-only=yes linear-stripped=${stripped_linear} cloudFeed=${cf_mode} githubFeed=${gf_mode} CTL-1928/CTL-2004)"
    fi
  else
    info "webhook ingestion NOT wired (rule=${rule} mode=${CATALYST_DEPLOYMENT_MODE_RESOLVED} roster=${roster_len:-0})"
  fi
}

persist_host_name() {
  # CTL-1210: host.name is a per-node key — write to node.json, not config.json.
  local cfg="$NODE_CONFIG"
  local host_name="${CATALYST_HOST_NAME:-}"
  if [[ -z "$host_name" ]]; then
    host_name="$(hostname -s 2>/dev/null || hostname | sed 's/\.local$//')"
    host_name="${host_name%.local}"
  fi
  if [[ ! -f "$cfg" ]]; then
    echo '{}' > "$cfg"
    chmod 0600 "$cfg" 2>/dev/null || true  # holds identity; protect immediately (CTL-1203)
  fi
  local tmp
  tmp="$(mktemp "$(dirname "$cfg")/.node.XXXXXX")"
  chmod 0600 "$tmp" 2>/dev/null || true
  jq --arg hn "$host_name" '.catalyst.host.name = $hn' "$cfg" > "$tmp" && mv "$tmp" "$cfg" || { rm -f "$tmp"; return 1; }
  info "host.name set to: ${host_name}"
  # CTL-1185 remediate: return the host name via a global, NOT via stdout. The
  # caller captures host_name="$(persist_host_name)"; echoing here makes command
  # substitution capture the info() line above too, so write_local_roster stored
  # a polluted multi-line value and local-hosts.json became
  # ["[join] host.name set to: <h>\n<h>"] instead of ["<h>"] (verify HIGH finding).
  PERSISTED_HOST_NAME="$host_name"
}

# CTL-1231: provision ~/.claude/settings.json (telemetry posture + autonomy
# defaults) and the daemon's OTLP endpoint. Runs AFTER persist_host_name so the
# per-host OTEL_RESOURCE_ATTRIBUTES can be synthesized from PERSISTED_HOST_NAME.
provision_claude_settings() {
  local host_name="$1"
  [[ -n "$host_name" ]] || { warn "provision_claude_settings: empty host name — skipping"; return 0; }
  local settings_dir="$HOME/.claude"
  local settings="$settings_dir/settings.json"
  local cs otlp
  cs="$(echo "$BUNDLE_JSON" | jq '.claudeSettings // null')"
  otlp="$(bundle_get '.otlpEndpointHint')"

  mkdir -p "$settings_dir"
  [[ -f "$settings" ]] || echo '{}' > "$settings"

  local tmp
  tmp="$(mktemp "${settings_dir}/.settings.XXXXXX")"
  # Deep-merge the shared slice UNDER the existing file ($shared * existing →
  # existing wins, non-clobber so a hand-tuned member file is preserved), then
  # ALWAYS synthesize the per-host OTEL_RESOURCE_ATTRIBUTES (never copy the
  # seed's host.name) and set the OTLP endpoint with //= (member override wins).
  jq \
    --argjson cs "$cs" \
    --arg host "$host_name" \
    --arg otlp "$otlp" \
    '
      ( if $cs == null then {} else $cs end ) as $shared
      | ($shared * .)
      | .env //= {}
      | .env.OTEL_RESOURCE_ATTRIBUTES = ("host.name=" + $host)
      | ( if $otlp != "" then .env.OTEL_EXPORTER_OTLP_ENDPOINT //= $otlp else . end )
    ' "$settings" > "$tmp" && mv "$tmp" "$settings" || { rm -f "$tmp"; return 1; }
  chmod 0644 "$settings" 2>/dev/null || true
  info "~/.claude/settings.json provisioned (host.name=${host_name})"

  # Daemon-context endpoint: the launchd execution-core daemon and the
  # bg-workers it spawns read OTEL_EXPORTER_OTLP_ENDPOINT from this env file, NOT
  # from settings.json. Unset → all worker telemetry exports nowhere. Append
  # only when absent — NEVER overwrite (preserves proxy/CA lines, etc.).
  if [[ -n "$otlp" ]]; then
    local ec_env="$HOME/.config/catalyst/execution-core.env"
    mkdir -p "$(dirname "$ec_env")"
    touch "$ec_env"
    if ! grep -q '^OTEL_EXPORTER_OTLP_ENDPOINT=' "$ec_env" 2>/dev/null; then
      printf 'OTEL_EXPORTER_OTLP_ENDPOINT=%s\n' "$otlp" >> "$ec_env"
      info "daemon OTLP endpoint written to execution-core.env"
    fi
  fi
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
  provision_claude_settings "$PERSISTED_HOST_NAME" || return 1
  write_local_roster "$PERSISTED_HOST_NAME" || return 1
}

do_doctor_gate() {
  # catalyst-doctor (CTL-1186) is the fail-closed activation gate: exit 0 iff zero
  # FAIL-level checks (warns/info are expected on a fresh SHADOW node — no Linear
  # token, no liveness anchor, single-host roster). --dry-run is a documented
  # no-op (all checks are read-only); we pass it to make the intent explicit.
  # Gate strictly on [$? -eq 0] per the doctor contract. This replaces the old
  # default of check-setup.sh, a cwd-relative full-workstation check that exits
  # nonzero on a fresh node (the reason mini-2's join needed a manual marker poke).
  #
  # CTL-1473: CATALYST_DOCTOR_PREINSTALL=1 downgrades install-remediable FAILs to
  # WARNs (e.g. missing log-shipper, which will be fixed by do_install_stack below).
  # The post-install strict verify (do_doctor_verify) then re-checks without the flag.
  #
  # #2918 follow-up (Codex P1): thread the SAME Layer-1 the webhook-wiring
  # gate consulted (provisioner-parity plugin-source checkout) into the doctor
  # run — the deployment-mode resolver's own Layer-1 default is CWD-relative
  # (the operator's invocation directory), so without this the doctor gate
  # resolves an inferred default and keeps the webhook-ingestion FAIL on a
  # declared non-cluster join that the wiring gate intentionally skipped.
  local _doctor_l1="${CATALYST_PLUGIN_SOURCE:-${HOME}/catalyst/plugin-source}/.catalyst/config.json"
  if CATALYST_DOCTOR_PREINSTALL=1 CATALYST_CONFIG_FILE="$_doctor_l1" bash "$DOCTOR_SCRIPT" --dry-run >/dev/null 2>&1; then
    info "Doctor gate passed (catalyst-doctor: 0 FAIL checks, preinstall mode)."
    return 0
  else
    fail "Activation gate (catalyst-doctor) reported FAIL check(s). Run '${DOCTOR_SCRIPT}' for details."
    return 1
  fi
}

do_doctor_verify() {
  # CTL-1473: strict post-install doctor check (no PREINSTALL downgrade).
  # Runs AFTER do_install_stack to catch any install-remediable issues that were
  # not actually remediated (e.g. an ephemeral shipper --config path).
  # Threads the same provisioner-parity Layer-1 as the pre-install gate (#2918).
  local _doctor_l1="${CATALYST_PLUGIN_SOURCE:-${HOME}/catalyst/plugin-source}/.catalyst/config.json"
  if CATALYST_CONFIG_FILE="$_doctor_l1" bash "$DOCTOR_SCRIPT" --dry-run >/dev/null 2>&1; then
    info "Post-install doctor verify passed (catalyst-doctor: 0 FAIL checks)."
    return 0
  else
    fail "Post-install verify (catalyst-doctor) reported FAIL check(s). Run '${DOCTOR_SCRIPT}' for details."
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
  # github-auth + provision-thoughts MUST precede setup-catalyst: setup-catalyst's
  # thoughts-init binds the checkout to the cloned thoughts repos + humanlayer.json
  # that provision-thoughts creates (CTL-1214 PATH-B #6). Stages are append-only in
  # the resume marker, so a re-run skips completed stages by name.
  run_stage "github-auth"         do_github_auth          || exit 1
  run_stage "provision-thoughts"  do_provision_thoughts   || exit 1
  run_stage "setup-catalyst"      do_setup_catalyst       || exit 1
  run_stage "install-cli"         do_install_cli          || exit 1
  run_stage "setup-plugin-source" do_setup_plugin_source  || exit 1

  # setup-catalyst installs node/bun into ~/.local/node/bin + ~/.bun/bin in a
  # CHILD shell, so the parent join shell's PATH doesn't see them. The doctor
  # gate (catalyst-doctor needs a bun/node runtime) and the stack stage run in
  # THIS shell — prepend the install bins + hash -r so they resolve on a truly
  # fresh node where the launching shell had no node/bun (CTL-1214 verify).
  export PATH="$HOME/.local/node/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"
  hash -r 2>/dev/null || true

  # 5. SHARED config merge + per-node items
  run_stage "config-merge" do_config_merge || exit 1

  # 6. Doctor gate (T4) — pre-install, PREINSTALL mode (install-remediable FAILs → WARN)
  run_stage "doctor" do_doctor_gate || exit 1

  # 7. Install launchd stack LAST (Stage-0 SHADOW)
  run_stage "stack" do_install_stack || exit 1

  # 8. Post-install strict doctor verify (CTL-1473): confirms install-remediable
  #    issues are actually resolved (no PREINSTALL downgrade this time).
  run_stage "doctor-verify" do_doctor_verify || exit 1

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
