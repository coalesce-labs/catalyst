#!/bin/bash
# setup-catalyst.sh - Complete Catalyst setup in one command
# Usage: curl -fsSL https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh | bash
#        OR ./setup-catalyst.sh [--non-interactive|--defaults]
#        Headless (CI/SSH/cron): --non-interactive or CATALYST_AUTONOMOUS=1 — prompts use
#        defaults, integrations configure only from discoverable tokens (LINEAR_API_TOKEN, etc.)

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Global variables
PROJECT_DIR=""
PROJECT_KEY=""
ORG_NAME=""
REPO_NAME=""
ORG_ROOT=""
THOUGHTS_REPO=""
WORKTREE_BASE=""
USER_NAME=""
NON_INTERACTIVE=0
# CTL-1836: Catalyst Cloud replica provisioning. Empty → the cloud path is a
# no-op and setup behaves exactly as it did before the flags existed.
CLOUD_TOKEN=""
CLOUD_ACCOUNT=""

#
# Utility functions
#

print_header() {
	echo ""
	echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
	echo -e "${BLUE}$1${NC}"
	echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
	echo ""
}

print_success() {
	echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
	echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
	echo -e "${RED}✗ $1${NC}"
}

# True when /dev/tty can actually be opened (existence alone is not enough:
# with no controlling tty, open(2) fails ENXIO — "Device not configured").
# The subshell absorbs the failed open so `set -e` does not kill the script.
can_open_tty() {
	(: </dev/tty) 2>/dev/null
}

#
# ── CTL-1914 / CTL-1918: ONE resolver for the Catalyst source tree ──
#
# Four separate steps below need a helper script that lives in `plugins/dev/scripts`
# of a Catalyst checkout: the orphan-sweep launchd installer, the Linear state
# contract, `setup-plugin-source.sh`, and `install-cli.sh`. Each used to resolve it
# relative to THIS script's own directory — which, in the install path every
# user-facing doc gives (`curl -O … && ./setup-catalyst.sh`), contains nothing but
# setup-catalyst.sh. So each degraded to a silent skip, and the documented install
# produced a materially more-broken machine than a repo clone.
#
# ⛔ The resolution is CENTRAL rather than per-call-site on purpose: four copies of a
# lookup are four chances for the next one to skip silently, and the reason the
# original defect survived is that each site failed in its own private way.
#
# Resolution order (first usable tree wins):
#   1. $CATALYST_SOURCE_DIR / --source-dir   — an operator override
#   2. next to this script                   — the repo-clone layout
#   3. $PROJECT_DIR                          — setup was run inside a Catalyst checkout
#   4. the plugin-source checkout            — what the daemons already run from
#   5. clone one                             — the documented-curl bootstrap
#
# Step 5 clones to the SAME default path `setup-plugin-source.sh` uses
# (`~/catalyst/plugin-source`), so the bootstrap clone IS the plugin-source checkout
# and that script then reuses it rather than cloning a second copy.
CATALYST_SOURCE_DIR_RESOLVED=""
# Which candidate won, and why a resolution failed. Both are read by callers and by
# __tests__/setup-catalyst-source-resolver.test.sh; exported so the answer is visible
# to a child process (and to shellcheck, which cannot see the test's use).
export CATALYST_SOURCE_ORIGIN=""
export CATALYST_SOURCE_REASON=""
NO_CLONE_SOURCE=0

# The marker for "this is a Catalyst source tree". Deliberately a directory rather
# than any single helper: a tree that exists but is missing ONE script must report
# that specific script as missing (`catalyst_helper_path`), not read as "no tree".
catalyst_is_source_tree() {
	[[ -n ${1-} && -d "$1/plugins/dev/scripts" ]]
}

catalyst_source_clone_target() {
	echo "${CATALYST_PLUGIN_SOURCE:-${HOME}/catalyst/plugin-source}"
}

# resolve_catalyst_source — echo a usable source tree, or fail with a NAMED reason.
#
# ⛔ Never echoes a path it has not just validated, and never returns 0 without one.
# "Could not look" and "there is nothing to find" are both failures here, but they are
# DIFFERENT failures and the caller gets to see which: an empty clone that exits 0 is
# the exact success-that-installed-nothing shape this whole ticket is about.
resolve_catalyst_source() {
	if [[ -n $CATALYST_SOURCE_DIR_RESOLVED ]]; then
		echo "$CATALYST_SOURCE_DIR_RESOLVED"
		return 0
	fi
	CATALYST_SOURCE_REASON=""

	local candidate script_dir
	if [[ -n ${CATALYST_SOURCE_DIR-} ]] && catalyst_is_source_tree "${CATALYST_SOURCE_DIR}"; then
		CATALYST_SOURCE_DIR_RESOLVED="$(cd "${CATALYST_SOURCE_DIR}" && pwd)"
		CATALYST_SOURCE_ORIGIN="env"
		echo "$CATALYST_SOURCE_DIR_RESOLVED"
		return 0
	fi

	# `BASH_SOURCE[0]` is empty under `curl … | bash` (the script arrives on stdin), so
	# this candidate simply does not apply there — which is correct, not a bug to work
	# around: there is genuinely no adjacent tree in that layout.
	script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || script_dir=""
	if catalyst_is_source_tree "$script_dir"; then
		CATALYST_SOURCE_DIR_RESOLVED="$script_dir"
		CATALYST_SOURCE_ORIGIN="script-dir"
		echo "$CATALYST_SOURCE_DIR_RESOLVED"
		return 0
	fi

	if catalyst_is_source_tree "${PROJECT_DIR-}"; then
		CATALYST_SOURCE_DIR_RESOLVED="$(cd "${PROJECT_DIR}" && pwd)"
		CATALYST_SOURCE_ORIGIN="project-dir"
		echo "$CATALYST_SOURCE_DIR_RESOLVED"
		return 0
	fi

	candidate="$(catalyst_source_clone_target)"
	if catalyst_is_source_tree "$candidate"; then
		CATALYST_SOURCE_DIR_RESOLVED="$(cd "$candidate" && pwd)"
		CATALYST_SOURCE_ORIGIN="plugin-source"
		echo "$CATALYST_SOURCE_DIR_RESOLVED"
		return 0
	fi

	if [[ $NO_CLONE_SOURCE -eq 1 || -n ${CATALYST_NO_CLONE_SOURCE-} ]]; then
		CATALYST_SOURCE_REASON="no-source-tree"
		return 1
	fi

	# ── the bootstrap clone ──
	# Same shape as setup-plugin-source.sh's own clone (main, single-branch) so the
	# tree it later reuses is the tree it would have made. NOT --depth 1: the fleet's
	# updater and `git merge-base --is-ancestor` checks need real history.
	echo "" >&2
	echo "📦 No Catalyst source tree found — cloning one to $(catalyst_source_clone_target)" >&2
	mkdir -p "$(dirname "$(catalyst_source_clone_target)")" 2>/dev/null || true
	if ! GIT_TERMINAL_PROMPT=0 git clone --branch main --single-branch \
		"${CATALYST_SOURCE_REPO:-https://github.com/coalesce-labs/catalyst.git}" \
		"$(catalyst_source_clone_target)" >/dev/null 2>&1; then
		CATALYST_SOURCE_REASON="clone-failed"
		return 1
	fi
	# ⛔ Validate the RESULT, not the exit code. A clone that exits 0 having produced
	# nothing usable is precisely the failure mode this ticket exists to remove, and
	# trusting rc=0 here would rebuild it one layer up.
	candidate="$(catalyst_source_clone_target)"
	if ! catalyst_is_source_tree "$candidate"; then
		CATALYST_SOURCE_REASON="clone-produced-no-tree"
		return 1
	fi
	CATALYST_SOURCE_DIR_RESOLVED="$(cd "$candidate" && pwd)"
	CATALYST_SOURCE_ORIGIN="cloned"
	echo "$CATALYST_SOURCE_DIR_RESOLVED"
	return 0
}

# catalyst_helper_path <relative-path-under-plugins/dev/scripts>
#
# Echo the absolute path to a helper script, or fail. Sets CATALYST_SOURCE_REASON to
# `missing-helper:<name>` when the tree resolved but this particular script is absent —
# a different fact from "no tree", and one a caller must be able to report distinctly.
#
# ⛔ The resolver is invoked DIRECTLY, never as `$(resolve_catalyst_source)`. Command
# substitution runs in a subshell, so every global the resolver sets — including
# CATALYST_SOURCE_REASON, which is the entire point of failing with a NAMED reason —
# is discarded when the subshell exits, and the caller's deferral prints an empty
# "()" where the diagnosis should be. That is this ticket's own defect one level down:
# a failure that still reports, but reports nothing usable. Callers read
# CATALYST_HELPER_PATH rather than capturing stdout, for the same reason.
CATALYST_HELPER_PATH=""
catalyst_helper_path() {
	local rel="$1"
	CATALYST_HELPER_PATH=""
	resolve_catalyst_source >/dev/null || return 1
	if [[ ! -f "${CATALYST_SOURCE_DIR_RESOLVED}/plugins/dev/scripts/${rel}" ]]; then
		CATALYST_SOURCE_REASON="missing-helper:${rel}"
		return 1
	fi
	CATALYST_HELPER_PATH="${CATALYST_SOURCE_DIR_RESOLVED}/plugins/dev/scripts/${rel}"
	echo "$CATALYST_HELPER_PATH"
}

#
# ── CTL-1918: the deferred-step ledger ──
#
# Setup used to end by PRINTING instructions for steps it could have performed, so
# "install finished" and "the system works" were different states with nothing
# enforcing the gap was closed. Every step now either RUNS or is recorded here — and a
# recorded step carries both the command that completes it AND the command that
# verifies it later, so a deferral is checkable rather than advisory.
CATALYST_DEFERRED_STEPS=()

catalyst_defer_step() {
	# title <TAB> complete-command <TAB> verify-command
	CATALYST_DEFERRED_STEPS+=("${1}"$'\t'"${2}"$'\t'"${3}")
}

print_deferred_steps() {
	local n=${#CATALYST_DEFERRED_STEPS[@]}
	if [[ $n -eq 0 ]]; then
		# Stated positively: an empty section and a section that was never reached read
		# identically, and only one of them means the install is complete.
		echo "✅ No steps were deferred — this node was fully provisioned."
		return 0
	fi
	echo ""
	echo "⚠️  ${n} step(s) were DEFERRED. This node is not fully provisioned until they are done:"
	local entry title complete verify
	for entry in "${CATALYST_DEFERRED_STEPS[@]}"; do
		IFS=$'\t' read -r title complete verify <<<"$entry"
		echo ""
		echo "  • ${title}"
		echo "      run:    ${complete}"
		echo "      verify: ${verify}"
	done
	echo ""
}

print_usage() {
	cat <<'USAGE'
Usage: setup-catalyst.sh [--non-interactive|--defaults]
                         [--cloud-token <token>] [--cloud-account <account>]

  --non-interactive, --defaults   Answer every prompt with its default.

  --cloud-token <token>     Provision the Catalyst Cloud read replica on this host.
                            Env: CATALYST_CLOUD_TOKEN (or the name configured by
                            CATALYST_CLOUD_TOKEN_ENV / Layer-2 catalyst.cloud.tokenEnv).
  --cloud-account <account> REQUIRED whenever a cloud token is supplied. There is
                            deliberately NO default here — see below.
                            Env: CATALYST_CLOUD_ACCOUNT

  --source-dir <path>       Use an existing Catalyst checkout for the helper scripts
                            setup needs (orphan-sweep installer, Linear state contract,
                            plugin-source, CLI installer).
                            Env: CATALYST_SOURCE_DIR
  --no-clone-source         Never clone a Catalyst checkout. Any step that needs one is
                            DEFERRED with the command to complete and verify it, rather
                            than skipped.
                            Env: CATALYST_NO_CLONE_SOURCE=1

Omit the cloud flags and setup behaves exactly as it always has.

Headless install (SSH-only / CI hosts), one command and one key:

  curl -fsSL https://raw.githubusercontent.com/coalesce-labs/catalyst/main/setup-catalyst.sh \
    | bash -s -- --non-interactive \
        --cloud-token "$CATALYST_CLOUD_TOKEN" --cloud-account "$CATALYST_CLOUD_ACCOUNT"

  `-s --` is required for the piped form: without it the flags are consumed by bash
  itself, not by this script, and the install silently runs interactive.
USAGE
}

# Parse CLI flags. CATALYST_AUTONOMOUS is the project-wide headless signal
# (same contract as plugins/dev/scripts/check-project-setup.sh).
parse_args() {
	if [[ -n ${CATALYST_AUTONOMOUS-} ]]; then
		NON_INTERACTIVE=1
	fi
	while [[ $# -gt 0 ]]; do
		case "$1" in
		--non-interactive | --defaults)
			NON_INTERACTIVE=1
			shift
			;;
		# CTL-1836: the Catalyst Cloud replica path. Absent → every behaviour below
		# is byte-identical to before this flag existed, so existing installs are
		# untouched. Env vars are the headless equivalent.
		--cloud-token)
			[[ $# -ge 2 ]] || {
				print_error "--cloud-token requires a value"
				exit 1
			}
			CLOUD_TOKEN="$2"
			shift 2
			;;
		--cloud-account)
			[[ $# -ge 2 ]] || {
				print_error "--cloud-account requires a value"
				exit 1
			}
			CLOUD_ACCOUNT="$2"
			shift 2
			;;
		# CTL-1914: where setup finds the helper scripts it needs. Absent → the
		# resolver's own ordered search, ending in a bootstrap clone.
		--source-dir)
			[[ $# -ge 2 ]] || {
				print_error "--source-dir requires a value"
				exit 1
			}
			CATALYST_SOURCE_DIR="$2"
			shift 2
			;;
		--no-clone-source)
			NO_CLONE_SOURCE=1
			shift
			;;
		-h | --help)
			print_usage
			exit 0
			;;
		*)
			print_error "Unknown option: $1"
			print_usage
			exit 1
			;;
		esac
	done
}

ask_yes_no() {
	local prompt="$1"
	local default="${2:-y}"
	local ni_answer="${3:-$default}"
	local suffix="[y/N]"
	[[ $default == "y" ]] && suffix="[Y/n]"
	local REPLY

	# Non-interactive mode (HEAD/sibling feature): answer with ni_answer
	# without touching stdin. CTL-1214 (PATH-B #5): when check_prerequisites is
	# auto-installing a CRITICAL tool headlessly it sets CATALYST_NI_AUTOINSTALL=1
	# to force-accept the install offer — otherwise the optional-style ni_answer
	# of "n" aborts an autonomous catalyst-join on the HumanLayer/gh prereq gate.
	# The default ni_answer is preserved for every other prompt (tests assert the
	# install offers still decline in plain NI mode).
	if [[ ${NON_INTERACTIVE:-0} -eq 1 ]]; then
		if [[ ${CATALYST_NI_AUTOINSTALL:-0} -eq 1 ]]; then ni_answer="y"; fi
		echo "$prompt $suffix → ${ni_answer} (non-interactive)" >&2
		[[ $ni_answer == "y" ]]
		return
	fi

	# CTL-843: full-line read — `read -n 1` left the trailing newline in stdin,
	# which bled into the next prompt and produced garbage config values. A
	# full-line read keeps consecutive prompts aligned for both interactive
	# terminals and piped stdin; EOF (read rc!=0) falls back to the default.
	read -r -p "$prompt $suffix " REPLY || REPLY=""

	if [[ -z $REPLY ]]; then
		[[ $default == "y" ]]
	else
		[[ $REPLY =~ ^[Yy] ]]
	fi
}

# prompt_value <prompt> <default> — echo the answer; in non-interactive mode
# (or on EOF) echo the default without consuming stdin.
prompt_value() {
	local prompt="$1"
	local default="${2-}"
	local reply=""
	if [[ ${NON_INTERACTIVE:-0} -eq 1 ]]; then
		echo "$prompt [${default}] → ${default} (non-interactive)" >&2
		# printf, not echo: a value of exactly -n/-e/-E is an echo option and would
		# emit nothing, silently blanking that field (e.g. an explicit invalid
		# deployment mode would round-trip to "" and read as unset instead of the
		# recognized:false error). printf '%s' treats the value as data, never a flag.
		printf '%s\n' "$default"
		return 0
	fi
	read -p "$prompt " -r reply || reply=""
	printf '%s\n' "${reply:-$default}"
}

