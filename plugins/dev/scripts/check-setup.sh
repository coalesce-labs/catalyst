#!/usr/bin/env bash
# Catalyst Setup Health Check
# Validates the full Catalyst environment: tools, database, config, OTel, direnv, thoughts.
# Run from any Catalyst-configured project directory.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
DIRENV_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/direnv"
CATALYST_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/catalyst"

pass_count=0
warn_count=0
fail_count=0

pass()  { echo -e "  ${GREEN}✅  ${NC}$1"; pass_count=$((pass_count + 1)); }
warn()  { echo -e "  ${YELLOW}⚠️   ${NC}$1"; warn_count=$((warn_count + 1)); }
fail()  { echo -e "  ${RED}❌  ${NC}$1"; fail_count=$((fail_count + 1)); }
info()  { echo -e "  ${BLUE}ℹ   ${NC}$1"; }
header() { echo ""; echo -e "${BOLD}$1${NC}"; }

# ─── 1. Platform ────────────────────────────────────────────────────────────

header "Platform"

if [[ "$(uname -s)" == "Darwin" ]]; then
    pass "macOS detected"
else
    warn "Non-macOS detected ($(uname -s)) — Catalyst assumes macOS"
fi

# ─── 2. Required Tools ──────────────────────────────────────────────────────

header "Required Tools"

TOOLS=(
    "git:Git"
    "jq:jq"
    "sqlite3:SQLite"
    "gh:GitHub CLI"
    "humanlayer:HumanLayer CLI"
    "linearis:Linearis CLI"
)

for spec in "${TOOLS[@]}"; do
    IFS=: read -r cmd name <<<"$spec"
    if command -v "$cmd" &>/dev/null; then
        pass "$name"
    else
        fail "$name not found"
    fi
done

header "Optional Tools"

OPT_TOOLS=(
    "agent-browser:agent-browser"
    "sentry-cli:Sentry CLI"
    "bun:Bun runtime"
    "direnv:direnv"
    "smee:smee-client (webhook tunnel)"
)

for spec in "${OPT_TOOLS[@]}"; do
    IFS=: read -r cmd name <<<"$spec"
    if command -v "$cmd" &>/dev/null; then
        pass "$name"
    else
        warn "$name not found (optional)"
    fi
done

# ─── 2b. Catalyst CLI Install ───────────────────────────────────────────────

header "Catalyst CLI Install"

CLI_BIN_DIR="${CATALYST_CLI_BIN_DIR:-$HOME/.catalyst/bin}"
CLI_NAMES=(catalyst-comms catalyst-events catalyst-session catalyst-state catalyst-db catalyst-monitor catalyst-thoughts catalyst-claude)

if [[ -d "$CLI_BIN_DIR" ]]; then
    pass "Bin dir exists: $CLI_BIN_DIR"

    case ":${PATH:-}:" in
        *":$CLI_BIN_DIR:"*) pass "$CLI_BIN_DIR is on PATH" ;;
        *) warn "$CLI_BIN_DIR not on PATH — add: export PATH=\"\$HOME/.catalyst/bin:\$PATH\"" ;;
    esac

    for cli in "${CLI_NAMES[@]}"; do
        link="$CLI_BIN_DIR/$cli"
        if [[ -L "$link" && -e "$link" ]]; then
            pass "$cli → $(readlink "$link")"
        elif [[ -L "$link" ]]; then
            fail "$cli symlink target missing — run install-cli.sh to repair"
        else
            warn "$cli not installed — run plugins/dev/scripts/install-cli.sh"
        fi
    done
else
    warn "$CLI_BIN_DIR missing — run plugins/dev/scripts/install-cli.sh"
    info "After install, add to PATH: export PATH=\"\$HOME/.catalyst/bin:\$PATH\""
fi

# ─── 3. Catalyst Directory ──────────────────────────────────────────────────

header "Catalyst Directory ($CATALYST_DIR)"

if [[ -d "$CATALYST_DIR" ]]; then
    pass "Directory exists"
else
    fail "Directory missing — run setup-catalyst.sh"
fi

if [[ -d "$CATALYST_DIR/wt" ]]; then
    pass "Worktree root exists (wt/)"
else
    warn "Worktree root missing ($CATALYST_DIR/wt/) — orchestration won't work"
fi

if [[ -d "$CATALYST_DIR/events" ]]; then
    pass "Events directory exists"
else
    warn "Events directory missing ($CATALYST_DIR/events/)"
