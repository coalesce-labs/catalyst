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

if [[ -f "$HOME_CONFIG_PATH" ]]; then
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

	# Check for cached Linear UUIDs (CTL-207) — reduces API calls during orchestrator runs
	if [[ -n $TEAM_KEY ]]; then
		STATE_IDS=$(jq -r '.catalyst.linear.stateIds // empty' "$CONFIG_PATH" 2>/dev/null)
		if [[ -z $STATE_IDS || $STATE_IDS == "null" ]]; then
			warnings+=("Missing catalyst.linear.stateIds — run: plugins/dev/scripts/resolve-linear-ids.sh")
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

	# Warn if config is still only in .claude/ (deprecated location)
	if [[ $CONFIG_PATH == ".claude/config.json" && ! -f ".catalyst/config.json" ]]; then
		warnings+=("config.json is in .claude/ (deprecated) — move to .catalyst/config.json")
	fi
else
	warnings+=(".catalyst/config.json not found — run setup-catalyst.sh to create it")
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
			if [[ -n "$smee_url" && "$tunnel_connected" != "true" ]]; then
				warnings+=("Webhook tunnel not connected (smeeUrl=${smee_url}) — GitHub events won't reach the daemon")
				warnings+=("  Restart the monitor: $MONITOR_SCRIPT restart")
			fi
		fi
	else
		# Daemon stopped. Behavior splits on autonomous vs interactive.
		if [[ -n ${CATALYST_AUTONOMOUS:-} ]] || [[ ! -t 0 ]]; then
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
