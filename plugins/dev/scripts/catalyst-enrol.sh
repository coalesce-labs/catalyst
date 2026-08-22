#!/usr/bin/env bash
# catalyst-enrol.sh — CTL-1985. One-key host enrollment installer.
#
# USAGE
#   catalyst enrol --cloud-key ctc_acct_… [OPTIONS]
#   catalyst enrol --help
#
# OPTIONS
#   --cloud-key KEY         Per-host organization key (ctc_acct_… prefix). Required.
#                           When omitted and stdin is a TTY, prompts without echo.
#   --cloud-account ID      Cloud account/tenant ID. Required (no default — the built-in
#                           fallback is the maintainer's own tenant, which you do not want).
#   --cloud-base-url URL    Override the cloud hub URL (default: staging.catalystcloud.dev).
#   --age-key-file PATH     Use an existing age private key instead of generating one.
#                           The supplied file stays where it is; only its recipient is
#                           registered. No keychain write for operator-supplied keys (Q2).
#   --dry-run               Validate + keygen/keychain but stop before daemon start.
#                           Progress marker is written so the real run can resume.
#   --resume                Resume from a previous run's progress marker (skip completed stages).
#   --help, -h              Print this help and exit.
#
# ENVIRONMENT OVERRIDES (for testing — never set in production)
#   ENROL_CURL              Path to curl binary
#   ENROL_SECURITY          Path to security(1) binary (macOS keychain)
#   ENROL_AGE_KEYGEN        Path to age-keygen binary
#   ENROL_STACK             Path to catalyst-stack binary
#   CATALYST_SOURCE_DIR     Override plugin scripts directory
#   CATALYST_CLOUD_BASE_URL Override cloud hub URL (production override)
#
# SAFETY ORDERING (CTL-1985 AC):
#   1. Validate key shape (no network, no disk write)
#   2. Validate token + binding against cloud (no disk write)
#   3. Generate or accept age keypair (temp file, shredded)
#   4. Store PRIVATE key in OS keychain — HARD FAIL if unavailable; NEVER disk fallback
#   5. Register PUBLIC recipient with cloud
#   6. Write ~/.config/catalyst/cloud-sync.env (0600)
#   7. Start daemons via catalyst-stack
#
# At end: the cloud org key is the only credential on this host not cloud-sourced.

set -euo pipefail

# ── Resolve scripts directory ─────────────────────────────────────────────────
_self_dir() { cd "$(dirname "${BASH_SOURCE[0]}")" && pwd; }
SCRIPTS_DIR="${CATALYST_SOURCE_DIR:-$(_self_dir)}"
LIB_DIR="${SCRIPTS_DIR}/lib"

# ── External command overrides (injectable for tests) ─────────────────────────
ENROL_CURL="${ENROL_CURL:-curl}"
ENROL_SECURITY="${ENROL_SECURITY:-security}"
ENROL_AGE_KEYGEN="${ENROL_AGE_KEYGEN:-}"
ENROL_STACK="${ENROL_STACK:-catalyst-stack}"

# ── Output helpers ────────────────────────────────────────────────────────────
_ok()   { echo "  ✓ $*"; }
_err()  { echo "  ✗ $*" >&2; }
_info() { echo "  · $*"; }
_warn() { echo "  ⚠ $*" >&2; }

_die() {
	_err "$*"
	exit 1
}

# ── Progress marker helpers ───────────────────────────────────────────────────
CATALYST_DIR="${CATALYST_DIR:-${HOME}/catalyst}"
ENROL_DIR="${CATALYST_DIR}/enrol"
MARKER_FILE="${ENROL_DIR}/progress.json"

_marker_init() {
	mkdir -p "$ENROL_DIR"
	# Resume: keep existing file. Otherwise, don't create the file yet;
	# _marker_add creates it on first successful stage so a rejected key
	# leaves no progress.json artifact.
	if [[ "${RESUME:-0}" -eq 1 && -f "$MARKER_FILE" ]]; then
		return 0
	fi
}

_marker_has() {
	local stage="$1"
	[[ -f "$MARKER_FILE" ]] && \
		jq -e --arg s "$stage" '.completedStages | index($s) != null' "$MARKER_FILE" >/dev/null 2>&1
}

_marker_add() {
	local stage="$1"
	if [[ ! -f "$MARKER_FILE" ]]; then
		local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		jq -n --arg ts "$ts" '{completedStages: [], startedAt: $ts}' >"$MARKER_FILE"
		chmod 0600 "$MARKER_FILE"
	fi
	local tmp; tmp="$(mktemp "${ENROL_DIR}/.marker.XXXXXX")"
	jq --arg s "$stage" '.completedStages += [$s]' "$MARKER_FILE" >"$tmp" && mv "$tmp" "$MARKER_FILE" || rm -f "$tmp"
}

