#!/usr/bin/env bash
# Catalyst Project Setup Check
# Validates that the current project is properly configured for Catalyst workflows.
# Run by workflow commands as a prerequisite check.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

errors=()
warnings=()

# Cross-project Layer 2 home config (smeeChannel + per-project secrets files live here)
CATALYST_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/catalyst"
HOME_CONFIG_PATH="$CATALYST_CONFIG/config.json"

# 0. Resolve config path (.catalyst/ preferred, .claude/ deprecated fallback)
CONFIG_PATH=""
if [[ -f ".catalyst/config.json" ]]; then
	CONFIG_PATH=".catalyst/config.json"
elif [[ -f ".claude/config.json" ]]; then
	CONFIG_PATH=".claude/config.json"
	# Auto-migrate: copy to .catalyst/ if directory doesn't exist yet
	if [[ ! -d ".catalyst" ]]; then
		mkdir -p ".catalyst"
		cp ".claude/config.json" ".catalyst/config.json"
		warnings+=("Migrated config.json from .claude/ to .catalyst/ — update .claude/config.json references")
	fi
fi

# Migrate workflow-context.json if needed
if [[ -f ".claude/.workflow-context.json" && ! -f ".catalyst/.workflow-context.json" ]]; then
	mkdir -p ".catalyst"
	cp ".claude/.workflow-context.json" ".catalyst/.workflow-context.json"
fi

# 1. Check thoughts system is initialized
# Fatal: thoughts/shared or thoughts/global is a regular directory when humanlayer-is-configured
# or .catalyst/config.json declares a thoughts directory. In that scenario humanlayer's symlink
# was clobbered and writes will silently bypass the central thoughts repo. On truly-unconfigured
# projects (no humanlayer, no thoughts config), plain directories are the intended fallback.
thoughts_expected=0
if [[ -n $CONFIG_PATH ]]; then
	CAT_THOUGHTS_DIR=$(jq -r '.catalyst.thoughts.directory // empty' "$CONFIG_PATH" 2>/dev/null)
	[[ -n $CAT_THOUGHTS_DIR ]] && thoughts_expected=1
fi
if command -v humanlayer &>/dev/null; then
	if humanlayer thoughts config --json 2>/dev/null | jq -e --arg cwd "$(pwd)" '.repoMappings[$cwd] // empty' &>/dev/null; then
		thoughts_expected=1
	fi
fi

if [[ $thoughts_expected -eq 1 ]]; then
	for top in shared global; do
		if [[ -e "thoughts/$top" && ! -L "thoughts/$top" ]]; then
			errors+=("thoughts/$top is a regular directory but should be a symlink — run: bash plugins/dev/scripts/catalyst-thoughts.sh check")
		elif [[ -L "thoughts/$top" && ! -e "thoughts/$top" ]]; then
			errors+=("thoughts/$top is a symlink with a missing target — run: bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair")
		fi
	done
fi

if [[ -d "thoughts/shared" ]]; then
	# Check subdirectories exist
	for dir in research plans handoffs prs reports; do
		if [[ ! -d "thoughts/shared/$dir" ]]; then
			warnings+=("thoughts/shared/$dir/ directory missing — run: bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair")
		fi
	done
else
	errors+=("Thoughts system not configured — run: bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair")
fi

# 2. Check thoughts is synced (has .git or is managed)
if [[ -d "thoughts" ]] && [[ ! -d "thoughts/.git" ]] && [[ ! -L "thoughts" ]]; then
	if command -v humanlayer &>/dev/null; then
		hl_status=$(humanlayer thoughts status 2>&1 || true)
		if ! echo "$hl_status" | grep -q "Repository:"; then
			warnings+=("thoughts/ exists but humanlayer is not configured — run: humanlayer thoughts init")
		fi
	else
		warnings+=("thoughts/ exists but is not git-backed and humanlayer is not installed")
	fi
fi

# 2b. Webhook pipeline (smee binary + smeeChannel — checked independently of daemon state)
if ! command -v smee &>/dev/null; then
	warnings+=("smee binary not on PATH — webhook tunnel cannot start")
	warnings+=("  Install: npm install -g smee-client")
fi

if [[ -f $HOME_CONFIG_PATH ]]; then
	SMEE_CHANNEL=$(jq -r '.catalyst.monitor.github.smeeChannel // empty' "$HOME_CONFIG_PATH" 2>/dev/null)
	if [[ -z $SMEE_CHANNEL ]]; then
		warnings+=("Missing catalyst.monitor.github.smeeChannel in $HOME_CONFIG_PATH — webhook tunnel won't start")
		warnings+=("  Run: bash plugins/dev/scripts/setup-webhooks.sh")
	fi
else
	warnings+=("Cross-project Layer 2 config missing: $HOME_CONFIG_PATH — webhook tunnel not configured")
	warnings+=("  Run: bash plugins/dev/scripts/setup-webhooks.sh")