# Merge a patch object into .catalyst.<section> of a config JSON string (CTL-843).
# The prompt run is authoritative for its own keys ($owned, a JSON array) — stale
# owned keys are deleted — and ALL other keys (e.g. linear.agent) are preserved.
merge_catalyst_section() {
	local config="$1" section="$2" patch="$3" owned="$4"
	echo "$config" | jq --arg s "$section" --argjson patch "$patch" --argjson owned "$owned" '
		.catalyst //= {}
		| .catalyst[$s] = (
			((.catalyst[$s] // {}) | with_entries(select(.key as $k | $owned | index($k) | not)))
			+ $patch
		)'
}

# Secret-hygiene primitives (CTL-1203). Inlined for standalone curl-able use.
# The canonical sourceable lib lives at plugins/dev/scripts/lib/secrets-hygiene.sh.

# harden_secrets_dir <dir> — mkdir -p then chmod 700. Idempotent.
harden_secrets_dir() {
	local dir="$1"
	[[ -n $dir ]] || return 1
	mkdir -p "$dir" || return 1
	chmod 700 "$dir"
}

# ensure_secrets_gitignore <dir> — create/update .gitignore with required lines.
ensure_secrets_gitignore() {
	local dir="$1" gi line
	gi="${dir}/.gitignore"
	mkdir -p "$dir" || return 1
	[[ -f $gi ]] || : >"$gi"
	for line in 'config*.json' '*.env'; do
		grep -qxF "$line" "$gi" 2>/dev/null || printf '%s\n' "$line" >>"$gi"
	done
}

# write_secret_file <content> <path> — atomic 600 writer (no JSON validation).
write_secret_file() {
	local content="$1" path="$2" tmp
	tmp="$(mktemp)" || return 1
	(
		umask 077
		printf '%s' "$content" >"$tmp"
	) || {
		rm -f "$tmp"
		return 1
	}
	chmod 600 "$tmp"
	mv "$tmp" "$path"
}

# Write the per-project secrets config safely (CTL-843): validate JSON first,
# back up the existing file (timestamped, 0600), then write atomically (CTL-1203).
write_secrets_config() {
	local content="$1" config_file="$2" validated tmp
	tmp=$(mktemp) || return 1
	if ! echo "$content" | jq . >"$tmp" 2>/dev/null; then
		rm -f "$tmp"
		print_error "Refusing to write invalid JSON to $config_file — existing file left untouched"
		return 1
	fi
	validated="$(cat "$tmp")"
	rm -f "$tmp"
	if [[ -f $config_file ]]; then
		local backup="${config_file}.bak-$(date +%Y%m%d-%H%M%S)"
		cp -p "$config_file" "$backup"
		chmod 600 "$backup"
		print_success "Backed up existing config to $backup"
	fi
	write_secret_file "$validated" "$config_file"
}

#
# Token discovery and validation functions
#

# Discover existing Linear API token from standard locations
discover_linear_token() {
	local token=""

	# Check environment variable
	if [[ -n ${LINEAR_API_TOKEN-} ]]; then
		echo "env" >&2
		echo "$LINEAR_API_TOKEN"
		return 0
	fi

	# Check ~/.linear_api_token file
	if [[ -f ~/.linear_api_token ]]; then
		token=$(cat ~/.linear_api_token | tr -d '[:space:]')
		if [[ -n $token ]]; then
			echo "file" >&2
			echo "$token"
			return 0
		fi
	fi

	return 1
}

# Validate Linear API token and extract org/teams info
validate_linear_token() {
	local token="$1"

	# GraphQL query to get viewer and teams
	local query='
  {
    viewer {
      id
      name
      email
      organization {
        id
        name
        urlKey
      }
    }
    teams {
      nodes {
        id
        name
        key
      }
    }
  }'

	local response
	response=$(curl -s -X POST \
		-H "Authorization: $token" \
		-H "Content-Type: application/json" \
		-d "{\"query\":$(echo "$query" | jq -Rs .)}" \
		https://api.linear.app/graphql 2>&1)

	# Check for errors
	if echo "$response" | jq -e '.errors' >/dev/null 2>&1; then
		echo '{"valid": false, "error": "Invalid token or API error"}' >&2
		return 1
	fi

	# Extract data
	local viewer=$(echo "$response" | jq -r '.data.viewer')
	local teams=$(echo "$response" | jq -r '.data.teams.nodes')

	if [[ $viewer == "null" ]]; then
		echo '{"valid": false, "error": "No user data returned"}' >&2
		return 1
	fi

	# Return validation result
	echo "$response" | jq '{
    valid: true,
    viewer: .data.viewer,
    teams: .data.teams.nodes
  }'
}

# Fetch workflow states for a Linear team
# Args: $1 = API token, $2 = team key
# Returns JSON array of workflow states with name, type, position
fetch_linear_workflow_states() {
	local token="$1"
	local team_key="$2"

	local query='
  {
    teams(filter: { key: { eq: "'"$team_key"'" } }) {
      nodes {
        workflowStates {
          nodes {
            name
            type
            position
          }
        }
      }
    }
  }'

	local response
	response=$(curl -s -X POST \
		-H "Authorization: $token" \
		-H "Content-Type: application/json" \
		-d "{\"query\":$(echo "$query" | jq -Rs .)}" \
		https://api.linear.app/graphql 2>&1)

	# Check for errors
	if echo "$response" | jq -e '.errors' >/dev/null 2>&1; then
		return 1
	fi

	# Extract workflow states
	local states
	states=$(echo "$response" | jq -r '.data.teams.nodes[0].workflowStates.nodes // empty')

	if [[ -z $states || $states == "null" ]]; then
		return 1
	fi

	echo "$states"
}

# Map Linear workflow states to Catalyst stateMap
# Args: $1 = JSON array of workflow states from fetch_linear_workflow_states
# Returns JSON object matching our stateMap schema
build_state_map_from_linear() {
	local states="$1"

	# Extract state names by type, sorted by position
	# Linear types: triage, backlog, unstarted, started, completed, canceled
	local backlog_state unstarted_state started_states review_state completed_state canceled_state

	backlog_state=$(echo "$states" | jq -r '[.[] | select(.type == "backlog")] | sort_by(.position) | .[0].name // empty')
	unstarted_state=$(echo "$states" | jq -r '[.[] | select(.type == "unstarted")] | sort_by(.position) | .[0].name // empty')
	completed_state=$(echo "$states" | jq -r '[.[] | select(.type == "completed")] | sort_by(.position) | .[0].name // empty')
	canceled_state=$(echo "$states" | jq -r '[.[] | select(.type == "cancelled" or .type == "canceled")] | sort_by(.position) | .[0].name // empty')

	# For "started" type, there may be multiple states (e.g., "In Progress", "In Review")
	# Try to find one with "review" in the name for our inReview key
	local default_started
	default_started=$(echo "$states" | jq -r '[.[] | select(.type == "started")] | sort_by(.position) | .[0].name // empty')
	review_state=$(echo "$states" | jq -r '[.[] | select(.type == "started") | select(.name | test("review"; "i"))] | .[0].name // empty')

	# If no explicit review state found, use the last started state (highest position)
	if [[ -z $review_state ]]; then
		local last_started
		last_started=$(echo "$states" | jq -r '[.[] | select(.type == "started")] | sort_by(.position) | last.name // empty')
		# Only use last_started as review if there are multiple started states
		local started_count
		started_count=$(echo "$states" | jq '[.[] | select(.type == "started")] | length')
		if [[ $started_count -gt 1 ]]; then
			review_state="$last_started"
		else
			review_state="$default_started"
		fi
	fi

	# If no triage state but we need a backlog fallback
	if [[ -z $backlog_state ]]; then
		# Check for triage state as fallback
		backlog_state=$(echo "$states" | jq -r '[.[] | select(.type == "triage")] | sort_by(.position) | .[0].name // empty')
	fi

	# Build the stateMap JSON
	jq -n \
		--arg backlog "${backlog_state:-Backlog}" \
		--arg todo "${unstarted_state:-Todo}" \
		--arg research "${default_started:-In Progress}" \
		--arg planning "${default_started:-In Progress}" \
		--arg inProgress "${default_started:-In Progress}" \
		--arg inReview "${review_state:-In Review}" \
		--arg done "${completed_state:-Done}" \
		--arg canceled "${canceled_state:-Canceled}" \
		'{
      backlog: $backlog,
      todo: $todo,
      research: $research,
      planning: $planning,
      inProgress: $inProgress,
      inReview: $inReview,
      done: $done,
      canceled: $canceled
    }'
}

# Update .catalyst/config.json with real Linear workflow states
# Called after Linear integration is configured in secrets
update_config_with_linear_states() {
	local config_file="${PROJECT_DIR}/.catalyst/config.json"
	# Backward compat: fall back to .claude/ if .catalyst/ doesn't exist yet
	if [[ ! -f $config_file && -f "${PROJECT_DIR}/.claude/config.json" ]]; then
		config_file="${PROJECT_DIR}/.claude/config.json"
	fi
	local secrets_file="$HOME/.config/catalyst/config-${PROJECT_KEY}.json"

	# CTL-2076: never re-derive over a committed, PRESERVED stateMap. setup_project_config
	# sets CATALYST_STATEMAP_PRESERVED=1 when it kept an existing non-empty committed map;
	# honoring it here closes the second clobber path (a credentialed re-run over a real
	# config, e.g. mini-2's CTL checkout, where fetch+build_state_map_from_linear would
	# otherwise overwrite the curated map with the positional heuristic). A fresh install
	# leaves the flag 0 (or unset), so the Linear-derived refresh still runs there.
	if [[ "${CATALYST_STATEMAP_PRESERVED:-0}" == "1" ]]; then
		echo ""
		echo "✓ Preserving committed linear.stateMap (skipping Linear-derived refresh)"
		return 0
	fi

	# Need both files to exist
	if [[ ! -f $config_file ]] || [[ ! -f $secrets_file ]]; then
		return 0
	fi

	# Get token and team key from secrets
	local token team_key
	token=$(jq -r '.catalyst.linear.apiToken // empty' "$secrets_file" 2>/dev/null)
	team_key=$(jq -r '.catalyst.linear.teamKey // empty' "$secrets_file" 2>/dev/null)

	# Fall back to project config for team key
	if [[ -z $team_key ]]; then
		team_key=$(jq -r '.catalyst.linear.teamKey // empty' "$config_file" 2>/dev/null)
	fi

	if [[ -z $token ]] || [[ -z $team_key ]]; then
		return 0
	fi

	echo ""
	echo "🔍 Fetching workflow states from Linear for team ${team_key}..."

	local states
	if states=$(fetch_linear_workflow_states "$token" "$team_key"); then
		local state_map
		state_map=$(build_state_map_from_linear "$states")

		if [[ -n $state_map ]]; then
			# Update the project config with real states
			local updated_config
			updated_config=$(jq --argjson stateMap "$state_map" '.catalyst.linear.stateMap = $stateMap' "$config_file")
			echo "$updated_config" | jq . >"$config_file"

			echo ""
			echo "✓ Updated config.json with actual Linear workflow states:"
			echo "$state_map" | jq -r 'to_entries[] | "  \(.key): \(.value)"'
			echo ""
		else
			print_warning "Could not build state map from Linear API response. Using defaults."
		fi
	else
		print_warning "Could not fetch workflow states from Linear API. Using defaults."
		echo "  You can customize later in .catalyst/config.json → catalyst.linear.stateMap"
	fi
}

# Ensure the execution-core Linear-state contract (CTL-564). A thin wrapper:
# invokes setup-execution-core-states.sh for every --full repo so the contract
# states, collapse stateMap, and registry entry are provisioned regardless of
# dispatchMode (CTL-722: the stateMap write is idempotent — the states script
# preserves a template-default or user-customised map). A non-zero exit (e.g. a
# Linear-permission failure) is tolerated (|| true) so it never aborts setup.
setup_execution_core_states() {
	# Resolve config the same way update_config_with_linear_states does:
	# .catalyst/ with a .claude/ backward-compat fallback.
	local config_file="${PROJECT_DIR}/.catalyst/config.json"
	if [[ ! -f $config_file && -f "${PROJECT_DIR}/.claude/config.json" ]]; then
		config_file="${PROJECT_DIR}/.claude/config.json"
	fi
	[[ -f $config_file ]] || return 0

	# CTL-722: run the state-contract step for every --full repo, not only
	# execution-core ones, so a fresh phase-agents repo provisions the contract
	# states + registry entry. The stateMap write is idempotent (the states
	# script preserves a template-default or user-customised map).

	# Locate the standalone script — installed plugin root, else the central resolver.
	# CTL-1914: the second branch was the RELATIVE path `plugins/dev/scripts/…`, i.e.
	# resolved against CWD, which for the documented curl install holds only the setup
	# script. The Linear workflow-state contract and the `worker-status` label group
	# were therefore never provisioned, behind a warning that read as informational.
	local states_script=""
	if [[ -n ${CLAUDE_PLUGIN_ROOT-} && -f "${CLAUDE_PLUGIN_ROOT}/scripts/setup-execution-core-states.sh" ]]; then
		states_script="${CLAUDE_PLUGIN_ROOT}/scripts/setup-execution-core-states.sh"
	else
		if catalyst_helper_path setup-execution-core-states.sh >/dev/null; then
			states_script="$CATALYST_HELPER_PATH"
		else
			states_script=""
		fi
	fi
	if [[ -z $states_script ]]; then
		print_warning "Linear state contract NOT provisioned (${CATALYST_SOURCE_REASON})"
		catalyst_defer_step \
			"Provision the Linear workflow-state contract and worker-status labels (${CATALYST_SOURCE_REASON})" \
			"git clone https://github.com/coalesce-labs/catalyst.git ~/catalyst/plugin-source && bash ~/catalyst/plugin-source/plugins/dev/scripts/setup-execution-core-states.sh --config ${config_file}" \
			"catalyst doctor"
		return 0
	fi

	echo ""
	echo "🔗 Ensuring execution-core Linear-state contract..."
	# ⛔ Codex #3500 P1: this was `|| true`, which swallowed a nonzero exit — Linear
	# refusing to create a state, registry setup failing — with no deferral. The new
	# ledger would then print its all-clear on a node whose state contract never landed,
	# which is a worse failure than the silent skip this PR removed: it is a silent skip
	# with a green receipt attached. The `|| true` stays (a failed contract must not
	# abort setup), but the status is now CAPTURED and recorded.
	local states_rc=0
	bash "$states_script" --config "$config_file" || states_rc=$?
	if [[ $states_rc -ne 0 ]]; then
		print_warning "Linear state contract did NOT land (setup-execution-core-states.sh exited ${states_rc})"
		catalyst_defer_step \
			"Provision the Linear workflow-state contract (its installer ran and exited ${states_rc})" \
			"bash ${states_script} --config ${config_file}" \
			"catalyst doctor"
	fi
}

# Discover existing Sentry auth token
discover_sentry_token() {
	local token=""

	# Check environment variable
	if [[ -n ${SENTRY_AUTH_TOKEN-} ]]; then
		echo "env" >&2
		echo "$SENTRY_AUTH_TOKEN"
		return 0
	fi

	# Check ~/.sentryclirc file
	if [[ -f ~/.sentryclirc ]]; then
		token=$(grep -E '^token\s*=' ~/.sentryclirc 2>/dev/null | cut -d'=' -f2 | tr -d '[:space:]' || echo "")
		if [[ -n $token ]]; then
			echo "file" >&2
			echo "$token"
			return 0
		fi
	fi

	return 1
}

# Validate Sentry auth token and get org/projects
validate_sentry_token() {
	local token="$1"

	# Get organizations
	local orgs_response
	orgs_response=$(curl -s -X GET \
		-H "Authorization: Bearer $token" \
		https://sentry.io/api/0/organizations/ 2>&1)

	# Check if valid JSON and has data
	if ! echo "$orgs_response" | jq -e '.' >/dev/null 2>&1; then
		echo '{"valid": false, "error": "Invalid response from API"}' >&2
		return 1
	fi

	if echo "$orgs_response" | jq -e '.detail' >/dev/null 2>&1; then
		local error=$(echo "$orgs_response" | jq -r '.detail')
		echo "{\"valid\": false, \"error\": \"$error\"}" >&2
		return 1
	fi

	# Get first org slug
	local org_slug=$(echo "$orgs_response" | jq -r '.[0].slug // empty')

	if [[ -z $org_slug ]]; then
		echo '{"valid": false, "error": "No organizations found"}' >&2
		return 1
	fi

	# Get projects for first org
	local projects_response
	projects_response=$(curl -s -X GET \
		-H "Authorization: Bearer $token" \
		"https://sentry.io/api/0/organizations/$org_slug/projects/" 2>&1)

	# Return validation result
	jq -n \
		--argjson orgs "$orgs_response" \
		--argjson projects "$projects_response" \
		'{
      valid: true,
      organizations: $orgs,
      projects: $projects
    }'
}

#
# Prerequisite functions
#

check_command_exists() {
	command -v "$1" &>/dev/null
}

# No-sudo install helpers (CTL-844) ──────────────────────────────────────────

LOCAL_BIN="$HOME/.local/bin"

detect_arch() {
	case "$(uname -m)" in
	arm64 | aarch64) echo "arm64" ;;
	x86_64) echo "amd64" ;;
	*) echo "$(uname -m)" ;;
	esac
}

detect_os() {
	case "$(uname -s)" in
	Darwin) echo "macos" ;;
	Linux) echo "linux" ;;
	*) echo "unknown" ;;
	esac
}

# Shell rc files to persist PATH lines into, picked by login shell ($SHELL):
# zsh → ~/.zshenv; bash → ~/.bashrc + ~/.profile (interactive + login);
# unknown → all three. Fresh Linux machines default to bash, so writing only
# ~/.zshenv left installed tools invisible in new shells (CTL-844 remediate).
path_rc_files() {
	case "${SHELL-}" in
	*zsh) echo "$HOME/.zshenv" ;;
	*bash) printf '%s\n' "$HOME/.bashrc" "$HOME/.profile" ;;
	*) printf '%s\n' "$HOME/.zshenv" "$HOME/.bashrc" "$HOME/.profile" ;;
	esac
}

# Append a PATH export line to each shell rc file exactly once. Idempotent.
persist_path_line() {
	local line="$1" rc
	while IFS= read -r rc; do
		if ! grep -qsF "$line" "$rc" 2>/dev/null; then
			printf '\n# Added by catalyst setup (no-sudo tool installs)\n%s\n' "$line" >>"$rc"
		fi
	done < <(path_rc_files)
}

# Create ~/.local/bin and persist it on PATH via the shell rc files. Idempotent.
# Also persist ~/.local/node/bin: the no-sudo Node install lives at ~/.local/node
# and `npm install -g humanlayer linearis` puts their bins in that node prefix
# (~/.local/node/bin), which is NOT covered by the node/npm/npx symlinks in
# ~/.local/bin — without this line fresh login shells cannot find humanlayer or
# linearis (CTL-1214 / mini-2 onboarding: "PATH must include ~/.local/node/bin").
ensure_local_bin() {
	mkdir -p "$LOCAL_BIN"
	persist_path_line 'export PATH="$HOME/.local/bin:$PATH"'
	persist_path_line 'export PATH="$HOME/.local/node/bin:$PATH"'
	export PATH="$LOCAL_BIN:$HOME/.local/node/bin:$PATH"
}

# ─────────────────────────────────────────────────────────────────────────────