_marker_set() {
	local key="$1" val="$2"
	[[ -f "$MARKER_FILE" ]] || return 0
	local tmp; tmp="$(mktemp "${ENROL_DIR}/.marker.XXXXXX")"
	jq --arg k "$key" --arg v "$val" '.[$k] = $v' "$MARKER_FILE" >"$tmp" && mv "$tmp" "$MARKER_FILE" || rm -f "$tmp"
}

_marker_get() {
	local key="$1"
	[[ -f "$MARKER_FILE" ]] || return 0
	jq -r --arg k "$key" '.[$k] // ""' "$MARKER_FILE" 2>/dev/null || echo ""
}

# ── Usage ─────────────────────────────────────────────────────────────────────
usage() {
	grep '^#' "${BASH_SOURCE[0]}" | grep -v '^#!/' | sed 's/^# \?//'
	exit 0
}

# ── Resolve age-keygen path ───────────────────────────────────────────────────
_resolve_age_keygen() {
	if [[ -n "${ENROL_AGE_KEYGEN:-}" && -x "${ENROL_AGE_KEYGEN}" ]]; then
		echo "$ENROL_AGE_KEYGEN"
		return 0
	fi
	# Check non-Homebrew paths first (matching sops candidate posture in catalyst-stack)
	for candidate in \
		"${HOME}/.local/bin/age-keygen" \
		"/usr/local/bin/age-keygen" \
		"/opt/homebrew/bin/age-keygen"; do
		if [[ -x "$candidate" ]]; then
			echo "$candidate"
			return 0
		fi
	done
	if command -v age-keygen >/dev/null 2>&1; then
		command -v age-keygen
		return 0
	fi
	return 1
}

# ── Credential classifier (bash mirror) ──────────────────────────────────────
_classify_key() {
	local token="$1"
	# shellcheck source=/dev/null
	if [[ -f "${LIB_DIR}/catalyst-host-write-credential.sh" ]]; then
		source "${LIB_DIR}/catalyst-host-write-credential.sh"
	else
		_die "Cannot load credential classifier (${LIB_DIR}/catalyst-host-write-credential.sh) — refusing to proceed"
	fi
	# GLOBALS: CATALYST_CREDENTIAL_VERDICT, CATALYST_CREDENTIAL_SHAPE, CATALYST_CREDENTIAL_DETAIL
	catalyst_classify_host_write_credential "$token"
}

# ── Validate cloud token (reuses the setup-catalyst.sh pattern) ───────────────
_validate_cloud_token() {
	local token="$1" account="$2" base_url="$3"
	_info "Validating cloud token against ${base_url} ..."

	local code
	code=$(
		printf 'header = "Authorization: Bearer %s"\n' "$token" |
			"$ENROL_CURL" -sS -o /dev/null -w '%{http_code}' --max-time 20 \
				--config - \
				"${base_url}/issues?account=${account}&limit=1" 2>/dev/null
	) || code=""

	case "$code" in
	200)
		_ok "cloud token validated (HTTP 200, account=${account})"
		return 0
		;;
	401)
		_die "Cloud token REJECTED by the hub (HTTP 401 unauthorized). The token is wrong, expired, or revoked. Nothing has been written."
		;;
	403)
		_die "Token is valid but NOT scoped to account '${account}' (HTTP 403). Nothing has been written."
		;;
	000 | "")
		_die "Could not reach hub at ${base_url} — token was NOT validated. Nothing has been written."
		;;
	*)
		_die "Hub returned HTTP ${code} — token was NOT validated. Nothing has been written."
		;;
	esac
}

# ── Validate per-host binding on agent write path ─────────────────────────────
_validate_cloud_agent_binding() {
	local token="$1" account="$2" base_url="$3"
	local probe_issue="CATALYST-ENROL-PROBE"
	_info "Verifying per-host binding on agent write path ..."

	local code
	code=$(
		printf 'header = "Authorization: Bearer %s"\n' "$token" |
			"$ENROL_CURL" -sS -o /dev/null -w '%{http_code}' --max-time 20 \
				--config - \
				"${base_url}/agent/attachments?issueId=${probe_issue}&account=${account}" 2>/dev/null
	) || code=""

	case "$code" in
	401 | 403)
		_die "Credential REFUSED on agent write path (HTTP ${code}) — not a per-host org key. Nothing has been written."
		;;
	200 | 404 | 400)
		_ok "per-host binding verified on agent write path (HTTP ${code})"
		return 0
		;;
	000 | "")
		_die "Could not reach hub at ${base_url} for binding check. Nothing has been written."
		;;
	*)
		_die "Hub returned HTTP ${code} on binding check — not verified. Nothing has been written."
		;;
	esac
}