fi

# ─── 4. SQLite Database ─────────────────────────────────────────────────────

header "Session Database"

DB_FILE="${CATALYST_DB_FILE:-$CATALYST_DIR/catalyst.db}"

if [[ -f "$DB_FILE" ]]; then
    pass "Database file exists ($DB_FILE)"

    if command -v sqlite3 &>/dev/null; then
        tables=$(sqlite3 "$DB_FILE" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" 2>/dev/null || echo "")
        core_tables=("session_events" "session_metrics" "session_prs" "session_tools" "sessions")
        all_core=true

        for t in "${core_tables[@]}"; do
            if ! echo "$tables" | grep -q "^${t}$"; then
                all_core=false
                break
            fi
        done

        if [[ "$all_core" == true ]]; then
            pass "Schema initialized (all 5 core tables present)"

            if echo "$tables" | grep -q "^schema_migrations$"; then
                migration=$(sqlite3 "$DB_FILE" "SELECT version FROM schema_migrations LIMIT 1;" 2>/dev/null || echo "")
                if [[ -n "$migration" ]]; then
                    pass "Migration tracked: $migration"
                fi
            else
                warn "schema_migrations table missing — run: plugins/dev/scripts/catalyst-db.sh init"
                info "Tables exist but weren't created by the migration system"
            fi
        else
            fail "Schema incomplete — run: plugins/dev/scripts/catalyst-db.sh init"
            info "Missing tables. Found: $(echo "$tables" | tr '\n' ', ' | sed 's/,$//')"
        fi

        journal=$(sqlite3 "$DB_FILE" "PRAGMA journal_mode;" 2>/dev/null || echo "unknown")
        if [[ "$journal" == "wal" ]]; then
            pass "WAL mode enabled"
        else
            warn "Journal mode is '$journal' (expected 'wal') — run: sqlite3 $DB_FILE 'PRAGMA journal_mode=WAL;'"
        fi
    else
        warn "sqlite3 not available — can't verify schema"
    fi
else
    fail "Database missing ($DB_FILE) — run: plugins/dev/scripts/catalyst-db.sh init"
fi

# Annotations DB
ANN_DB="$CATALYST_DIR/annotations.db"
if [[ -f "$ANN_DB" ]]; then
    pass "Annotations database exists"
else
    warn "Annotations database missing ($ANN_DB) — created on first orch-monitor use"
fi

# ─── 5. Project Config ──────────────────────────────────────────────────────

header "Project Config (current directory)"

CONFIG_PATH=""
if [[ -f ".catalyst/config.json" ]]; then
    CONFIG_PATH=".catalyst/config.json"
    pass "Config found: .catalyst/config.json"
elif [[ -f ".claude/config.json" ]]; then
    CONFIG_PATH=".claude/config.json"
    warn "Config in deprecated location (.claude/config.json) — move to .catalyst/"
else
    fail "No project config found — run setup-catalyst.sh"
fi

if [[ -n "$CONFIG_PATH" ]]; then
    PROJECT_KEY=$(jq -r '.catalyst.projectKey // empty' "$CONFIG_PATH" 2>/dev/null)
    if [[ -n "$PROJECT_KEY" ]]; then
        pass "Project key: $PROJECT_KEY"
    else
        fail "Missing catalyst.projectKey in $CONFIG_PATH"
    fi

    TICKET_PREFIX=$(jq -r '.catalyst.project.ticketPrefix // empty' "$CONFIG_PATH" 2>/dev/null)
    if [[ -n "$TICKET_PREFIX" ]]; then
        pass "Ticket prefix: $TICKET_PREFIX"
    else
        warn "Missing catalyst.project.ticketPrefix"
    fi

    TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // empty' "$CONFIG_PATH" 2>/dev/null)
    if [[ -n "$TEAM_KEY" ]]; then
        pass "Linear team key: $TEAM_KEY"
    else
        warn "Missing catalyst.linear.teamKey"
    fi

    STATE_MAP=$(jq -r '.catalyst.linear.stateMap // empty' "$CONFIG_PATH" 2>/dev/null)
    if [[ -n "$STATE_MAP" ]]; then
        pass "Linear state map configured"
    else
        warn "Missing catalyst.linear.stateMap"
    fi
fi

# ─── 6. Secrets Config ──────────────────────────────────────────────────────

header "Secrets Config"

if [[ -n "${PROJECT_KEY:-}" ]]; then
    SECRETS_FILE="$CATALYST_CONFIG/config-${PROJECT_KEY}.json"
    if [[ -f "$SECRETS_FILE" ]]; then
        pass "Secrets file exists: config-${PROJECT_KEY}.json"

        token=$(jq -r '.linear.apiToken // empty' "$SECRETS_FILE" 2>/dev/null)
        if [[ -n "$token" && "$token" != "[NEEDS_SETUP]" ]]; then
            pass "Linear API token configured"
        else
            warn "Linear API token not set in $SECRETS_FILE"
        fi
    else
        warn "Secrets file missing: $SECRETS_FILE"
        info "Create with: setup-catalyst.sh or manually"
    fi
else
    warn "Can't check secrets — no projectKey found"
fi

# ─── 6b. Webhook Pipeline ──────────────────────────────────────────────────

header "Webhook Pipeline"

HOME_CONFIG_PATH="$CATALYST_CONFIG/config.json"
if [[ -f "$HOME_CONFIG_PATH" ]]; then
    smee_channel=$(jq -r '.catalyst.monitor.github.smeeChannel // empty' "$HOME_CONFIG_PATH" 2>/dev/null)
    if [[ -n "$smee_channel" ]]; then
        pass "smeeChannel configured ($smee_channel)"
    else
        warn "Missing catalyst.monitor.github.smeeChannel in $HOME_CONFIG_PATH — webhook tunnel won't start"
        info "Run: bash plugins/dev/scripts/setup-webhooks.sh"
    fi
else
    warn "Cross-project Layer 2 config missing: $HOME_CONFIG_PATH — webhook tunnel not configured"
    info "Run: bash plugins/dev/scripts/setup-webhooks.sh"
fi

if [[ -n "${PROJECT_KEY:-}" && -f "${SECRETS_FILE:-}" ]]; then
    linear_webhook_id=$(jq -r '.catalyst.monitor.linear.webhookId // empty' "$SECRETS_FILE" 2>/dev/null)
    if [[ -n "$linear_webhook_id" ]]; then
        pass "Linear webhook registered (id: ${linear_webhook_id:0:8}…)"
    else
        warn "Linear webhook not registered — Linear events won't reach the event log"
        info "Register: bash plugins/dev/scripts/setup-webhooks.sh --linear-register"
    fi
fi

# ─── 7. OTel Observability Stack (optional) ────────────────────────────────

header "Observability Stack (optional)"

if command -v docker &>/dev/null; then
    pass "Docker available"

    otel_containers=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -cE "otel|prometheus|loki|grafana|lgtm" || true)
    if [[ "$otel_containers" -gt 0 ]]; then
        pass "OTel containers running ($otel_containers found)"

        get_host_port() {
            local container_pattern="$1" internal_port="$2"
            local ports_str
            ports_str=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -i "$container_pattern" || echo "")
            if [[ -z "$ports_str" ]]; then echo ""; return; fi
            # Match "0.0.0.0:HOST_PORT->INTERNAL_PORT/tcp" (exact port)
            local port
            port=$(echo "$ports_str" | grep -oE "0\.0\.0\.0:[0-9]+->${internal_port}/tcp" | head -1 | sed 's/0\.0\.0\.0:\([0-9]*\)->.*/\1/')
            if [[ -n "$port" ]]; then echo "$port"; return; fi
            # Match port range "0.0.0.0:START-END->START-END/tcp" where internal_port falls in range
            local range_start
            range_start=$(echo "$ports_str" | grep -oE "0\.0\.0\.0:[0-9]+-[0-9]+->[0-9]+-[0-9]+/tcp" | head -1 | sed 's/0\.0\.0\.0:\([0-9]*\)-.*/\1/')
            if [[ -n "$range_start" ]]; then echo "$internal_port"; return; fi
            echo ""
        }

        collector_port=$(get_host_port "collector" "4318")
        if [[ -n "$collector_port" ]]; then
            if (echo >/dev/tcp/localhost/"$collector_port") 2>/dev/null; then
                pass "OTel Collector reachable (:$collector_port)"
            else
                warn "OTel Collector mapped to :$collector_port but not responding"
            fi
        else
            warn "OTel Collector port mapping not found"
        fi

        prom_port=$(get_host_port "prometheus" "9090")
        if [[ -n "$prom_port" ]] && curl -sf --max-time 3 "http://localhost:${prom_port}/api/v1/status/buildinfo" &>/dev/null; then
            pass "Prometheus reachable (:$prom_port)"
        elif [[ -n "$prom_port" ]]; then
            warn "Prometheus mapped to :$prom_port but not responding"
        else
            warn "Prometheus port mapping not found"
        fi

        loki_port=$(get_host_port "loki" "3100")
        if [[ -n "$loki_port" ]] && curl -sf --max-time 3 "http://localhost:${loki_port}/ready" &>/dev/null; then
            pass "Loki reachable (:$loki_port)"
        elif [[ -n "$loki_port" ]]; then
            warn "Loki mapped to :$loki_port but not responding"
        else
            warn "Loki port mapping not found"
        fi

        grafana_port=$(get_host_port "grafana" "3000")
        if [[ -n "$grafana_port" ]] && curl -sf --max-time 3 "http://localhost:${grafana_port}/api/health" &>/dev/null; then
            pass "Grafana reachable (:$grafana_port)"
        elif [[ -n "$grafana_port" ]]; then
            warn "Grafana mapped to :$grafana_port but not responding"
        else
            warn "Grafana port mapping not found"
        fi
    else
        info "No OTel containers running — observability not configured"
        info "Optional: https://github.com/ryanrozich/claude-code-otel"
    fi