fi

# 3. Check CLAUDE.md has Catalyst snippet
if [[ -f "CLAUDE.md" ]]; then
	if ! grep -q "Catalyst Development Workflow" CLAUDE.md 2>/dev/null; then
		warnings+=("CLAUDE.md is missing the Catalyst workflow snippet")
		warnings+=("  Add the snippet from: plugins/dev/templates/CLAUDE_SNIPPET.md")
		warnings+=("  Or run: cat plugins/dev/templates/CLAUDE_SNIPPET.md >> CLAUDE.md")
	fi
else
	warnings+=("No CLAUDE.md found — agents will lack project-level workflow context")
	warnings+=("  Create one and add the Catalyst snippet from: plugins/dev/templates/CLAUDE_SNIPPET.md")
fi

# 4. Check config.json exists and has required fields
if [[ -n $CONFIG_PATH ]]; then
	# Check for projectKey (needed to locate secrets config file)
	PROJECT_KEY=$(jq -r '.catalyst.projectKey // empty' "$CONFIG_PATH" 2>/dev/null)
	if [[ -z $PROJECT_KEY ]]; then
		warnings+=("Missing catalyst.projectKey in $CONFIG_PATH — secrets config file can't be located")
		warnings+=('  Add: "projectKey": "your-project-name"')
	fi

	# Check for project.ticketPrefix (needed for document naming)
	TICKET_PREFIX=$(jq -r '.catalyst.project.ticketPrefix // empty' "$CONFIG_PATH" 2>/dev/null)
	if [[ -z $TICKET_PREFIX ]]; then
		warnings+=("Missing catalyst.project.ticketPrefix in $CONFIG_PATH — document naming will default to PROJ")
	fi

	# Check for linear.teamKey (needed for ticket extraction from branch names)
	TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // empty' "$CONFIG_PATH" 2>/dev/null)
	if [[ -z $TEAM_KEY ]]; then
		warnings+=("Missing catalyst.linear.teamKey in $CONFIG_PATH — ticket extraction from branch names won't work")
	fi

	# Check for linear.stateMap (needed for lifecycle transitions)
	STATE_MAP=$(jq -r '.catalyst.linear.stateMap // empty' "$CONFIG_PATH" 2>/dev/null)
	if [[ -z $STATE_MAP ]]; then
		warnings+=("Missing catalyst.linear.stateMap in $CONFIG_PATH — Linear ticket states won't update during workflows")
		warnings+=("  See: https://catalyst.coalescelabs.ai/reference/configuration/#state-map-keys")
	fi

	# If linear fields are missing, show a single setup hint
	if [[ -z $TEAM_KEY || -z $STATE_MAP ]]; then
		warnings+=("  Run setup-catalyst.sh or add linear config manually — see docs/reference/configuration")
	fi

	# Check for the cached Linear UUID registry (CTL-207, CTL-577). stateIds is a
	# machine-level derived cache at ~/.config/catalyst/linear-state-ids.json,
	# resolved on demand by resolve-linear-ids.sh (and auto-resolved by
	# linear-transition.sh on a cache miss) — never committed to git.
	if [[ -n $TEAM_KEY ]]; then
		STATE_IDS_REGISTRY="${XDG_CONFIG_HOME:-$HOME/.config}/catalyst/linear-state-ids.json"
		registry_has_state_ids=""
		if [[ -f $STATE_IDS_REGISTRY ]]; then
			registry_has_state_ids=$(jq -r --arg t "$TEAM_KEY" \
				'.[$t].stateIds // {} | if length > 0 then "yes" else empty end' \
				"$STATE_IDS_REGISTRY" 2>/dev/null)
		fi
		if [[ -z $registry_has_state_ids ]]; then
			warnings+=("Linear state-id cache not yet resolved for team '$TEAM_KEY' — generated on demand, or run: plugins/dev/scripts/resolve-linear-ids.sh")
		fi
	fi

	# Execution-core Linear-state contract check (CTL-564, CTL-577). Only when the
	# repo is dispatchMode: execution-core: verify the 6 contract states are
	# present in stateMap VALUES (the authored contract), and that a central
	# registry entry exists for the team. Local-only — no API call. Gaps are
	# warnings, consistent with every other linear-config issue here.
	DISPATCH_MODE=$(jq -r '.catalyst.orchestration.dispatchMode // empty' "$CONFIG_PATH" 2>/dev/null)
	if [[ $DISPATCH_MODE == "execution-core" ]]; then
		# The contract states this check expects. Mirrors contract_states() in
		# setup-execution-core-states.sh — keep the two in sync (different
		# languages, so a shared constant is not possible).
		# CTL-722: Ready was archived on 2026-06-02; Todo is the post-cutover
		# scheduler-eligible entry state.
		EXECUTION_CORE_CONTRACT_STATES=(Todo Research Plan Implement Validate PR)
		execution_core_gaps=0
		for contract_state in "${EXECUTION_CORE_CONTRACT_STATES[@]}"; do
			in_state_map=$(jq -r --arg s "$contract_state" \
				'[.catalyst.linear.stateMap // {} | to_entries[].value] | index($s) // empty' \
				"$CONFIG_PATH" 2>/dev/null)
			if [[ -z $in_state_map ]]; then
				warnings+=("Execution-core contract state '$contract_state' missing from stateMap in $CONFIG_PATH")
				execution_core_gaps=$((execution_core_gaps + 1))
			fi
		done

		# Registry entry — resolved via the same logic as registry.mjs/config.mjs.
		REGISTRY_PATH="${CATALYST_DIR:-$HOME/catalyst}/execution-core/registry.json"
		registry_has_team=""
		if [[ -f $REGISTRY_PATH && -n $TEAM_KEY ]]; then
			registry_has_team=$(jq -r --arg t "$TEAM_KEY" \
				'[.projects // [] | .[] | select(.team == $t)] | length | if . > 0 then "yes" else empty end' \
				"$REGISTRY_PATH" 2>/dev/null)
		fi
		if [[ -z $registry_has_team ]]; then
			# CTL-578: under execution-core dispatch the team MUST be in
			# registry.json — the daemon is blind to a team that's not there.
			# Absence is a hard failure, not a warning.
			errors+=("No execution-core registry entry for team '$TEAM_KEY' in $REGISTRY_PATH")
			errors+=("  Run setup-catalyst or plugins/dev/scripts/setup-execution-core-states.sh to fix")
			execution_core_gaps=$((execution_core_gaps + 1))
		fi

		if [[ $execution_core_gaps -gt 0 ]]; then
			warnings+=("  Run setup-catalyst or plugins/dev/scripts/setup-execution-core-states.sh to fix the contract")
		fi

		# Linear git-automation drift check (CTL-759). The execution-core pipeline
		# is the authority on Linear state; a `review` git automation, or a
		# `start`/`merge` automation pointed somewhere other than PR/Done, is the
		# CTL-758 backward-write footgun. This is a hot-path check, so the live
		# gitAutomationStates query is TTL-gated behind a per-team cache; a fresh
		# cache short-circuits the API call entirely. No per-project token → SOFT
		# skip (no warning) — a token is required to query, and its absence is
		# already surfaced elsewhere.
		GIT_AUTO_TOKEN=""
		if [[ -n $PROJECT_KEY ]]; then
			GIT_AUTO_SECRETS="${CATALYST_CONFIG}/config-${PROJECT_KEY}.json"
			if [[ -f $GIT_AUTO_SECRETS ]]; then
				GIT_AUTO_TOKEN=$(jq -r '.catalyst.linear.apiToken // .linear.apiToken // empty' \
					"$GIT_AUTO_SECRETS" 2>/dev/null)
			fi
		fi
		if [[ -n $GIT_AUTO_TOKEN && -n $TEAM_KEY ]]; then
			GIT_AUTO_CACHE="${CATALYST_CONFIG}/linear-git-automation-cache.json"
			GIT_AUTO_TTL=$((6 * 60 * 60)) # 6h — automations rarely change
			git_auto_nodes=""
			git_auto_fresh=""
			if [[ -f $GIT_AUTO_CACHE ]]; then
				cache_ts=$(jq -r --arg k "$TEAM_KEY" '.[$k].fetchedAt // empty' \
					"$GIT_AUTO_CACHE" 2>/dev/null)
				if [[ -n $cache_ts ]]; then
					now_ts=$(date +%s)
					age=$((now_ts - cache_ts))
					if [[ $age -ge 0 && $age -lt $GIT_AUTO_TTL ]]; then
						git_auto_fresh="yes"
						git_auto_nodes=$(jq -c --arg k "$TEAM_KEY" '.[$k].nodes // []' \
							"$GIT_AUTO_CACHE" 2>/dev/null)
					fi
				fi
			fi

			if [[ -z $git_auto_fresh ]] && command -v curl &>/dev/null; then
				# Cache miss/stale → one live query, then persist keyed by teamKey.
				ga_query='query($teamKey: String!) { teams(filter: { key: { eq: $teamKey } }) { nodes { gitAutomationStates { nodes { id event state { id name } } } } } }'
				ga_payload=$(jq -nc --arg q "$ga_query" --arg k "$TEAM_KEY" \
					'{query: $q, variables: {teamKey: $k}}')
				ga_resp=$(curl -s --max-time 5 -X POST https://api.linear.app/graphql \
					-H "Content-Type: application/json" \
					-H "Authorization: ${GIT_AUTO_TOKEN}" \
					-d "$ga_payload" 2>/dev/null || true)
				if [[ -n $ga_resp ]] && ! echo "$ga_resp" | jq -e '.errors' >/dev/null 2>&1; then
					git_auto_nodes=$(echo "$ga_resp" |
						jq -c '.data.teams.nodes[0].gitAutomationStates.nodes // []' 2>/dev/null)
					if [[ -n $git_auto_nodes && $git_auto_nodes != "null" ]]; then
						mkdir -p "$CATALYST_CONFIG"
						tmp_cache="$(mktemp)"
						existing_cache='{}'
						[[ -f $GIT_AUTO_CACHE ]] && existing_cache="$(cat "$GIT_AUTO_CACHE" 2>/dev/null || echo '{}')"
						echo "$existing_cache" | jq \
							--arg k "$TEAM_KEY" \
							--argjson nodes "$git_auto_nodes" \
							--argjson ts "$(date +%s)" \
							'.[$k] = { fetchedAt: $ts, nodes: $nodes }' \
							>"$tmp_cache" 2>/dev/null &&
							mv "$tmp_cache" "$GIT_AUTO_CACHE" ||
							rm -f "$tmp_cache"
					fi
				fi
			fi

			# Evaluate whatever nodes we have (cached or freshly fetched).
			if [[ -n $git_auto_nodes && $git_auto_nodes != "null" && $git_auto_nodes != "[]" ]]; then
				review_count=$(echo "$git_auto_nodes" | jq -r '[.[] | select(.event == "review")] | length' 2>/dev/null || echo 0)
				start_state=$(echo "$git_auto_nodes" | jq -r '[.[] | select(.event == "start")][0].state.name // empty' 2>/dev/null)
				merge_state=$(echo "$git_auto_nodes" | jq -r '[.[] | select(.event == "merge")][0].state.name // empty' 2>/dev/null)
				if [[ ${review_count:-0} -gt 0 ]]; then
					warnings+=("Linear 'review' git automation is set for team '$TEAM_KEY' — it conflicts with execution-core state authority (CTL-758)")
					warnings+=("  Run plugins/dev/scripts/setup-execution-core-states.sh to remove it")
				fi
				if [[ -n $start_state && $start_state != "PR" ]]; then
					warnings+=("Linear 'start' git automation for team '$TEAM_KEY' points at '$start_state' (expected 'PR')")
				fi
				if [[ -n $merge_state && $merge_state != "Done" ]]; then
					warnings+=("Linear 'merge' git automation for team '$TEAM_KEY' points at '$merge_state' (expected 'Done')")
				fi
			fi
		fi

		# CTL-764: worker-status label group check (hot-path, TTL-cached). Reuses the
		# GIT_AUTO_TOKEN acquired above. Shared cache key: .[TEAM_KEY].workerStatusLabels
		# preserves the gitAutomation sibling written above. Warnings only — never alters
		# exit code. No per-project token → silently skipped (same gate as git-automation).
		if [[ -n $GIT_AUTO_TOKEN && -n $TEAM_KEY ]]; then
			WS_CACHE="${CATALYST_CONFIG}/linear-git-automation-cache.json"
			WS_TTL=$((6 * 60 * 60))
			ws_members=""
			ws_status="" # "" | "no_group" | "found"
			if [[ -f $WS_CACHE ]]; then
				ws_cache_ts=$(jq -r --arg k "$TEAM_KEY" \
					'.[$k].workerStatusLabels.fetchedAt // empty' \
					"$WS_CACHE" 2>/dev/null)
				if [[ -n $ws_cache_ts ]]; then
					now_ts=$(date +%s)
					age=$((now_ts - ws_cache_ts))
					if [[ $age -ge 0 && $age -lt $WS_TTL ]]; then
						ws_status="found"
						ws_members=$(jq -c --arg k "$TEAM_KEY" \
							'.[$k].workerStatusLabels.members // []' \
							"$WS_CACHE" 2>/dev/null)
					fi
				fi
			fi

			if [[ -z $ws_status ]] && command -v curl &>/dev/null; then
				ws_query='query { issueLabels(filter: {team: {null: true}}, first: 250) { nodes { id name isGroup parent { id } } } }'
				ws_payload=$(jq -nc --arg q "$ws_query" '{query: $q}')
				ws_resp=$(curl -s --max-time 5 -X POST https://api.linear.app/graphql \
					-H "Content-Type: application/json" \
					-H "Authorization: ${GIT_AUTO_TOKEN}" \
					-d "$ws_payload" 2>/dev/null || true)
				if [[ -n $ws_resp ]] && ! echo "$ws_resp" | jq -e '.errors' >/dev/null 2>&1; then
					all_labels=$(echo "$ws_resp" | jq -c '.data.issueLabels.nodes // []' 2>/dev/null)
					ws_group_id=$(echo "$all_labels" | jq -r \
						'.[] | select(.name == "worker-status" and .isGroup == true) | .id // empty' \
						2>/dev/null | head -1)
					if [[ -n $ws_group_id ]]; then
						ws_status="found"
						ws_members=$(echo "$all_labels" | jq -c --arg pid "$ws_group_id" \
							'[.[] | select(.parent.id == $pid) | .name]' 2>/dev/null)
						mkdir -p "$CATALYST_CONFIG"
						tmp_ws="$(mktemp)"
						existing_ws_cache='{}'
						[[ -f $WS_CACHE ]] && existing_ws_cache="$(cat "$WS_CACHE" 2>/dev/null || echo '{}')"
						echo "$existing_ws_cache" | jq \
							--arg k "$TEAM_KEY" \
							--argjson members "$ws_members" \
							--argjson ts "$(date +%s)" \
							'.[$k].workerStatusLabels = { fetchedAt: $ts, members: $members }' \
							>"$tmp_ws" 2>/dev/null &&
							mv "$tmp_ws" "$WS_CACHE" ||
							rm -f "$tmp_ws"
					else
						ws_status="no_group"
					fi
				fi
			fi

			case "$ws_status" in
			found)
				for _ws_exp in queued blocked needs-input needs-human; do
					if ! echo "$ws_members" | jq -e --arg n "$_ws_exp" \
						'map(. == $n) | any' >/dev/null 2>&1; then
						warnings+=("worker-status label '${_ws_exp}' missing from Linear workspace — run plugins/dev/scripts/setup-execution-core-states.sh")
					fi
				done
				;;
			no_group)
				warnings+=("worker-status label group missing from Linear workspace — run plugins/dev/scripts/setup-execution-core-states.sh")
				;;
			esac
		fi
	fi

	# Check Linear webhook registration (CTL-253) — gates whether Linear events reach the event log.
	# The record lives in the cross-project Layer 2 file ($HOME_CONFIG_PATH); per-project secrets
	# files (config-<projectKey>.json) hold the API token only. See setup-linear-webhook.sh.
	if [[ -f $HOME_CONFIG_PATH ]]; then
		LINEAR_WEBHOOK_ID=$(jq -r '.catalyst.monitor.linear.webhookId // empty' "$HOME_CONFIG_PATH" 2>/dev/null)
		if [[ -z $LINEAR_WEBHOOK_ID ]]; then
			warnings+=("Missing catalyst.monitor.linear.webhookId in $HOME_CONFIG_PATH — Linear events won't reach the event log")
			warnings+=("  Register: bash plugins/dev/scripts/setup-webhooks.sh --linear-register")
		fi
	fi

	# CTL-749: bot user IDs — daemon now reads a SET from two sources:
	#   NEW: ~/.config/catalyst/config.json  catalyst.linear.bot.{worker,orchestrator}.botUserId
	#   OLD: .catalyst/config.json           catalyst.monitor.linear.botUserId (Layer-1, back-compat)
	_GLOBAL_CFG="$HOME/.config/catalyst/config.json"
	BOT_WORKER_ID=$(jq -r '.catalyst.linear.bot.worker.botUserId // empty' "$_GLOBAL_CFG" 2>/dev/null)
	BOT_ORCH_ID=$(jq -r '.catalyst.linear.bot.orchestrator.botUserId // empty' "$_GLOBAL_CFG" 2>/dev/null)
	BOT_USER_ID=$(jq -r '.catalyst.monitor.linear.botUserId // empty' "$CONFIG_PATH" 2>/dev/null)
	if [[ -z $BOT_WORKER_ID && -z $BOT_ORCH_ID && -z $BOT_USER_ID ]]; then
		warnings+=("No Linear bot user IDs configured — execution-core comms won't filter bot self-echo (the agent's own Linear comments look like human replies)")
		warnings+=("  NEW: set catalyst.linear.bot.worker.botUserId in ~/.config/catalyst/config.json")
		warnings+=("  OLD fallback: set catalyst.monitor.linear.botUserId in $CONFIG_PATH; see /catalyst-foundry:setup-catalyst")
	fi

	# Warn if config is still only in .claude/ (deprecated location)
	if [[ $CONFIG_PATH == ".claude/config.json" && ! -f ".catalyst/config.json" ]]; then
		warnings+=("config.json is in .claude/ (deprecated) — move to .catalyst/config.json")
	fi