# ── Load age-keychain helpers ─────────────────────────────────────────────────
_load_keychain_lib() {
	# shellcheck source=/dev/null
	if [[ -f "${LIB_DIR}/age-keychain.sh" ]]; then
		source "${LIB_DIR}/age-keychain.sh"
	else
		_die "Cannot load keychain library (${LIB_DIR}/age-keychain.sh)"
	fi
}

# ── Generate age keypair ──────────────────────────────────────────────────────
# Sets globals: ENROL_PRIVATE_KEY, ENROL_RECIPIENT
_generate_age_keypair() {
	local keygen
	if ! keygen="$(_resolve_age_keygen)"; then
		_die "age-keygen not found. Install it (e.g. brew install age or ~/.local/bin/age-keygen)."
	fi

	_info "Generating age keypair ..."

	# Temp file with umask 077; shredded on EXIT
	local tmp_key
	tmp_key="$(umask 077; mktemp)"
	trap 'rm -f '"$tmp_key"'' EXIT

	"$keygen" >"$tmp_key" 2>/dev/null || _die "age-keygen failed"

	# Extract the private key line (the AGE-SECRET-KEY-1... line)
	ENROL_PRIVATE_KEY="$(grep '^AGE-SECRET-KEY-' "$tmp_key" | head -1)"
	# Derive the recipient (public key)
	ENROL_RECIPIENT="$("$keygen" -y "$tmp_key" 2>/dev/null)" || _die "Failed to derive recipient from generated key"

	# Shred the temp file immediately — key is now only in ENROL_PRIVATE_KEY
	rm -f "$tmp_key"

	_ok "age keypair generated (recipient: ${ENROL_RECIPIENT})"
}

# ── Get recipient from an existing key file ───────────────────────────────────
_recipient_from_file() {
	local key_file="$1"
	local keygen
	if ! keygen="$(_resolve_age_keygen)"; then
		_die "age-keygen not found — needed to derive recipient from --age-key-file"
	fi
	"$keygen" -y "$key_file" 2>/dev/null || _die "Failed to derive recipient from ${key_file}"
}

# ── Submit public recipient to the cloud (seamed) ─────────────────────────────
_submit_recipient() {
	local token="$1" account="$2" base_url="$3" recipient="$4"

	# ENROL_RECIPIENT_ENDPOINT — seam for tests + future catalyst-cloud wiring.
	# Skipped when the endpoint is not configured (the endpoint lives in catalyst-cloud,
	# not this repo — Phase 4 open item).
	local endpoint="${ENROL_RECIPIENT_ENDPOINT:-}"
	if [[ -z "$endpoint" ]]; then
		_info "Recipient registration skipped — ENROL_RECIPIENT_ENDPOINT not configured (catalyst-cloud CTC-739)"
		return 0
	fi

	_info "Registering public recipient with cloud ..."

	local code
	code=$(
		printf 'header = "Authorization: Bearer %s"\n' "$token" |
			"$ENROL_CURL" -sS -o /dev/null -w '%{http_code}' --max-time 20 \
				--config - \
				-X POST \
				-H "Content-Type: application/json" \
				--data "$(jq -n --arg r "$recipient" --arg a "$account" '{recipient: $r, account: $a}')" \
				"${endpoint}" 2>/dev/null
	) || code=""

	case "$code" in
	200 | 201 | 204)
		_ok "public recipient registered with cloud"
		return 0
		;;
	401 | 403)
		_die "Recipient registration rejected by cloud (HTTP ${code}) — aborting before daemon start."
		;;
	000 | "")
		_die "Could not reach enrollment endpoint — aborting before daemon start."
		;;
	*)
		_die "Cloud returned HTTP ${code} on recipient registration — aborting before daemon start."
		;;
	esac
}

