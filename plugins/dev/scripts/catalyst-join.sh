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
# (global fallback → coalesce-labs, deterministic repoMappings), verify auth.
# Orgs are derived data-driven from the node's execution-core registry when
# present, else from the bundle's repoUrl org (coalesce-labs primary) — never a
# hardcoded list. MUST run before setup-catalyst, whose thoughts-init binds the
# checkout to these repos + humanlayer.json.
do_provision_thoughts() {
  local pt="$PROVISION_THOUGHTS_SCRIPT"
  [[ -x "$pt" ]] || { fail "provision-thoughts.sh not found/executable at $pt"; return 1; }
  local args=(--node-user "${USER:-$(whoami)}")
  local registry="${CATALYST_DIR}/execution-core/registry.json"
  [[ -f "$registry" ]] || registry="${CATALYST_DIR}/plugin-source/plugins/dev/scripts/execution-core/registry.json"
  if [[ -f "$registry" ]]; then
    args+=(--registry "$registry")
  else
    # First-join fallback: registry isn't written yet, so derive the primary org
    # from the bundle's repoUrl. repoUrl is "<org>/<repo>" (join-bundle.mjs); also
    # tolerate a full https URL. (A bare `${url%%/*}` would yield "https:".)
    local repo_url org
    repo_url="$(bundle_get '.repoUrl')"
    org="$(sed -nE 's#^(https?://[^/]+/)?([^/]+)/.*#\2#p' <<<"$repo_url")"
    [[ -n "$org" ]] && args+=(--orgs "$org")
  fi
  if bash "$pt" "${args[@]}"; then
    return 0
  fi
  # provision-thoughts failed — usually push-auth (an M2 precondition), not the
  # clone. If the primary thoughts repo is present AND has a usable HEAD (a real
  # read-OK clone, not a partial/interrupted one), severity depends on whether
  # this node will own work.
  local primary="${CATALYST_DIR:-$HOME/catalyst}/hlt/coalesce-labs/thoughts"
  if [[ -d "$primary/.git" ]] && git -C "$primary" rev-parse --verify -q HEAD >/dev/null 2>&1; then
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
  if [[ "${roster_len:-0}" -gt 1 && "$monitor_wh" != "null" ]]; then
    local tmp2
    tmp2="$(mktemp "$(dirname "$cfg")/.config.XXXXXX")"
    # Deep-merge ($wh * existing): existing node-local values WIN (non-clobber),
    # new keys from the bundle are added.
    jq --argjson wh "$monitor_wh" '
        .catalyst //= {}
        | .catalyst.monitor = ($wh * (.catalyst.monitor // {}))
      ' "$cfg" > "$tmp2" && mv "$tmp2" "$cfg" || { rm -f "$tmp2"; return 1; }
    info "webhook ingestion wired (multiHost roster=${roster_len})"
  else
    info "webhook ingestion NOT wired (roster=${roster_len:-0}) — single-host double-dispatch guard"
  fi
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
  if bash "$DOCTOR_SCRIPT" --dry-run >/dev/null 2>&1; then
    info "Doctor gate passed (catalyst-doctor: 0 FAIL checks)."
    return 0
  else
    fail "Activation gate (catalyst-doctor) reported FAIL check(s). Run '${DOCTOR_SCRIPT}' for details."
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