else
	warnings+=(".catalyst/config.json not found — run setup-catalyst.sh to create it")
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 4c. Execution-core daemon env proxy sanity (CTL proxy-audit automation).
#     The daemon sources a machine-local env file on start (catalyst-execution-core
#     cmd_start). It is OPT-IN; an absent file is a no-op and the common case. The
#     ONE silent-failure we surface in this hot path is: a proxy is configured but
#     NODE_USE_ENV_PROXY=1 is missing — Node fetch then IGNORES the proxy, so the
#     daemon's Linear/gh calls bypass the audit with nothing visibly broken. Full
#     port/CA diagnostics live in check-setup.sh; here we keep it cheap (read the
#     file in a subshell, no network) and warn only.
DAEMON_ENV_FILE="${CATALYST_EXECUTION_CORE_ENV:-$CATALYST_CONFIG/execution-core.env}"
if [[ -f $DAEMON_ENV_FILE ]]; then
	daemon_env_vals=$(
		set +euo pipefail
		set -a
		# shellcheck disable=SC1090
		. "$DAEMON_ENV_FILE" 2>/dev/null
		set +a
		printf 'PROXY=%s\nUSE_ENV_PROXY=%s\n' \
			"${HTTPS_PROXY:-${HTTP_PROXY-}}" "${NODE_USE_ENV_PROXY-}"
	)
	de_proxy=$(printf '%s\n' "$daemon_env_vals" | sed -n 's/^PROXY=//p')
	de_use_env_proxy=$(printf '%s\n' "$daemon_env_vals" | sed -n 's/^USE_ENV_PROXY=//p')
	if [[ -n $de_proxy && $de_use_env_proxy != "1" ]]; then
		warnings+=("Proxy vars set in $DAEMON_ENV_FILE but NODE_USE_ENV_PROXY=1 missing — Node fetch IGNORES the proxy (daemon Linear/gh calls bypass the audit silently)")
		warnings+=("  Add to $DAEMON_ENV_FILE: export NODE_USE_ENV_PROXY=1 — then: catalyst-execution-core restart")
		warnings+=("  Full proxy health (port listening, CA cert): bash plugins/dev/scripts/check-setup.sh")
	fi