# ── Write cloud-sync.env ──────────────────────────────────────────────────────
_write_cloud_sync_env() {
	local token="$1" account="$2" base_url="$3"
	local config_dir="${HOME}/.config/catalyst"
	local env_file="${config_dir}/cloud-sync.env"

	mkdir -p "$config_dir"
	chmod 700 "$config_dir" 2>/dev/null || true

	local tmp_env
	tmp_env="$(umask 077; mktemp)"
	{
		echo "# Written by catalyst-enrol.sh (CTL-1985)."
		echo "export CATALYST_CLOUD_TOKEN=${token}"
		echo "export CATALYST_CLOUD_ACCOUNT=${account}"
		echo "export CATALYST_CLOUD_BASE_URL=${base_url}"
	} >"$tmp_env"
	mv "$tmp_env" "$env_file"
	chmod 0600 "$env_file"
	_ok "Wrote ${env_file} (0600)"
}

# ── Start daemons ─────────────────────────────────────────────────────────────
_start_daemons() {
	local stack="$ENROL_STACK"

	if ! command -v "$stack" >/dev/null 2>&1; then
		_warn "catalyst-stack not found on PATH — run 'catalyst-stack adopt-cloud-sync' and 'catalyst-stack start' manually"
		return 0
	fi

	_info "Adopting cloud-sync writer ..."
	"$stack" adopt-cloud-sync 2>&1 | sed 's/^/    /' || \
		_warn "catalyst-stack adopt-cloud-sync returned non-zero (continuing)"

	_info "Starting daemons ..."
	"$stack" start 2>&1 | sed 's/^/    /' || \
		_warn "catalyst-stack start returned non-zero (continuing)"

	_ok "Daemons started"
}

# ── Arg parsing ───────────────────────────────────────────────────────────────
CLOUD_KEY=""
CLOUD_ACCOUNT=""
CLOUD_BASE_URL="${CATALYST_CLOUD_BASE_URL:-https://staging.catalystcloud.dev/api/v1}"
AGE_KEY_FILE=""
DRY_RUN=0
RESUME=0