else
    info "Docker not found — skipping OTel stack check (optional)"
fi

# OTel config file
OTEL_CONFIG="$CATALYST_CONFIG/config.json"
if [[ -n "${PROJECT_KEY:-}" ]]; then
    OTEL_CONFIG="$CATALYST_CONFIG/config-${PROJECT_KEY}.json"
fi
if [[ -f "$OTEL_CONFIG" ]]; then
    otel_enabled=$(jq -r '.otel.enabled // empty' "$OTEL_CONFIG" 2>/dev/null)
    if [[ "$otel_enabled" == "true" ]]; then
        pass "OTel enabled in config"
    elif [[ -n "$otel_enabled" ]]; then
        warn "OTel disabled in config ($OTEL_CONFIG)"
    fi
fi

# ─── 7b. Orchestration Monitor (optional) ──────────────────────────────────

header "Orchestration Monitor (optional)"

MONITOR_PORT="${MONITOR_PORT:-7400}"

LAUNCHER=""
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "${CLAUDE_PLUGIN_ROOT}/scripts/catalyst-monitor.sh" ]]; then
    LAUNCHER="${CLAUDE_PLUGIN_ROOT}/scripts/catalyst-monitor.sh"
elif [[ -f "plugins/dev/scripts/catalyst-monitor.sh" ]]; then
    LAUNCHER="plugins/dev/scripts/catalyst-monitor.sh"