fi

# 5. Check orch-monitor daemon liveness
#    Event-driven skills (orchestrate Phase 4, oneshot Phase 5, merge-pr Phase 6) depend on
#    the daemon to surface webhook events. Without it, catalyst-events wait-for falls back
#    to a 600s timeout + gh pr view polling — silently degraded.
MONITOR_SCRIPT="${SCRIPT_DIR}/catalyst-monitor.sh"
MONITOR_PORT_RESOLVED="${MONITOR_PORT:-7400}"
if [[ -x $MONITOR_SCRIPT ]]; then
	if "$MONITOR_SCRIPT" status --json &>/dev/null; then
		# Daemon is running — also check webhook tunnel connectivity (CTL-244).
		if command -v curl &>/dev/null && command -v jq &>/dev/null; then
			local_tunnel=$(curl -s --max-time 2 "http://localhost:${MONITOR_PORT_RESOLVED}/api/status/webhook-tunnel" 2>/dev/null || true)
			smee_url=$(echo "$local_tunnel" | jq -r '.smeeUrl // empty' 2>/dev/null || true)
			tunnel_connected=$(echo "$local_tunnel" | jq -r '.connected // empty' 2>/dev/null || true)
			if [[ -n $smee_url && $tunnel_connected != "true" ]]; then
				warnings+=("Webhook tunnel not connected (smeeUrl=${smee_url}) — GitHub events won't reach the daemon")
				warnings+=("  Restart the monitor: $MONITOR_SCRIPT restart")
			fi
		fi
	else
		# Daemon stopped. Behavior splits on autonomous vs interactive.
		if [[ -n ${CATALYST_AUTONOMOUS-} ]] || [[ ! -t 0 ]]; then
			echo -e "${YELLOW}WARN: orch-monitor daemon not running${NC}" >&2
			echo "  Event-driven skills will degrade to polling fallback." >&2
			echo "  Start with: $MONITOR_SCRIPT start" >&2
		else
			echo -e "${YELLOW}orch-monitor daemon is not running.${NC}"
			echo "Event-driven skills (orchestrate, oneshot, merge-pr) will degrade"
			echo "to slower polling fallback without it."
			read -r -p "Start the monitor now? [Y/n] " yn
			case "$yn" in
			[Nn]*)
				warnings+=("orch-monitor daemon not running — event-driven skills will degrade to polling")
				;;
			*)
				if ! "$MONITOR_SCRIPT" start; then
					errors+=("Failed to start orch-monitor — check log: ${CATALYST_DIR:-$HOME/catalyst}/monitor.log")
					errors+=("  Investigate: tail -50 \"${CATALYST_DIR:-$HOME/catalyst}/monitor.log\"")
				fi
				;;
			esac
		fi
	fi