check_prerequisites() {
	print_header "Checking Prerequisites"

	local missing_critical=false
	local missing_optional=false

	# Platform check — Catalyst is developed and tested on macOS only
	if [[ "$(uname -s)" != "Darwin" ]]; then
		echo ""
		print_warning "Catalyst is built for macOS. Detected platform: $(uname -s)"
		echo "  Some features (Homebrew installs, open(1), direnv profiles) assume macOS."
		echo "  You can continue, but some things may not work as expected."
		echo ""
		if ! ask_yes_no "Continue on unsupported platform?" "n"; then
			echo "Setup cancelled."
			exit 0
		fi
	else
		print_success "Platform: macOS ($(sw_vers -productVersion 2>/dev/null || echo 'unknown version'))"
	fi

	# Critical: git (used throughout for repo detection, worktrees, thoughts)
	if ! check_command_exists "git"; then
		print_error "git not found (required)"
		echo "  Install git: https://git-scm.com/downloads"
		missing_critical=true
	else
		print_success "git installed"
	fi

	# Critical: jq (for config manipulation)
	if ! check_command_exists "jq"; then
		print_warning "jq not found (required for config management)"
		offer_install_jq || missing_critical=true
	else
		print_success "jq installed"
	fi

	# Critical: sqlite3 (for session store)
	if ! check_command_exists "sqlite3"; then
		print_error "sqlite3 not found (required for session store)"
		echo "  sqlite3 ships with macOS. If missing, install via your package manager."
		missing_critical=true
	else
		print_success "sqlite3 installed"
	fi

	# Critical: node + npm (linearis, humanlayer CLI, agent-browser are npm packages)
	if ! check_command_exists "node" || ! check_command_exists "npm"; then
		print_warning "node/npm not found (required for linearis + HumanLayer CLI)"
		offer_install_node || missing_critical=true
	else
		print_success "node installed ($(node --version 2>/dev/null))"
	fi

	# Critical: bun (catalyst-monitor + execution-core daemons require it)
	if ! check_command_exists "bun"; then
		print_warning "bun not found (required for the daemon stack)"
		offer_install_bun || missing_critical=true
	else
		print_success "bun installed"
	fi

	# Critical: humanlayer (for thoughts system)
	if ! check_command_exists "humanlayer"; then
		print_warning "HumanLayer CLI not found (required for thoughts system)"
		# CTL-1214 (PATH-B #5): force-accept the install offer in headless mode so
		# an autonomous catalyst-join does not abort on this critical prereq. The
		# offer helper's own NI default ("n") is preserved for direct/test calls.
		CATALYST_NI_AUTOINSTALL=1 offer_install_humanlayer || missing_critical=true
	else
		print_success "HumanLayer CLI installed"
	fi

	# gh: required on a cluster NODE for HTTPS git push auth (gh auth git-credential)
	# — thoughts sync pushes over HTTPS, mirroring the seed. Optional for a plain
	# workstation install. CTL-1214: auto-install it in headless mode so a node
	# join is not left without push credentials (mini-2 needed a manual download).
	if ! check_command_exists "gh"; then
		print_warning "GitHub CLI not found (needed for node HTTPS git auth / thoughts sync)"
		if [[ ${NON_INTERACTIVE:-0} -eq 1 ]]; then
			CATALYST_NI_AUTOINSTALL=1 offer_install_gh_cli || missing_optional=true
		else
			offer_install_gh_cli || missing_optional=true
		fi
	else
		print_success "GitHub CLI installed"
	fi

	# Optional: linearis (for Linear integration)
	if ! check_command_exists "linearis"; then
		print_warning "Linearis CLI not found (optional, for Linear integration)"
		echo "  Install: npm install -g linearis"
		missing_optional=true
	else
		# Check version is at least 1.1.0
		local linearis_version
		linearis_version=$(linearis --version 2>/dev/null | tail -1 | tr -d '[:space:]')

		if [[ $linearis_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
			local major minor patch
			IFS='.' read -r major minor patch <<<"$linearis_version"

			if [ "$major" -lt 1 ] || ([ "$major" -eq 1 ] && [ "$minor" -lt 1 ]); then
				print_warning "Linearis CLI version $linearis_version is too old (need >= 1.1.0)"
				echo "  Update: npm install -g linearis"
				missing_optional=true
			else
				print_success "Linearis CLI installed (v${linearis_version})"
			fi
		else
			print_success "Linearis CLI installed"
		fi
	fi

	# Optional: agent-browser (browser automation)
	if check_command_exists "agent-browser"; then
		print_success "agent-browser installed"
	else
		print_warning "agent-browser not found (optional — browser automation)"
		echo "  Install: npm install -g agent-browser && agent-browser install"
		missing_optional=true
	fi

	if [ "$missing_critical" = true ]; then
		print_error "Critical prerequisites missing. Cannot continue."
		exit 1
	fi

	if [ "$missing_optional" = true ]; then
		echo ""
		print_warning "Some optional tools are missing. You can:"
		echo "  - Continue setup (you can add integrations later)"
		echo "  - Exit and install tools manually"
		echo ""
		if ! ask_yes_no "Continue without optional tools?"; then
			echo "Setup cancelled. Install missing tools and re-run this script."
			exit 0
		fi
	fi

	echo ""
}

offer_install_node() {
	echo ""
	echo "node + npm are required (linearis and the HumanLayer CLI install via npm)."
	echo ""
	if ! ask_yes_no "Install Node.js LTS to ~/.local/node now (no sudo)?"; then
		return 1
	fi
	if command -v brew &>/dev/null; then
		if brew install node; then return 0; fi
		print_warning "brew install node failed — falling back to no-sudo install"
	fi
	ensure_local_bin
	local os arch version tarball
	os=$([[ "$(uname -s)" == "Darwin" ]] && echo "darwin" || echo "linux")
	arch=$([[ "$(detect_arch)" == "arm64" ]] && echo "arm64" || echo "x64")
	version="${CATALYST_NODE_VERSION:-$(curl -fsSL https://nodejs.org/dist/index.json |
		jq -r '[.[] | select(.lts != false)][0].version')}"
	[[ -n $version && $version != "null" ]] || {
		print_error "Could not resolve Node LTS version"
		return 1
	}
	tarball="node-${version}-${os}-${arch}.tar.gz"
	echo "  Downloading ${tarball} ..."
	mkdir -p "$HOME/.local"
	# Download + extract + verify in a temp dir, then swap — never delete a
	# working ~/.local/node until the replacement node executes (CTL-844
	# remediate: a partial extract must not clobber a good install).
	local tmp
	tmp=$(mktemp -d "$HOME/.local/.node-install.XXXXXX")
	if curl -fsSL -o "$tmp/$tarball" "https://nodejs.org/dist/${version}/${tarball}" &&
		tar -xzf "$tmp/$tarball" -C "$tmp" &&
		"$tmp/node-${version}-${os}-${arch}/bin/node" --version >/dev/null 2>&1; then
		rm -rf "$HOME/.local/node"
		mv "$tmp/node-${version}-${os}-${arch}" "$HOME/.local/node"
		rm -rf "$tmp"
		ln -sf "$HOME/.local/node/bin/node" "$LOCAL_BIN/node"
		ln -sf "$HOME/.local/node/bin/npm" "$LOCAL_BIN/npm"
		ln -sf "$HOME/.local/node/bin/npx" "$LOCAL_BIN/npx"
		print_success "Node $(node --version 2>/dev/null || echo "$version") installed to ~/.local/node"
		return 0
	fi
	rm -rf "$tmp"
	print_error "Node install failed. Manual: https://nodejs.org/en/download"
	return 1
}

offer_install_bun() {
	echo ""
	echo "bun is required (catalyst-monitor + execution-core daemons run on bun)."
	echo ""
	if ! ask_yes_no "Install bun now via the official installer (no sudo)?"; then
		return 1
	fi
	if curl -fsSL https://bun.sh/install | bash; then
		persist_path_line 'export PATH="$HOME/.bun/bin:$PATH"'
		export PATH="$HOME/.bun/bin:$PATH"
		command -v bun &>/dev/null && {
			print_success "bun installed ($(bun --version))"
			return 0
		}
	fi
	print_error "bun install failed. Manual: https://bun.sh"
	return 1
}

offer_install_humanlayer() {
	echo ""
	echo "HumanLayer CLI is required for the thoughts system."
	echo ""
	echo "  Install: npm install -g humanlayer"
	echo ""
	if ! ask_yes_no "Attempt to install via npm now?" "y" "n"; then
		print_warning "Skipping HumanLayer installation. Setup cannot continue."
		return 1
	fi
	if ! command -v npm &>/dev/null; then
		print_error "npm not found — node/npm must be installed first (see above)."
		return 1
	fi
	# Run the CLI, don't just `command -v` it — a global-npm prefix off PATH
	# or a stale shim passes lookup without working (CTL-844 remediate).
	if npm install -g humanlayer && humanlayer --version >/dev/null 2>&1; then
		print_success "HumanLayer CLI installed ($(humanlayer --version 2>/dev/null || true))"
		return 0
	fi
	print_error "HumanLayer install failed. Manual: npm install -g humanlayer"
	return 1
}

offer_install_gh_cli() {
	echo ""
	echo "GitHub CLI is used for PR automation and Linear/GitHub integration."
	echo ""
	if ! ask_yes_no "Install GitHub CLI now?" "y" "n"; then
		echo "  Manual install: https://cli.github.com/"
		return 1
	fi
	if command -v brew &>/dev/null; then
		if brew install gh; then return 0; fi
		print_warning "brew install gh failed — falling back to no-sudo install"
	fi
	# No-sudo: release archive → ~/.local/bin (jq is guaranteed installed by now)
	ensure_local_bin
	local ver os arch ext dir tmp
	ver=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest |
		jq -r '.tag_name' | sed 's/^v//')
	[[ -n $ver && $ver != "null" ]] || {
		print_error "Could not resolve gh version. Manual: https://cli.github.com/"
		return 1
	}
	if [[ "$(uname -s)" == "Darwin" ]]; then
		os="macOS"
		ext="zip"
	else
		os="linux"
		ext="tar.gz"
	fi
	if [[ $ext == "zip" ]] && ! command -v unzip &>/dev/null; then
		print_error "unzip not found — cannot extract gh archive. Manual: https://cli.github.com/"
		return 1
	fi
	arch=$(detect_arch)
	dir="gh_${ver}_${os}_${arch}"
	tmp=$(mktemp -d)
	if curl -fsSL -o "$tmp/gh.$ext" \
		"https://github.com/cli/cli/releases/download/v${ver}/${dir}.${ext}"; then
		if [[ $ext == "zip" ]]; then
			unzip -q "$tmp/gh.$ext" -d "$tmp"
		else
			tar -xzf "$tmp/gh.$ext" -C "$tmp"
		fi
		install -m 0755 "$tmp/$dir/bin/gh" "$LOCAL_BIN/gh"
		rm -rf "$tmp"
		command -v gh &>/dev/null && {
			print_success "GitHub CLI installed to $LOCAL_BIN/gh"
			return 0
		}
	fi
	rm -rf "$tmp"
	print_error "gh install failed. Manual: https://cli.github.com/"
	return 1
}

offer_install_jq() {
	echo ""
	echo "jq is required for config file manipulation."
	echo ""

	if ask_yes_no "Attempt to install jq now?" "y" "n"; then
		if command -v brew &>/dev/null; then
			brew install jq
			return 0
		elif command -v apt-get &>/dev/null; then
			sudo apt-get install -y jq
			return 0
		else
			echo "  No package manager found — installing official jq binary (no sudo) ..."
			ensure_local_bin
			local artifact="jq-$(detect_os)-$(detect_arch)"
			# Execute the downloaded binary once — chmod + command -v alone
			# would bless a corrupted/partial download (CTL-844 remediate).
			if curl -fsSL -o "$LOCAL_BIN/jq" \
				"https://github.com/jqlang/jq/releases/latest/download/${artifact}" &&
				chmod +x "$LOCAL_BIN/jq" &&
				"$LOCAL_BIN/jq" --version >/dev/null 2>&1; then
				print_success "jq installed to $LOCAL_BIN/jq"
				return 0
			fi
			print_error "Could not auto-install. Install manually: https://jqlang.github.io/jq/"
			return 1
		fi
	fi

	return 1
}

#
# Detection functions
#

detect_git_repo() {
	print_header "Detecting Git Repository"

	if git rev-parse --git-dir >/dev/null 2>&1; then
		PROJECT_DIR=$(git rev-parse --show-toplevel)
		print_success "Found git repository: $PROJECT_DIR"

		# Extract org and repo from remote
		detect_org_and_repo

		echo ""
		echo "Detected repository: ${ORG_NAME}/${REPO_NAME}"
		echo ""

		if ask_yes_no "Set up Catalyst in this repository?"; then
			return 0
		else
			determine_project_location
		fi
	else
		print_warning "Not currently in a git repository"
		determine_project_location
	fi
}

detect_org_and_repo() {
	local git_remote
	git_remote=$(git config --get remote.origin.url 2>/dev/null || echo "")

	if [[ $git_remote =~ github\.com[:/]([^/]+)/([^/.]+) ]]; then
		ORG_NAME="${BASH_REMATCH[1]}"
		REPO_NAME="${BASH_REMATCH[2]}"
	else
		# No GitHub remote, try to parse directory structure
		# Assume structure: */github/<org>/<repo>
		local abs_path
		abs_path=$(cd "$PROJECT_DIR" && pwd)

		if [[ $abs_path =~ /github/([^/]+)/([^/]+)/?$ ]]; then
			ORG_NAME="${BASH_REMATCH[1]}"
			REPO_NAME="${BASH_REMATCH[2]}"
		else
			# Fallback: ask user
			echo ""
			print_warning "Could not detect GitHub org/repo from remote or path"
			if [[ $NON_INTERACTIVE -eq 1 ]]; then
				print_error "Cannot detect GitHub org/repo (no remote, unrecognized path). Run interactively or set a GitHub remote."
				exit 1
			fi
			read -p "Enter GitHub organization name: " ORG_NAME
			read -p "Enter repository name: " REPO_NAME
		fi
	fi

	# Determine org root (parent of repo directory)
	ORG_ROOT="$(dirname "$PROJECT_DIR")"

	# Set projectKey to org name
	PROJECT_KEY="$ORG_NAME"
}

determine_project_location() {
	if [[ $NON_INTERACTIVE -eq 1 ]]; then
		print_error "Not in a git repository. Run setup from inside the target repo when using --non-interactive."
		exit 1
	fi
	echo ""
	echo "Where is your project located?"
	echo ""
	echo "Options:"
	echo "  1. I already have the repo checked out"
	echo "  2. Clone a fresh copy to a new location"
	echo ""

	read -p "Select option (1 or 2): " location_option

	case $location_option in
	1)
		read -p "Enter path to existing repository: " PROJECT_DIR
		PROJECT_DIR=$(cd "$PROJECT_DIR" && pwd) # Resolve to absolute path

		if [ ! -d "$PROJECT_DIR/.git" ]; then
			print_error "Not a git repository: $PROJECT_DIR"
			exit 1
		fi

		cd "$PROJECT_DIR"
		detect_org_and_repo
		;;
	2)
		read -p "Enter GitHub repo (org/repo): " github_repo

		if [[ ! $github_repo =~ ^([^/]+)/([^/]+)$ ]]; then
			print_error "Invalid format. Expected: org/repo"
			exit 1
		fi

		ORG_NAME="${BASH_REMATCH[1]}"
		REPO_NAME="${BASH_REMATCH[2]}"
		PROJECT_KEY="$ORG_NAME"

		# Determine clone location
		if [ -n "$GITHUB_SOURCE_ROOT" ]; then
			ORG_ROOT="${GITHUB_SOURCE_ROOT}/${ORG_NAME}"
			PROJECT_DIR="${ORG_ROOT}/${REPO_NAME}"
		else
			read -p "Enter directory to clone into [~/code-repos/github/${ORG_NAME}]: " clone_base
			clone_base="${clone_base:-$HOME/code-repos/github/${ORG_NAME}}"
			ORG_ROOT="$clone_base"
			PROJECT_DIR="${ORG_ROOT}/${REPO_NAME}"
		fi

		mkdir -p "$ORG_ROOT"

		echo ""
		print_header "Cloning Repository"
		git clone "git@github.com:${github_repo}.git" "$PROJECT_DIR"
		cd "$PROJECT_DIR"
		;;
	*)
		print_error "Invalid option"
		exit 1
		;;
	esac
}

#
# Setup functions
#

discover_existing_thoughts_repo() {
	# Priority 1: Check if thoughts/shared is already a symlink in PROJECT_DIR
	# This handles the case where humanlayer thoughts init was already run
	if [ -L "${PROJECT_DIR}/thoughts/shared" ]; then
		local shared_target
		shared_target=$(readlink "${PROJECT_DIR}/thoughts/shared" 2>/dev/null || echo "")
		if [ -n "$shared_target" ]; then
			# Derive the thoughts repo root from the symlink target
			# e.g., /path/to/thoughts/repos/evergreen/shared → /path/to/thoughts
			local thoughts_root
			thoughts_root=$(echo "$shared_target" | sed 's|/repos/[^/]*/shared$||')
			if [ -d "$thoughts_root" ] && [ -d "$thoughts_root/repos" ]; then
				THOUGHTS_REPO="$thoughts_root"
				return 0
			fi
		fi
	fi

	# Priority 2: Check HumanLayer profile config in humanlayer.json
	local hl_config="$HOME/.config/humanlayer/humanlayer.json"
	if [ -f "$hl_config" ] && command -v jq &>/dev/null; then
		# Try by ORG_NAME (most common - profile name matches org)
		local thoughts_path
		thoughts_path=$(jq -r ".thoughts.profiles.\"${ORG_NAME}\".thoughtsRepo // empty" "$hl_config" 2>/dev/null)
		if [ -n "$thoughts_path" ] && [ -d "$thoughts_path" ] && [ -d "$thoughts_path/repos" ]; then
			THOUGHTS_REPO="$thoughts_path"
			return 0
		fi

		# Try by PROJECT_KEY if different from ORG_NAME
		if [ "$PROJECT_KEY" != "$ORG_NAME" ]; then
			thoughts_path=$(jq -r ".thoughts.profiles.\"${PROJECT_KEY}\".thoughtsRepo // empty" "$hl_config" 2>/dev/null)
			if [ -n "$thoughts_path" ] && [ -d "$thoughts_path" ] && [ -d "$thoughts_path/repos" ]; then
				THOUGHTS_REPO="$thoughts_path"
				return 0
			fi
		fi
	fi

	# Priority 3: Check standard location based on ORG_ROOT
	if [ -d "${ORG_ROOT}/thoughts" ] && [ -d "${ORG_ROOT}/thoughts/repos" ]; then
		THOUGHTS_REPO="${ORG_ROOT}/thoughts"
		return 0
	fi

	# Not found
	return 1
}