fi

# Prefer querying the wrapper for structured status (running + version drift).
# Fall back to a raw TCP probe when the wrapper or jq is unavailable.
if [[ -n "$LAUNCHER" ]] && command -v jq &>/dev/null; then
    STATUS_JSON=$(bash "$LAUNCHER" status --json 2>/dev/null || true)
    if [[ -n "$STATUS_JSON" ]]; then
        MONITOR_RUNNING=$(echo "$STATUS_JSON" | jq -r '.running // false')
        MONITOR_RV=$(echo "$STATUS_JSON" | jq -r '.runningVersion // "?"')
        MONITOR_LV=$(echo "$STATUS_JSON" | jq -r '.latestAvailableVersion // "?"')
        MONITOR_STALE=$(echo "$STATUS_JSON" | jq -r '.isStale // false')
        if [[ "$MONITOR_RUNNING" == "true" ]]; then
            pass "Monitor running on :$MONITOR_PORT (v$MONITOR_RV)"
        else
            warn "Monitor not running on :$MONITOR_PORT — catalyst-events wait-for falls back to 600s polling timeout"
            info "Start with: bash $LAUNCHER start"
        fi
        if [[ "$MONITOR_STALE" == "true" ]]; then
            warn "Monitor version drift: running v$MONITOR_RV, v$MONITOR_LV available — bash $LAUNCHER restart"
        fi
    elif (echo >/dev/tcp/localhost/"$MONITOR_PORT") 2>/dev/null; then
        pass "Monitor running on :$MONITOR_PORT"
    else
        warn "Monitor not running on :$MONITOR_PORT — catalyst-events wait-for falls back to 600s polling timeout"
        info "Start with: bash $LAUNCHER start"
    fi