fi

# 6. Ensure workflow context file exists
#    This is the auto-discovery backing store; skills and hooks depend on it.
if [[ -f "${SCRIPT_DIR}/workflow-context.sh" ]]; then
	"${SCRIPT_DIR}/workflow-context.sh" init 2>/dev/null || true
elif [[ -n ${CLAUDE_PLUGIN_ROOT-} && -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
	"${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" init 2>/dev/null || true
fi

# 6. Check catalyst-* CLIs are on PATH (CTL-227)
#    Skills like monitor-events invoke `catalyst-events` by bare name; if it's
#    not on PATH, the skill fails with `command not found`. Use catalyst-events
#    as the canary — it's the newest CLI and most likely to be missing on a
#    user who upgraded but never re-ran install-cli.sh.
if ! command -v catalyst-events &>/dev/null; then
	warnings+=("catalyst-events not found on PATH — run: bash plugins/dev/scripts/install-cli.sh")
fi

# 7. Check template drift (CTL-489) — keys in plugins/dev/templates/config.template.json
#    but missing from .catalyst/config.json. Non-fatal; surfaces silent fallbacks
#    (CTL-487 spent two months in legacy mode because dispatchMode was absent)
#    at workflow-invocation time. Resolved via /catalyst-foundry:setup-catalyst.
if [[ -n $CONFIG_PATH ]]; then
	DRIFT_SCRIPT="${SCRIPT_DIR}/check-config-drift.sh"
	TEMPLATE_PATH=""
	# Resolve template: prefer plugin cache (production), then sibling templates/
	# (cache layout), then in-repo path (dogfood from arbitrary cwd).
	if [[ -n ${CLAUDE_PLUGIN_ROOT-} && -f "${CLAUDE_PLUGIN_ROOT}/templates/config.template.json" ]]; then
		TEMPLATE_PATH="${CLAUDE_PLUGIN_ROOT}/templates/config.template.json"
	elif [[ -f "${SCRIPT_DIR}/../templates/config.template.json" ]]; then
		TEMPLATE_PATH="${SCRIPT_DIR}/../templates/config.template.json"
	elif [[ -f "plugins/dev/templates/config.template.json" ]]; then
		TEMPLATE_PATH="plugins/dev/templates/config.template.json"
	fi
	if [[ -x $DRIFT_SCRIPT && -n $TEMPLATE_PATH ]]; then
		# Distinguish drift-script exit codes:
		#   0 → no drift (silent)
		#   1 → drift detected; stdout lines become warnings
		#   2+ → setup error (jq missing, malformed template); surface as a
		#        warning so the gap is visible. Previously `2>/dev/null || true`
		#        swallowed rc=2 and rc=1 alike — exactly the CTL-487 silent-
		#        fallback class this feature exists to surface.
		# set -e would abort on rc=1; tolerate non-zero so we can branch on rc.
		DRIFT_OUT=$(bash "$DRIFT_SCRIPT" --config "$CONFIG_PATH" --template "$TEMPLATE_PATH" 2>&1) && DRIFT_RC=0 || DRIFT_RC=$?
		case $DRIFT_RC in
		0) ;;
		1)
			while IFS= read -r line; do
				[[ -n $line ]] && warnings+=("$line")
			done <<<"$DRIFT_OUT"
			;;
		*)
			# Collapse newlines so the warning stays a single bullet.
			warnings+=("check-config-drift exited $DRIFT_RC: ${DRIFT_OUT//$'\n'/ }")
			;;
		esac
	fi