setup_thoughts_repo() {
	print_header "Setting Up Thoughts Repository"

	# Try to discover an existing thoughts repo before creating one
	if discover_existing_thoughts_repo; then
		print_success "Found existing thoughts repository: $THOUGHTS_REPO"

		# Validate structure
		if [ ! -d "$THOUGHTS_REPO/repos" ] || [ ! -d "$THOUGHTS_REPO/global" ]; then
			print_warning "Thoughts repo exists but missing expected structure"
			echo "Expected: repos/ and global/ directories"

			if ask_yes_no "Initialize proper structure?"; then
				mkdir -p "$THOUGHTS_REPO/repos"
				mkdir -p "$THOUGHTS_REPO/global"
			fi
		fi

		# Check if it's a git repo
		if [ ! -d "$THOUGHTS_REPO/.git" ]; then
			print_warning "Thoughts repo is not a git repository"

			if ask_yes_no "Initialize as git repo?"; then
				cd "$THOUGHTS_REPO"
				git init
				git add .
				git commit -m "Initial commit" || true
				cd "$PROJECT_DIR"
			fi
		fi

		# Offer GitHub backup
		if [ -d "$THOUGHTS_REPO/.git" ]; then
			offer_github_backup
		fi

		echo ""
		return 0
	fi

	# No existing thoughts repo found - create one at the standard location
	THOUGHTS_REPO="${ORG_ROOT}/thoughts"

	echo "Thoughts repository will be created at: $THOUGHTS_REPO"
	echo ""
	echo "This will be shared by all projects in org: $ORG_NAME"
	echo ""

	if ask_yes_no "Create thoughts repository?"; then
		mkdir -p "$THOUGHTS_REPO/repos"
		mkdir -p "$THOUGHTS_REPO/global"

		# Initialize as git repo
		cd "$THOUGHTS_REPO"
		git init

		# Create README
		cat >README.md <<'EOF'
# Thoughts Repository

This is a shared thoughts repository for all projects in this organization.

## Structure

```
thoughts/
├── repos/           # Per-project thoughts
│   ├── project-a/
│   │   ├── {user}/
│   │   └── shared/
│   └── project-b/
│       ├── {user}/
│       └── shared/
└── global/          # Cross-project thoughts
    ├── {user}/
    └── shared/
```

## Usage

Projects symlink into this repo via `humanlayer thoughts init`.

See: https://github.com/humanlayer/humanlayer/blob/main/hlyr/THOUGHTS.md
EOF

		git add README.md
		git commit -m "Initial thoughts repository"

		print_success "Created thoughts repository: $THOUGHTS_REPO"
		cd "$PROJECT_DIR"
	else
		print_error "Thoughts repository required for Catalyst. Exiting."
		exit 1
	fi

	# Offer GitHub backup
	if [ -d "$THOUGHTS_REPO/.git" ]; then
		offer_github_backup
	fi

	echo ""
}

setup_worktree_directory() {
	print_header "Setting Up Worktree Directory"

	# Check if we're already inside a worktree (e.g., one your tooling manages)
	local git_dir
	git_dir=$(git rev-parse --git-dir 2>/dev/null || echo "")

	if [ -f "$git_dir" ] 2>/dev/null || [[ $git_dir == *"/worktrees/"* ]]; then
		print_success "Already running inside a git worktree"
		echo "Worktree management is handled by your tooling (e.g., /create-worktree)."
		echo ""
		echo "To create additional worktrees, use:"
		echo "  /create-worktree PROJ-123 feature-name"
		echo ""
		WORKTREE_BASE=""
		return 0
	fi

	# Standard layout: worktrees as sibling of the repo under ORG_ROOT
	WORKTREE_BASE="${ORG_ROOT}/${REPO_NAME}-worktrees"

	echo "Worktrees will be created at: $WORKTREE_BASE"
	echo ""

	if [ -d "$WORKTREE_BASE" ]; then
		print_success "Worktree directory already exists"

		# List existing worktrees
		local count
		count=$(find "$WORKTREE_BASE" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)

		if [ "$count" -gt 0 ]; then
			echo "Existing worktrees:"
			ls -1 "$WORKTREE_BASE" | sed 's/^/  - /'
		fi
	else
		if ask_yes_no "Create worktree directory?"; then
			mkdir -p "$WORKTREE_BASE"
			print_success "Created worktree directory: $WORKTREE_BASE"
		else
			print_warning "Skipped worktree setup. You can create it later."
		fi
	fi

	echo ""
	echo "To create worktrees, use:"
	echo "  /create-worktree PROJ-123 feature-name"
	echo ""
}

setup_project_config() {
	print_header "Setting Up Project Configuration"

	local config_file="${PROJECT_DIR}/.catalyst/config.json"

	# Create .catalyst directory if needed
	mkdir -p "${PROJECT_DIR}/.catalyst"

	# Migrate from .claude/ if needed
	if [[ ! -f $config_file && -f "${PROJECT_DIR}/.claude/config.json" ]]; then
		cp "${PROJECT_DIR}/.claude/config.json" "$config_file"
		print_warning "Migrated config.json from .claude/ to .catalyst/"
	fi

	# Check if config already exists
	if [ -f "$config_file" ]; then
		print_warning "Found existing .catalyst/config.json"

		# Check if projectKey matches
		local existing_key
		existing_key=$(jq -r '.catalyst.projectKey // empty' "$config_file")

		if [ -n "$existing_key" ] && [ "$existing_key" != "$PROJECT_KEY" ]; then
			echo ""
			echo "Existing projectKey: $existing_key"
			echo "Detected projectKey: $PROJECT_KEY"
			echo ""

			if ask_yes_no "Update to new projectKey ($PROJECT_KEY)?"; then
				PROJECT_KEY="$PROJECT_KEY"
			else
				PROJECT_KEY="$existing_key"
				print_warning "Keeping existing projectKey: $existing_key"
			fi
		elif [ -n "$existing_key" ]; then
			print_success "Config already has correct projectKey: $existing_key"
			return 0
		fi
	fi

	# Prompt for ticket prefix
	echo ""
	echo "Ticket Prefix Configuration:"
	echo "  This is used for Linear tickets and appears in:"
	echo "  - Branch names (e.g., ${PROJECT_KEY}-123-feature-name)"
	echo "  - PR titles (e.g., [${PROJECT_KEY}-123] Add new feature)"
	echo "  - Commit messages and documentation"
	echo ""
	# Ticket prefix: default PROJ, but PRESERVE an existing committed value across a
	# regeneration (CTL-2076) so a non-interactive re-run over a real config (e.g. the
	# CTL checkout) does not clobber ticketPrefix back to PROJ. Mirrors the thoughts.*
	# (CTL-1214) and deployment.mode (CTL-1622) preservation blocks below; identical
	# preload+prompt shape to the deployment_mode block.
	local ticket_prefix_default="PROJ"
	if [[ -f $config_file ]]; then
		local _existing_prefix
		_existing_prefix=$(jq -r '.catalyst.project.ticketPrefix // empty' "$config_file" 2>/dev/null)
		[[ -n $_existing_prefix ]] && ticket_prefix_default="$_existing_prefix"
	fi
	ticket_prefix=$(prompt_value "Enter ticket prefix (e.g., ENG, PROJ) [${ticket_prefix_default}]:" "${ticket_prefix_default}")

	# Prompt for project name
	echo ""
	echo "Project Name Configuration:"
	echo "  This is a human-friendly display name (not the repo name)."
	echo "  Used in documentation, reports, and thought documents."
	echo "  Example: 'Acme API' instead of 'acme-api-backend'"
	echo ""
	project_name=$(prompt_value "Enter project name [${REPO_NAME}]:" "${REPO_NAME}")

	# Thoughts subdir/profile: default to REPO_NAME/ORG_NAME but PRESERVE an
	# existing committed value (CTL-1214) — e.g. the catalyst repo's canonical
	# .catalyst.thoughts.directory is "catalyst-workspace", NOT the repo name
	# "catalyst"; regenerating the config must not clobber it and fragment the
	# node's thoughts subtree away from the fleet's.
	local thoughts_directory="${REPO_NAME}" thoughts_profile="${ORG_NAME}"
	if [[ -f $config_file ]]; then
		local _existing_dir _existing_prof
		_existing_dir=$(jq -r '.catalyst.thoughts.directory // empty' "$config_file" 2>/dev/null)
		_existing_prof=$(jq -r '.catalyst.thoughts.profile // empty' "$config_file" 2>/dev/null)
		[[ -n $_existing_dir ]] && thoughts_directory="$_existing_dir"
		[[ -n $_existing_prof ]] && thoughts_profile="$_existing_prof"
	fi

	# Deployment mode (CTL-1622): default single-host, but PRESERVE an existing
	# committed value (mirrors the thoughts preservation above) so a config
	# regeneration never clobbers a fleet's declared cluster/cloud back to
	# single-host. Validation is deferred to the resolver + `catalyst doctor`
	# (same as ticket prefix), so accept any value here.
	local deployment_mode="single-host"
	if [[ -f $config_file ]]; then
		local _existing_mode
		# Preserve the value whenever the key is PRESENT and NON-NULL — including an
		# explicit `false`/number/garbage — rather than `// empty` (which jq treats
		# `false` as absent, silently resetting a misconfig to single-host and masking
		# the resolver's recognized:false / `catalyst doctor` failure). JSON `null` is
		# excluded on purpose: the resolver treats null as the "unset" sentinel
		# (fallthrough → inferred:true, recognized:true, doctor passes), so it must be
		# handled like an absent key here — `tostring` would coerce it to the string
		# "null", an unrecognized value that flips doctor to FAIL after regeneration.
		# Deferred validation (resolver + doctor) is what surfaces a genuinely bad value.
		_existing_mode=$(jq -r 'if (.catalyst.deployment | objects | has("mode")) and (.catalyst.deployment.mode != null) then (.catalyst.deployment.mode | tostring) else empty end' "$config_file" 2>/dev/null)
		[[ -n $_existing_mode ]] && deployment_mode="$_existing_mode"
	fi

	echo ""
	echo "Deployment Mode Configuration:"
	echo "  Declares this project's fleet topology (CTL-1617):"
	echo "    single-host  one machine runs everything (default; dev clones)"
	echo "    cluster      multiple machines share ticket ownership"
	echo "    cloud        hosted control plane (no local smee tunnel)"
	echo "  Written to .catalyst/config.json as the fleet default; override"
	echo "  per-host via ~/.config/catalyst/config.json (Layer-2)."
	echo ""
	deployment_mode=$(prompt_value "Enter deployment mode (single-host|cluster|cloud) [${deployment_mode}]:" "${deployment_mode}")

	# JSON-encode the (deliberately-unvalidated) deployment value before it lands
	# in the heredoc below, so a pasted quote/backslash/newline can't produce a
	# malformed .catalyst/config.json that the next jq consumer aborts on — after
	# the file has already been overwritten. jq -Rn emits the value WITH its
	# surrounding quotes, so the heredoc interpolates it bare (no wrapping "").
	local deployment_mode_json
	deployment_mode_json=$(jq -Rn --arg v "$deployment_mode" '$v')

	# teamKey: default to the ticket prefix (preserving today's teamKey := ticketPrefix
	# coupling for fresh installs), but PRESERVE an existing committed linear.teamKey
	# INDEPENDENTLY across a regeneration (CTL-2076) — a config can legitimately carry a
	# teamKey distinct from its prefix, and clobbering it to the prefix is the exact bug
	# that rewrote mini-2's CTL checkout to team PROJ.
	local team_key="${ticket_prefix}"
	if [[ -f $config_file ]]; then
		local _existing_team
		_existing_team=$(jq -r '.catalyst.linear.teamKey // empty' "$config_file" 2>/dev/null)
		[[ -n $_existing_team ]] && team_key="$_existing_team"
	fi

	# stateMap: PRESERVE an existing NON-EMPTY committed linear.stateMap verbatim across a
	# regeneration (CTL-2076); otherwise use today's generic 8-key default. Injected as a
	# pre-encoded JSON blob the same way deployment_mode_json is, so a preserved map lands
	# byte-for-byte and a fresh install keeps the exact current default.
	#
	# CTL-2076: signal the preservation to update_config_with_linear_states (called next in
	# main), which would otherwise re-derive the map from Linear via the positional heuristic
	# in build_state_map_from_linear and collapse a curated map (research/planning/inProgress =
	# Research/Plan/Implement) back to a single started-state name — re-introducing the exact
	# clobber this ticket fixes. The flag is deliberately NOT `local`: both functions run in
	# the same process from main(), and a just-written generic default (flag=0) must still be
	# refreshed from Linear on a fresh install. Defaults to 0 for a fresh/absent config.
	local state_map_json
	CATALYST_STATEMAP_PRESERVED=0
	if [[ -f $config_file ]] &&
		[[ $(jq -r '(.catalyst.linear.stateMap | objects | length) // 0' "$config_file" 2>/dev/null) -gt 0 ]]; then
		state_map_json=$(jq -c '.catalyst.linear.stateMap' "$config_file")
		CATALYST_STATEMAP_PRESERVED=1
	else
		state_map_json=$(jq -cn '{backlog:"Backlog",todo:"Todo",research:"In Progress",planning:"In Progress",inProgress:"In Progress",inReview:"In Review",done:"Done",canceled:"Canceled"}')
	fi

	# Create/update config
	cat >"$config_file" <<EOF
{
  "catalyst": {
    "projectKey": "${PROJECT_KEY}",
    "repository": {
      "org": "${ORG_NAME}",
      "name": "${REPO_NAME}"
    },
    "project": {
      "ticketPrefix": "${ticket_prefix}",
      "name": "${project_name}"
    },
    "deployment": {
      "mode": ${deployment_mode_json}
    },
    "linear": {
      "teamKey": "${team_key}",
      "stateMap": ${state_map_json}
    },
    "thoughts": {
      "user": null,
      "directory": "${thoughts_directory}",
      "profile": "${thoughts_profile}"
    }
  }
}
EOF

	print_success "Created .catalyst/config.json"
	echo ""
	echo "✓ projectKey: ${PROJECT_KEY}"
	echo "✓ org/repo: ${ORG_NAME}/${REPO_NAME}"
	echo "✓ ticketPrefix: ${ticket_prefix}"
	echo "✓ linear.teamKey: ${team_key}"
	echo "✓ linear.stateMap: ${state_map_json}"
	echo "✓ deployment.mode: ${deployment_mode}"
	echo ""
}

setup_humanlayer_config() {
	print_header "Setting Up HumanLayer Configuration"

	local config_dir="$HOME/.config/humanlayer"
	local config_file="${config_dir}/config-${PROJECT_KEY}.json"

	mkdir -p "$config_dir"

	# Check if config already exists
	if [ -f "$config_file" ]; then
		print_warning "Found existing HumanLayer config: $config_file"

		# Validate it points to correct thoughts repo
		local existing_repo
		existing_repo=$(jq -r '.thoughts.thoughtsRepo // empty' "$config_file")

		if [ -n "$existing_repo" ] && [ "$existing_repo" = "$THOUGHTS_REPO" ]; then
			print_success "Config already points to correct thoughts repo"
			return 0
		elif [ -n "$existing_repo" ]; then
			print_warning "Config points to different thoughts repo: $existing_repo"

			if ! ask_yes_no "Update to use $THOUGHTS_REPO?"; then
				THOUGHTS_REPO="$existing_repo"
				print_warning "Using existing thoughts repo: $existing_repo"
				return 0
			fi
		fi
	fi

	# Prompt for username
	echo ""
	echo "Thoughts Username Configuration:"
	echo "  This creates a personal directory for your notes and research."
	echo "  Structure: thoughts/{your_name}/ (e.g., thoughts/ryan/)"
	echo "  Used to separate your work from shared team documents."
	echo ""
	echo "  Detected system user: ${USER}"
	echo "  You can use your system username or choose something else (like your first name)."
	echo ""
	thoughts_user=$(prompt_value "Enter your name for thoughts [${USER}]:" "${USER}")
	USER_NAME="$thoughts_user"

	# Create config
	cat >"$config_file" <<EOF
{
  "thoughts": {
    "thoughtsRepo": "${THOUGHTS_REPO}",
    "user": "${thoughts_user}",
    "reposDir": "repos",
    "globalDir": "global"
  }
}
EOF

	print_success "Created HumanLayer config: $config_file"
	echo ""
	echo "✓ Thoughts repo: ${THOUGHTS_REPO}"
	echo "✓ User: ${thoughts_user}"
	echo ""
}