elif (echo >/dev/tcp/localhost/"$MONITOR_PORT") 2>/dev/null; then
    pass "Monitor running on :$MONITOR_PORT"
else
    warn "Monitor not running on :$MONITOR_PORT — catalyst-events wait-for falls back to 600s polling timeout"
    if [[ -n "$LAUNCHER" ]]; then
        info "Start with: bash $LAUNCHER start"
    else
        info "Start with: bash plugins/dev/scripts/catalyst-monitor.sh start"
    fi
fi

# ─── 8. direnv ──────────────────────────────────────────────────────────────

header "direnv"

if command -v direnv &>/dev/null; then
    pass "direnv installed ($(direnv version))"

    if [[ -f "$DIRENV_CONFIG/lib/profiles.sh" ]]; then
        pass "Library: profiles.sh"
    else
        warn "Missing $DIRENV_CONFIG/lib/profiles.sh — use_profile won't work"
    fi

    if [[ -f "$DIRENV_CONFIG/lib/otel.sh" ]]; then
        pass "Library: otel.sh"
    else
        warn "Missing $DIRENV_CONFIG/lib/otel.sh — use_otel_context won't work"
    fi

    profile_count=$(ls "$DIRENV_CONFIG/profiles/"*.env 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$profile_count" -gt 0 ]]; then
        pass "$profile_count profile(s) in $DIRENV_CONFIG/profiles/"
    else
        warn "No profiles found in $DIRENV_CONFIG/profiles/"
    fi

    if [[ -f ".envrc" ]]; then
        pass ".envrc exists in current project"
        if grep -q "use_profile" .envrc 2>/dev/null; then
            profiles_used=$(grep "use_profile" .envrc | sed 's/.*use_profile[[:space:]]*//' | tr -d '"' | tr '\n' ', ' | sed 's/,$//')
            pass "Profiles loaded: $profiles_used"

            for p in $(grep "use_profile" .envrc | sed 's/.*use_profile[[:space:]]*//' | tr -d '"'); do
                if [[ ! -f "$DIRENV_CONFIG/profiles/${p}.env" ]]; then
                    fail "Profile '$p' referenced in .envrc but $DIRENV_CONFIG/profiles/${p}.env missing"
                fi
            done
        fi
        if grep -q "use_otel_context" .envrc 2>/dev/null; then
            pass "OTel context configured in .envrc"
        fi
    else
        warn "No .envrc in current project — direnv not active here"
    fi
else
    warn "direnv not installed (recommended for multi-repo API key isolation)"
    info "Install: brew install direnv"
fi

# ─── 9. Thoughts System ─────────────────────────────────────────────────────

header "Thoughts System"

if [[ -d "thoughts" ]]; then
    pass "thoughts/ directory exists"

    # Fatal: regular directory (or dangling symlink) where humanlayer expects a symlink.
    # This is the bug state where writes silently land in the local repo instead of
    # syncing to the central thoughts store. Only fires when thoughts is expected
    # to be symlinked (humanlayer is configured for this repo, or .catalyst/config.json
    # declares catalyst.thoughts.directory).
    thoughts_expected=0
    if [[ -f ".catalyst/config.json" ]] && \
       [[ -n "$(jq -r '.catalyst.thoughts.directory // empty' .catalyst/config.json 2>/dev/null)" ]]; then
        thoughts_expected=1
    fi
    if command -v humanlayer &>/dev/null && \
       humanlayer thoughts config --json 2>/dev/null | \
         jq -e --arg cwd "$(pwd)" '.repoMappings[$cwd] // empty' &>/dev/null; then
        thoughts_expected=1
    fi

    if [[ $thoughts_expected -eq 1 ]]; then
        for top in shared global; do
            if [[ -e "thoughts/$top" && ! -L "thoughts/$top" ]]; then
                fail "thoughts/$top is a regular directory but should be a symlink — humanlayer init was bypassed"
                info "Recovery: bash plugins/dev/scripts/catalyst-thoughts.sh check"
            elif [[ -L "thoughts/$top" && ! -e "thoughts/$top" ]]; then
                fail "thoughts/$top is a symlink with a missing target"
                info "Recovery: bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair"
            fi
        done
    fi

    for dir in research plans handoffs prs reports; do
        if [[ -d "thoughts/shared/$dir" ]]; then
            pass "thoughts/shared/$dir/"
        else
            warn "Missing thoughts/shared/$dir/ — run: bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair"
        fi
    done

    if command -v humanlayer &>/dev/null; then
        hl_status=$(humanlayer thoughts status 2>&1 || true)
        if echo "$hl_status" | grep -q "Repository:"; then
            repo_path=$(echo "$hl_status" | grep "Repository:" | sed 's/.*Repository:[[:space:]]*//')
            pass "Thoughts repo: $repo_path"
        else
            warn "humanlayer thoughts not configured for this directory"
        fi

        if echo "$hl_status" | grep -q "Profile:"; then
            profile=$(echo "$hl_status" | grep "Profile:" | sed 's/.*Profile:[[:space:]]*//')
            pass "Thoughts profile: $profile"
        fi

        # Profile / directory drift check: catches the scenario where humanlayer was
        # init'd under a different profile than .catalyst/config.json declares.
        if [[ -f ".catalyst/config.json" ]]; then
            cat_profile=$(jq -r '.catalyst.thoughts.profile // empty' .catalyst/config.json 2>/dev/null)
            cat_dir=$(jq -r '.catalyst.thoughts.directory // empty' .catalyst/config.json 2>/dev/null)
            hl_map=$(humanlayer thoughts config --json 2>/dev/null | jq -r --arg cwd "$(pwd)" '.repoMappings[$cwd] // empty' 2>/dev/null)
            if [[ -n "$hl_map" ]]; then
                hl_profile=$(echo "$hl_map" | jq -r '.profile // empty' 2>/dev/null)
                hl_repo=$(echo "$hl_map" | jq -r '.repo // empty' 2>/dev/null)
                if [[ -n "$cat_profile" && -n "$hl_profile" && "$cat_profile" != "$hl_profile" ]]; then
                    fail "Profile drift: .catalyst/config.json='$cat_profile', humanlayer='$hl_profile' for this repo"
                    info "Fix: bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair"
                    info "  (or manually: humanlayer thoughts uninit --force && humanlayer thoughts init --profile $cat_profile --directory ${cat_dir:-<directory>})"
                fi
                if [[ -n "$cat_dir" && -n "$hl_repo" && "$cat_dir" != "$hl_repo" ]]; then
                    fail "Directory drift: .catalyst/config.json='$cat_dir', humanlayer='$hl_repo' for this repo"
                fi
            fi
        fi
    fi
else
    warn "thoughts/ not found — run: bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair"
fi

# ─── 9b. Catalyst Marketplace Drift ─────────────────────────────────────────

header "Catalyst Marketplace"

DRIFT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIFT_SCRIPT="$DRIFT_SCRIPT_DIR/check-marketplace-drift.sh"
if [[ -x "$DRIFT_SCRIPT" ]]; then
    set +e
    drift_out=$("$DRIFT_SCRIPT" 2>&1)
    drift_rc=$?
    set -e
    if [[ $drift_rc -eq 2 ]]; then
        fail "check-marketplace-drift.sh setup error: $drift_out"
    elif [[ -z "$drift_out" ]]; then
        info "No local dev marketplace registered (public marketplace only)"
    else
        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            case "$line" in
                "✅ "*) pass "${line#✅ }" ;;
                "⚠️ "*) warn "${line#⚠️ }" ;;
                "❌ "*) fail "${line#❌ }" ;;
                "ℹ "*)  info "${line#ℹ }" ;;
                *)      info "$line" ;;
            esac
        done <<< "$drift_out"
    fi
else
    warn "check-marketplace-drift.sh not found or not executable"
fi

# ─── 10. CLAUDE.md ──────────────────────────────────────────────────────────

header "CLAUDE.md"

if [[ -f "CLAUDE.md" ]]; then
    if grep -qi "catalyst" CLAUDE.md 2>/dev/null; then
        pass "CLAUDE.md exists with Catalyst context"
    else
        warn "CLAUDE.md exists but may be missing the Catalyst snippet"
        info "Add with: cat plugins/dev/templates/CLAUDE_SNIPPET.md >> CLAUDE.md"
    fi
else
    warn "No CLAUDE.md — agents won't have project-level workflow context"
fi

# ─── Summary ────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ $fail_count -eq 0 && $warn_count -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All checks passed ($pass_count/${pass_count})${NC}"
elif [[ $fail_count -eq 0 ]]; then
    echo -e "${YELLOW}${BOLD}$pass_count passed, $warn_count warnings${NC}"
else
    echo -e "${RED}${BOLD}$pass_count passed, $warn_count warnings, $fail_count failures${NC}"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

exit $fail_count