fi

# 8. Linear read path — replica-first reflex (CTL-1397 / CTL-1420 follow-up)
#    CTL-1397 pivoted agent Linear READS to direct SQLite against the local
#    catalyst-replica.db (writer-fed from Catalyst Cloud). Bare `linearis issues
#    read <ID>` instead hits the personal ~2500/hr Linear key and 429s under load.
#    Affirm "reads → replica" when the replica is FRESH; WARN (advisory, NEVER fatal)
#    only when the operator has OPTED IN (CATALYST_LINEAR_REPLICA=on) but the replica
#    is STALE/missing — so a downstream/non-fleet host that never runs the replica is
#    NOT nagged and is NOT flipped out of "Project setup OK". Freshness is the SAME
#    two-gate check the read helper enforces (writer.lock < 5min AND a sync_meta
#    cursor) — sourced, not duplicated, so the gate can't drift from read behavior.
REPLICA_LIB=""
if [[ -f "${SCRIPT_DIR}/lib/linear-read-replica.sh" ]]; then
	REPLICA_LIB="${SCRIPT_DIR}/lib/linear-read-replica.sh"
elif [[ -n ${CLAUDE_PLUGIN_ROOT-} && -f "${CLAUDE_PLUGIN_ROOT}/scripts/lib/linear-read-replica.sh" ]]; then
	REPLICA_LIB="${CLAUDE_PLUGIN_ROOT}/scripts/lib/linear-read-replica.sh"