# ── CTL-1836: provision the Catalyst Cloud read replica ─────────────────────
#
# Before this, a brand-new user finished setup with a working local node, no
# replica, and no indication one existed — every step below was a separate,
# undocumented manual procedure. This closes the six blockers a new install hits,
# in the order it hits them: no cloud path in the installer; hand-writing the
# writer env; the tenant-0 account default; the legacy base URL; replica reads
# defaulting off; and the project never being enrolled.
#
# ⛔ NO-DEFAULT RULE FOR THE ACCOUNT. cloud-sync.mjs:125 and cloud-sync/launch.sh:68
# both default CATALYST_CLOUD_ACCOUNT to "tenant-0" — Ryan's workspace. For an
# external user that default silently points their host at somebody else's tenant.
# With a per-tenant key it fails CLOSED (the mirror forces the account to match the
# key), but the result is an opaque 403 with no hint about why. So when a cloud
# token is supplied here, the account is REQUIRED and we fail loudly instead.
#
# ⚠️ WHAT THIS DELIBERATELY DOES NOT DO: it does not change those runtime defaults.
# Measured on the live fleet — both minis' ~/.config/catalyst/cloud-sync.env is a
# single line containing only the token, pinning NEITHER the account NOR the base
# URL. Changing either default would repoint or break both running replica writers
# the moment they restarted. New installs get explicit values written here; the
# defaults are a separate, evidence-gathering change.
# validate_cloud_token TOKEN ACCOUNT BASE_URL — ONE authenticated call, and the
# install refuses to continue unless it comes back 200. (CTL-1913)
#
# Endpoint choice is measured, not guessed. There is no /health, /me, /whoami or
# /accounts on the hub (all 404), and `GET /issues?limit=1` discriminates BOTH
# failure modes this function exists to catch — verified live 2026-08-17 against
# staging.catalystcloud.dev:
#
#   valid token   + correct account -> 200
#   garbage token + correct account -> 401 unauthorized
#   valid token   + WRONG account   -> 403 forbidden
#
# That 403 is the tenant-0 footgun the account-required check above guards
# syntactically; this catches the case where an account was supplied and is simply
# not the one the key is scoped to — previously an opaque 403 the customer only met
# hours later, in a log they had no reason to read.
#
# ⛔ EVERY NON-200 IS FATAL, INCLUDING "COULD NOT REACH". There is deliberately no
# skip flag and no soft path. Provisioning a cloud replica REQUIRES reaching the
# hub, so a host that cannot reach it at install time cannot succeed later either —
# reporting success would recreate exactly the green-install-dead-writer state this
# ticket removes. A distinct message per class keeps the failure actionable, and
# `CATALYST_CLOUD_BASE_URL` remains the supported override for a different hub.
#
# The token is passed on stdin via a config file, never on the argv of a command
# (`ps` is world-readable) and never interpolated into a URL.
validate_cloud_token() {
	local token="$1" account="$2" base_url="$3"

	if ! command -v curl >/dev/null 2>&1; then
		print_error "curl not found — cannot validate the cloud token."
		echo ""
		echo "  The install refuses to write a cloud config it could not verify."
		echo "  Install curl and re-run."
		return 1
	fi

	echo "  Validating the cloud token against ${base_url} ..."

	# --max-time bounds a hung hub; -sS keeps the body quiet but lets curl's own
	# error reach stderr. The header goes in a config file read from stdin so the
	# bearer token never appears in this process's argv.
	local code
	code=$(
		printf 'header = "Authorization: Bearer %s"\n' "$token" |
			curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
				--config - \
				"${base_url}/issues?account=${account}&limit=1" 2>/dev/null
	) || code=""

	case "$code" in
	200)
		print_success "cloud token validated against the hub (HTTP 200, account=${account})"
		return 0
		;;
	401)
		print_error "The cloud token was REJECTED by the hub (HTTP 401 unauthorized)."
		echo ""
		echo "  The token is wrong, expired, or revoked. Nothing has been written."
		echo "  Re-run with a valid --cloud-token."
		return 1
		;;
	403)
		print_error "The token is valid but NOT scoped to account '${account}' (HTTP 403 forbidden)."
		echo ""
		echo "  The hub forces the account to match the key. Check --cloud-account"
		echo "  against the tenant the token was issued for. Nothing has been written."
		return 1
		;;
	000 | "")
		print_error "Could not reach the hub at ${base_url} — the token was NOT validated."
		echo ""
		echo "  A cloud replica cannot be provisioned without reaching the hub, so this"
		echo "  is fatal rather than a warning: reporting success here is what produced"
		echo "  green installs with a permanently dead writer (CTL-1913)."
		echo ""
		echo "  Check the host resolves and is reachable, then re-run:"
		echo "    curl -sS -o /dev/null -w '%{http_code}\\n' ${base_url}/issues"
		echo "  (an unauthenticated 401 proves the host serves the API)"
		return 1
		;;
	*)
		print_error "The hub returned HTTP ${code} — the token was NOT validated."
		echo ""
		echo "  Nothing has been written. If the hub is having an outage, re-run once"
		echo "  it recovers; a 5xx is not evidence the token is good OR bad."
		return 1
		;;
	esac
}

# ── CTL-2045 §1: refuse the wrong credential CLASS before anything reaches disk ──
#
# assert_host_write_credential_shape TOKEN — 0 when TOKEN is a per-host org key.
#
# ⛔ THE INCIDENT. mini-2's 2026-08-18 reinstall provisioned the tenant-wide ADMIN_TOKEN
# as this host's write credential. The cloud's agent routes correctly refuse an admin
# bearer for writes, so every cross-host claim 403'd and the board froze from ~15:00 CT
# — and `catalyst doctor` passed, the daemons ran, the heartbeat stayed fresh, and the
# local write ledger read `2` with ZERO refusals the whole time, because nothing ever got
# far enough to be refused locally.
#
# The classification itself lives in ONE place (lib/host-write-credential.mjs, mirrored
# for bash in lib/catalyst-host-write-credential.sh, held honest over a shared fixture
# table by __tests__/host-write-credential-parity.test.sh). Read that header for why this
# is a positive ALLOW-LIST rather than a blacklist of admin-bearer shapes, and why it does
# not gate on the token's LENGTH.
#
# ⚠️ FAILS CLOSED WHEN THE CLASSIFIER CANNOT BE LOADED. A guard that silently skips itself
# when its helper is missing is worse than no guard: it reports the same green install as
# a passing check, which is the precise shape of the bug being fixed here.
assert_host_write_credential_shape() {
	local token="$1"

	catalyst_helper_path "lib/catalyst-host-write-credential.sh" >/dev/null || {
		print_error "Cannot verify the cloud credential's class — the classifier is unavailable."
		echo ""
		echo "  Reason: ${CATALYST_SOURCE_REASON:-unknown}"
		echo ""
		echo "  This check refuses rather than skips. Provisioning a host write credential"
		echo "  without classifying it is what put mini-2 into a silent dispatch deadlock"
		echo "  for four hours on 2026-08-18 (CTL-2045) — every existing check stayed green."
		return 1
	}
	# shellcheck disable=SC1090
	source "$CATALYST_HELPER_PATH"

	# ⛔ Called DIRECTLY, never as `$(…)`. The verdict rides globals; a command
	# substitution runs the function in a subshell and discards all of them.
	if catalyst_classify_host_write_credential "$token"; then
		print_success "cloud credential is a per-host organization key (${CATALYST_CREDENTIAL_SHAPE})"
		return 0
	fi

	print_error "The cloud token is NOT a per-host write credential — got ${CATALYST_CREDENTIAL_SHAPE}."
	echo ""
	echo "  Class:  ${CATALYST_CREDENTIAL_VERDICT}"
	echo "  Detail: ${CATALYST_CREDENTIAL_DETAIL}"
	echo ""
	echo "  A host write credential must be a per-host ORGANIZATION key — it begins"
	echo "  '${CATALYST_HOST_WRITE_CREDENTIAL_PREFIX}'. The cloud derives this host's identity from that key;"
	echo "  a credential it cannot bind to a host is refused on every claim write, so the"
	echo "  host installs green and then claims NOTHING, on any phase, forever."
	echo ""
	echo "  Mint a per-host key for this host and re-run with it. Nothing has been written."
	return 1
}

# ── CTL-2045 §2: prove this host can actually take a fence ──────────────────────────
#
# validate_cloud_agent_binding TOKEN ACCOUNT BASE_URL
#
# ⭐ THE HALF THAT ACTUALLY CLOSES THE HOLE, and it is NOT what validate_cloud_token does.
# That function calls `GET /issues` — the GENERIC read route, which never goes through the
# cloud's `resolveAgentPrincipal`. mini-2's admin bearer sailed through it with a 200 and
# then 403'd on every single claim. ⛔ A shape check plus a generic read is still two
# checks that both pass on the broken credential.
#
# The `/agent/*` family is the one the claim actually uses, and the cloud's own code
# settles which call is sufficient — plugins/dev/scripts/execution-core/linear-write-proxy.mjs:83:
#
#     "The GET read-back is NOT a weaker check than a write … resolveReadOnlyAgentContext
#      calls the SAME resolveAgentPrincipal as resolveWriteContext, including
#      hostId = authz.keyId and the `if (!hostId) -> 403` refusal. Only the BUDGET half
#      differs. So `GET /agent/attachments` -> 200 already proves a per-host binding, and
#      it is the right preflight before arming a host."
#
# ⭐ So the preflight is a GET, and that is a strictly better install-time probe than the
# real write the ticket's AC2 describes: it exercises the identical per-host binding
# refusal, while creating nothing, needing no scratch ticket, requiring no release step
# that could fail and leave residue, and spending ZERO of the host's daily write budget.
#
# ⚠️ THE VERDICT IS THREE-VALUED, and the pass arm is deliberately wide.
#   401/403 → REFUSE. This is the incident's exact signature: the credential is rejected
#             at the agent route family. Nothing else here is evidence of anything.
#   2xx/404/400 → PASS. The request got PAST authorization to issue resolution, which is
#             all this probe claims. A 404 on a probe issue id is the AUTHORIZED answer
#             (measured 2026-08-18: a per-host key against its own account returns 404 on
#             an absent issue; the admin bearer returned 403 for the same request), so
#             pinning the pass arm to "200 only" would refuse every correct install.
#   anything else (000, 5xx) → REFUSE as UNVERIFIED, not as broken. Same posture
#             validate_cloud_token already takes for an unreachable hub (CTL-1913):
#             reporting success on a check that did not run is what produced green
#             installs with permanently dead writers.
validate_cloud_agent_binding() {
	local token="$1" account="$2" base_url="$3"

	# A deliberately absent issue: this probe must never touch a real ticket, and the
	# authorization verdict it reads is decided before issue resolution either way.
	local probe_issue="CATALYST-INSTALL-PROBE"

	echo "  Verifying this host's per-host binding on the agent write path ..."

	local code
	code=$(
		printf 'header = "Authorization: Bearer %s"\n' "$token" |
			curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
				--config - \
				"${base_url}/agent/attachments?issueId=${probe_issue}&account=${account}" 2>/dev/null
	) || code=""

	case "$code" in
	401 | 403)
		print_error "This credential is REFUSED on the agent write path (HTTP ${code})."
		echo ""
		echo "  It authenticated for generic reads but the cloud derives NO per-host"
		echo "  binding from it, so every cross-host claim this host attempts will be"
		echo "  refused. That is a silent dispatch deadlock: the daemons run, the"
		echo "  heartbeat stays fresh, doctor passes, and the host claims no ticket on"
		echo "  any phase. It cost the fleet four hours on 2026-08-18 (CTL-2045)."
		echo ""
		echo "  Use a per-host organization key minted for THIS host and account"
		echo "  '${account}'. Nothing has been written."
		return 1
		;;
	2?? | 404 | 400)
		print_success "per-host binding proven on the agent write path (HTTP ${code})"
		return 0
		;;
	000 | "")
		print_error "Could not reach ${base_url}/agent/attachments — the binding was NOT verified."
		echo ""
		echo "  Refusing rather than assuming: an unverified binding is exactly the state"
		echo "  this check exists to make impossible. Re-run once the hub is reachable."
		return 1
		;;
	*)
		print_error "The hub returned HTTP ${code} on the agent write path — binding NOT verified."
		echo ""
		echo "  Nothing has been written. A 5xx is not evidence the credential is good OR"
		echo "  bad; re-run once the hub recovers."
		return 1
		;;
	esac
}

# resolve_cloud_token — the ONE answer to "did this run get a cloud token".
#
# ⛔ Codex #3500 P1: this resolution used to live only inside setup_cloud_replica, as a
# `local`. So a token supplied through the DOCUMENTED env var (or a custom name via
# CATALYST_CLOUD_TOKEN_ENV) provisioned the writer while the global CLOUD_TOKEN stayed
# empty — and finalize_install, which gated on that global, skipped `activate-replica`
# AND recorded no deferral. Setup could report a fully provisioned node with replica
# reads off: the exact "install finished ≠ system works" gap CTL-1918 exists to close,
# reintroduced by the fix for it. Flags win over env; the configured name wins over the
# default (CTL-1668).
# resolve_cloud_account — CTL-2019. flag > env > THIS HOST'S OWN previously-recorded
# account, read back out of the cloud-sync.env that setup_cloud_replica itself wrote.
#
# ⛔ WHY. The account was WRITTEN here (`export CATALYST_CLOUD_ACCOUNT=...` below) and
# never READ back: resolution was flag-then-env only. So on any host that already has a
# discoverable cloud token but no account exported in its shell — which is every host
# after its first install, because the account lives in a file rather than the
# environment — `setup_cloud_replica` found a token, found no account, and returned 1.
# That line is `setup_cloud_replica || exit 1`, so the whole of setup aborted, and with
# it every step `catalyst install` runs afterwards: set-class, pull-owner, install-cli,
# install-services, adopt-cloud-sync, start-stack, verify-node, doctor.
#
# Measured on mini-2 during the CTL-1975 rehearsal (2026-08-18): a reinstalled node came
# up with 1 of 8 launchd agents, 0 daemons, `node.class` unset and NO REPLICA WRITER —
# which silently falls back to live `linearis` and burns the shared, rate-limited Linear
# quota. Nothing was red. The value that would have prevented all of it was sitting in
# ~/.config/catalyst/cloud-sync.env, one directory from the code that refused to look.
#
# ⚠️ This is a CARRY-FORWARD, not a default, and the distinction is the safety property
# the original comment was protecting: we re-use the account THIS host already recorded
# for itself. We still never fall back to "tenant-0" — pointing a host at the
# maintainer's tenant on a guess is exactly the 403-with-no-explanation this refuses.
# An absent/unreadable file still yields empty, and the hard error below still fires.
#
# Deliberately NOT `source`d: that file also carries the cloud TOKEN, and sourcing it
# would pull a live credential into this shell (and into every child it spawns) to read
# a non-secret identifier. One field is extracted by name instead.
resolve_cloud_account() {
	local acct="${CLOUD_ACCOUNT:-${CATALYST_CLOUD_ACCOUNT-}}"
	if [[ -z $acct ]]; then
		local env_file="$HOME/.config/catalyst/cloud-sync.env"
		if [[ -r $env_file ]]; then
			acct="$(sed -n 's/^[[:space:]]*export[[:space:]]\{1,\}CATALYST_CLOUD_ACCOUNT=//p' "$env_file" 2>/dev/null | tail -1)"
			acct="${acct%\"}"
			acct="${acct#\"}"
			acct="${acct%\'}"
			acct="${acct#\'}"
		fi
	fi
	printf '%s' "$acct"
}

resolve_cloud_token() {
	local _tv="${CATALYST_CLOUD_TOKEN_ENV-}"
	if [[ -z $_tv ]] && [[ -r "$HOME/.config/catalyst/config.json" ]] && command -v jq >/dev/null 2>&1; then
		_tv="$(jq -r '.catalyst.cloud.tokenEnv // empty' "$HOME/.config/catalyst/config.json" 2>/dev/null || true)"
	fi
	[[ -n $_tv ]] || _tv="CATALYST_CLOUD_TOKEN"
	printf '%s' "${CLOUD_TOKEN:-${!_tv-}}"
}

# Set only when the replica was actually provisioned. finalize_install keys activation
# on the OUTCOME, not on a re-derived precondition — activating reads against a replica
# that was never provisioned is meaningless, and re-deriving is how the two drifted.
CLOUD_REPLICA_PROVISIONED=0