while [[ $# -gt 0 ]]; do
	case "$1" in
	--cloud-key)
		[[ $# -ge 2 ]] || _die "--cloud-key requires a value"
		CLOUD_KEY="$2"; shift 2 ;;
	--cloud-account)
		[[ $# -ge 2 ]] || _die "--cloud-account requires a value"
		CLOUD_ACCOUNT="$2"; shift 2 ;;
	--cloud-base-url)
		[[ $# -ge 2 ]] || _die "--cloud-base-url requires a value"
		CLOUD_BASE_URL="$2"; shift 2 ;;
	--age-key-file)
		[[ $# -ge 2 ]] || _die "--age-key-file requires a value"
		AGE_KEY_FILE="$2"; shift 2 ;;
	--dry-run) DRY_RUN=1; shift ;;
	--resume) RESUME=1; shift ;;
	--help | -h) usage ;;
	*) _die "Unknown option: $1" ;;
	esac
done

# ── Interactive key prompt (non-interactive: fail) ────────────────────────────
if [[ -z "$CLOUD_KEY" ]]; then
	if [[ -t 0 && -t 1 ]]; then
		printf 'Enter cloud org key (ctc_acct_…): '
		read -rs CLOUD_KEY
		echo ""
	else
		_die "No cloud key supplied. Pass --cloud-key ctc_acct_… or run interactively."
	fi
fi

if [[ -z "$CLOUD_ACCOUNT" ]]; then
	_die "No cloud account supplied. Pass --cloud-account <id>."
fi

# ── Main flow ─────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  catalyst enrol (CTL-1985)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

_marker_init

# Resume: read stored values if --resume was passed
if [[ "$RESUME" -eq 1 && -f "$MARKER_FILE" ]]; then
	stored_key="$(_marker_get cloudKey)"
	stored_acct="$(_marker_get cloudAccount)"
	[[ -n "$stored_key" ]] && CLOUD_KEY="$stored_key"
	[[ -n "$stored_acct" ]] && CLOUD_ACCOUNT="$stored_acct"
	stored_age_file="$(_marker_get ageKeyFile)"
	[[ -n "$stored_age_file" ]] && AGE_KEY_FILE="$stored_age_file"
fi

# ── Stage: validate ───────────────────────────────────────────────────────────
if ! _marker_has "validated"; then
	_info "Stage: credential validation"

	# §1 Classify key shape — NO network, NO disk write
	_classify_key "$CLOUD_KEY" || {
		_err "The cloud token is NOT a per-host org-key — got ${CATALYST_CREDENTIAL_SHAPE:-unknown}."
		_err "Class:  ${CATALYST_CREDENTIAL_VERDICT:-unknown}"
		_err "Detail: ${CATALYST_CREDENTIAL_DETAIL:-unknown}"
		_err "A host write credential must start '${CATALYST_HOST_WRITE_CREDENTIAL_PREFIX:-ctc_acct_}'. Nothing has been written."
		_err ""
		_err "Required: a per-host organization key (ctc_acct_…)."
		exit 1
	}
	_ok "cloud credential shape valid (${CATALYST_CREDENTIAL_SHAPE})"

	# §2 Validate token against cloud (reads /issues, one network call)
	_validate_cloud_token "$CLOUD_KEY" "$CLOUD_ACCOUNT" "$CLOUD_BASE_URL"

	# §3 Validate per-host binding
	_validate_cloud_agent_binding "$CLOUD_KEY" "$CLOUD_ACCOUNT" "$CLOUD_BASE_URL"

	_marker_add "validated"
	_marker_set "cloudKey" "$CLOUD_KEY"
	_marker_set "cloudAccount" "$CLOUD_ACCOUNT"
	[[ -n "$AGE_KEY_FILE" ]] && _marker_set "ageKeyFile" "$AGE_KEY_FILE"
fi

# ── Stage: keychain-stored ────────────────────────────────────────────────────
if ! _marker_has "keychain-stored"; then
	_info "Stage: age keypair + keychain storage"
	_load_keychain_lib

	if [[ -n "$AGE_KEY_FILE" ]]; then
		# Operator-supplied key: derive recipient, skip generation and keychain write (Q2)
		[[ -f "$AGE_KEY_FILE" ]] || _die "--age-key-file does not exist: ${AGE_KEY_FILE}"
		ENROL_RECIPIENT="$(_recipient_from_file "$AGE_KEY_FILE")"
		_ok "Using supplied age key — recipient: ${ENROL_RECIPIENT}"
		# Do not store in keychain (operator owns this file and its lifecycle)
	elif age_keychain_present; then
		# Idempotency: key already in keychain — read recipient, skip regeneration
		_info "Age key already in keychain — skipping regeneration"
		local_keygen=""
		if local_keygen="$(_resolve_age_keygen)"; then
			tmp_key="$(umask 077; mktemp)"
			age_keychain_read >"$tmp_key" 2>/dev/null || true
			ENROL_RECIPIENT="$("$local_keygen" -y "$tmp_key" 2>/dev/null)" || ENROL_RECIPIENT=""
			rm -f "$tmp_key"
		fi
		[[ -n "${ENROL_RECIPIENT:-}" ]] || ENROL_RECIPIENT="(unknown — age-keygen not available)"
		_ok "Using existing keychain key — recipient: ${ENROL_RECIPIENT}"
	else
		# Generate a new keypair
		_generate_age_keypair  # sets ENROL_PRIVATE_KEY, ENROL_RECIPIENT

		# ⛔ HARD FAIL: store private key in keychain — NEVER write to disk
		_info "Storing private key in OS keychain (service: $(age_keychain_service_name)) ..."
		if ! age_keychain_store "${ENROL_PRIVATE_KEY}"; then
			_err "FATAL: keychain write failed — aborting enrollment."
			_err ""
			_err "The age private key was NOT written to disk (as required by CTL-1985 AC)."
			_err "Check that the macOS keychain is accessible (not locked, not in a headless"
			_err "session without keychain access). The credential is ONLY in memory and is"
			_err "discarded now."
			exit 1
		fi
		# Clear the private key from memory as soon as it's in the keychain
		ENROL_PRIVATE_KEY=""
		_ok "Private key stored in OS keychain"
	fi

	_marker_add "keychain-stored"
fi

# ── Stage: recipient-registered ───────────────────────────────────────────────
if ! _marker_has "recipient-registered"; then
	_info "Stage: recipient registration"
	_submit_recipient "$CLOUD_KEY" "$CLOUD_ACCOUNT" "$CLOUD_BASE_URL" "${ENROL_RECIPIENT:-}"
	_marker_add "recipient-registered"
fi

# ── Dry-run stop ──────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" -eq 1 ]]; then
	echo ""
	_ok "dry-run complete — validation and key setup done"
	_info "Re-run without --dry-run to write cloud-sync.env and start daemons."
	exit 0
fi

# ── Stage: enrolled ───────────────────────────────────────────────────────────
if ! _marker_has "enrolled"; then
	_info "Stage: environment pull + daemon start"

	_write_cloud_sync_env "$CLOUD_KEY" "$CLOUD_ACCOUNT" "$CLOUD_BASE_URL"
	_start_daemons

	_marker_add "enrolled"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
_ok "Host enrollment complete."
echo ""
echo "  This host is now enrolled in the Catalyst Cloud."
echo "  The cloud org key is the only credential not cloud-sourced on this host."
echo ""
echo "  Next: run 'catalyst doctor' to verify the installation."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