fi
if [[ -n $REPLICA_LIB ]]; then
	# Defines replica_fresh() (print-free, rc-only) + CATALYST_REPLICA_DB /
	# CATALYST_LINEAR_REPLICA_STALE_MS defaults. Idempotent; safe under set -e.
	# shellcheck source=lib/linear-read-replica.sh disable=SC1090,SC1091
	source "$REPLICA_LIB"
	_replica_stale_s=$((${CATALYST_LINEAR_REPLICA_STALE_MS:-300000} / 1000))
	if replica_fresh; then
		echo -e "${GREEN}Linear reads → local replica${NC} (${CATALYST_REPLICA_DB}) — do NOT use bare 'linearis issues read <ID>' for single-ticket reads (it hits the personal Linear key and 429s under load)."
	elif [[ -f $CATALYST_REPLICA_DB ]]; then
		warnings+=("Linear replica STALE (writer heartbeat >${_replica_stale_s}s or seed incomplete) — single-ticket reads fall back to the personal Linear key (rate-limited, 429-prone). Check the cloud-sync writer: bash plugins/dev/scripts/check-setup.sh")
	elif [[ ${CATALYST_LINEAR_REPLICA-} == on ]]; then
		warnings+=("CATALYST_LINEAR_REPLICA=on but no replica at $CATALYST_REPLICA_DB — single-ticket reads fall back to the personal Linear key (rate-limited, 429-prone). Start the cloud-sync writer: catalyst-stack adopt-cloud-sync")
	fi
	# else (no replica, not opted in): silent — the replica is fleet-internal infra a
	# downstream install never runs; nagging it would be a permanent false alarm.