setup_cloud_replica() {
	# Flags win over env. Absent → this whole function is a no-op and setup is
	# byte-identical to before CTL-1836.
	local token account
	token="$(resolve_cloud_token)"
	account="$(resolve_cloud_account)"
	[[ -n $token ]] || return 0

	print_header "Provisioning Catalyst Cloud Replica"

	if [[ -z $account ]]; then
		print_error "A cloud token was supplied without an account."
		echo ""
		echo "  Pass --cloud-account <id> (or set CATALYST_CLOUD_ACCOUNT)."
		echo ""
		echo "  There is no default on purpose. The writer's built-in fallback is"
		echo "  'tenant-0', which is the Catalyst maintainer's own tenant — defaulting"
		echo "  to it would point THIS host at somebody else's workspace. Your key"
		echo "  would be refused with an opaque 403 and no explanation."
		return 1
	fi

	local config_dir="$HOME/.config/catalyst"
	local env_file="${config_dir}/cloud-sync.env"

	harden_secrets_dir "$config_dir"
	ensure_secrets_gitignore "$config_dir"

	# ⛔ CTL-1910 — THIS COMMENT USED TO BE BACKWARDS, AND THE VALUE WITH IT.
	# It called `app.catalystcloud.dev` "the canonical host" and
	# `api.catalyst-cloud.coalescelabs.ai` "the LEGACY ... being retired". Measured
	# 2026-08-17 from two hosts, with a control:
	#
	#   web.dev                             RESOLVES            <- control: .dev resolves here
	#   app.catalystcloud.dev               NXDOMAIN (curl rc=6)   the pinned "canonical" host
	#   catalystcloud.dev                   NXDOMAIN
	#   staging.catalystcloud.dev           200 with a live token
	#   api.catalyst-cloud.coalescelabs.ai  200 with a live token  the "retired" one
	#
	# The control matters: `web.dev` resolving proves the resolver handles `.dev`, so
	# the NXDOMAIN is a real absence and not a broken lookup. So the host called
	# canonical does not exist, and the one called retired is one of the two that
	# actually answer. This function was writing the dead one into every new
	# customer's 0600 launchd-sourced config: the writer could never reach the hub,
	# the replica was never created, and setup exited 0 with two green checkmarks.
	#
	# Now pinned to `staging.catalystcloud.dev` (COORD's ruling — the live cloud).
	# Verified equivalent, not assumed: authenticated `GET /api/v1/issues?limit=1`
	# against staging and against the legacy host returned 200 with a
	# BYTE-IDENTICAL first record, so they are the same backend serving the same
	# tenant.
	#
	# ⚠️ `cloud-sync.mjs`'s own DEFAULT_BASE_URL is deliberately NOT changed here.
	# The three hosts already running pin no base URL at all (measured: mini-2's
	# cloud-sync.env has no CATALYST_CLOUD_BASE_URL line), so they resolve the code
	# default — repointing it would repoint every live writer on its next restart.
	# That is a fleet change, not an installer fix. New installs get an explicit
	# value written below.
	local base_url="${CATALYST_CLOUD_BASE_URL:-https://staging.catalystcloud.dev/api/v1}"

	# ⛔ CTL-1913 — VALIDATE BEFORE WRITING ANYTHING.
	# Ordered first on purpose: a config we have already proven cannot work must
	# never reach disk. Previously nothing on this path made a single network call,
	# so a correct token and `FAKE-TOKEN-NOT-REAL` produced byte-identical output —
	# two green checkmarks and exit 0 — and the customer's only symptom was a
	# replica that never appeared. (Why it stays silent: a tokenless/rejected writer
	# `process.exit(0)`s, and under `KeepAlive={SuccessfulExit:false}` a clean exit
	# is PERMANENT — launchd never retries.)
	# ⛔ CTL-2045 — THREE GATES, CHEAPEST FIRST, AND NONE OF THEM WRITES.
	#
	# §1 the credential's CLASS (local, no network): refuses the admin bearer / a user key
	#    / a bare sk_ issuer key before a single packet leaves the host.
	# §2 the credential AUTHENTICATES at all (CTL-1913's generic read).
	# §3 the credential is PER-HOST BOUND on the agent write path (CTL-2045).
	#
	# ⚠️ The order is load-bearing and §3 is not redundant with §2. A well-SHAPED key can
	# still carry the wrong grants, the wrong tenant, or the wrong endpoint — all three were
	# live hypotheses during the 2026-08-18 incident — and a generic read cannot see any of
	# them. Conversely §1 catches the mis-provisioned class with no round trip at all, and
	# names it precisely, rather than leaving the operator to interpret a bare 403.
	assert_host_write_credential_shape "$token" || return 1
	validate_cloud_token "$token" "$account" "$base_url" || return 1
	validate_cloud_agent_binding "$token" "$account" "$base_url" || return 1

	# ⛔ EVERY LINE MUST BE `export` (Codex P1 on #3365). launch.sh SOURCES this file
	# and then `exec`s bun. A bare `FOO=bar` in a sourced file is a SHELL-LOCAL
	# variable — it is not in the child's environment, so bun would see no token,
	# take its tokenless idle path, and `process.exit(0)`. Under the agent's
	# `KeepAlive={SuccessfulExit:false}` a clean exit is PERMANENT: launchd never
	# restarts it, and the only symptom is a replica that quietly stops advancing.
	# (Verified against the three hosts already running: every existing
	# cloud-sync.env uses `export`. This is the established form, not a new one.)
	#
	# CTL-1668: the token's env-var NAME is configurable, so honour the same
	# precedence the writer resolves with — env override → Layer-2
	# catalyst.cloud.tokenEnv → default. Writing a fixed name while the writer looks
	# up a custom one produces the identical silent idle.
	local token_var="${CATALYST_CLOUD_TOKEN_ENV-}"
	if [[ -z $token_var ]]; then
		local l2_cfg="$HOME/.config/catalyst/config.json"
		if [[ -r $l2_cfg ]] && command -v jq >/dev/null 2>&1; then
			token_var="$(jq -r '.catalyst.cloud.tokenEnv // empty' "$l2_cfg" 2>/dev/null || true)"
		fi
	fi
	[[ -n $token_var ]] || token_var="CATALYST_CLOUD_TOKEN"

	# launchd does not read ~/.zshenv, so the writer's credentials have to live in
	# this file. Written 0600 BEFORE the secret lands in it — never world-readable,
	# not even momentarily.
	local tmp_env
	tmp_env=$(mktemp)
	chmod 600 "$tmp_env"
	{
		echo "# Written by setup-catalyst.sh (CTL-1836). Consumed by"
		echo "# plugins/dev/scripts/execution-core/cloud-sync/launch.sh under launchd."
		echo "# Every line is exported: launch.sh sources this then execs bun, and a"
		echo "# non-exported assignment would leave the writer tokenless (silent idle exit)."
		echo "export ${token_var}=${token}"
		echo "export CATALYST_CLOUD_ACCOUNT=${account}"
		echo "export CATALYST_CLOUD_BASE_URL=${base_url}"
	} >"$tmp_env"
	mv "$tmp_env" "$env_file"
	chmod 600 "$env_file"
	print_success "Wrote $env_file (0600) — account and base URL pinned explicitly"

	# Adopt the writer. Optional by design: a host without the stack installed still
	# gets a correct env file, and adopting later picks it up.
	local stack
	stack=$(command -v catalyst-stack 2>/dev/null || true)
	if [[ -n $stack ]]; then
		# ⛔ CTL-1913: the output is CAPTURED, not discarded. This was
		# `>/dev/null 2>&1`, so whatever adopt-cloud-sync said about why it was
		# unhappy was unrecoverable — the operator got one generic warning line for
		# every possible cause. Kept out of the way on success, shown in full on
		# failure, which is the only time anyone wants it.
		local adopt_out adopt_rc=0
		adopt_out=$("$stack" adopt-cloud-sync 2>&1) || adopt_rc=$?
		if [[ $adopt_rc -eq 0 ]]; then
			print_success "cloud-sync writer adopted (launchd agent installed)"
		else
			print_warning "catalyst-stack adopt-cloud-sync failed (rc=${adopt_rc}) — its output follows"
			# Indented so it reads as sub-output rather than as this script's own.
			printf '%s\n' "$adopt_out" | sed 's/^/    /'
			echo ""
			echo "  Fix the cause above, then re-run: catalyst-stack adopt-cloud-sync"
		fi
	else
		print_warning "catalyst-stack not on PATH — run 'catalyst-stack adopt-cloud-sync' after installing the stack"
	fi

	# CTL-1918: replica READS and registry enrolment used to be PRINTED here as
	# advisory text — a populated replica that nothing reads, and a daemon with no
	# work to find, both looking identical to a healthy install. finalize_install now
	# performs both (and defers them with a verify command if it cannot), so printing
	# them here would tell an operator to redo work that is already done.

	# Reaching here means the writer env was written and the account was accepted, so
	# there IS a replica for reads to be turned on against. Set at the single success
	# exit rather than at the top: a function that announces provisioning before doing
	# it hands finalize_install a precondition that was never met.
	CLOUD_REPLICA_PROVISIONED=1
	return 0
}

setup_catalyst_secrets() {
	print_header "Setting Up Catalyst Secrets"

	local config_dir="$HOME/.config/catalyst"
	local config_file="${config_dir}/config-${PROJECT_KEY}.json"

	harden_secrets_dir "$config_dir"
	ensure_secrets_gitignore "$config_dir"

	echo "This config file stores API tokens and secrets."
	echo "Location: $config_file"
	echo ""
	echo "You can configure integrations now or skip and add them later."
	echo ""

	# Check if config exists
	if [ -f "$config_file" ]; then
		print_warning "Found existing secrets config"

		if ! ask_yes_no "Update/add integrations?"; then
			print_success "Keeping existing secrets config"
			return 0
		fi

		# Load existing config
		local existing_config
		existing_config=$(cat "$config_file")
	else
		# Create empty config
		existing_config='{"catalyst":{}}'
	fi

	# Prompt for each integration (CTL-843: private mktemp, not a fixed /tmp path)
	local prompt_tmp
	prompt_tmp=$(mktemp)
	prompt_linear_config "$existing_config" >"$prompt_tmp"
	existing_config=$(cat "$prompt_tmp")

	prompt_sentry_config "$existing_config" >"$prompt_tmp"
	existing_config=$(cat "$prompt_tmp")

	prompt_posthog_config "$existing_config" >"$prompt_tmp"
	existing_config=$(cat "$prompt_tmp")

	prompt_exa_config "$existing_config" >"$prompt_tmp"
	existing_config=$(cat "$prompt_tmp")
	rm -f "$prompt_tmp"

	# Save final config (CTL-843: backup + atomic write)
	write_secrets_config "$existing_config" "$config_file"

	print_success "Secrets config saved: $config_file"
	echo ""
}

prompt_linear_config() {
	local config="$1"

	echo "" >&2
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
	echo "Linear Configuration (Project Management)" >&2
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
	echo "" >&2

	# Check if already configured
	local has_token
	has_token=$(echo "$config" | jq -r '.catalyst.linear.apiToken // empty')

	if [ -n "$has_token" ] && [ "$has_token" != "[NEEDS_SETUP]" ]; then
		echo "✓ Linear already configured" >&2
		if ! ask_yes_no "Update Linear config?"; then
			echo "$config"
			return 0
		fi
	fi

	if [[ $NON_INTERACTIVE -eq 1 ]] && ! discover_linear_token >/dev/null 2>&1; then
		echo "Skipping Linear (non-interactive, no token discoverable)." >&2
		echo "$config"
		return 0
	fi

	if ! ask_yes_no "Configure Linear integration?"; then
		echo "Skipping Linear. You can add it later by re-running this script." >&2
		echo "$config"
		return 0
	fi

	echo "" >&2

	local discovered_token=""
	local discovery_source=""
	local linear_token=""
	local linear_org=""
	local linear_teams=""
	local linear_team=""
	local linear_team_name=""

	# Try to discover existing token
	echo "🔍 Checking for existing Linear API token..." >&2

	if discovered_token=$(discover_linear_token 2>&1); then
		discovery_source=$(echo "$discovered_token" | head -1)
		discovered_token=$(echo "$discovered_token" | tail -1)

		echo "" >&2
		echo "✓ Found existing Linear API token in: $discovery_source" >&2

		# Validate the token
		echo "🔍 Validating token and fetching organization info..." >&2

		if validation_result=$(validate_linear_token "$discovered_token" 2>&1); then
			# Extract info
			linear_org=$(echo "$validation_result" | jq -r '.viewer.organization.name')
			local org_key=$(echo "$validation_result" | jq -r '.viewer.organization.urlKey')
			linear_teams=$(echo "$validation_result" | jq -r '.teams')

			echo "" >&2
			echo "✓ Token is valid!" >&2
			echo "  Organization: $linear_org ($org_key)" >&2
			echo "  Found $(echo "$linear_teams" | jq 'length') team(s):" >&2
			echo "$linear_teams" | jq -r '.[] | "    - \(.key): \(.name)"' >&2
			echo "" >&2

			if ask_yes_no "Use this token?"; then
				linear_token="$discovered_token"

				# Let user select team
				local team_count=$(echo "$linear_teams" | jq 'length')

				if [[ $team_count -eq 1 ]]; then
					# Only one team, use it
					linear_team=$(echo "$linear_teams" | jq -r '.[0].key')
					linear_team_name=$(echo "$linear_teams" | jq -r '.[0].name')
					echo "Using team: $linear_team ($linear_team_name)" >&2
				else
					# Multiple teams
					if [[ $NON_INTERACTIVE -eq 1 ]]; then
						linear_team=$(echo "$linear_teams" | jq -r '.[0].key')
						linear_team_name=$(echo "$linear_teams" | jq -r '.[0].name')
						echo "Non-interactive: auto-selecting first team: $linear_team ($linear_team_name)" >&2
					else
						echo "Select a team:" >&2
						echo "$linear_teams" | jq -r 'to_entries | .[] | "  \(.key + 1). \(.value.key): \(.value.name)"' >&2
						echo "" >&2

						read -p "Enter team number [1-$team_count]: " team_num
						team_num=$((team_num - 1))

						linear_team=$(echo "$linear_teams" | jq -r ".[$team_num].key")
						linear_team_name=$(echo "$linear_teams" | jq -r ".[$team_num].name")
					fi
				fi
			fi
		else
			echo "⚠ Token validation failed. You'll need to enter it manually." >&2
		fi
	fi

	# If no token discovered or user declined, ask for it
	if [[ -z $linear_token ]]; then
		echo "" >&2
		echo "Linear API Token Setup:" >&2
		echo "  📚 Documentation: https://linear.app/docs/api-and-webhooks#api-keys" >&2
		echo "" >&2
		echo "  Steps:" >&2
		echo "  1. Go to https://linear.app/settings/api" >&2
		echo "  2. Click 'Create key' under Personal API Keys" >&2
		echo "  3. Give it a name (e.g., 'Catalyst')" >&2
		echo "  4. Copy the token (starts with 'lin_api_')" >&2
		echo "" >&2
		echo "  TIP: Save to ~/.linear_api_token to auto-discover next time:" >&2
		echo "       echo 'YOUR_TOKEN' > ~/.linear_api_token" >&2
		echo "" >&2

		read -p "Linear API token: " linear_token

		# Validate the manually entered token
		if [[ -n $linear_token ]]; then
			echo "" >&2
			echo "🔍 Validating token..." >&2

			if validation_result=$(validate_linear_token "$linear_token" 2>&1); then
				linear_org=$(echo "$validation_result" | jq -r '.viewer.organization.name')
				linear_teams=$(echo "$validation_result" | jq -r '.teams')

				echo "✓ Token is valid!" >&2
				echo "  Organization: $linear_org" >&2
				echo "" >&2

				# Offer to save token
				if ask_yes_no "Save token to ~/.linear_api_token for future use?"; then
					echo "$linear_token" >~/.linear_api_token
					chmod 600 ~/.linear_api_token
					echo "✓ Token saved to ~/.linear_api_token" >&2
				fi
			else
				echo "⚠ Warning: Token validation failed. Saving anyway..." >&2
			fi
		fi
	fi

	# Get team key (auto-detect from project config or use validated data)
	if [[ -z $linear_team ]]; then
		local _cfg="${PROJECT_DIR}/.catalyst/config.json"
		[[ ! -f $_cfg ]] && _cfg="${PROJECT_DIR}/.claude/config.json"
		if [ -f "$_cfg" ]; then
			linear_team=$(jq -r '.catalyst.project.ticketPrefix // "PROJ"' "$_cfg")
			echo "" >&2
			echo "Team Key (Identifier): Using '${linear_team}' from project config" >&2
			echo "  (This matches your ticket prefix for consistency)" >&2
		else
			echo "" >&2
			echo "Team Key (Identifier):" >&2
			echo "  This is the short prefix used in your Linear issue IDs." >&2
			echo "  Example: If your issues are 'ENG-123', the key is 'ENG'" >&2
			echo "  📚 Find it: Linear → Settings → Teams → [Your Team] → Identifier field" >&2
			echo "" >&2
			read -p "Linear team key (identifier): " linear_team
		fi
	fi

	# Get team name if not already set
	if [[ -z $linear_team_name ]]; then
		echo "" >&2
		echo "Team Name:" >&2
		echo "  The full name of your Linear team (not the short identifier)" >&2
		echo "  📚 Find it: Linear → Settings → Teams → [Your Team] → Name field" >&2
		echo "" >&2
		read -p "Linear team name: " linear_team_name
	fi

	# Build config (CTL-843: merge — never drop unprompted keys like .agent)
	local patch
	patch=$(jq -n --arg token "$linear_token" --arg team "$linear_team" \
		--arg teamName "$linear_team_name" \
		'{apiToken: $token, teamKey: $team, defaultTeam: $teamName}')
	merge_catalyst_section "$config" linear "$patch" \
		'["apiToken","teamKey","defaultTeam"]'
}

prompt_sentry_config() {
	local config="$1"

	echo "" >&2
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
	echo "Sentry Configuration (Error Monitoring)" >&2
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
	echo "" >&2

	# Check if already configured
	local has_token
	has_token=$(echo "$config" | jq -r '.catalyst.sentry.authToken // empty')

	if [ -n "$has_token" ] && [ "$has_token" != "[NEEDS_SETUP]" ]; then
		echo "✓ Sentry already configured" >&2
		if ! ask_yes_no "Update Sentry config?"; then
			echo "$config"
			return 0
		fi
	fi

	if [[ $NON_INTERACTIVE -eq 1 ]] && ! discover_sentry_token >/dev/null 2>&1; then
		echo "Skipping Sentry (non-interactive, no token discoverable)." >&2
		echo "$config"
		return 0
	fi

	if ! ask_yes_no "Configure Sentry integration?"; then
		echo "Skipping Sentry. You can add it later by re-running this script." >&2
		echo "$config"
		return 0
	fi

	echo "" >&2

	local discovered_token=""
	local discovery_source=""
	local sentry_token=""
	local sentry_orgs=""
	local sentry_org=""
	local sentry_projects=""
	local sentry_project=""

	# Try to discover existing token
	echo "🔍 Checking for existing Sentry auth token..." >&2

	if discovered_token=$(discover_sentry_token 2>&1); then
		discovery_source=$(echo "$discovered_token" | head -1)
		discovered_token=$(echo "$discovered_token" | tail -1)

		echo "" >&2
		echo "✓ Found existing Sentry auth token in: $discovery_source" >&2

		# Validate the token
		echo "🔍 Validating token and fetching organization info..." >&2

		if validation_result=$(validate_sentry_token "$discovered_token" 2>&1); then
			# Extract info
			sentry_orgs=$(echo "$validation_result" | jq -r '.organizations')

			echo "" >&2
			echo "✓ Token is valid!" >&2
			echo "  Found $(echo "$sentry_orgs" | jq 'length') organization(s):" >&2
			echo "$sentry_orgs" | jq -r '.[] | "    - \(.slug): \(.name)"' >&2
			echo "" >&2

			if ask_yes_no "Use this token?"; then
				sentry_token="$discovered_token"

				# Let user select organization
				local org_count=$(echo "$sentry_orgs" | jq 'length')

				if [[ $org_count -eq 1 ]]; then
					# Only one org, use it
					sentry_org=$(echo "$sentry_orgs" | jq -r '.[0].slug')
					local org_name=$(echo "$sentry_orgs" | jq -r '.[0].name')
					echo "Using organization: $sentry_org ($org_name)" >&2

					# Get projects for this org
					sentry_projects=$(echo "$validation_result" | jq -r '.projects')
					echo "  Found $(echo "$sentry_projects" | jq 'length') project(s)" >&2
				else
					# Multiple orgs
					if [[ $NON_INTERACTIVE -eq 1 ]]; then
						sentry_org=$(echo "$sentry_orgs" | jq -r '.[0].slug')
						local ni_org_name=$(echo "$sentry_orgs" | jq -r '.[0].name')
						echo "Non-interactive: auto-selecting first org: $sentry_org ($ni_org_name)" >&2
					else
						echo "Select an organization:" >&2
						echo "$sentry_orgs" | jq -r 'to_entries | .[] | "  \(.key + 1). \(.value.slug): \(.value.name)"' >&2
						echo "" >&2

						read -p "Enter organization number [1-$org_count]: " org_num
						org_num=$((org_num - 1))

						sentry_org=$(echo "$sentry_orgs" | jq -r ".[$org_num].slug")
					fi
				fi

				# Let user select project(s)
				if [[ -n $sentry_projects ]]; then
					local project_count=$(echo "$sentry_projects" | jq 'length')

					if [[ $project_count -eq 1 ]]; then
						sentry_project=$(echo "$sentry_projects" | jq -r '.[0].slug')
						local project_name=$(echo "$sentry_projects" | jq -r '.[0].name')
						echo "Using project: $sentry_project ($project_name)" >&2
					elif [[ $project_count -gt 1 ]]; then
						echo "" >&2
						echo "Found $project_count projects:" >&2
						echo "$sentry_projects" | jq -r 'to_entries | .[] | "  \(.key + 1). \(.value.slug): \(.value.name)"' >&2
						echo "" >&2
						echo "Options:" >&2
						echo "  A. Monitor all projects (recommended for multi-project setups)" >&2
						echo "  S. Select specific projects to monitor" >&2
						echo "  1-$project_count. Choose one default project" >&2
						echo "" >&2

						if [[ $NON_INTERACTIVE -eq 1 ]]; then
							project_choice="A"
							echo "Non-interactive: auto-selecting all projects" >&2
						else
							read -p "Enter choice [A/S/1-$project_count]: " project_choice
						fi

						case "${project_choice^^}" in
						A)
							echo "✓ Will monitor all projects in organization" >&2
							sentry_project="" # Empty = all projects
							;;
						S)
							echo "" >&2
							echo "Enter project numbers to monitor (space-separated, e.g., '1 3 5'):" >&2
							read -p "Projects: " selected_nums

							local selected_projects="[]"
							for num in $selected_nums; do
								num=$((num - 1))
								local proj_slug=$(echo "$sentry_projects" | jq -r ".[$num].slug")
								if [[ $proj_slug != "null" ]]; then
									selected_projects=$(echo "$selected_projects" | jq --arg slug "$proj_slug" '. += [$slug]')
								fi
							done

							sentry_project="$selected_projects"
							echo "✓ Will monitor $(echo "$selected_projects" | jq 'length') project(s)" >&2
							;;
						[0-9]*)
							project_num=$((project_choice - 1))
							sentry_project=$(echo "$sentry_projects" | jq -r ".[$project_num].slug")
							local project_name=$(echo "$sentry_projects" | jq -r ".[$project_num].name")
							echo "✓ Using default project: $sentry_project ($project_name)" >&2
							;;
						*)
							echo "⚠ Invalid choice, will monitor all projects" >&2
							sentry_project=""
							;;
						esac
					fi
				fi
			fi
		else
			echo "⚠ Token validation failed. You'll need to enter it manually." >&2
		fi
	fi

	# If no token discovered or user declined, ask for it
	if [[ -z $sentry_token ]]; then
		echo "" >&2
		echo "Sentry Auth Token Setup:" >&2
		echo "  📚 Documentation: https://docs.sentry.io/api/auth/" >&2
		echo "" >&2
		echo "  Steps:" >&2
		echo "  1. Go to https://sentry.io/settings/account/api/auth-tokens/" >&2
		echo "  2. Click 'Create New Token'" >&2
		echo "  3. Give it a name (e.g., 'Catalyst')" >&2
		echo "  4. Select scopes: project:read, org:read" >&2
		echo "  5. Copy the token" >&2
		echo "" >&2
		echo "  TIP: Save to ~/.sentryclirc to auto-discover next time:" >&2
		echo "       echo '[auth]' > ~/.sentryclirc" >&2
		echo "       echo 'token=YOUR_TOKEN' >> ~/.sentryclirc" >&2
		echo "" >&2

		read -p "Sentry auth token: " sentry_token

		# Validate the manually entered token
		if [[ -n $sentry_token ]]; then
			echo "" >&2
			echo "🔍 Validating token..." >&2

			if validation_result=$(validate_sentry_token "$sentry_token" 2>&1); then
				sentry_orgs=$(echo "$validation_result" | jq -r '.organizations')

				echo "✓ Token is valid!" >&2
				echo "  Found $(echo "$sentry_orgs" | jq 'length') organization(s)" >&2
				echo "" >&2

				# Offer to save token
				if ask_yes_no "Save token to ~/.sentryclirc for future use?"; then
					cat >~/.sentryclirc <<EOF
[auth]
token=$sentry_token
EOF
					chmod 600 ~/.sentryclirc
					echo "✓ Token saved to ~/.sentryclirc" >&2
				fi
			else
				echo "⚠ Warning: Token validation failed. Saving anyway..." >&2
			fi
		fi
	fi

	# Get org slug if not already set
	if [[ -z $sentry_org ]]; then
		echo "" >&2
		echo "Organization Slug:" >&2
		echo "  Your Sentry organization URL slug" >&2
		echo "  Example: If your URL is https://my-org.sentry.io, enter 'my-org'" >&2
		echo "" >&2
		read -p "Sentry organization slug: " sentry_org
	fi

	# Get project slug if not already set
	if [[ -z $sentry_project ]]; then
		echo "" >&2
		echo "Project Slug:" >&2
		echo "  Your main Sentry project slug" >&2
		echo "  📚 Find it: Sentry → Settings → Projects → [Your Project]" >&2
		echo "" >&2
		read -p "Sentry project slug: " sentry_project
	fi

	# Build config (CTL-843: merge — never drop unprompted keys)
	local sentry_owned='["org","project","projects","defaultProject","authToken"]'
	local patch
	if [[ -z $sentry_project ]]; then
		patch=$(jq -n --arg org "$sentry_org" --arg token "$sentry_token" \
			'{org: $org, authToken: $token}')
	elif [[ $sentry_project =~ ^\[.*\]$ ]]; then
		patch=$(jq -n --arg org "$sentry_org" --argjson projects "$sentry_project" \
			--arg token "$sentry_token" \
			'{org: $org, projects: $projects, defaultProject: $projects[0], authToken: $token}')
	else
		patch=$(jq -n --arg org "$sentry_org" --arg project "$sentry_project" \
			--arg token "$sentry_token" \
			'{org: $org, project: $project, authToken: $token}')
	fi
	merge_catalyst_section "$config" sentry "$patch" "$sentry_owned"
}

prompt_posthog_config() {
	local config="$1"

	echo "" >&2
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
	echo "PostHog Configuration (Analytics)" >&2
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
	echo "" >&2

	# Check if already configured
	local has_token
	has_token=$(echo "$config" | jq -r '.catalyst.posthog.apiKey // empty')

	if [ -n "$has_token" ] && [ "$has_token" != "[NEEDS_SETUP]" ]; then
		echo "✓ PostHog already configured" >&2
		if ! ask_yes_no "Update PostHog config?"; then
			echo "$config"
			return 0
		fi
	fi

	if [[ $NON_INTERACTIVE -eq 1 ]]; then
		echo "Skipping PostHog (non-interactive, no token discovery available)." >&2
		echo "$config"
		return 0
	fi

	if ! ask_yes_no "Configure PostHog integration?"; then
		echo "Skipping PostHog. You can add it later by re-running this script." >&2
		echo "$config"
		return 0
	fi

	echo "" >&2
	echo "" >&2
	echo "PostHog Personal API Key Setup:" >&2
	echo "  📚 Documentation: https://posthog.com/docs/api" >&2
	echo "" >&2
	echo "  Steps:" >&2
	echo "  1. Click your avatar (bottom left) → gear icon → Account settings" >&2
	echo "  2. Go to 'Personal API Keys' tab" >&2
	echo "  3. Click 'Create personal API key'" >&2
	echo "  4. Add a name and select required scopes" >&2
	echo "  5. Copy the key (shown only once!)" >&2
	echo "" >&2

	read -p "PostHog API key: " posthog_key
	read -p "PostHog project ID: " posthog_project

	local patch
	patch=$(jq -n --arg apiKey "$posthog_key" --arg projectId "$posthog_project" \
		'{apiKey: $apiKey, projectId: $projectId}')
	merge_catalyst_section "$config" posthog "$patch" '["apiKey","projectId"]'
}

prompt_exa_config() {
	local config="$1"

	echo "" >&2
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
	echo "Exa Configuration (Search API)" >&2
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
	echo "" >&2

	# Check if already configured
	local has_token
	has_token=$(echo "$config" | jq -r '.catalyst.exa.apiKey // empty')

	if [ -n "$has_token" ] && [ "$has_token" != "[NEEDS_SETUP]" ]; then
		echo "✓ Exa already configured" >&2
		if ! ask_yes_no "Update Exa config?"; then
			echo "$config"
			return 0
		fi
	fi

	if [[ $NON_INTERACTIVE -eq 1 ]]; then
		echo "Skipping Exa (non-interactive, no token discovery available)." >&2
		echo "$config"
		return 0
	fi

	if ! ask_yes_no "Configure Exa integration?"; then
		echo "Skipping Exa. You can add it later by re-running this script." >&2
		echo "$config"
		return 0
	fi

	echo "" >&2
	echo "" >&2
	echo "Exa API Key Setup:" >&2
	echo "  📚 Documentation: https://docs.exa.ai/websets/api/get-started" >&2
	echo "" >&2
	echo "  Steps:" >&2
	echo "  1. Create account at https://exa.ai/ (free tier available)" >&2
	echo "  2. Go to https://dashboard.exa.ai/api-keys" >&2
	echo "  3. Click '+ CREATE NEW KEY'" >&2
	echo "  4. Name it (e.g., 'Catalyst') and copy the key" >&2
	echo "  5. Store it securely (shown only once!)" >&2
	echo "" >&2

	read -p "Exa API key: " exa_key

	local patch
	patch=$(jq -n --arg apiKey "$exa_key" '{apiKey: $apiKey}')
	merge_catalyst_section "$config" exa "$patch" '["apiKey"]'
}

#
# Initialization functions
#

init_humanlayer_thoughts() {
	print_header "Initializing HumanLayer Thoughts"

	cd "$PROJECT_DIR"

	# Check if already initialized
	if [ -L "thoughts/shared" ] && [ -L "thoughts/global" ]; then
		print_success "Thoughts already initialized in this project"

		# Verify symlinks point to the discovered thoughts repo
		local shared_target
		shared_target=$(readlink "thoughts/shared" 2>/dev/null || echo "")

		if [[ $shared_target == *"${THOUGHTS_REPO}"* ]]; then
			print_success "Symlinks point to correct thoughts repo"
			return 0
		else
			print_warning "Symlinks point to different location: $shared_target"

			if ! ask_yes_no "Re-initialize thoughts?"; then
				return 0
			fi

			# Remove old symlinks
			rm -rf thoughts/
		fi
	fi

	# CTL-845: use vendored init (avoids ERR_INVALID_ARG_TYPE crash in humanlayer v0.17.2-npm).
	# Resolve profile via existing logic then delegate to the vendored script.
	local hl_config="$HOME/.config/humanlayer/humanlayer.json"
	local profile_name=""
	if [ -f "$hl_config" ] && command -v jq &>/dev/null; then
		if jq -e ".thoughts.profiles.\"${ORG_NAME}\"" "$hl_config" &>/dev/null; then
			profile_name="$ORG_NAME"
		elif jq -e ".thoughts.profiles.\"${PROJECT_KEY}\"" "$hl_config" &>/dev/null; then
			profile_name="$PROJECT_KEY"
		fi
	fi

	local _setup_dir
	_setup_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || _setup_dir=""
	local VENDOR_INIT="${_setup_dir}/scripts/worktree-thoughts-init.sh"

	local init_success=false
	if [ -x "$VENDOR_INIT" ]; then
		echo "Running: worktree-thoughts-init.sh --directory \"${REPO_NAME}\"${profile_name:+ --profile $profile_name}"
		local vendor_args=(--directory "$REPO_NAME")
		[ -n "$profile_name" ] && vendor_args+=(--profile "$profile_name")
		if bash "$VENDOR_INIT" "${vendor_args[@]}"; then
			init_success=true
		fi
	else
		# Fallback for curl|bash mode where the vendored script is not on disk.
		echo "Running: humanlayer thoughts init --directory \"${REPO_NAME}\""
		local config_file="$HOME/.config/humanlayer/config-${PROJECT_KEY}.json"
		if [ -f "$config_file" ]; then
			HUMANLAYER_CONFIG="$config_file" humanlayer thoughts init --directory "$REPO_NAME" && init_success=true || true
		fi
		if ! $init_success && [ -n "$profile_name" ]; then
			echo "Using HumanLayer profile: $profile_name"
			humanlayer thoughts init --profile "$profile_name" --directory "$REPO_NAME" && init_success=true || true
		fi
		if ! $init_success; then
			humanlayer thoughts init --directory "$REPO_NAME" && init_success=true || true
		fi
	fi

	if ! $init_success; then
		print_error "Failed to initialize thoughts"
		echo ""
		echo "You can try manually:"
		echo "  cd $PROJECT_DIR"
		echo "  humanlayer thoughts init --profile ${ORG_NAME} --directory \"${REPO_NAME}\""
		return 1
	fi

	print_success "Thoughts initialized!"

	# Verify structure
	if [ -d "thoughts" ]; then
		echo ""
		echo "Created structure:"
		ls -la thoughts/ | grep -v "^total" | tail -n +2 | sed 's/^/  /'
	fi

	echo ""
}

sync_thoughts() {
	echo "Creating searchable index..."

	cd "$PROJECT_DIR"

	# Try per-project config first, then fall back to default
	local config_file="$HOME/.config/humanlayer/config-${PROJECT_KEY}.json"

	if [ -f "$config_file" ]; then
		if HUMANLAYER_CONFIG="$config_file" humanlayer thoughts sync; then
			print_success "Thoughts synced and indexed"
			echo ""
			return 0
		fi
	fi

	# Fall back to default config (uses profile auto-detection via repoMappings)
	if humanlayer thoughts sync; then
		print_success "Thoughts synced and indexed"
	else
		print_warning "Failed to sync thoughts. You can run manually:"
		echo "  cd $PROJECT_DIR"
		echo "  humanlayer thoughts sync"
	fi

	echo ""
}

#
# Validation functions
#

validate_setup() {
	print_header "Validating Setup"

	local validation_failed=false

	echo "Checking configuration..."
	echo ""

	# Check .catalyst/config.json (or deprecated .claude/config.json)
	local _vcfg="${PROJECT_DIR}/.catalyst/config.json"
	[[ ! -f $_vcfg ]] && _vcfg="${PROJECT_DIR}/.claude/config.json"
	if [ -f "$_vcfg" ]; then
		if jq empty "$_vcfg" 2>/dev/null; then
			print_success "✓ Project config is valid JSON"

			# Verify structure
			local has_key
			has_key=$(jq -r '.catalyst.projectKey // empty' "$_vcfg")

			if [ -n "$has_key" ]; then
				print_success "✓ projectKey configured: $has_key"
			else
				print_error "✗ Missing .catalyst.projectKey"
				validation_failed=true
			fi
		else
			print_error "✗ Project config is invalid JSON"
			validation_failed=true
		fi
	else
		print_error "✗ Project config not found"
		validation_failed=true
	fi

	# Check HumanLayer config (per-project file or profile in humanlayer.json)
	local hl_config="$HOME/.config/humanlayer/config-${PROJECT_KEY}.json"
	local hl_global="$HOME/.config/humanlayer/humanlayer.json"

	if [ -f "$hl_config" ]; then
		if jq empty "$hl_config" 2>/dev/null; then
			print_success "✓ HumanLayer per-project config is valid JSON"

			local repo_path
			repo_path=$(jq -r '.thoughts.thoughtsRepo // empty' "$hl_config")

			if [ -d "$repo_path" ]; then
				print_success "✓ Thoughts repo exists: $repo_path"
			else
				print_error "✗ Thoughts repo not found: $repo_path"
				validation_failed=true
			fi
		else
			print_error "✗ HumanLayer per-project config is invalid JSON"
			validation_failed=true
		fi
	elif [ -f "$hl_global" ]; then
		# Check for profile in global humanlayer.json
		local profile_repo=""
		profile_repo=$(jq -r ".thoughts.profiles.\"${ORG_NAME}\".thoughtsRepo // empty" "$hl_global" 2>/dev/null)

		if [ -n "$profile_repo" ] && [ -d "$profile_repo" ]; then
			print_success "✓ HumanLayer profile '${ORG_NAME}' configured (thoughts: $profile_repo)"
		else
			print_warning "⚠ No HumanLayer per-project config or matching profile found"
			print_warning "  Run: humanlayer thoughts init --profile ${ORG_NAME} --directory ${REPO_NAME}"
		fi
	else
		print_error "✗ HumanLayer config not found"
		validation_failed=true
	fi

	# Check Catalyst secrets
	local secrets_config="$HOME/.config/catalyst/config-${PROJECT_KEY}.json"
	if [ -f "$secrets_config" ]; then
		if jq empty "$secrets_config" 2>/dev/null; then
			print_success "✓ Catalyst secrets config is valid JSON"
		else
			print_error "✗ Catalyst secrets config is invalid JSON"
			validation_failed=true
		fi
	else
		print_warning "⚠ Catalyst secrets config not found (okay if skipped integrations)"
	fi

	# Check thoughts symlinks
	if [ -L "${PROJECT_DIR}/thoughts/shared" ]; then
		print_success "✓ Thoughts symlinks created"
	else
		print_error "✗ Thoughts not initialized in project"
		validation_failed=true
	fi

	# Check worktree directory
	if [ -n "$WORKTREE_BASE" ] && [ -d "$WORKTREE_BASE" ]; then
		print_success "✓ Worktree directory exists: $WORKTREE_BASE"
	elif [ -n "$WORKTREE_BASE" ]; then
		print_warning "⚠ Worktree directory not created (okay if skipped)"
	else
		print_success "✓ Running inside worktree (worktree management handled externally)"
	fi

	echo ""

	if [ "$validation_failed" = true ]; then
		print_error "Validation failed! Please review errors above."
		return 1
	else
		print_success "All validations passed!"
		return 0
	fi
}