fi

# 9. Agent house rules present — the "Working the Loop" reflexes (CTL general-instructions).
#    The agent-instructions doc is meant to teach EVERY agent (including an interactive,
#    non-slash-command session) three default reflexes that are otherwise buried in
#    skills: (a) subscribe to the event log instead of polling GitHub/CI/Linear,
#    (b) read a single Linear ticket from the local replica, (c) recognize an
#    automated reviewer's 👍-reaction clean pass. A recent interactive session polled
#    GitHub for 99 min and missed a passed review because these were framed as
#    skill-internal, not house rules. This checkup nags (WARN, never fatal) when a
#    Catalyst-managed project's agent doc is missing any reflex.
#
#    The block must live in the file the driving agent actually LOADS: AGENTS.md when
#    CLAUDE.md is a thin `@AGENTS.md` bridge (AGENTS.md is imported), otherwise the
#    monolithic CLAUDE.md directly. So we accept a marker found in EITHER doc, and only
#    run the check when at least one agent doc exists (a repo with neither is outside
#    the framework — nagging it would be a false alarm). Canonical block to copy:
#    plugins/dev/templates/agents-house-rules.md. Markers matched case-insensitively.
AGENT_DOCS=()
[[ -f AGENTS.md ]] && AGENT_DOCS+=("AGENTS.md")
[[ -f CLAUDE.md ]] && AGENT_DOCS+=("CLAUDE.md")
if [[ ${#AGENT_DOCS[@]} -gt 0 ]]; then
	missing_reflex=()
	grep -qiE 'subscribe to the event log|wait-for-github' "${AGENT_DOCS[@]}" ||
		missing_reflex+=("event-log-over-polling (waiting on GitHub/CI/Linear state → catalyst-dev:wait-for-github / catalyst-dev:monitor-events, don't poll)")
	grep -qE '👍' "${AGENT_DOCS[@]}" ||
		missing_reflex+=("automated-review 👍-reaction clean pass (detect via reactions/comments, not only the reviews API)")
	grep -qiE 'linear_read_ticket|local replica' "${AGENT_DOCS[@]}" ||
		missing_reflex+=("single-ticket Linear reads → local replica (linear_read_ticket <ID>, not bare linearis)")
	if [[ ${#missing_reflex[@]} -eq 0 ]]; then
		echo -e "${GREEN}Agent house rules present${NC} — ${AGENT_DOCS[*]} teaches the event-log, 👍-review, and replica-read reflexes."
	else
		warnings+=("Agent doc (${AGENT_DOCS[*]}) is missing house rules (the 'Working the Loop' reflexes) — an interactive agent won't learn: ${missing_reflex[*]}. Seed the canonical block: plugins/dev/templates/agents-house-rules.md (into AGENTS.md if CLAUDE.md is an @AGENTS.md bridge, else into CLAUDE.md).")
	fi
fi

# Report errors (fatal)
if [[ ${#errors[@]} -gt 0 ]]; then
	echo -e "${RED}ERROR: Project setup incomplete${NC}"
	for err in "${errors[@]}"; do
		echo -e "  ${RED}•${NC} $err"
	done
	echo ""
	exit 1
fi

# Report warnings (non-fatal but important)
if [[ ${#warnings[@]} -gt 0 ]]; then
	echo -e "${YELLOW}WARN: Project setup has issues${NC}"
	for warn in "${warnings[@]}"; do
		echo -e "  ${YELLOW}•${NC} $warn"
	done
	echo ""
fi

# Success
if [[ ${#warnings[@]} -eq 0 ]]; then
	echo -e "${GREEN}Project setup OK${NC}"
fi