print_summary() {
	echo ""
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	echo ""
	print_header "🎉 Catalyst Setup Complete!"
	echo ""
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	echo ""

	echo "📁 Project Configuration:"
	echo "   Location: ${PROJECT_DIR}"
	echo "   Org/Repo: ${ORG_NAME}/${REPO_NAME}"
	echo "   Project Key: ${PROJECT_KEY}"
	echo ""

	echo "🧠 Thoughts Repository:"
	echo "   Location: ${THOUGHTS_REPO}"
	echo "   User: ${USER_NAME}"
	echo ""

	echo "🌳 Worktrees:"
	if [ -n "$WORKTREE_BASE" ]; then
		echo "   Location: ${WORKTREE_BASE}"
	else
		echo "   Managed externally (running inside worktree)"
	fi
	echo ""

	echo "⚙️  Configuration Files:"
	echo "   Project: ${PROJECT_DIR}/.catalyst/config.json"
	echo "   HumanLayer: ~/.config/humanlayer/config-${PROJECT_KEY}.json"
	echo "   Secrets: ~/.config/catalyst/config-${PROJECT_KEY}.json"
	echo ""

	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	echo ""
	print_header "Next Steps"
	echo ""

	# CTL-1918: this used to be "1. Provision plugin-source …" — an instruction whose
	# own fallback branch told the reader to clone the repo, which is exactly the work
	# resolve_catalyst_source now does. finalize_install performs it; what remains is
	# whatever genuinely could not be done, stated with its verify command.
	print_deferred_steps

	echo "1. Restart Claude Code to load configuration"
	echo ""

	echo "2. Try your first workflow command:"
	echo "   /research-codebase"
	echo ""

	echo "3. Create a worktree for parallel work:"
	echo "   /create-worktree PROJ-123 main"
	echo ""

	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	echo ""
	echo "📚 Documentation:"
	echo "   Documentation: https://catalyst.coalescelabs.ai"
	echo "   Architecture: https://github.com/coalesce-labs/catalyst/blob/main/docs/architecture.md"
	echo ""

	echo "💡 Tip: This script is idempotent. Run again anytime to:"
	echo "   - Add/update integrations"
	echo "   - Fix configuration issues"
	echo "   - Set up additional projects in same org"
	echo ""
}

#
# GitHub backup functions
#

offer_github_backup() {
	echo ""
	print_header "GitHub Backup for Thoughts"

	cd "$THOUGHTS_REPO"

	# Check if already has remote
	if git remote get-url origin >/dev/null 2>&1; then
		local remote_url
		remote_url=$(git remote get-url origin)
		print_success "Thoughts repo already backed up to: $remote_url"
		cd "$PROJECT_DIR"
		return 0
	fi

	echo "Your thoughts repository is not backed up to GitHub."
	echo ""
	echo "Options:"
	echo "  1. Create new private GitHub repo (requires 'gh' CLI)"
	echo "  2. Link to existing GitHub repo (provide URL)"
	echo "  3. Skip (set up backup manually later)"
	echo ""

	backup_option=$(prompt_value "Select option (1, 2, or 3):" "3")

	case $backup_option in
	1)
		if ! command -v gh &>/dev/null; then
			print_error "GitHub CLI ('gh') not found"
			cd "$PROJECT_DIR"
			return 1
		fi

		local repo_name="${ORG_NAME}-thoughts"
		echo ""
		echo "Creating private GitHub repo: ${ORG_NAME}/${repo_name}"

		if gh repo create "${repo_name}" --private --source=. --push; then
			print_success "Thoughts backed up to GitHub!"
		else
			print_error "Failed to create GitHub repo"
		fi
		;;
	2)
		echo ""
		read -p "Enter GitHub repo URL (git@github.com:org/repo.git): " remote_url

		git remote add origin "$remote_url"

		if ask_yes_no "Push now?" "y" "n"; then
			git push -u origin main || git push -u origin master
			print_success "Thoughts pushed to GitHub"
		fi
		;;
	3)
		echo "Skipping GitHub backup. You can set it up later with:"
		echo "  cd $THOUGHTS_REPO"
		echo "  gh repo create my-thoughts --private --source=. --push"
		;;
	*)
		print_warning "Invalid option. Skipping GitHub backup."
		;;
	esac

	cd "$PROJECT_DIR"
}

#
# Session database initialization
#

init_session_database() {
	print_header "Initializing Session Database"

	local catalyst_dir="${CATALYST_DIR:-$HOME/catalyst}"
	local db_file="${catalyst_dir}/catalyst.db"

	mkdir -p "$catalyst_dir"

	if ! check_command_exists "sqlite3"; then
		print_warning "sqlite3 not found — skipping session database initialization"
		return 0
	fi

	# Use catalyst-db.sh if available (plugin is installed), otherwise apply schema directly
	local db_script=""
	if [ -f "${PROJECT_DIR}/plugins/dev/scripts/catalyst-db.sh" ]; then
		db_script="${PROJECT_DIR}/plugins/dev/scripts/catalyst-db.sh"
	elif [ -n "${CLAUDE_PLUGIN_ROOT-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/catalyst-db.sh" ]; then
		db_script="${CLAUDE_PLUGIN_ROOT}/scripts/catalyst-db.sh"
	fi

	if [ -n "$db_script" ]; then
		CATALYST_DIR="$catalyst_dir" "$db_script" init
		print_success "Session database initialized: $db_file"
	else
		# Minimal init: create the db with WAL mode if it doesn't exist
		sqlite3 "$db_file" "PRAGMA journal_mode = WAL;" >/dev/null 2>&1
		print_success "Session database created: $db_file"
		print_warning "Install the catalyst-dev plugin to apply full schema migrations"
	fi

	echo ""
}

# Write catalyst.sweep defaults into .catalyst/config.json and, on macOS,
# invoke the launchd installer (CTL-1030).
setup_sweep_config() {
	# Resolve REPO_ROOT and SCRIPT_DIR for this function. setup-catalyst.sh
	# sits at the repo root; PROJECT_DIR is set by detect_git_repo() for
	# interactive runs, but may be empty if sourced in lib-only mode.
	# CTL-1914: the old script-relative SCRIPT_DIR is gone — helper resolution is
	# catalyst_helper_path's job now, and keeping a second, private copy of that logic
	# here is exactly how the silent skip survived four separate call sites.
	local REPO_ROOT="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "$PWD")}"
	local config_file="${REPO_ROOT}/.catalyst/config.json"
	[[ -f $config_file ]] || return 0
	local patch tmp
	patch='{"idleHours":48,"intervalHours":1,"salvagePush":false,"maxRemovalsPerRun":10}'
	tmp="${config_file}.tmp.$$"
	# patch first so user overrides win
	if jq --argjson p "$patch" '.catalyst.sweep = ($p + (.catalyst.sweep // {}))' "$config_file" >"$tmp" && mv "$tmp" "$config_file"; then
		print_success "wrote catalyst.sweep defaults" 2>/dev/null || echo "setup: wrote catalyst.sweep defaults"
	else
		rm -f "$tmp"
		echo "setup: warning: could not write catalyst.sweep defaults" >&2
	fi
	local _os="${CATALYST_FORCE_OS:-$(uname -s 2>/dev/null || echo unknown)}"
	if [[ $_os == "Darwin" ]]; then
		# CTL-1914: was `${SCRIPT_DIR}/install-orphan-sweep.sh` guarded by `[[ -x ]]`,
		# which in the documented curl layout is a directory containing only
		# setup-catalyst.sh — so the sweep scheduler was NEVER installed and nothing
		# said so. Resolve centrally, and when it cannot be resolved, DEFER LOUDLY.
		local installer
		if catalyst_helper_path install-orphan-sweep.sh >/dev/null; then
			installer="$CATALYST_HELPER_PATH"
			if "$installer" >/dev/null 2>&1; then
				print_success "orphan-sweep scheduler installed" 2>/dev/null || true
			else
				print_warning "orphan-sweep launchd installer failed" 2>/dev/null || true
				catalyst_defer_step \
					"Install the orphan-sweep scheduler (its installer ran but failed)" \
					"bash ${installer}" \
					"launchctl list | grep catalyst.orphan-sweep"
			fi
		else
			print_warning "orphan-sweep scheduler NOT installed (${CATALYST_SOURCE_REASON})" 2>/dev/null || true
			catalyst_defer_step \
				"Install the orphan-sweep scheduler (no Catalyst source tree: ${CATALYST_SOURCE_REASON})" \
				"git clone https://github.com/coalesce-labs/catalyst.git ~/catalyst/plugin-source && bash ~/catalyst/plugin-source/plugins/dev/scripts/install-orphan-sweep.sh" \
				"launchctl list | grep catalyst.orphan-sweep"
		fi
	else
		echo "setup: note: Linux scheduling is a follow-up (CTL-1030). Config written." >&2
	fi
}

#
# ── CTL-1918: finish the install instead of printing a list of hand-steps ──
#
# Setup used to end by printing three instructions it was perfectly able to perform,
# so "setup completed successfully" and "this node works" were different states with
# nothing enforcing the gap was closed. Each step below RUNS; a step that cannot run
# is recorded in the deferred ledger with the command that completes it AND the
# command that verifies it, so what is left is checkable rather than advisory.
#
# ⛔ Ordering is load-bearing: install-cli.sh is what puts `catalyst-stack` and
# `catalyst-execution-core` on PATH, and the two steps after it are those binaries.
# Running them first would produce two "command not found" deferrals on a node where
# nothing was actually wrong.
finalize_install() {
	echo ""
	print_header "Finishing the install"

	local bin_dir="${CATALYST_BIN_DIR:-${HOME}/.catalyst/bin}"
	local cli_script stack_bin core_bin pss

	# ── 1. the CLIs on PATH ──
	# README's "Quick Setup" never runs this, so a README-only reader reaches
	# `command not found: catalyst-stack` at the last step of a "5 minute" install.
	if catalyst_helper_path install-cli.sh >/dev/null; then
		cli_script="$CATALYST_HELPER_PATH"
		if bash "$cli_script" >/dev/null 2>&1; then
			print_success "Catalyst CLIs installed to ${bin_dir}"
		else
			print_warning "install-cli.sh failed"
			catalyst_defer_step "Put the Catalyst CLIs on PATH" \
				"bash ${cli_script}" "command -v catalyst-stack"
		fi
	else
		print_warning "Catalyst CLIs NOT installed (${CATALYST_SOURCE_REASON})"
		catalyst_defer_step "Put the Catalyst CLIs on PATH (${CATALYST_SOURCE_REASON})" \
			"bash <catalyst-checkout>/plugins/dev/scripts/install-cli.sh" "command -v catalyst-stack"
	fi

	# The freshly-installed symlinks are not on this process's PATH yet, and the steps
	# below are those binaries. Resolve them by absolute path rather than hoping.
	stack_bin="${bin_dir}/catalyst-stack"
	core_bin="${bin_dir}/catalyst-execution-core"
	[[ -x $stack_bin ]] || stack_bin="$(command -v catalyst-stack 2>/dev/null || echo "")"
	[[ -x $core_bin ]] || core_bin="$(command -v catalyst-execution-core 2>/dev/null || echo "")"

	# ── 2. plugin-source (live plugin loading) ──
	# Was "Next Steps" item 1 — a printed instruction whose own fallback branch told the
	# reader to clone the repo, i.e. the work the resolver above has already done.
	if catalyst_helper_path setup-plugin-source.sh >/dev/null; then
		pss="$CATALYST_HELPER_PATH"
		# ⛔ Codex #3500 P1: this used to pass --no-interactive-wrapper whenever prompts
		# were suppressed. That flag is NOT "the quiet variant" — its own header reserves
		# it for the install-lifecycle acquire/pre-backup step, and it SKIPS the
		# marketplace and shell-wrapper retirement. The result is skills links plus the
		# two legacy load paths still live, which checkSkillsDirPlugins treats as
		# precedence-blocking / double-loading, while setup reports plugin-source as
		# provisioned. Prompt suppression is not a request for a partial workflow, so a
		# headless install runs the SAME full cutover an interactive one does.
		if bash "$pss" >/dev/null 2>&1; then
			print_success "plugin-source provisioned (pluginDirs registered)"
		else
			print_warning "setup-plugin-source.sh failed"
			catalyst_defer_step "Provision plugin-source (live plugin loading)" \
				"bash ${pss}" "catalyst doctor"
		fi
	else
		catalyst_defer_step "Provision plugin-source (${CATALYST_SOURCE_REASON})" \
			"bash <catalyst-checkout>/plugins/dev/scripts/setup-plugin-source.sh" "catalyst doctor"
	fi

	# ── 3. replica reads ──
	# Only meaningful when a replica was actually provisioned; `activate-replica` gates
	# itself on `verify-cloud-sync --json` reporting ok, so a broken replica is REFUSED
	# here rather than switched on — which is the behaviour we want, and is why this
	# calls the existing verb instead of writing the config key directly.
	if [[ -n "$(resolve_cloud_token)" ]] && [[ $CLOUD_REPLICA_PROVISIONED -eq 0 ]]; then
		# A token was supplied but the replica never provisioned. Activating reads would
		# be meaningless; saying nothing would let the all-clear stand.
		catalyst_defer_step "Turn on replica READS (the replica was not provisioned this run)" \
			"catalyst-stack activate-replica" "catalyst-stack verify-cloud-sync --json"
	elif [[ $CLOUD_REPLICA_PROVISIONED -eq 1 ]]; then
		if [[ -n $stack_bin && -x $stack_bin ]]; then
			if "$stack_bin" activate-replica >/dev/null 2>&1; then
				print_success "replica reads activated (catalyst.linearReplica.mode = on)"
			else
				print_warning "activate-replica declined — the replica is not verifiably healthy yet"
				catalyst_defer_step "Turn on replica READS once the replica verifies healthy" \
					"catalyst-stack activate-replica" "catalyst-stack verify-cloud-sync --json"
			fi
		else
			catalyst_defer_step "Turn on replica READS (catalyst-stack not on PATH)" \
				"catalyst-stack activate-replica" "catalyst-stack verify-cloud-sync --json"
		fi
	fi

	# ── 4. enrol the project ──
	# Without a registry entry the daemon dispatches nothing — a running stack that does
	# literally nothing, which looks identical to a broken one.
	if [[ -n ${TICKET_PREFIX-} ]]; then
		if [[ -n $core_bin && -x $core_bin ]]; then
			if "$core_bin" register --team "${TICKET_PREFIX}" >/dev/null 2>&1; then
				print_success "project enrolled in the execution-core registry (team ${TICKET_PREFIX})"
			else
				print_warning "registry enrolment failed for team ${TICKET_PREFIX}"
				catalyst_defer_step "Enrol this project so the daemon has work to find" \
					"catalyst-execution-core register --team ${TICKET_PREFIX}" \
					"catalyst-execution-core list-projects"
			fi
		else
			catalyst_defer_step "Enrol this project so the daemon has work to find" \
				"catalyst-execution-core register --team ${TICKET_PREFIX}" \
				"catalyst-execution-core list-projects"
		fi
	else
		# No team key discovered — the command cannot be spelled for the operator, so say
		# exactly that rather than emitting a placeholder they must decode.
		catalyst_defer_step "Enrol this project (no Linear team key was discovered during setup)" \
			"catalyst-execution-core register --team <TEAM_KEY>" \
			"catalyst-execution-core list-projects"
	fi
}

#
# Main execution
#

main() {
	parse_args "$@"

	# Handle curl | bash: redirect stdin from terminal for interactive prompts.
	# When piped, bash reads the script from stdin. Once loaded (main is a function,
	# so bash reads the full definition before executing), we redirect stdin to /dev/tty
	# so that read commands can get user input from the terminal.
	if [[ $NON_INTERACTIVE -eq 0 ]] && [ ! -t 0 ]; then
		if can_open_tty; then
			exec </dev/tty
		else
			print_warning "No terminal available. Interactive prompts will use defaults."
		fi
	fi

	# Print banner
	echo ""
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	echo "           🚀 Catalyst Complete Setup"
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	echo ""

	# Run setup steps
	check_prerequisites
	detect_git_repo
	setup_thoughts_repo
	setup_worktree_directory
	setup_project_config
	setup_humanlayer_config
	setup_catalyst_secrets
	# CTL-1836: no-op unless a cloud token was supplied. Placed after secrets so it
	# can reuse the hardened ~/.config/catalyst dir, and before the Linear/state
	# steps so a failure here stops setup before it reports success.
	setup_cloud_replica || exit 1
	update_config_with_linear_states
	setup_execution_core_states
	init_session_database
	setup_sweep_config
	init_humanlayer_thoughts
	sync_thoughts
	# CTL-1918: perform the steps setup used to print. Runs last so every input it
	# needs (team key, cloud token, config) has been established.
	finalize_install

	# Validate
	if validate_setup; then
		print_summary
		exit 0
	else
		echo ""
		# ⛔ The deferred ledger prints on BOTH paths. It lived only in print_summary,
		# i.e. only on the success path — so an operator whose install FAILED, who is
		# precisely the one who needs to know which provisioning steps did not happen,
		# was the one person who never saw the list.
		print_deferred_steps
		print_error "Setup completed with errors. Please review and re-run if needed."
		exit 1
	fi
}

# Run main unless the script is being sourced (tests source it for unit access).
# Two independent skip conditions, both required:
#   1. (HEAD) return-probe: when piped to bash (curl ... | bash) or executed
#      directly, the return-probe fails (return is only valid inside a sourced
#      script/function), so main runs; a plain `source` invocation skips it.
#   2. (CTL-843) CATALYST_SETUP_LIB_ONLY env guard: lets tests source the
#      function library without running setup even from contexts where the
#      return-probe would succeed/fail unexpectedly (curl | bash runs from
#      stdin where BASH_SOURCE is empty, so an env guard is the reliable signal).
if (return 0 2>/dev/null) || [[ -n ${CATALYST_SETUP_LIB_ONLY-} ]]; then
	:
else
	main "$@"
fi
